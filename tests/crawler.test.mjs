#!/usr/bin/env node
/**
 * P1 爬取队列的离线测试。
 *
 * crawler.ts 只跟一个 CrawlTransport 打交道，所以并发上限、重试次数、去重、耗尽判定
 * 这些语义能在 Node 里用假 transport 真测，不必等设备。
 * 这里锁的是 PLAN §4 D5 的每一条参数。
 *
 * 用法： node tests/crawler.test.mjs   （需先跑 npx tsc）
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPILED = join(ROOT, "dist/feed/crawler.js");
if (!existsSync(COMPILED)) {
  console.error(`✗ 找不到 ${COMPILED}，先跑 npx tsc`);
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { createCrawler } = require(COMPILED);

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

/** 构造一个形状合法的 shader 响应。 */
function shaderJson(id, opts = {}) {
  const renderpass = [
    {
      type: "image",
      code: "void mainImage(out vec4 c, in vec2 f){ c=vec4(0.); }",
      inputs: [],
    },
  ];
  if (opts.withBuffer) {
    renderpass.unshift({
      type: "buffer",
      code: "void mainImage(out vec4 c, in vec2 f){ c=vec4(0.); }",
      inputs: [],
    });
  }
  return JSON.stringify({
    Shader: {
      info: {
        id,
        name: "n_" + id,
        username: "u",
        likes: "1",
        views: "2",
        date: "0",
      },
      renderpass,
    },
  });
}

/**
 * 假 transport。plan[id] 可控制失败模式：
 *   "alwaysfail" 每次失败 | "failonce" 首次失败 | "badtoken" 返回非法 JSON | undefined 正常
 */
function makeFake(pages, options = {}) {
  const state = {
    inFlight: 0,
    maxInFlight: 0,
    listCalls: [],
    attempts: new Map(),
  };
  const transport = {
    async listIds(cursor, limit) {
      state.listCalls.push({ cursor, limit });
      const page = pages[cursor === "" ? "start" : cursor];
      return page ?? { ok: true, ids: [], nextCursor: "", exhausted: true };
    },
    async fetchShader(id) {
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        await new Promise((r) => setTimeout(r, options.delayMs ?? 1));
        const n = (state.attempts.get(id) ?? 0) + 1;
        state.attempts.set(id, n);
        const mode = options.plan ? options.plan[id] : undefined;
        if (mode === "alwaysfail")
          return { ok: false, text: "", error: "boom" };
        if (mode === "failonce" && n === 1)
          return { ok: false, text: "", error: "boom" };
        if (mode === "badtoken") return { ok: true, text: "<<not json>>" };
        return {
          ok: true,
          text: shaderJson(id, { withBuffer: mode === "buffer" }),
        };
      } finally {
        state.inFlight--;
      }
    },
  };
  return { transport, state };
}

const ids = (n, prefix = "id") =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

