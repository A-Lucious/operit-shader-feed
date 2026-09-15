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

import { SELF_CONTAINED_HTML } from "../../deck/embedded.js";
import {
  toCompileIpcPayload,
  type CompileIpcWrite,
} from "../../plugin/compile-ipc.js";
import {
  HOST_INTERFACE_NAME,
  IPC_COMPILE_WRITE,
  STATE_KEY_SHADER_CODE,
  STATE_KEY_SHADER_TITLE,
} from "../../shared/chat-shader-state.js";

/**
 * 页面的基准地址。这里没有任何相对资源，给一个真实 origin 只是为了不让页面处在
 * opaque origin（某些 WebView 对 opaque origin 的 WebGL/localStorage 更严格）。
 * 它**不会**被真的访问 —— 页面内容全部内联。
 */
const PAGE_BASE_URL = "https://shaderfeed.local/";

/** 命名避开组件内的 errorText 状态，否则会被它遮蔽（同名遮蔽后就不是函数了）。 */
function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** runner 上报的是 JSON 字符串；聊天里要的是一句人话，不是原始 JSON。 */
function summarizeReport(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      stage?: string;
      errors?: string[];
      fps?: number;
      isGLSL3?: boolean;
    };
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
  } catch {
    return text.slice(0, 200);
  }
}

/** 从宿主给的 console 事件里尽量取出一句可读的话（字段名不保证，所以只认字符串）。 */
function summarizeConsole(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "";
  }
  const e = event as Record<string, unknown>;
  const level = typeof e.level === "string" ? e.level.toLowerCase() : "";
  const message =
    typeof e.message === "string"
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

export default function Screen(ctx: ComposeDslContext): ComposeNode {
  const { UI } = ctx;
  const colors = ctx.MaterialTheme.colorScheme;

  // 钩子下发的。键名来自共享常量，两边不会写岔（写岔的表现是「聊天里什么都不显示」）。
  const [shaderCode] = ctx.useState(STATE_KEY_SHADER_CODE, "");
  const [shaderTitle] = ctx.useState(STATE_KEY_SHADER_TITLE, "");

  const [statusText, setStatusText] = ctx.useState(
    "chatStatus",
    "渲染器就绪，等待页面握手…",
  );
  const [errorText, setErrorText] = ctx.useState("chatError", "");
  const [ready, setReady] = ctx.useState("chatReady", false);

  // lastCodeLength：下发时的代码长度。**必须放 ref，不能读 state** ——
  // report 处理器是在 boot() 里注册一次的，闭包会捕获注册那一刻的 shaderCode（空串），
  // 于是长度永远是 0，AI 就没法判断「读到的是不是我刚写那段」。
  const [flags] = ctx.useState<{ booted: boolean; lastCodeLength: number }>(
    "chatFlags",
    {
      booted: false,
      lastCodeLength: 0,
    },
  );

  const controller = ctx.createWebViewController("chat_shader_webview");

  /**
   * 把编译回执转给 main —— 这是 AI 拿到 GLSL 编译器报错的**唯一**途径。
   * 失败必须静默：这条通道是尽力而为的，它挂了不该连带渲染框也看不见。
   */
  function writeCompileIpc(payload: CompileIpcWrite): void {
    Promise.resolve(ToolPkg.ipc.call(IPC_COMPILE_WRITE, payload)).catch(
      () => undefined,
    );
  }

  function sendShader(): void {
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
    const script =
      "__runnerLoad(" + JSON.stringify(payload) + ", { timeOffset: 0 });";
    // 先记长度、再告诉 main「新代码已下发」：此后 AI 读到的是「还在编译」，
    // 而不是上一次的报错 —— 读旧报错会让它去改一段自己已经改过的地方。
    flags.lastCodeLength = shaderCode.length;
    writeCompileIpc({ kind: "pending", codeLength: flags.lastCodeLength });
    Promise.resolve(controller.evaluateJavascript(script)).catch(
      (error: unknown) => {
        setErrorText("下发失败: " + toErrorText(error));
      },
    );
  }

  function registerHost(): void {
    controller.removeJavascriptInterface(HOST_INTERFACE_NAME);
    const host: ComposeWebViewJavascriptInterface = {
      ready: () => {
        // 页面脚本跑起来了 —— 这一句能被调用，就说明自包含 HTML 那条路是通的。
        sendShader();
        return true;
      },
      report: (...args: unknown[]) => {
        const value = args.length > 0 ? args[0] : undefined;
        const text = typeof value === "string" ? value : JSON.stringify(value);
        setStatusText(summarizeReport(text));
        // 编译回执转给 main —— AI 看不到界面，这是它拿到编译器报错的唯一途径。
        // （value 可能是 JSON 字符串，也可能是对象；解析在 compile-ipc 里，
        //   每秒一次的 stats 会在那里被丢掉，不会污染账本。）
        const payload = toCompileIpcPayload(value, {
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
    controller.addJavascriptInterface(HOST_INTERFACE_NAME, host);
  }

  function boot(): void {
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
        // 关键：直接给 HTML，不走 url。没有域名、没有网络请求、没有资源拦截。
        html: SELF_CONTAINED_HTML,
        baseUrl: PAGE_BASE_URL,
        // 聊天里需要一个明确的框高（需求原话是「显示在一个框里」）。
        height: 260,
        fillMaxWidth: true,
        javaScriptEnabled: true,
        domStorageEnabled: true,
        supportZoom: false,
        useWideViewPort: true,
        loadWithOverviewMode: true,
        onReceivedError: (event: unknown) => {
          setErrorText("页面错误: " + JSON.stringify(event).slice(0, 200));
        },
        onConsoleMessage: (event: unknown) => {
          const line = summarizeConsole(event);
          if (line) {
            setErrorText("页面 " + line);
          }
        },
      })
    : UI.Box(
        { height: 120, fillMaxWidth: true, contentAlignment: "center" },
        UI.Text({
          text: "正在装载渲染器…",
          style: "bodySmall",
          color: colors.onSurfaceVariant,
        }),
      );

  return UI.Column(
    { fillMaxWidth: true, backgroundColor: colors.surface, onLoad: boot },
    [header, statusBar, body],
  );
}
