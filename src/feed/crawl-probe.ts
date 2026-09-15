/**
 * P1 契约探测脚本。
 *
 * 这是在 **shadertoy.com 页面上下文里**执行的脚本，用来在一次真实会话中把数据接口契约
 * 实测出来，而不是靠猜。它必须在 CF 已通过、cookie 有效的会话里跑，否则拿不到真数据。
 *
 * ⚠️ 为什么这里是「字符串」而不是资源文件：
 *   这段代码要注入**第三方 origin** 的页面（shadertoy.com），而
 *   `ToolPkg.readResource()` 返回的是宿主临时目录里的**绝对路径**、它又拿不到内容；
 *   虚拟域拦截也只对 shaderfeed.local 生效。所以只能作为字符串随 TS 源码带进去。
 *
 * ⚠️ 为什么脚本里一个反斜杠都没有：
 *   它被写在 TS 模板字面量里，而模板字面量会解释转义序列 —— `\s` 会变成 `s`、`\.` 会变成 `.`，
 *   正则会被静默改错。所以这里一律用 indexOf / new RegExp 的字符类，不用任何反斜杠转义。
 *
 * 探测三件事：
 *   1. CF 是否真的过了（看 title）
 *   2. 站点自己调过哪些接口（performance.getEntriesByType）
 *   3. 对真实存在的 shader id 试几种候选请求，报告哪个通、响应顶层结构长什么样
 *
 * 结果会：① 通过 ShaderHost.report 上报 ② 并把当前页面替换成可选中复制的 <pre>
 */

/** 探测结果页面用的内联样式（替换掉 shadertoy 页面，方便长按复制）。 */
const RESULT_PAGE_STYLE = [
  "margin:0",
  "padding:12px",
  "min-height:100vh",
  "box-sizing:border-box",
  "background:#0b0f14",
  "color:#d7e6f5",
  "font:12px/1.5 ui-monospace,Menlo,Consolas,monospace",
  "white-space:pre-wrap",
  "word-break:break-all",
  "user-select:text",
  "-webkit-user-select:text",
].join(";");

/**
 * 与 shadertoy 站点无关的静态列表：用 indexOf 而不是正则，见文件头说明。
 * 用于从 performance 条目里滤掉静态资源，只留下疑似数据接口。
 */
const STATIC_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".css",
  ".js",
  ".woff",
  ".woff2",
  ".ttf",
  ".mp4",
  ".ico",
];

