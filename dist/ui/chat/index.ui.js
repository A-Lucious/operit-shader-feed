"use strict";
/**
 * 聊天内实时渲染 shader。
 *
 * 由 xml_render 钩子触发：AI 在回复里写出 `<shader>…</shader>`，钩子把代码通过 `state`
 * 下发到这里，这里用 WebView 渲染成**活的画面**（不是截图，它会一直动）。
 *
 * ⚠️ 这里只用**自包含 HTML**：deck 在编译期内联进 HTML 字符串（见 tools/embed-runner.mjs）。
 *
 * 为什么不再走「虚拟域 + 资源拦截 + readResource 落盘路径」：
 *   真机实测那条路根本不工作 ——
 *       net::ERR_CONNECTION_CLOSED  https://shaderfeed.local/runner.html
 *   即拦截没生效，WebView 跑到**真网络**上找那个域名，于是整条链路（含 JS bridge 握手）
 *   一起断掉，界面上只剩一句「网页无法打开」。
 *   自包含 HTML 把这一整类失败模式移除：没有域名、没有网络、没有文件系统、没有拦截。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = Screen;
const embedded_js_1 = require("../../deck/embedded.js");
const compile_ipc_js_1 = require("../../plugin/compile-ipc.js");
const chat_shader_state_js_1 = require("../../shared/chat-shader-state.js");
/**
 * 页面的基准地址。
 *
 * 用 about:blank 而不是一个 https 域名：真机实测过 —— 给 https://shaderfeed.local/ 时
 * WebView 会自动去请求 https://shaderfeed.local/favicon.ico，那个请求当然连不上
 * （ERR_CONNECTION_CLOSED），然后报给我的 onReceivedError，**盖住了真正的错误**。
 * 页面内容全内联，不需要任何自的 origin。
 */
