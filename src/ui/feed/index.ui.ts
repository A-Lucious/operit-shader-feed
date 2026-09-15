/**
 * P0 侧边栏外壳：只做「释放资源 → 喂给 WebView → 在 Runner / Probe 之间切换」。
 *
 * 两个必须记住的约束：
 *
 * 1. `ToolPkg.readResource()` 返回的是**落盘后的绝对路径**，不是文件内容
 *    （见 src/types/operit.d.ts 的说明，以及 TOOLPKG_FORMAT_GUIDE.md §3.2.6），
 *    所以拿不到 HTML 字符串去喂 `loadHtml()`。P0 走「虚拟域 + 资源拦截」，
 *    与官方示例 dino_runner 同一条路。
 * 2. `runner.html` 必须自己用 `<script src="./runner.js">` 加载 deck。
 *    deck 是自注册的 IIFE（定义 `window.__runnerLoad` 并在末尾调用
 *    `ShaderHost.ready()`），由页面加载比宿主注入更稳。
 */

import {
  CRAWL_PROBE_SCRIPT,
  SHADERTOY_ORIGIN,
  SHADERTOY_PROBE_URL,
} from "../../feed/crawl-probe.js";
import {
  createHostFs,
  DEFAULT_STORE_ROOT,
  hashTextureUrl,
  verifyRootWritable,
} from "../../feed/host-fs.js";
import { createStore, type Store } from "../../feed/store.js";
import {
  isSinglePassRenderable,
  parseShader,
  type ShaderRecord,
} from "../../feed/parse.js";
import { CANNED, runSelfTest } from "../../feed/selftest.js";
import { createStoreCrawler } from "../../feed/store-crawler.js";
import { createFeed, type Feed } from "../../feed/feed.js";
import { describeFeedStatus } from "../../feed/feed-status.js";
import { createCrawler, type Crawler } from "../../feed/crawler.js";
import {
  createSessionTransport,
  defaultRecipe,
} from "../../feed/transport.js";

import {
  HOST_INTERFACE_NAME,
  PROBE_PAGE,
  RUNNER_PAGE,
  VIRTUAL_HOST,
  makeResourceHandler,
  releaseRunnerResources,
  resolvePathname,
} from "../shared/runner-resources.js";

/**
 * P0 内置 demo shader：GLSL1、无通道，只验证 deck 的渲染回路能跑通。
 * 形状必须匹配 deck 的 assemble()：`renderpass[]` + `type: "image"` + `mainImage()`。
 */
const DEMO_SHADER = {
  info: { id: "p0_demo", name: "P0 Demo" },
  renderpass: [
    {
      type: "image",
      inputs: [],
      code: [
        "void mainImage(out vec4 fragColor, in vec2 fragCoord) {",
        "  vec2 uv = fragCoord / iResolution.xy;",
        "  float t = iTime * 0.5;",
        "  vec3 col = 0.5 + 0.5 * cos(t + uv.xyx + vec3(0.0, 2.0, 4.0));",
        "  col *= 0.6 + 0.4 * sin(uv.y * 12.0 + iTime * 2.0);",
        "  fragColor = vec4(col, 1.0);",
        "}",
      ].join("\n"),
    },
  ],
};

const DEMO_TIME_OFFSET = 12;

type PageTarget = "runner" | "probe" | "crawl" | "cache";

/** 一处定义，避免页面名与加载提示各写一套嵌套三元。 */
const PAGE_META: Record<PageTarget, { label: string; loading: string }> = {
  runner: { label: "runner.html", loading: "正在加载 runner.html…" },
  probe: { label: "probe.html", loading: "正在加载 probe.html…" },
  crawl: {
    label: "shadertoy.com",
    loading: "正在打开 shadertoy.com（首次会先过 Cloudflare）…",
  },
  cache: { label: "缓存", loading: "正在读取缓存占用…" },
};

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 宿主 console 打点。不声明全局 `console`，避免与 lib.dom 的声明冲突（TS2451）。 */
/**
 * 宿主能力一行摘要。传输层的请求超时依赖 setTimeout，而它到底存不存在是实测问题 ——
 * 所以如实报出来，而不是假定它有。探针包在 try 里：宿主对象真的缺失时也不能把状态页炸掉。
 */
