#!/usr/bin/env node
/**
 * 缓存数据源（store-crawler.ts）的离线测试。
 *
 * 这一层是 D6「拔网后仍能刷已缓存内容」的实现，也是让 feed 通路能在真机上
 * **不依赖网络**就完成第一次验证的关键。所以测试里有一条真的「不联网」断言：
 * 把全局 fetch 换成会抛异常的实现，任何试图联网的路径都会当场炸出来。
 *
 * 用法： node tests/store-crawler.test.mjs   （需先跑 npx tsc）
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SC_JS = join(ROOT, "dist/feed/store-crawler.js");
const FEED_JS = join(ROOT, "dist/feed/feed.js");
if (!existsSync(SC_JS) || !existsSync(FEED_JS)) {
  console.error("✗ 找不到编译产物，先跑 npx tsc");
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { createStoreCrawler } = require(SC_JS);
const { createFeed } = require(FEED_JS);

let pass = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? "  → " + detail : ""}`);
  }
}
const eq = (name, a, b) =>
  ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);

const rec = (id, savedAt) => ({
  id,
  name: "n_" + id,
  username: "u",
  likes: 0,
  views: 0,
  date: "0",
  code: "void mainImage(out vec4 c, in vec2 f){ c=vec4(0.); } // " + id,
  common: "",
  passCount: 1,
  hasBuffers: false,
  isGLSL3: false,
  channels: [],
  unsupportedChannels: [],
  savedAt,
});

/** 假缓存源：按 savedAt 倒序返回元数据（和真实 store 的 listShaders 一致）。 */
function makeSource(records, opts = {}) {
  const state = { listCalls: 0, loadCalls: [] };
  return {
    state,
    source: {
      async listShaders() {
        state.listCalls++;
        return [...records]
          .sort((a, b) => b.savedAt - a.savedAt)
          .map((r) => ({ id: r.id }));
      },
      async loadShader(id) {
        state.loadCalls.push(id);
        if (opts.missing && opts.missing.includes(id)) return null;
        return records.find((r) => r.id === id) ?? null;
      },
    },
  };
}

