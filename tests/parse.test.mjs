#!/usr/bin/env node
/**
 * P1 解析层的离线测试。
 *
 * parse.ts 是纯函数（不碰 DOM、不碰 ToolPkg），所以这里能在 Node 里真测，
 * 不用等设备。契约探测会给出真值，但容错行为现在就能锁住 ——
 * 尤其是「多 pass 不能被静默丢掉」这一条（PLAN §4 D3 的复核依赖它）。
 *
 * 用法： node tests/parse.test.mjs   （需先跑 npx tsc）
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPILED = join(ROOT, "dist/feed/parse.js");
if (!existsSync(COMPILED)) {
  console.error(`✗ 找不到 ${COMPILED}，先跑 npx tsc`);
  process.exit(2);
}
// 用 createRequire 而不是 ESM 具名导入：不依赖 Node 对 CJS 具名导出的静态推断。
const require = createRequire(import.meta.url);
const { parseShader, extractShaderIds, isSinglePassRenderable } = require(
  COMPILED,
);

let pass = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? "  → " + detail : ""}`);
    console.log(`  ✗ ${name}${detail ? "  → " + detail : ""}`);
  }
}
function eq(name, actual, expected) {
  ok(
    name,
    actual === expected,
    `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  );
}

const IMAGE_CODE =
  "void mainImage(out vec4 c, in vec2 f){ c = vec4(f/iResolution.xy, 0.0, 1.0); }";
const COMMON_CODE = "float helper(){ return 1.0; }";

/** 基准：按已确认的契约形状（inputs 字段名来自 shadertoy Rust crate 的 RenderPassInput）。 */
function makeShader(overrides = {}) {
  return {
    Shader: {
      info: {
        id: "4dXGR8",
        name: "Test Shader",
        username: "someone",
        likes: "128",
        views: "9300",
        date: "1710000000",
      },
      renderpass: [{ type: "image", code: IMAGE_CODE, inputs: [] }],
      ...overrides,
    },
  };
}

const j = (v) => JSON.stringify(v);

console.log("── 规范形状与外壳容错 ──");
{
  const r = parseShader(j(makeShader()));
  ok("带 {Shader:{...}} 外壳 → ok", r.ok, r.error);
  const rec = r.record;
  if (rec) {
    eq("id", rec.id, "4dXGR8");
    eq("name", rec.name, "Test Shader");
    eq("username", rec.username, "someone");
    eq("likes 字符串→数字", rec.likes, 128);
    eq("views 字符串→数字", rec.views, 9300);
    eq("date 原样保留为字符串", rec.date, "1710000000");
    eq("passCount", rec.passCount, 1);
    eq("hasBuffers", rec.hasBuffers, false);
    eq("isGLSL3", rec.isGLSL3, false);
    eq("channels 为空", rec.channels.length, 0);
    eq("单 pass 可渲染", isSinglePassRenderable(rec), true);
  }
}
{
  const flat = makeShader().Shader;
  const r = parseShader(j(flat));
  ok("扁平形状（无 Shader 外壳）→ ok", r.ok, r.error);
  eq("扁平形状仍能取到 id", r.record && r.record.id, "4dXGR8");
}

console.log("── 缺失值不能用 0 冒充 ──");
{
  const s = makeShader();
  delete s.Shader.info.likes;
  delete s.Shader.info.views;
  const r = parseShader(j(s));
  ok(
    "likes/views 缺失 → null（不是 0）",
    r.ok && r.record.likes === null && r.record.views === null,
    `likes=${j(r.record && r.record.likes)} views=${j(r.record && r.record.views)}`,
  );
}
{
  const s = makeShader();
  s.Shader.info.likes = 0;
  const r = parseShader(j(s));
  eq("真实 0 赞仍是 0（与缺失区分开）", r.record.likes, 0);
}

