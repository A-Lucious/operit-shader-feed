#!/usr/bin/env node
/**
 * P2 存储层的离线测试。
 *
 * store.ts 只跟 StoreFs 打交道（不认识 ToolPkg），所以索引、纹理去重、LRU 淘汰、
 * 损坏恢复这些语义能用内存 FS 在 Node 里真测。
 * 这里锁的是 PLAN §4 D6 的每一条。
 *
 * 用法： node tests/store.test.mjs   （需先跑 npx tsc）
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPILED = join(ROOT, "dist/feed/store.js");
if (!existsSync(COMPILED)) {
  console.error(`✗ 找不到 ${COMPILED}，先跑 npx tsc`);
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { createStore } = require(COMPILED);

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
  // 只有「期望值不是布尔」时才拦：布尔对布尔（eq("x", flag, false)）是合法比较。
  if (typeof a === "boolean" && typeof b !== "boolean") {
    throw new Error(
      `eq() 收到了布尔断言：「${name}」—— 谓词请改用 ok(name, 条件, 详情)`,
    );
  }
  ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};

// 内存 FS 与字节数助手由 tests/helpers/memfs.mjs 提供 ——
// 自测的测试要用同一份，所以在那里定义一次。
import { b64, deterministicHash, makeMemFs } from "./helpers/memfs.mjs";

function makeRecord(id, opts = {}) {
  return {
    id,
    name: "name_" + id,
    username: "user",
    likes: 5,
    views: 100,
    date: "1710000000",
    code: "void mainImage(out vec4 c, in vec2 f){ c=vec4(0.); } // " + id,
    common: opts.common || "",
    passCount: opts.withBuffer ? 2 : 1,
    hasBuffers: !!opts.withBuffer,
    isGLSL3: !!opts.glsl3,
    channels: opts.channels || [],
    unsupportedChannels: [],
  };
}

const ROOT_DIR = "/sdcard/Download/Operit/plugins/shader_feed";

async function main() {
  console.log("── 正文与索引：往返 + 不重复 ──");
  {
    const mem = makeMemFs();
    const store = createStore(mem.fs, {
      root: ROOT_DIR,
      hash: deterministicHash,
    });
    const rec = makeRecord("abc123");
    await store.saveShader(rec, true);

    const loaded = await store.loadShader("abc123");
    ok(
      "loadShader 往返拿到完整记录（含代码）",
      !!loaded && loaded.code === rec.code,
      loaded && loaded.code,
    );
    eq("hasShader 为真", await store.hasShader("abc123"), true);
    eq("未保存的 id → hasShader 为假", await store.hasShader("zzz999"), false);
    eq(
      "未保存的 id → loadShader 返回 null",
      await store.loadShader("zzz999"),
      null,
    );

    const list = await store.listShaders();
    eq("索引里有 1 条", list.length, 1);
    eq(
      "索引里的元数据不带代码（保证 index.json 小）",
      "code" in list[0],
      false,
    );
    eq("元数据带 singlePass 标记", list[0].singlePass, true);

    // 同 id 重存不得产生两份
    await store.saveShader(makeRecord("abc123"), true);
    eq("同 id 重存后索引仍只有 1 条", (await store.listShaders()).length, 1);

    const tmpLeft = [...mem.files.keys()].filter((k) => k.endsWith(".tmp"));
    eq("原子写没有留下 .tmp 残骸", tmpLeft.length, 0);
  }

  console.log("── 索引按保存时间倒序（本地优先浏览的依据）──");
  {
    const mem = makeMemFs();
    let t = 1000;
    const store = createStore(mem.fs, {
      root: ROOT_DIR,
      hash: deterministicHash,
      now: () => t,
    });
    await store.saveShader(makeRecord("a1"), true);
    t = 2000;
    await store.saveShader(makeRecord("a2"), true);
    t = 3000;
    await store.saveShader(makeRecord("a3"), true);
    const order = (await store.listShaders()).map((m) => m.id);
    eq("最新保存的排最前", order.join(","), "a3,a2,a1");
  }

  console.log("── 纹理全局去重 ──");
  {
    const mem = makeMemFs();
    const store = createStore(mem.fs, {
      root: ROOT_DIR,
      hash: deterministicHash,
    });
    const url = "https://www.shadertoy.com/media/shaders/xyz.png";
    const first = await store.recordTexture(url, b64(60), "png");
    const second = await store.recordTexture(url, b64(60), "png");
    eq("同一 URL 只占一份文件", mem.calls.writeBinary, 1);
    eq("台账里只有 1 条", (await store.usage()).textureCount, 1);
    eq("两次返回同一个 hash", first.hash, second.hash);
    const touched = await store.touchTexture(url);
    ok(
      "touchTexture 能查回同一条",
      !!touched && touched.hash === first.hash,
      JSON.stringify(touched),
    );
    eq(
      "未缓存过的 URL → touchTexture 返回 null",
      await store.touchTexture("https://x/new.png"),
      null,
    );
  }

  console.log("── LRU 淘汰：只动纹理，且 touch 能保住 ──");
  {
    const mem = makeMemFs();
    let t = 1;
    // 每条 60 字节，配额 150 → 同时最多留 2 条
    const store = createStore(mem.fs, {
      root: ROOT_DIR,
      hash: deterministicHash,
      quotaBytes: 150,
      now: () => t,
    });
    const A = "https://s/a.png";
    const B = "https://s/b.png";
    const C = "https://s/c.png";
    const D = "https://s/d.png";

    await store.recordTexture(A, b64(60), "png"); // t=1 → {A}
    t = 2;
    await store.recordTexture(B, b64(60), "png"); // t=2 → {A,B} = 120 ≤ 150
    t = 3;
    await store.recordTexture(C, b64(60), "png"); // t=3 → 180 > 150 → 淘汰最旧的 A
    eq("超配额后淘汰了 1 条", (await store.usage()).textureCount, 2);
    eq("最旧的 A 被淘汰", await store.touchTexture(A), null);
    ok("B 仍在", !!(await store.touchTexture(B)));

    t = 4;
    await store.touchTexture(B); // B 变成最新
    t = 5;
    await store.recordTexture(D, b64(60), "png"); // 180 > 150 → 淘汰最旧的 C（不是刚 touch 过的 B）
    const remaining = await store.usage();
    eq("淘汰后仍是 2 条", remaining.textureCount, 2);
    ok("被 touch 过的 B 活了下来", !!(await store.touchTexture(B)));
    ok("D 在", !!(await store.touchTexture(D)));
    eq("最旧的 C 被淘汰", await store.touchTexture(C), null);
    ok(
      "纹理占用不超过配额",
      remaining.textureBytes <= 150,
      `${remaining.textureBytes} / 150`,
    );
  }

  console.log("── 淘汰绝不碰 shader 元数据（D6）──");
  {
    const mem = makeMemFs();
    let t = 1;
    const store = createStore(mem.fs, {
      root: ROOT_DIR,
      hash: deterministicHash,
      quotaBytes: 100,
      now: () => t,
    });
    for (const id of ["s1", "s2", "s3"]) {
      await store.saveShader(makeRecord(id), true);
      t++;
    }
    await store.recordTexture("https://s/t1.png", b64(60), "png");
    t++;
    await store.recordTexture("https://s/t2.png", b64(60), "png"); // 触发淘汰
    t++;
    await store.recordTexture("https://s/t3.png", b64(60), "png"); // 再淘汰
    const usage = await store.usage();
    ok(
      "纹理被压到配额内",
      usage.textureBytes <= 100,
      `${usage.textureBytes} / 100`,
    );
    eq("shader 一条都没被淘汰", usage.shaderCount, 3);
    eq(
      "shader 正文文件都还在",
      (await mem.fs.size(ROOT_DIR + "/shaders/s1.json")) > 0,
      true,
    );
  }

  console.log("── 占用统计与清理入口（必须给真实绝对路径）──");
  {
    const mem = makeMemFs();
    const store = createStore(mem.fs, {
      root: ROOT_DIR,
      hash: deterministicHash,
    });
    await store.saveShader(makeRecord("m1"), true);
    await store.recordTexture("https://s/t.png", b64(1024), "png");
    const usage = await store.usage();
    ok(
      "describe 含真实绝对路径",
      usage.describe.includes(ROOT_DIR),
      usage.describe,
    );
    ok(
      "describe 含 shader 条数",
      usage.describe.includes("1 条"),
      usage.describe,
    );
    ok("describe 含配额上限", usage.describe.includes("上限"), usage.describe);
    eq("root 原样暴露", usage.root, ROOT_DIR);
    eq("shaderBytes > 0", usage.shaderBytes > 0, true);
    eq("textureBytes = 1KB", usage.textureBytes, 1024);

    await store.clearTextures();
    const afterClear = await store.usage();
    eq("清纹理后纹理为 0", afterClear.textureCount, 0);
    eq("清纹理不动 shader", afterClear.shaderCount, 1);

    await store.clearAll();
    const afterAll = await store.usage();
    eq("全清后 shader 也为 0", afterAll.shaderCount, 0);
    eq(
      "全清后文件也没了",
      await mem.fs.size(ROOT_DIR + "/shaders/m1.json"),
      -1,
    );
  }

  console.log("── 台账有记录但文件没了（用户手动清过）→ 以文件为准 ──");
  {
    const mem = makeMemFs();
    const store = createStore(mem.fs, {
      root: ROOT_DIR,
      hash: deterministicHash,
    });
    const url = "https://s/gone.png";
    const entry = await store.recordTexture(url, b64(32), "png");
    mem.files.delete(entry.file); // 模拟用户用文件管理器删了
    eq(
      "touchTexture 返回 null（不再谎报有缓存）",
      await store.touchTexture(url),
      null,
    );
    eq("台账也同步清掉了", (await store.usage()).textureCount, 0);
  }

  console.log("── 损坏的索引不能让插件变成打不开的黑屏 ──");
  {
    const mem = makeMemFs();
    const store = createStore(mem.fs, {
      root: ROOT_DIR,
      hash: deterministicHash,
    });
    await store.saveShader(makeRecord("ok1"), true);

    // 模拟崩溃写坏 / 用户手动改坏
    mem.files.set(ROOT_DIR + "/index.json", { text: "{ 这不是合法 JSON" });
    const fresh = createStore(mem.fs, {
      root: ROOT_DIR,
      hash: deterministicHash,
    });
    let threw = null;
    let list = null;
    try {
      list = await fresh.listShaders();
    } catch (err) {
      threw = err;
    }
    ok("损坏索引不抛异常", threw === null, threw && String(threw.message));
    eq("退化成空索引", list ? list.length : -1, 0);
    // 而且还能继续正常用
    await fresh.saveShader(makeRecord("ok2"), true);
    eq("损坏后仍能继续写入", (await fresh.listShaders()).length, 1);

    mem.files.set(ROOT_DIR + "/textures.json", { text: "also broken" });
    const fresh2 = createStore(mem.fs, {
      root: ROOT_DIR,
      hash: deterministicHash,
    });
    eq("损坏的纹理台账也退化成空", (await fresh2.usage()).textureCount, 0);
  }

  console.log("── 被吞掉的错误必须能从 onWarn 看到 ──");
  {
    const mem = makeMemFs();
    const warnings = [];
    const store = createStore(mem.fs, {
      root: ROOT_DIR,
      hash: deterministicHash,
      onWarn: (m) => warnings.push(m),
    });
    await store.recordTexture("https://s/warn.png", b64(32), "png");
    mem.setFailRemove(() => true);
    await store.clearTextures();
    ok(
      "删除失败会上报 onWarn（不是无声消失）",
      warnings.length > 0,
      JSON.stringify(warnings),
    );
    ok("告警里带上了失败路径", warnings[0].includes(ROOT_DIR), warnings[0]);
    eq(
      "失败后台账仍被清空（否则永远占着配额）",
      (await store.usage()).textureCount,
      0,
    );
  }

  console.log("── 根目录末尾斜杠会被归一化（避免拼出 // 路径）──");
  {
    const mem = makeMemFs();
    const store = createStore(mem.fs, {
      root: ROOT_DIR + "/",
      hash: deterministicHash,
    });
    eq("root 归一化", store.root, ROOT_DIR);
    await store.saveShader(makeRecord("n1"), true);
    ok(
      "没有出现双斜杠路径",
      ![...mem.files.keys()].some((k) => k.includes("//")),
      [...mem.files.keys()].join(" "),
    );
  }

  console.log("── 并发写入：共享的 .tmp 路径不能导致「保存随机失败」 ──");
  {
    const mem = makeMemFs();
    const store = createStore(mem.fs, {
      root: ROOT_DIR,
      hash: deterministicHash,
    });

    // 12 条同时保存：它们都要写同一个 index.json（→ 同一个 .tmp）
    const N = 12;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        store.saveShader(makeRecord("cc" + i), true),
      ),
    );
    const rejected = results.filter((r) => r.status === "rejected");
    eq(
      "并发保存 12 条：一条都不该失败",
      rejected.length,
      0,
      JSON.stringify(rejected.map((r) => String(r.reason && r.reason.message))),
    );
    eq("索引里 12 条都在（没有丢写）", (await store.listShaders()).length, N);
    eq(
      "没有留下 .tmp 残骸",
      [...mem.files.keys()].filter((k) => k.endsWith(".tmp")).length,
      0,
    );

    // 纹理并发：每一次都会写台账 + 可能触发淘汰，所以落盘更密集
    const urls = Array.from(
      { length: 8 },
      (_, i) => "https://s/tex" + i + ".png",
    );
    const texResults = await Promise.allSettled(
      urls.map((url) => store.recordTexture(url, b64(64), "png")),
    );
    eq(
      "并发写 8 张纹理：一条都不该失败",
      texResults.filter((r) => r.status === "rejected").length,
      0,
      JSON.stringify(
        texResults
          .filter((r) => r.status === "rejected")
          .map((r) => String(r.reason)),
      ),
    );
    eq("台账里 8 张都在", (await store.usage()).textureCount, 8);
    eq(
      "纹理并发也没留下 .tmp 残骸",
      [...mem.files.keys()].filter((k) => k.endsWith(".tmp")).length,
      0,
    );
  }

  console.log("── 索引不可读 / 损坏时必须上报，不能静默当成首次运行 ──");
  {
    // 不可读（权限等）：必须能区分于「不存在」，否则缓存会被当成首次运行而被覆盖
    const mem = makeMemFs();
    const warnings = [];
    const brokenFs = {
      ...mem.fs,
      readText: async () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const store = createStore(brokenFs, {
      root: ROOT_DIR,
      hash: deterministicHash,
      onWarn: (m) => warnings.push(m),
    });
    eq("不可读时退化成空（不抛）", (await store.listShaders()).length, 0);
    ok("但必须上报到 onWarn", warnings.length > 0, JSON.stringify(warnings));
    ok(
      "警告里带路径与原因",
      warnings[0].includes("index.json") && warnings[0].includes("EACCES"),
      warnings[0],
    );
  }
  {
    // 损坏的 JSON 也要上报，而不只是默默清空
    const mem = makeMemFs();
    const warnings = [];
    const seed = createStore(mem.fs, { root: ROOT_DIR, hash: deterministicHash });
    await seed.saveShader(makeRecord("corrupt1"), true);
    mem.files.set(ROOT_DIR + "/index.json", { text: "{ 这不是合法 JSON" });

    const fresh = createStore(mem.fs, {
      root: ROOT_DIR,
      hash: deterministicHash,
      onWarn: (m) => warnings.push(m),
    });
    eq("损坏索引退化成空", (await fresh.listShaders()).length, 0);
    ok(
      "损坏也上报（用户要知道缓存为什么没了）",
      warnings.some((w) => w.includes("损坏")),
      JSON.stringify(warnings),
    );
  }
  {
    // 首次运行（文件根本不存在）不该产生噪音警告，否则警告会被用户忽略
    const mem = makeMemFs();
    const warnings = [];
    const store = createStore(mem.fs, {
      root: ROOT_DIR,
      hash: deterministicHash,
      onWarn: (m) => warnings.push(m),
    });
    await store.listShaders();
    await store.usage();
    await store.loadShader("nope");
    eq("首次运行不报警告", warnings.length, 0, JSON.stringify(warnings));
  }

  console.log(`\n${pass}/${pass + failures.length} 通过`);
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败`);
    process.exit(1);
  }
  console.log(
    "✓ D6 的每条（索引 / 去重 / 只淘汰纹理 / LRU / 配额 / 真实路径 / 损坏恢复）全部锁住",
  );
}

main();
