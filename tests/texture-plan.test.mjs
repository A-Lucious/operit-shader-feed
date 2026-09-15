#!/usr/bin/env node
/**
 * 纹理计划（texture-plan.ts）的离线测试。
 *
 * 这里锁两件容易出错的事：
 *   1. **扩展名解析**：Shadertoy 的纹理 URL 常带查询串、有时大写、有时没扩展名。
 *      解析错的后果是落盘文件没有扩展名 → WebView 拿不到 MIME → 图片加载失败，
 *      而且只在真机上表现为「画面里没有纹理」。
 *   2. **路径穿越**：虚拟域的 hash 会被拼进落盘路径。不做校验的话，
 *      `/tex/../../something` 就能让拦截器去读缓存目录之外的文件。
 *
 * 用法： node tests/texture-plan.test.mjs   （需先跑 npx tsc）
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_JS = join(ROOT, "dist/feed/texture-plan.js");
if (!existsSync(PLAN_JS)) {
  console.error("✗ 找不到编译产物，先跑 npx tsc");
  process.exit(2);
}
const require = createRequire(import.meta.url);
const {
  extFromUrl,
  extFromFile,
  planTextureDownloads,
  planChannelDispatch,
  parseVirtualTexturePath,
} = require(PLAN_JS);

let pass = 0;
const failures = [];
function ok(name, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? "  → " + detail : ""}`);
  }
}
/**
 * 值相等断言。**收到布尔值就直接报错** —— 谓词要用 ok()。
 * 这个守卫来自真实教训：把 `x >= 1000` 这类谓词传给 eq() 已经犯过四次，
 * 每次都表现为「期望 "1000"，实际 true」这种要读两遍才明白的消息。
 * 注意只在期望值不是布尔时拦：布尔对布尔是合法比较，不是这个错误。
 */
const eq = (name, a, b) => {
  if (typeof a === "boolean" && typeof b !== "boolean") {
    throw new Error(
      `eq() 收到了布尔断言：「${name}」—— 谓词请改用 ok(name, 条件, 详情)`,
    );
  }
  ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};

/** 造一条通道，字段与 parse.ts 的 ShaderChannel 一致。 */
function ch(patch) {
  return Object.assign(
    {
      channel: 0,
      ctype: "texture",
      src: "",
      filter: "linear",
      wrap: "repeat",
      vflip: "true",
    },
    patch,
  );
}

const HOST = "https://shaderfeed.local";

