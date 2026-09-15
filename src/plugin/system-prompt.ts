/**
 * 系统提示钩子：让 AI 知道 `<shader>` 标签的存在。
 *
 * 为什么必须有：渲染器（P5）已经能用了，但**没人告诉 AI 有这个东西**，
 * 它就永远不会写出来 —— 一个发现不了的能力等于不存在。官方示例里
 * `<plantodo>` 这类标签也是靠同一套机制让 AI 知道的。
 *
 * 代价必须说清楚：注入的内容会出现在**每一次请求**的系统提示里，
 * 所以这里刻意压到三行。想再省，就得加开关（像官方 thinking_guidance 那样
 * 配一个输入菜单开关），但那是用户可见的复杂度，先不加。
 */

const PROMPT_HOOK_ID = "shader_feed_inline_prompt";

const PROMPT_ZH = [
 "聊天内可实时渲染 shader：在回复里写出 <shader>…</shader>，中间放 Shadertoy 风格的 GLSL，",
 "聊天里会显示成一块持续动的画面。代码必须定义 void mainImage(out vec4 fragColor, in vec2 fragCoord)，",
 "不要写 main()。代码里的 < 与 > 要写成 &lt; 与 &gt;（或用 <![CDATA[ … ]]> 包起来），否则 XML 解析会失败。",
].join("");

const PROMPT_EN = [
 "Shaders can be rendered live inside the chat: emit <shader>…</shader> with Shadertoy-style GLSL inside, ",
 "and it renders as a continuously animating block. The code must define ",
 "void mainImage(out vec4 fragColor, in vec2 fragCoord) — do not write main(). ",
 "Escape < and > as &lt; and &gt; (or wrap the code in <![CDATA[ … ]]>), otherwise XML parsing fails.",
].join("");

export function onSystemPromptCompose(
 event: ToolPkgPromptHookEvent,
): ToolPkgSystemPromptComposeResult | null {
 if (!event) {
  return null;
 }
 const stage = event.eventName || event.event || "";
 if (stage !== "after_compose_system_prompt") {
  return null;
 }
 const payload = event.eventPayload || {};
 const current = String(payload.systemPrompt || "");
 const addition = payload.useEnglish ? PROMPT_EN : PROMPT_ZH;
 return { systemPrompt: current + "\n\n" + addition };
}

/** 供 main.ts 注册用；id 与处理函数集中在这里，不会各改一处。 */
export const SYSTEM_PROMPT_REGISTRATION: ToolPkgSystemPromptComposeRegistration =
 {
  id: PROMPT_HOOK_ID,
  function: onSystemPromptCompose,
 };
