/**
 * xml_render 钩子：把聊天里的 `<shader>…</shader>` 换成一块**活的**渲染界面。
 *
 * 这是需求「该插件在 AI 调用时能够在聊天中实时渲染 shader 并显示在一个框里」的实现。
 *
 * 为什么代码要过一遍实体解码与 CDATA 处理：GLSL 里必然出现 `<`（比较运算）与 `>`，
 * 裸写进 XML 文本是不合法的。AI 可能写成 `&lt;`，也可能用 `<![CDATA[ … ]]>` 包起来，
 * 还可能什么都不做（那就解析不出来）。这里两种正确写法都收，不做无谓的挑剔。
 *
 * 为什么渲染不了时要返回 `text` 而不是只渲染一个错误界面：**AI 看不到界面**。
 * 返回纯文本，错误才会出现在对话记录里，AI 才有机会自己改。
 */

import chatShaderScreen from "../ui/chat/index.ui.js";
import {
  STATE_KEY_SHADER_CODE,
  STATE_KEY_SHADER_TITLE,
} from "../shared/chat-shader-state.js";

/** 我们占用的标签名。太长/太通用都会和别的插件撞。 */
export const SHADER_XML_TAG = "shader";

/**
 * 解码 XML 实体。
 * 顺序很重要：`&amp;` 必须**最后**解，否则 `&amp;lt;` 会被二次解码成 `<`。
 */
export function decodeXmlEntities(text: string): string {
  return text
    .split("&lt;")
    .join("<")
    .split("&gt;")
    .join(">")
    .split("&quot;")
    .join('"')
    .split("&#39;")
    .join("'")
    .split("&apos;")
    .join("'")
    .split("&amp;")
    .join("&");
}

/** 去掉 `<![CDATA[ … ]]>` 外壳（若存在）。 */
export function stripCdata(text: string): string {
  const open = "<![CDATA[";
  const close = "]]>";
  const trimmed = text.trim();
  if (trimmed.startsWith(open) && trimmed.endsWith(close)) {
    return trimmed.slice(open.length, trimmed.length - close.length);
  }
  return text;
}

/** 标签可选的标题属性，例如 `<shader title="旋转的方块">`。没写就是空。 */
function extractTitle(xmlContent: string): string {
  const marker = 'title="';
  const at = xmlContent.indexOf(marker);
  if (at < 0) {
    return "";
  }
  const rest = xmlContent.slice(at + marker.length);
  const end = rest.indexOf('"');
  return end < 0 ? "" : rest.slice(0, end).trim();
}

/**
 * 结构性预检查 —— 这些是纯字符串判断，不需要 WebGL，所以能在钩子里立刻做。
 *
 * 它覆盖的是最常见的失败（忘了写 mainImage、把整段 main() 贴进来）。
 * **真正的 GLSL 编译错误这里查不出来**：编译需要 WebGL 上下文，而工具/钩子跑在
 * QuickJS 里没有 GL。那类错误会在渲染框的状态条上显示给用户看。
 */
export function precheckShaderCode(code: string): string | null {
  const text = code.trim();
  if (!text) {
    return (
      "标签里没有代码。正确写法：`<" +
      SHADER_XML_TAG +
      ">` 里面放 Shadertoy 风格的 GLSL。"
    );
  }
  if (text.startsWith("<")) {
    // v0.8.0 真机 bug 的兜底：外壳没剥干净时代码会以 `<shader…` 开头，
    // 直接送进 GLSL 只会在渲染器里报 `<` 语法错误，AI 根本不知道自己错在哪。
    return (
      "代码以 `<` 开头 —— `<shader>` 标签外壳没剥干净（标签本身不该出现在代码里）。" +
      "请只把 GLSL 写在 `<" +
      SHADER_XML_TAG +
      ">…</" +
      SHADER_XML_TAG +
      ">` 内部；外壳剥离由这里负责。"
    );
  }
  if (!text.includes("mainImage")) {
    return (
      "代码里没有 `mainImage`。Shadertoy 的 image pass 必须定义：" +
      "`void mainImage(out vec4 fragColor, in vec2 fragCoord) { … }`；" +
      "不要写 `void main()`，入口由渲染器负责。"
    );
  }
  if (text.includes("#version") && !text.includes("#version 300 es")) {
    return "只支持 `#version 300 es`；其它版本号请去掉，让渲染器按 GLSL1 处理。";
  }
  return null;
}