const PAGE_BASE_URL = "about:blank";
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
/** 从宿主给的 console 事件里尽量取出一句可读的话（字段名不保证，所以只认字符串）。 */
function summarizeConsole(event) {
    if (!event || typeof event !== "object") {
        return "";
    }
    const e = event;
    const level = typeof e.level === "string" ? e.level.toLowerCase() : "";
    const message = typeof e.message === "string"
        ? e.message
        : typeof e.text === "string"
            ? e.text
            : "";
    if (!message) {
        return "";
    }
    // 只把 error/warn 抬到状态行；普通 log 会被每秒一次的 stats 刷掉，没意义。
    if (level && level !== "error" && level !== "warn") {
        return "";
    }
    return (level ? level + ": " : "") + message.slice(0, 200);
}
function Screen(ctx) {
    const { UI } = ctx;
    const colors = ctx.MaterialTheme.colorScheme;
    // 钩子下发的。键名来自共享常量，两边不会写岔（写岔的表现是「聊天里什么都不显示」）。
    const [shaderCode] = ctx.useState(chat_shader_state_js_1.STATE_KEY_SHADER_CODE, "");
    const [shaderTitle] = ctx.useState(chat_shader_state_js_1.STATE_KEY_SHADER_TITLE, "");
    const [statusText, setStatusText] = ctx.useState("chatStatus", "渲染器就绪，等待页面握手…");
    const [errorText, setErrorText] = ctx.useState("chatError", "");
    const [ready, setReady] = ctx.useState("chatReady", false);
    // 可变引用。除了 booted，其余字段都是**为了绕开闭包捕获**：
    // report / ready 处理器只注册一次，直接读 state 会捕获注册那一刻的值。
    // 真机上的后果是「黑框且什么都不报」—— 因为读到的 shaderCode 是空串。
    const [flags] = ctx.useState("chatFlags", {
        booted: false,
        lastCodeLength: 0,
        code: "",
        title: "",
    });
    // 每次渲染都把最新值同步进去（state 晚到也能被后续的握手/回执读到）。
    flags.code = shaderCode;
    flags.title = shaderTitle;
    const controller = ctx.createWebViewController("chat_shader_webview");
    /**
     * 把编译回执转给 main —— 这是 AI 拿到 GLSL 编译器报错的**唯一**途径。
     * 失败必须静默：这条通道是尽力而为的，它挂了不该连带渲染框也看不见。
     */
    function writeCompileIpc(payload) {
        Promise.resolve(ToolPkg.ipc.call(chat_shader_state_js_1.IPC_COMPILE_WRITE, payload)).catch(() => undefined);
    }
    function sendShader() {
        // 从 ref 读，不从闭包读：state 可能晚于 registerHost() 到达。
        const code = flags.code;
        if (!code) {
            setErrorText("没有收到 shader 代码（state 里是空的）。");
            return;
        }
        // AI 写的是 Shadertoy 风格的 mainImage，这里包成 deck 认的 renderpass 形状。
        // 没有通道：聊天里没有纹理可绑。
        const payload = {
            info: { id: "chat_inline", name: flags.title || "chat shader" },
            renderpass: [{ type: "image", inputs: [], code: code }],
        };
        const script = "__runnerLoad(" + JSON.stringify(payload) + ", { timeOffset: 0 });";
        // 先记长度、再告诉 main「新代码已下发」：此后 AI 读到的是「还在编译」，
        // 而不是上一次的报错 —— 读旧报错会让它去改一段自己已经改过的地方。
        flags.lastCodeLength = code.length;
        writeCompileIpc({ kind: "pending", codeLength: flags.lastCodeLength });
        Promise.resolve(controller.evaluateJavascript(script)).catch((error) => {
            setErrorText("下发失败: " + toErrorText(error));
        });
    }
    /**
     * 把下发推迟一拍。
     *
     * ⚠️ 不能在握手回调里**同步**调 `evaluateJavascript`：宿主侧那是阻塞实现
     * （`evaluateJavascriptBlocking` 会发到主线程等 WebView 回调，还有超时），
     * 而此刻页面的 JS 正卡在这次握手调用上等我们返回 —— 两边互等，最后超时抛错。
     * 真机上的表现就是「黑框，什么提示都没有」。
     */
    function scheduleSend() {
        if (typeof setTimeout === "function") {
            setTimeout(() => sendShader(), 0);
            return;
        }
        sendShader();
    }
    function registerHost() {
        controller.removeJavascriptInterface(chat_shader_state_js_1.HOST_INTERFACE_NAME);
        const host = {
            ready: () => {
                // 页面脚本跑起来了 —— 这一句能被调用，就说明自包含 HTML 那条路是通的。
                // 不能在这里同步下发（见 scheduleSend 的注释）。
                scheduleSend();
                return true;
            },
            report: (...args) => {
                const value = args.length > 0 ? args[0] : undefined;
                const text = typeof value === "string" ? value : JSON.stringify(value);
                setStatusText(summarizeReport(text));
                // 编译回执转给 main —— AI 看不到界面，这是它拿到编译器报错的唯一途径。
                // （value 可能是 JSON 字符串，也可能是对象；解析在 compile-ipc 里，
                //   每秒一次的 stats 会在那里被丢掉，不会污染账本。）
                const payload = (0, compile_ipc_js_1.toCompileIpcPayload)(value, {
                    codeLength: flags.lastCodeLength,
                });
                if (payload) {
                    writeCompileIpc(payload);
                }
                return true;
            },
            // 聊天里不需要换片，但页面挂了手势监听；给个空实现免得它报「宿主不可用」。
            swipe: () => true,
        };
        controller.addJavascriptInterface(chat_shader_state_js_1.HOST_INTERFACE_NAME, host);
    }
    function boot() {
        if (flags.booted) {
            return;
        }
        flags.booted = true;
        // 再没有异步装载：HTML 是编译期内联进来的字符串，直接把 bridge 挂上就行。
        // 顺序很重要 —— WebView 只有 ready 之后才渲染，所以 bridge 一定先于页面存在。
        registerHost();
        setReady(true);
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
            controller,
            // 关键：直接给 HTML，不走 url。没有域名、没有网络请求、没有资源拦截。
            html: embedded_js_1.SELF_CONTAINED_HTML,
            baseUrl: PAGE_BASE_URL,
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
                // 屏幕上只有一句 shaderfeed.local/favicon 的 ERR_CONNECTION_CLOSED，
                // 看起来像整个页面挂了，实际页面好好的。
                if (/favicon/i.test(url)) {
                    return;
                }
                setErrorText("页面错误: " + JSON.stringify(event).slice(0, 200));
            },
            onConsoleMessage: (event) => {
                const line = summarizeConsole(event);
                if (line) {
                    setErrorText("页面 " + line);
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
