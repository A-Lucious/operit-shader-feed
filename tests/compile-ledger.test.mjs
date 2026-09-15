#!/usr/bin/env node
/**
 * 编译结果账本（compile-ledger.ts）的离线测试。这是 P6「AI 自动修到编译通过」的核心逻辑。
 *
 * 这里真正要锁住的是**时序**，不是"能不能把报错送出来"：
 *   编译是异步的（WebView 渲染完才知道结果），而 AI 写完 shader 会立刻来读。
 *   如果账本只有"最近一次结果"，AI 读到的会是**上一次**的报错 —— 它会照着去改一段
 *   自己根本没写错、甚至已经改过的代码。所以「下发新代码 → 旧报错必须立刻读不到」
 *   是一条独立断言。
 *
 * 用法： node tests/compile-ledger.test.mjs   （需先跑 npx tsc）
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER_JS = join(ROOT, "dist/plugin/compile-ledger.js");
if (!existsSync(LEDGER_JS)) {
  console.error("✗ 找不到编译产物，先跑 npx tsc");
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { createCompileLedger } = require(LEDGER_JS);

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
/**
 * 值相等断言。**收到布尔值就直接报错** —— 谓词要用 ok()。
 * 这个守卫来自真实教训：把 `x >= 1000` 这类谓词传给 eq() 已经犯过四次，
 * 每次都表现为「期望 "1000"，实际 true」这种要读两遍才明白的消息。
 * 注意只在期望值不是布尔时拦：布尔对布尔是合法比较，不是这个错误。
 */
const eq = (name, a, b) => {
  if (typeof a === "boolean" && typeof b !== "boolean") {
    throw new Error(
      `eq() 收到了布尔断言：「${name}」—— 谓词请改用 ok(name, 条件, 详情)`,
    );
  }
  ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};

const ERR = "[fragment] ERROR: 0:42: 'uv2' : undeclared identifier";

function main() {
  console.log("── 还没有任何结果：要说清楚「稍后再读」，而不是报错 ──");
  {
    const led = createCompileLedger({ now: () => 1000 });
    eq("初始状态是 idle", led.state().kind, "idle");
    const text = led.describe();
    ok("说「还没有收到任何编译结果」", text.includes("还没有收到"), text);
    ok("并告诉 AI 稍后再调用一次", text.includes("稍后再调用"), text);
    ok("不会误导成「编译失败」", !text.includes("失败"), text);
  }

  console.log("── 核心：下发新代码后，旧报错必须立刻读不到 ──");
  {
    const led = createCompileLedger({ now: () => 2000 });
    led.record({ ok: false, errors: [ERR], codeLength: 300 });
    ok("第一次失败能读到报错原文", led.describe().includes("uv2"), led.describe());

    // AI 按报错改完之后界面会重新下发 —— 此刻新结果还没回来
    led.markPending({ codeLength: 310 });
    eq("状态变成 pending", led.state().kind, "pending");
    const during = led.describe();
    ok("pending 时不能再说「失败」", !during.includes("失败"), during);
    ok(
      "pending 时**绝不能**把上一次的报错原文递给 AI（否则它会去改已经改过的地方）",
      !during.includes("uv2"),
      during,
    );
    ok("并明确说「还在编译」", during.includes("还在编译"), during);
  }

  console.log("── 成功与失败都要有明确结论 ──");
  {
    const led = createCompileLedger({ now: () => 3000 });
    led.record({ ok: true, codeLength: 500 });
    ok("成功时说「成功」", led.describe().includes("成功"), led.describe());
    ok("成功时不提「失败」", !led.describe().includes("失败"), led.describe());

    led.record({ ok: false, errors: [ERR], codeLength: 512 });
    const text = led.describe();
    ok("失败时带编译器原文", text.includes(ERR), text);
    ok("失败时给出下一步动作", text.includes("重新写一遍"), text);
    ok("报错原文前后有上下文（不是光秃秃一行）", text.includes("GLSL 编译器原文"), text);
  }

  console.log("── 边角：空日志、空行、长度未知、截断 ──");
  {
    const led = createCompileLedger({ now: () => 4000 });
    led.record({ ok: false, errors: [] });
    const noLog = led.describe();
    ok("没有日志也要说人话（不能是空话）", noLog.includes("没有给出日志"), noLog);
    ok("并给出排查方向", noLog.includes("状态条"), noLog);

    led.record({ ok: false, errors: ["", "   ", ERR] });
    ok("空行会被过滤，正常报错留下", led.describe().includes(ERR), led.describe());
    eq("空行没有变成错误条目", led.state().errors.length, 1);

    // 长度未知时不该编一个「代码 0 字」出来，那会让 AI 以为拿到了别人的结果
    led.record({ ok: true });
    ok("长度未知时不提字数", !led.describe().includes("代码 0 字"), led.describe());

    // pending 里知道的长度要延续到结果上
    led.markPending({ codeLength: 120 });
    led.record({ ok: true });
    ok("pending 的长度会延续到结果", led.describe().includes("代码 120 字"), led.describe());
  }
  {
    const led = createCompileLedger({ now: () => 5000, maxErrorChars: 200 });
    led.record({ ok: false, errors: ["x".repeat(500)] });
    const text = led.describe();
    ok("超长报错会被截断", text.includes("已截断"), text.slice(-120));
    ok("并说明截掉了多少", text.includes("300"), text.slice(-120));
    ok("截断后仍然给出下一步动作", text.includes("重新写一遍"), text);
  }

  console.log("── 序号递增 + reset ──");
  {
    const led = createCompileLedger({ now: () => 6000 });
    led.record({ ok: true });
    ok("第 1 次", led.describe().includes("第 1 次"), led.describe());
    led.record({ ok: false, errors: [ERR] });
    ok("第 2 次", led.describe().includes("第 2 次"), led.describe());
    led.reset();
    eq("reset 回到 idle", led.state().kind, "idle");
    ok("reset 后描述也回到 idle 措辞", led.describe().includes("还没有收到"), led.describe());
  }

  console.log("── 穷举：任何状态、任何调用顺序都不能产出空话 ──");
  {
    const led = createCompileLedger({ now: () => 7000 });
    let bad = "";
    let checked = 0;
    const steps = [
      () => led.describe(),
      () => led.markPending({ codeLength: 10 }),
      () => led.record({ ok: false, errors: [] }),
      () => led.record({ ok: false, errors: ["\n"] }),
      () => led.record({ ok: true }),
      () => led.record({ ok: false, errors: [ERR] }),
      () => led.markPending(),
      () => led.reset(),
    ];
    for (let round = 0; round < 3; round++) {
      for (const step of steps) {
        const text = step();
        checked++;
        if (typeof text !== "string") {
          continue; // 状态推进类调用没有返回值
        }
        if (!bad && text.trim() === "") {
          bad = "空字符串（第 " + round + " 轮）";
        }
        if (!bad && (text.includes("undefined") || text.includes("NaN"))) {
          bad = "串出了 " + text;
        }
      }
    }
    eq("组合数", checked, 24);
    eq("没有空话/串值", bad, "");
  }

  console.log(`\n${pass}/${pass + failures.length} 通过`);
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败`);
    process.exit(1);
  }
  console.log(
    "✓ 「下发新代码后旧报错立刻读不到」这个时序陷阱 + 每种状态的措辞 全部锁住",
  );
}

main();
