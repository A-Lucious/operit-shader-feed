"use strict";
/**
 * P1 解析层：把 Shadertoy 的 shader JSON 变成内部记录。
 *
 * 设计原则：**容错，且不丢信息**。
 *   - 接口契约还没在真机上实测过（P1a 的探测页会给真值），所以这里对已知的几种变体都收：
 *     `{Shader:{...}}` 外壳 vs 扁平、likes/views 是字符串还是数字、pass type 大小写、
 *     inputs 里缺 sampler 或缺 ctype。
 *   - **不因为多 pass 就丢弃**。PLAN §4 D3 约定 v1 只收单 pass，但那条决策要靠
 *     「真实语料里单 pass 占比」来复核，所以解析层必须把多 pass 标出来、交给调用方筛，
 *     而绝不能在这里悄悄丢掉 —— 丢在这里，那个占比就永远统计不出来了。
 *
 * 这个文件是纯函数，不碰 DOM、不碰 ToolPkg，所以能在 Node 里直接测（见 tests/parse.test.mjs）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseShader = parseShader;
exports.extractShaderIds = extractShaderIds;
exports.isSinglePassRenderable = isSinglePassRenderable;
const GLSL3_MARKER = "#version 300 es";
/** 取掉可能的 `{Shader: ...}` 外壳。API v1 与站点内部接口都可能带这层。 */
function unwrapShader(parsed) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
    }
    const root = parsed;
    const inner = root.Shader;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        return inner;
    }
    return root;
}
function asText(value) {
    if (value === null || value === undefined) {
        return "";
    }
    return typeof value === "string" ? value : String(value);
}
/**
 * likes/views 实测可能是字符串（站点接口惯用字符串），也可能是数字。
 * 拿不到真实值一律返回 null，不要退化成 0。
 */
function asCount(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    const n = Number.parseInt(asText(value), 10);
    return Number.isFinite(n) ? n : null;
}
function asPassList(shader) {
    const raw = shader.renderpass ?? shader.renderPass ?? shader.passes;
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter((p) => !!p && typeof p === "object" && !Array.isArray(p));
}
function passType(pass) {
    return asText(pass.type).trim().toLowerCase();
}
function readChannels(pass) {
    const raw = pass.inputs;
    const channels = [];
    const unsupported = [];
    if (!Array.isArray(raw)) {
        return { channels, unsupported };
    }
    for (const item of raw) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            continue;
        }
        const inp = item;
        const ctype = asText(inp.ctype).trim().toLowerCase();
        const channel = asCount(inp.channel);
        if (ctype !== "texture") {
            // keyboard / audio / video / cubemap / buffer ... 都记下来，交给上层决定
            unsupported.push(ctype || "unknown");
            continue;
        }
        const sampler = inp.sampler &&
            typeof inp.sampler === "object" &&
            !Array.isArray(inp.sampler)
            ? inp.sampler
            : {};
        channels.push({
            channel: channel === null ? channels.length : channel,
            ctype,
            src: asText(inp.src),
            filter: asText(sampler.filter) || "linear",
            wrap: asText(sampler.wrap) || "repeat",
            vflip: asText(sampler.vflip) || "false",
        });
    }
    return { channels, unsupported };
}
/**
 * 解析单个 shader 的响应体。
 *
 * 与 deck 的 `assemble()` 保持同一套前置判断（必须有 image pass、必须有 mainImage），
 * 这样「能入库」与「能渲染」是同一个判据，不会出现存下来却渲染不了的记录。
 */
function parseShader(jsonText) {
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    }
    catch (err) {
        return {
            ok: false,
            error: "响应不是合法 JSON: " +
                asText(err instanceof Error ? err.message : err),
        };
    }
    const shader = unwrapShader(parsed);
    if (!shader) {
        return { ok: false, error: "响应顶层不是对象" };
    }
    const passes = asPassList(shader);
    if (passes.length === 0) {
        return { ok: false, error: "没有 renderpass（接口形状可能变了）" };
    }
    const image = passes.find((p) => passType(p) === "image");
    if (!image) {
        return { ok: false, error: "没有 image pass" };
    }
    const code = asText(image.code);
    if (code.indexOf("mainImage") < 0) {
        return { ok: false, error: "image pass 里没有 mainImage()" };
    }
    const commonPass = passes.find((p) => passType(p) === "common");
    const common = commonPass ? asText(commonPass.code) : "";
    const { channels, unsupported } = readChannels(image);
    const info = shader.info &&
        typeof shader.info === "object" &&
        !Array.isArray(shader.info)
        ? shader.info
        : {};
    const id = asText(info.id) || asText(shader.id);
    return {
        ok: true,
        record: {
            id,
            name: asText(info.name),
            username: asText(info.username),
            likes: asCount(info.likes),
            views: asCount(info.views),
            date: asText(info.date),
            code,
            common,
            passCount: passes.length,
            hasBuffers: passes.some((p) => passType(p) === "buffer"),
            isGLSL3: code.indexOf(GLSL3_MARKER) >= 0,
            channels,
            unsupportedChannels: unsupported,
        },
    };
}
/** Shadertoy 的 id 是短的 base62 串；用它挡掉列表里混进来的非 id 字段。 */
function looksLikeShaderId(value) {
    if (value.length < 3 || value.length > 16) {
        return false;
    }
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        const isDigit = c >= 48 && c <= 57;
        const isUpper = c >= 65 && c <= 90;
        const isLower = c >= 97 && c <= 122;
        if (!isDigit && !isUpper && !isLower) {
            return false;
        }
    }
    return true;
}
/**
 * 从列表/查询响应里抽取 shader id。
 *
 * 列表响应的确切形状还没实测，所以按已知变体逐个收，而不是赌一种：
 *   1. 纯字符串数组（`/api/v1/shaders/query/...` 按官方说明就是"返回一组 ID"）
 *   2. 对象数组，取 `.id` / `._id`
 *   3. 上面两种被包在 `Results` / `Items` / `Shaders` / `data` 里
 * 递归深度有限，避免在大响应上失控。
 */
function extractShaderIds(jsonText) {
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    }
    catch {
        return [];
    }
    const found = [];
    const seen = new Set();
    function push(value) {
        const text = asText(value).trim();
        if (!text || seen.has(text) || !looksLikeShaderId(text)) {
            return;
        }
        seen.add(text);
        found.push(text);
    }
    function walk(node, depth) {
        if (depth > 6 || node === null || node === undefined) {
            return;
        }
        if (typeof node === "string") {
            push(node);
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node) {
                walk(item, depth + 1);
            }
            return;
        }
        if (typeof node !== "object") {
            return;
        }
        const obj = node;
        // 先看这个对象自己是不是一条 shader 摘要
        if (obj.id !== undefined || obj._id !== undefined) {
            push(obj.id === undefined ? obj._id : obj.id);
        }
        // 再看命名容器
        for (const key of [
            "Results",
            "Items",
            "Shaders",
            "data",
            "results",
            "items",
        ]) {
            if (obj[key] !== undefined) {
                walk(obj[key], depth + 1);
            }
        }
    }
    walk(parsed, 0);
    return found;
}
/**
 * D3 的单 pass 判定。**只做判定，不做丢弃** —— 调用方要同时统计总数与通过数，
 * 才能在 P1 复核 D3（若单 pass 占比 < 30%，PLAN 要求回头评估多 pass 方案）。
 */
function isSinglePassRenderable(record) {
    return (record.passCount === 1 &&
        !record.hasBuffers &&
        record.unsupportedChannels.length === 0);
}
