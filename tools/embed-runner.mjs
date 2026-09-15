#!/usr/bin/env node
/**
 * 把 runner.html 与 deck 合成一个**自包含 HTML 字符串**，生成 src/deck/embedded.ts。
 *
 * 为什么要内联（这是一次真实失败逼出来的）：
 *   原先设计是「虚拟域 + 资源拦截」——runner.html 里用相对名引 runner.js，
 *   宿主拦截 https://shaderfeed.local/* 用落盘路径作答。真机上这条路直接失败：
 *       net::ERR_CONNECTION_CLOSED   https://shaderfeed.local/runner.html
 *   也就是请求根本没被拦截，跑到真网络上去了，整条链路（含 JS bridge 握手）随之全断。
 *   自包含 HTML 把这一整类失败模式移除：没有域名、没有网络、没有文件系统、没有拦截。
 *
 * 为什么生成 TS 而不是运行时读文件：`ToolPkg.readResource()` 返回的是**落盘路径**，
 * 拿不到文件内容（同一个原因）。所以内容必须在编译期就变成字符串进包。
 *
 * 生成物由门禁校验（第 1 步重新生成并比对），所以手改会被立刻发现。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHELL = join(ROOT, "resources/webview/runner.html");
const DECK = join(ROOT, "src/deck/shader-deck.js");
const OUT = join(ROOT, "src/deck/embedded.ts");

/** 这是 shell 里唯一的外链，必须精确存在 —— 找不到就直接报错，别让内联静默失效。 */
const SCRIPT_TAG = '<script src="runner.js"></script>';

function buildSelfContainedHtml() {
  for (const f of [SHELL, DECK]) {
    if (!existsSync(f)) {
      throw new Error(`找不到 ${f}`);
    }
  }
  const shell = readFileSync(SHELL, "utf8");
  const deck = readFileSync(DECK, "utf8");

  if (!shell.includes(SCRIPT_TAG)) {
    throw new Error(
      `resources/webview/runner.html 里找不到 ${SCRIPT_TAG} —— ` +
        `自包含 HTML 靠替换这一行来内联 deck，找不到就等于页面没有脚本。`,
    );
  }

  // deck 是 IIFE，末尾会回调 ShaderHost.ready()。内联成 <script> 时唯一的坑是
  // 源码里出现 `</script>` 字面量会把标签提前闭合（deck 里没有，但要有断言守着）。
  if (deck.includes("</script")) {
    throw new Error(
      "deck 源码里出现了 </script 字面量：内联进 <script> 会把标签提前闭合。" +
        "请改写成 `<\\/script` 之类的形式。",
    );
  }

  const html = shell.replace(
    SCRIPT_TAG,
    "<script>\n" + deck.trimEnd() + "\n</script>",
  );

  // 生成物必须完全自包含：任何 src/href 外链都意味着又一次「真机上去网络上找」。
  // 先去掉 HTML 注释再查 —— 注释不会发请求，但人会在里面写示例链接
  //（这份 runner.html 里就写着为何不能用外链，那段说明本身带一个 src="…"）。
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const external =
    withoutComments.match(/(src|href)\s*=\s*["'](?!data:)[^"']+["']/gi) || [];
  if (external.length > 0) {
    throw new Error(
      `自包含 HTML 里仍有外链：${external.join(", ")} —— 这会让真机重新依赖网络/文件系统。`,
    );
  }

  return html;
}

function renderModule(html) {
  return [
    "/**",
    " * ⚠️ 自动生成，请勿手改。",
    " * 来源：resources/webview/runner.html + src/deck/shader-deck.js",
    " * 生成：tools/embed-runner.mjs（门禁第 1 步会重新生成并比对，手改会被发现）",
    " *",
    " * 为什么是字符串而不是资源文件：ToolPkg.readResource() 返回的是**落盘路径**，",
    " * 拿不到内容；而虚拟域 + 资源拦截在真机上会让 WebView 去真网络找 shaderfeed.local，",
    " * 实测 net::ERR_CONNECTION_CLOSED。自包含 HTML 把这一整类失败模式移除。",
    " */",
    "",
    `export const SELF_CONTAINED_HTML: string = ${JSON.stringify(html)};`,
    "",
  ].join("\n");
}

function main() {
  const html = buildSelfContainedHtml();
  const next = renderModule(html);
  const prev = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (prev === next) {
    console.log(
      `✓ 自包含 HTML 已是最新（${html.length} 字符，deck 已内联）`,
    );
    return;
  }
  writeFileSync(OUT, next);
  console.log(
    `✓ 已生成 src/deck/embedded.ts（${html.length} 字符，deck 已内联）`,
  );
}

main();
