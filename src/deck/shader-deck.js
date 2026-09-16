/**
 * Operit Shader Feed — Shadertoy 兼容层（deck）
 *
 * 把 Shadertoy 的 shader JSON 变成可在 WebGL 里渲染的程序。
 * Shadertoy 的 GLSL 不是 WebGL 的 GLSL，中间有一整套注入层，本文件就是那层。
 *
 * 只支持单 pass（image）+ Common + 图片纹理通道 —— 见 PLAN.md §4 D3。
 *
 * 该文件有两个使用场景，两者都是纯浏览器脚本，没有模块系统：
 *   1. 宿主读 resources/webview/runner.js 后 evaluateJavascript 注入进 WebView
 *   2. tests/run.mjs 用 <script src> 载入同一个文件（测的就是要发布的那个文件）
 *
 * @version 0.1.0
 */
(() => {
  var DECK_VERSION = "0.1.0";

  var CHANNEL_COUNT = 4;
  var GLSL3_RE = /^\s*#version\s+300\s+es\b/m;
  var HAS_VERSION_RE = /^\s*#version\b.*$/m;
  var HAS_MAINIMAGE_RE = /\bvoid\s+mainImage\s*\(/;
  var HAS_MAIN_RE = /\bvoid\s+main\s*\(/;

  // ---------------------------------------------------------------- 源码装配

  /** 取出 renderpass 数组。兼容 API v1 的 {Shader:{...}} 外壳。 */
  function getRenderpass(shader) {
    var s = shader && (shader.Shader || shader);
    var passes = (s && s.renderpass) || [];
    if (!Array.isArray(passes)) return [];
    return passes.filter((p) => p && typeof p.code === "string");
  }

  /** 兼容 API v1 的 info 外壳。 */
  function getInfo(shader) {
    var s = shader && (shader.Shader || shader);
    return (s && s.info) || {};
  }

  function stripVersionDirective(code) {
    return String(code).replace(HAS_VERSION_RE, "");
  }

  function uniformBlock() {
    return [
      "uniform vec3  iResolution;",
      "uniform float iTime;",
      "uniform float iTimeDelta;",
      "uniform float iFrameRate;",
      "uniform int   iFrame;",
      "uniform vec4  iMouse;",
      "uniform vec4  iDate;",
      "uniform vec3  iChannelResolution[" + CHANNEL_COUNT + "];",
      "uniform float iChannelTime[" + CHANNEL_COUNT + "];",
      "uniform sampler2D iChannel0;",
      "uniform sampler2D iChannel1;",
      "uniform sampler2D iChannel2;",
      "uniform sampler2D iChannel3;",
    ].join("\n");
  }

  function glsl1Preamble() {
    return [
      "precision highp float;",
      "precision highp int;",
      "precision mediump sampler2D;",
      uniformBlock(),
      // 很多标称 GLSL1 的 shader 实际上写的是 texture()。两个 #define 未被使用时完全无害，
      // 被使用时则是唯一能让它们编译通过的东西。
      "#define texture texture2D",
      "#define textureLod texture2DLod",
    ].join("\n");
  }

  function glsl3Preamble() {
    return [
      "#version 300 es",
      "precision highp float;",
      "precision highp int;",
      uniformBlock(),
      "out vec4 outColor;",
      // GLSL3 没有 gl_FragColor；部分 shader 仍会直接写它。
      "#define gl_FragColor outColor",
    ].join("\n");
  }

  var VERTEX_GLSL1 =
    "attribute vec2 aPos;\nvoid main(){ gl_Position = vec4(aPos, 0.0, 1.0); }\n";
  var VERTEX_GLSL3 =
    "#version 300 es\nin vec2 aPos;\nvoid main(){ gl_Position = vec4(aPos, 0.0, 1.0); }\n";

  /**
   * 把 shader JSON 装配成可编译的 fragment source。
   * @returns {{ok:boolean, isGLSL3?:boolean, source?:string, image?:object, common?:object,
   *            imageInputs?:Array, warnings:string[], errors:string[]}}
   */
  function assemble(shader) {
    var warnings = [];
    var errors = [];
    var passes = getRenderpass(shader);

    if (!passes.length) {
      return {
        ok: false,
        warnings: warnings,
        errors: ["renderpass 为空或格式不可识别"],
      };
    }

    var common = null;
    var image = null;
    for (var i = 0; i < passes.length; i++) {
      var t = String(passes[i].type || "").toLowerCase();
      if (t === "common" && !common) common = passes[i];
      else if (t === "image" && !image) image = passes[i];
    }

    if (!image) {
      return { ok: false, warnings: warnings, errors: ["没有 image pass"] };
    }
    if (
      passes.length > 1 &&
      passes.some((p) => String(p.type).toLowerCase() === "buffer")
    ) {
      // D3：多 Buffer 不在 P0 支持范围内。明确报错而不是渲染出错的东西。
      return {
        ok: false,
        warnings: warnings,
        errors: ["含 buffer pass，P0 不支持多 pass"],
      };
    }

    var imageCode = image.code;
    if (!HAS_MAINIMAGE_RE.test(imageCode)) {
      if (HAS_MAIN_RE.test(imageCode)) {
        return {
          ok: false,
          warnings: warnings,
          errors: ["image pass 直接定义了 main()，没有 mainImage()"],
        };
      }
      return {
        ok: false,
        warnings: warnings,
        errors: ["image pass 里找不到 mainImage()"],
      };
    }

    var isGLSL3 = GLSL3_RE.test(imageCode);
    var commonCode = common ? common.code : "";
    if (common && GLSL3_RE.test(commonCode)) {
      warnings.push(
        "Common 里出现了 #version，已剥离（#version 只能在文件最前面）",
      );
    }

    var outAssign = isGLSL3 ? "outColor" : "gl_FragColor";
    var source = [
      isGLSL3 ? glsl3Preamble() : glsl1Preamble(),
      "// ---- Common ----",
      stripVersionDirective(commonCode),
      "// ---- Image ----",
      stripVersionDirective(imageCode),
      "// ---- Deck entry ----",
      "void main() {",
      "  vec4 _deckColor = vec4(0.0, 0.0, 0.0, 1.0);",
      "  mainImage(_deckColor, gl_FragCoord.xy);",
      "  " + outAssign + " = _deckColor;",
      "}",
    ].join("\n");

    var inputs = Array.isArray(image.inputs) ? image.inputs : [];
    var unsupported = [];
    for (var j = 0; j < inputs.length; j++) {
      var ct = String((inputs[j] && inputs[j].ctype) || "").toLowerCase();
      if (ct && ct !== "texture")
        unsupported.push(ct + ":" + inputs[j].channel);
    }
    if (unsupported.length) {
      warnings.push(
        "非图片通道（P0 不支持，将绑定为黑）: " + unsupported.join(", "),
      );
    }

    return {
      ok: true,
      isGLSL3: isGLSL3,
      source: source,
      image: image,
      common: common,
      imageInputs: inputs,
      warnings: warnings,
      errors: errors,
    };
  }

  // ---------------------------------------------------------------- GL 工具

  /** WebGL 的 infoLog 在部分实现里以 NUL 结尾；NUL 不是空白字符，trim() 清不掉，
   * 会在错误列表里留一条「幽灵行」。这里在源头统一剥掉。 */
  function stripNul(text) {
    return String(text == null ? "" : text)
      .split(String.fromCharCode(0))
      .join("");
  }
  
  function compileShader(gl, type, source) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = stripNul(gl.getShaderInfoLog(sh)) || "(空日志)";
      gl.deleteShader(sh);
      return { ok: false, log: log };
    }
    return { ok: true, shader: sh };
  }

  function linkProgram(gl, vsSource, fsSource) {
    var logs = [];
    var vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
    if (!vs.ok) {
      return { ok: false, logs: ["[vertex] " + vs.log] };
    }
    var fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
    if (!fs.ok) {
      gl.deleteShader(vs.shader);
      return { ok: false, logs: ["[fragment] " + fs.log] };
    }
    var prog = gl.createProgram();
    gl.attachShader(prog, vs.shader);
    gl.attachShader(prog, fs.shader);
    gl.linkProgram(prog);
    gl.deleteShader(vs.shader);
    gl.deleteShader(fs.shader);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      logs.push("[link] " + (stripNul(gl.getProgramInfoLog(prog)) || "(空日志)"));
      gl.deleteProgram(prog);
      return { ok: false, logs: logs };
    }
    return { ok: true, program: prog, logs: logs };
  }

  function createContext(canvas) {
    var attrs = {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      // ponytail: P0 期间保持 true，好让测试能同步 draw+readPixels。生产渲染走 rAF
      // 且从不回读，届时可改成 false 省一次拷贝。
      preserveDrawingBuffer: true,
    };
    return (
      canvas.getContext("webgl2", attrs) || canvas.getContext("webgl", attrs)
    );
  }

  function isWebGL2(gl) {
    return !!(gl && gl.texStorage2D);
  }

  function waitForImage(src) {
    return new Promise((resolve, reject) => {
      var img = new Image();
      if (/^https?:/i.test(src)) img.crossOrigin = "anonymous";
      img.onload = () => {
        resolve(img);
      };
      img.onerror = () => {
        reject(new Error("图片加载失败: " + String(src).slice(0, 96)));
      };
      img.src = src;
    });
  }

  function resolveTextureSource(src) {
    if (typeof src === "string") return waitForImage(src);
    // ImageBitmap / HTMLImageElement / HTMLCanvasElement / HTMLVideoElement 直接用
    if (src && (src.width || src.naturalWidth || src.videoWidth))
      return Promise.resolve(src);
    return Promise.reject(new Error("不可识别的纹理源"));
  }

  function samplerParams(sampler) {
    var s = sampler || {};
    var filter = String(s.filter || "linear").toLowerCase();
    var wrap = String(s.wrap || "repeat").toLowerCase();
    var p = {
      wrapS: wrap === "clamp" ? "CLAMP_TO_EDGE" : "REPEAT",
      wrapT: wrap === "clamp" ? "CLAMP_TO_EDGE" : "REPEAT",
      vflip: String(s.vflip) === "true",
      mipmap: filter === "mipmap",
    };
    if (filter === "nearest") {
      p.min = "NEAREST";
      p.mag = "NEAREST";
    } else {
      p.min = "LINEAR";
      p.mag = "LINEAR";
    }
    return p;
  }

  // ------------------------------------------------------------------- Deck

  function createDeck(canvas, options) {
    if (!canvas) throw new Error("createDeck 需要一个 canvas");
    var opts = options || {};
    var gl = createContext(canvas);
    if (!gl) throw new Error("无法创建 WebGL 上下文");

    var deck = {
      version: DECK_VERSION,
      canvas: canvas,
      gl: gl,
      webgl2: isWebGL2(gl),

      program: null,
      isGLSL3: false,
      warnings: [],
      qualityScale:
        typeof opts.qualityScale === "number" ? opts.qualityScale : 0.75,
      targetFps: typeof opts.targetFps === "number" ? opts.targetFps : 60,

      _uniforms: {},
      _textures: new Array(CHANNEL_COUNT),
      _blackTex: null,
      _channels: [],
      _buffer: null,
      _posLoc: -1,
      _running: false,
      _rafId: 0,
      _timeOffset: 0,
      _t0: 0,
      _lastTs: 0,
      _frame: 0,
      _frameRate: 0,
      _lastReportTs: 0,
      _paused: false,
      /** 暂停后需要重对齐时钟基准；由 renderFrame 消费一次。 */
      _resyncAfterPause: false,
      /** 限帧用：最小帧间隔（毫秒）与上一拍的时间戳。 */
      _minInterval: 0,
      _lastTickTs: 0,
    };

    // --- 资源 ---------------------------------------------------------------
    function makeBlackTexture() {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]),
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    }

    function disposeTextures() {
      for (var i = 0; i < CHANNEL_COUNT; i++) {
        var entry = deck._textures[i];
        if (entry && entry.tex) gl.deleteTexture(entry.tex);
        deck._textures[i] = null;
      }
      deck._channels = [];
    }

    function uploadTexture(entry, source, params) {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, params.vflip ? 1 : 0);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        source,
      );
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);

      var minF = params.min === "NEAREST" ? gl.NEAREST : gl.LINEAR;
      var magF = params.mag === "NEAREST" ? gl.NEAREST : gl.LINEAR;
      var wrapS =
        params.wrapS === "CLAMP_TO_EDGE" ? gl.CLAMP_TO_EDGE : gl.REPEAT;
      var wrapT =
        params.wrapT === "CLAMP_TO_EDGE" ? gl.CLAMP_TO_EDGE : gl.REPEAT;

      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magF);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);

      var dims = [
        source.width || source.naturalWidth || 0,
        source.height || source.naturalHeight || 0,
      ];
      var okMip = false;
      if (params.mipmap) {
        // WebGL1 的 mipmap 需要 POT；非 POT 时退回 LINEAR，否则采样结果全黑。
        var pot = (n) => n > 0 && (n & (n - 1)) === 0;
        if (deck.webgl2 || (pot(dims[0]) && pot(dims[1]))) {
          gl.generateMipmap(gl.TEXTURE_2D);
          gl.texParameteri(
            gl.TEXTURE_2D,
            gl.TEXTURE_MIN_FILTER,
            params.min === "NEAREST"
              ? gl.NEAREST_MIPMAP_NEAREST
              : gl.LINEAR_MIPMAP_LINEAR,
          );
          okMip = true;
        }
      }
      if (!okMip) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minF);
      }

      entry.tex = tex;
      entry.res = [dims[0], dims[1]];
      return entry;
    }

    function bindDefaultChannels() {
      for (var i = 0; i < CHANNEL_COUNT; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        var entry = deck._textures[i];
        gl.bindTexture(gl.TEXTURE_2D, (entry && entry.tex) || deck._blackTex);
      }
    }

    // --- uniforms -----------------------------------------------------------
    function cacheUniforms() {
      var names = [
        "iResolution",
        "iTime",
        "iTimeDelta",
        "iFrameRate",
        "iFrame",
        "iMouse",
        "iDate",
        "iChannelResolution[0]",
        "iChannelTime[0]",
        "iChannel0",
        "iChannel1",
        "iChannel2",
        "iChannel3",
        "aPos",
      ];
      deck._uniforms = {};
      for (var i = 0; i < names.length; i++) {
        deck._uniforms[names[i]] = gl.getUniformLocation(
          deck.program,
          names[i],
        );
      }
      // 数组 uniform 在部分驱动上只能按 [0] 拿到首地址，这里统一成一个 location。
      deck._uniforms.iChannelResolution0 =
        deck._uniforms["iChannelResolution[0]"];
      deck._uniforms.iChannelTime0 = deck._uniforms["iChannelTime[0]"];
      deck._uniforms.iResolutionLoc = deck._uniforms.iResolution;
      deck._posLoc = gl.getAttribLocation(deck.program, "aPos");
    }

    function setStaticUniforms() {
      var u = deck._uniforms;
      if (deck._posLoc >= 0) {
        if (!deck._buffer) deck._buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, deck._buffer);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          new Float32Array([-1, -1, 3, -1, -1, 3]),
          gl.STATIC_DRAW,
        );
        gl.enableVertexAttribArray(deck._posLoc);
        gl.vertexAttribPointer(deck._posLoc, 2, gl.FLOAT, false, 0, 0);
      }
      // 通道 → 纹理单元，固定绑定一次即可
      for (var i = 0; i < CHANNEL_COUNT; i++) {
        var loc = u["iChannel" + i];
        if (loc) gl.uniform1i(loc, i);
      }
    }

    function pushFrameUniforms(time, delta) {
      var u = deck._uniforms;
      var w = gl.drawingBufferWidth;
      var h = gl.drawingBufferHeight;

      if (u.iResolution) gl.uniform3f(u.iResolution, w, h, 1.0);
      if (u.iTime) gl.uniform1f(u.iTime, time);
      if (u.iTimeDelta) gl.uniform1f(u.iTimeDelta, delta);
      if (u.iFrameRate) gl.uniform1f(u.iFrameRate, deck._frameRate);
      if (u.iFrame) gl.uniform1i(u.iFrame, deck._frame);
      // iMouse：xy = 当前/最后触点（buffer 像素、y 向上，与 fragCoord 同系）；
      // zw = 本次拖拽起点；按住为正、松开为负（abs(zw) 即起点）。
      if (u.iMouse) {
        var mouse = deck._mouse || { x: 0, y: 0, sx: 0, sy: 0, down: false };
        var mouseSign = mouse.down ? 1 : -1;
        gl.uniform4f(
          u.iMouse,
          mouse.x,
          mouse.y,
          mouse.sx * mouseSign,
          mouse.sy * mouseSign,
        );
      }
      // D4：iDate 固定常量，保证可复现
      if (u.iDate) gl.uniform4f(u.iDate, 2024.0, 1.0, 1.0, 43200.0);

      if (u.iChannelResolution0) {
        var res = new Float32Array(CHANNEL_COUNT * 3);
        for (var i = 0; i < CHANNEL_COUNT; i++) {
          var e = deck._textures[i];
          var r = (e && e.res) || [0, 0];
          res[i * 3] = r[0];
          res[i * 3 + 1] = r[1];
          res[i * 3 + 2] = 1;
        }
        gl.uniform3fv(u.iChannelResolution0, res);
      }
      if (u.iChannelTime0) {
        var ct = new Float32Array(CHANNEL_COUNT);
        for (var j = 0; j < CHANNEL_COUNT; j++) ct[j] = time;
        gl.uniform1fv(u.iChannelTime0, ct);
      }
    }

    // --- 生命周期 -----------------------------------------------------------
    function teardownProgram() {
      if (deck.program) {
        gl.deleteProgram(deck.program);
        deck.program = null;
      }
    }

    /**
     * 载入并编译。
     * @param {object} shader Shadertoy shader JSON
     * @param {{textures?:Object}} [loadOpts] textures: {0: 'data:...' | ImageBitmap}
     */
    deck.load = (shader, loadOpts) => {
      var o = loadOpts || {};
      deck.stop();
      teardownProgram();
      disposeTextures();
      deck.warnings = [];
      deck.isGLSL3 = false;

      var asm = assemble(shader);
      if (!asm.ok) {
        return Promise.resolve({
          ok: false,
          errors: asm.errors,
          warnings: asm.warnings,
          isGLSL3: false,
        });
      }
      deck.warnings = asm.warnings.slice();
      deck.isGLSL3 = asm.isGLSL3;

      if (!deck._blackTex) deck._blackTex = makeBlackTexture();

      // 先按 inputs 建占位条目（无纹理时绑黑），再异步补真实像素。
      var specs = [];
      var inputs = asm.imageInputs;
      for (var i = 0; i < inputs.length; i++) {
        var inp = inputs[i] || {};
        var ch =
          typeof inp.channel === "number"
            ? inp.channel
            : parseInt(inp.channel, 10);
        if (!(ch >= 0 && ch < CHANNEL_COUNT)) continue;
        if (String(inp.ctype || "").toLowerCase() !== "texture") continue;
        var provided = o.textures && o.textures[ch];
        if (provided === undefined || provided === null) continue;
        specs.push({
          channel: ch,
          source: provided,
          params: samplerParams(inp.sampler),
        });
      }

      return Promise.all(
        specs.map((spec) =>
          resolveTextureSource(spec.source)
            .then((src) => ({ spec: spec, src: src }))
            .catch((err) => {
              deck.warnings.push(
                "通道 " + spec.channel + " 纹理失败: " + err.message,
              );
              return null;
            }),
        ),
      ).then((loaded) => {
        for (var k = 0; k < loaded.length; k++) {
          if (!loaded[k]) continue;
          deck._textures[loaded[k].spec.channel] = uploadTexture(
            {},
            loaded[k].src,
            loaded[k].spec.params,
          );
        }

        var linked = linkProgram(
          gl,
          asm.isGLSL3 ? VERTEX_GLSL3 : VERTEX_GLSL1,
          asm.source,
        );
        if (!linked.ok) {
          return {
            ok: false,
            errors: linked.logs,
            warnings: deck.warnings,
            isGLSL3: asm.isGLSL3,
          };
        }

        deck.program = linked.program;
        gl.useProgram(deck.program);
        cacheUniforms();
        setStaticUniforms();
        bindDefaultChannels();

        return {
          ok: true,
          errors: [],
          warnings: deck.warnings,
          isGLSL3: asm.isGLSL3,
          channels: deck._textures.map((e) => (e ? e.res : null)),
        };
      });
    };

    /** 按元素尺寸 × 画质档重设 drawingBuffer 大小。 */
    deck.resize = (cssWidth, cssHeight, scale) => {
      var s = typeof scale === "number" ? scale : deck.qualityScale;
      deck.qualityScale = s;
      var dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      var w = Math.max(
        1,
        Math.round((cssWidth || canvas.clientWidth || 1) * dpr * s),
      );
      var h = Math.max(
        1,
        Math.round((cssHeight || canvas.clientHeight || 1) * dpr * s),
      );
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      return [canvas.width, canvas.height];
    };

    deck.setScale = (scale) => {
      deck.resize(canvas.clientWidth, canvas.clientHeight, scale);
    };

    /** 画一帧并推进时钟。返回实际使用的时间。 */
    deck.renderFrame = (nowMs) => {
      if (!deck.program) return null;
      var now =
        typeof nowMs === "number"
          ? nowMs
          : typeof performance === "undefined"
            ? Date.now()
            : performance.now();
      if (!deck._t0) {
        deck._t0 = now;
        deck._lastTs = now;
      }
      // 暂停后第一次回到循环：把时钟基准往后推，跳过暂停时长，
      // 这样 iTime 从暂停处继续而不是跳回起点（D4 要求的「回来继续」）。
      // 只用循环自己的时间戳（同一个时钟）—— 混用 wall clock 会让
      // 「用受控时间戳驱动」的测试测不出真行为。
      if (deck._resyncAfterPause) {
        deck._resyncAfterPause = false;
        deck._t0 += now - deck._lastTs;
      }

      var delta = (now - deck._lastTs) / 1000;
      if (delta <= 0 || delta > 1) delta = 1 / 60;
      deck._lastTs = now;

      var time = (now - deck._t0) / 1000 + deck._timeOffset;
      // 平滑一下，避免单帧抖动直接进 iFrameRate
      var instantRate = 1 / delta;
      deck._frameRate = deck._frameRate
        ? deck._frameRate * 0.9 + instantRate * 0.1
        : instantRate;

      gl.useProgram(deck.program);
      bindDefaultChannels();
      pushFrameUniforms(time, delta);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      deck._frame++;

      return time;
    };

    /** 同步渲染单帧（测试用；不做 rAF、不改时钟基准）。 */
    deck.renderOnce = (timeSeconds) => {
      if (!deck.program) return { ok: false, errors: ["未载入 shader"] };
      var t = typeof timeSeconds === "number" ? timeSeconds : deck._timeOffset;
      gl.useProgram(deck.program);
      bindDefaultChannels();
      pushFrameUniforms(t, 1 / 60);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.finish();
      deck._frame++;
      return { ok: true, time: t };
    };

    /** 读回像素，测试断言用。 */
    deck.readPixels = () => {
      var w = gl.drawingBufferWidth;
      var h = gl.drawingBufferHeight;
      var buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return { width: w, height: h, data: buf };
    };

    /**
     * 渲染循环的「一拍」：限帧 + 暂停检查 + 画一帧。
     *
     * rAF 回调与测试调**同一个函数**，保证被验证的就是真跑的那份逻辑，
     * 而不是一份「看起来一样」的复制品。这也让限帧/暂停/停止可以离线驱动：
     * 无头 Chromium 的虚拟时间下 rAF 基本不触发（实测只出了 2 帧），靠它才测得了。
     */
    deck.stepFrame = (ts) => {
      if (!deck._running) return false;
      if (deck._paused) return false;
      const minInterval = deck._minInterval || 0;
      if (minInterval && ts - deck._lastTickTs < minInterval - 0.5)
        return false;
      deck._lastTickTs = ts;
      deck.renderFrame(ts);
      return true;
    };

    deck.start = (startOpts) => {
      var so = startOpts || {};
      if (typeof so.timeOffset === "number") deck._timeOffset = so.timeOffset;
      if (typeof so.targetFps === "number") deck.targetFps = so.targetFps;
      if (deck._running) return;
      deck._running = true;
      deck._paused = false;
      deck._t0 = 0;
      deck._frame = 0;
      deck._lastTickTs = 0;
      deck._resyncAfterPause = false;
      deck._minInterval = deck.targetFps > 0 ? 1000 / deck.targetFps : 0;
      deck.resize(canvas.clientWidth, canvas.clientHeight);

      var tick = (ts) => {
        if (!deck._running) return;
        deck._rafId = requestAnimationFrame(tick);
        deck.stepFrame(ts);
      };
      deck._rafId = requestAnimationFrame(tick);
    };

    deck.stop = () => {
      deck._running = false;
      if (deck._rafId) {
        cancelAnimationFrame(deck._rafId);
        deck._rafId = 0;
      }
    };

    deck.pause = () => {
      deck._paused = true;
    };
    deck.resume = () => {
      if (!deck._paused) return;
      deck._paused = false;
      // 真正的时钟补偿在下一帧的 renderFrame 里做 —— 那里才有循环自己的时间戳。
      // 这里只打个标记，避免与 wall clock 混用（那正是这一版修掉的问题）。
      deck._resyncAfterPause = true;
    };

    deck.stats = () => ({
      fps: Math.round(deck._frameRate * 10) / 10,
      frames: deck._frame,
      time: deck._t0
        ? (deck._lastTs - deck._t0) / 1000 + deck._timeOffset
        : deck._timeOffset,
      isGLSL3: deck.isGLSL3,
      running: deck._running,
    });

    deck.dispose = () => {
      deck.stop();
      teardownProgram();
      disposeTextures();
      if (deck._blackTex) {
        gl.deleteTexture(deck._blackTex);
        deck._blackTex = null;
      }
      if (deck._buffer) {
        gl.deleteBuffer(deck._buffer);
        deck._buffer = null;
      }
    };

    return deck;
  }

  // ------------------------------------------------------- 无 canvas 的校验器

  /**
   * 只编译不渲染。给 P6 的 validate_shader 工具和离线跑批用。
   * @returns {Promise<{ok:boolean, isGLSL3:boolean, errors:string[], warnings:string[]}>}
   */
  function validate(shader) {
    var asm = assemble(shader);
    if (!asm.ok) {
      return Promise.resolve({
        ok: false,
        isGLSL3: false,
        errors: asm.errors,
        warnings: asm.warnings,
      });
    }
    var canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 4;
    var gl = createContext(canvas);
    if (!gl) {
      return Promise.resolve({
        ok: false,
        isGLSL3: asm.isGLSL3,
        warnings: asm.warnings,
        errors: ["无法创建 WebGL 上下文"],
      });
    }
    var linked = linkProgram(
      gl,
      asm.isGLSL3 ? VERTEX_GLSL3 : VERTEX_GLSL1,
      asm.source,
    );
    var lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
    return Promise.resolve({
      ok: linked.ok,
      isGLSL3: asm.isGLSL3,
      errors: linked.ok ? [] : linked.logs,
      warnings: asm.warnings,
    });
  }

  window.ShaderDeck = {
    VERSION: DECK_VERSION,
    CHANNEL_COUNT: CHANNEL_COUNT,
    assemble: assemble,
    getInfo: getInfo,
    create: createDeck,
    validate: validate,
  };

  // ------------------------------------------------------- runner 页控制器
  //
  // 宿主注入本文件后调用 __runnerLoad(shaderJson) 即可。
  // 页面必须提供 <canvas id="gl">；状态文本写进 <pre id="status">（存在时）。

  var runner = null;

  function statusEl() {
    return typeof document === "undefined"
      ? null
      : document.getElementById("status");
  }

  function setStatus(text) {
    var el = statusEl();
    if (el) el.textContent = text;
    if (typeof console !== "undefined") console.log("[runner] " + text);
  }

  var REPORT_PREFIX = "[shader-report] ";

  function report(payload) {
    var json = JSON.stringify(payload);
    window.__lastReport = json;
    // 回执**首走 console**：宿主有 onConsoleMessage（WebViewClient 层面的钩子），
    // 不依赖 addJavascriptInterface。真机上 JS bridge 根本挂不上（宿主在
    // onPageStarted/onPageFinished 才安装，而本脚本在解析阶段就跑完了），
    // 所以不能让回执只依赖那一条路。
    if (typeof console !== "undefined" && console.log) {
      console.log(REPORT_PREFIX + json);
    }
    // 保留了 bridge 路径：万一日后 bridge 可用，两边都能到。
    var host = window.ShaderHost;
    if (host && typeof host.report === "function") {
      try {
        host.report(json);
      } catch {
        /* 宿主不可用时忽略 */
      }
    }
  }

  // ---------------------------------------------------------------- 滑动手势
  //
  // 为什么在页面侧做：DSL 的 ComposeWebView 只有导航/资源/生命周期回调，
  // **没有 drag / gesture 回调**，所以竖向滑动只能在页面里判定，再通过 bridge 上报。
  //
  // 为什么用 pointer 事件而不是 touch 事件：
  //   1. 一套代码同时覆盖手指与鼠标（桌面调试试手势不用另写一条路径）；
  //   2. PointerEvent 可以被构造，所以这套判定能在离线 harness 里用合成事件真测。
  // 配套要求：canvas 必须有 touch-action:none（见 runner.html），
  // 否则浏览器把竖向触摸当滚动吃掉，pointermove 根本不会来。

  var SWIPE_MIN_DY = 60; // CSS 像素；比这短算误触
  var SWIPE_MAX_MS = 800; // 慢拖不算滑动

  function attachSwipe(target, onSwipe) {
    var startX = 0;
    var startY = 0;
    var startTs = 0;
    var tracking = false;

    function begin(event) {
      // 状态条是可选中文本，用户在上面划动是在选字，不该被当成换视频
      var el = event.target;
      if (el && el.id === "status") {
        tracking = false;
        return;
      }
      tracking = true;
      startX = event.clientX;
      startY = event.clientY;
      startTs = Date.now();
    }

    function finish(event) {
      if (!tracking) {
        return;
      }
      tracking = false;
      var dx = event.clientX - startX;
      // 屏幕坐标里向上滑是负值，取反后「向上 = 正」更直观
      var up = startY - event.clientY;
      var ms = Date.now() - startTs;
      if (Math.abs(up) < SWIPE_MIN_DY) {
        return;
      }
      if (ms > SWIPE_MAX_MS) {
        return;
      }
      // 斜着划不算：纵向位移必须大于横向，避免手抖误判
      if (Math.abs(up) <= Math.abs(dx)) {
        return;
      }
      onSwipe({
        direction: up > 0 ? "up" : "down",
        dy: Math.round(up),
        dx: Math.round(dx),
        ms: ms,
      });
    }

    function cancel() {
      tracking = false;
    }

    target.addEventListener("pointerdown", begin);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", cancel);
    return function detach() {
      target.removeEventListener("pointerdown", begin);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", cancel);
    };
  }

  // ---------------------------------------------------------------- iMouse 拖拽
  //
  // 与 attachSwipe 的分工：swipe 只关心「快速竖向滑动」这个动作（诊断/上报用），
  // 而这里提供的是**持续状态**：当前触点、拖拽起点、是否按住 —— 着色器据此做拖拽旋转。
  // 坐标统一为 buffer 像素、y 向上（与 fragCoord / iResolution 同系），
  // 这样 1.0 / 0.75 画质档下手感一致；touch-action:none 已在 runner.html 里配好。
  function attachPointerDrag(canvas, state) {
    function toBuffer(event) {
      var rect = canvas.getBoundingClientRect();
      var kx = rect.width > 0 ? canvas.width / rect.width : 1;
      var ky = rect.height > 0 ? canvas.height / rect.height : 1;
      return [
        (event.clientX - rect.left) * kx,
        canvas.height - (event.clientY - rect.top) * ky,
      ];
    }
    function down(event) {
      var p = toBuffer(event);
      state.x = p[0];
      state.y = p[1];
      state.sx = p[0];
      state.sy = p[1];
      state.down = true;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* 不支持 capture 的环境按普通事件流处理 */
      }
    }
    function move(event) {
      var p = toBuffer(event);
      state.x = p[0];
      state.y = p[1];
    }
    function up(event) {
      if (state.down) {
        state.down = false;
        var p = toBuffer(event);
        state.x = p[0];
        state.y = p[1];
      }
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        /* 同上 */
      }
    }
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    return function detach() {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
    };
  }
  
  function ensureRunner() {
    if (runner) return runner;
    var canvas = document.getElementById("gl");
    if (!canvas) throw new Error('runner.html 缺少 <canvas id="gl">');
    var deck = createDeck(canvas, {});
    // iMouse 拖拽接线：canvas 上的指针状态喂给 pushFrameUniforms()。
    deck._mouse = { x: 0, y: 0, sx: 0, sy: 0, down: false };
    runner = { canvas: canvas, deck: deck, reportTimer: 0 };
    runner.detachDrag = attachPointerDrag(canvas, deck._mouse);

    if (typeof ResizeObserver !== "undefined") {
      try {
        runner.resizeObserver = new ResizeObserver(() => {
          deck.resize(canvas.clientWidth, canvas.clientHeight);
        });
        runner.resizeObserver.observe(canvas);
      } catch {
        /* 不支持就退回 start() 里的手动 resize */
      }
    }

    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", () => {
        // D4：不可见即停，否则后台烧电池
        if (document.hidden) deck.pause();
        else deck.resume();
      });
    }

    // P3b：页面侧滑动检测，通过 bridge 上报给宿主。
    // 挂在 document 上而不是 canvas 上：canvas 只盖满视口，
    // 状态条会遮住底部一条，挂 document 才不会丢掉那块区域的滑动。
    window.__swipeLog = [];
    runner.detachSwipe = attachSwipe(document, (info) => {
      // 留一个小环作诊断（上限 50 条，不会无限增长）
      window.__swipeLog.push(info);
      if (window.__swipeLog.length > 50) {
        window.__swipeLog.shift();
      }
      window.__lastSwipe = info;
      var host = window.ShaderHost;
      if (host && typeof host.swipe === "function") {
        try {
          host.swipe(JSON.stringify(info));
        } catch (err) {
          // 宿主不可用不该让手势逻辑崩掉，但也不能无声无息
          if (typeof console !== "undefined") {
            console.log("[runner] swipe 上报失败: " + String(err));
          }
        }
      }
      if (typeof console !== "undefined") {
        console.log("[runner] swipe " + JSON.stringify(info));
      }
    });

    return runner;
  }

  /**
   * 宿主入口。
   * @param {object} shaderJson Shadertoy shader JSON
   * @param {{textures?:Object, timeOffset?:number}} [opts]
   */
  window.__runnerLoad = (shaderJson, opts) => {
    var o = opts || {};
    var payload = shaderJson || {};
    var timeOffset =
      typeof o.timeOffset === "number"
        ? o.timeOffset
        : typeof payload.__timeOffset === "number"
          ? payload.__timeOffset
          : 0;

    var r;
    try {
      r = ensureRunner();
    } catch (e) {
      var boom = { ok: false, stage: "init", errors: [String(e.message || e)] };
      setStatus("初始化失败: " + boom.errors[0]);
      report(boom);
      return Promise.resolve(boom);
    }

    r.deck.stop();
    setStatus("编译中…");

    return r.deck.load(payload, { textures: o.textures }).then((res) => {
      var out = {
        ok: !!res.ok,
        stage: res.ok ? "running" : "compile",
        isGLSL3: !!res.isGLSL3,
        errors: res.errors || [],
        warnings: res.warnings || [],
        timeOffset: timeOffset,
        id: getInfo(payload).id || "",
      };
      if (!res.ok) {
        setStatus("编译失败:\n" + out.errors.join("\n"));
        report(out);
        return out;
      }
      r.deck.start({ timeOffset: timeOffset });

      if (r.reportTimer) clearInterval(r.reportTimer);
      r.reportTimer = setInterval(() => {
        var s = r.deck.stats();
        report({
          stage: "stats",
          fps: s.fps,
          frames: s.frames,
          time: Math.round(s.time * 10) / 10,
          isGLSL3: s.isGLSL3,
        });
      }, 1000);

      setStatus(
        "渲染中 · GLSL" +
          (res.isGLSL3 ? "3" : "1") +
          " · offset=" +
          Math.round(timeOffset) +
          "s" +
          (out.warnings.length ? "\n警告: " + out.warnings.join("; ") : ""),
      );
      report(out);
      return out;
    });
  };

  /** 宿主可随时停/起（例如滑走/滑回）。 */
  window.__runnerStop = () => {
    if (runner) {
      runner.deck.stop();
      if (runner.reportTimer) clearInterval(runner.reportTimer);
    }
    return true;
  };
  window.__runnerPause = () => {
    if (runner) runner.deck.pause();
    return true;
  };
  window.__runnerResume = () => {
    if (runner) runner.deck.resume();
    return true;
  };
  window.__runnerScale = (scale) => {
    if (runner) runner.deck.setScale(scale);
    return runner ? runner.deck.qualityScale : null;
  };
  window.__runnerStats = () => (runner ? runner.deck.stats() : null);

  /**
   * 诊断用：把「实际绘图缓冲区尺寸 vs 布局尺寸 vs 画质档」一起吐出来。
   * D4 的画质旋钮是产品能不能用的分界线（同一个 shader 在旗舰机与中端机上差好几倍），
   * 所以它必须可被验证，而不是只能相信它生效了。真机上也用这个确认档位真的落下去了。
   */
  window.__runnerDebug = () => {
    if (!runner) return null;
    var canvas = runner.canvas;
    var gl = runner.deck.gl;
    return {
      drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      css: [canvas.clientWidth, canvas.clientHeight],
      dpr: (typeof window !== "undefined" && window.devicePixelRatio) || 1,
      qualityScale: runner.deck.qualityScale,
      isGLSL3: runner.deck.isGLSL3,
      warnings: runner.deck.warnings,
    };
  };
  window.__runnerReady = true;

  // ⚠️ 宿主注入 bridge 是**页面加载之后**才发生的：宿主在 onPageStarted / onPageFinished
  // 里才去安装 JS 接口（见 ToolPkgComposeDslWebView.kt），而本脚本在解析阶段就跑完了。
  // 所以「末尾只查一次」必然扑空 —— 真机实测正是如此：页面跑起来了、deck 也执行了，
  // 但那一刻 window.ShaderHost 还不存在，deck 一声不吭地放弃，框里一直空着。
  // 改成轮询：接口一出现就握手。
  var HOST_POLL_MS = 200;
  var HOST_WAIT_MS = 10000;
  var hostWaited = 0;
  var hostDone = false;

  function tryHostHandshake() {
    if (hostDone) {
      return true;
    }
    var host = window.ShaderHost;
    if (host && typeof host.ready === "function") {
      hostDone = true;
      try {
        host.ready();
      } catch {
        /* 忽略：握手本身出错时，宿主侧的错误上报会把原因带到界面 */
      }
      return true;
    }
    return false;
  }

  // ---- 启动 ----
  //
  // 主路径：渲染**内联在页面里**的 shader。界面在把 HTML 交给 WebView 之前，
  // 就把 payload 替换进了 window.__pendingShader —— 不需要握手、不需要 JS bridge。
  //
  // 为什么不再依赖握手：宿主挂 JS bridge 的时机是 onPageStarted / onPageFinished
  //（见 ToolPkgComposeDslWebView.kt），而本脚本在解析阶段就跑完了；真机上实测
  // **等了 10 秒 bridge 也没出现**，所以那条路不能当主路径。
  var pending = window.__pendingShader;
  if (pending && typeof pending === "object") {
    var pendingOffset =
      typeof pending.__timeOffset === "number" ? pending.__timeOffset : 0;
    window.__runnerLoad(pending, { timeOffset: pendingOffset });
  } else if (!tryHostHandshake()) {
    // 兜底：页面里没有内联 payload（例如手工打开这份 HTML 调试）才去等宿主握手。
    setStatus("等待宿主握手…");
    var hostTimer = setInterval(() => {
      hostWaited += HOST_POLL_MS;
      if (tryHostHandshake()) {
        clearInterval(hostTimer);
        return;
      }
      if (hostWaited >= HOST_WAIT_MS) {
        clearInterval(hostTimer);
        setStatus(
          "页面里既没有内联 shader，也没收到宿主握手（等了 " +
            Math.round(HOST_WAIT_MS / 1000) +
            " 秒）—— 界面可能没把 payload 替换进 HTML",
        );
      }
    }, HOST_POLL_MS);
  }
})();
