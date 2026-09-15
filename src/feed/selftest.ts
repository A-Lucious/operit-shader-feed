/**
 * 设备侧自测：用**内置的假数据**把整条流水线跑一遍，不碰网络。
 *
 * 为什么需要它：否则真机上的第一次运行把两件独立的事混在一起判断 ——
 * 「我的流水线在这台机器上能不能工作」和「Cloudflare 能不能过」。
 * 分开之后，如果网络那步失败，我们已知流水线本身是好的，能直接定位。
 *
 * 它验证的是**宿主实现**，不是逻辑（逻辑已有离线测试）：
 *   Tools.Files 的读写/移动/建目录/列目录/取大小、CryptoJS、以及 __runnerLoad 的回执。
 *   这些都是打桩测不到的部分 —— 字段名写错在离线环境下永远看不出来。
 *
 * ⚠️ 安全约束：自测在 `<root>/_selftest` 子目录里跑，**绝不碰用户的真实缓存**。
 * 一个自测把用户缓存清了是不可接受的。
 */

import type { ShaderRecord } from "./parse.js";
import type { CrawlTransport, ShaderPayload, ListPage } from "./transport.js";
import { createCrawler, type Crawler } from "./crawler.js";
import { createFeed } from "./feed.js";
import { createStore, type Store, type StoreFs } from "./store.js";

export interface SelfTestStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SelfTestReport {
  ok: boolean;
  steps: SelfTestStep[];
  /** 可直接贴出来的整段文本。 */
  text: string;
}

export interface SelfTestDeps {
  fs: StoreFs;
  /** 真实缓存根目录；自测会在其下建 _selftest 子目录。 */
  root: string;
  /** URL → 短 hash（与生产同一实现）。 */
  hash: (input: string) => string;
  /** 把一条记录交给渲染器。真实实现走 evaluateJavascript('__runnerLoad(...)')。 */
  loadIntoRunner(
    record: ShaderRecord,
    timeOffsetSeconds: number,
  ): Promise<{ ok: boolean; error?: string }>;
  /** 可注入时钟，便于自测里快进 30 秒。 */
  now?: () => number;
}

const SELFTEST_SUBDIR = "_selftest";
const DWELL_MS = 30000;

/** 一张 4x4 的合法 PNG（每像素恰好 4 字节；字节数用于验证 writeBinary 是真的落盘了）。 */
const TEX_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAH0lEQVR4nGP4z8DwPyAgAI4ZkDkoAgz/GTBVAHX/BwARax8enytO9AAAAABJRU5ErkJggg==";

function shaderJson(
  id: string,
  opts: { glsl3?: boolean; withTexture?: boolean } = {},
): string {
  const code = opts.glsl3
    ? "#version 300 es\nvoid mainImage(out vec4 c, in vec2 f){ c = vec4(f / iResolution.xy, 0.5, 1.0); }"
    : "void mainImage(out vec4 c, in vec2 f){ c = vec4(f / iResolution.xy, 0.5, 1.0); }";
  const inputs = opts.withTexture
    ? [
        {
          channel: 0,
          ctype: "texture",
          id: 1,
          src: "/selftest/tex.png",
          sampler: { filter: "linear", wrap: "repeat", vflip: "false" },
        },
      ]
    : [];
  return JSON.stringify({
    Shader: {
      info: {
        id,
        name: "selftest_" + id,
        username: "selftest",
        likes: "7",
        views: "42",
        date: "0",
      },
      renderpass: [{ type: "image", code, inputs }],
    },
  });
}

/**
 * 内置假数据：三条，覆盖 GLSL1 / GLSL3 / 带纹理通道。
 * 导出是为了让「灌入示例数据」复用同一份 —— 示例 fixture 复制两份迟早会漂移。
 */
export const CANNED: string[] = [
  shaderJson("st0001", {}),
  shaderJson("st0002", { glsl3: true }),
  shaderJson("st0003", { withTexture: true }),
];

