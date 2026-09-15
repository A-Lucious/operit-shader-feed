"use strict";
/**
 * P1c 传输层：在**已通过 Cloudflare 的 shadertoy 会话里**发请求，把响应文本送回宿主。
 *
 * 为什么是这样：CF 的 clearance 是 cookie + IP 绑定的，宿主侧的 HTTP（含
 * `Tools.Files.download`）拿不到 WebView 的 cookie，所以只有页面上下文里的 fetch 能过。
 * 于是流程是：宿主注入一段 fetch 脚本 → 页面执行 → 结果通过 JS bridge 回调回来。
 *
 * 三层刻意解耦，因为它们各自能独立验证：
 *   1. `SessionBridge` —— UI 层用 evaluateJavascript + addJavascriptInterface 实现
 *   2. `TransportRecipe` —— 请求配方（URL/method/body），**契约探测的结果就是填这里**，
 *      所以探测回来之后只需要改这一处，不用动本文件其它逻辑
 *   3. 本文件 —— 请求编号、结果关联、超时、错误映射
 *
 * 第 3 点里最容易在真机上炸的是**结果关联**：20 条并发详情请求如果发生串包，
 * 表现是「滑到某条 shader 出来的是别人的画面」——所以它有专门的反串包测试。
 *
 * ⚠️ 超时是必须的，不是保险：bridge 一旦不回调，对应的 promise 就永久挂住 →
 * crawler 的槽位不减 → feed 的补货标志永远为 true → 整个 feed 停摆。
 * 宿主有没有 setTimeout 由契约探测页顺带确认。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildFetchScript = buildFetchScript;
exports.defaultRecipe = defaultRecipe;
exports.createSessionTransport = createSessionTransport;
const DEFAULT_TIMEOUT_MS = 20000;
/**
 * 页面侧 fetch 脚本。**一个反斜杠都不能有** —— 它会被写进 TS 模板字面量，
 * 而模板字面量会解释转义（`\s` → `s`），静默改坏脚本。
 * 所以这里用 indexOf / JSON.stringify，不用正则、不用 `\n` 转义。
 */
