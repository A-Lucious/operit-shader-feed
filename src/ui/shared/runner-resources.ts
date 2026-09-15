/**
 * 虚拟域资源拦截的共享实现。
 *
 * 侧边栏与「聊天内实时渲染」都要把 runner 页面喂给各自的 WebView，而这一套
 * （虚拟域 → 拦截 → 用 readResource 拿到的落盘路径作答）逻辑必须只有一份 ——
 * 两处各写一份，将来改一处忘另一处，表现会是"某个界面白屏"。
 *
 * 为什么走虚拟域而不是 loadHtml：`ToolPkg.readResource()` 返回的是**落盘后的绝对路径**，
 * 不是文件内容（见 docs/doc-src/package-dev/toolpkg.md）。拿不到 HTML 字符串，
 * 所以只能让页面从虚拟域加载、由宿主拦截并按路径作答。
 */

export const VIRTUAL_HOST = "https://shaderfeed.local";

/** 宿主注入的 JS 接口名。页面侧通过 window.ShaderHost 回调用。 */
export const HOST_INTERFACE_NAME = "ShaderHost";

export interface PageSpec {
  path: string;
  mime: string;
  resourceKey: string;
  /** 释放到宿主临时目录时使用的文件名；runner.html 靠相对名引用 runner.js。 */
  fileName: string;
}

export const RUNNER_PAGE: PageSpec = {
  path: "/runner.html",
  mime: "text/html",
  resourceKey: "runner_html",
  fileName: "runner.html",
};

export const RUNNER_SCRIPT: PageSpec = {
  path: "/runner.js",
  mime: "application/javascript",
  resourceKey: "runner_js",
  fileName: "runner.js",
};

export const PROBE_PAGE: PageSpec = {
  path: "/probe.html",
  mime: "text/html",
  resourceKey: "probe_html",
  fileName: "probe.html",
};

/** 释放后的落盘路径。空串表示没拿到。 */
export interface RunnerResourcePaths {
  runner: string;
  script: string;
  probe: string;
}

/**
 * 把三个 webview 资源释放到宿主临时目录。
 * 注意：**不能在 `registerToolPkg()` 执行期间调用**（会立即抛异常）。
 */
export async function releaseRunnerResources(): Promise<RunnerResourcePaths> {
  const [html, script, probe] = await Promise.all([
    ToolPkg.readResource(RUNNER_PAGE.resourceKey, RUNNER_PAGE.fileName),
    ToolPkg.readResource(RUNNER_SCRIPT.resourceKey, RUNNER_SCRIPT.fileName),
    ToolPkg.readResource(PROBE_PAGE.resourceKey, PROBE_PAGE.fileName),
  ]);
  return {
    runner: String(html || "").trim(),
    script: String(script || "").trim(),
    probe: String(probe || "").trim(),
  };
}

/** 把虚拟域 URL 归一成 pathname；不是本虚拟域则返回 null。 */
export function resolvePathname(url: string): string | null {
  const value = String(url || "").trim();
  if (!value.startsWith(VIRTUAL_HOST)) {
    return null;
  }
  const suffix = value.slice(VIRTUAL_HOST.length) || "/";
  const withoutHash = suffix.split("#", 1)[0] || "/";
  const withoutQuery = withoutHash.split("?", 1)[0] || "/";
  return withoutQuery.startsWith("/") ? withoutQuery : "/" + withoutQuery;
}

export function buildFileResponse(
  mime: string,
  filePath: string,
): ComposeWebViewResourceDecision {
  return {
    action: "respond",
    response: {
      mimeType: mime,
      encoding: "UTF-8",
      statusCode: 200,
      reasonPhrase: "OK",
      // no-store：调试时改了 runner 要立刻生效，别被 WebView 缓存住。
      headers: { "Cache-Control": "no-store" },
      filePath,
    },
  };
}

/**
 * 造一个资源拦截处理器。传空串表示那个页面这次不用（对应请求会被 block，
 * 而不是去回一个空文件 —— 那样页面会拿到 0 字节脚本，报错更难查）。
 */
export function makeResourceHandler(paths: RunnerResourcePaths) {
  return function handleResourceRequest(
    request: ComposeWebViewResourceRequest,
  ): ComposeWebViewResourceDecision {
    const pathname = resolvePathname(request.url);
    if (pathname === null) {
      // 虚拟域之外的请求不属于本页资源，交给 WebView 自行处理。
      return { action: "allow" };
    }
    if (pathname === RUNNER_PAGE.path && paths.runner) {
      return buildFileResponse(RUNNER_PAGE.mime, paths.runner);
    }
    if (pathname === RUNNER_SCRIPT.path && paths.script) {
      return buildFileResponse(RUNNER_SCRIPT.mime, paths.script);
    }
    if (pathname === PROBE_PAGE.path && paths.probe) {
      return buildFileResponse(PROBE_PAGE.mime, paths.probe);
    }
    return { action: "block" };
  };
}
