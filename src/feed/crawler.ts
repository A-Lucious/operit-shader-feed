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

import {
  isSinglePassRenderable,
  parseShader,
  type ShaderRecord,
} from "./parse.js";

export interface ListPage {
  ok: boolean;
  ids: string[];
  nextCursor: string;
  /** 列表已到底（服务端明确没有更多）。与「本页返回空」等价处理。 */
  exhausted?: boolean;
  error?: string;
}

export interface ShaderPayload {
  ok: boolean;
  text: string;
  error?: string;
}

/** 真实传输层要保证：所有请求走**同一个**已通过 CF 的会话。 */
export interface CrawlTransport {
  listIds(cursor: string, limit: number): Promise<ListPage>;
  fetchShader(id: string): Promise<ShaderPayload>;
}

export interface CrawlOptions {
  listSize?: number;
  detailConcurrency?: number;
  /** 单条最大尝试次数（含首次）。D5 定的是「最多重试 1 次」＝ 2 次。 */
  maxAttempts?: number;
  /** 可注入的解析函数，便于测试；默认用 parseShader。 */
  parse?: (text: string) => {
    ok: boolean;
    record?: ShaderRecord;
    error?: string;
  };
  /** 每条记录解析成功后调用；异常不得阻塞队列。 */
  onRecord?: (record: ShaderRecord) => void | Promise<void>;
}

export interface CrawlStats {
  listCalls: number;
  listFailures: number;
  detailCalls: number;
  detailFailures: number;
  retries: number;
  parseFailures: number;
  /** 已交付的记录数（含多 pass —— 它们只是被标记，没有被丢弃）。 */
  delivered: number;
  singlePass: number;
  multiPass: number;
}

export interface Crawler {
  /** 补货到「前方至少有 target 条可播」。允许多次并发调用，不会重复开工。 */
  ensure(target: number): Promise<void>;
  /** 取出一条可播记录；没有则返回 null。 */
  take(): ShaderRecord | null;
  /** 当前前方可播条数。 */
  ahead(): number;
  /** 列表是否已耗尽。 */
  exhausted(): boolean;
  stats(): CrawlStats;
}

export function createCrawler(
  transport: CrawlTransport,
  options: CrawlOptions = {},
): Crawler {
  const listSize = options.listSize ?? 24;
  const concurrency = Math.max(1, options.detailConcurrency ?? 3);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const parse = options.parse ?? parseShader;
  const onRecord = options.onRecord;

  /** 已解析、可立即播放。 */
  const ready: ShaderRecord[] = [];
  /** 已拿到 id、尚未取详情。 */
  const pendingIds: string[] = [];
  /** 跨列表页去重 —— 同一个 id 绝不取两次详情。 */
  const seen = new Set<string>();

  let cursor = "";
  let listExhausted = false;
  /** 连续多少页没拿到新 id。游标一直前进却只回重复 id 时靠它判到底。 */
  let emptyStreak = 0;
  let active = 0;
  let pumpPromise: Promise<void> | null = null;

  const stats: CrawlStats = {
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

  async function loadMoreIds(): Promise<void> {
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
    const previousCursor = cursor;
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
      return;
    }
    // 判到底的两个信号，缺一个都会变成“卡住时每秒发一次列表请求”：
    //
    //   1. 游标没前进。服务端完全可能一直回同一个游标（或永远回同样一批重复 id），
    //      这时再翻也是同一页。用「游标不变」当信号比猜次数精确。
    //   2. 连续几页都没拿到新 id。就算游标每次前进，一直回已见过的 id 也是死路。
    if (added === 0 && cursor === previousCursor) {
      listExhausted = true;
      return;
    }
    if (added === 0) {
      emptyStreak++;
      if (emptyStreak >= 3) {
        listExhausted = true;
      }
    } else {
      emptyStreak = 0;
    }
  }

  /** 取一条详情（含至多 maxAttempts-1 次重试），成功后推入 ready。 */
  async function loadOne(id: string): Promise<void> {
    active++;
    try {
      let lastError = "";
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        stats.detailCalls++;
        if (attempt > 1) {
          stats.retries++;
        }
        let payload: ShaderPayload;
        try {
          payload = await transport.fetchShader(id);
        } catch (err) {
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
        if (onRecord) {
          try {
            await onRecord(record);
          } catch {
            // 持久化失败不应丢掉已解析的可播记录。
          }
        }
        stats.delivered++;
        if (isSinglePassRenderable(record)) {
          stats.singlePass++;
        } else {
          stats.multiPass++;
        }
        return;
      }
      // 重试耗尽：标记跳过，不阻塞队列。
      stats.detailFailures++;
      void lastError;
    } finally {
      active--;
    }
  }

  /**
   * 单次补货：一直推进到「前方够 target 条」或「确实再也推不动」。
   * 不做定时器 —— 何时补货是调用方（P3 的 feed）决定的，本层只负责「推到多少」。
   */
  async function pump(target: number): Promise<void> {
    const inFlight = new Set<Promise<void>>();

    while (ready.length < target) {
      // 补 id
      if (pendingIds.length === 0 && active === 0 && !listExhausted) {
        await loadMoreIds();
      }
      // 开工到并发上限
      while (active < concurrency && pendingIds.length > 0) {
        const id = pendingIds.shift() as string;
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
    ensure(target: number): Promise<void> {
      if (pumpPromise) {
        return pumpPromise;
      }
      const run = pump(Math.max(0, target)).finally(() => {
        pumpPromise = null;
      });
      pumpPromise = run;
      return run;
    },
    take(): ShaderRecord | null {
      return ready.shift() ?? null;
    },
    ahead(): number {
      return ready.length;
    },
    exhausted(): boolean {
      return (
        listExhausted &&
        pendingIds.length === 0 &&
        active === 0 &&
        ready.length === 0
      );
    },
    stats(): CrawlStats {
      return { ...stats };
    },
  };
}
