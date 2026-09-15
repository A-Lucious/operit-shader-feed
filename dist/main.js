"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerToolPkg = registerToolPkg;
const chat_xml_render_js_1 = require("./plugin/chat-xml-render.js");
const compile_ipc_js_1 = require("./plugin/compile-ipc.js");
const compile_ledger_js_1 = require("./plugin/compile-ledger.js");
const system_prompt_js_1 = require("./plugin/system-prompt.js");
const chat_shader_state_js_1 = require("./shared/chat-shader-state.js");
/**
 * 编译结果账本 —— **唯一活在 main 上下文的状态**。
 *
 * 官方文档：“main 适合承载需要跨 UI、子包工具共享的内存态”。链路正好是：
 *   聊天框 WebView（有 GL、能编译）→ ui 上下文 ipc.call → 这里 → 工具脚本（sandbox）读走 → AI
 * 编译 GLSL 需要 WebGL，而工具与钩子跑在 QuickJS 里没有 GL，所以结果必须先回传再转手。
 */
const compileIpc = (0, compile_ipc_js_1.createCompileIpcHandlers)((0, compile_ledger_js_1.createCompileLedger)());
/**
 * ToolPkg 主入口：只做注册，不在这里调用 `ToolPkg.readResource()`
 * （注册期间调用会立即抛异常，见 TOOLPKG_FORMAT_GUIDE.md §3.2.5）。
 *
 * 这个包只有一个能力：**聊天里实时渲染 shader**。
 * 曾经还有侧边栏信息流（爬取 + 缓存 + 播放），真机上一处失败无法修复而整体移除 ——
 * 见 README「为什么只剩聊天渲染」。
 */
function registerToolPkg() {
    // 聊天内实时渲染：AI 写出 <shader>…</shader> 时，把它换成一个活着的画面。
    // 注册形状与标签名集中在 chat-xml-render.ts，避免标签名与处理函数各改一处。
    ToolPkg.registerXmlRenderPlugin(chat_xml_render_js_1.SHADER_XML_RENDER_REGISTRATION);
    // 让 AI 知道 <shader> 标签存在，并知道写完要回来读编译结果 —— 否则这个能力没人发现。
    ToolPkg.registerSystemPromptComposeHook(system_prompt_js_1.SYSTEM_PROMPT_REGISTRATION);
    // 编译结果的两个通道：界面写、工具读。
    //
    // 放在 registerToolPkg() 里而不是模块顶层（官方文档的 ipc 示例是放顶层的）：
    // 顶层注册的代价是「万一 ToolPkg 还没就绪就整个包加载失败」，而这里必定就绪；
    // 而且注册期的禁止清单里只有 readResource / wasm.call 这类**操作**，ipc.on 属于声明。
    ToolPkg.ipc.on(chat_shader_state_js_1.IPC_COMPILE_WRITE, (payload) => {
        compileIpc.write(payload);
        return true;
    });
    ToolPkg.ipc.on(chat_shader_state_js_1.IPC_COMPILE_READ, () => compileIpc.read());
    return true;
}