function buildFetchScript(requestId, spec) {
    const payload = JSON.stringify({
        id: requestId,
        path: spec.path,
        method: spec.method,
        body: spec.body ?? "",
        contentType: spec.contentType ?? "",
    });
    return `(function () {
  var REQ = ${payload};
  function deliver(ok, text) {
    try {
      if (window.ShaderHost && typeof window.ShaderHost.fetchResult === "function") {
        window.ShaderHost.fetchResult(REQ.id, ok, text);
      }
    } catch (err) {
      // 宿主不可用就只能算了；宿主侧的超时会兜底
    }
  }
  var init = { method: REQ.method, credentials: "include" };
  if (REQ.body) {
    init.body = REQ.body;
    init.headers = { "Content-Type": REQ.contentType || "application/x-www-form-urlencoded" };
  }
  try {
    fetch(REQ.path, init)
      .then(function (res) {
        return res.text().then(function (text) {
          deliver(res.status >= 200 && res.status < 400, text);
        });
      })
      .catch(function (err) {
        deliver(false, "fetch failed: " + String(err && err.message ? err.message : err));
      });
  } catch (err) {
    deliver(false, "fetch threw: " + String(err && err.message ? err.message : err));
  }
  return REQ.id;
})();`;
}
/** 默认配方：站点自己的内部接口（待契约探测确认）。 */
function defaultRecipe() {
    return {
        list: () => ({
            path: "/shadertoy",
            method: "POST",
            body: "nt=0&nl=12&np=0",
            contentType: "application/x-www-form-urlencoded",
        }),
        detail: (id) => ({
            path: "/shadertoy",
            method: "POST",
            body: "s=" + id + "&nt=0&nl=0&np=0",
            contentType: "application/x-www-form-urlencoded",
        }),
    };
}
function createSessionTransport(bridge, recipe = defaultRecipe(), options = {}) {
    const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const now = options.now ?? (() => Date.now());
    let seq = 0;
    const pending = new Map();
    const detach = bridge.onResult((requestId, ok, payload) => {
        const resolve = pending.get(requestId);
        if (!resolve) {
            // 迟到的结果（大概率是已经超时被清掉的那条）——忽略，但不能让它串到别人身上
            return;
        }
        pending.delete(requestId);
        resolve({ ok, text: payload });
    });
    /**
     * 发一次请求并等结果。
     * 关键：**按 requestId 关联**，不是按到达顺序 —— 并发详情请求必须各拿各的。
     */
    /** dispose 之后不再接受新请求：bridge 已解绑，结果永远回不来，等下去只能等到超时。 */
    let disposed = false;
    function send(spec) {
        if (disposed) {
            return Promise.resolve({
                ok: false,
                text: "",
                error: "transport 已关闭",
            });
        }
        seq += 1;
        const requestId = "r" + now() + "_" + seq;
        return new Promise((resolve) => {
            let settled = false;
            function settle(value) {
                if (settled)
                    return;
                settled = true;
                pending.delete(requestId);
                resolve(value);
            }
            pending.set(requestId, (result) => {
                if (result.ok) {
                    settle({ ok: true, text: result.text });
                }
                else {
                    settle({ ok: false, text: result.text, error: result.text });
                }
            });
            // 超时兜底。没有它，一次不回头的 bridge 会让整个爬虫永久停摆。
            if (typeof setTimeout === "function") {
                setTimeout(() => {
                    settle({
                        ok: false,
                        text: "",
                        error: "请求超时（" + timeoutMs + "ms）: " + spec.path,
                    });
                }, timeoutMs);
            }
            try {
                bridge.inject(buildFetchScript(requestId, spec));
            }
            catch (err) {
                settle({
                    ok: false,
                    text: "",
                    error: "注入脚本失败: " +
                        (err instanceof Error ? err.message : String(err)),
                });
            }
        });
    }
    return {
        async listIds(cursor, limit) {
            const result = await send(recipe.list(cursor, limit));
            if (!result.ok) {
                return { ok: false, ids: [], nextCursor: cursor, error: result.error };
            }
            const ids = extractIds(result.text);
            // 用 [length-1] 而不是 .at(-1)：.at 是 ES2022，宿主 QuickJS 上不一定有。
            // （lint 的 prefer-at 建议在这里是错的，照做会引入宿主兼容性 bug。）
            const lastId = ids.length > 0 ? ids[ids.length - 1] : cursor;
            return {
                ok: true,
                ids,
                nextCursor: lastId,
                exhausted: ids.length === 0,
            };
        },
        async fetchShader(id) {
            const result = await send(recipe.detail(id));
            if (!result.ok) {
                return { ok: false, text: "", error: result.error };
            }
            return { ok: true, text: result.text };
        },
        /**
         * 关闭传输层：解绑 bridge 回调，并让**所有未决请求就地失败**。
         *
         * 为什么不能只 `pending.clear()`：那样未决的 promise 只能等超时落地 ——
         * 而宿主没有 setTimeout 时会**永远不落地**，于是 crawler 的槽位不减、
         * `ensure` 永远不 resolve、feed 的补货标志永久卡住（整条链停摆）。
         * 就地失败则让每个调用者立刻拿到一个明确的失败，能继续往下走。
         */
        dispose() {
            disposed = true;
            detach();
            const inFlight = [...pending.values()];
            pending.clear();
            for (const resolve of inFlight) {
                resolve({ ok: false, text: "transport 已关闭（未决请求被取消）" });
            }
        },
    };
}
/**
 * 从列表响应里抽 id。这里只做**结构无关**的兜底抽取，
 * 真正的字段级解析在 parse.ts（那里有完整的变体覆盖和测试）。
 */
function extractIds(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return [];
    }
    const out = [];
    const seen = new Set();
    function push(value) {
        const id = typeof value === "string" ? value.trim() : "";
        if (!id || seen.has(id))
            return;
        // id 是短 base62；用长度与字符集挡掉混进来的其它字段
        if (id.length < 3 || id.length > 16)
            return;
        for (let i = 0; i < id.length; i++) {
            const c = id.charCodeAt(i);
            const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
            if (!ok)
                return;
        }
        seen.add(id);
        out.push(id);
    }
    function walk(node, depth) {
        if (depth > 4 || node === null || node === undefined)
            return;
        if (typeof node === "string") {
            push(node);
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node)
                walk(item, depth + 1);
            return;
        }
        if (typeof node !== "object")
            return;
        const obj = node;
        if (obj.id !== undefined)
            push(obj.id);
        if (obj._id !== undefined)
            push(obj._id);
        for (const key of [
            "Results",
            "Items",
            "Shaders",
            "data",
            "results",
            "items",
        ]) {
            if (obj[key] !== undefined)
                walk(obj[key], depth + 1);
        }
    }
    walk(parsed, 0);
    return out;
}