function main() {
  console.log("── 扩展名：必须经得起真实 URL ──");
    eq("普通 png", extFromUrl("https://x.com/a/b.png"), "png");
    eq("大写转小写", extFromUrl("https://x.com/a/B.PNG"), "png");
    eq("带查询串（Shadertoy 常见）", extFromUrl("https://x.com/a/b.jpg?w=1&h=2"), "jpg");
    eq("带锚点", extFromUrl("https://x.com/a/b.webp#frag"), "webp");
    eq("多级扩展名取最后一段", extFromUrl("https://x.com/a.tar.gz"), "gz");
    eq("没有扩展名", extFromUrl("https://x.com/media/abc123"), "");
    eq("目录名里的点不算扩展名", extFromUrl("https://x.com/v1.2/media"), "");
    eq("点开头（隐藏文件）不算", extFromUrl("https://x.com/.gitignore"), "");
    eq("结尾就是点", extFromUrl("https://x.com/a.png."), "");
    eq("扩展名过长不认（挡杂串）", extFromUrl("https://x.com/a.abcdefghij"), "");
    eq("非字符串", extFromUrl(undefined), "");
    eq("从落盘路径反推（台账里存的是路径）", extFromFile("/sdcard/x/textures/ab12cd.png"), "png");

  console.log("── 该下载哪些：只挑绝对 http 的图片通道，且按 URL 去重 ──");
  {
    const wanted = planTextureDownloads([
      ch({ channel: 0, src: "https://x.com/noise.png" }),
      ch({ channel: 1, src: "https://x.com/noise.png" }), // 同一张
      ch({ channel: 2, ctype: "keyboard", src: "https://x.com/kb.png" }),
      ch({ channel: 3, src: "media/a/local.png" }), // 相对路径：拿不到字节
      ch({ channel: 0, src: "" }),
      ch({ channel: 0, src: "   " }),
      ch({ channel: 0, src: "data:image/png;base64,AAAA" }),
      ch({ channel: 1, ctype: "texture", src: "  https://x.com/b.jpg?w=1  " }),
    ]);
    eq("去重后 2 张", wanted.length, 2);
    eq("第一张是噪声图", wanted[0].url, "https://x.com/noise.png");
    eq("扩展名解析正确", wanted[0].ext, "png");
    eq("第二张去掉了空白", wanted[1].url, "https://x.com/b.jpg?w=1");
    eq("带查询串也算出 jpg", wanted[1].ext, "jpg");

    const noExt = planTextureDownloads([ch({ src: "https://x.com/media/abc" })]);
    eq("没扩展名时兜底 bin", noExt[0].ext, "bin");

    ok("空数组安全", planTextureDownloads([]).length === 0);
    ok(
      "缺字段/垃圾条目不抛",
      (() => {
        try {
          planTextureDownloads([null, undefined, {}, { ctype: "texture" }]);
          return true;
        } catch {
          return false;
        }
      })(),
    );
  }

  console.log("── 下发形态：缓存命中走虚拟域，没命中保留原 URL ──");
  {
    const cached = { "https://x.com/noise.png": { hash: "ab12cd", ext: "png" } };
    const lookup = (url) => cached[url] || null;

    const plans = planChannelDispatch(
      [
        ch({ channel: 0, src: "https://x.com/noise.png" }),
        ch({ channel: 1, src: "https://x.com/missing.png" }),
        ch({ channel: 2, ctype: "keyboard", src: "https://x.com/kb.png" }),
      ],
      lookup,
      HOST,
    );
    eq("三条都保留（不能因为不认识就丢通道）", plans.length, 3);
    eq("命中改写成虚拟域", plans[0].src, "https://shaderfeed.local/tex/ab12cd.png");
    eq("命中标记为 cached", plans[0].cached, true);
    eq("未命中保留原 URL（在线回退）", plans[1].src, "https://x.com/missing.png");
    eq("未命中标记为未缓存", plans[1].cached, false);
    eq("非图片通道也只保留原样", plans[2].src, "https://x.com/kb.png");
    eq("通道号不被改动", plans[1].channel, 1);

    let lookupCalls = 0;
    planChannelDispatch(
      [ch({ src: "media/rel.png" }), ch({ src: "" })],
      () => {
        lookupCalls++;
        return null;
      },
      HOST,
    );
    eq("相对/空 src 不去查台账（白查一轮没意义）", lookupCalls, 0);
  }

  console.log("── 拦截侧解析：包括路径穿越必须挡住 ──");
  {
    const parsed = parseVirtualTexturePath("/tex/ab12cd.png");
    eq("正常路径解析出 hash", parsed && parsed.hash, "ab12cd");
    eq("扩展名小写化", parseVirtualTexturePath("/tex/ab12cd.PNG").ext, "png");

    eq("不是 /tex/ 前缀 → null", parseVirtualTexturePath("/runner.html"), null);
    eq("没有扩展名 → null", parseVirtualTexturePath("/tex/ab12cd"), null);
    eq("hash 为空 → null", parseVirtualTexturePath("/tex/.png"), null);
    eq("空路径 → null", parseVirtualTexturePath(""), null);
    eq("非字符串 → null", parseVirtualTexturePath(null), null);

    eq(
      "路径穿越（../）必须挡住 —— hash 会被拼进落盘路径",
      parseVirtualTexturePath("/tex/../../etc/passwd.png"),
      null,
    );
    eq(
      "带斜杠的 hash 必须挡住",
      parseVirtualTexturePath("/tex/a/b.png"),
      null,
    );
    eq(
      "超长 hash 挡住（防文件名滥用）",
      parseVirtualTexturePath("/tex/" + "a".repeat(65) + ".png"),
      null,
    );
    eq(
      "扩展名里的可疑字符挡住",
      parseVirtualTexturePath("/tex/ab12cd.p%2fng"),
      null,
    );
  }

  console.log(`\n${pass}/${pass + failures.length} 通过`);
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败`);
    process.exit(1);
  }
  console.log(
    "✓ 纹理下载计划（去重/扩展名）+ 下发改写（虚拟域/在线回退）+ 拦截解析（含路径穿越）全部锁住",
  );
}

main();
