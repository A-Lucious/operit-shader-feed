#!/usr/bin/env node
/**
 * 单一验证门禁。**这是唯一的验收入口**，不要手工拼一串命令。
 *
 * 为什么必须存在：曾经出现过「tsc 失败 → 没有新 dist → 测试跑的是上一次的旧产物 →
 * 仍然报 47/47 通过 → 包也用旧 dist 打出来」这种**假绿**。
 * 那次是 biome 把 `Object.prototype.hasOwnProperty.call` 改写成 ES2022 的 `Object.hasOwn`，
 * 超出 tsconfig 的 lib，tsc 报 TS2550；而测试循环照样跑完并显示全绿。
 *
 * 所以本脚本的硬规矩：**第 1 步不过，后面一步都不许跑**。
 *
 * 步骤：
 *   1. tsc（失败即中止）
 *   2. 同步 deck: src/deck/shader-deck.js → resources/webview/runner.js
 *   3. 依次跑全部测试套件（任一套非零退出即中止）
 *   4. 打包 .toolpkg
 *   5. 解包回来与工作区逐字节比对（防止包内混入旧产物）
 *
 * 用法： node tools/check.mjs
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DECK_SRC = join(ROOT, "src/deck/shader-deck.js");
const DECK_SHIPPED = join(ROOT, "resources/webview/runner.js");

/**
 * 套件列表**自动发现**，不手写。
 *
 * 为什么：手写列表漏加一个新套件，就等于它永远不会被跑，而输出仍然显示全绿 ——
 * 这和之前那个「tsc 失败但测试报绿」是同一类洞。
 * 约定：tests/*.test.mjs 都是 node 套件；tests/run.mjs 是需要浏览器的套件，单独列。
 */
const SUITE_LABELS = {
  "host-fs.test.mjs": "宿主 FS 适配器",
  "store.test.mjs": "存储层",
  "crawler.test.mjs": "爬取队列",
  "feed.test.mjs": "播放/缓冲状态机",
  "parse.test.mjs": "解析层",
  "store-crawler.test.mjs": "缓存数据源",
  "transport.test.mjs": "传输层",
  "run.mjs": "P0 + 宿主握手（浏览器）",
};

function discoverSuites() {
  const dir = join(ROOT, "tests");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".test.mjs") || name === "run.mjs")
    .sort();
  const suites = files.map((name) => [
    SUITE_LABELS[name] || name,
    `tests/${name}`,
  ]);
  if (suites.length < 5) {
    die(
      0,
      `只发现 ${suites.length} 个测试套件，远少于预期 —— 目录或命名被改动了？`,
    );
  }
  return suites;
}

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function die(step, detail) {
  console.error(`\n✗ 门禁在第 ${step} 步中止`);
  if (detail) {
    console.error(detail);
  }
  process.exit(1);
}

// ---------------------------------------------------------------- 1. tsc

function compile() {
  const localTsc = join(ROOT, "node_modules/.bin/tsc");
  let out = "";
  try {
    // 无参数即按 tsconfig.json 编译（含 outDir: dist）。
    if (existsSync(localTsc)) {
      out = run(localTsc, []);
    } else {
      out = run("npx", ["--no-install", "tsc"]);
    }
  } catch (err) {
    const stdout = err.stdout ? String(err.stdout) : "";
    const stderr = err.stderr ? String(err.stderr) : "";
    die(1, `tsc 失败：\n${stdout}${stderr}`.trim());
  }
  if (out.trim()) {
    console.log(out.trim());
  }
  console.log("✓ 1/5 tsc 通过");
}

// ---------------------------------------------------------------- 2. deck 同步

function syncDeck() {
  if (!existsSync(DECK_SRC)) {
    die(2, `找不到 ${DECK_SRC}`);
  }
  copyFileSync(DECK_SRC, DECK_SHIPPED);
  console.log("✓ 2/5 deck 已同步 → resources/webview/runner.js");
}

// ---------------------------------------------------------------- 3. 测试套件

function runSuites() {
  let assertions = 0;
  const rows = [];
  for (const [name, file] of discoverSuites()) {
    let out = "";
    try {
      out = run(process.execPath, [file]);
    } catch (err) {
      const stdout = err.stdout ? String(err.stdout) : "";
      const stderr = err.stderr ? String(err.stderr) : "";
      const failed = stdout
        .split("\n")
        .filter((l) => l.includes("✗"))
        .slice(0, 8)
        .join("\n");
      die(3, `测试套件「${name}」失败：\n${failed}\n${stderr}`.trim());
    }
    const m = out.match(/^(\d+)\/(\d+) 通过\s*$/m);
    if (!m) {
      die(
        3,
        `测试套件「${name}」没有输出通过数，无法确认它真的跑了：\n${out.slice(-800)}`,
      );
    }
    const passed = Number(m[1]);
    const total = Number(m[2]);
    if (passed !== total) {
      die(3, `测试套件「${name}」有 ${total - passed} 项失败`);
    }
    assertions += total;
    rows.push([name, `${passed}/${total}`]);
  }
  const width = Math.max(...rows.map((r) => r[0].length));
  for (const [name, result] of rows) {
    console.log(`  ${name.padEnd(width)}  ${result}`);
  }
  console.log(`✓ 3/5 全部测试套件通过（共 ${assertions} 项断言）`);
  return assertions;
}

// ---------------------------------------------------------------- 4. 打包

function build() {
  let out = "";
  try {
    out = run(process.execPath, ["tools/build-toolpkg.mjs"]);
  } catch (err) {
    die(4, `${err.stdout || ""}${err.stderr || ""}`.trim());
  }
  const first = out.split("\n")[0];
  console.log(`✓ 4/5 ${first.replace(/^→ /, "已打包 ")}`);
  const path = first
    .replace(/^→ /, "")
    .replace(/\s+\(.*$/, "")
    .trim();
  if (!existsSync(path)) {
    die(4, `打包脚本报告了路径但文件不存在：${path}`);
  }
  return path;
}

// ---------------------------------------------------------------- 5. 包内容比对

function walk(dir, base = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walk(join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function verifyPackage(pkgPath) {
  const tmp = mkdtempSync(join(tmpdir(), "toolpkg-verify-"));
  try {
    run("unzip", ["-q", pkgPath, "-d", tmp]);
    const packaged = walk(tmp).sort();
    if (packaged.length === 0) {
      die(5, "解包后是空的");
    }
    const mismatched = [];
    for (const rel of packaged) {
      const a = join(tmp, rel);
      const b = join(ROOT, rel);
      if (!existsSync(b)) {
        mismatched.push(`${rel}（工作区里不存在）`);
        continue;
      }
      if (statSync(a).size !== statSync(b).size) {
        mismatched.push(`${rel}（大小不同）`);
        continue;
      }
      if (Buffer.compare(readFileSync(a), readFileSync(b)) !== 0) {
        mismatched.push(`${rel}（内容不同）`);
      }
    }
    if (mismatched.length) {
      die(
        5,
        `包内与工作区不一致，说明打进了旧产物：\n${mismatched.join("\n")}`,
      );
    }
    console.log(`✓ 5/5 包内 ${packaged.length} 个文件与工作区逐字节一致`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- main

console.log("── 验证门禁 ──");
compile();
syncDeck();
const assertions = runSuites();
const pkgPath = build();
verifyPackage(pkgPath);
console.log(`\n✓ 全部通过：${assertions} 项断言，产物 ${pkgPath}`);
