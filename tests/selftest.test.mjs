#!/usr/bin/env node
/**
 * 设备侧自测（selftest.ts）的离线测试。
 *
 * 自测本身要靠真机验证宿主实现，但**它的两条元属性**必须在这里先锁住：
 *   1. 它绝不能碰用户的真实缓存 —— 自测把用户缓存清了是不可接受的
 *   2. 它绝不能抛异常 —— 它是个诊断工具，自己崩掉就失去意义了
 *
 * 另外还要验证它真的会**报错**：如果渲染器拒绝加载，报告必须变成失败，
 * 而不是照样说"全部通过"。
 *
 * 用法： node tests/selftest.test.mjs   （需先跑 npx tsc）
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeMemFs, deterministicHash } from "./helpers/memfs.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELFTEST_JS = join(ROOT, "dist/feed/selftest.js");
const STORE_JS = join(ROOT, "dist/feed/store.js");
if (!existsSync(SELFTEST_JS) || !existsSync(STORE_JS)) {
  console.error("✗ 找不到编译产物，先跑 npx tsc");
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { runSelfTest } = require(SELFTEST_JS);
const { createStore } = require(STORE_JS);

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
const eq = (name, a, b) =>
  ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);

const REAL_ROOT = "/sdcard/Download/Operit/plugins/shader_feed";
const SELFTEST_DIR = REAL_ROOT + "/_selftest";

function makeRecord(id) {
  return {
    id,
    name: "user_" + id,
    username: "realuser",
    likes: 1,
    views: 2,
    date: "0",
    code: "void mainImage(out vec4 c, in vec2 f){ c=vec4(0.); } // " + id,
    common: "",
    passCount: 1,
    hasBuffers: false,
    isGLSL3: false,
    channels: [],
    unsupportedChannels: [],
  };
}

/** 只快照真实缓存（排除 _selftest 子树）—— 自测本来就允许写那里。 */
function snapshotReal(files) {
  const out = {};
  for (const [path, value] of [...files.entries()].sort()) {
    if (path.startsWith(SELFTEST_DIR + "/")) continue;
    out[path] =
      value.text === undefined
        ? "b64:" + value.base64.length
        : "text:" + value.text.length;
  }
  return out;
}

