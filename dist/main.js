"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerToolPkg = registerToolPkg;
const index_ui_js_1 = __importDefault(require("./ui/feed/index.ui.js"));
const chat_xml_render_js_1 = require("./plugin/chat-xml-render.js");
const system_prompt_js_1 = require("./plugin/system-prompt.js");
/**
 * 侧边栏路由。它会出现在市场入口和 `toolpkg:` 引用里，改它等于换入口，别随手改。
 */
const FEED_ROUTE = "toolpkg:com.shaderfeed.operit:ui:feed";
/**
 * ToolPkg 主入口：只做注册，不在这里调用 `ToolPkg.readResource()`
 * （注册期间调用会立即抛异常，见 TOOLPKG_FORMAT_GUIDE.md §3.2.5）。
 */
function registerToolPkg() {
    ToolPkg.registerUiRoute({
        id: "feed",
        route: FEED_ROUTE,
        runtime: "compose_dsl",
        screen: index_ui_js_1.default,
        params: {},
        title: {
            zh: "Shader 流",
            en: "Shader Feed",
        },
    });
    ToolPkg.registerNavigationEntry({
        id: "shader_feed_sidebar",
        route: FEED_ROUTE,
        surface: "main_sidebar_plugins",
        title: {
            zh: "Shader 流",
            en: "Shader Feed",
        },
        icon: Icons.SportsEsports,
        order: 150,
    });
    // 聊天内实时渲染：AI 写出 <shader>…</shader> 时，把它换成一个活着的画面。
    // 注册形状与标签名集中在 chat-xml-render.ts，避免标签名与处理函数各改一处。
    ToolPkg.registerXmlRenderPlugin(chat_xml_render_js_1.SHADER_XML_RENDER_REGISTRATION);
    // 让 AI 知道 <shader> 标签存在 —— 否则这个能力永远没人发现。
    ToolPkg.registerSystemPromptComposeHook(system_prompt_js_1.SYSTEM_PROMPT_REGISTRATION);
    return true;
}
