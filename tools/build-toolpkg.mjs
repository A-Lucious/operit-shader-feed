#!/usr/bin/env node
/**
 * 打包 .toolpkg（本质是 ZIP，manifest.json 必须在压缩包根目录）
 *
 * 只打运行期需要的文件。src/ tests/ tools/ tsconfig.json package.json 都是开发期产物，
 * 不进包 —— 包越小，宿主安装和重新扫描越快。
 *
 * 用法： node tools/build-toolpkg.mjs
 * 产物： release/<toolpkg_id>-<version>.toolpkg
 */

import {
  readFileSync,
  statSync,
  mkdirSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "release");

// 显式白名单，不用排除法：宁可漏带也不要悄悄把不该进包的东西塞进去。
const INCLUDE = ["manifest.json", "dist", "resources"];

/** 递归收集，base 保留顶层目录名（丢掉的后果是 dist/main.js 变成 main.js，包结构全错）。 */
function walk(absDir, base) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`读目录失败 ${base}: ${err.message}`);
  }
  for (const e of entries) {
    const rel = `${base}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(join(absDir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

function collectFiles() {
  const out = [];
  for (const entry of INCLUDE) {
    const abs = join(ROOT, entry);
    if (!existsSync(abs)) throw new Error(`打包清单里的东西不存在: ${entry}`);
    out.push(...(statSync(abs).isDirectory() ? walk(abs, entry) : [entry]));
  }
  return [...new Set(out)].sort();
}

function readManifest() {
  const p = join(ROOT, "manifest.json");
  if (!existsSync(p)) throw new Error("缺少 manifest.json");
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    throw new Error(`读不到 manifest.json: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest.json 不是合法 JSON: ${err.message}`);
  }
}

function main() {
  const manifest = readManifest();

  const files = collectFiles();
  if (!files.includes(manifest.main)) {
    throw new Error(
      `manifest.main 指向的文件不在打包清单里: ${manifest.main}（先跑 tsc）`,
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(
    OUT_DIR,
    `${manifest.toolpkg_id}-${manifest.version}.toolpkg`,
  );
  if (existsSync(outPath)) rmSync(outPath);

  execFileSync("zip", ["-q", "-r", "-X", outPath, ...files], { cwd: ROOT });

  let entries;
  try {
    entries = execFileSync("zipinfo", ["-1", outPath], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter((l) => l && !l.endsWith("/"));
  } catch (err) {
    throw new Error(`zipinfo 读包失败: ${err.message}`);
  }

  const sizeKb = Math.round(statSync(outPath).size / 1024);
  console.log(`→ ${outPath}  (${sizeKb} KB, ${entries.length} 个文件)`);
  for (const e of entries) console.log(`    ${e}`);

  // 打包正确性的硬检查。宿主按压缩包根目录找 manifest.json，
  // 放在子目录里导入会直接失败，所以这个断言不能省。
  if (!entries.includes("manifest.json")) {
    throw new Error("manifest.json 不在压缩包根目录，这个包宿主导入会失败");
  }
  const missing = [
    ...manifest.resources.map((r) => r.path),
    manifest.main,
    "manifest.json",
  ].filter((p) => !entries.includes(p));
  if (missing.length) {
    throw new Error(`manifest 声明了但包里没有: ${missing.join(", ")}`);
  }
  console.log("✓ 包结构校验通过（manifest 在根目录，声明的资源与入口都在）");
}

try {
  main();
} catch (err) {
  console.error(`✗ 打包失败: ${err.message}`);
  process.exit(1);
}