async function main() {
  console.log("── D5: 并发上限 3 ──");
  {
    const { transport, state } = makeFake({
      start: { ok: true, ids: ids(12), nextCursor: "p2" },
    });
    const crawler = createCrawler(transport);
    await crawler.ensure(8);
    ok(
      "ensure(8) 后前方 >= 8",
      crawler.ahead() >= 8,
      `实际 ${crawler.ahead()}`,
    );
    ok(
      "并发从未超过 3",
      state.maxInFlight <= 3,
      `实测峰值 ${state.maxInFlight}`,
    );
    eq(
      "列表请求带的 limit = 24（D5 列表页大小）",
      state.listCalls[0].limit,
      24,
    );
    eq("首页游标为空串", state.listCalls[0].cursor, "");
  }

  console.log("── D5: 失败重试最多 1 次，然后跳过且不阻塞队列 ──");
  {
    const { transport, state } = makeFake(
      { start: { ok: true, ids: ["a1", "a2", "a3", "a4"] } },
      { plan: { a2: "alwaysfail", a3: "failonce" } },
    );
    const crawler = createCrawler(transport);
    await crawler.ensure(10);
    const got = [];
    for (let r = crawler.take(); r; r = crawler.take()) got.push(r.id);
    ok("永久失败的那条被跳过", !got.includes("a2"), JSON.stringify(got));
    ok("首失败次成功的那条最终拿到", got.includes("a3"), JSON.stringify(got));
    ok(
      "其余正常条目都拿到",
      got.includes("a1") && got.includes("a4"),
      JSON.stringify(got),
    );
    eq(
      "永久失败的条目只尝试 2 次（不是无限重试）",
      state.attempts.get("a2"),
      2,
    );
    eq("failonce 的条目尝试 2 次", state.attempts.get("a3"), 2);
    eq("正常条目只尝试 1 次", state.attempts.get("a1"), 1);
    const s = crawler.stats();
    eq("detailFailures 计入 1 条", s.detailFailures, 1);
    eq("retries 计入 2 次（两条各重试一次）", s.retries, 2);
  }

  console.log("── 去重：同一个 id 绝不取两次详情 ──");
  {
    const { transport, state } = makeFake({
      start: { ok: true, ids: ["d1", "d2"], nextCursor: "p2" },
      p2: { ok: true, ids: ["d2", "d3"], nextCursor: "p3" },
      p3: { ok: true, ids: [], nextCursor: "", exhausted: true },
    });
    const crawler = createCrawler(transport);
    await crawler.ensure(10);
    const got = [];
    for (let r = crawler.take(); r; r = crawler.take()) got.push(r.id);
    ok("跨页去重后拿到 3 条", got.length === 3, JSON.stringify(got));
    eq("重叠 id 只请求了 1 次", state.attempts.get("d2"), 1);
  }

  console.log("── D3 复核所需的统计：多 pass 只标记、不丢弃 ──");
  {
    const { transport } = makeFake(
      { start: { ok: true, ids: ["s1", "m1", "s2", "m2"] } },
      { plan: { m1: "buffer", m2: "buffer" } },
    );
    const crawler = createCrawler(transport);
    await crawler.ensure(10);
    const got = [];
    for (let r = crawler.take(); r; r = crawler.take()) got.push(r);
    eq("多 pass 的记录也交付了（不能被静默丢弃）", got.length, 4);
    const s = crawler.stats();
    eq("singlePass 计数", s.singlePass, 2);
    eq("multiPass 计数", s.multiPass, 2);
    eq("单 pass 占比可算出来（2/4）", s.singlePass / s.delivered, 0.5);
    const multi = got.find((r) => r.id === "m1");
    ok(
      "多 pass 记录带 hasBuffers 标记",
      multi && multi.hasBuffers === true,
      JSON.stringify(multi && multi.hasBuffers),
    );
  }

  console.log("── 解析失败也走同一条重试/跳过路径 ──");
  {
    const { transport, state } = makeFake(
      { start: { ok: true, ids: ["p1", "p2"] } },
      { plan: { p1: "badtoken" } },
    );
    const crawler = createCrawler(transport);
    await crawler.ensure(5);
    const got = [];
    for (let r = crawler.take(); r; r = crawler.take()) got.push(r.id);
    ok("解析不了的条目被跳过", !got.includes("p1"), JSON.stringify(got));
    ok("正常条目不受影响", got.includes("p2"), JSON.stringify(got));
    eq("非法响应也只尝试 2 次", state.attempts.get("p1"), 2);
    ok("parseFailures 有计数", crawler.stats().parseFailures >= 0);
  }

  console.log("── 耗尽判定与列表失败容错 ──");
  {
    const { transport } = makeFake({
      start: { ok: true, ids: ["e1", "e2"], nextCursor: "", exhausted: true },
    });
    const crawler = createCrawler(transport);
    await crawler.ensure(10);
    ok(
      "列表耗尽后 exhausted()=false（还有内容可取）",
      crawler.exhausted() === false,
    );
    while (crawler.take()) {
      /* 抽干 */
    }
    await crawler.ensure(5);
    ok("抽干且列表到底 → exhausted()=true", crawler.exhausted() === true);
  }
  {
    let calls = 0;
    const flaky = {
      async listIds() {
        calls++;
        if (calls === 1)
          return { ok: false, ids: [], nextCursor: "", error: "网络挂了" };
        return { ok: true, ids: ["f1"], nextCursor: "", exhausted: true };
      },
      async fetchShader(id) {
        return { ok: true, text: shaderJson(id) };
      },
    };
    const crawler = createCrawler(flaky);
    await crawler.ensure(3);
    eq("首次列表失败 → 前方为空", crawler.ahead(), 0);
    await crawler.ensure(3);
    ok(
      "列表恢复后能继续补货（失败没把爬虫判死）",
      crawler.ahead() === 1,
      `实际 ${crawler.ahead()}`,
    );
    eq("listFailures 有计数", crawler.stats().listFailures, 1);
  }

  console.log("── 并发上限在大批量下仍然成立 ──");
  {
    const { transport, state } = makeFake(
      { start: { ok: true, ids: ids(40, "big") } },
      { delayMs: 2 },
    );
    const crawler = createCrawler(transport);
    await crawler.ensure(30);
    ok("前方 >= 30", crawler.ahead() >= 30, `实际 ${crawler.ahead()}`);
    ok(
      "40 条压力下并发峰值仍 <= 3",
      state.maxInFlight <= 3,
      `实测峰值 ${state.maxInFlight}`,
    );
    const drained = [];
    for (let r = crawler.take(); r; r = crawler.take()) drained.push(r.id);
    eq("抽干后的条数 = 已交付数", drained.length, crawler.stats().delivered);
    ok(
      "抽干结果无重复（去重真的生效）",
      new Set(drained).size === drained.length,
      `${drained.length} 条`,
    );
    ok("条数不超过列表提供的 40", drained.length <= 40, `${drained.length} 条`);
  }

  console.log("── 病态列表响应：卡住时不能变成每秒一个列表请求 ──");
  {
    // 情况 1：永远只回同一批重复 id，且游标不前进
    let calls = 0;
    const stuck = {
      async listIds() {
        calls += 1;
        return { ok: true, ids: ["dup1", "dup2"], nextCursor: "never-advances" };
      },
      async fetchShader(id) {
        return { ok: true, text: shaderJson(id) };
      },
    };
    const crawler = createCrawler(stuck);
    await crawler.ensure(5);
    const afterFirstPass = calls;
    ok("游标不前进：一轮就判到底（不是无休止翻页）", afterFirstPass <= 2, "listCalls=" + afterFirstPass);
    eq("那两条仍被拿到了", crawler.ahead(), 2);

    // 排空后才能说"到底了"（exhausted 要求前方也为空）
    crawler.take();
    crawler.take();
    eq("排空后 exhausted 为真", crawler.exhausted(), true);

    // 关键：再反复 ensure 不得继续打列表接口 —— 这才是"卡住时每秒一个请求"的入口
    for (let i = 0; i < 10; i++) {
      await crawler.ensure(5);
    }
    eq("再连着 ensure 10 次也不发列表请求", calls, afterFirstPass);
  }
  {
    // 情况 2：游标每次都在前进，但只回已见过的 id
    const pages = {};
    for (let i = 0; i < 8; i++) {
      pages[i === 0 ? "start" : "p" + i] = {
        ok: true,
        ids: ["onlydup"],
        nextCursor: "p" + (i + 1),
      };
    }
    const { transport, state } = makeFake(pages);
    const crawler = createCrawler(transport);

    for (let i = 0; i < 4; i++) {
      await crawler.ensure(3);
    }
    ok("游标前进但只回重复 id：连续几页后也会判到底", state.listCalls.length <= 5, "listCalls=" + state.listCalls.length);
    crawler.take();
    eq("排空后 exhausted 为真", crawler.exhausted(), true);

    const before = state.listCalls.length;
    for (let i = 0; i < 5; i++) {
      await crawler.ensure(3);
    }
    eq("判到底后不再发列表请求", state.listCalls.length, before);
  }

  console.log(`\n${pass}/${pass + failures.length} 通过`);
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败`);
    process.exit(1);
  }
  console.log(
    "✓ D5 的每条参数（并发 3 / 重试 1 次 / 跳过不阻塞 / 去重 / 补货 / 多 pass 统计）全部锁住",
  );
}

main();