console.log("── 多 pass / 通道：只标记，绝不丢弃 ──");
{
  const s = makeShader({
    renderpass: [
      { type: "common", code: COMMON_CODE, inputs: [] },
      {
        type: "buffer",
        code: "void mainImage(out vec4 c, in vec2 f){ c=vec4(0.); }",
        inputs: [],
      },
      { type: "image", code: IMAGE_CODE, inputs: [] },
    ],
  });
  const r = parseShader(j(s));
  ok("多 pass 仍能解析出记录（不丢）", r.ok, r.error);
  const rec = r.record;
  if (rec) {
    eq("passCount=3", rec.passCount, 3);
    eq("hasBuffers=true（D3 复核要统计它）", rec.hasBuffers, true);
    eq("common 已提取", rec.common, COMMON_CODE);
    eq("code 取的是 image pass", rec.code, IMAGE_CODE);
    eq("多 pass → 不满足单 pass 判定", isSinglePassRenderable(rec), false);
  }
}
{
  const s = makeShader({
    renderpass: [
      {
        type: "image",
        code: IMAGE_CODE,
        inputs: [
          {
            id: 1,
            src: "/media/a.png",
            ctype: "texture",
            channel: 0,
            sampler: { filter: "nearest", wrap: "clamp", vflip: "true" },
          },
          { id: 2, src: "", ctype: "texture", channel: 1 },
          { id: 3, src: "", ctype: "keyboard", channel: 2, sampler: {} },
        ],
      },
    ],
  });
  const r = parseShader(j(s));
  const rec = r.record;
  ok("混合通道可解析", r.ok, r.error);
  if (rec) {
    eq("只把 texture 收进 channels", rec.channels.length, 2);
    eq(
      "channel0 采样器参数",
      rec.channels[0].filter +
        "/" +
        rec.channels[0].wrap +
        "/" +
        rec.channels[0].vflip,
      "nearest/clamp/true",
    );
    eq(
      "缺 sampler 时取默认值",
      rec.channels[1].filter +
        "/" +
        rec.channels[1].wrap +
        "/" +
        rec.channels[1].vflip,
      "linear/repeat/false",
    );
    ok(
      "非 texture 通道被记入 unsupportedChannels",
      rec.unsupportedChannels.includes("keyboard"),
      j(rec.unsupportedChannels),
    );
    eq("含非图片通道 → 不满足单 pass 判定", isSinglePassRenderable(rec), false);
  }
}
{
  const s = makeShader({
    renderpass: [
      { type: "Image", code: "#version 300 es\n" + IMAGE_CODE, inputs: [] },
    ],
  });
  const r = parseShader(j(s));
  ok(
    'pass type 大小写不敏感（"Image"）',
    r.ok && r.record.isGLSL3 === true,
    r.error,
  );
}

console.log("── 负例必须明确报错，而不是产出坏记录 ──");
{
  const cases = [
    ["非法 JSON", "not json at all", "JSON"],
    ["顶层是数组", "[]", "对象"],
    ["没有 renderpass", j({ Shader: { info: { id: "x" } } }), "renderpass"],
    [
      "没有 image pass",
      j({ Shader: { renderpass: [{ type: "common", code: COMMON_CODE }] } }),
      "image",
    ],
    [
      "image pass 没有 mainImage",
      j({ Shader: { renderpass: [{ type: "image", code: "void main(){}" }] } }),
      "mainImage",
    ],
  ];
  for (const [name, text, expectFragment] of cases) {
    const r = parseShader(text);
    ok(`${name} → ok=false`, r.ok === false, `实际 ok=${r.ok}`);
    ok(
      `${name} → 报错信息可读`,
      !!r.error && r.error.includes(expectFragment),
      r.error,
    );
    ok(`${name} → 不产出 record`, r.record === undefined, j(r.record));
  }
}

console.log("── 列表响应里的 id 抽取（形状未实测，所以按多变体收） ──");
{
  eq(
    "纯字符串数组",
    j(extractShaderIds(j(["4dXGR8", "Nsl3RN", "MdXGzR"]))),
    j(["4dXGR8", "Nsl3RN", "MdXGzR"]),
  );
  eq(
    "对象数组取 .id",
    j(extractShaderIds(j([{ id: "4dXGR8" }, { id: "Nsl3RN" }]))),
    j(["4dXGR8", "Nsl3RN"]),
  );
  eq(
    "对象数组取 ._id",
    j(extractShaderIds(j([{ _id: "4dXGR8" }]))),
    j(["4dXGR8"]),
  );
  eq(
    "包在 Results 里",
    j(extractShaderIds(j({ Results: [{ id: "4dXGR8" }] }))),
    j(["4dXGR8"]),
  );
  eq(
    "包在 Shaders 里",
    j(extractShaderIds(j({ Shaders: ["4dXGR8"] }))),
    j(["4dXGR8"]),
  );
  eq("去重", j(extractShaderIds(j(["4dXGR8", "4dXGR8"]))), j(["4dXGR8"]));
  eq("非法 JSON → 空数组", j(extractShaderIds("<<<")), j([]));
  const junk = extractShaderIds(
    j(["4dXGR8", "hello world", "这是一段中文", "x".repeat(40), "", "ab"]),
  );
  eq("滤掉非 id（空格/中文/超长/过短/空）", j(junk), j(["4dXGR8"]));
}

console.log(`\n${pass}/${pass + failures.length} 通过`);
if (failures.length) {
  console.error(`✗ ${failures.length} 项失败`);
  process.exit(1);
}
console.log("✓ P1 解析层容错行为（含「多 pass 不丢弃」）全部锁住");
