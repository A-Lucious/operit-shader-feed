/**
 * 手写的 Operit ToolPkg API 最小声明子集 —— 只覆盖 P0 侧边栏外壳实际用到的符号。
 *
 * 为什么不直接引用 Operit 的 `examples/types/*.d.ts`：
 * Operit 本体是 LGPL-3.0，本仓库是 MIT。把它的类型文件抄进本仓库会造成许可证混合。
 * 需要完整声明时，去 Operit 仓库的 `examples/types/` 查阅对照，不要复制过来。
 *
 * 本文件不含任何 import/export，因此是全局长声明，项目内所有 .ts 可直接使用这些名字。
 */

type LocalizedText = string | { [lang: string]: string };

// ------------------------------------------------------------ ToolPkg 注册

interface ToolPkgUiRouteRegistration {
 id: string;
 route: string;
 runtime: "compose_dsl";
 screen: ComposeDslScreen;
 params?: Record<string, unknown>;
 title?: LocalizedText;
 keepAlive?: boolean;
}

interface ToolPkgNavigationEntryRegistration {
 id: string;
 route: string;
 surface: "toolbox" | "main_sidebar_plugins";
 title?: LocalizedText;
 icon?: string;
 order?: number;
}

/**
 * 跨运行时上下文类型。官方 `examples/types/toolpkg.d.ts` 里字面量就是这四个。
 *   main    = manifest.main 指向的包级入口
 *   ui      = compose_dsl 界面（每个 UI 实例各有自己的 JS engine）
 *   sandbox = 独立/子包工具脚本
 *   provider= 自定义 AI provider
 */
type ToolPkgRuntimeKind = "main" | "ui" | "sandbox" | "provider";

interface ToolPkgIpcMeta {
 channel: string;
 callerContextKey?: string;
 currentContextKey?: string;
 currentRuntime?: ToolPkgRuntimeKind;
 packageTarget?: string;
}

interface ToolPkgIpcCallOptions {
 targetRuntime?: ToolPkgRuntimeKind;
 targetContextKey?: string;
}

/**
 * `ToolPkg.ipc` —— 官方跨运行时通道（TOOLPKG_FORMAT_GUIDE.md「跨上下文共享状态」）。
 *
 * 语义（原文要点）：
 *   - `on` 在当前上下文注册处理函数；`call` 在**非 main 上下文默认发给本包的 main**
 *   - 指定 `ui`/`provider`/`sandbox` 目标时**必须**给 `targetContextKey`，否则直接报错
 *   - payload 与返回值必须是 JSON 可序列化数据，按值复制、不保留引用
 */
interface ToolPkgIpcApi {
 on<TPayload = unknown, TResult = unknown>(
  channel: string,
  handler: (
   payload: TPayload,
   meta: ToolPkgIpcMeta,
  ) => TResult | Promise<TResult>,
 ): () => void;
 off<TPayload = unknown, TResult = unknown>(
  channel: string,
  handler?: (
   payload: TPayload,
   meta: ToolPkgIpcMeta,
  ) => TResult | Promise<TResult>,
 ): boolean;
 call<TPayload = unknown, TResult = unknown>(
  channel: string,
  payload?: TPayload,
  options?: ToolPkgIpcCallOptions,
 ): Promise<TResult>;
}

interface ToolPkgApi {
 registerUiRoute(definition: ToolPkgUiRouteRegistration): void;
 registerNavigationEntry(definition: ToolPkgNavigationEntryRegistration): void;
 registerXmlRenderPlugin(definition: ToolPkgXmlRenderRegistration): void;
 registerSystemPromptComposeHook(
  definition: ToolPkgSystemPromptComposeRegistration,
 ): void;
 /**
  * 把 manifest.resources 里声明的资源释放到宿主临时目录，返回**落盘后的绝对路径**。
  * 注意：返回的是路径字符串，不是文件内容。
  */
 readResource(
  key: string,
  outputFileName?: string,
  internal?: boolean,
 ): Promise<string>;
 ipc: ToolPkgIpcApi;
}

// --------------------------------------------------------------- XML 渲染钩子
//
// 机制：AI 在聊天回复里写出自定义 XML 标签 → 我们注册的钩子把它换成一块活着的界面。
// 形状来自官方示例 `examples/plan_mode/src/plugin/plantodo-xml-render-plugin.ts`，
// 以及 `examples/types/toolpkg.d.ts` 里的 XmlRenderPluginRegistration / XmlRenderHookObjectResult。