async function main() {
  // 真的「不联网」断言：任何试图联网的路径都会打到这个桩上并抛异常。
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("居然联网了 —— 这一层必须完全离线");
  };

  try {
    console.log("── 基本读取：按保存时间倒序、按需逐条读正文 ──");
    {
      const { state, source } = makeSource([
        rec("a1", 100),
        rec("a2", 300),
        rec("a3", 200),
      ]);
      const crawler = createStoreCrawler(source);
      await crawler.ensure(2);
      eq("ensure(2) 后前方有 2 条", crawler.ahead(), 2);
      eq("只读了 2 个文件（不是把整表读进来）", state.loadCalls.length, 2);
      eq("读的是最新的两条", state.loadCalls.join(","), "a2,a3");
      eq("元数据只读了一次", state.listCalls, 1);

      const first = crawler.take();
      eq("take 拿到最新那条", first && first.id, "a2");
      eq("take 后前方减 1", crawler.ahead(), 1);
      ok("exhausted 为假（还有内容在后）", crawler.exhausted() === false);
    }

    console.log("── 重复 ensure 不该重读元数据 ──");
    {
      const { state, source } = makeSource([
        rec("b1", 1),
        rec("b2", 2),
        rec("b3", 3),
      ]);
      const crawler = createStoreCrawler(source);
      await crawler.ensure(3);
      await crawler.ensure(3);
      eq("元数据仍然只读了一次", state.listCalls, 1);
      eq("前方仍是 3 条", crawler.ahead(), 3);
    }

    console.log("── 坏数据（读不到正文）必须跳过，不能卡住整轮 ──");
    {
      const { source } = makeSource(
        [rec("c1", 3), rec("c2", 2), rec("c3", 1)],
        { missing: ["c2"] },
      );
      const crawler = createStoreCrawler(source);
      await crawler.ensure(3);
      // c2 读不到，只应有 2 条；且循环不能因为 c2 而提前退出
      eq("跳过后拿到 2 条", crawler.ahead(), 2);
      eq("第一条是 c1", crawler.take().id, "c1");
      eq("第二条直接是 c3（跳过了 c2）", crawler.take().id, "c3");
      eq("取完为空", crawler.take(), null);
    }

    console.log("── 耗尽语义 ──");
    {
      const { source } = makeSource([rec("d1", 1)]);
      const crawler = createStoreCrawler(source);
      ok(
        "还没 ensure 时 exhausted 为假（还不知道有没有）",
        crawler.exhausted() === false,
      );
      await crawler.ensure(5);
      eq("缓存只有 1 条，前方就是 1", crawler.ahead(), 1);
      const got = crawler.take();
      eq("取到 d1", got && got.id, "d1");
      eq("取完后前方为 0", crawler.ahead(), 0);
      ok("取完后 exhausted 为真", crawler.exhausted() === true);
      eq("再取返回 null（不崩）", crawler.take(), null);
    }

    console.log("── 空缓存（首次运行）也要能跑 ──");
    {
      const { source } = makeSource([]);
      const crawler = createStoreCrawler(source);
      await crawler.ensure(8);
      eq("前方为 0", crawler.ahead(), 0);
      eq("take 返回 null", crawler.take(), null);
      ok("exhausted 为真", crawler.exhausted() === true);
    }

    console.log("── take 在任何时刻都不该崩 ──");
    {
      const { source } = makeSource([rec("e1", 1)]);
      const crawler = createStoreCrawler(source);
      eq("ensure 之前 take 返回 null", crawler.take(), null);
      eq("ensure 之前 ahead 为 0", crawler.ahead(), 0);
      await crawler.ensure(1);
      eq("ensure 之后能取到", crawler.take().id, "e1");
      eq("重复 take 返回 null", crawler.take(), null);
    }

    console.log("── limit 限制考虑范围（缓存很大时列表本身也不该变重）──");
    {
      const many = Array.from({ length: 10 }, (_, i) => rec("f" + i, i));
      const { source } = makeSource(many);
      const crawler = createStoreCrawler(source, { limit: 3 });
      await crawler.ensure(100);
      eq("只考虑 3 条", crawler.ahead(), 3);
    }

    console.log("── 与 feed 串联：这是「拔网后仍能刷已缓存内容」的实际形态 ──");
    {
      const { source } = makeSource([
        rec("g1", 10),
        rec("g2", 30),
        rec("g3", 20),
      ]);
      const crawler = createStoreCrawler(source);
      // 真实用法：宿主先 await ensure 把 buffer 填上，再开播。
      await crawler.ensure(8);
      let t = 0;
      const feed = createFeed(crawler, {
        dwellMs: 30000,
        now: () => t,
        sessionSeed: 3,
      });

      const first = feed.start();
      ok(
        "feed.start 直接拿到缓存里最新的一条",
        first.current && first.current.id === "g2",
        JSON.stringify(first.current && first.current.id),
      );

      t += 30000;
      const second = feed.tick();
      ok(
        "30 秒后自动上滑到第二条",
        second.advanced && second.current && second.current.id === "g3",
        JSON.stringify(second.current && second.current.id),
      );

      t += 30000;
      const third = feed.tick();
      ok(
        "再 30 秒滑到第三条",
        third.advanced && third.current && third.current.id === "g1",
      );
    }

    console.log(
      "── 启动时还没有数据：第一条就绪就要立刻开播，不能干等 30 秒 ──",
    );
    {
      const { source } = makeSource([rec("i1", 1), rec("i2", 2)]);
      const crawler = createStoreCrawler(source);
      let t = 0;
      const feed = createFeed(crawler, { dwellMs: 30000, now: () => t });

      // 故意先不 ensure：模拟「进了插件，爬虫还没拿回第一条」
      const empty = feed.start();
      eq("启动时没内容 → 不报 advanced", empty.advanced, false);
      eq("current 为 null", feed.current(), null);

      // 数据到了（等价于宿主那边补货落地）
      await crawler.ensure(8);
      t += 1000; // 只过 1 秒，远没到 30 秒
      const picked = feed.tick();
      eq("内容一到就立刻开播（不是等 30 秒）", picked.advanced, true);
      ok(
        "播的是缓存里最新那条",
        picked.current && picked.current.id === "i2",
        String(picked.current && picked.current.id),
      );
    }

    console.log("── 缓存只有 1 条时，feed 停在它上面而不是白屏 ──");
    {
      const { source } = makeSource([rec("h1", 1)]);
      const crawler = createStoreCrawler(source);
      await crawler.ensure(8);
      let t = 0;
      const feed = createFeed(crawler, { dwellMs: 30000, now: () => t });
      feed.start();
      t += 90000;
      const tick = feed.tick();
      eq("没内容可换时不报 advanced", tick.advanced, false);
      ok("停在 h1", feed.current() && feed.current().id === "h1");
      ok("waiting() 说明真的卡住了", feed.waiting() === true);
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\n${pass}/${pass + failures.length} 通过`);
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败`);
    process.exit(1);
  }
  console.log(
    "✓ 缓存数据源（按需读取 / 跳过坏数据 / 耗尽语义 / 空缓存 / 与 feed 串联）全部锁住，且全程零联网",
  );
}

main();
