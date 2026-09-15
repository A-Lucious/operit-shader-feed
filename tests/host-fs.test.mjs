#!/usr/bin/env node
/**
 * P2b 宿主 FS 适配器的离线测试。
 *
 * host-fs.ts 把 Tools.Files 映射成 StoreFs。它引用的是宿主全局，所以这里打桩即可真测：
 *   - 字段名映射写错（contentBase64 vs base64、isDirectory vs isDir）
 *     → 真机上的表现是「什么都没存下来」，极难查
 *   - read() 对不存在的文件会抛，而契约要求返回 null
 *   - move() 不保证覆盖，而原子写每次都要覆盖同一个目标名
 *     → 不带退路的话，第二次保存起就永远失败
 *
 * 用法： node tests/host-fs.test.mjs   （需先跑 npx tsc）
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPILED = join(ROOT, "dist/feed/host-fs.js");
if (!existsSync(COMPILED)) {
  console.error(`✗ 找不到 ${COMPILED}，先跑 npx tsc`);
  process.exit(2);
}

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

// ---- 打桩宿主全局（必须在 require 之前/之后都行，因为模块体不引用它们）----
const calls = [];
let readImpl = async () => ({ path: "x", content: "", size: 0 });
let moveImpl = async () => undefined;
let infoImpl = async () => ({
  path: "x",
  exists: true,
  fileType: "file",
  size: 123,
  lastModified: "",
});

globalThis.Tools = {
  Files: {
    async read(path, env) {
      calls.push(["read", path, env]);
      return readImpl(path, env);
    },
    async write(path, content, append, env) {
      calls.push(["write", path, content, append, env]);
    },
    async writeBinary(path, base64, env) {
      calls.push(["writeBinary", path, base64, env]);
    },
    async list(path, env) {
      calls.push(["list", path, env]);
      return {
        path,
        entries: [
          { name: "a.json", isDirectory: false, size: 11 },
          { name: "shaders", isDirectory: true, size: 0 },
        ],
      };
    },
    async mkdir(path, createParents, env) {
      calls.push(["mkdir", path, createParents, env]);
    },
    async deleteFile(path, recursive, env) {
      calls.push(["deleteFile", path, recursive, env]);
    },
    async move(from, to, env) {
      calls.push(["move", from, to, env]);
      return moveImpl(from, to, env);
    },
    async info(path, env) {
      calls.push(["info", path, env]);
      return infoImpl(path, env);
    },
  },
};

globalThis.CryptoJS = {
  MD5(message) {
    return { toString: () => "md5(" + message + ")" };
  },
};

const require = createRequire(import.meta.url);
const {
  createHostFs,
  hashTextureUrl,
  DEFAULT_STORE_ROOT,
  verifyRootWritable,
} = require(COMPILED);

const missing = () => {
  const e = new Error("ENOENT: no such file or directory");
  return e;
};

async function main() {
  const fs = createHostFs();

  console.log("── 映射：字段名与参数顺序 ──");
  calls.length = 0;
  await fs.writeText("/r/index.json", '{"a":1}');
  eq(
    "writeText → write(path, text, append=false, env=android)",
    JSON.stringify(calls[0]),
    JSON.stringify(["write", "/r/index.json", '{"a":1}', false, "android"]),
  );

  calls.length = 0;
  await fs.writeBinary("/r/textures/x.png", "QUJD");
  eq(
    "writeBinary → writeBinary(path, base64, env)",
    JSON.stringify(calls[0]),
    JSON.stringify(["writeBinary", "/r/textures/x.png", "QUJD", "android"]),
  );

  calls.length = 0;
  await fs.mkdir("/r/shaders");
  eq(
    "mkdir 带 createParents=true（首次运行整条路径可能都不存在）",
    JSON.stringify(calls[0]),
    JSON.stringify(["mkdir", "/r/shaders", true, "android"]),
  );

  calls.length = 0;
  await fs.remove("/r/textures", true);
  eq(
    "remove → deleteFile(path, recursive=true, env)",
    JSON.stringify(calls[0]),
    JSON.stringify(["deleteFile", "/r/textures", true, "android"]),
  );

  console.log("── readText：不存在的文件必须是 null 而不是抛异常 ──");
  {
    readImpl = async () => {
      throw missing();
    };
    eq(
      "ENOENT → null（首次运行的正常状态）",
      await fs.readText("/r/index.json"),
      null,
    );

    readImpl = async () => {
      throw new Error("EACCES: permission denied");
    };
    // 契约：只有「不存在」返回 null，其它失败必须抛出。
    // 返回 null 会让 store 把「不可读」当成「首次运行」，随后覆盖用户原有缓存。
    let permErr = null;
    try {
      await fs.readText("/r/index.json");
    } catch (err) {
      permErr = err;
    }
    ok(
      "权限错误必须抛出（不能伪装成「不存在」）",
      permErr !== null,
      String(permErr && permErr.message),
    );

    readImpl = async () => {
      throw new Error("文件不存在");
    };
    eq(
      "中文「不存在」依然识别为不存在 → null",
      await fs.readText("/r/index.json"),
      null,
    );

    readImpl = async (p) => ({ path: p, content: '{"shaders":{}}', size: 15 });
    calls.length = 0;
    eq(
      "正常读取取的是 .content 字段",
      await fs.readText("/r/index.json"),
      '{"shaders":{}}',
    );
    eq("read 走 android 环境", calls[calls.length - 1][2], "android");
  }

  console.log("── list：isDirectory → isDir ──");
  {
    const entries = await fs.list("/r");
    eq("返回 2 条", entries.length, 2);
    eq("文件条目 isDir=false", entries[0].isDir, false);
    eq("文件条目 size 原样保留", entries[0].size, 11);
    eq("目录条目 isDir=true", entries[1].isDir, true);
    ok("目录条目的 name 准确", entries[1].name === "shaders", entries[1].name);
  }

  console.log("── move：必须能在目标已存在时覆盖（原子写依赖这条）──");
  {
    calls.length = 0;
    moveImpl = async () => undefined;
    await fs.move("/r/index.json.tmp", "/r/index.json");
    eq(
      "正常情况下只调一次 move",
      calls.filter((c) => c[0] === "move").length,
      1,
    );
    eq("没有多余删除", calls.filter((c) => c[0] === "deleteFile").length, 0);

    // 模拟「目标已存在导致 move 失败」
    calls.length = 0;
    let firstMove = true;
    moveImpl = async () => {
      if (firstMove) {
        firstMove = false;
        throw new Error("destination already exists");
      }
      return undefined;
    };
    await fs.move("/r/index.json.tmp", "/r/index.json");
    const moves = calls.filter((c) => c[0] === "move");
    const deletes = calls.filter((c) => c[0] === "deleteFile");
    eq("失败后重试 → 共 2 次 move", moves.length, 2);
    eq("中间删掉了目标", deletes.length, 1);
    eq("删的正是目标路径", deletes[0][1], "/r/index.json");
    eq("没有递归删（只删文件）", deletes[0][2], false);
    eq("重试仍是同一个目标", moves[1][2], "/r/index.json");
  }

  console.log("── size：文件不存在返回 -1（配额与 LRU 依赖这个约定）──");
  infoImpl = async (p) => ({
    path: p,
    exists: false,
    fileType: "other",
    size: 0,
    lastModified: "",
  });
  eq("exists=false → -1", await fs.size("/r/textures/x.png"), -1);

  infoImpl = async () => {
    throw missing();
  };
  eq("info 抛异常 → -1", await fs.size("/r/textures/x.png"), -1);

  infoImpl = async (p) => ({
    path: p,
    exists: true,
    fileType: "file",
    size: 4096,
    lastModified: "",
  });
  eq("存在 → 真实字节数", await fs.size("/r/textures/x.png"), 4096);

  console.log("── 纹理 hash：用宿主 CryptoJS，不自己造 ──");
  eq(
    "hashTextureUrl 走 CryptoJS.MD5",
    hashTextureUrl("https://s/a.png"),
    "md5(https://s/a.png)",
  );
  eq(
    "同一 URL 稳定",
    hashTextureUrl("https://s/a.png"),
    hashTextureUrl("https://s/a.png"),
  );
  ok(
    "不同 URL 不同",
    hashTextureUrl("https://s/a.png") !== hashTextureUrl("https://s/b.png"),
  );

  console.log(
    "── 根目录可写性探测（省得用户在真机上面对一个莫名空白的缓存页）──",
  );
  {
    // 探针会写 'ok' 再读回来，所以这里的 read 必须真的返回 'ok'，否则测的是失败路径
    readImpl = async (p) => ({ path: p, content: "ok", size: 2 });
    const r = await verifyRootWritable(
      "/sdcard/Download/Operit/plugins/shader_feed",
    );
    ok("正常时 ok=true", r.ok === true, r.message);
    ok(
      "消息里带真实路径",
      r.message.includes("/sdcard/Download/Operit/plugins/shader_feed"),
      r.message,
    );

    // 写失败
    const origWrite = globalThis.Tools.Files.write;
    globalThis.Tools.Files.write = async () => {
      throw new Error("EACCES: permission denied");
    };
    const bad = await verifyRootWritable("/sdcard/nope");
    ok("写不进去时 ok=false", bad.ok === false, bad.message);
    ok(
      "失败原因里带路径与原始错误",
      bad.message.includes("/sdcard/nope") && bad.message.includes("EACCES"),
      bad.message,
    );
    globalThis.Tools.Files.write = origWrite;

    // 读回不一致
    readImpl = async () => ({ path: "x", content: "NOT-OK", size: 5 });
    const mismatch = await verifyRootWritable("/sdcard/x");
    ok("读回不一致时 ok=false", mismatch.ok === false, mismatch.message);
    ok(
      "不一致的提示也可读",
      mismatch.message.includes("读回"),
      mismatch.message,
    );
    readImpl = async (p) => ({ path: p, content: "", size: 0 });

    eq(
      "默认根目录就是平台约定路径",
      DEFAULT_STORE_ROOT,
      "/sdcard/Download/Operit/plugins/shader_feed",
    );
  }

  console.log(`\n${pass}/${pass + failures.length} 通过`);
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败`);
    process.exit(1);
  }
  console.log(
    "✓ Tools.Files 映射、缺失文件语义、move 覆盖退路、根目录可写探测全部锁住",
  );
}

main();
