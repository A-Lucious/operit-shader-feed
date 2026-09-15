#!/usr/bin/env node
/**
 * 编译结果「线格式」两端的离线测试（compile-ipc.ts）。
 *
 * 这层是**运行时边界**，所以测试重点不在正常路径，而在三件事：
 *   1. 界面侧不能把"每秒一次的性能上报"当成编译结果发出去
 *      —— 那会让账本序号每秒 +1，AI 读到「第 137 次编译」这种鬼话
 *   2. main 侧拿到不可信 payload 时**绝不能抛**，也绝不能把认不出的东西塞进账本
 *   3. 认不出的东西被忽略之后，AI 仍然读得到上一次的真实结果
 *
 * 用法： node tests/compile-ipc.test.mjs   （需先跑 npx tsc）
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IPC_JS = join(ROOT, "dist/plugin/compile-ipc.js");
const LEDGER_JS = join(ROOT, "dist/plugin/compile-ledger.js");
if (!existsSync(IPC_JS) || !existsSync(LEDGER_JS)) {
  console.error("✗ 找不到编译产物，先跑 npx tsc");
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { toCompileIpcPayload, createCompileIpcHandlers } = require(IPC_JS);
const { createCompileLedger } = require(LEDGER_JS);

let pass = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    const suffix = detail ? `  → ${detail}` : "";
    console.log(`  ✗ ${name}${suffix}`);
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
  console.log("── 编码端：只认「一次编译结果」，性能上报必须被丢掉 ──");
  {
    const runOk = toCompileIpcPayload({ stage: "running", ok: true, errors: [] });
    eq("running → result", runOk && runOk.kind, "result");
    eq("running 是成功", runOk && runOk.ok, true);

    const bad = toCompileIpcPayload({
      stage: "compile",
      ok: false,
      errors: [ERR],
    });
    eq("compile → result", bad && bad.kind, "result");
    eq("compile 是失败", bad && bad.ok, false);
    eq("报错原文带过去了", bad && bad.errors && bad.errors[0], ERR);

    const init = toCompileIpcPayload({ ok: false, stage: "init", errors: ["boom"] });
    eq("init（上下文都没建起来）也算一次结果", init && init.ok, false);

    // 这条是重点：stats 每秒一次，混进来就会污染账本
    eq(
      "stats 性能上报必须返回 null（否则账本序号会每秒 +1）",
      toCompileIpcPayload({ stage: "stats", fps: 60, frames: 120, time: 2 }),
      null,
    );
    eq("契约探测之类的其它 stage 也丢掉", toCompileIpcPayload({ stage: "crawl-probe" }), null);

    for (const junk of [null, undefined, 42, "text", {}, [], true]) {
      eq(`不是对象/没有 stage 的一律 null：${JSON.stringify(junk)}`, toCompileIpcPayload(junk), null);
    }

    // 宿主桥可能把上报原样递过来（字符串），所以编码端必须自己容忍 JSON 文本 ——
    // 「解析放在边界」而不是让调用侧多写一个返回 unknown 的辅助函数。
    const asText = toCompileIpcPayload(
      JSON.stringify({ stage: "compile", ok: false, errors: [ERR] }),
    );
    eq("JSON 字符串形式也能解", asText && asText.kind, "result");
    eq("JSON 字符串形式的报错也在", asText && asText.errors && asText.errors[0], ERR);
    eq("坏 JSON 不抛、返回 null", toCompileIpcPayload("{ 这不是 JSON"), null);
    eq("JSON 数组同样不是有效上报", toCompileIpcPayload("[1,2,3]"), null);
  }

  console.log("── 编码端：字段脏了怎么办 ──");
  {
    const mixed = toCompileIpcPayload({
      stage: "compile",
      errors: [ERR, 42, null, { a: 1 }, "第二行"],
    });
    eq("errors 里的非字符串被过滤", mixed && mixed.errors && mixed.errors.length, 2);
    eq("留下的顺序不变", mixed && mixed.errors && mixed.errors[1], "第二行");

    const noErrors = toCompileIpcPayload({ stage: "compile" });
    eq("errors 缺失 → 空数组（不是 undefined）", noErrors && noErrors.errors && noErrors.errors.length, 0);

    const withLen = toCompileIpcPayload({ stage: "running", ok: true }, { codeLength: 320 });
    eq("codeLength 会带上", withLen && withLen.codeLength, 320);
    ok(
      "codeLength 是负数/NaN 时不带（别编一个假长度出来）",
      toCompileIpcPayload({ stage: "running", ok: true }, { codeLength: -5 }) ===
        null ||
        toCompileIpcPayload({ stage: "running", ok: true }, { codeLength: -5 })
          .codeLength === undefined,
    );

    // 自相矛盾的组合：以 stage 为准，宁可当失败（AI 会去查）
    const weird = toCompileIpcPayload({ stage: "compile", ok: true });
    eq("stage 说编译失败就是失败，即使 ok 传了 true", weird && weird.ok, false);
  }

  console.log("── 解码端：不可信 payload 不许抛、不许污染账本 ──");
  {
    const ledger = createCompileLedger({ now: () => 1000 });
    const handlers = createCompileIpcHandlers(ledger);

    handlers.write({ kind: "pending", codeLength: 100 });
    eq("pending 让账本进入 pending", ledger.state().kind, "pending");

    handlers.write({ kind: "result", ok: false, errors: [ERR], codeLength: 100 });
    ok("result 让 AI 读到报错原文", handlers.read().includes(ERR), handlers.read());

    const before = handlers.read();
    let threw = null;
    try {
      for (const junk of [
        null,
        undefined,
        42,
        "text",
        {},
        [],
        { kind: "nonsense" },
        { kind: "result", ok: "yes", errors: "not-an-array" },
        { kind: "pending", codeLength: "abc" },
        { kind: "result", errors: [1, 2, 3] },
      ]) {
        handlers.write(junk);
      }
    } catch (err) {
      threw = err;
    }
    ok("一堆垃圾 payload 都不抛异常", threw === null, threw && String(threw.message));

    // 最后一条是 { kind:"result", errors:[1,2,3] } —— 它是合法 kind，所以会写进账本，
    // 但非字符串会被过滤掉，于是变成"失败但没有日志"，这对 AI 仍然是有用的话。
    const after = handlers.read();
    ok("读出来的永远是可用的文本（不会是空话）", after.trim() !== "", JSON.stringify(after));
    ok("而且仍然在说人话（不是 [object Object]）", !after.includes("[object"), after);
    ok("垃圾没有被当成「还没有收到」", !after.includes("还没有收到"), after);
    ok("before 与 after 都是文本（便于对照）", typeof before === "string" && typeof after === "string");

    // 只发了垃圾 kind 时，账本必须原封不动
    const ledger2 = createCompileLedger({ now: () => 2000 });
    const h2 = createCompileIpcHandlers(ledger2);
    h2.write({ kind: "result", ok: true, errors: [] });
    const snapshot = h2.read();
    h2.write({ kind: "nonsense" });
    h2.write("who am i");
    h2.write(null);
    eq("认不出的 kind 不改动账本", h2.read(), snapshot);
  }

  console.log("── 端到端（进程内）：一次编译失败走完两端后，AI 读到什么 ──");
  {
    const ledger = createCompileLedger({ now: () => 3000 });
    const handlers = createCompileIpcHandlers(ledger);

    handlers.write({ kind: "pending", codeLength: 260 });
    ok(
      "刚下发、还没编译完时，AI 读到「还在编译」（而不是上一次的错误）",
      handlers.read().includes("还在编译"),
      handlers.read(),
    );

    const payload = toCompileIpcPayload(
      { stage: "compile", ok: false, errors: [ERR] },
      { codeLength: 260 },
    );
    handlers.write(payload);
    const text = handlers.read();
    ok("编译失败后 AI 读到编译器原文", text.includes(ERR), text);
    ok("并知道代码长度（能判断是不是它刚写那段）", text.includes("260"), text);
    ok("并拿到下一步动作", text.includes("重新写一遍"), text);
  }

  console.log(`\n${pass}/${pass + failures.length} 通过`);
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败`);
    process.exit(1);
  }
  console.log(
    "✓ 「stats 不许污染账本」「不可信 payload 不抛也不脏账本」「两端语义对称」全部锁住",
  );
}

main();