function hostCapabilityLine(): string {
  const probe = (fn: () => unknown): string => {
    try {
      return typeof fn();
    } catch {
      return "throw";
    }
  };
  return [
    "setTimeout=" + typeof setTimeout,
    "setInterval=" + typeof setInterval,
    "CryptoJS=" + probe(() => CryptoJS),
    "Tools.Files=" + probe(() => Tools.Files),
  ].join(" ");
}

function hostLog(message: string): void {
  // SAFETY: QuickJS 宿主保证提供 console；这里只探测它是否存在、log 是否可调用，
  // 不对其结构做校验，因此用断言而不是收窄。
  const holder = globalThis as {
    console?: { log: (...args: unknown[]) => void };
  };
  const logger = holder.console;
  if (logger && typeof logger.log === "function") {
    logger.log(message);
  }
}

export default function Screen(ctx: ComposeDslContext): ComposeNode {
  const { UI } = ctx;
  const colors = ctx.MaterialTheme.colorScheme;

  const controller = ctx.createWebViewController("shader_feed_webview");

  const [initialized, setInitialized] = ctx.useState("initialized", false);
  const [resourcesReady, setResourcesReady] = ctx.useState(
    "resourcesReady",
    false,
  );
  const [target, setTarget] = ctx.useState<PageTarget>("target", "runner");
  const [statusText, setStatusText] = ctx.useState(
    "statusText",
    "正在装载资源…",
  );
  const [pageError, setPageError] = ctx.useState("pageError", "");
  const [runnerPath, setRunnerPath] = ctx.useState("runnerPath", "");
  const [runnerScriptPath, setRunnerScriptPath] = ctx.useState(
    "runnerScriptPath",
    "",
  );
  const [probePath, setProbePath] = ctx.useState("probePath", "");
  const [cacheReport, setCacheReport] = ctx.useState("cacheReport", "");
  const [cacheBusy, setCacheBusy] = ctx.useState("cacheBusy", false);
  // 可变 ref：store 与告警都挂在同一个对象上，避免重渲染时被重建。
  const [cacheRefs] = ctx.useState<{ store: Store | null; warnings: string[] }>(
    "cacheRefs",
    { store: null, warnings: [] },
  );

  // 串流播放器的可变引用；null 表示还没开始播。
  // offline / lastStatus 也放这里：它们不参与渲染，只是用来避免每秒都 setState 一次。
  const [feedRef] = ctx.useState<{
    feed: Feed | null;
    crawler: Crawler | null;
    transport: ReturnType<typeof createSessionTransport> | null;
    offline: boolean;
    lastStatus: string;
  }>("feedRef", {
    feed: null,
    crawler: null,
    transport: null,
    offline: true,
    lastStatus: "",
  });

  const crawlerController = ctx.createWebViewController("shader_feed_crawler_webview");
  const [crawlerRef] = ctx.useState<{ ready: boolean; started: boolean; resultHandlers: Map<string, (id: string, ok: boolean, text: string) => void> }>(
    "crawlerRef",
    { ready: false, started: false, resultHandlers: new Map() },
  );

  function registerCrawlerHost(): void {
    crawlerController.removeJavascriptInterface(HOST_INTERFACE_NAME);
    crawlerController.addJavascriptInterface(HOST_INTERFACE_NAME, {
      fetchResult: (...args: unknown[]) => {
        const id = String(args[0] ?? "");
        const ok = args[1] === true;
        const text = String(args[2] ?? "");
        const handler = crawlerRef.resultHandlers.get(id) || crawlerRef.resultHandlers.get("*");
        if (handler) handler(id, ok, text);
        return true;
      },
    });
  }

  function startLiveCrawler(): void {
    if (crawlerRef.started || !crawlerRef.ready) return;
    crawlerRef.started = true;
    // The bridge callback is fan-out based: request ids are unique and one transport is used.
    const transport = createSessionTransport({
      inject: (script) => { void crawlerController.evaluateJavascript(script); },
      onResult: (callback) => {
        const listener = (id: string, ok: boolean, text: string) => callback(id, ok, text);
        crawlerRef.resultHandlers.set("*", listener);
        return () => crawlerRef.resultHandlers.delete("*");
      },
    }, defaultRecipe());
    feedRef.transport = transport;
    feedRef.crawler = createCrawler(transport, {
      onRecord: async (record) => {
        try {
          const store = ensureStore();
          await store.saveShader(record, isSinglePassRenderable(record));
        } catch (error) {
          hostLog("[ShaderFeed] 保存爬取记录失败: " + toErrorText(error));
        }
      },
    });
    void startFeedOrDemo();
  }

  // 可变标记，不参与渲染：记录「本次页面加载是否已经下发过 demo」。
  // 用 useState 持有的对象当 ref，避免依赖 useRef 的运行时可用性。
  const [flags] = ctx.useState<{ demoSent: boolean; playbackStarted: boolean }>(
    "flags",
    { demoSent: false, playbackStarted: false },
  );

  function sendDemoShader(): void {
    if (flags.demoSent) {
      return;
    }
    flags.demoSent = true;
    const script =
      "__runnerLoad(" +
      JSON.stringify(DEMO_SHADER) +
      ", " +
      JSON.stringify({ timeOffset: DEMO_TIME_OFFSET }) +
      ");";
    Promise.resolve(controller.evaluateJavascript(script)).catch(
      (error: unknown) => {
        setStatusText("下发 demo shader 失败: " + toErrorText(error));
      },
    );
  }

  /**
   * 开始播放。**离线优先**：先看本地缓存（D6 的「拔网后仍能刷」），
   * 缓存为空才退回内置 demo —— 否则从没联网过的设备上会是一片空白。
   */
  function startPlayback(): void {
    if (flags.playbackStarted) {
      return;
    }
    flags.playbackStarted = true;
    void startFeedOrDemo();
  }

  async function startFeedOrDemo(): Promise<void> {
    try {
      const store = ensureStore();
      const cached = createStoreCrawler(store, { limit: 200 });
      const source = feedRef.crawler || cached;
      await source.ensure(8);
      if (source.ahead() === 0 && source !== cached) {
        // 网络不可用时仍然优先提供离线缓存。
        await cached.ensure(8);
      }
      const playable = source.ahead() > 0 ? source : cached;
      if (playable.ahead() === 0) {
        setStatusText(
          "缓存为空，先播内置示例。去「缓存」页点「灌入示例数据」就能离线刷 shader。",
        );
        sendDemoShader();
        return;
      }
      const feed = createFeed(playable, {
        onAdvance: (tick) => {
          if (tick.current) {
            void sendShaderToRunner(tick.current, feed.timeOffsetSeconds());
          }
        },
      });
      feedRef.feed = feed;
      // 这条通路就是离线缓存（实时爬虫还没接上），所以耗尽时的措辞按离线来。
      feedRef.offline = playable === cached;
      feedRef.lastStatus = "";
      const first = feed.start();
      if (first.current) {
        void sendShaderToRunner(first.current, feed.timeOffsetSeconds());
      }
    } catch (error) {
      setStatusText("启动播放失败，退回内置示例: " + toErrorText(error));
      sendDemoShader();
    }
  }

  /**
   * 状态行：把 feed 的内部状态翻译成一句话，并且**只在内容真的变了才 setState**
   *（每秒一次的重渲染在低端机上是白费电）。
   *
   * 必须每次 tick / 每次上滑都调：不调的话，缓冲空了或缓存刷完了，界面就是
   * **静默冻结** —— 用户上滑没反应，也拿不到任何解释。
   */
  function refreshFeedStatus(): void {
    const feed = feedRef.feed;
    if (!feed) {
      return;
    }
    const s = feed.snapshot();
    const next = describeFeedStatus({
      ahead: s.ahead,
      waiting: s.waiting,
      exhausted: s.exhausted,
      paused: s.paused,
      index: s.index,
      offline: feedRef.offline,
    });
    if (next !== feedRef.lastStatus) {
      feedRef.lastStatus = next;
      setStatusText(next);
    }
  }

  /** 页面每秒一次的 stats 上报 = feed 的时钟（宿主里就不需要定时器了）。 */
  function onRunnerReport(text: string): void {
    const feed = feedRef.feed;
    if (!feed) {
      return;
    }
    let stage = "";
    try {
      stage = String((JSON.parse(text) as { stage?: string }).stage || "");
    } catch {
      return;
    }
    if (stage !== "stats") {
      return;
    }
    const tick = feed.tick();
    if (tick.advanced && tick.current) {
      void sendShaderToRunner(tick.current, feed.timeOffsetSeconds());
    }
    refreshFeedStatus();
  }

  /** 页面侧竖滑手势 → 下一条。 */
  function onRunnerSwipe(text: string): void {
    const feed = feedRef.feed;
    if (!feed) {
      return;
    }
    let direction = "";
    try {
      direction = String(
        (JSON.parse(text) as { direction?: string }).direction || "",
      );
    } catch {
      return;
    }
    if (direction !== "up") {
      // feed 没有「上一条」的概念，向下滑先忽略（将来要支持就给它加 back()）。
      return;
    }
    const tick = feed.advance();
    if (tick.advanced && tick.current) {
      void sendShaderToRunner(tick.current, feed.timeOffsetSeconds());
    }
    // 上滑失败（advanced=false，也就是前方真的没有下一条）必须给个说法，
    // 否则用户看到的就是「滑了但没反应」。
    refreshFeedStatus();
  }

  /**
   * 把内置示例写进**真实缓存**，这样完全离线也能刷 feed。
   * id 前缀是 st，与真实数据可区分；「全部清空」能一把清掉。
   */
  async function seedDemoCache(): Promise<void> {
    setCacheBusy(true);
    try {
      const store = ensureStore();
      let saved = 0;
      for (const json of CANNED) {
        const parsed = parseShader(json);
        if (parsed.ok && parsed.record) {
          await store.saveShader(
            parsed.record,
            isSinglePassRenderable(parsed.record),
          );
          saved += 1;
        }
      }
      await refreshCache(
        "已灌入 " +
          saved +
          " 条示例数据（id 前缀 st）。切到「Runner」就能离线刷。",
      );
    } catch (error) {
      setCacheReport("灌入示例失败: " + toErrorText(error));
      setCacheBusy(false);
    }
  }

  function registerHostInterface(): void {
    controller.removeJavascriptInterface(HOST_INTERFACE_NAME);
    const host: ComposeWebViewJavascriptInterface = {
      // deck 脚本就绪后主动回调，此时 __runnerLoad 已经定义好了。
      ready: () => {
        startPlayback();
        return true;
      },
      // 页面上报状态：显示在状态栏 + 打日志；stats 上报同时驱动 feed 的时钟。
      report: (...args: unknown[]) => {
        const value = args.length > 0 ? args[0] : undefined;
        const text = typeof value === "string" ? value : JSON.stringify(value);
        hostLog("[ShaderFeed] " + text);
        setStatusText(text);
        onRunnerReport(text);
        return true;
      },
      // 页面侧识别出的竖滑手势。向上 = 下一条。
      swipe: (...args: unknown[]) => {
        const value = args.length > 0 ? args[0] : undefined;
        const text = typeof value === "string" ? value : JSON.stringify(value);
        hostLog("[ShaderFeed] swipe " + text);
        onRunnerSwipe(text);
        return true;
      },
    };
    controller.addJavascriptInterface(HOST_INTERFACE_NAME, host);
  }

  async function boot(): Promise<void> {
    if (initialized) {
      return;
    }
    setInitialized(true);
    try {
      const released = await releaseRunnerResources();
      if (!released.runner || !released.script || !released.probe) {
        setPageError("webview 资源没有完整装载。");
        setStatusText("资源装载失败");
        return;
      }
      setRunnerPath(released.runner);
      setRunnerScriptPath(released.script);
      setProbePath(released.probe);
      registerHostInterface();
      registerCrawlerHost();
      setResourcesReady(true);
      setStatusText("资源就绪，等待页面握手…");
      // 宿主能力先报一次：传输层的请求超时依赖 setTimeout，
      // 而它到底存不存在是实测问题，不是靠猜的。
      hostLog("[ShaderFeed] host capabilities: " + hostCapabilityLine());
    } catch (error) {
      setPageError("资源装载异常: " + toErrorText(error));
      setStatusText("资源装载异常");
    }
  }

  function pageUrlFor(next: PageTarget): string {
    // crawl 探测页必须停在 shadertoy.com 自己的 origin 上：
    // 只有同源请求才会带上 CF 的 clearance cookie。
    if (next === "crawl") {
      return SHADERTOY_PROBE_URL;
    }
    if (next === "runner") {
      return VIRTUAL_HOST + RUNNER_PAGE.path;
    }
    return VIRTUAL_HOST + PROBE_PAGE.path;
  }

  function pageLabelFor(next: PageTarget): string {
    return PAGE_META[next].label;
  }

  /**
   * P1 契约探测：在站点页面上跑一段脚本，把数据接口实测出来。
   * 这个调用同时回答 spike gate G1 —— `evaluateJavascript` 到底会不会 await 返回的 Promise。
   * （探测脚本自己会通过 ShaderHost.report 把结果送回来，所以不依赖 G1 的结论。）
   */
  function runCrawlProbe(): void {
    setStatusText("已到达 shadertoy.com，正在探测接口契约…");
    Promise.resolve(controller.evaluateJavascript(CRAWL_PROBE_SCRIPT)).then(
      (result: unknown) => {
        hostLog(
          "[ShaderFeed] G1: evaluateJavascript 返回值 = " +
            JSON.stringify(result),
        );
      },
      (error: unknown) => {
        setStatusText("探测脚本执行失败: " + toErrorText(error));
      },
    );
  }

  function ensureStore(): Store {
    if (!cacheRefs.store) {
      cacheRefs.store = createStore(createHostFs(), {
        root: DEFAULT_STORE_ROOT,
        hash: hashTextureUrl,
        onWarn: (message: string) => {
          cacheRefs.warnings.push(message);
          hostLog("[ShaderFeed][store] " + message);
        },
      });
    }
    return cacheRefs.store;
  }

  /**
   * 缓存面板必须给出**真实绝对路径**（用户要靠它去文件管理器里清理），
   * 所以这里同时做一次可写性探测：首次运行时权限/作用域存储问题会直接在这里暴露，
   * 而不是让用户面对一个莫名空白的页面。
   */
  async function refreshCache(note?: string): Promise<void> {
    setCacheBusy(true);
    try {
      const store = ensureStore();
      const probe = await verifyRootWritable(store.root);
      const usage = await store.usage();
      const lines: string[] = [];
      if (note) {
        lines.push(note, "");
      }
      lines.push(
        probe.message,
        "",
        usage.describe,
        "",
        "宿主能力：" + hostCapabilityLine(),
      );
      if (cacheRefs.warnings.length > 0) {
        lines.push("", "警告 " + cacheRefs.warnings.length + " 条：");
        for (const warning of cacheRefs.warnings.slice(-3)) {
          lines.push("· " + warning);
        }
      }
      const text = lines.join("\n");
      setCacheReport(text);
      hostLog("[ShaderFeed] " + text);
    } catch (error) {
      setCacheReport("读取缓存信息失败: " + toErrorText(error));
    } finally {
      setCacheBusy(false);
    }
  }

  async function clearCache(mode: "textures" | "all"): Promise<void> {
    setCacheBusy(true);
    try {
      const store = ensureStore();
      if (mode === "all") {
        await store.clearAll();
      } else {
        await store.clearTextures();
      }
      hostLog("[ShaderFeed] cache cleared: " + mode);
      await refreshCache(mode === "all" ? "已全部清空。" : "已清理纹理缓存。");
    } catch (error) {
      setCacheReport("清理失败: " + toErrorText(error));
      setCacheBusy(false);
    }
  }

  /**
   * 设备自测：用内置假数据把整条流水线跑一遍，**不碰网络**。
   *
   * 存在意义：否则真机上第一次运行会把两件独立的事混在一起判断 ——
   * 「流水线在这台机器上能不能工作」和「Cloudflare 能不能过」。
   * 分开之后，网络那步失败时我们已知流水线本身是好的，能直接定位。
   */
  async function runDeviceSelfTest(): Promise<void> {
    setCacheBusy(true);
    setCacheReport(
      "正在自测…（只写 " +
        DEFAULT_STORE_ROOT +
        "/_selftest，不动你的真实缓存）",
    );
    try {
      const report = await runSelfTest({
        fs: createHostFs(),
        root: DEFAULT_STORE_ROOT,
        hash: hashTextureUrl,
        loadIntoRunner: sendShaderToRunner,
      });
      setCacheReport(report.text);
      hostLog("[ShaderFeed] selftest ok=" + report.ok);
    } catch (error) {
      // 自测承诺自己不招异常；真招了就说明有更严重的问题，如实报出来。
      setCacheReport("自测本身崩了（这不该发生）: " + toErrorText(error));
    } finally {
      setCacheBusy(false);
    }
  }

  /** 把一条记录交给渲染器。 */
  function sendShaderToRunner(
    record: ShaderRecord,
    timeOffsetSeconds: number,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!resourcesReady) {
      return Promise.resolve({ ok: false, error: "webview 资源还没就绪" });
    }
    const script =
      "__runnerLoad(" +
      JSON.stringify(record) +
      ", " +
      JSON.stringify({ timeOffset: timeOffsetSeconds }) +
      ");";
    return Promise.resolve(controller.evaluateJavascript(script)).then(
      (result: unknown) => {
        // G1 还没定论（evaluateJavascript 不保证 await Promise），所以不依赖返回内容，
        // 只要不抛就认为下发成功；真正的成败由页面通过 ShaderHost.report 回执。
        hostLog("[ShaderFeed] __runnerLoad 下发: " + JSON.stringify(result));
        return { ok: true };
      },
      (error: unknown) => ({ ok: false, error: toErrorText(error) }),
    );
  }

  function switchTo(next: PageTarget): void {
    // 缓存页不需要 webview 资源，所以它不必等 resourcesReady。
    if (next === target || (next !== "cache" && !resourcesReady)) {
      return;
    }
    // 换页会重新加载页面并重新触发握手，所以重置标记。
    flags.demoSent = false;
    setPageError("");
    setTarget(next);
    setStatusText(PAGE_META[next].loading);
    if (next === "cache" && !cacheReport) {
      void refreshCache();
    }
  }

  function handleResourceRequest(
    request: ComposeWebViewResourceRequest,
  ): ComposeWebViewResourceDecision {
    // 拦截逻辑与聊天内渲染共用一份实现（src/ui/shared/runner-resources.ts），
    // 否则两处各写一份，改一处忘另一处的表现会是「某个界面白屏」。
    return makeResourceHandler({
      runner: runnerPath,
      script: runnerScriptPath,
      probe: probePath,
    })(request);
  }

  function handleNavigation(
    request: ComposeWebViewNavigationRequest,
  ): ComposeWebViewNavigationDecision {
    if (resolvePathname(request.url) !== null) {
      return { action: "allow" };
    }
    // 契约探测必须在 shadertoy.com 的 origin 里跑（同源才能带 cf_clearance），
    // 所以这个域不能丢给系统浏览器。
    if (request.url.startsWith(SHADERTOY_ORIGIN)) {
      return { action: "allow" };
    }
    // 其余外链交给系统浏览器，别把侧边栏导航走丢。
    return { action: "external", url: request.url };
  }

  const toolbar = UI.Row(
    {
      fillMaxWidth: true,
      spacing: 8,
      padding: { horizontal: 12, vertical: 8 },
      verticalAlignment: "center",
    },
    [
      UI.Button({
        text: "Runner",
        enabled: resourcesReady && target !== "runner",
        onClick: () => switchTo("runner"),
      }),
      UI.Button({
        text: "Probe",
        enabled: resourcesReady && target !== "probe",
        onClick: () => switchTo("probe"),
      }),
      UI.Button({
        text: "契约探测",
        enabled: resourcesReady && target !== "crawl",
        onClick: () => switchTo("crawl"),
      }),
      UI.Button({
        text: "缓存",
        enabled: target !== "cache",
        onClick: () => switchTo("cache"),
      }),
      UI.Text({
        text: pageLabelFor(target),
        style: "labelMedium",
        color: colors.onSurfaceVariant,
        maxLines: 1,
        overflow: "ellipsis",
      }),
    ],
  );

  const statusBar = UI.Text({
    text: statusText,
    style: "bodySmall",
    color: pageError ? colors.error : colors.onSurfaceVariant,
    maxLines: 4,
    overflow: "ellipsis",
    padding: { horizontal: 12, vertical: 6 },
  });

  /**
   * WebView 节点的**唯一构造处**。
   * 缓存页也要挂一个常驻的 runner（自测要驱动渲染器），所以不能在两处各写一份 props ——
   * 那两处迟早会漂移。
   */
  function renderWebView(
    url: string,
    keySuffix: string,
    purpose: PageTarget,
  ): ComposeNode {
    return UI.WebView({
      key: "shader_feed_webview_" + keySuffix,
      controller,
      url,
      fillMaxSize: true,
      weight: 1,
      nestedScrollInterop: true,
      javaScriptEnabled: true,
      domStorageEnabled: true,
      supportZoom: false,
      useWideViewPort: true,
      loadWithOverviewMode: true,
      onShouldOverrideUrlLoading: handleNavigation,
      onInterceptRequest: handleResourceRequest,
      onPageFinished: (event: unknown) => {
        if (purpose !== "crawl") {
          return;
        }
        // CF 挑战页也会触发这里；脚本自己会辨认并只上报不动作，
        // 所以这里不必去猜「这次到底是不是真页面」。
        hostLog("[ShaderFeed] page finished: " + JSON.stringify(event));
        runCrawlProbe();
      },
      onReceivedError: (event: unknown) => {
        setStatusText("页面错误: " + JSON.stringify(event));
      },
    });
  }

  const waitingBox = UI.Box(
    {
      fillMaxSize: true,
      contentAlignment: "center",
      padding: 24,
    },
    UI.Text({
      text: pageError || "正在装载 webview 资源…",
      style: "bodyMedium",
      color: pageError ? colors.error : colors.onSurfaceVariant,
    }),
  );

  const webViewOrWaiting = resourcesReady
    ? renderWebView(pageUrlFor(target), target, target)
    : waitingBox;

  // 缓存页：占用信息 + 操作按钮 + **常驻的 runner**。
  // runner 必须留在页面里，否则自测没法驱动渲染器（自测要验证 __runnerLoad 真的回执）。
  // 共用同一个 key，所以从缓存页切回 Runner 不会重新加载页面、也不会重跑一次握手。
  const cacheBody = UI.Column({ fillMaxSize: true, padding: 12, spacing: 8 }, [
    UI.Text({
      text: cacheReport || "点「刷新」读取缓存占用。",
      style: "bodySmall",
      color: pageError ? colors.error : colors.onSurfaceVariant,
    }),
    // 五个按钮挤一行在窄屏侧边栏会溢出，所以拆成两行。
    UI.Row({ fillMaxWidth: true, spacing: 8 }, [
      UI.Button({
        text: cacheBusy ? "处理中…" : "刷新",
        enabled: !cacheBusy,
        onClick: () => {
          void refreshCache();
        },
      }),
      UI.Button({
        text: "灌入示例",
        enabled: !cacheBusy,
        onClick: () => {
          void seedDemoCache();
        },
      }),
      UI.Button({
        text: "运行自测",
        enabled: !cacheBusy && resourcesReady,
        onClick: () => {
          void runDeviceSelfTest();
        },
      }),
    ]),
    UI.Row({ fillMaxWidth: true, spacing: 8 }, [
      UI.Button({
        text: "清理纹理",
        enabled: !cacheBusy,
        onClick: () => {
          void clearCache("textures");
        },
      }),
      UI.Button({
        text: "全部清空",
        enabled: !cacheBusy,
        onClick: () => {
          void clearCache("all");
        },
      }),
    ]),
    resourcesReady
      ? renderWebView(pageUrlFor("runner"), "runner", "runner")
      : waitingBox,
  ]);

  const body: ComposeNode = target === "cache" ? cacheBody : webViewOrWaiting;

  const crawlerWebView = UI.WebView({
    key: "shader_feed_crawler_webview",
    controller: crawlerController,
    url: SHADERTOY_PROBE_URL,
    height: 1,
    fillMaxWidth: true,
    javaScriptEnabled: true,
    domStorageEnabled: true,
    supportZoom: false,
    onPageFinished: () => {
      // Cloudflare also reports page-finished for the challenge document. Wait for
      // the real page before creating the transport; otherwise every request is
      // sent to the challenge HTML and the crawler burns through retries.
      Promise.resolve(crawlerController.evaluateJavascript("document.title"))
        .then((title) => {
          const value = String(title ?? "").toLowerCase();
          if (value.indexOf("just a moment") >= 0 || value.indexOf("attention required") >= 0) {
            return;
          }
          crawlerRef.ready = true;
          startLiveCrawler();
        })
        .catch(() => undefined);
    },
    onReceivedError: (event: unknown) => {
      hostLog("[ShaderFeed] crawler page error: " + JSON.stringify(event));
    },
  });

  return UI.Column(
    {
      fillMaxSize: true,
      backgroundColor: colors.surface,
      onLoad: boot,
    },
    [toolbar, statusBar, crawlerWebView, body],
  );
}
