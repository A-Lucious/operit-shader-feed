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

import type { ShaderRecord } from "./parse.js";

export interface FeedCrawler {
  ensure(target: number): Promise<void>;
  take(): ShaderRecord | null;
  ahead(): number;
  exhausted(): boolean;
}

export interface FeedOptions {
  /** 前方要维持的条数（D5：8）。 */
  target?: number;
  /** 低于这个数就补货（D5：4）。 */
  refillBelow?: number;
  /** 每条播多久（D4：30 秒）。 */
  dwellMs?: number;
  /** iTime 起点的会话种子（D4：hash(shaderId, sessionSeed) % 600）。 */
  sessionSeed?: number;
  now?: () => number;
  /** 当前条目发生变化时回调，宿主据此把新 shader 交给 WebView。 */
  onAdvance?: (tick: FeedTick) => void;
}

export interface FeedTick {
  /** 本次 tick 是否换了条目。 */
  advanced: boolean;
  current: ShaderRecord | null;
  /** 当前这条实际播放了多久（暂停期间不累加）。 */
  playedMs: number;
}

export interface FeedSnapshot {
  index: number;
  ahead: number;
  playedMs: number;
  waiting: boolean;
  paused: boolean;
  target: number;
  refillBelow: number;
  dwellMs: number;
  exhausted: boolean;
}

export interface Feed {
  /** 取第一条并开始计时。 */
  start(): FeedTick;
  /** 宿主每秒调一次。 */
  tick(): FeedTick;
  /** 用户上滑。 */
  advance(): FeedTick;
  pause(): void;
  resume(): void;
  current(): ShaderRecord | null;
  /** 当前这条的 iTime 起点（秒），已按 D4 做随机化。 */
  timeOffsetSeconds(): number;
  /** 卡住等新内容中（前方已空）。 */
  waiting(): boolean;
  snapshot(): FeedSnapshot;
}

/**
 * D4：iTime 起点用 hash(shaderId, sessionSeed) % 600，避免同一条每次刷都看到同一个开头。
 * 用 FNV-1a 这种确定性哈希：同一个 id + 种子在任何运行里得到同一个偏移，
 * 出问题时可复现 —— 这正是 D4 把 iDate 定成常量的同一个理由。
 */
export function timeOffsetFor(id: string, sessionSeed: number): number {
  let h = (2166136261 ^ (sessionSeed >>> 0)) >>> 0;
  const text = String(id);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 600;
}

export function createFeed(
  crawler: FeedCrawler,
  options: FeedOptions = {},
): Feed {
  const target = Math.max(1, options.target ?? 8);
  const refillBelow = Math.max(1, Math.min(options.refillBelow ?? 4, target));
  const dwellMs = Math.max(1000, options.dwellMs ?? 30000);
  const sessionSeed = options.sessionSeed ?? 1;
  const now = options.now ?? (() => Date.now());
  const onAdvance = options.onAdvance;

  let currentRecord: ShaderRecord | null = null;
  let index = -1;
  let playedMs = 0;
  let lastTs = 0;
  let paused = false;
  let started = false;
  /** 有一条补货在飞。没有这个标记的话，卡住时每个 tick 都会发一次补货 —— 每秒一次。 */
  let refilling = false;

  function pullNext(): ShaderRecord | null {
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
  function maybeRefill(): void {
    if (refilling || crawler.ahead() >= refillBelow) {
      return;
    }
    refilling = true;
    crawler.ensure(target).then(
      () => {
        refilling = false;
      },
      () => {
        refilling = false;
      },
    );
  }

  /**
   * 「真的卡住了」：没有任何内容可显示，或者播完了却换不到下一条。
   * 刻意**不等于**「前方 buffer 为空」—— 当前这条还在正常播、只是队列空了不算卡住。
   * UI 要区分这两种：前者显示「正在获取内容…」，后者用 ahead 显示「缓冲偏低」。
   */
  function isWaiting(): boolean {
    if (currentRecord === null) {
      return true;
    }
    return playedMs >= dwellMs && crawler.ahead() === 0;
  }

  function emit(advanced: boolean): FeedTick {
    const tick: FeedTick = { advanced, current: currentRecord, playedMs };
    if (onAdvance && advanced) {
      onAdvance(tick);
    }
    return tick;
  }

  function start(): FeedTick {
    // 幂等：重复 start 会重置 dwell 并再取一条，等于把当前这条静默丢掉
    // （它还没播满 30 秒就被换走）。advance() 在未开始时也走 start()，
    // 那条路径不受影响（started 仍为 false）。
    if (started) {
      return emit(false);
    }
    started = true;
    lastTs = now();
    playedMs = 0;
    const got = pullNext();
    maybeRefill();
    return emit(got !== null);
  }

  function tick(): FeedTick {
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

  function advance(): FeedTick {
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
    pause(): void {
      paused = true;
      // 把基准时间推到现在，避免暂停期间的时间被算进下一条
      lastTs = now();
    },
    resume(): void {
      paused = false;
      lastTs = now();
    },
    current(): ShaderRecord | null {
      return currentRecord;
    },
    timeOffsetSeconds(): number {
      return currentRecord ? timeOffsetFor(currentRecord.id, sessionSeed) : 0;
    },
    waiting(): boolean {
      return isWaiting();
    },
    snapshot(): FeedSnapshot {
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
