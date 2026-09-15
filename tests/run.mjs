#!/usr/bin/env node
/**
 * P0 离线自检跑批器
 *
 * 跑两个页面，都使用 headless Chromium（SwiftShader）：
 *   页面 A「deck 装配/渲染」：断言真实像素，证明 GLSL1 / GLSL3 / Common / 纹理通道四条路径成立
 *   页面 B「宿主握手」：模拟宿主行为（注入 ShaderHost → 注入 deck → __runnerLoad），
 *                        证明 ToolPkg 侧那套调用约定真的能跑通
 *
 * 同时把 src/deck/shader-deck.js 拷进 .tmp/ 供页面 A 用 —— 两个页面跑的都是源文件本身。
 *
 * 用法： node tests/run.mjs
 * 这是开发期验证，不是运行期依赖 —— 运行期 100% 在安卓。
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DECK_SRC = join(ROOT, "src/deck/shader-deck.js");
/** 编译后的自包含 HTML（deck 在编译期内联）—— 页面 B 跑的就是它。 */
const EMBEDDED_JS = join(ROOT, "dist/deck/embedded.js");
if (!existsSync(EMBEDDED_JS)) {
  console.error("✗ 找不到 dist/deck/embedded.js，先跑 npx tsc");
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { SELF_CONTAINED_HTML } = require(EMBEDDED_JS);
const TMP = join(ROOT, ".tmp");
const CANVAS = 64;

// 4x4 RGBA：texel(0,0)=红 texel(2,2)=绿 texel(3,3)=蓝，其余灰。
// 注意：手工构造 PNG 时每个像素必须恰好 4 字节。早先版本多推了一个字节导致 alpha=0，
// 整个纹理解成全透明，表现为「采样恒为纯黑」。
const CHECKER_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAH0lEQVR4nGP4z8DwPyAgAI4ZkDkoAgz/GTBVAHX/BwARax8enytO9AAAAABJRU5ErkJggg==";

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const base = join(homedir(), ".cache/ms-playwright");
  if (!existsSync(base)) {
    throw new Error("找不到 playwright 缓存目录，设置 CHROME_BIN 或先装浏览器");
  }
  for (const dir of readdirSync(base)
    .filter((d) => d.startsWith("chromium-"))
    .sort()
    .reverse()) {
    for (const sub of ["chrome-linux64", "chrome-linux"]) {
      const p = join(base, dir, sub, "chrome");
      if (existsSync(p)) return p;
    }
  }
  throw new Error("找不到 chromium 可执行文件，请设置 CHROME_BIN");
}

const FIXTURES = [
  "glsl1-plain.json",
  "glsl3-plain.json",
  "common-texture.json",
].map((f) => ({
  file: f,
  json: JSON.parse(readFileSync(join(ROOT, "tests/fixtures", f), "utf8")),
}));

// 负例：不需要 GL，验证 D3 的过滤逻辑真的会拒绝不该进来的 shader
const NEGATIVE = [
  {
    name: "multi-pass(buffer) 必须被拒绝",
    shader: {
      renderpass: [
        {
          type: "buffer",
          code: "void mainImage(out vec4 c, in vec2 f){c=vec4(0.);}",
        },
        {
          type: "image",
          code: "void mainImage(out vec4 c, in vec2 f){c=vec4(0.);}",
        },
      ],
    },
    expectErrorIncludes: "buffer",
  },
  {
    name: "没有 image pass 必须被拒绝",
    shader: {
      renderpass: [{ type: "common", code: "float x(){return 1.0;}" }],
    },
    expectErrorIncludes: "image",
  },
  {
    name: "image pass 里没有 mainImage 必须被拒绝",
    shader: { renderpass: [{ type: "image", code: "void main(){ }" }] },
    expectErrorIncludes: "main",
  },
];

