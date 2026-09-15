"use strict";
/**
 * 「AI 写的 shader 编译结果」账本 —— P6 的核心。
 *
 * 为什么需要它：编译 GLSL 需要 WebGL 上下文，而工具与钩子跑在 QuickJS 里**没有 GL**。
 * 唯一能编译的地方是聊天框里那个 WebView。于是链路是：
 *
 *   聊天框 WebView 编译失败 → UI 把报错原文 ipc 给 main（就是这里）→
 *   AI 调工具读到它 → 自己修
 *
 * 本模块只做账本与措辞，所有分支都能离线测；真机上只剩「ipc 能不能送到」一件事。
 *
 * ⚠️ 这里真正要解决的不是"把报错送出来"，而是**时序**：
 *   编译是异步的（WebView 渲染完才知道结果），而 AI 写完 shader 会立刻来读。
 *   如果账本只有"最近一次结果"，AI 读到的会是**上一次**的报错 —— 它会照着去改一段
 *   自己根本没写错、甚至已经改过的代码。所以状态机里必须有 pending：
 *   新代码一下发就进入 pending，describe() 会说「还在编译，稍后再读」，
 *   而不会把旧报错当成新报错递给 AI。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCompileLedger = createCompileLedger;
const DEFAULT_MAX_ERROR_CHARS = 4000;
function createCompileLedger(options = {}) {
    const now = options.now ?? (() => Date.now());
    const maxErrorChars = Math.max(200, options.maxErrorChars ?? DEFAULT_MAX_ERROR_CHARS);
    let state = { kind: "idle" };
    let seq = 0;
    function clip(text) {
        if (text.length <= maxErrorChars) {
            return text;
        }
        return (text.slice(0, maxErrorChars) +
            "\n…（报错原文过长，已截断 " +
            (text.length - maxErrorChars) +
            " 字）");
    }
    /** 代码长度只在真的知道时才提 —— 0 字这种话会让 AI 以为拿到了别人的结果。 */
    function lengthNote(len) {
        return len > 0 ? "，代码 " + len + " 字" : "";
    }
    return {
        markPending(input = {}) {
            state = {
                kind: "pending",
                since: input.at ?? now(),
                codeLength: Math.max(0, input.codeLength ?? 0),
            };
        },
        record(input) {
            seq += 1;
            const raw = (input.errors ?? []).map((line) => String(line));
            // 过滤掉空行：渲染器有时会回一个空数组，那不该变成"错误列表里有一条空话"。
            const errors = raw.filter((line) => line.trim() !== "");
            const prevLength = state.kind === "pending" ? state.codeLength : 0;
            state = {
                kind: "settled",
                ok: input.ok === true,
                errors,
                at: input.at ?? now(),
                codeLength: Math.max(0, input.codeLength ?? prevLength),
                seq,
            };
        },
        state() {
            return state;
        },
        describe() {
            if (state.kind === "idle") {
                return ("还没有收到任何编译结果。\n" +
                    "如果你刚写过一段 shader，界面需要一点时间（通常 1～2 秒）把它编译出来，" +
                    "稍后再调用一次这个工具。");
            }
            if (state.kind === "pending") {
                return ("还在编译中（新代码已下发，渲染器还没回执）。\n" +
                    "稍等 1～2 秒再调用一次，现在读到的任何报错都不属于你最新写的这段代码。");
            }
            if (state.ok) {
                return ("最近一次编译**成功**（第 " +
                    state.seq +
                    " 次" +
                    lengthNote(state.codeLength) +
                    "）。不需要改动。");
            }
            if (state.errors.length === 0) {
                // 渲染器没给日志也要说人话，否则 AI 会拿到一句空话、无从下手。
                return ("最近一次编译**失败**，但渲染器没有给出日志（第 " +
                    state.seq +
                    " 次" +
                    lengthNote(state.codeLength) +
                    "）。\n" +
                    "常见原因是渲染上下文创建失败；可以让用户看一眼渲染框里的状态条。");
            }
            return ("最近一次编译**失败**（第 " +
                state.seq +
                " 次" +
                lengthNote(state.codeLength) +
                "）。GLSL 编译器原文如下：\n\n" +
                clip(state.errors.join("\n")) +
                "\n\n请按报错修改后，把完整的 shader 重新写一遍（不要只贴片段）。");
        },
        reset() {
            state = { kind: "idle" };
            seq = 0;
        },
    };
}
