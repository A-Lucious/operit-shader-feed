"use strict";
/**
 * 聊天内实时渲染 shader。
 *
 * 由 xml_render 钩子触发：AI 在回复里写出 `<shader>…</shader>`，钩子把代码通过 `state`
 * 下发到这里，这里用 WebView 渲染成**活的画面**（不是截图，它会一直动）。
 *
 * ⚠️ 这里**不用 JS bridge，也不用握手**。两条方向各有不依赖 bridge 的路：
 *
 *   界面 → 页面：把 payload 直接字符串替换进 HTML（`window.__pendingShader`），
 *                页面一解析完就知道该渲染什么。
 *   页面 → 界面：页面把回执 `console.log("[shader-report] …")`，宿主用
 *                `onConsoleMessage`（WebViewClient 层面的钩子）送到这里。
 *
 * 为什么必须这样：宿主挂 JS bridge 的时机是 `onPageStarted` / `onPageFinished`
 * （见 Operit 的 ToolPkgComposeDslWebView.kt），而页面脚本在**解析阶段**就跑完了。
 * 真机上实测——**等了 10 秒 `ShaderHost` 也没出现**，于是 deck 拿不到 shader、
 * 界面也收不到回执，框里只剩一句「没有收到宿主握手」。那条路不能当主路径。
 *
 * 另外整个页面还是**自包含 HTML**：没有域名、没有网络、没有文件系统、没有资源拦截
 * （真机上也实测过虚拟域拦截不生效：net::ERR_CONNECTION_CLOSED）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Screen;
const embedded_js_1 = require("../../deck/embedded.js");
const compile_ipc_js_1 = require("../../plugin/compile-ipc.js");
const chat_shader_state_js_1 = require("../../shared/chat-shader-state.js");
/**
 * 内联 payload 的占位符。必须与 resources/webview/runner.html 里那一处一字不差
 * （生成自包含 HTML 时它就在页面里），否则页面永远不知道该渲染什么。
 * 有一条测试盯着这个耦合。
 */
const PENDING_MARKER = "/*__PENDING_SHADER__*/null";
/**
 * 回执前缀。必须与 deck（src/deck/shader-deck.js 的 REPORT_PREFIX）一字不差。
 * 同样有测试盯着。
 */
const REPORT_PREFIX = "[shader-report] ";
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
/**
 * 把 payload 写进 HTML。
 *
 * 用**函数式**替换：`String.replace` 的替换串里 `$&`、`$1` 之类有特殊含义，
 * 而 shader 代码里完全可能出现 `$`（会被静默改写、表现为画面错乱）。
 */
