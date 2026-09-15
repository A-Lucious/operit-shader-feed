import feedScreen from "./ui/feed/index.ui.js";

/**
 * 侧边栏路由。它会出现在市场入口和 `toolpkg:` 引用里，改它等于换入口，别随手改。
 */
const FEED_ROUTE = "toolpkg:com.shaderfeed.operit:ui:feed";

/**
 * ToolPkg 主入口：只做注册，不在这里调用 `ToolPkg.readResource()`
 * （注册期间调用会立即抛异常，见 TOOLPKG_FORMAT_GUIDE.md §3.2.5）。
 */
export function registerToolPkg(): boolean {
  ToolPkg.registerUiRoute({
    id: "feed",
    route: FEED_ROUTE,
    runtime: "compose_dsl",
    screen: feedScreen,
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
