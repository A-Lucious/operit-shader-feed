/**
 * 聊天内渲染的 state 键名。
 *
 * 必须由**钩子与界面共用同一份**：钩子用 `state: { [key]: … }` 下发，界面用
 * `ctx.useState(key, "")` 读取。两边各写一个字符串字面量的后果是——
 * 写错了不会报任何错，只是聊天里永远什么都不显示，而且离线环境完全查不出来。
 */

export const STATE_KEY_SHADER_CODE = "shaderCode";
export const STATE_KEY_SHADER_TITLE = "shaderTitle";

/**
 * 编译结果的跨运行时通道名（`ToolPkg.ipc`）。
 *
 * 同样只有一份的理由更硬：界面往里**写**（渲染器回执）、main 收下、
 * 工具脚本（也就是 AI）从里面**读**。三处任何一处写错，表现都是「AI 读不到编译结果」，
 * 而这条链路**无法离线验证** —— 跨运行时投递要真机才能跑。所以名字只能靠这里对齐。
 *
 * 语义见官方 TOOLPKG_FORMAT_GUIDE.md：ui 上下文 call 时默认目标就是本包的 main，
 * 不需要 targetContextKey；sandbox 里的工具同样能 call 到 main。
 */
export const IPC_COMPILE_WRITE = "shader_feed.compile_result.write";
export const IPC_COMPILE_READ = "shader_feed.compile_result.read";

/**
 * 页面里那个 JS bridge 的名字（`window.ShaderHost`）。
 *
 * 必须与 deck（src/deck/shader-deck.js）里读的名字一字不差 —— deck 是纯 JS，
 * 没法 import 这个常量，所以两边只能靠约定。写错的后果：deck 永远不调 ready()，
 * 界面一直卡在「等待页面握手」，而且**只能真机发现**。
 * 生成自包含 HTML 时有一道断言拉着它们（见 tests/runner-html.test.mjs）。
 */
export const HOST_INTERFACE_NAME = "ShaderHost";
