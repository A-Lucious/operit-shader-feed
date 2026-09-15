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

装好后侧边栏出现「**Shader 流**」。进去有 4 个标签，以下 6 下点击能把我需要的
全部实机数据拿回来（结果都是屏幕上**可选中复制**的文本）：

| # | 操作 | 耗时 | 能确认什么 |
|---|---|---|---|
| 1 | 「Probe」自动跑 | 立即 | **G3** 真机同时可存的 WebGL context 上限 → 决定 P4 走 α 还是 β |
| 2 | 「Probe」→「开始 G4」 | 3 分 15 秒 | 0.5 / 0.75 / 1.0 三档实测 fps 与降频 → 决定默认画质档 |
| 3 | 「契约探测」 | ~10 秒 | **G2** 侧边栏 WebView 能否过 Cloudflare；站点真实接口；响应字段名 |
| 4 | 「缓存」→「刷新」 | 立即 | 缓存真实绝对路径 / 占用；**宿主是否提供 `setTimeout`** |
| 5 | 「缓存」→「运行自测」 | ~5 秒 | 流水线在本机的 14 步逐步结果（不联网） |
| 6 | 「缓存」→「灌入示例」→ 切「Runner」 | ~10 秒 | **离线刷 shader + 手势换片真的生效** |
| 7 | 在聊天里跟 AI 说「写一个旋转的彩色方块 shader」 | ~30 秒 | **聊天内实时渲染（P5）+ prompt 钩子是否注入成功** |

第 6 下不依赖网络与 Cloudflare —— 它是唯一能直接看到产品形态的一步。

### 已知限制：编译错误回传

自由创意模式需要「AI 写的 shader 编译不过时，把编译器报错原文给它」。但**编译 GLSL 需要 WebGL
上下文，而工具与钩子跑在 QuickJS 里没有 GL**。所以：

| 能自动发现 | 发现不了 |
|---|---|
| 结构性错误：漏写 `mainImage`、写错 `#version`、pass 形状不对 | **真正的 GLSL 编译错误** |

结构性错误会作为**纯文本**返回（因为 AI 看不到界面，错误必须落在对话记录里它才能自己修）；
真实编译错误只显示在渲染框的状态条上，需用户转述。可能的解法在 `ComposeDslContext` 的
`getEnv`/`setEnv` 上（跨运行时键值通道），但那需要在真机上做一次实验才能确认。

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

### 几条不该被"顺手优化"掉的设计

- **`waiting()` 表示"真的卡住"，不是"缓冲为空"**。当前这条还在正常播、只是队列空了不算卡住。
  UI 要分开处理，否则用户会在最需要耐心的时刻看到吓人的提示。
- **宿主里没有定时器**。feed 的时钟由页面每秒一次的 stats 上报驱动，所以 30 秒逻辑
  能离线真测，也不用赌 QuickJS 有没有 `setTimeout`。
- **不改用 `.at(-1)`**。它是 ES2022，宿主 QuickJS 上不一定有（lint 会建议这么改，那是错的）。
- **REST 的 `waiting` / 参数钳制 / 「多 pass 不丢弃」都有断言**。特别是多 pass：
  丢在解析层，D3 的单 pass 占比就永远统计不出来了。
- **`ToolPkg.readResource` 返回的是落盘路径，不是文件内容**，所以 WebView 走
  「虚拟域 + 资源拦截」，`runner.html` 用相对名引用 `runner.js`。

---

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
