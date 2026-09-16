#!/usr/bin/env node
/**
 * xml_render 钩子的离线测试（此前完全没覆盖）。
 *
 * 这段逻辑的失败模式都很隐蔽：
 *   - 实体解码顺序错了（`&amp;lt;` 应该变成 `&lt;` 而不是 `<`）→ 代码被静默改坏
 *   - GLSL 里的 `<` 与 `>` 没被正确处理 → XML 解析失败，聊天里什么都不出现
 *   - 钩子下发的 state 键名与界面读取的键名不一致 → 同样什么都不出现，且不报错
 *
 * 最后一条由共享常量从结构上消除，这里把它锁住。
 *
 * 用法： node tests/chat-xml-render.test.mjs   （需先跑 npx tsc）
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_JS = join(ROOT, "dist/plugin/chat-xml-render.js");
const KEYS_JS = join(ROOT, "dist/shared/chat-shader-state.js");
if (!existsSync(HOOK_JS) || !existsSync(KEYS_JS)) {
  console.error("✗ 找不到编译产物，先跑 npx tsc");
  process.exit(2);
}
const require = createRequire(import.meta.url);
const {
  SHADER_XML_TAG,
  SHADER_XML_RENDER_REGISTRATION,
  decodeXmlEntities,
  stripCdata,
  parseShaderTag,
  extractShaderBody,
  precheckShaderCode,
  onShaderXmlRender,
} = require(HOOK_JS);
const { STATE_KEY_SHADER_CODE, STATE_KEY_SHADER_TITLE } = require(KEYS_JS);

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
  // 只有「期望值不是布尔」时才拦：布尔对布尔（eq("x", flag, false)）是合法比较。
  if (typeof a === "boolean" && typeof b !== "boolean") {
    throw new Error(
      `eq() 收到了布尔断言：「${name}」—— 谓词请改用 ok(name, 条件, 详情)`,
    );
  }
  ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};

/** 一段含 `<` 与 `&` 的真实风格 GLSL（这正是会破坏 XML 的字符）。 */
const GLSL_WITH_ANGLES = [
  "void mainImage(out vec4 fragColor, in vec2 fragCoord) {",
  "  vec2 uv = fragCoord / iResolution.xy;",
  "  vec3 col = uv.x < 0.5 && uv.y > 0.2 ? vec3(1.0) : vec3(0.0);",
  "  fragColor = vec4(col, 1.0);",
  "}",
].join("\n");