function buildDeckPage() {
  return `<!doctype html>
<html><body>
<canvas id="gl" width="${CANVAS}" height="${CANVAS}"></canvas>
<pre id="status"></pre>
<pre id="out">pending</pre>
<script src="runner.js"></script>
<script>
(function () {
  var CHECKER = ${JSON.stringify(CHECKER_URI)};
  var FIXTURES = ${JSON.stringify(FIXTURES)};
  var NEGATIVE = ${JSON.stringify(NEGATIVE.map((n) => ({ name: n.name, shader: n.shader, expectErrorIncludes: n.expectErrorIncludes })))};

  var results = [];
  function rec(name, ok, detail) { results.push({ name: name, ok: !!ok, detail: detail || '' }); }
  function fmt(px) { return '(' + px.r.toFixed(3) + ',' + px.g.toFixed(3) + ',' + px.b.toFixed(3) + ')'; }
  function finish() {
    var failed = results.filter(function (r) { return !r.ok; }).length;
    document.getElementById('out').textContent =
      encodeURIComponent(JSON.stringify({ total: results.length, failed: failed, results: results }));
    document.title = failed ? 'FAIL' : 'PASS';
  }

  // ---- 负例（不需要 GL） ----
  NEGATIVE.forEach(function (n) {
    var asm;
    try { asm = window.ShaderDeck.assemble(n.shader); }
    catch (e) { rec(n.name, false, 'assemble 抛异常: ' + e.message); return; }
    var joined = (asm.errors || []).join(' | ');
    var ok = !asm.ok && joined.toLowerCase().indexOf(n.expectErrorIncludes.toLowerCase()) >= 0;
    rec(n.name, ok, 'ok=' + asm.ok + ' errors=' + joined);
  });

  // ---- 正例：真渲染 + 真读像素 ----
  var canvas = document.getElementById('gl');
  var deck;
  try {
    deck = window.ShaderDeck.create(canvas, {});
  } catch (e) {
    rec('创建 WebGL 上下文', false, e.message);
    finish();
    return;
  }

  var gl = deck.gl;
  var dbg = gl.getExtension('WEBGL_debug_renderer_info');
  rec('WebGL 版本', true, gl.getParameter(gl.VERSION));
  rec('渲染器', true, dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'n/a');

  function px(buf, x, y) {
    var i = (y * buf.width + x) * 4;
    return { r: buf.data[i] / 255, g: buf.data[i + 1] / 255, b: buf.data[i + 2] / 255, a: buf.data[i + 3] / 255 };
  }

  function assertGradient(tag, buf) {
    var c00 = px(buf, 0, 0);
    var c11 = px(buf, buf.width - 1, buf.height - 1);
    var mid = px(buf, Math.floor(buf.width / 2), 0);
    var low = px(buf, 2, 0);
    var high = px(buf, buf.width - 1, 0);
    rec(tag + ' 左下角≈(0,0,0.25)', c00.r < 0.05 && c00.g < 0.05 && Math.abs(c00.b - 0.25) < 0.02, fmt(c00));
    rec(tag + ' 右上角≈(1,1,0.25)', c11.r > 0.95 && c11.g > 0.95 && Math.abs(c11.b - 0.25) < 0.02, fmt(c11));
    rec(tag + ' 横向单调递增', mid.r > low.r && high.r > mid.r, fmt(low) + ' < ' + fmt(mid) + ' < ' + fmt(high));
  }

  function assertSplit(tag, buf) {
    var y = Math.floor(buf.height / 2);
    var left = px(buf, 4, y);
    var mid = px(buf, Math.floor(buf.width / 2), y);
    var right = px(buf, buf.width - 5, y);
    rec(tag + ' 左区=纹理 texel(0,0) 红', left.r > 0.9 && left.g < 0.1 && left.b < 0.1, fmt(left));
    rec(tag + ' 中区=纹理 texel(2,2) 绿', mid.g > 0.9 && mid.r < 0.1 && mid.b < 0.1, fmt(mid));
    rec(tag + ' 右区=纹理 texel(3,3) 蓝', right.b > 0.9 && right.r < 0.1 && right.g < 0.1, fmt(right));
  }

  function run(i) {
    if (i >= FIXTURES.length) { deck.dispose(); finish(); return; }
    var fx = FIXTURES[i];
    var tag = '[' + fx.file + ']';
    var opts = { textures: { 0: CHECKER } };

    deck.load(fx.json, opts).then(function (res) {
      rec(tag + ' load 成功', res.ok, (res.errors || []).join(' | '));
      if (res.warnings && res.warnings.length) rec(tag + ' 有警告（仅记录）', true, res.warnings.join('; '));
      if (!res.ok) { run(i + 1); return; }

      var expectGLSL3 = /glsl3/.test(fx.file);
      rec(tag + ' isGLSL3=' + expectGLSL3, res.isGLSL3 === expectGLSL3, '实际=' + res.isGLSL3);

      var r = deck.renderOnce(0);
      rec(tag + ' renderOnce', r.ok, (r.errors || []).join(' | '));
      if (!r.ok) { run(i + 1); return; }

      var buf = deck.readPixels();
      if (/common-texture/.test(fx.file)) assertSplit(tag, buf);
      else assertGradient(tag, buf);

      run(i + 1);
    }).catch(function (err) {
      rec(tag + ' load 抛异常', false, String(err && err.message || err));
      run(i + 1);
    });
  }

  run(0);
})();
</script>
</body></html>`;
}