export interface ParsedShaderTag {
  code: string;
  title: string;
}

/**
 * 从钩子给的 xmlContent 里剥出 `<shader>…</shader>` 的**内部内容**。
 *
 * 宿主（ToolPkgCommonBridgePlugin → CustomXmlRenderer）传来的是**完整 XML 块** ——
 * `<shader …>` 与 `</shader>` 本身都在里面。v0.8.0 把它直接当内部内容用，
 * 于是 GLSL 的第一个字符是 `<`，deck 装配后在 fragment 源码里报：
 *   [fragment] ERROR : 0:22: '<': syntax error
 *
 * 若拿到的本来就是内部内容（离线测试、以及将来宿主只传内部），原样返回。
 */
export function extractShaderBody(xmlContent: string): string {
  const text = String(xmlContent).trim();
  const openPrefix = "<" + SHADER_XML_TAG;
  if (!text.toLowerCase().startsWith(openPrefix)) {
    return xmlContent;
  }
  const after = text.slice(openPrefix.length, openPrefix.length + 1);
  const looksLikeOpenTag = after === ">" || after.trim() === "";
  if (!looksLikeOpenTag) {
    return xmlContent;
  }
  const openEnd = text.indexOf(">");
  if (openEnd < 0) {
    return xmlContent;
  }
  const closeTag = "</" + SHADER_XML_TAG + ">";
  const closeAt = text.toLowerCase().lastIndexOf(closeTag);
  if (closeAt < openEnd) {
    // 只有开标签（不完整）：保守地原样返回，交给结构预检查去报告。
    return xmlContent;
  }
  return text.slice(openEnd + 1, closeAt);
}

/** 从标签原文里取出代码与标题。外壳剥离、实体解码与 CDATA 都在这里统一处理。 */
export function parseShaderTag(xmlContent: string): ParsedShaderTag {
  const title = extractTitle(xmlContent);
  let body = extractShaderBody(xmlContent);
  if (title) {
    // 去掉属性本身，别把它当成代码的一部分（旧格式里属性混在 body 里时兜底）
    body = body.replace(' title="' + title + '"', "");
  }
  const code = decodeXmlEntities(stripCdata(body)).trim();
  return { code, title };
}

export function onShaderXmlRender(
  event: ToolPkgXmlRenderEvent,
): ToolPkgXmlRenderResult {
  const payload = event.eventPayload || {};
  if (payload.tagName !== SHADER_XML_TAG) {
    return { handled: false };
  }
  const xmlContent = payload.xmlContent;
  if (xmlContent === undefined) {
    return { handled: false };
  }

  const parsed = parseShaderTag(xmlContent);
  const problem = precheckShaderCode(parsed.code);
  if (problem) {
    // 返回纯文本 —— 这样错误会出现在对话记录里，AI 才有机会自己修。
    return {
      handled: true,
      text: "✗ 无法渲染这段 shader：" + problem,
    };
  }

  return {
    handled: true,
    composeDsl: {
      screen: chatShaderScreen,
      // 键名与界面共用同一份常量：各写一份字面量、写错了不会报错，
      // 只会表现为「聊天里什么都不显示」。
      state: {
        [STATE_KEY_SHADER_CODE]: parsed.code,
        [STATE_KEY_SHADER_TITLE]: parsed.title,
      },
      memo: {},
    },
  };
}

/** 供 main.ts 注册用；集中在这里，标签名与处理函数不会各改一处。 */
export const SHADER_XML_RENDER_REGISTRATION: ToolPkgXmlRenderRegistration = {
  id: "shader_inline_render",
  tag: SHADER_XML_TAG,
  function: onShaderXmlRender,
};