async function main() {
  console.log("── 正常路径：整条流水线在（内存）宿主实现上跑通 ──");
  const mem = makeMemFs();
  // 先在"真实缓存"里放一份用户数据，用来验证自测不碰它
  const realStore = createStore(mem.fs, {
    root: REAL_ROOT,
    hash: deterministicHash,
  });
  await realStore.saveShader(makeRecord("realuser1"), true);
  await realStore.saveShader(makeRecord("realuser2"), true);
  const beforeSnapshot = snapshotReal(mem.files);
  ok(
    "真实缓存已就绪（2 条）",
    Object.keys(beforeSnapshot).length >= 2,
    JSON.stringify(Object.keys(beforeSnapshot)),
  );

  const loads = [];
  const report = await runSelfTest({
    fs: mem.fs,
    root: REAL_ROOT,
    hash: deterministicHash,
    now: () => 1000,
    loadIntoRunner: async (record, offsetSeconds) => {
      loads.push({ id: record.id, offset: offsetSeconds });
      return { ok: true };
    },
  });

  ok(
    "自测整体通过",
    report.ok === true,
    report.text.split("\n").slice(-3).join(" | "),
  );
  ok(
    "每一步都通过",
    report.steps.every((s) => s.ok),
    JSON.stringify(report.steps.filter((s) => !s.ok)),
  );
  ok(
    "步数合理（覆盖存储/索引/纹理/占用/feed/渲染器）",
    report.steps.length >= 10,
    String(report.steps.length),
  );
  ok(
    "报告文本含逐步结果",
    report.text.includes("✓") && report.text.includes("自测全部通过"),
    report.text.slice(0, 80),
  );
  ok(
    "报告里带上了自测目录的真实路径",
    report.text.includes(SELFTEST_DIR),
    SELFTEST_DIR,
  );

  console.log("── feed 与渲染器的衔接 ──");
  eq("渲染器被调用两次（第一条 + 自动上滑后）", loads.length, 2);
  ok(
    "两次是不同的 shader",
    loads.length === 2 && loads[0].id !== loads[1].id,
    JSON.stringify(loads),
  );
  ok(
    "iTime 起点都落在 [0,600)",
    loads.every((l) => l.offset >= 0 && l.offset < 600),
    JSON.stringify(loads),
  );
  ok(
    "id 来自内置假数据（不是网络）",
    loads.every((l) => l.id.startsWith("st")),
    JSON.stringify(loads),
  );

  console.log("── 安全属性：绝不能碰用户真实缓存 ──");
  const afterSnapshot = snapshotReal(mem.files);
  eq(
    "真实缓存文件集合与内容完全未变",
    JSON.stringify(afterSnapshot),
    JSON.stringify(beforeSnapshot),
  );
  ok(
    "真实缓存里没有多出 selftest 数据文件",
    ![...mem.files.keys()].some(
      (k) => k.startsWith(REAL_ROOT + "/shaders/") && k.includes("st0"),
    ),
    JSON.stringify(
      [...mem.files.keys()].filter((k) =>
        k.startsWith(REAL_ROOT + "/shaders/"),
      ),
    ),
  );
  ok(
    "自测数据目录已清空（shaders/textures 下无残留）",
    ![...mem.files.keys()].some(
      (k) =>
        k.startsWith(SELFTEST_DIR + "/shaders/") ||
        k.startsWith(SELFTEST_DIR + "/textures/"),
    ),
    JSON.stringify(
      [...mem.files.keys()].filter((k) => k.startsWith(SELFTEST_DIR)),
    ),
  );

  console.log("── 渲染器拒绝加载时，报告必须变成失败（不能照样说通过）──");
  {
    const mem2 = makeMemFs();
    const bad = await runSelfTest({
      fs: mem2.fs,
      root: REAL_ROOT,
      hash: deterministicHash,
      now: () => 1000,
      loadIntoRunner: async () => ({ ok: false, error: "模拟编译失败" }),
    });
    ok("整体变成失败", bad.ok === false);
    ok(
      "报告文本明确说失败",
      bad.text.includes("自测失败"),
      bad.text.split("\n").slice(-2).join(" | "),
    );
    const failedStep = bad.steps.find((s) => !s.ok);
    ok(
      "能定位到失败的那一步",
      !!failedStep && failedStep.name.includes("渲染器"),
      JSON.stringify(failedStep),
    );
    ok(
      "失败详情带上了原始错误",
      !!failedStep && failedStep.detail.includes("模拟编译失败"),
      JSON.stringify(failedStep),
    );
  }

  console.log("── 宿主实现抛异常时，自测要报错而不是自己崩掉 ──");
  {
    const mem3 = makeMemFs();
    const brokenFs = {
      ...mem3.fs,
      writeText: async () => {
        throw new Error("磁盘满了");
      },
    };
    let threw = null;
    let brokenReport = null;
    try {
      brokenReport = await runSelfTest({
        fs: brokenFs,
        root: REAL_ROOT,
        hash: deterministicHash,
        now: () => 1000,
        loadIntoRunner: async () => ({ ok: true }),
      });
    } catch (err) {
      threw = err;
    }
    ok("自测没有向外抛异常", threw === null, threw && String(threw.message));
    ok(
      "并且如实报了失败",
      brokenReport && brokenReport.ok === false,
      brokenReport && brokenReport.text.slice(-90),
    );
    const step = brokenReport && brokenReport.steps.find((s) => !s.ok);
    ok(
      "失败原因可读（含原始错误）",
      !!step && step.detail.includes("磁盘满了"),
      JSON.stringify(step),
    );
  }

  console.log("── 没有真实缓存（首次运行）也要能跑 ──");
  {
    const mem4 = makeMemFs();
    const fresh = await runSelfTest({
      fs: mem4.fs,
      root: REAL_ROOT,
      hash: deterministicHash,
      now: () => 1000,
      loadIntoRunner: async () => ({ ok: true }),
    });
    ok(
      "空环境下自测通过",
      fresh.ok === true,
      fresh.text.split("\n").slice(-2).join(" | "),
    );
    ok(
      "真实缓存仍为空（没被自测写入）",
      (
        await createStore(mem4.fs, {
          root: REAL_ROOT,
          hash: deterministicHash,
        }).usage()
      ).shaderCount === 0,
    );
  }

  console.log("── 可复现性：同输入两次运行报告应一致 ──");
  {
    const runTwice = async () => {
      const m = makeMemFs();
      const r = await runSelfTest({
        fs: m.fs,
        root: REAL_ROOT,
        hash: deterministicHash,
        now: () => 1000,
        loadIntoRunner: async () => ({ ok: true }),
      });
      return r.text;
    };
    const a = await runTwice();
    const b = await runTwice();
    eq("两次报告文本一致", a, b);
  }

  console.log(`\n${pass}/${pass + failures.length} 通过`);
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败`);
    process.exit(1);
  }
  console.log(
    "✓ 自测的两条元属性（不碰真实缓存 / 自己永不抛异常）+ 失败必须可见 全部锁住",
  );
}

main();