function buildPageHtml(payload) {
    const json = JSON.stringify(payload);
    return embedded_js_1.SELF_CONTAINED_HTML.replace(PENDING_MARKER, () => json);
}
/** 从宿主给的 console 事件里取出消息文本（字段名不保证，所以只认字符串）。 */
function consoleText(event) {
    if (!event || typeof event !== "object") {
        return "";
    }
    const e = event;
    if (typeof e.message === "string") {
        return e.message;
    }
    if (typeof e.text === "string") {
        return e.text;
    }
    return "";
}
function Screen(ctx) {
    const { UI } = ctx;
    const colors = ctx.MaterialTheme.colorScheme;
    // 钩子下发的。键名来自共享常量，两边不会写岔（写岔的表现是「聊天里什么都不显示」）。
    const [shaderCode] = ctx.useState(chat_shader_state_js_1.STATE_KEY_SHADER_CODE, "");
    const [shaderTitle] = ctx.useState(chat_shader_state_js_1.STATE_KEY_SHADER_TITLE, "");
    const [statusText, setStatusText] = ctx.useState("chatStatus", "正在装载渲染器…");
    const [errorText, setErrorText] = ctx.useState("chatError", "");
    const [ready, setReady] = ctx.useState("chatReady", false);
    // 可变引用。除了 booted，其余字段都是**为了绕开闭包捕获**：
    // console 处理器只注册一次（它挂在 WebView 节点上），直接读 state 会捕获注册那一刻的值。
    const [flags] = ctx.useState("chatFlags", {
        booted: false,
        lastCodeLength: 0,
        code: "",
        title: "",
    });
    // 每次渲染都把最新值同步进去（state 晚到也能被后续的回执读到）。
    flags.code = shaderCode;
    flags.title = shaderTitle;
    /**
     * 把编译回执转给 main —— 这是 AI 拿到 GLSL 编译器报错的**唯一**途径。
     * 失败**不能静默**：这条方向挂掉的话，AI 永远读不到编译结果，
     * 而真正的现象（工具报"读不到"）只在对话里出现 —— 必须在这里留下原因。
     */
    function writeCompileIpc(payload) {
        Promise.resolve(ToolPkg.ipc.call(chat_shader_state_js_1.IPC_COMPILE_WRITE, payload)).catch((error) => {
            setErrorText("编译结果回传失败: " + toErrorText(error));
        });
    }
    /** 页面里 deck 的回执（走 console 送上来）。 */
    function onReport(json) {
        setStatusText(summarizeReport(json));
        // 每秒一次的 stats 会被 toCompileIpcPayload 丢掉，不会污染账本。
        const payload = (0, compile_ipc_js_1.toCompileIpcPayload)(json, {
            codeLength: flags.lastCodeLength,
        });
        if (payload) {
            writeCompileIpc(payload);
        }
    }
    function boot() {
        if (flags.booted) {
            return;
        }
        flags.booted = true;
        // 没有异步装载了：HTML 是编译期内联的字符串，payload 是运行时字符串替换进去的。
        setReady(true);
        setStatusText("渲染器就绪，等待页面回执…");
    }
    // 每次渲染都重新构造（字符串替换很便宜），保证拿到的是当前 state。
    const pageHtml = buildPageHtml({
        info: {
            id: "chat_inline",
            name: flags.title || "chat shader",
        },
        renderpass: [{ type: "image", inputs: [], code: flags.code }],
        __timeOffset: 0,
    });
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
        // 两条都显示，不互相遮蔽：真机上出现过「favicon 的错误把 deck 的真实状态盖掉」，
        // 屏幕上只剩一句看起来像页面挂了的报错。
        text: [statusText, errorText].filter((s) => s && s.length > 0).join("  ·  ") ||
            "…",
        style: "bodySmall",
        color: errorText ? colors.error : colors.onSurfaceVariant,
        maxLines: 4,
        overflow: "ellipsis",
        paddingHorizontal: 12,
        paddingBottom: 6,
    });
    const body = ready
        ? UI.WebView({
            key: "chat_shader_webview",
            // 关键：直接给 HTML（payload 已内联），不走 url。
            // 没有域名、没有网络请求、没有资源拦截、没有 JS bridge。
            html: pageHtml,
            baseUrl: "about:blank",
            // 显式 MIME/编码：宿主把 html 交给 loadDataWithBaseURL，别让嗅探决定。
            mimeType: "text/html",
            encoding: "utf-8",
            // 聊天里需要一个明确的框高（需求原话是「显示在一个框里」）。
            height: 260,
            fillMaxWidth: true,
            javaScriptEnabled: true,
            domStorageEnabled: true,
            supportZoom: false,
            useWideViewPort: true,
            loadWithOverviewMode: true,
            onReceivedError: (event) => {
                const e = (event || {});
                const url = typeof e.url === "string" ? e.url : "";
                // favicon 之类的子资源失败会把真正的错误盖住。真机实测过一次：
                // 屏幕上只有一句 favicon 的 ERR_CONNECTION_CLOSED，看起来像整个页面挂了。
                if (/favicon/i.test(url)) {
                    return;
                }
                setErrorText("页面错误: " + JSON.stringify(event).slice(0, 200));
            },
            onConsoleMessage: (event) => {
                const text = consoleText(event);
                if (!text) {
                    return;
                }
                const at = text.indexOf(REPORT_PREFIX);
                if (at >= 0) {
                    onReport(text.slice(at + REPORT_PREFIX.length));
                    return;
                }
                // 页面里 deck 的 setStatus 也会 console.log（前缀是 [runner]）——
                // 把它当补充诊断，但不要盖掉回执带来的状态。
                if (text.indexOf("[runner]") >= 0 && !errorText) {
                    setStatusText(text.replace("[runner]", "").trim().slice(0, 200));
                }
            },
        })
        : UI.Box({ height: 120, fillMaxWidth: true, contentAlignment: "center" }, UI.Text({
            text: "正在装载渲染器…",
            style: "bodySmall",
            color: colors.onSurfaceVariant,
        }));
    return UI.Column({ fillMaxWidth: true, backgroundColor: colors.surface, onLoad: boot }, [header, statusBar, body]);
}
