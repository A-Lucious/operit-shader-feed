"use strict";
/**
 * 聊天内实时渲染 shader（需求 3）。
 *
 * 由 xml_render 钩子触发：AI 在回复里写出 `<shader>…</shader>`，钩子把代码通过
 * `state` 下发到这里，这里用 WebView + 同一个 runner/deck 渲染成**活的画面**，
 * 不是截图 —— 它会一直动。
 *
 * 与侧边栏那套共用 src/ui/shared/runner-resources.ts，所以虚拟域拦截只有一份实现。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Screen;
const runner_resources_js_1 = require("../shared/runner-resources.js");
/** 命名避开组件内的 errorText 状态，否则会被它遮蔽（同名遮蔽后就不是函数了）。 */
function toErrorText(error) {
    return error instanceof Error ? error.message : String(error);
}
/** runner 上报的是 JSON 字符串；聊天里要的是一句人话，不是原始 JSON。 */
function summarizeReport(text) {
    try {
        const parsed = JSON.parse(text);
        if (parsed.stage === "stats") {
            return "渲染中 · " + (parsed.fps ?? 0) + " fps";
        }
        if (parsed.stage === "compile") {
            // 编译失败是这里最需要被看见的信息（AI 看不到它，但用户能）。
            const first = (parsed.errors && parsed.errors[0]) || "未知编译错误";
            return "编译失败：" + String(first).slice(0, 200);
        }
        if (parsed.stage === "running") {
            return "渲染中 · GLSL" + (parsed.isGLSL3 ? "3" : "1");
        }
        return text.slice(0, 200);
    }
    catch {
        return text.slice(0, 200);
    }
}
function Screen(ctx) {
    const { UI } = ctx;
    const colors = ctx.MaterialTheme.colorScheme;
    // 钩子下发的（键名与 chat-xml-render.ts 里的 state 一一对应）
    const [shaderCode] = ctx.useState("shaderCode", "");
    const [shaderTitle] = ctx.useState("shaderTitle", "");
    const [statusText, setStatusText] = ctx.useState("chatStatus", "正在装载渲染器…");
    const [errorText, setErrorText] = ctx.useState("chatError", "");
    const [ready, setReady] = ctx.useState("chatReady", false);
    // 可变引用：拦截处理器在请求到达时才读这些路径。
    const [paths] = ctx.useState("chatPaths", {
        runner: "",
        script: "",
        probe: "",
    });
    const [flags] = ctx.useState("chatFlags", {
        booted: false,
    });
    const controller = ctx.createWebViewController("chat_shader_webview");
    function sendShader() {
        if (!shaderCode) {
            setErrorText("没有收到 shader 代码（标签里是空的）。");
            return;
        }
        // AI 写的是 Shadertoy 风格的 mainImage，这里包成 deck 认的 renderpass 形状。
        // 没有通道：聊天里没有纹理可绑。
        const payload = {
            info: { id: "chat_inline", name: shaderTitle || "chat shader" },
            renderpass: [{ type: "image", inputs: [], code: shaderCode }],
        };
        const script = "__runnerLoad(" + JSON.stringify(payload) + ", { timeOffset: 0 });";
        Promise.resolve(controller.evaluateJavascript(script)).catch((error) => {
            setErrorText("下发失败: " + toErrorText(error));
        });
    }
    function registerHost() {
        controller.removeJavascriptInterface(runner_resources_js_1.HOST_INTERFACE_NAME);
        const host = {
            ready: () => {
                sendShader();
                return true;
            },
            report: (...args) => {
                const value = args.length > 0 ? args[0] : undefined;
                const text = typeof value === "string" ? value : JSON.stringify(value);
                setStatusText(summarizeReport(text));
                return true;
            },
            // 聊天里不需要换片，但页面挂了手势监听；给个空实现免得它报"宿主不可用"。
            swipe: () => true,
        };
        controller.addJavascriptInterface(runner_resources_js_1.HOST_INTERFACE_NAME, host);
    }
    async function boot() {
        if (flags.booted) {
            return;
        }
        flags.booted = true;
        try {
            const released = await (0, runner_resources_js_1.releaseRunnerResources)();
            if (!released.runner || !released.script) {
                setErrorText("runner 资源没有完整装载。");
                setStatusText("资源装载失败");
                return;
            }
            paths.runner = released.runner;
            paths.script = released.script;
            paths.probe = released.probe;
            registerHost();
            setReady(true);
            setStatusText("渲染器就绪，等待页面握手…");
        }
        catch (error) {
            setErrorText("资源装载异常: " + toErrorText(error));
        }
    }
    const header = UI.Text({
        text: shaderTitle ? "Shader · " + shaderTitle : "Shader",
        style: "labelMedium",
        color: colors.onSurfaceVariant,
        maxLines: 1,
        overflow: "ellipsis",
        paddingHorizontal: 12,
        paddingTop: 8,
    });
    const statusBar = UI.Text({
        text: errorText ? errorText : statusText,
        style: "bodySmall",
        color: errorText ? colors.error : colors.onSurfaceVariant,
        maxLines: 3,
        overflow: "ellipsis",
        paddingHorizontal: 12,
        paddingBottom: 6,
    });
    const body = ready
        ? UI.WebView({
            key: "chat_shader_webview",
            controller,
            url: runner_resources_js_1.VIRTUAL_HOST + runner_resources_js_1.RUNNER_PAGE.path,
            // 聊天里需要一个明确的框高（需求原话是「显示在一个框里」）。
            height: 260,
            fillMaxWidth: true,
            javaScriptEnabled: true,
            domStorageEnabled: true,
            supportZoom: false,
            useWideViewPort: true,
            loadWithOverviewMode: true,
            onShouldOverrideUrlLoading: (request) => (0, runner_resources_js_1.resolvePathname)(request.url) === null
                ? { action: "external", url: request.url }
                : { action: "allow" },
            onInterceptRequest: (0, runner_resources_js_1.makeResourceHandler)(paths),
            onReceivedError: (event) => {
                setErrorText("页面错误: " + JSON.stringify(event).slice(0, 200));
            },
        })
        : UI.Box({ height: 120, fillMaxWidth: true, contentAlignment: "center" }, UI.Text({
            text: errorText || "正在装载渲染器…",
            style: "bodySmall",
            color: errorText ? colors.error : colors.onSurfaceVariant,
        }));
    return UI.Column({ fillMaxWidth: true, backgroundColor: colors.surface, onLoad: boot }, [header, statusBar, body]);
}
