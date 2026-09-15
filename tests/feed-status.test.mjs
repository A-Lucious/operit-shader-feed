#!/usr/bin/env node
/**
 * 「feed 状态 → 用户看到的那句话」的离线测试。
 *
 * 这个映射写错的两个方向都很糟（README 点名的区分）：
 *   - 缓冲一空就喊「卡住了」→ 在最需要耐心的时刻吓用户
 *   - 该说话时什么都不说 → 界面静默冻结，用户上滑没反应也不知道为什么
 *
 * 用法： node tests/feed-status.test.mjs   （需先跑 npx tsc）
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATUS_JS = join(ROOT, "dist/feed/feed-status.js");
if (!existsSync(STATUS_JS)) {
  console.error("✗ 找不到编译产物，先跑 npx tsc");
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { describeFeedStatus } = require(STATUS_JS);

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

/** 正常播放中的基准输入，各用例只改需要改的字段。 */
const BASE = {
  ahead: 1,
  waiting: false,
  exhausted: false,
  paused: false,
  index: 1,
  offline: true,
};

function status(patch) {
  return describeFeedStatus(Object.assign({}, BASE, patch));
}

function main() {
  console.log("── 正常播放中：说清楚还有多少条 ──");
  {
    const t = status({ ahead: 5 });
    ok("包含待播条数", t.includes("前方 5 条待播"), t);
    ok("顺带交代节奏（30 秒）", t.includes("30 秒"), t);
    ok("1 条时也读得通", status({ ahead: 1 }).includes("前方 1 条待播"), status({ ahead: 1 }));
  }

  console.log("── 缓冲为空但当前这条还在正常播：绝不能喊「卡住了」──");
  {
    const t = status({ ahead: 0, waiting: false, index: 3 });
    ok("不说「卡住」", !t.includes("卡住"), t);
    ok("说「补货中」", t.includes("补货"), t);
  }

  console.log("── 真的卡住：区分「源已耗尽」与「暂时拿不到」──");
  {
    const done = status({ ahead: 0, waiting: true, exhausted: true, index: 12 });
    ok("耗尽时说「刷完」而不是「卡住」", done.includes("刷完") && !done.includes("卡住"), done);
    ok("交代规模（共 12 条）", done.includes("12"), done);
    ok("给出可行动项（连网）", done.includes("连网"), done);

    const online = status({ ahead: 0, waiting: true, exhausted: true, index: 4, offline: false });
    ok("在线源耗尽时不提「缓存」（会误导）", !online.includes("缓存"), online);

    const stuck = status({ ahead: 0, waiting: true, exhausted: false, index: 2, offline: false });
    ok("只是拿不到时才说「卡住」", stuck.includes("卡住"), stuck);
    ok("并给出可行动项（检查网络）", stuck.includes("网络"), stuck);
  }

  console.log("── 暂停优先于其它状态 ──");
  {
    const t = status({ ahead: 0, waiting: true, exhausted: true, paused: true, index: 9 });
    ok("暂停时只说暂停", t.includes("已暂停") && !t.includes("卡住") && !t.includes("刷完"), t);
  }

  console.log("── 穷举布尔组合：任何输入都不能产出空话或串出 undefined/NaN ──");
  {
    let bad = "";
    let checked = 0;
    for (const waiting of [false, true]) {
      for (const exhausted of [false, true]) {
        for (const paused of [false, true]) {
          for (const offline of [false, true]) {
            for (const ahead of [0, 1, 7]) {
              for (const index of [0, 12]) {
                checked++;
                const t = describeFeedStatus({
                  ahead,
                  waiting,
                  exhausted,
                  paused,
                  index,
                  offline,
                });
                if (!bad && (!t || t.trim() === "")) {
                  bad = "空字符串 ← " + JSON.stringify({ waiting, exhausted, paused, offline, ahead, index });
                }
                if (!bad && (t.includes("undefined") || t.includes("NaN"))) {
                  bad = "串出了 " + t;
                }
              }
            }
          }
        }
      }
    }
    eq("组合数", checked, 96);
    eq("没有空话/串值", bad, "");
  }

  console.log(`\n${pass}/${pass + failures.length} 通过`);
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败`);
    process.exit(1);
  }
  console.log(
    "✓ 「缓冲空 ≠ 卡住」这个区分、以及每种状态的可行动措辞 全部锁住",
  );
}

main();
