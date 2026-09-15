"use strict";
/**
 * 编译结果的**线格式**，以及两端：界面侧编码、main 侧解码。
 *
 * 放在一个模块里的理由：这两端必须严格对称（界面写的字段、main 要认得），
 * 分开写就会出现"界面发了、main 读不到"这种只能真机发现的错位。
 * 放一起还能让它们共用同一份类型。
 *
 * ⚠️ 这层是**运行时边界**：payload 从另一个运行时过来，必须当成不可信数据处理 ——
 * 解码端任何一个字段都可能是 undefined / 字符串 / 对象。两条硬要求：
 *   1. 解码端绝不抛异常（它在 main 里，抛了会影响整个包）
 *   2. 认不出来的 payload 一律**忽略**，而不是硬塞进账本（否则 AI 会读到脏结果）
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.toCompileIpcPayload = toCompileIpcPayload;
exports.createCompileIpcHandlers = createCompileIpcHandlers;
/** 渲染器上报里，判断"这是不是一次编译结果"只需要这几个字段。 */
function readNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
}
/**
 * 上报可能已经是对象（宿主桥把它解析过了），也可能是 JSON 字符串
 *（deck 那边 report 前先 stringify 了一次）。两种都得能收。
 * 解析失败一律返回 null —— **不在调用侧做这件事**，否则 unknown 只是被挪了个位置。
 */
function parseReport(report) {
    let value = report;
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        }
        catch {
            return null;
        }
    }
    return value && typeof value === "object" ? value : null;
}
/**
 * 界面侧：把渲染器的上报翻译成要发给 main 的 payload。
 * 不是编译结果就返回 null —— 特别是每秒一次的 `stage: "stats"`，
 * 放进去会让账本的序号每秒 +1，AI 会读到「第 137 次编译」这种鬼话。
 */
function toCompileIpcPayload(report, context = {}) {
    const parsed = parseReport(report);
    if (!parsed) {
        return null;
    }
    const stage = typeof parsed.stage === "string" ? parsed.stage : "";
    // running = 编译并链接成功；compile = GLSL 编译失败；
    // init = 连渲染上下文都没建起来（对 AI 来说同样是"这段代码现在渲染不出来"）。
    if (stage !== "running" && stage !== "compile" && stage !== "init") {
        return null;
    }
    const errors = Array.isArray(parsed.errors)
        ? parsed.errors.filter((line) => typeof line === "string")
        : [];
    const payload = {
        kind: "result",
        // 只有 running 才可能是成功；compile/init 即使没带 ok 也是失败。
        ok: stage === "running" && parsed.ok === true,
        errors,
    };
    const codeLength = readNumber(context.codeLength);
    if (codeLength !== undefined) {
        payload.codeLength = codeLength;
    }
    return payload;
}
function createCompileIpcHandlers(ledger) {
    return {
        write(payload) {
            if (!payload || typeof payload !== "object") {
                return;
            }
            const p = payload;
            const codeLength = readNumber(p.codeLength);
            if (p.kind === "pending") {
                ledger.markPending(codeLength === undefined ? {} : { codeLength });
                return;
            }
            if (p.kind !== "result") {
                // 认不出来的 kind：忽略。硬塞进账本会让 AI 读到不属于它的结果。
                return;
            }
            const errors = Array.isArray(p.errors)
                ? p.errors.filter((line) => typeof line === "string")
                : [];
            ledger.record({
                ok: p.ok === true,
                errors,
                ...(codeLength === undefined ? {} : { codeLength }),
            });
        },
        read() {
            return ledger.describe();
        },
    };
}