async function main() {
  console.log("── 实体解码：顺序是最容易错的地方 ──");
  eq("&lt; → <", decodeXmlEntities("a &lt; b"), "a < b");
  eq("&gt; → >", decodeXmlEntities("a &gt; b"), "a > b");
  eq("&amp; → &", decodeXmlEntities("a &amp; b"), "a & b");
  // 关键：若先解 &amp; 再解 &lt;，这里会得到 '<'，代码就被改坏了
  eq(
    "&amp;lt; → &lt;（不能二次解码成 <）",
    decodeXmlEntities("&amp;lt;"),
    "&lt;",
  );
  eq(
    "混合",
    decodeXmlEntities("a &lt; b &amp;&amp; c &gt; d"),
    "a < b && c > d",
  );
  eq("没有实体时原样返回", decodeXmlEntities("plain text"), "plain text");
  eq(
    "&quot; 与 &#39;",
    decodeXmlEntities("&quot;x&quot; &#39;y&#39;"),
    "\"x\" 'y'",
  );

  console.log("── CDATA 剥离 ──");
  eq("包着 CDATA → 取内层", stripCdata("<![CDATA[hello]]>"), "hello");
  eq("未包 CDATA → 原样", stripCdata("hello"), "hello");
  eq("前后空白被容忍", stripCdata("  <![CDATA[ hello ]]>  "), " hello ");
  eq("只包一半不当成 CDATA", stripCdata("<![CDATA[hello"), "<![CDATA[hello");

  console.log("── 标签解析：属性、实体、CDATA ──");
  {
    const plain = parseShaderTag(
      "void mainImage(out vec4 c, in vec2 f){ c=vec4(0.); }",
    );
    eq("无标题时 title 为空", plain.title, "");
    ok("无标题时代码完整", plain.code.includes("mainImage"));

    const titled = parseShaderTag(
      ' title="旋转方块" void mainImage(out vec4 c, in vec2 f){ c=vec4(0.); }',
    );
    eq("抽出 title", titled.title, "旋转方块");
    ok(
      "title 属性不会混进代码",
      !titled.code.includes("title="),
      titled.code.slice(0, 40),
    );

    const escaped = parseShaderTag(
      "void mainImage(out vec4 c, in vec2 f){ if (c.x &lt; 0.5) c = vec4(1.); }",
    );
    ok("实体被解码回真实尖括号", escaped.code.includes("< 0.5"), escaped.code);

    const cdata = parseShaderTag("<![CDATA[" + GLSL_WITH_ANGLES + "]]>");
    ok(
      "CDATA 内的代码原样取出",
      cdata.code.includes("uv.x < 0.5 && uv.y > 0.2"),
      cdata.code,
    );
    ok("CDATA 外壳没留下", !cdata.code.includes("CDATA"));

    // —— v0.8.0 真机 bug：宿主传的是**完整 XML 块**（含 <shader> 标签本身）——
    const block = parseShaderTag(
      '<shader title="旋转方块">' + GLSL_WITH_ANGLES + "</shader>",
    );
    eq("完整块：抽出 title", block.title, "旋转方块");
    ok(
      "完整块：外壳被剥掉",
      !block.code.includes("<shader") && !block.code.includes("</shader>"),
      block.code.slice(0, 80),
    );
    ok(
      "完整块：代码从 void mainImage 开始",
      block.code.startsWith("void mainImage"),
      block.code.slice(0, 80),
    );

    const blockNoAttr = parseShaderTag("<shader>" + GLSL_WITH_ANGLES + "</shader>");
    ok(
      "完整块（无属性）也能剥",
      blockNoAttr.code.startsWith("void mainImage"),
      blockNoAttr.code.slice(0, 40),
    );

    const blockCdata = parseShaderTag(
      "<shader><![CDATA[" + GLSL_WITH_ANGLES + "]]></shader>",
    );
    ok(
      "完整块 + CDATA：代码原样取出",
      blockCdata.code.includes("uv.x < 0.5"),
      blockCdata.code.slice(0, 80),
    );

    const blockEntity = parseShaderTag(
      "<shader>void mainImage(out vec4 c, in vec2 f){ if (c.x &lt;0.5) c = vec4(1.); }</shader>",
    );
    ok("完整块 + 实体：解码回尖括号", blockEntity.code.includes("<0.5"), blockEntity.code);

    // 直接测剥离函数本身（这次修复的新增单元）
    eq("剥壳：完整块 → 内部", extractShaderBody("<shader>abc</shader>"), "abc");
    eq(
      "剥壳：带属性的完整块 → 内部",
      extractShaderBody('<shader title="t">abc</shader>'),
      "abc",
    );
    eq("剥壳：不是标签 → 原样", extractShaderBody("abc"), "abc");
    eq(
      "剥壳：只有开标签 → 原样（保守）",
      extractShaderBody("<shader>abc"),
      "<shader>abc",
    );

  }

  console.log("── 结构预检查（纯字符串，不需要 WebGL）──");
  ok(
    "空代码 → 报错并提示正确写法",
    String(precheckShaderCode("")).includes(SHADER_XML_TAG),
  );
  ok(
    "缺 mainImage → 报错",
    String(precheckShaderCode("float x(){return 1.0;}")).includes("mainImage"),
  );
  ok(
    "只写 main() → 也报缺 mainImage",
    String(precheckShaderCode("void main(){ }")).includes("mainImage"),
  );
  ok(
    "错误的 #version → 报错",
    String(precheckShaderCode("#version 100\n" + GLSL_WITH_ANGLES)).includes(
      "300 es",
    ),
  );

  ok(
    "外壳没剥（代码以 < 开头）→ 报错提醒",
    String(precheckShaderCode("<shader>void mainImage(){}")).includes("外壳"),
  );

  eq("GLSL1 合法 → 通过", precheckShaderCode(GLSL_WITH_ANGLES), null);
  eq(
    "#version 300 es 合法 → 通过",
    precheckShaderCode("#version 300 es\n" + GLSL_WITH_ANGLES),
    null,
  );

  console.log("── 钩子行为 ──");
  {
    const wrongTag = onShaderXmlRender({
      eventPayload: { tagName: "not_shader", xmlContent: "x" },
    });
    eq("标签名不匹配 → handled:false", wrongTag.handled, false);
    ok("不匹配时不产出界面", wrongTag.composeDsl === undefined);

    const noContent = onShaderXmlRender({
      eventPayload: { tagName: SHADER_XML_TAG },
    });
    eq("没有 xmlContent → handled:false", noContent.handled, false);
  }
  {
    // 坏代码：必须返回**纯文本**，AI 才可能在对话记录里看到并自己修
    const bad = onShaderXmlRender({
      eventPayload: {
        tagName: SHADER_XML_TAG,
        xmlContent: "float x(){return 1.0;}",
      },
    });
    eq("结构不合法 → handled:true", bad.handled, true);
    ok(
      "结构不合法 → 返回纯文本（AI 看得到）",
      typeof bad.text === "string" && bad.text.length > 0,
      JSON.stringify(bad).slice(0, 120),
    );
    ok("结构不合法 → 不产出界面", bad.composeDsl === undefined);
    ok("错误文本里说明了缺什么", bad.text.includes("mainImage"), bad.text);
  }
  {
    // 好代码：产出界面，且 state 键名必须与界面读取的一致
    const good = onShaderXmlRender({
      eventPayload: {
        tagName: SHADER_XML_TAG,
        xmlContent: ' title="测试" ' + GLSL_WITH_ANGLES,
      },
    });
    eq("合法代码 → handled:true", good.handled, true);
    ok("合法代码 → 产出界面", !!good.composeDsl);
    ok(
      "screen 是个函数",
      typeof (good.composeDsl && good.composeDsl.screen) === "function",
    );
    const state = (good.composeDsl && good.composeDsl.state) || {};
    eq(
      "state 用的是共享的代码键名",
      Object.keys(state).includes(STATE_KEY_SHADER_CODE),
      true,
    );
    eq(
      "state 用的是共享的标题键名",
      Object.keys(state).includes(STATE_KEY_SHADER_TITLE),
      true,
    );
    eq(
      "state 里的代码是解码后的",
      state[STATE_KEY_SHADER_CODE].includes("uv.x < 0.5"),
      true,
    );
    eq("state 里的标题正确", state[STATE_KEY_SHADER_TITLE], "测试");
  }

  {
    // 宿主真实格式：完整 XML 块（v0.8.0 在真机上拿到的就是这个）
    const wrapped = onShaderXmlRender({
      eventPayload: {
        tagName: SHADER_XML_TAG,
        xmlContent: '<shader title="完整块">' + GLSL_WITH_ANGLES + "</shader>",
      },
    });
    eq("完整块 → handled:true", wrapped.handled, true);
    ok("完整块 → 产出界面", !!wrapped.composeDsl);
    const wrappedState = (wrapped.composeDsl && wrapped.composeDsl.state) || {};
    eq("完整块 → 标题正确", wrappedState[STATE_KEY_SHADER_TITLE], "完整块");
    ok(
      "完整块 → 下发的代码不含标签外壳",
      typeof wrappedState[STATE_KEY_SHADER_CODE] === "string" &&
        !wrappedState[STATE_KEY_SHADER_CODE].includes("<shader"),
      String(wrappedState[STATE_KEY_SHADER_CODE]).slice(0, 80),
    );
  }

  console.log("── 注册对象 ──");
  eq(
    "tag 就是 SHADER_XML_TAG",
    SHADER_XML_RENDER_REGISTRATION.tag,
    SHADER_XML_TAG,
  );
  ok(
    "id 非空且稳定",
    typeof SHADER_XML_RENDER_REGISTRATION.id === "string" &&
      SHADER_XML_RENDER_REGISTRATION.id.length > 0,
  );
  eq(
    "function 就是钩子本体",
    SHADER_XML_RENDER_REGISTRATION.function,
    onShaderXmlRender,
  );
  eq("标签名没被改成别的", SHADER_XML_TAG, "shader");

  console.log(`\n${pass}/${pass + failures.length} 通过`);
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败`);
    process.exit(1);
  }
  console.log(
    "✓ XML 实体/CData/标题剥离、结构预检查、钩子行为、以及与界面的 state 键名耦合 全部锁住",
  );
}

main();
