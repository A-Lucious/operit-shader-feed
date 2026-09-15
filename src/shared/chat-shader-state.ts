/**
 * 聊天内渲染的 state 键名。
 *
 * 必须由**钩子与界面共用同一份**：钩子用 `state: { [key]: … }` 下发，界面用
 * `ctx.useState(key, "")` 读取。两边各写一个字符串字面量的后果是——
 * 写错了不会报任何错，只是聊天里永远什么都不显示，而且离线环境完全查不出来。
 */

export const STATE_KEY_SHADER_CODE = "shaderCode";
export const STATE_KEY_SHADER_TITLE = "shaderTitle";
