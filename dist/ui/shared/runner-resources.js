"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROBE_PAGE = exports.RUNNER_SCRIPT = exports.RUNNER_PAGE = exports.HOST_INTERFACE_NAME = exports.VIRTUAL_HOST = void 0;
exports.releaseRunnerResources = releaseRunnerResources;
exports.resolvePathname = resolvePathname;
exports.buildFileResponse = buildFileResponse;
exports.makeResourceHandler = makeResourceHandler;
exports.VIRTUAL_HOST = "https://shaderfeed.local";
/** 宿主注入的 JS 接口名。页面侧通过 window.ShaderHost 回调用。 */
exports.HOST_INTERFACE_NAME = "ShaderHost";
exports.RUNNER_PAGE = {
    path: "/runner.html",
    mime: "text/html",
    resourceKey: "runner_html",
    fileName: "runner.html",
};
exports.RUNNER_SCRIPT = {
    path: "/runner.js",
    mime: "application/javascript",
    resourceKey: "runner_js",
    fileName: "runner.js",
};
exports.PROBE_PAGE = {
    path: "/probe.html",
    mime: "text/html",
    resourceKey: "probe_html",
    fileName: "probe.html",
};
/**
 * 把三个 webview 资源释放到宿主临时目录。
 * 注意：**不能在 `registerToolPkg()` 执行期间调用**（会立即抛异常）。
 */
async function releaseRunnerResources() {
    const [html, script, probe] = await Promise.all([
        ToolPkg.readResource(exports.RUNNER_PAGE.resourceKey, exports.RUNNER_PAGE.fileName),
        ToolPkg.readResource(exports.RUNNER_SCRIPT.resourceKey, exports.RUNNER_SCRIPT.fileName),
        ToolPkg.readResource(exports.PROBE_PAGE.resourceKey, exports.PROBE_PAGE.fileName),
    ]);
    return {
        runner: String(html || "").trim(),
        script: String(script || "").trim(),
        probe: String(probe || "").trim(),
    };
}
/** 把虚拟域 URL 归一成 pathname；不是本虚拟域则返回 null。 */
function resolvePathname(url) {
    const value = String(url || "").trim();
    if (!value.startsWith(exports.VIRTUAL_HOST)) {
        return null;
    }
    const suffix = value.slice(exports.VIRTUAL_HOST.length) || "/";
    const withoutHash = suffix.split("#", 1)[0] || "/";
    const withoutQuery = withoutHash.split("?", 1)[0] || "/";
    return withoutQuery.startsWith("/") ? withoutQuery : "/" + withoutQuery;
}
function buildFileResponse(mime, filePath) {
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
function makeResourceHandler(paths) {
    return function handleResourceRequest(request) {
        const pathname = resolvePathname(request.url);
        if (pathname === null) {
            // 虚拟域之外的请求不属于本页资源，交给 WebView 自行处理。
            return { action: "allow" };
        }
        if (pathname === exports.RUNNER_PAGE.path && paths.runner) {
            return buildFileResponse(exports.RUNNER_PAGE.mime, paths.runner);
        }
        if (pathname === exports.RUNNER_SCRIPT.path && paths.script) {
            return buildFileResponse(exports.RUNNER_SCRIPT.mime, paths.script);
        }
        if (pathname === exports.PROBE_PAGE.path && paths.probe) {
            return buildFileResponse(exports.PROBE_PAGE.mime, paths.probe);
        }
        return { action: "block" };
    };
}