interface ToolPkgXmlRenderPayload {
 /** 标签内部的原文。实体可能已被宿主解码也可能没有，所以两种都处理。 */
 xmlContent?: string;
 tagName?: string;
}

interface ToolPkgXmlRenderEvent {
 eventPayload: ToolPkgXmlRenderPayload;
}

interface ToolPkgXmlRenderDsl {
 screen: ComposeDslScreen;
 /**
  * 下发给 screen 的初始状态。screen 里用 `ctx.useState(key, "")` 就能读到同名的值
  * （见官方示例 `examples/plan_mode/src/ui/plantodo/index.ui.ts` 的 `ctx.useState("xmlContent", "")`）。
  */
 state?: Record<string, unknown>;
 memo?: Record<string, unknown>;
 moduleSpec?: Record<string, unknown>;
}

interface ToolPkgXmlRenderResult {
 handled?: boolean;
 /**
  * 直接换成纯文本。用于「这块渲染不了，原因是…」这类**要让 AI 也能在对话里看到**的情况 ——
  * 只渲染一个错误界面的话，AI 是看不到自己错在哪的。
  */
 text?: string;
 content?: string;
 composeDsl?: ToolPkgXmlRenderDsl;
}

type ToolPkgXmlRenderReturn =
 | ToolPkgXmlRenderResult
 | string
 | null
 | undefined
 | Promise<ToolPkgXmlRenderResult | string | null | undefined>;

interface ToolPkgXmlRenderRegistration {
 id: string;
 tag: string;
 function: (event: ToolPkgXmlRenderEvent) => ToolPkgXmlRenderReturn;
}

// ----------------------------------------------------------- 系统提示组合钩子
//
// 形状来自官方示例 `examples/thinking_guidance/src/main.ts`：
//   1. 只处理 `after_compose_system_prompt` 阶段，其它阶段返回 null
//   2. 返回的是**整段新提示**（拿现有 systemPrompt 拼上自己的内容），不是增量
//
// 代价提醒：写进去的东西会出现在**每一次请求**的系统提示里，所以越短越好。

interface ToolPkgPromptHookPayload {
 systemPrompt?: string;
 useEnglish?: boolean;
}

interface ToolPkgPromptHookEvent {
 /** 阶段名。示例里用 `event.eventName || event.event` 取，两种都出现过。 */
 eventName?: string;
 event?: string;
 eventPayload?: ToolPkgPromptHookPayload;
}

interface ToolPkgSystemPromptComposeResult {
 systemPrompt?: string;
}

interface ToolPkgSystemPromptComposeRegistration {
 id: string;
 function: (
  event: ToolPkgPromptHookEvent,
 ) => ToolPkgSystemPromptComposeResult | null | undefined;
}

declare const ToolPkg: ToolPkgApi;

/** Material 图标注册表；按名字取图标。 */
declare const Icons: { [name: string]: string };

/**
 * 宿主确实提供 `console`，但这里**故意不声明全局 `console`**：
 * 一旦编译时引入了 lib.dom（或任何声明了 `console` 的 lib），重声明会直接报 TS2451。
 * 需要打日志时，在具体 .ts 里用 globalThis 取值。
 *
 * 注：本文件是纯声明文件，不得包含任何函数实现。
 */

// ------------------------------------------------------------ Compose DSL

interface ComposeNode {
 type: string;
 props?: Record<string, unknown>;
 children?: ComposeNode[];
}

type ComposeChildren = ComposeNode | ComposeNode[] | null | undefined;

type ComposeNodeFactory<TProps = Record<string, unknown>> = (
 props?: TProps,
 children?: ComposeChildren,
) => ComposeNode;

/**
 * WebView 的 props。**字段名照官方 `examples/types/compose-dsl.d.ts` 的 WebViewProps**，
 * 而不是用默认的宽松 Record —— 具名 props 的代价是几行声明，收益是**写错 props 名会直接编译不过**。
 *
 * 这不是洁癖：真机实测过一次 `Tools.Files.read(path, env)` 因声明太宽而一路编过，
 * 到了手机上才发现环境参数被静默丢弃。属性名同理 —— 写错就是「页面白屏」而没有任何报错。
 */
