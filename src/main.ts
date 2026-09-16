import { SHADER_XML_RENDER_REGISTRATION } from "./plugin/chat-xml-render.js";
import { createCompileIpcHandlers } from "./plugin/compile-ipc.js";
import { createCompileLedger } from "./plugin/compile-ledger.js";
import { SYSTEM_PROMPT_REGISTRATION } from "./plugin/system-prompt.js";
import {
 IPC_COMPILE_READ,
 IPC_COMPILE_WRITE,
} from "./shared/chat-shader-state.js";

/**
 * 编译结果账本 —— **唯一活在 main 上下文的状态**。
 *
 * 官方文档：“main 适合承载需要跨 UI、子包工具共享的内存态”。链路正好是：
 *   聊天框 WebView（有 GL、能编译）→ ui 上下文 ipc.call → 这里 → 工具脚本（sandbox）读走 → AI
 * 编译 GLSL 需要 WebGL，而工具与钩子跑在 QuickJS 里没有 GL，所以结果必须先回传再转手。
 */
const compileIpc = createCompileIpcHandlers(createCompileLedger());

/**
 * 编译结果的两个通道：界面写、工具读。**必须挂在脚本顶层**，不能放进 registerToolPkg()。
 *
 * 为什么（v0.8.0 真机 bug）：宿主调用 registerToolPkg() 的是一次性注册引擎，
 * 跑完立刻 destroy()；真正接收 IPC 的是另一个长期存活的 main 执行引擎。
 * handler 挂在注册引擎里会随它一起被销毁，main 引擎的 __operitToolPkgIpcRegistry
 * 永远是空的 —— 真机表现就是 `ToolPkg.ipc channel is not registered`。
 *
 * 顶层代码会在**每个真正执行本脚本的引擎**里跑一遍（模块按脚本文本缓存，每引擎一次），
 * 所以每个 main 执行引擎都会得到这两个 handler。官方文档的 ipc 示例也是顶层写法。
 */
ToolPkg.ipc.on(IPC_COMPILE_WRITE, (payload: unknown): boolean => {
  compileIpc.write(payload);
  return true;
});
ToolPkg.ipc.on(IPC_COMPILE_READ, (): string => compileIpc.read());

/**
 * ToolPkg 主入口：只做注册，不在这里调用 `ToolPkg.readResource()`
 * （注册期间调用会立即抛异常，见 TOOLPKG_FORMAT_GUIDE.md §3.2.5）。
 *
 * 这个包只有一个能力：**聊天里实时渲染 shader**。
 * 曾经还有侧边栏信息流（爬取 + 缓存 + 播放），真机上一处失败无法修复而整体移除 ——
 * 见 README「为什么只剩聊天渲染」。
 */
export function registerToolPkg(): boolean {
 // 聊天内实时渲染：AI 写出 <shader>…</shader> 时，把它换成一个活着的画面。
 // 注册形状与标签名集中在 chat-xml-render.ts，避免标签名与处理函数各改一处。
 ToolPkg.registerXmlRenderPlugin(SHADER_XML_RENDER_REGISTRATION);

 // 让 AI 知道 <shader> 标签存在，并知道写完要回来读编译结果 —— 否则这个能力没人发现。
 ToolPkg.registerSystemPromptComposeHook(SYSTEM_PROMPT_REGISTRATION);

 return true;
}