/**
 * 页面 B：跑**真正要发布的那一页** —— dist/deck/embedded.js 里的自包含 HTML。
 *
 * 这里踩过一次教训：旧版把 resources/webview/runner.html 与相对引用的 runner.js 拷进
 * 同一个目录、用 file:// 跑，测试全绿；而真机走的是「虚拟域 + 资源拦截」那条路，
 * 实测直接 net::ERR_CONNECTION_CLOSED —— 测试覆盖的是另一条路，于是给了虚假信心。
 * 现在两者合成一个字符串，测试与发布产物是**同一份内容**。
 *
 * 顺序与 ToolPkg 外壳一致：先注入 ShaderHost，再让 deck 脚本自己加载，最后 __runnerLoad。
 */
function buildRunnerTestPage() {
  const real = SELF_CONTAINED_HTML;

  // 自包含是这个页面的**核心性质**：任何外链都意味着又一次「真机去网络上找」。
  const withoutComments = real.replace(/<!--[\s\S]*?-->/g, "");
  const external =
    withoutComments.match(/(src|href)\s*=\s*["'](?!data:)[^"']+["']/gi) || [];
  if (external.length > 0) {
    throw new Error(`自包含 HTML 里仍有外链：${external.join(", ")}`);
  }

  // 宿主：ComposeWebViewController.addJavascriptInterface("ShaderHost", {...})
  // 必须在 deck 脚本之前注入，否则 deck 的 ready() 回调会落空。
  const hostStub = `<script>
  window.__host = { ready: 0, reports: [], swipes: [] };
  window.ShaderHost = {
    ready: function () { window.__host.ready++; },
    report: function (json) { window.__host.reports.push(json); },
    swipe: function (json) { window.__host.swipes.push(json); }
  };
</script>
`;

  const driver = `<pre id="out">pending</pre>
<script>
(function () {
  var FIXTURE = ${JSON.stringify(FIXTURES[0].json)};
  var results = [];
  function rec(n, ok, d) { results.push({ name: n, ok: !!ok, detail: d || '' }); }
  function finish(failed) {
    document.getElementById('out').textContent =
      encodeURIComponent(JSON.stringify({ total: results.length, failed: failed, results: results }));
    document.title = failed ? 'FAIL' : 'PASS';
  }

  // 页面里的 deck 必须是**内联**跑起来的，否则真机上就是一片空白
  rec('自包含 HTML 里的 deck 已执行（内联，无外链）', typeof window.ShaderDeck === 'object' && !!window.ShaderDeck.VERSION, String(window.ShaderDeck && window.ShaderDeck.VERSION));
  rec('页面提供了 #gl', !!document.getElementById('gl'), '');
  rec('页面提供了 #status', !!document.getElementById('status'), '');
  rec('deck 加载后自动回调 ShaderHost.ready()', window.__host.ready === 1, 'ready=' + window.__host.ready);
  rec('__runnerLoad 已暴露', typeof window.__runnerLoad === 'function', typeof window.__runnerLoad);

  if (typeof window.__runnerLoad !== 'function') { finish(results.length); return; }

  window.__runnerLoad(FIXTURE, {}).then(function (res) {
    rec('__runnerLoad 返回 ok', res && res.ok === true, JSON.stringify(res && res.errors));
    rec('stage=running', res && res.stage === 'running', String(res && res.stage));

    var st = document.getElementById('status').textContent || '';
    rec('状态条显示「渲染中」', st.indexOf('渲染中') >= 0, st.split(String.fromCharCode(10))[0]);
    rec('状态条含 GLSL 版本', /GLSL[13]/.test(st), st.split(String.fromCharCode(10))[0]);

    var reports = window.__host.reports.map(function (s) {
      try { return JSON.parse(s); } catch (e) { return {}; }
    });
    rec('宿主收到 report', reports.length > 0, 'n=' + reports.length);
    rec('report 含 running 事件', !!reports.filter(function (r) { return r.stage === 'running'; })[0], JSON.stringify(reports[0] || null));

    // D4 的画质旋钮是「产品能不能用」的分界线，所以必须验证它真的改变了绘图缓冲区，
    // 而不是只验证返回值变了。
    var dbg0 = window.__runnerDebug();
    rec('__runnerDebug 吐出了布局/缓冲区/dpr',
      !!dbg0 && Array.isArray(dbg0.drawingBuffer) && Array.isArray(dbg0.css),
      JSON.stringify(dbg0));
    if (dbg0) {
      var wantDefaultW = Math.round(dbg0.css[0] * dbg0.dpr * 0.75);
      rec('默认画质档就是 0.75（D4 规定）且已落到 drawingBuffer',
        dbg0.qualityScale === 0.75 && dbg0.drawingBuffer[0] === wantDefaultW,
        'scale=' + dbg0.qualityScale + ' buffer=' + JSON.stringify(dbg0.drawingBuffer) + ' 期望宽=' + wantDefaultW);
    }

    var scaleChecks = [];
    [1.0, 0.75, 0.5].forEach(function (s) {
      var ret = window.__runnerScale(s);
      var dbg = window.__runnerDebug();
      var wantW = Math.round(dbg.css[0] * dbg.dpr * s);
      var wantH = Math.round(dbg.css[1] * dbg.dpr * s);
      scaleChecks.push({
        s: s,
        ok: ret === s && dbg.drawingBuffer[0] === wantW && dbg.drawingBuffer[1] === wantH,
        got: dbg.drawingBuffer,
        want: [wantW, wantH]
      });
    });
    rec('画质档 1.0/0.75/0.5 都真的改变了 drawingBuffer',
      scaleChecks.every(function (c) { return c.ok; }),
      JSON.stringify(scaleChecks));
    rec('__runnerPause 可用（D4 不可见即停）', window.__runnerPause() === true, '');
    rec('__runnerResume 可用', window.__runnerResume() === true, '');
    rec('__runnerStop 可用', window.__runnerStop() === true, '');
    var stats = window.__runnerStats();
    rec('__runnerStats 有结构', !!stats && typeof stats.fps === 'number', JSON.stringify(stats));

    // ---- P3b：页面侧滑动检测（合成 pointer 事件，这一块是能在本地真测的）----
    function fire(type, x, y) {
      document.dispatchEvent(new PointerEvent(type, {
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'touch'
      }));
    }
    function doSwipe(fromY, toY, fromX, toX) {
      var x0 = fromX === undefined ? 100 : fromX;
      var x1 = toX === undefined ? 100 : toX;
      fire('pointerdown', x0, fromY);
      fire('pointermove', x1, toY);
      fire('pointerup', x1, toY);
      var list = window.__host.swipes;
      return list.length ? JSON.parse(list[list.length - 1]) : {};
    }
    var swipeCount = function () { return window.__host.swipes.length; };

    var n0 = swipeCount();
    var upInfo = doSwipe(500, 200);
    rec('上滑被识别并上报给宿主', swipeCount() === n0 + 1, JSON.stringify(upInfo));
    rec('上滑 direction=up 且 dy 为正', upInfo.direction === 'up' && upInfo.dy > 0, JSON.stringify(upInfo));

    var n1 = swipeCount();
    var downInfo = doSwipe(200, 500);
    rec('下滑 direction=down', swipeCount() === n1 + 1 && downInfo.direction === 'down', JSON.stringify(downInfo));

    var n2 = swipeCount();
    doSwipe(500, 470);
    rec('小幅拖动不算滑动（防误触）', swipeCount() === n2, 'swipes=' + swipeCount());

    var n3 = swipeCount();
    doSwipe(300, 300, 100, 400);
    rec('横向拖动不算滑动', swipeCount() === n3, 'swipes=' + swipeCount());

    var n4 = swipeCount();
    doSwipe(500, 200, 100, 300);
    rec('斜向拖动（纵向>横向）仍算上滑', swipeCount() === n4 + 1, 'swipes=' + swipeCount());

    rec('滑动记录留在页面侧（__swipeLog，用于诊断）',
      Array.isArray(window.__swipeLog) && window.__swipeLog.length >= 3,
      String(window.__swipeLog && window.__swipeLog.length));

    finish(results.filter(function (r) { return !r.ok; }).length);
  }).catch(function (e) {
    rec('__runnerLoad 抛异常', false, String(e && e.message || e));
    finish(results.length);
  });
})();
</script>`;

  // 按字面字符串注入必须用 lastIndexOf 找 body 结束标签：
  // 第一个匹配可能落在注释或脚本字符串里（这个坑真的踩过一次，DOM 直接被插乱）。
  const headEnd = real.indexOf("</head>");
  const bodyEnd = real.lastIndexOf("</body>");
  if (headEnd < 0 || bodyEnd < 0) {
    throw new Error("自包含 HTML 结构不符预期：找不到 head 或 body 的结束位置");
  }
  return (
    real.slice(0, headEnd) +
    hostStub +
    real.slice(headEnd, bodyEnd) +
    driver +
    real.slice(bodyEnd)
  );
}