export const CRAWL_PROBE_SCRIPT: string = `(function () {
  var STATIC_EXT = ${JSON.stringify(STATIC_EXTENSIONS)};
  var STYLE = ${JSON.stringify(RESULT_PAGE_STYLE)};

  var report = { ok: true, stage: "crawl-probe" };
  report.href = String(location.href);
  report.title = String(document.title);
  // CF 拦截页的标题是 "Just a moment..."（英文）/"Attention Required!"（部分场景）
  var lowerTitle = report.title.toLowerCase();
  report.cfCleared =
    lowerTitle.indexOf("just a moment") < 0 && lowerTitle.indexOf("attention required") < 0;

  // 关键时序：onPageFinished 在 CF 的挑战页上也会触发。
  // 此时既拿不到真数据，而且**替换 body 有干扰挑战脚本的风险**（挑战是靠页面脚本跑的）。
  // 所以未通过就只上报一句、绕不碰 DOM；等 CF 跳转后触发的下一次 onPageFinished 再真跑。
  if (!report.cfCleared) {
    report.stage = "crawl-probe-pending";
    try {
      if (window.ShaderHost && typeof window.ShaderHost.report === "function") {
        window.ShaderHost.report(JSON.stringify(report));
      }
    } catch (err) { /* 宿主不可用时忽略 */ }
    return "cf-pending";
  }

  function isStatic(url) {
    var u = url.toLowerCase();
    for (var i = 0; i < STATIC_EXT.length; i++) {
      if (u.indexOf(STATIC_EXT[i]) >= 0) return true;
    }
    return false;
  }

  // ---- 1) 站点自己调过哪些接口：不用猜，直接听 ----
  try {
    var entries = performance.getEntriesByType("resource");
    var seen = {};
    var endpoints = [];
    for (var e = 0; e < entries.length; e++) {
      var name = String(entries[e].name || "");
      if (name.indexOf("shadertoy.com") < 0) continue;
      if (isStatic(name)) continue;
      var key = name.split("?")[0];
      if (seen[key]) continue;
      seen[key] = true;
      endpoints.push(name);
      if (endpoints.length >= 40) break;
    }
    report.networkEndpoints = endpoints;
  } catch (err) {
    report.networkEndpoints = ["读取 performance 失败: " + String(err && err.message)];
  }

  // ---- 2) 从页面上抓一个**真实存在**的 shader id，避免用写死的 id 猜 ----
  var shaderId = "";
  try {
    var anchors = document.querySelectorAll('a[href*="/view/"]');
    for (var a = 0; a < anchors.length; a++) {
      var href = String(anchors[a].getAttribute("href") || "");
      var at = href.indexOf("/view/");
      if (at < 0) continue;
      var rest = href.slice(at + 6);
      var cut = rest.length;
      var stops = ["?", "#", "/"];
      for (var s = 0; s < stops.length; s++) {
        var pos = rest.indexOf(stops[s]);
        if (pos >= 0 && pos < cut) cut = pos;
      }
      var candidate = rest.slice(0, cut);
      if (candidate) { shaderId = candidate; break; }
    }
    report.pickedShaderId = shaderId;
    report.viewLinkCount = anchors.length;
  } catch (err) {
    report.pickedShaderId = "";
  }

  // ---- 3) 试候选请求 ----
  // 每个候选：method / path / body / contentType。哪个通用哪个，不预设。
  var candidates = [];
  if (shaderId) {
    var form = "s=" + shaderId + "&nt=0&nl=0&np=0";
    candidates = [
      { id: "shadertoy_post_full", method: "POST", path: "/shadertoy", body: form,
        contentType: "application/x-www-form-urlencoded" },
      { id: "shadertoy_post_short", method: "POST", path: "/shadertoy", body: "s=" + shaderId,
        contentType: "application/x-www-form-urlencoded" },
      { id: "api_v1_shader", method: "GET", path: "/api/v1/shaders/" + shaderId, body: "",
        contentType: "" },
      { id: "view_page", method: "GET", path: "/view/" + shaderId, body: "", contentType: "" }
    ];
  }

  /** 把 shader 对象压缩成「契约摘要」：只报字段名与结构，不把响应体整个搬走。 */
  function summarize(text) {
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { parsed: false, head: text.slice(0, 400) };
    }
    var s = parsed && (parsed.Shader || parsed);
    var out = { parsed: true };
    out.topKeys = Object.keys(s || {});
    if (s && s.info) {
      out.infoKeys = Object.keys(s.info);
      out.infoSample = {
        id: s.info.id,
        name: s.info.name,
        username: s.info.username,
        likes: s.info.likes,
        views: s.info.views,
        date: s.info.date
      };
    }
    var rp = (s && s.renderpass) || [];
    out.passCount = rp.length;
    out.passes = [];
    for (var i = 0; i < rp.length; i++) {
      var p = rp[i];
      var code = String((p && p.code) || "");
      var inputs = (p && p.inputs) || [];
      var inputSummaries = [];
      for (var j = 0; j < inputs.length; j++) {
        var inp = inputs[j] || {};
        inputSummaries.push({
          keys: Object.keys(inp),
          channel: inp.channel,
          ctype: inp.ctype,
          src: inp.src,
          sampler: inp.sampler
        });
      }
      out.passes.push({
        type: p.type,
        codeLength: code.length,
        // 用 indexOf 而不是正则：见文件头关于反斜杠的说明
        declaresGLSL3: code.indexOf("#version 300 es") >= 0,
        inputCount: inputs.length,
        inputs: inputSummaries
      });
    }
    return out;
  }

  function finish() {
    var text = JSON.stringify(report, null, 2);
    // ① 上报宿主（侧边栏会打日志）
    try {
      if (window.ShaderHost && typeof window.ShaderHost.report === "function") {
        window.ShaderHost.report(JSON.stringify({
          stage: "crawl-probe",
          cfCleared: report.cfCleared,
          pickedShaderId: report.pickedShaderId,
          endpoints: (report.networkEndpoints || []).length,
          attempts: (report.attempts || []).map(function (a) {
            return a.id + "=" + a.status + (a.summary && a.summary.parsed ? "(json)" : "");
          })
        }));
      }
    } catch (err) { /* 宿主不可用时忽略 */ }
    // ② 把页面换成可复制的文本，用户直接长按拷走
    try {
      document.body.setAttribute("style", STYLE);
      document.body.textContent = text;
      document.title = "CRAWL-PROBE-DONE";
    } catch (err) { /* 忽略 */ }
  }

  report.attempts = [];

  function tryOne(index) {
    if (index >= candidates.length) { finish(); return; }
    var c = candidates[index];
    var init = { method: c.method, credentials: "include" };
    if (c.body) {
      init.body = c.body;
      init.headers = { "Content-Type": c.contentType };
    }
    var record = { id: c.id, method: c.method, path: c.path, body: c.body, status: null };
    var started = Date.now();
    fetch(c.path + (c.method === "GET" ? "" : ""), init)
      .then(function (res) {
        record.status = res.status;
        record.contentType = res.headers.get("content-type");
        record.ms = Date.now() - started;
        return res.text();
      })
      .then(function (text) {
        record.length = text.length;
        record.summary = summarize(text);
        report.attempts.push(record);
        tryOne(index + 1);
      })
      .catch(function (err) {
        record.error = String(err && err.message);
        record.ms = Date.now() - started;
        report.attempts.push(record);
        tryOne(index + 1);
      });
  }

  tryOne(0);
  return "crawl-probe started";
})();`;

/** 探测页的目标地址：列表页，保证有 shader 链接、也保证站点会发数据请求。 */
export const SHADERTOY_ORIGIN = "https://www.shadertoy.com";
export const SHADERTOY_PROBE_URL = SHADERTOY_ORIGIN + "/browse";
