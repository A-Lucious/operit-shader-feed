#!/usr/bin/env node
/**
 * 工具脚本侧逻辑（compile-tool.ts）的离线测试。
 *
 * 这是 AI 唯一能读到 GLSL 编译报错的通道，所以**失败路径比成功路径更重要**：
 * 工具抛异常的话，AI 拿到的是一段堆栈而不是"现在该怎么办"，它就修不下去了。
 *
 * 用法： node tests/compile-tool.test.mjs   （需先跑 npx tsc）
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL_JS = join(ROOT, "dist/plugin/compile-tool.js");
const SHARED_JS = join(ROOT, "dist/shared/chat-shader-state.js");
if (!existsSync(TOOL_JS) || !existsSync(SHARED_JS)) {
  console.error("✗ 找不到编译产物，先跑 npx tsc");
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { readCompileResultText } = require(TOOL_JS);
const { IPC_COMPILE_READ } = require(SHARED_JS);

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

async function main() {
  console.log("── 正常路径：原样把 main 的文本交给 AI ──");
  {
    const seen = [];
    const text = await readCompileResultText(async (channel, payload) => {
      seen.push([channel, payload]);
      return "编译失败：\n" + ERR;
    });
    ok("文本原样返回（不加工、不截断）", text.includes(ERR), text);
    eq("用的是共享常量里的通道名", seen[0][0], IPC_COMPILE_READ);
    ok(
      "调用时带了 payload",
      typeof seen[0][1] === "object" && seen[0][1] !== null,
    );
    eq("只调用了一次", seen.length, 1);
  }

  console.log("── 失败路径：绝不能抛异常（抛了 AI 就只能看堆栈）──");
  {
    const thrown = await readCompileResultText(async () => {
      throw new Error("no handler registered for channel");
    });
    ok(
      "不抛异常，返回可用文本",
      typeof thrown === "string" && thrown.length > 0,
      thrown,
    );
    ok("保留了原始错误信息（便于排查）", thrown.includes("no handler"), thrown);
    ok("给出可行动项", thrown.includes("状态条"), thrown);
    // 真机上工具结果是折叠的，前缀太长会把唯一有用的信息截掉 —— 实测踩过一次，
    // 屏幕上只剩「读不到编译结果（跨运行时通…」看不出哪一步错了。
    ok(
      "错误正文就在开头，不会被折叠截掉",
      thrown.indexOf("no handler") < 120,
      thrown.slice(0, 160),
    );
    ok("两次尝试都报告了（默认 + 显式 main）", thrown.includes("默认目标") && thrown.includes("显式 main"), thrown);

    // 非 Error 抛出（宿主可能直接 throw 字符串）
    const thrownStr = await readCompileResultText(async () => {
      throw "boom";
    });
    ok("抛字符串也不炸", thrownStr.includes("boom"), thrownStr);
  }

  console.log("── 通道通了但内容不对：每种都要说人话 ──");
  {
    const cases = [
      [42, "number"],
      [null, "null"],
      ["", "空字符串"],
      ["   ", "空字符串"],
      [undefined, "undefined"],
      [{}, "object"],
      [[], "object"],
    ];
    for (const [value, expected] of cases) {
      const text = await readCompileResultText(async () => value);
      ok(
        `拿到 ${expected} 时说清是什么而不是空话`,
        text.includes("非文本内容") && text.includes(expected),
        text,
      );
      ok(`拿到 ${expected} 时仍给出可行动项`, text.includes("状态条"), text);
    }
  }

  console.log("── 两次尝试：默认目标失败就显式指定 main 再试一次 ──");
  {
    const seen = [];
    const text = await readCompileResultText(async (channel, payload, options) => {
      seen.push(options === undefined ? "默认" : JSON.stringify(options));
      if (seen.length === 1) {
        throw new Error("target runtime is not active");
      }
      return "编译失败：\n" + ERR;
    });
    eq("第一次用默认目标", seen[0], "默认");
    eq("第二次显式 main", seen[1], '{"targetRuntime":"main"}');
    ok("第二次拿到结果就返回它", text.includes(ERR), text);
    ok("不再把第一次的失败当结论", !text.includes("not active"), text);
  }

  console.log("── 穷举：任何输入都不能产出空话或串值 ──");
  {
    let bad = "";
    let checked = 0;
    const returns = [undefined, null, 0, "", "  ", {}, [], false, "正常文本"];
    const callers = [
      async (v) => v,
      async () => {
        throw new Error("fail");
      },
      async () => {
        throw new Error("");
      },
    ];
    for (const value of returns) {
      for (const caller of callers) {
        checked++;
        const text = await readCompileResultText(() => caller(value));
        if (!bad && (typeof text !== "string" || text.trim() === "")) {
          bad = "空话 ← " + JSON.stringify(value);
        }
        if (!bad && text.includes("undefined") && value !== undefined) {
          bad = "串出了 undefined ← " + JSON.stringify(value);
        }
      }
    }
    eq("组合数", checked, 27);
    eq("没有空话/串值", bad, "");
  }

  console.log("── 三处名字必须一致：METADATA ↔ 导出函数 ↔ 提示词 ──");
  {
    // 这三处里任何一处漂了，表现都是「工具不存在」或「AI 永远不调它」，
    // 而且只能在真机上发现。METADATA 只能是字面量（它是注释里的 JSON），
    // 所以名字天然有三份，只能靠这条断言把它们钉在一起。
    const scriptText = readFileSync(
      join(ROOT, "dist/packages/shader-compile.js"),
      "utf8",
    );
    const metaMatch = scriptText.match(/\/\*\s*METADATA\s*([\s\S]*?)\*\//);
    ok(
      "子包脚本里有 METADATA 块",
      metaMatch !== null,
      "没有就等于这个包没有工具",
    );

    let meta = {};
    try {
      meta = JSON.parse((metaMatch && metaMatch[1]) || "{}");
    } catch (err) {
      ok("METADATA 是合法 JSON", false, String(err && err.message));
    }
    ok("METADATA 是合法 JSON", typeof meta === "object" && meta !== null);

    const tools = Array.isArray(meta.tools) ? meta.tools : [];
    eq("声明了一个工具", tools.length, 1);
    const tool = tools[0] || {};
    const toolName = String(tool.name || "");
    eq("工具名是预期那个", toolName, "shader_last_compile_result");

    ok(
      "同名函数真的有导出（宿主按名字找导出，改名只会表现为「工具不存在」）",
      new RegExp(
        "exports\\." +
          toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          "\\s*=",
      ).test(scriptText),
      "产物里找不到 exports." + toolName,
    );
    eq(
      "参数列表存在且为空（宿主会读它）",
      Array.isArray(tool.parameters),
      true,
    );
    eq("参数个数为 0", (tool.parameters || []).length, 0);

    const desc = JSON.stringify(tool.description || "");
    ok(
      "描述里解释了为什么必须调用它（编译需要 WebGL）",
      desc.includes("WebGL"),
      desc.slice(0, 120),
    );
    ok(
      "描述里说了失败时该干嘛（按报错改）",
      desc.includes("报错") || desc.includes("errors"),
      desc.slice(0, 160),
    );

    const promptText = readFileSync(
      join(ROOT, "dist/plugin/system-prompt.js"),
      "utf8",
    );
    const mentioned = (promptText.match(new RegExp(toolName, "g")) || [])
      .length;
    ok(
      "中英两份提示词都提到了这个工具名（只提一份的话另一种语言的用户就永远用不上）",
      mentioned >= 2,
      `提到 ${mentioned} 次`,
    );
  }

  console.log(`\n${pass}/${pass + failures.length} 通过`);
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败`);
    process.exit(1);
  }
  console.log(
    "✓ 工具侧永不抛异常 + 每种异常内容都给得出「现在该怎么办」全部锁住",
  );
}

main();
