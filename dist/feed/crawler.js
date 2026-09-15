"use strict";
/**
 * P1 爬取队列：D5 的直接实现。
 *
 *  列表页大小 24 / 详情并发 3 / 前方 buffer < 4 触发补货 / 维持 ≥ 8
 *  单条失败标记跳过、最多重试 1 次、不阻塞队列
 *  复用同一个会话（由 transport 负责，本层不做任何会话决策）
 *
 * 本层刻意**不认识** WebView、ToolPkg 或网络 —— 它只跟一个 `CrawlTransport` 打交道。
 * 好处是队列语义（并发上限、重试次数、去重、耗尽判定）能在 Node 里用假 transport 真测，
 * 不必等设备。真实传输层（在 shadertoy 会话里跑 fetch）单独实现。
 *
 * 与契约无关的部分都在这；契约相关的只有 `transport` 的实现。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCrawler = createCrawler;
const parse_js_1 = require("./parse.js");
function createCrawler(transport, options = {}) {
    const listSize = options.listSize ?? 24;
    const concurrency = Math.max(1, options.detailConcurrency ?? 3);
    const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    const parse = options.parse ?? parse_js_1.parseShader;
    /** 已解析、可立即播放。 */
    const ready = [];
    /** 已拿到 id、尚未取详情。 */
    const pendingIds = [];
    /** 跨列表页去重 —— 同一个 id 绝不取两次详情。 */
    const seen = new Set();
    let cursor = "";
    let listExhausted = false;
    let active = 0;
    let pumpPromise = null;
    const stats = {
        listCalls: 0,
        listFailures: 0,
        detailCalls: 0,
        detailFailures: 0,
        retries: 0,
        parseFailures: 0,
        delivered: 0,
        singlePass: 0,
        multiPass: 0,
    };
    async function loadMoreIds() {
        if (listExhausted) {
            return;
        }
        stats.listCalls++;
        const page = await transport.listIds(cursor, listSize);
        if (!page.ok) {
            stats.listFailures++;
            // 列表失败不把整个爬虫判死：留待下一次 ensure 重试。
            return;
        }
        cursor = page.nextCursor || cursor;
        let added = 0;
        for (const id of page.ids) {
            if (!id || seen.has(id)) {
                continue;
            }
            seen.add(id);
            pendingIds.push(id);
            added++;
        }
        if (page.exhausted || page.ids.length === 0) {
            listExhausted = true;
        }
        // 页面返回了内容但全是重复 id，也算到底，避免无限循环。
        if (added === 0 && page.ids.length > 0 && !page.nextCursor) {
            listExhausted = true;
        }
    }
    /** 取一条详情（含至多 maxAttempts-1 次重试），成功后推入 ready。 */
    async function loadOne(id) {
        active++;
        try {
            let lastError = "";
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                stats.detailCalls++;
                if (attempt > 1) {
                    stats.retries++;
                }
                let payload;
                try {
                    payload = await transport.fetchShader(id);
                }
                catch (err) {
                    payload = {
                        ok: false,
                        text: "",
                        error: String(err instanceof Error ? err.message : err),
                    };
                }
                if (!payload.ok) {
                    lastError = payload.error || "详情请求失败";
                    continue;
                }
                const parsed = parse(payload.text);
                if (!parsed.ok || !parsed.record) {
                    lastError = parsed.error || "解析失败";
                    continue;
                }
                const record = parsed.record;
                ready.push(record);
                stats.delivered++;
                if ((0, parse_js_1.isSinglePassRenderable)(record)) {
                    stats.singlePass++;
                }
                else {
                    stats.multiPass++;
                }
                return;
            }
            // 重试耗尽：标记跳过，不阻塞队列。
            stats.detailFailures++;
            void lastError;
        }
        finally {
            active--;
        }
    }
    /**
     * 单次补货：一直推进到「前方够 target 条」或「确实再也推不动」。
     * 不做定时器 —— 何时补货是调用方（P3 的 feed）决定的，本层只负责「推到多少」。
     */
    async function pump(target) {
        const inFlight = new Set();
        while (ready.length < target) {
            // 补 id
            if (pendingIds.length === 0 && active === 0 && !listExhausted) {
                await loadMoreIds();
            }
            // 开工到并发上限
            while (active < concurrency && pendingIds.length > 0) {
                const id = pendingIds.shift();
                const task = loadOne(id).then(() => {
                    inFlight.delete(task);
                });
                inFlight.add(task);
            }
            if (inFlight.size === 0) {
                // 既没在飞、也没 id、列表也到底了 —— 真的推不动了
                break;
            }
            await Promise.race(inFlight);
        }
        // 不吞掉在飞的请求：让它们自然结束，否则下一轮会与它们重复取同一条
        await Promise.all(inFlight);
    }
    return {
        ensure(target) {
            if (pumpPromise) {
                return pumpPromise;
            }
            const run = pump(Math.max(0, target)).finally(() => {
                pumpPromise = null;
            });
            pumpPromise = run;
            return run;
        },
        take() {
            return ready.shift() ?? null;
        },
        ahead() {
            return ready.length;
        },
        exhausted() {
            return (listExhausted &&
                pendingIds.length === 0 &&
                active === 0 &&
                ready.length === 0);
        },
        stats() {
            return { ...stats };
        },
    };
}
