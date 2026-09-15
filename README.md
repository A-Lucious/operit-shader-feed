# 聊天 Shader 渲染

Operit ToolPkg：**在聊天里实时渲染 shader**。

AI 在回复里写出 `<shader>…</shader>`（中间放 Shadertoy 风格的 GLSL），聊天里就出现一块
**持续的活画面** —— 不是截图，它一直在动。配套一个工具 `shader_last_compile_result`，
让 AI 能读回 GLSL 编译器的报错原文，把代码改到编译通过。

```
AI 写 <shader> → xml_render 钩子把它换成一块 WebView → deck 编译并每帧渲染
编译失败时：渲染框 → ToolPkg.ipc → main 里的账本 → AI 调工具读走报错原文 → 自己改
```

## 装到手机上

产物：`release/com.shaderfeed.operit-<version>.toolpkg`（由 `node tools/check.mjs` 打包）

1. 在 Operit 里打开这个 `.toolpkg` 安装
2. **启用这个包**（`enabled_by_default` 是 false，要手动打开）
3. 在聊天里跟 AI 说：**「写一个旋转的彩色方块 shader」**

成不成一眼就能看出来：聊天里那块框会动起来（约 1 秒内）。若不动，框里的状态条会告诉你停在哪一步：

| 状态条显示 | 含义 |
|---|---|
| `渲染器就绪，等待页面握手…` | WebView 的页面还没跑起来（自包含 HTML 没加载） |
| `渲染中 · GLSL1/3` | 正常 |
| `编译失败：<编译器原文>` | shader 写错了（AI 会通过工具读到同样这段原文） |
| `页面错误: {…}` | WebView 层面报错（含 errorCode） |
| `页面 error: <消息>` | 页面里 JS 报错（deck 崩了） |

## 为什么只剩聊天渲染

这个包最初是一个完整的侧边栏「shader 信息流」：爬取 Shadertoy、缓存到本地、30 秒自动上滑、
外加硬件实测页与契约探测页。**真机上它整体失败了，失败点只有一个**：

```
net::ERR_CONNECTION_CLOSED   https://shaderfeed.local/runner.html
```

原设计靠「虚拟域 + `onInterceptRequest` 资源拦截」把页面喂给 WebView（`ToolPkg.readResource()`
只给落盘路径、不给内容，所以只能这么绕）。真机上拦截**没有生效**，WebView 跑去真网络上找
`shaderfeed.local`，于是页面、JS bridge 握手、编译回执、缓存全链路一起断掉。

更糟的是：**离线测试全绿**。因为测试用 `file://` 加载页面（相对引用 `runner.js` 在同一个目录里
就能解析），而那和真机走的根本是两条路 —— 测试给了虚假信心。

于是做了两件事：

1. **把渲染页面变成一个自包含 HTML 字符串**：deck 在编译期内联进 HTML（`tools/embed-runner.mjs`），
   运行时**不碰网络、不碰文件系统、不碰资源拦截**。这一整类失败模式就此消失。
2. **砍掉除聊天渲染以外的全部功能**：侧边栏、爬取、缓存、播放、纹理、自测页全部删除。
   一个只有一条路径、且那条路径已经被离线断言钉死的包，比一个功能很多但主路径依赖未验证机制的包更值。

## 验证状态（诚实版）

- **离线可验证的**：`node tools/check.mjs` → 222 项断言 / 6 套全绿。其中 62 项在真实
  headless Chromium 里跑 deck 与宿主握手（含像素断言）；17 项专门钉住「自包含 HTML」这条新路径
  （无外链、deck 真在里面、bridge 名字三处一致）
- **与 Operit 官方契约核对过的**：入口注册、`compose_dsl` 界面入口、`WebView` 的 props、
  `xml_render` 钩子与 prompt 钩子形状、`ToolPkg.ipc` 语义、subpackage 的 `METADATA` 块 ——
  对着官方源码与示例逐项比过，不是猜的
- **只能在真机验证的**：自包含 HTML 能否在 Android WebView 里正常加载与渲染（`html` 属性 /
  `loadHtml` 这条路）、`ToolPkg.ipc` 的跨运行时投递、实际帧率

## 开发

```bash
npx tsc                 # 编译到 dist/
node tools/embed-runner.mjs   # 从 runner.html + shader-deck.js 生成 src/deck/embedded.ts
node tools/check.mjs    # 唯一验证入口：生成 → tsc → 全部套件 → 打包 → 包内逐字节比对
```

`node tools/check.mjs` 是唯一入口，别手工拼步骤。它按顺序做五件事，**任何一步失败就中止**：
生成自包含 HTML → tsc → 全部测试套件 → 打包 → 解包逐字节比对工作区。

（这个顺序有来历：曾经出现过「tsc 失败 → 测试跑的是旧 dist → 包也用旧 dist 打出来」的假绿，
所以「tsc 失败就绝不继续」是硬规则。）

### 目录

