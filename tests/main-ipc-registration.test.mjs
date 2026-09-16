#!/usr/bin/env node
/**
 * main 脚本的 IPC 注册位置回归测试。
 *
 * 真机故障（v0.8.0）：`ToolPkg.ipc channel is not registered:
 * shader_feed.compile_result.write / .read`。
 * 根因：handler 注册在 registerToolPkg() 里，而宿主调用它的是一次性注册引擎（跑完即毁）；
 * 真正接收 IPC 的 main 执行引擎里，__operitToolPkgIpcRegistry 永远是空的。
 *
 * 这个测试在 Node 里**只加载脚本、不调用 registerToolPkg()**，
 * 断言两个通道已经被注册 —— 旧代码会在这一条上失败，新代码通过。
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN_JS = join(ROOT, "dist/main.js");
if (!existsSync(MAIN_JS)) {
  console.error("✗ 找不到编译产物，先跑 npx tsc");
  process.exit(2);
}

let pass = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) {
    pass++;
    console.log("  ✓ " + name);
  } else {
    failures.push(name);
    console.log("  ✗ " + name + (detail ? "  → " + detail : ""));
  }
}

// —— 假宿主：只需要 ipc 与两个 register* 能力 ——
const channels = new Map();
const registeredOrder = [];
globalThis.ToolPkg = {
  ipc: {
    on(channel, handler) {
      channels.set(channel, handler);
      registeredOrder.push(channel);
      return () => channels.delete(channel);
    },
  },
  registerXmlRenderPlugin(spec) {
    globalThis.__xmlSpec = spec;
  },
  registerSystemPromptComposeHook(spec) {
    globalThis.__promptSpec = spec;
  },
};

const require = createRequire(import.meta.url);
const main = require(MAIN_JS);

console.log("── 加载脚本即注册（不依赖 registerToolPkg）──");
ok(
  "写通道已注册",
  channels.has("shader_feed.compile_result.write"),
  [...channels.keys()].join(", "),
);
ok(
  "读通道已注册",
  channels.has("shader_feed.compile_result.read"),
  [...channels.keys()].join(", "),
);

console.log("── 通道真的连到 main 里的账本 ──");
const write = channels.get("shader_feed.compile_result.write");
const read = channels.get("shader_feed.compile_result.read");
{
  const writeRet = write({
    kind: "result",
    ok: false,
    errors: ["0:22: '<': syntax error"],
  });
  ok("写通道返回 true", writeRet === true, String(writeRet));
  const text = read();
  ok(
    "写入的结果能被读回（含报错原文）",
    typeof text === "string" && text.includes("0:22"),
    String(text).slice(0, 120),
  );
  ok(
    "读回的是失败态描述",
    typeof text === "string" && text.includes("失败"),
    String(text).slice(0, 80),
  );
}

console.log("── registerToolPkg 只做声明，不再碰 IPC 通道 ──");
const beforeCount = registeredOrder.length;
{
  const ret = main.registerToolPkg();
  ok("registerToolPkg 返回 true", ret === true);
  ok(
    "不重复注册 IPC 通道（注册引擎里注册没有意义）",
    registeredOrder.length === beforeCount,
    registeredOrder.join(", "),
  );
  ok("通道依然在（没有被顺手注销）", channels.size === 2, channels.size + " 个");
  ok(
    "xml 渲染声明已注册",
    !!globalThis.__xmlSpec && globalThis.__xmlSpec.tag === "shader",
  );
  ok("system prompt 声明已注册", !!globalThis.__promptSpec);
}

console.log("");
console.log(pass + "/" + (pass + failures.length) + " 通过");
if (failures.length) {
  console.error("✗ " + failures.length + " 项失败");
  process.exit(1);
}
console.log("✓ IPC 通道在脚本加载时注册（不依赖 registerToolPkg），账本接线正确");
