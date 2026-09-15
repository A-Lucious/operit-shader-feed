"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerToolPkg = registerToolPkg;
const index_ui_js_1 = __importDefault(require("./ui/feed/index.ui.js"));
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
    return true;
}