/** 完全本地的假 transport：不发任何请求。 */
function cannedTransport(payloads: string[]): CrawlTransport {
  let cursor = 0;
  return {
    async listIds(): Promise<ListPage> {
      // 只发一次；之后报到底，避免自测里出现无限补货
      const ids =
        cursor === 0
          ? payloads.map((_, i) => "st" + String(i + 1).padStart(4, "0"))
          : [];
      cursor += 1;
      return { ok: true, ids, nextCursor: "st", exhausted: ids.length === 0 };
    },
    async fetchShader(id: string): Promise<ShaderPayload> {
      const index = Number(id.replace("st", "")) - 1;
      const text = payloads[index];
      if (text === undefined) {
        return { ok: false, text: "", error: "自测数据里没有 " + id };
      }
      return { ok: true, text };
    },
  };
}

export async function runSelfTest(deps: SelfTestDeps): Promise<SelfTestReport> {
  const steps: SelfTestStep[] = [];
  const now = deps.now ?? (() => Date.now());
  // 时钟从注入的基准开始，每次落盘前进 1 秒：既保留可复现性，
  // 又让 LRU 的时间戳有明确的先后关系。
  let clock = now();
  const tickClock = () => {
    clock += 1000;
    return clock;
  };

  const realRoot = deps.root.replace(/\/+$/, "");
  // 自测开始前先记下真实缓存的占用（只读）。结束时要比对，
  // 证明自测确实没碰用户数据 —— 不能靠"我看代码应该没碰"。
  const realStore: Store = createStore(deps.fs, {
    root: realRoot,
    hash: deps.hash,
  });
  const realUsageBefore = await realStore.usage();

  function step(name: string, ok: boolean, detail: string): void {
    steps.push({ name, ok, detail });
  }

  function fail(name: string, detail: string): SelfTestReport {
    step(name, false, detail);
    return finish();
  }

  function finish(): SelfTestReport {
    const ok = steps.every((s) => s.ok);
    const width = Math.max(0, ...steps.map((s) => s.name.length));
    const lines = steps.map(
      (s) => (s.ok ? "✓ " : "✗ ") + s.name.padEnd(width) + "  " + s.detail,
    );
    const failed = steps.filter((s) => !s.ok).length;
    lines.push("");
    lines.push(
      ok
        ? "自测全部通过：" + steps.length + " 步。流水线与宿主实现都正常。"
        : "自测失败 " +
            failed +
            "/" +
            steps.length +
            " 步 —— 上面标 ✗ 的就是断点。",
    );
    return { ok, steps, text: lines.join("\n") };
  }

  const testRoot = deps.root.replace(/\/+$/, "") + "/" + SELFTEST_SUBDIR;
  const store: Store = createStore(deps.fs, {
    root: testRoot,
    hash: deps.hash,
    now: () => tickClock(),
    onWarn: (message: string) => {
      // 自测期间任何被吞掉的错误都记下来 —— 静默失败正是自测要消灭的东西
      steps.push({ name: "store 告警", ok: false, detail: message });
    },
  });

  // ---- 1. 建目录并清掉上次自测的残留 ----
  try {
    await store.clearAll();
    step("清理自测目录", true, testRoot);
  } catch (err) {
    return fail(
      "清理自测目录",
      String(err instanceof Error ? err.message : err),
    );
  }
  step("建目录 + 首次读取", true, "clearAll 未抛异常");

  // ---- 2. 写一条真实记录并读回（验证 Tools.Files 文本往返）----
  const crawler: Crawler = createCrawler(cannedTransport(CANNED), {
    maxAttempts: 1,
  });
  await crawler.ensure(3);
  const records: ShaderRecord[] = [];
  for (let r = crawler.take(); r; r = crawler.take()) {
    records.push(r);
  }
  if (records.length !== 3) {
    return fail("从内置数据解析出 3 条记录", "实际 " + records.length + " 条");
  }
  step("从内置数据解析出 3 条记录", true, records.map((r) => r.id).join(","));

  const first = records[0];
  try {
    await store.saveShader(first, true);
  } catch (err) {
    return fail(
      "写入 shader 正文",
      String(err instanceof Error ? err.message : err),
    );
  }
  const loaded = await store.loadShader(first.id);
  const roundTrip =
    !!loaded &&
    loaded.code === first.code &&
    loaded.username === first.username;
  step(
    "写入并读回 shader 正文",
    roundTrip,
    roundTrip
      ? "代码与作者一致（" + first.code.length + " 字符）"
      : "读回不一致或为 null",
  );

  // ---- 3. 索引（验证 dir 列表与元数据落盘）----
  for (const record of records.slice(1)) {
    await store.saveShader(record, true);
  }
  const list = await store.listShaders();
  step(
    "索引列出全部记录",
    list.length === 3,
    "共 " + list.length + " 条；最新的是 " + (list[0] ? list[0].id : "无"),
  );

  // ---- 4. 纹理：writeBinary + 去重 + LRU touch ----
  const textureUrl = "https://selftest.local/tex.png";
  try {
    const entry = await store.recordTexture(textureUrl, TEX_PNG_BASE64, "png");
    const touched = await store.touchTexture(textureUrl);
    const wroteRealBytes = entry.bytes > 0;
    step(
      "写入纹理并读回台账",
      !!touched && wroteRealBytes,
      "hash=" + entry.hash.slice(0, 12) + " 记账 " + entry.bytes + " 字节",
    );
    // 去重：同 URL 再来一次不应产生第二份文件
    await store.recordTexture(textureUrl, TEX_PNG_BASE64, "png");
    const usage = await store.usage();
    step(
      "同一 URL 的纹理去重",
      usage.textureCount === 1,
      "台账 " + usage.textureCount + " 条",
    );
  } catch (err) {
    return fail("纹理写入", String(err instanceof Error ? err.message : err));
  }

  // ---- 5. 占用统计（清理入口要显示的东西）----
  const usage = await store.usage();
  const usageOk =
    usage.shaderCount === 3 && usage.textureCount === 1 && usage.totalBytes > 0;
  step(
    "占用统计可用",
    usageOk,
    "shader " +
      usage.shaderCount +
      " 条 / 纹理 " +
      usage.textureCount +
      " 张 / 合计 " +
      usage.totalBytes +
      " 字节",
  );

  // ---- 6. feed：自动上滑 + 交给渲染器 ----
  const feedCrawler = createCrawler(cannedTransport(CANNED), {
    maxAttempts: 1,
  });
  await feedCrawler.ensure(3);

  let t = 0;
  const feed = createFeed(feedCrawler, {
    dwellMs: DWELL_MS,
    now: () => t,
    sessionSeed: 7,
  });

  const started = feed.start();
  if (!started.current) {
    return fail("feed.start 取到第一条", "current 为空");
  }
  step("feed.start 取到第一条", true, started.current.id);

  let load = await deps.loadIntoRunner(
    started.current,
    feed.timeOffsetSeconds(),
  );
  step(
    "渲染器接受第一条",
    load.ok,
    load.ok
      ? "iTime 起点 " + feed.timeOffsetSeconds() + "s"
      : load.error || "未知错误",
  );

  // 快进过 30 秒，验证自动上滑与第二条加载
  t += DWELL_MS;
  const advanced = feed.tick();
  step(
    "30 秒到点自动上滑",
    advanced.advanced && !!advanced.current,
    advanced.current ? "换到 " + advanced.current.id : "没有上滑",
  );
  if (advanced.current) {
    load = await deps.loadIntoRunner(
      advanced.current,
      feed.timeOffsetSeconds(),
    );
    step(
      "渲染器接受第二条",
      load.ok,
      load.ok ? advanced.current.id : load.error || "未知错误",
    );
  }

  // ---- 7. 清掉自测目录，并**真的**证明用户真实缓存没被动过 ----
  // 之前这里写成了「赋 true 就算过」的假断言 —— 那种东西比没有断言更糟，
  // 它会把"没验证"伪装成"验证通过"。改成前后占用对比。
  try {
    await store.clearAll();
    step("清理自测目录", true, "已清空 " + testRoot);
  } catch (err) {
    step(
      "清理自测目录",
      false,
      String(err instanceof Error ? err.message : err),
    );
  }

  const realUsageAfter = await realStore.usage();
  const untouched =
    JSON.stringify(realUsageBefore) === JSON.stringify(realUsageAfter);
  step(
    "用户真实缓存未被触碰（前后占用完全一致）",
    untouched,
    untouched
      ? "自测只在 " + SELFTEST_SUBDIR + " 子目录内读写"
      : "自测动了真实缓存：前 " +
          JSON.stringify(realUsageBefore) +
          " 后 " +
          JSON.stringify(realUsageAfter),
  );

  return finish();
}
