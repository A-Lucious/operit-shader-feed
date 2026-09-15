/**
 * 把「已缓存的 shader」包装成 `FeedCrawler` —— 两件事一次解决：
 *
 *   1. **D6 的验收**：「拔网后仍能刷已缓存内容」。这条要求一个不联网的数据源。
 *   2. **让 P3 的接线能在真机上离线验证**。否则 feed 通路的第一次验证必须同时
 *      依赖「接线对」+「Cloudflare 过」+「契约猜对」三个未知，失败时无法定位。
 *
 * 刻意不做的事：
 *   - 不补货（缓存是有限的，没有「更多」可拉）
 *   - 不缓存整表（按需逐条读正文；一次 ensure(8) 只读 8 个文件，而不是把 200 条全读进内存）
 */

import type { ShaderRecord } from "./parse.js";
import type { FeedCrawler } from "./feed.js";

/** 只需要 store 的这两个方法，便于测试打桩。 */
export interface CachedSource {
  /** 按保存时间倒序返回元数据。 */
  listShaders(): Promise<{ id: string }[]>;
  loadShader(id: string): Promise<ShaderRecord | null>;
}

export interface StoreCrawlerOptions {
  /** 最多考虑多少条缓存（防止缓存很大时列表本身就很重）。 */
  limit?: number;
}

export function createStoreCrawler(
  source: CachedSource,
  options: StoreCrawlerOptions = {},
): FeedCrawler {
  const limit = Math.max(1, options.limit ?? 200);

  const queue: ShaderRecord[] = [];
  let ids: string[] | null = null;
  let cursor = 0;
  let loading: Promise<void> | null = null;

  async function loadMore(target: number): Promise<void> {
    if (ids === null) {
      const list = await source.listShaders();
      ids = list.slice(0, limit).map((meta) => meta.id);
    }
    // 逐条按需读：不要为了拿 8 条而把整表正文都读进来。
    while (queue.length < target && cursor < ids.length) {
      const id = ids[cursor];
      cursor += 1;
      const record = await source.loadShader(id);
      // 读不到（文件损坏/被用户删了）就跳过，不能卡住这一轮 —— 否则一条坏数据会让 feed 停摆。
      if (record) {
        queue.push(record);
      }
    }
  }

  return {
    ensure(target: number): Promise<void> {
      if (!loading) {
        loading = loadMore(Math.max(1, target)).finally(() => {
          loading = null;
        });
      }
      return loading;
    },

    take(): ShaderRecord | null {
      return queue.length > 0 ? (queue.shift() as ShaderRecord) : null;
    },

    ahead(): number {
      return queue.length;
    },

    exhausted(): boolean {
      if (ids === null) {
        return false;
      }
      return cursor >= ids.length && queue.length === 0;
    },
  };
}