interface ComposeWebViewProps {
 key?: string;
 controller?: ComposeWebViewController;
 url?: string;
 /** 直接给 HTML 字符串（本插件就是走这条：自包含 HTML，不碰网络/文件系统）。 */
 html?: string;
 baseUrl?: string;
 mimeType?: string;
 encoding?: string;
 javaScriptEnabled?: boolean;
 domStorageEnabled?: boolean;
 supportZoom?: boolean;
 useWideViewPort?: boolean;
 loadWithOverviewMode?: boolean;
 nestedScrollInterop?: boolean;
 height?: number;
 fillMaxWidth?: boolean;
 fillMaxSize?: boolean;
 onPageFinished?: (event: unknown) => void | Promise<void>;
 onReceivedError?: (event: unknown) => void | Promise<void>;
 onConsoleMessage?: (event: unknown) => void | Promise<void>;
}

/**
 * 各组件的 props 类型在两个官方示例里是逐字段精确声明的。
 * 这里故意放宽成 Record<string, unknown>：P0 只依赖少数几个字段，
 * 复刻全部 props 类型既没必要也会引入维护负担。
 */
interface ComposeUiFactories {
 Box: ComposeNodeFactory;
 Column: ComposeNodeFactory;
 Row: ComposeNodeFactory;
 Spacer: ComposeNodeFactory;
 Text: ComposeNodeFactory;
 Button: ComposeNodeFactory;
 IconButton: ComposeNodeFactory;
 Card: ComposeNodeFactory;
 Surface: ComposeNodeFactory;
 Icon: ComposeNodeFactory;
 WebView: ComposeNodeFactory<ComposeWebViewProps>;
}

interface ComposeColorToken {
 __colorToken: string;
 alpha?: number;
 copy(options: { alpha: number }): ComposeColorToken;
}

type ComposeColor = string | ComposeColorToken;

interface ComposeMaterialTheme {
 colorScheme: { [token: string]: ComposeColorToken };
}

type ComposeWebViewJavascriptInterfaceMethod = (
 ...args: unknown[]
) => unknown | Promise<unknown>;

type ComposeWebViewJavascriptInterface = Record<
 string,
 ComposeWebViewJavascriptInterfaceMethod
>;

interface ComposeWebViewLoadHtmlOptions {
 baseUrl?: string;
 mimeType?: string;
 encoding?: string;
}

interface ComposeWebViewController {
 readonly key: string;
 loadUrl(url: string, headers?: Record<string, string>): void;
 loadHtml(html: string, options?: ComposeWebViewLoadHtmlOptions): void;
 reload(): void;
 stopLoading(): void;
 goBack(): void;
 goForward(): void;
 clearHistory(): void;
 evaluateJavascript<TResult = unknown>(
  script: string,
 ): Promise<TResult | null | undefined>;
 addJavascriptInterface(
  name: string,
  object: ComposeWebViewJavascriptInterface,
 ): void;
 removeJavascriptInterface(name: string): void;
}

interface ComposeWebViewResourceRequest {
 url: string;
 method?: string | null;
 headers?: Record<string, string>;
 isMainFrame?: boolean;
 hasGesture?: boolean;
 isRedirect?: boolean;
 scheme?: string | null;
}

interface ComposeWebViewResourceResponse {
 mimeType?: string;
 encoding?: string;
 statusCode?: number;
 reasonPhrase?: string;
 headers?: Record<string, string>;
 filePath: string;
 text?: never;
 base64?: never;
}

type ComposeWebViewResourceDecision =
 | { action: "allow" }
 | { action: "block" }
 | { action: "rewrite"; url: string; headers?: Record<string, string> }
 | { action: "respond"; response: ComposeWebViewResourceResponse };

interface ComposeWebViewNavigationRequest {
 url: string;
 isMainFrame?: boolean;
 hasGesture?: boolean;
 scheme?: string | null;
}

type ComposeWebViewNavigationDecision =
 | { action: "allow" }
 | { action: "cancel" }
 | { action: "rewrite"; url: string; headers?: Record<string, string> }
 | { action: "external"; url?: string };

