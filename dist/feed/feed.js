"use strict";
/**
 * P3 播放/缓冲状态机：抖音式 feed 的「当前播哪条、什么时候自动上滑、要不要补货」。
 *
 * 刻意**不引入宿主定时器**：宿主在收到 WebView 每秒一次的 stats 上报时调 `tick()` 就够了
 * （runner.js 本来就在每秒上报）。这样 30 秒逻辑是纯函数式的、能在 Node 里注入时钟真测，
 * 也不用赌 QuickJS 里有没有 setTimeout。
 *
 * 与 crawler 一致，本层只跟接口打交道，不认识 WebView / ToolPkg。
 * 参数全部来自 PLAN §4 D4/D5：
 *   30 秒自动上滑、前方维持 >= 8、< 4 触发补货、补货绝不阻塞播放、不可见即停。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.timeOffsetFor = timeOffsetFor;
exports.createFeed = createFeed;
/**
 * D4：iTime 起点用 hash(shaderId, sessionSeed) % 600，避免同一条每次刷都看到同一个开头。
 * 用 FNV-1a 这种确定性哈希：同一个 id + 种子在任何运行里得到同一个偏移，
 * 出问题时可复现 —— 这正是 D4 把 iDate 定成常量的同一个理由。
 */
function timeOffsetFor(id, sessionSeed) {
    let h = (2166136261 ^ (sessionSeed >>> 0)) >>> 0;
    const text = String(id);
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h % 600;
}
function createFeed(crawler, options = {}) {
    const target = Math.max(1, options.target ?? 8);
    const refillBelow = Math.max(1, Math.min(options.refillBelow ?? 4, target));
    const dwellMs = Math.max(1000, options.dwellMs ?? 30000);
    const sessionSeed = options.sessionSeed ?? 1;
    const now = options.now ?? (() => Date.now());
    const onAdvance = options.onAdvance;
    let currentRecord = null;
    let index = -1;
    let playedMs = 0;
    let lastTs = 0;
    let paused = false;
    let started = false;
    /** 有一条补货在飞。没有这个标记的话，卡住时每个 tick 都会发一次补货 —— 每秒一次。 */
    let refilling = false;
    function pullNext() {
        const next = crawler.take();
        if (next) {
            currentRecord = next;
            index++;
            playedMs = 0;
        }
        return next;
    }
    /**
     * 补货：**绝不 await**（D5 要求补货不阻塞当前播放）。
     * 低水位期间只发一次，直到它落地且下一次又低于阈值才会再发。
     */
    function maybeRefill() {
        if (refilling || crawler.ahead() >= refillBelow) {
            return;
        }
        refilling = true;
        crawler.ensure(target).then(() => {
            refilling = false;
        }, () => {
            refilling = false;
        });
    }
    /**
     * 「真的卡住了」：没有任何内容可显示，或者播完了却换不到下一条。
     * 刻意**不等于**「前方 buffer 为空」—— 当前这条还在正常播、只是队列空了不算卡住。
     * UI 要区分这两种：前者显示「正在获取内容…」，后者用 ahead 显示「缓冲偏低」。
     */
    function isWaiting() {
        if (currentRecord === null) {
            return true;
        }
        return playedMs >= dwellMs && crawler.ahead() === 0;
    }
    function emit(advanced) {
        const tick = { advanced, current: currentRecord, playedMs };
        if (onAdvance && advanced) {
            onAdvance(tick);
        }
        return tick;
    }
    function start() {
        started = true;
        lastTs = now();
        playedMs = 0;
        const got = pullNext();
        maybeRefill();
        return emit(got !== null);
    }
    function tick() {
        if (!started) {
            return emit(false);
        }
        const ts = now();
        const delta = ts - lastTs;
        lastTs = ts;
        // 暂停期间不累加：D4 要求不可见即停，回来后从原处继续而不是重置。
        if (!paused && delta > 0) {
            playedMs += delta;
        }
        // 还没有任何内容可播：**立刻**尝试取一条。
        // 这是 D5「第一条就绪就立刻开播」的要求 —— 不能等到 dwell 到期，
        // 否则用户会在空白页上干等 30 秒（而那一刻正是他最没耐心的时刻）。
        if (currentRecord === null) {
            const firstNow = pullNext();
            if (firstNow) {
                maybeRefill();
                return emit(true);
            }
        }
        if (playedMs >= dwellMs) {
            const next = pullNext();
            if (next) {
                maybeRefill();
                return emit(true);
            }
            // 前方空了：停在当前这条，且**保留已超时的 playedMs**，
            // 这样一旦有内容进来，下一次 tick 立刻换过去，而不是重新数 30 秒。
        }
        maybeRefill();
        return emit(false);
    }
    function advance() {
        if (!started) {
            return start();
        }
        const next = pullNext();
        maybeRefill();
        if (next) {
            return emit(true);
        }
        // 没内容可换：留在当前这条（用户上滑到尾部不该崩，也不该变白屏）。
        return emit(false);
    }
    return {
        start,
        tick,
        advance,
        pause() {
            paused = true;
            // 把基准时间推到现在，避免暂停期间的时间被算进下一条
            lastTs = now();
        },
        resume() {
            paused = false;
            lastTs = now();
        },
        current() {
            return currentRecord;
        },
        timeOffsetSeconds() {
            return currentRecord ? timeOffsetFor(currentRecord.id, sessionSeed) : 0;
        },
        waiting() {
            return isWaiting();
        },
        snapshot() {
            return {
                index,
                ahead: crawler.ahead(),
                playedMs,
                waiting: isWaiting(),
                paused,
                target,
                refillBelow,
                dwellMs,
                exhausted: crawler.exhausted(),
            };
        },
    };
}