function dumpPage(chrome, pagePath, budgetMs) {
  const dom = execFileSync(
    chrome,
    [
      "--headless",
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--hide-scrollbars",
      `--virtual-time-budget=${budgetMs}`,
      "--dump-dom",
      `file://${pagePath}`,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  const m = dom.match(/<pre id="out">([^<]*)<\/pre>/);
  if (!m || m[1] === "pending") {
    console.error(`✗ ${pagePath} 没有产出结果（页面脚本可能崩了）。DOM 片段：`);
    console.error(dom.slice(0, 2000));
    process.exit(2);
  }
  return JSON.parse(decodeURIComponent(m[1]));
}

/**
 * 页面 C：播放回路 soak。
 *
 * P0 验收里有一条「跑满 30 秒不掉帧」，而在此之前**播放回路本身**
 * （限帧、暂停语义、stop 是不是真的停、播放中改画质档）一个测试都没有。
 * 这些恰好是设备上出问题时最难查的一类。
 *
 * 驱动方式：**不用 rAF**。实测无头 Chromium 的虚拟时间下 rAF 基本不触发（只出了 2 帧），
 * 靠它测就等于测了个空气。改为用受控时间戳调 `deck.stepFrame()` ——
 * 那是 rAF 回调内部调的同一个函数，所以验证的就是真跑的那份逻辑。
 */
function buildSoakPage() {
  return `<!doctype html>
<html><body>
<canvas id="gl" style="width:200px;height:150px"></canvas>
<pre id="out">pending</pre>
<script src="runner.js"></script>
<script>
(function () {
  var FIXTURE = ${JSON.stringify(FIXTURES[0].json)};
  var results = [];
  function rec(name, ok, detail) { results.push({ name: name, ok: !!ok, detail: detail || '' }); }
  function finish() {
    var failed = results.filter(function (r) { return !r.ok; }).length;
    document.getElementById('out').textContent =
      encodeURIComponent(JSON.stringify({ total: results.length, failed: failed, results: results }));
    document.title = failed ? 'FAIL' : 'PASS';
  }

  var canvas = document.getElementById('gl');
  var deck = window.ShaderDeck.create(canvas, {});
  var snaps = {};
  function snap() {
    var s = deck.stats();
    s.buffer = [deck.gl.drawingBufferWidth, deck.gl.drawingBufferHeight];
    return s;
  }

  deck.load(FIXTURE).then(function (res) {
    rec('载入成功', res.ok, (res.errors || []).join(' | '));
    if (!res.ok) { finish(); return; }

    deck.start({ timeOffset: 5 });
    rec('start 后 running 为真', deck.stats().running === true, String(deck.stats().running));

    // 无头 Chromium 的虚拟时间下 rAF 基本不触发（实测只出了 2 帧），
    // 所以用受控时间戳直接驱动渲染循环的「一拍」—— 它和 rAF 回调是同一个函数。
    var t = 1000;
    function pump(times, gapMs) {
      for (var k = 0; k < times; k++) {
        t += gapMs;
        deck.stepFrame(t);
      }
    }

    pump(30, 17);
    snaps.a = snap();
    pump(60, 17);
    snaps.b = snap();

    // 限帧：紧接着再来一拍（间隔 1ms，远小于 60fps 的 16.7ms）应被挡掉
    snaps.capped = deck.stepFrame(t + 1);

    deck.setScale(0.5);
    snaps.scaleAfter = [deck.gl.drawingBufferWidth, deck.gl.drawingBufferHeight];
    pump(60, 17);
    snaps.d = snap();

    deck.pause();
    snaps.e0 = snap();
    pump(30, 17);
    snaps.e = snap();

    deck.resume();
    pump(30, 17);
    snaps.f = snap();

    deck.stop();
    snaps.g0 = snap();
    pump(30, 17);
    snaps.g = snap();

    check();
  }).catch(function (e) {
    rec('load 抛异常', false, String(e && e.message || e));
    finish();
  });

  function check() {
    rec('渲染循环在出帧', snaps.b.frames > snaps.a.frames,
      snaps.a.frames + ' → ' + snaps.b.frames);
    rec('iTime 在推进', snaps.b.time > snaps.a.time,
      snaps.a.time + ' → ' + snaps.b.time);
    rec('timeOffset 生效（起点 >= 5s）', snaps.a.time >= 5, String(snaps.a.time));
    rec('默认画质档 0.75 已落在缓冲区（200×0.75）', snaps.a.buffer[0] === 150,
      JSON.stringify(snaps.a.buffer));
    rec('限帧生效（间隔不足的一拍被挡掉）', snaps.capped === false, String(snaps.capped));
    rec('播放中改画质档：缓冲区真的变了（200×0.5）', snaps.scaleAfter[0] === 100,
      JSON.stringify(snaps.scaleAfter));
    rec('改档后循环没断（帧数继续涨）', snaps.d.frames > snaps.b.frames,
      snaps.b.frames + ' → ' + snaps.d.frames);
    rec('暂停后不再出帧（D4：不可见即停）', snaps.e.frames === snaps.e0.frames,
      snaps.e0.frames + ' → ' + snaps.e.frames);
    rec('恢复后继续出帧', snaps.f.frames > snaps.e.frames,
      snaps.e.frames + ' → ' + snaps.f.frames);
    rec('恢复后 iTime 从暂停处继续（不跳回起点）', snaps.f.time >= snaps.e.time - 0.05,
      snaps.e.time + ' → ' + snaps.f.time);
    rec('停止后彻底不再出帧', snaps.g.frames === snaps.g0.frames,
      snaps.g0.frames + ' → ' + snaps.g.frames);
    rec('停止后 running 为假', snaps.g.running === false, String(snaps.g.running));

    deck.dispose();
    finish();
  }
})();
</script>
</body></html>`;
}

/**
 * 页面 D：宿主**晚到** —— 真机失败的原样复现。
 *
 * 宿主是在 onPageStarted / onPageFinished 里才安装 JS 接口的
 * （见 Operit 的 ToolPkgComposeDslWebView.kt），而页面脚本在解析阶段就跑完了。
 * 旧版 deck 只在脚本末尾查一次 window.ShaderHost，必然扑空 —— 真机上就表现成
 * 「框里只有一句『没有收到宿主握手』」。
 *
 * 这一页把 ShaderHost 推迟 300ms 才注入，断言：① 轮询能完成握手；
 * ② 握手后能真的收到 shader（而不是只握了个手）。
 */
function buildLateHostPage() {
  const real = SELF_CONTAINED_HTML;
  const fixture = JSON.stringify(FIXTURES[0].json);
  const hostStub = `<script>
  window.__host = { ready: 0, reports: [], loadOk: null };
  // 300ms 后才出现 —— 模拟宿主在页面加载完成后才安装 bridge。
  window.setTimeout(function () {
    window.ShaderHost = {
      ready: function () {
        window.__host.ready++;
        window.__runnerLoad(${fixture}, { timeOffset: 0 }).then(function (res) {
          window.__host.loadOk = !!(res && res.ok);
        });
      },
      report: function (json) { window.__host.reports.push(json); },
      swipe: function () { return true; }
    };
  }, 300);
</script>
`;
  const driver = `<pre id="out">pending</pre>
<script>
(function () {
  var results = [];
  function rec(n, ok, d) { results.push({ name: n, ok: !!ok, detail: d || '' }); }
  window.setTimeout(function () {
    rec('晚到的 ShaderHost 仍被握手（旧版在这里必然扑空）', window.__host.ready >= 1, 'ready=' + window.__host.ready);
    rec('握手后真的收到了 shader（不是只握了个手）', window.__host.loadOk === true, String(window.__host.loadOk));
    var failed = 0;
    for (var i = 0; i < results.length; i++) { if (!results[i].ok) failed++; }
    document.getElementById('out').textContent = encodeURIComponent(JSON.stringify({ total: results.length, failed: failed, results: results }));
    document.title = failed ? 'FAIL' : 'PASS';
  }, 2500);
})();
</script>`;
  const headEnd = real.indexOf("</head>");
  const bodyEnd = real.lastIndexOf("</body>");
  if (headEnd < 0 || bodyEnd < 0) {
    throw new Error("自包含 HTML 结构不符预期：找不到 head 或 body 的结束位置");
  }
  return (
    real.slice(0, headEnd) +
    hostStub +
    real.slice(headEnd, bodyEnd) +
    driver +
    real.slice(bodyEnd)
  );
}

/**
 * 页面 E：**完全没有宿主**，payload 内联在 HTML 里 —— 真机现在的场景。
 *
 * 真机上 JS bridge 挂不上（宿主在 onPageStarted / onPageFinished 才安装，而页面脚本在
 * 解析阶段就跑完了；实测等了 10 秒 ShaderHost 也没出现），所以「握手」这条路根本不能依赖。
 * 现在的设计不靠它：界面把 payload 直接字符串替换进 HTML（window.__pendingShader），
 * 页面一解析完就渲染；回执走 console.log，由宿主的 onConsoleMessage 收。
 *
 * 这一页**故意不注入任何 ShaderHost**，断言：
 *   ① deck 仍然把 shader 编译并渲染出来；② 回执经 console 发了出来。
 */
function buildNoHostPage() {
  const html = SELF_CONTAINED_HTML.replace(
    '/*__PENDING_SHADER__*/null',
    () => JSON.stringify(FIXTURES[0].json),
  );
  // 在 deck 之前把 console.log 接管，模拟宿主的 onConsoleMessage。
  const capture = `<script>
  window.__console = [];
  (function () {
    var original = console.log;
    console.log = function () {
      try { window.__console.push(Array.prototype.join.call(arguments, ' ')); } catch (e) {}
      if (original) original.apply(console, arguments);
    };
  })();
</script>
`;
  const driver = `<pre id="out">pending</pre>
<script>
(function () {
  var results = [];
  function rec(n, ok, d) { results.push({ name: n, ok: !!ok, detail: d || '' }); }
  window.setTimeout(function () {
    var lines = window.__console.filter(function (l) { return l.indexOf('[shader-report] ') >= 0; });
    var reports = lines.map(function (l) { return JSON.parse(l.slice(l.indexOf('[shader-report] ') + 16)); });
    var stages = reports.map(function (r) { return r.stage; });
    var stats = reports.filter(function (r) { return r.stage === 'stats'; });

    rec('这一页确实没有 ShaderHost（就是在测无 bridge 路径）', typeof window.ShaderHost === 'undefined', typeof window.ShaderHost);
    rec('deck 已执行', typeof window.ShaderDeck === 'object', String(window.ShaderDeck));
    rec('收到了经 console 发来的回执', lines.length > 0, 'lines=' + lines.length);
    rec('回执里有 running（说明编译成功）', stages.indexOf('running') >= 0, JSON.stringify(stages));
    rec('已经在出帧（stats 且 frames>0）', stats.length > 0 && stats[stats.length - 1].frames > 0, JSON.stringify(stats[stats.length - 1] || null));

    var failed = 0;
    for (var i = 0; i < results.length; i++) { if (!results[i].ok) failed++; }
    document.getElementById('out').textContent = encodeURIComponent(JSON.stringify({ total: results.length, failed: failed, results: results }));
    document.title = failed ? 'FAIL' : 'PASS';
  }, 2500);
})();
</script>`;
  const headEnd = html.indexOf('</head>');
  const bodyEnd = html.lastIndexOf('</body>');
  if (headEnd < 0 || bodyEnd < 0) {
    throw new Error('自包含 HTML 结构不符预期：找不到 head 或 body 的结束位置');
  }
  return html.slice(0, headEnd) + capture + html.slice(headEnd, bodyEnd) + driver + html.slice(bodyEnd);
}

function main() {
  mkdirSync(TMP, { recursive: true });
  copyFileSync(DECK_SRC, join(TMP, "runner.js"));
  console.log("→ 已拷 deck 到 .tmp/runner.js");

  const chrome = findChrome();

  // 页面 B 跑的是 dist/deck/embedded.js 里的自包含 HTML（deck 已内联），
  // 不需要任何配套文件 —— 这正是它与真机一致的地方。
  copyFileSync(join(ROOT, "src/deck/shader-deck.js"), join(TMP, "runner.js"));
  const pages = [
    ["页面 A · deck 装配与渲染", "harness.html", buildDeckPage(), 10000],
    [
      "页面 B · 自包含 HTML + 宿主握手",
      "runner-pageB.html",
      buildRunnerTestPage(),
      12000,
    ],
    ["页面 C · 播放回路 soak", "harness-soak.html", buildSoakPage(), 20000],
    [
      "页面 D · 宿主晚到（真机失败复现）",
      "runner-pageD.html",
      buildLateHostPage(),
      6000,
    ],
    [
      "页面 E · 无宿主 + 内联 payload（真机现况）",
      "runner-pageE.html",
      buildNoHostPage(),
      6000,
    ],
  ];

  const all = [];
  for (const [label, name, html, budget] of pages) {
    console.log(`\n── ${label} ──`);
    const pagePath = join(TMP, name);
    writeFileSync(pagePath, html);
    const payload = dumpPage(chrome, pagePath, budget);
    const w = Math.max(...payload.results.map((r) => r.name.length));
    for (const r of payload.results) {
      console.log(`  ${r.ok ? "✓" : "✗"} ${r.name.padEnd(w)}  ${r.detail}`);
    }
    all.push(...payload.results);
  }

  const failed = all.filter((r) => !r.ok);
  console.log(`\n${all.length - failed.length}/${all.length} 通过`);
  if (failed.length) {
    console.error(`✗ ${failed.length} 项失败`);
    process.exit(1);
  }
  console.log(
    "✓ P0 验收（①WebGL2 ②GLSL1+GLSL3 ③Common ④纹理通道 ⑤宿主握手）全部通过",
  );
}

main();