interface ComposeDslContext {
 readonly UI: ComposeUiFactories;
 MaterialTheme: ComposeMaterialTheme;
 useState<T>(key: string, initialValue: T): [T, (value: T) => void];
 createWebViewController(key: string): ComposeWebViewController;
 showToast(message: string): Promise<void> | void;
}

type ComposeDslScreen = (
 ctx: ComposeDslContext,
) => ComposeNode | Promise<ComposeNode>;

// ------------------------------------------------------- Tools.Files（P2 存储层）
//
// 同样只声明实际用到的部分。完整签名见 Operit 仓库的
// docs/doc-src/package-dev/files.md 与 examples/types/files.d.ts（不要在本地复制）。

type FileEnvironment = "android" | "linux";

interface FileEntryInfo {
 name: string;
 isDirectory: boolean;
 size: number;
}

interface DirectoryListingData {
 path: string;
 entries: FileEntryInfo[];
}

interface FileContentData {
 path: string;
 content: string;
 size: number;
}

interface BinaryFileContentData {
 path: string;
 /** Base64 编码的内容 */
 contentBase64: string;
 size: number;
}

interface FileExistsData {
 path: string;
 exists: boolean;
 isDirectory?: boolean;
 size?: number;
}

interface FileInfoData {
 path: string;
 exists: boolean;
 /** "file" | "directory" | "other" */
 fileType: string;
 size: number;
 lastModified: string;
}

interface ToolsFilesApi {
 list(
  path: string,
  environment?: FileEnvironment,
 ): Promise<DirectoryListingData>;
 /**
  * 读文本。不存在会抛（调用方负责映射成 null）。
  * 官方只有这个**单参**重载。
  */
 read(path: string): Promise<FileContentData>;
 /**
  * 需要指定执行环境时必须用 options 形式 —— 官方**没有** (path, env) 这种重载。
  * 写成 read(path, env) 能通过类型检查（如果声明写错了的话），但环境参数会被静默丢弃。
  */
 read(options: {
  path: string;
  environment?: FileEnvironment;
  intent?: string;
  direct_image?: boolean;
 }): Promise<FileContentData>;
 readBinary(
  path: string,
  environment?: FileEnvironment,
 ): Promise<BinaryFileContentData>;
 write(
  path: string,
  content: string,
  append?: boolean,
  environment?: FileEnvironment,
 ): Promise<unknown>;
 writeBinary(
  path: string,
  base64Content: string,
  environment?: FileEnvironment,
 ): Promise<unknown>;
 exists(path: string, environment?: FileEnvironment): Promise<FileExistsData>;
 info(path: string, environment?: FileEnvironment): Promise<FileInfoData>;
 mkdir(
  path: string,
  createParents?: boolean,
  environment?: FileEnvironment,
 ): Promise<unknown>;
 deleteFile(
  path: string,
  recursive?: boolean,
  environment?: FileEnvironment,
 ): Promise<unknown>;
 move(
  source: string,
  destination: string,
  environment?: FileEnvironment,
 ): Promise<unknown>;
}

interface ToolsApi {
 Files: ToolsFilesApi;
}

declare const Tools: ToolsApi;

// ------------------------------------------------------------------ CryptoJS
//
// 宿主桥接的 CryptoJS **只暴露 MD5**（见 docs/doc-src/package-dev/cryptojs.md）。
// 我们只拿它当纹理解缓存键（128 位，非安全用途），
// 所以这里不要误以为有 sha256 可用 —— 真写 sha256 会直接报错。

declare const CryptoJS: {
 MD5(message: string): { toString(encoding?: string): string };
};

// ---------------------------------------------------------------- 宿主定时器
//
// **刻意声明成可选**：宿主（QuickJS 沙箱）到底有没有定时器还没实测确认。
// 声明成可选的好处是类型系统会**强制**你写运行时守卫 —— 传输层的请求超时、
// 以及将来任何依赖定时器的地方，都必须能容忍它不存在。
//
// 对比：页面（WebView）里的 setTimeout 与这里无关，那个一定有（runner.js 自己在用）。

type HostTimerHandle = number;
type HostTimer = (handler: () => void, timeoutMs: number) => HostTimerHandle;

declare const setTimeout: HostTimer | undefined;
declare const clearTimeout: ((handle: HostTimerHandle) => void) | undefined;
declare const setInterval: HostTimer | undefined;
declare const clearInterval: ((handle: HostTimerHandle) => void) | undefined;
