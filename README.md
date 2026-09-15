# Shader 流 (Shader Feed)

Operit 侧边栏插件：把 [Shadertoy](https://www.shadertoy.com/) 上别人写的 shader
变成**像抖音一样上下滑的 30 秒实时渲染流**。

- **运行期完全在安卓**，不依赖任何外部服务器
- 用**插件自己的 WebView** 当浏览器与渲染器 —— 不需要在设备上装 Python、Playwright 或 Chromium
- 运行期从 Shadertoy 抓取内容，**仓库里不存一行 shader 源码**

---

## 当前状态

明确的进度，不含含糊：

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0** | Shadertoy 兼容层（deck）+ runner 页面 + 侧边栏外壳 | ✅ 代码完成，本地 62 项浏览器断言通过（含播放回路 soak） |
| **P1** | 数据获取：契约探测页 + 容错解析 + 爬取队列 + 传输层 | ✅ 代码完成（122 项断言）；**请求配方待实机确认** |
| **P2** | 存储：索引 + 正文分文件 + 纹理去重 + 配额 + 清理入口 | ✅ 代码完成（80 项断言） |
| **P3** | 播放：30 秒自动上滑 + 缓冲补货 + 手势换片 + 离线数据源 | ✅ 代码完成（88 项断言） |
| **P4** | 预热模型（α 单 context / β 三 WebView 常驻） | ⏳ **依赖实机 WebGL context 上限数据** |
| **P5** | 聊天内实时渲染（`xml_render` 插件 + 让 AI 知道标签存在的 prompt 钩子） | ✅ 代码完成 |
| **P6** | 自由创意模式（结构性预检查） | ⚠️ **部分可实现**，见下方「已知限制」 |
| **P7** | 发布（市场条目 + Release 资产） | ⏳ 仓库脚手架就绪，待推 GitHub |

**已知边界**：feed 目前**只从本地缓存播放**。实时爬虫已实现但尚未接进 feed ——
接线要在实机拿到请求配方之后做（那一步同时依赖 Cloudflare 能否在侧边栏通过）。

---

## 装到手机上

产物：`release/com.shaderfeed.operit-<version>.toolpkg`（由 `node tools/build-toolpkg.mjs` 生成）

装好后侧边栏出现「**Shader 流**」。进去有 4 个标签，以下 7 下点击能把我需要的
全部实机数据拿回来（结果都是屏幕上**可选中复制**的文本）：

| # | 操作 | 耗时 | 能确认什么 |
|---|---|---|---|
| 1 | 「Probe」自动跑 | 立即 | **G3** 真机同时可存的 WebGL context 上限 → 决定 P4 走 α 还是 β |
| 2 | 「Probe」→「开始 G4」 | 3 分 15 秒 | 0.5 / 0.75 / 1.0 三档实测 fps 与降频 → 决定默认画质档 |
| 3 | 「契约探测」 | ~10 秒 | **G2** 侧边栏 WebView 能否过 Cloudflare；站点真实接口；响应字段名 |
| 4 | 「缓存」→「刷新」 | 立即 | 缓存真实绝对路径 / 占用；**宿主是否提供 `setTimeout`** |
| 5 | 「缓存」→「运行自测」 | ~5 秒 | 流水线在本机的 14 步逐步结果（不联网） |
| 6 | 「缓存」→「灌入示例」→ 切「Runner」 | ~10 秒 | **离线刷 shader + 手势换片真的生效** |
| 7 | 在聊天里跟 AI 说「写一个旋转的彩色方块 shader」 | ~30 秒 | **聊天内实时渲染（P5）+ prompt 钩子是否注入成功**；再让它「写一段故意有语法错的 shader，然后自己读编译结果修好」就能验回传链路（要 `ToolPkg.ipc` 真的通） |

第 6 下不依赖网络与 Cloudflare —— 它是唯一能直接看到产品形态的一步。

### 编译错误回传（已实现，只剩一件事要真机验证）

自由创意模式需要「AI 写的 shader 编译不过时，把编译器报错原文给它」。但**编译 GLSL 需要 WebGL
上下文，而工具与钩子跑在 QuickJS 里没有 GL**。所以分两层：

| 在哪发现 | 能发现什么 |
|---|---|
| XML 钩子（QuickJS） | 结构性错误：漏写 `mainImage`、写错 `#version`、pass 形状不对 —— 作为**纯文本**返回，AI 当场就能改 |
| 渲染框（WebView，有 GL） | **真正的 GLSL 编译错误** —— 原文由渲染器回传 |

回传链路（官方 `ToolPkg.ipc`，见 `TOOLPKG_FORMAT_GUIDE.md`「跨上下文共享状态」）：

```text
聊天框 WebView 编译失败
  → 聊天框（ui 上下文） ipc.call(IPC_COMPILE_WRITE)
  → main 里的编译结果账本（src/plugin/compile-ledger.ts）
  → AI 调工具 shader_last_compile_result → main 的 IPC_COMPILE_READ → 账本 describe()
```

三个设计点值得说明（都有断言守着）：

- **账本必须是三态**（idle / pending / settled）。编译是异步的，而 AI 写完 shader 会立刻来读 ——
  如果只留「最近一次结果」，它读到的是**上一次**的报错，会照着去改一段自己已经改过的地方。
  所以新代码一下发就进 pending，此时只说「还在编译」。
- **每秒一次的性能上报不许进账本**，否则序号每秒 +1，AI 会读到「第 137 次编译」这种鬼话。
- 工具**永不抛异常**：抛了 AI 只看到一段堆栈，而不是“现在该怎么办”，它就修不下去了。

**还没在真机上验证的只有一件事**：`ToolPkg.ipc` 的跨运行时投递（官方文档写了语义，
但只有真机能跑）。万一没通，AI 会读到「跨运行时通道未就绪」这种可解释的文本，
退路仍是让用户看渲染框里的状态条 —— 也就是回到改造前的行为，不会更糟。

### 缓存位置与清理

```text
/sdcard/Download/Operit/plugins/shader_feed/
  index.json        shader 元数据索引（不含代码）
  textures.json     纹理台账
  shaders/          每条 shader 的完整记录
  textures/         纹理，按 URL 哈希命名并全局去重
  _selftest/        自测专用的隔离目录（可随时删）
```

- 默认上限 **500 MB**，超出后**只按 LRU 淘汰纹理**，shader 元数据永不淘汰
  （淘汰元数据会毁掉「按日期往回翻」的能力）
- 「清理纹理」只清纹理（占绝大头）；「全部清空」清掉全部缓存
- 自测只在 `_selftest/` 内读写，并有断言保证它**不碰你的真实缓存**

---

## 开发

```bash
npx tsc                    # 编译 TS → dist/（包里的运行时代码）
node tools/check.mjs       # 【唯一验收入口】tsc → deck 同步 → 9 套测试 → 打包 → 包内容比对
```

`tools/check.mjs` 的硬规矩是**第 1 步不过，后面一步都不许跑**。这不是洁癖：
曾经出现过「tsc 失败 → 没有新 dist → 测试跑的是旧产物 → 仍然报全绿 → 包也是旧的」
这种假绿。最后一步（解包回来与工作区逐字节比对）专门用来防它。

当前基线：**417 项断言 / 10 套全绿**。

### 目录

```text
src/deck/shader-deck.js     Shadertoy 兼容层（deck）：GLSL1/GLSL3 双分支、Common 拼接、
                            通道绑定、全屏三角、画质档；同时也是 runner 页的控制器
src/feed/parse.ts           容错解析（多变体、多 pass 只标记不丢弃）
src/feed/crawler.ts         爬取队列（并发 3 / 重试 1 次 / 跨页去重 / 多 pass 统计）
src/feed/transport.ts       在已过 CF 的会话里发 fetch 并取回文本（请求编号关联 + 超时兜底）
src/feed/store.ts           索引 + 正文分文件 + 纹理去重 + LRU + 损坏恢复
src/feed/host-fs.ts         Tools.Files → StoreFs 适配器 + 根目录可写性探测
src/feed/store-crawler.ts   把「已缓存的 shader」包装成可播数据源（D6 的离线播放）
src/feed/feed.ts            播放状态机（30s 自动上滑 / 补货阈值 / 暂停恢复 / iTime 随机化）
src/feed/selftest.ts        设备侧自测（内置假数据，不联网）
src/feed/crawl-probe.ts     契约探测脚本（注入到 shadertoy.com 页面里执行）
src/ui/feed/index.ui.ts     侧边栏界面（compose_dsl）
src/ui/chat/index.ui.ts     聊天内渲染界面（固定框高 260）
src/ui/shared/              虚拟域资源拦截 —— 侧边栏与聊天共用同一份，否则改一处忘另一处就是“某个界面白屏”
src/plugin/chat-xml-render.ts  xml_render 钩子：把 `<shader>` 换成活的画面
src/plugin/system-prompt.ts    系统提示钩子：让 AI 知道 `<shader>` 存在
src/shared/                 跨模块共用常量（聊天 state 键名）
resources/webview/          runner.html（含 touch-action:none）、probe.html
```

### 与宿主契约的核对（装包前已逐项对过 Operit 源码）

入口类错误有个很恶心的性质：**宿主不报错，只是什么都不显示**（侧边栏没入口、页面空白、
聊天里不出图）。所以下面每一条都是在装包前对着官方示例与 Kotlin 实现核对过的，不是猜的：

| 契约 | 核对结论 |
|---|---|
| `registerNavigationEntry({ surface })` | 只能是 `toolbox` / `main_sidebar_plugins`（`ToolPkgCommonPluginConstants.kt`），写错 = 侧边栏不出现入口 |
| 路由格式 | `toolpkg:<toolpkg_id>:ui:<id>`，与 `examples/dino_runner` 同形 |
| 入口函数 | `export function registerToolPkg()`；tsc 的 CJS 产物是 `exports.registerToolPkg = …`，**在文件开头**（`tail` 看不到，别因此以为没导出） |
| `registerUiRoute({ runtime })` | `compose_dsl`；`keepAlive` 省略即宿主的默认 `false`（`PackageManager.kt`）—— 正是耍的：离开侧边栏就别再渲染了 |
| UI 模块入口 | 宿主只认 `exports.default` / `exports.Screen`（`JsComposeDslRuntimeScript.kt`），所以两个 `index.ui.ts` 都是 `export default function Screen` |
| XML 渲染结果 | `{ handled, composeDsl: { screen, state, memo } }`；`screen` 必须是**模块函数**（宿主给导出贴 `__operit_toolpkg_module_path` 标记，传字符串路径会直接抛错） |
| prompt 钩子 | 返回 `{ systemPrompt }`，阶段名 `after_compose_system_prompt`，与 `examples/thinking_guidance` 同形 |
| 聊天框的资源 | 与侧边栏共用 `runner-resources.ts`，**不依赖侧边栏路由** —— 所以聊天里也能拿到 `runner.js` |
| `ctx.*` 与 `UI.*` | 成员名与签名逐个对过：`useState(key, initial)` 返回 `[值, setter]`、`createWebViewController(key)`、6 个工厂都存在、`WebViewProps` 里的 `controller` 是**可选字段**（不是构造参数） |
| `evaluateJavascript` | `evaluateJavascript<T>(script): Promise<T \| null \| undefined>` —— **可空**。4 处调用都包了 `Promise.resolve(...)` 并接了错误处理，因为 G1「宿主会不会 await 页面里的 Promise」还没定论 |
| 资源拦截的应答 | 必须返回 `{ action: "respond", response: { …, filePath } }`。`filePath` 这个变体正是「`readResource` 只给落盘路径、不给内容」的官方答案 —— 也就是本插件的地基 |
| `Tools.Files.read` | 官方只有 `read(path)` 与 `read({ path, environment })` —— **没有** `(path, env)` 位置参数重载。原先写成位置参数，环境会被静默丢弃（默认恰好是 `android`，所以没出事，但改成 `linux` 就会读错地方）。已修：实现、声明与官方对齐，并加了「调用形状」断言 |
| 宿主定时器 | **有** `setTimeout` / `setInterval` / `clearTimeout` / `queueMicrotask`（`quickjs-runtime.d.ts`）—— 所以缓存面板里那一项设备问题已经有答案了 |

这一节的价值在于：这些错误**要装包后才会暴露，而且表现为「没反应」**（不是报错），
定位成本高，返工要再走一次安装流程。

### 几条不该被"顺手优化"掉的设计

- **`waiting()` 表示"真的卡住"，不是"缓冲为空"**。当前这条还在正常播、只是队列空了不算卡住。
  UI 要分开处理，否则用户会在最需要耐心的时刻看到吓人的提示。
- **feed 的时钟由页面每秒一次的 stats 上报驱动**，而不是宿主定时器。宿主其实**有**
  `setTimeout`/`setInterval`（`quickjs-runtime.d.ts` 里是全局声明），所以这不是「没有才这么办」：
  页面驱动的时钟跟着渲染循环走、不额外起一个定时器、而且能离线真测（注入时间戳跑 30 秒逻辑）。
- **不改用 `.at(-1)`**。它是 ES2022，宿主 QuickJS 上不一定有（lint 会建议这么改，那是错的）。
- **REST 的 `waiting` / 参数钳制 / 「多 pass 不丢弃」都有断言**。特别是多 pass：
  丢在解析层，D3 的单 pass 占比就永远统计不出来了。
- **`ToolPkg.readResource` 返回的是落盘路径，不是文件内容**，所以 WebView 走
  「虚拟域 + 资源拦截」，`runner.html` 用相对名引用 `runner.js`。
- **所有落盘必须走 `writeTextAtomic` 的串行队列**，看上去像多余的仪式。
  去掉它实测的后果：12 条并发保存有 **11 条抛错、11 条数据静默丢失**（原子写用的是固定
  的 `.tmp` 路径，并发时互相踩）。有专门的并发测试守着。
- **`loadIndex`/`loadLedger` 缓存的是 Promise 而不是值**，这看上去也像多余。
  缓存值的话，N 个并发调用会各自读到空、各自建对象，最后一个赋值胜出 ——
  8 次并发写纹理最后台账只剩 1 条，而且不报任何错。
- **`readText` 的契约是「只有不存在才返回 null，其它失败必须抛出」**。看着像自找麻烦
  （为什么非让权限错误往上冒？），但两者混为一谈的后果是：一个权限坏掉的 `index.json`
  会被 store 当成「首次运行」，然后被**覆盖** —— 用户几十条缓存在没有任何提示的情况下消失。
  抛出去之后 store 会走 `onWarn` 上报，用户至少知道缓存为什么没了。
- **`feed.start()` 的幂等守卫看着像废话，但不是**。去掉它，重复调用会重置 dwell 并再取一条 ——
  等于把当前这条**静默丢掉**（它还没播满 30 秒就被换走）。有断言守着。

---

## 发布流程（路线 B：仓库 + GitHub Release 资产）

官方两条发布路线里，本仓库走 B（持续维护仓库 + 引用 Release 资产）。
**市场登记必须在 Operit 应用里做** —— 服务端会核对「Release 创建者 == 当前登录的 GitHub 账号」，
所以那步没法脚本化；其余都已固定成下面这套：

1. `node tools/check.mjs` —— 唯一验证入口（tsc → deck 同步 → 全部套件 → 打包 → 包内逐字节比对）
2. 改 `manifest.json` 里的 `version`，提交
3. `gh release create v<version> release/com.shaderfeed.operit-<version>.toolpkg --title … --notes-file …`
4. 在 Operit 发布页：选**与 Release 资产完全相同**的文件 → 「发布资源来源」选「引用 GitHub Release 资产」
   → 填仓库链接、选 Release 与资产名 → 填市场元数据 → 登记

两条容易踩的：

- 市场版本号取自包内 manifest，发布页**不允许手改**；所以先改 manifest 再打包。
- Release 正文只放作者自己的发布说明。官方明确不要求加 Operit 标记 / proof / 签名文本。

## 合规

Shadertoy 上 shader 的默认授权是 **CC BY-NC-SA 3.0**，纹理同理。因此：

1. **本仓库不存储任何 shader 源码或纹理**（运行期抓取是架构本身决定的）
2. **界面上每条 shader 必须显示作者名与原页面链接** —— 既是授权要求，也是基本礼貌
3. **`LICENSE` 只覆盖插件代码**，不覆盖运行期抓取的 shader 与纹理
4. **不暗示 Shadertoy 或任何 shader 作者的背书**（不使用其 logo，不作为"官方客户端"宣传）

抓取请遵守目标站点的服务条款与 robots.txt；本插件仅作浏览用途。

---

## 许可

[MIT](LICENSE)，仅覆盖本仓库的插件代码。详见 LICENSE 末尾的说明。
