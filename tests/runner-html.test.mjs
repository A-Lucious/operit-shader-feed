#!/usr/bin/env node
/**
 * 自包含 HTML 的离线测试（这是这次真机失败之后新增的护栏）。
 *
 * 为什么要专门测它：这个包**只有一条渲染路径**，而它曾经是一条错的路 ——
 * 旧版走「虚拟域 + 资源拦截 + 相对引用 runner.js」，浏览器里全绿（因为测试用的是 file://），
 * 真机上却直接：
 *     net::ERR_CONNECTION_CLOSED  https://shaderfeed.local/runner.html
 * 也就是 WebView 根本没走拦截，跑去真网络找那个域名，整条链路连同 bridge 握手一起断。
 *
 * 现在发布产物就是**一个 HTML 字符串**，于是「它是否真的自包含」变成了可以离线断言的性质：
 *   - 有没有外链（任何 src/href 都意味着又去网络上找）
 *   - deck 是否真的在里面
 *   - bridge 名字是否与界面用的一致（错一个字就是「永远不握手」，而那只在真机暴露）
 *
 * 用法： node tests/runner-html.test.mjs   （需先跑 npx tsc）
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EMBEDDED_JS = join(ROOT, "dist/deck/embedded.js");
const SHARED_JS = join(ROOT, "dist/shared/chat-shader-state.js");
const CHAT_UI_JS = join(ROOT, "dist/ui/chat/index.ui.js");
for (const f of [EMBEDDED_JS, SHARED_JS, CHAT_UI_JS]) {
  if (!existsSync(f)) {
    console.error("✗ 找不到编译产物，先跑 npx tsc");
    process.exit(2);
  }
}
const require = createRequire(import.meta.url);
const { SELF_CONTAINED_HTML } = require(EMBEDDED_JS);
const { HOST_INTERFACE_NAME } = require(SHARED_JS);

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

function main() {
  const html = String(SELF_CONTAINED_HTML || "");
  // 去注释版本：注释里可以提到历史（比如「以前用 runner.js」），但那些文本不发请求。
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");

  console.log("── 自包含：任何外链都意味着「真机又去网络上找」──");
  {
    ok("HTML 非空", html.length > 0, `长度 ${html.length}`);
    ok(
      "体积合理（deck 真的内联进来了，而不是只剩空壳）",
      html.length > 20000,
      `长度 ${html.length}`,
    );
    const external =
      withoutComments.match(/(src|href)\s*=\s*["'](?!data:)[^"']+["']/gi) || [];
    eq("没有任何 src/href 外链", external.length, 0, external.join(", "));
    ok(
      "没有 http(s) 外链残留",
      !/["'(]https?:\/\//.test(withoutComments.replace(/baseUrl[^,]*/g, "")),
      "",
    );
  }

  console.log("── 页面结构：deck 与 DOM 都得在 ──");
  ok("有 #gl 画布", html.includes('id="gl"'), "");
  ok(
    "有 #status 状态条（真机上编译报错只能靠它看）",
    html.includes('id="status"'),
    "",
  );
  ok("deck 的入口 API 在（__runnerLoad）", html.includes("__runnerLoad"), "");
  ok("deck 暴露了 ShaderDeck 版本信息", html.includes("ShaderDeck"), "");
  // 危险的不是「提到了 runner.js」（deck 的注释里解释历史就会提到），
  // 而是代码里真的去引用它 —— 那才会又变成一次网络/文件系统依赖。
  ok(
    '代码里没有 src="runner.js" 这类引用',
    !/(src|href)\s*=\s*["']runner\.js["']/.test(withoutComments),
    "",
  );
  // 内联进 <script> 时唯一能毁掉页面的东西是提前闭合。
  // 所以不去数 <script（注释与字串里都可能有），只断言结束标签恰好出现一次。
  eq(
    "script 结束标签恰好一次（没有提前闭合）",
    (withoutComments.match(/<\/script/gi) || []).length,
    1,
  );

  console.log(
    "── bridge 名字：写错一个字就是「永远不握手」，而那只在真机暴露 ──",
  );
  {
    eq("界面侧常量就是 ShaderHost", HOST_INTERFACE_NAME, "ShaderHost");
    ok(
      `deck 读的是同一个名字（window.${HOST_INTERFACE_NAME}）`,
      html.includes(`window.${HOST_INTERFACE_NAME}`),
      "deck 里找不到该名字",
    );
    ok(
      "deck 会调 ready()（不调的话界面一直停在「等待页面握手」）",
      html.includes(`window.${HOST_INTERFACE_NAME}.ready`),
      "",
    );

    // 界面侧：必须真的把 ShaderHost 注册进 bridge，且用的是同一个常量
    const chatUi = readFileSync(CHAT_UI_JS, "utf8");
    ok(
      "聊天界面用共享常量注册 bridge（不是写死的字面量）",
      chatUi.includes("HOST_INTERFACE_NAME"),
      "",
    );
    ok(
      "聊天界面调用 addJavascriptInterface",
      chatUi.includes("addJavascriptInterface"),
      "",
    );
    ok(
      "聊天界面用 html 属性而不是 url（不走网络/拦截）",
      chatUi.includes(".html(") || chatUi.includes("html:"),
      "",
    );
    ok(
      "聊天界面不再引用被删的虚拟域拦截",
      !chatUi.includes("onInterceptRequest") &&
        !chatUi.includes("runner-resources"),
      "",
    );
  }

  console.log(`\n${pass}/${pass + failures.length} 通过`);
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败`);
    process.exit(1);
  }
  console.log("✓ 自包含性（无外链）+ 页面结构 + bridge 名字三处一致 全部锁住");
}

main();