```
src/deck/shader-deck.js      Shadertoy 兼容层（GLSL1/GLSL3 前导、Common 拼接、通道绑定、每帧步进）
src/deck/embedded.ts         自动生成：自包含 HTML（勿手改）
src/plugin/chat-xml-render.ts  <shader> 钩子：解析标签、结构预检、返回 composeDsl 界面
src/plugin/compile-ledger.ts   编译结果账本（三态：idle / pending / settled）
src/plugin/compile-ipc.ts      线格式与两端：界面编码 / main 解码
src/plugin/compile-tool.ts     工具侧逻辑：读不到时怎么说话（**永不抛异常**）
src/plugin/system-prompt.ts    告诉 AI 这个标签存在、写完要回来读编译结果
src/packages/shader-compile.ts 子包脚本：METADATA 块 + 一行 ipc 调用
src/ui/chat/index.ui.ts        聊天里那块 WebView（自包含 HTML + bridge）
src/main.ts                    只做注册
tools/embed-runner.mjs         生成自包含 HTML
tools/check.mjs                唯一验证门禁
tools/build-toolpkg.mjs        打包（显式白名单，不用排除法）
```

### 几条不该被"顺手优化"掉的设计

- **渲染页面必须保持自包含**。加一行 `<script src=...>` 或 `<link href=...>` 就等于把
  真机上那个 `ERR_CONNECTION_CLOSED` 请回来。生成器与测试都会拦，但别去试。
- **`compile-ledger` 必须是三态**。编译是异步的，AI 写完 shader 会立刻来读；只留"最近一次结果"
  的话它读到的是**上一次**的报错，会去改一段自己已经改过的地方。
- **每秒一次的性能上报不许进账本**（否则序号每秒 +1，AI 会读到「第 137 次编译」这种鬼话）。
- **工具永不抛异常**。抛了 AI 只看到一段堆栈，而不是"现在该怎么办"，它就修不下去了。
- **`HOST_INTERFACE_NAME` 与 deck 里 `window.ShaderHost` 必须一字不差**。写错的表现是
  「永远停在等待握手」，而那只在真机暴露 —— 所以有一条断言拉着它们。
- **代码长度放 ref，不读 state**。`report` 处理器只注册一次，读 state 会捕获注册那一刻的空串，
  AI 拿到的长度永远是 0。
- **`ToolPkg.ipc.on` 放在 `registerToolPkg()` 里**，不放模块顶层：顶层注册失败会让整个包加载不了。

### 与宿主契约的核对（装包前已逐项对过官方源码）

入口类错误有个恶心的性质：**宿主不报错，只是什么都不显示**。所以下面每条都对着官方示例与
Kotlin 实现核对过：

| 契约 | 核对结论 |
|---|---|
| 入口函数 | `export function registerToolPkg()`；tsc 的 CJS 产物是 `exports.registerToolPkg = …`，**在文件开头**（`tail` 看不到，别因此以为没导出） |
| XML 渲染结果 | `{ handled, composeDsl: { screen, state, memo } }`；`screen` 必须是**模块函数**（宿主会贴 `__operit_toolpkg_module_path` 标记，传字符串路径会直接抛错） |
| `UI.WebView` 的 props | `html` / `baseUrl` / `controller` / `onReceivedError` / `onConsoleMessage` 都存在（`src/types/operit.d.ts` 里按官方字段名声明，写错会编译不过） |
| prompt 钩子 | 返回 `{ systemPrompt }`，阶段名 `after_compose_system_prompt`，与 `examples/thinking_guidance` 同形 |
| `ToolPkg.ipc` | ui → main 是**默认目标**、不需要 `targetContextKey`；sandbox 工具同样能 call 到 main |
| 子包 tools | manifest 的 `subpackages[]` + 脚本头部 `/* METADATA {...} */`。METADATA 是**注释**，tsconfig 一旦开 `removeComments` 就会消失（打包脚本会拦） |
| 宿主定时器 | **有** `setTimeout`/`setInterval`（`quickjs-runtime.d.ts`）—— 本包不依赖它们，时钟走页面驱动 |

## 发布流程（路线 B：仓库 + GitHub Release 资产）

**市场登记必须在 Operit 应用里做** —— 服务端会核对「Release 创建者 == 当前登录的 GitHub 账号」，
那一步没法脚本化；其余已固定成下面这套：

1. `node tools/check.mjs`（唯一验证入口）
2. 改 `manifest.json` 里的 `version`，提交
3. `gh release create v<version> release/com.shaderfeed.operit-<version>.toolpkg --title … --notes-file …`
4. 在 Operit 发布页：选**与 Release 资产完全相同**的文件 → 「发布资源来源」选「引用 GitHub Release 资产」
   → 填仓库链接、选 Release 与资产名 → 填市场元数据 → 登记

两条容易踩的：市场版本号取自包内 manifest，发布页**不允许手改**；Release 正文只放自己的发布说明
（官方明确不要求加 Operit 标记 / proof / 签名文本）。

## 合规

- 本仓库**不含任何第三方 shader 源码**：deck 是 Shadertoy **格式**的兼容层，不是内容
- 本包不再抓取任何站点，也不再缓存第三方内容（抓取与缓存已随侧边栏功能一并移除）
- 与 Shadertoy 官方无关联，不使用其标识，不暗示任何背书

## 许可

[MIT](LICENSE)，仅覆盖本仓库的插件代码。
