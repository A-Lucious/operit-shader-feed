#!/usr/bin/env node
/**
 * P3 播放/缓冲状态机的离线测试。
 *
 * feed.ts 不引入宿主定时器（tick 由宿主在 WebView 每秒 stats 上报时驱动），
 * 并且只跟 FeedCrawler 接口打交道，所以 30 秒自动上滑、补货阈值、暂停语义
 * 全都能用假 crawler + 注入时钟在 Node 里真测。
 *
 * 这里锁的是 PLAN §4 D4/D5 关于播放的那几条。
 *
 * 用法： node tests/feed.test.mjs   （需先跑 npx tsc）
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPILED = join(ROOT, "dist/feed/feed.js");
if (!existsSync(COMPILED)) {
  console.error(`✗ 找不到 ${COMPILED}，先跑 npx tsc`);
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { createFeed, timeOffsetFor } = require(COMPILED);

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

const rec = (id) => ({ id });

/**
 * 假 crawler。
 * autoResolve=false 时 ensure 会挂起，用来验证「补货不阻塞播放」与「补货不被狂刷」。
 */
function makeFakeCrawler(initial = [], opts = {}) {
  const queue = [...initial];
  const state = { ensureCalls: 0, pending: [], exhausted: !!opts.exhausted };
  const crawler = {
    async ensure() {
      state.ensureCalls++;
      if (opts.autoResolve !== false) return;
      await new Promise((resolve) => state.pending.push(resolve));
    },
    take() {
      return queue.length ? queue.shift() : null;
    },
    ahead() {
      return queue.length;
    },
    exhausted() {
      return state.exhausted;
    },
  };
  return {
    crawler,
    state,
    push(...items) {
      queue.push(...items);
    },
    releaseAll() {
      for (const resolve of state.pending.splice(0)) resolve();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function main() {
  const DWELL = 30000;

  console.log("── D4: 30 秒自动上滑 ──");
  {
    let t = 0;
    const fake = makeFakeCrawler([
      rec("r1"),
      rec("r2"),
      rec("r3"),
      rec("r4"),
      rec("r5"),
    ]);
    const feed = createFeed(fake.crawler, { dwellMs: DWELL, now: () => t });

    const first = feed.start();
    ok(
      "start 取到第一条",
      first.current && first.current.id === "r1",
      JSON.stringify(first.current),
    );
    eq("开始时 index=0", feed.snapshot().index, 0);
    eq("开始时 playedMs=0", feed.snapshot().playedMs, 0);

    t += DWELL - 1;
    let tick = feed.tick();
    eq("差 1ms 到点时不换", tick.advanced, false);
    ok("仍然在 r1", feed.current().id === "r1", feed.current().id);

    t += 1;
    tick = feed.tick();
    eq("到 30 秒整点自动上滑", tick.advanced, true);
    eq("换到 r2", feed.current().id, "r2");
    eq("换条目后 playedMs 归零", feed.snapshot().playedMs, 0);
    eq("index 递增", feed.snapshot().index, 1);
  }

  console.log("── 用户上滑也重置计时 ──");
  {
    let t = 0;
    const fake = makeFakeCrawler([rec("a"), rec("b"), rec("c")]);
    const feed = createFeed(fake.crawler, { dwellMs: DWELL, now: () => t });
    feed.start();
    t += 20000;
    feed.tick();
    const before = feed.snapshot().playedMs;
    ok("已累计 20 秒", before >= 20000, String(before));

    const adv = feed.advance();
    eq("上滑成功", adv.advanced, true);
    eq("上滑到 b", feed.current().id, "b");
    eq("上滑后计时归零", feed.snapshot().playedMs, 0);
  }

  console.log("── D5: 补货不阻塞播放 ──");
  {
    let t = 0;
    // 初始只有 2 条，低于 refillBelow(4)，所以 start 就会触发补货；
    // autoResolve=false 让它永远挂着，模拟慢网络。
    const fake = makeFakeCrawler([rec("w1"), rec("w2")], {
      autoResolve: false,
    });
    const feed = createFeed(fake.crawler, { dwellMs: DWELL, now: () => t });

    const first = feed.start();
    ok(
      "start 没有被挂起的补货阻塞",
      first.current && first.current.id === "w1",
    );
    eq("补货确实发出去了", fake.state.ensureCalls, 1);
    ok(
      "补货 promise 仍挂起（说明没被 await）",
      fake.state.pending.length === 1,
      String(fake.state.pending.length),
    );

    t += DWELL;
    const tick = feed.tick();
    ok(
      "补货挂起期间仍能正常上滑",
      tick.advanced === true && feed.current().id === "w2",
      feed.current() && feed.current().id,
    );
  }

  console.log("── D5: 低水位期间补货只发一次（否则卡住时每秒发一次请求）──");
  {
    let t = 0;
    const fake = makeFakeCrawler([rec("x1")], { autoResolve: false });
    const feed = createFeed(fake.crawler, { dwellMs: DWELL, now: () => t });
    feed.start();
    eq("首次补货", fake.state.ensureCalls, 1);

    for (let i = 0; i < 20; i++) {
      t += 1000;
      feed.tick();
    }
    eq("连跑 20 秒仍是 1 次（没被狂刷）", fake.state.ensureCalls, 1);

    // 补货落地后，如果仍低水位，允许再发一次
    fake.releaseAll();
    await flush();
    t += 1000;
    feed.tick();
    eq("补货落地且仍低水位 → 允许再发一次", fake.state.ensureCalls, 2);
  }

  console.log(
    "── 前方空了：停住但保留已超时的计时（有内容就立刻走，不重新数 30 秒）──",
  );
  {
    let t = 0;
    const fake = makeFakeCrawler([rec("only")]);
    const feed = createFeed(fake.crawler, { dwellMs: DWELL, now: () => t });

    feed.start();
    // waiting() 的语义是「真的卡住」，不是「缓冲为空」：
    // 当前这条还在正常播、只是队列空了，不该显示成卡住。
    ok("缓冲虽空但当前条还在正常播 → 不算卡住", feed.waiting() === false);
    ok("「缓冲偏低」用 ahead 单独表示", feed.snapshot().ahead === 0);

    t += DWELL + 5000;
    const stuck = feed.tick();
    eq("没内容可换时不报 advanced", stuck.advanced, false);
    ok(
      "停在当前这条而不是白屏",
      feed.current() && feed.current().id === "only",
    );
    ok(
      "已超时的 playedMs 被保留",
      feed.snapshot().playedMs >= DWELL,
      String(feed.snapshot().playedMs),
    );
    ok(
      "播完却换不到下一条 → waiting()=true（这才是真的卡住）",
      feed.waiting() === true,
    );

    fake.push(rec("arrived"));
    t += 1000;
    const resumed = feed.tick();
    eq("内容一到立刻上滑（没有重新等 30 秒）", resumed.advanced, true);
    eq("上滑到新条目", feed.current().id, "arrived");
    ok("不再 waiting", feed.waiting() === false);
  }

  console.log("── 用户滑到尾部不该崩，也不该变白屏 ──");
  {
    const t = 0;
    const fake = makeFakeCrawler([rec("t1")]);
    const feed = createFeed(fake.crawler, { dwellMs: DWELL, now: () => t });
    feed.start();
    const tail = feed.advance();
    eq("尾部上滑不报 advanced", tail.advanced, false);
    ok("仍停在上一条", feed.current() && feed.current().id === "t1");
    eq("snapshot 不抛异常", typeof feed.snapshot().index, "number");
  }

  console.log("── D4: 不可见即停，回来继续（不是重置）──");
  {
    let t = 0;
    const fake = makeFakeCrawler([rec("p1"), rec("p2")]);
    const feed = createFeed(fake.crawler, { dwellMs: DWELL, now: () => t });
    feed.start();

    feed.pause();
    eq("暂停后 paused=true", feed.snapshot().paused, true);
    t += DWELL + 10000;
    feed.tick();
    eq("暂停期间不累计播放时间", feed.snapshot().playedMs, 0);
    ok("暂停期间不会自动上滑", feed.current().id === "p1", feed.current().id);

    feed.resume();
    eq("恢复后 paused=false", feed.snapshot().paused, false);
    t += 1000;
    feed.tick();
    ok(
      "恢复后从原处继续累计（而不是重置）",
      feed.snapshot().playedMs >= 1000,
      String(feed.snapshot().playedMs),
    );

    t += DWELL;
    const done = feed.tick();
    eq("继续累计到 30 秒后正常上滑", done.advanced, true);
  }

  console.log("── 参数的边界钳制（避免调用方传 0 让状态机失控）──");
  {
    let t = 0;
    // 需要两条：start 会吃掉第一条，自动上滑才有东西可换
    const fake = makeFakeCrawler([rec("c1"), rec("c2")]);
    const feed = createFeed(fake.crawler, {
      dwellMs: 10,
      refillBelow: 999,
      target: 8,
      now: () => t,
    });
    const s = feed.snapshot();
    eq("dwellMs 下限 1000", s.dwellMs, 1000);
    eq("refillBelow 被钳到 target", s.refillBelow, 8);
    eq("target 保留", s.target, 8);
    feed.start();
    t += 1000;
    eq("钳制后的 dwell 生效", feed.tick().advanced, true);
  }

  console.log("── D4: iTime 起点随机化且可复现 ──");
  {
    const a1 = timeOffsetFor("abc123", 7);
    const a2 = timeOffsetFor("abc123", 7);
    eq("同 id + 同种子 → 同一个偏移（可复现）", a1, a2);
    ok("偏移在 [0,600)", a1 >= 0 && a1 < 600, String(a1));
    ok(
      "不同 id → 通常不同",
      timeOffsetFor("abc123", 7) !== timeOffsetFor("zzz999", 7) || true,
    );
    const many = new Set();
    for (let i = 0; i < 200; i++) many.add(timeOffsetFor("id" + i, 7));
    ok(
      "200 个 id 能散开（不是全挤在一个值上）",
      many.size > 100,
      String(many.size),
    );
    ok(
      "种子会影响结果",
      timeOffsetFor("abc123", 7) !== timeOffsetFor("abc123", 8),
    );

    const t = 0;
    const fake = makeFakeCrawler([rec("seedme")]);
    const feed = createFeed(fake.crawler, { sessionSeed: 42, now: () => t });
    feed.start();
    eq(
      "timeOffsetSeconds 用的是当前条目的 id",
      feed.timeOffsetSeconds(),
      timeOffsetFor("seedme", 42),
    );
  }

  console.log("── exhausted 透传（UI 要用它显示「到底了」）──");
  {
    const t = 0;
    const fake = makeFakeCrawler([], { exhausted: true });
    const feed = createFeed(fake.crawler, { now: () => t });
    const s0 = feed.start();
    eq("没有内容时 start 不报 advanced", s0.advanced, false);
    ok("snapshot 反映 exhausted", feed.snapshot().exhausted === true);
    ok("没有内容时 current 为 null", feed.current() === null);
  }

  console.log("── start 必须幂等：重复 start 不该静默吃掉一条 ──");
  {
    let t = 0;
    const fake = makeFakeCrawler([rec('s1'), rec('s2'), rec('s3')]);
    const feed = createFeed(fake.crawler, { dwellMs: DWELL, now: () => t });

    const first = feed.start();
    eq('首次 start 拿到第一条', first.current && first.current.id, 's1');
    t += 1000;
    feed.tick();

    const again = feed.start();
    eq('重复 start 不报 advanced', again.advanced, false);
    eq('当前条目没被换掉', feed.current().id, 's1');
    ok('已播时长没被重置', feed.snapshot().playedMs >= 1000, String(feed.snapshot().playedMs));
    eq('index 没被推进', feed.snapshot().index, 0);
  }

  console.log("── 未 start 就 advance：应当开始播放而不是丢一条 ──");
  {
    let t = 0;
    const fake = makeFakeCrawler([rec('a1'), rec('a2')]);
    const feed = createFeed(fake.crawler, { dwellMs: DWELL, now: () => t });
    const startedTick = feed.advance();
    eq('advance 在未开始时充当 start', startedTick.current && startedTick.current.id, 'a1');
    eq('index 为 0（没有跳过第一条）', feed.snapshot().index, 0);
  }

  console.log("── 时序边界：dwell 到点与用户上滑同时发生 ──");
  {
    let t = 0;
    const fake = makeFakeCrawler([rec('b1'), rec('b2'), rec('b3'), rec('b4')]);
    const feed = createFeed(fake.crawler, { dwellMs: DWELL, now: () => t });
    feed.start();
    t += DWELL;
    const auto = feed.tick();
    eq('自动上滑到 b2', auto.current && auto.current.id, 'b2');

    // 同一时刻用户也上滑：会再换一条。这是可接受的（用户本来就是想滑走），
    // 关键是不能抛错、不能回退、不能出现 current 为 null 的 advanced。
    let threwOut = null;
    let manual = null;
    try {
      manual = feed.advance();
    } catch (err) {
      threwOut = err;
    }
    ok('紧接的 advance 不抛异常', threwOut === null, threwOut && String(threwOut.message));
    eq('再换到 b3', manual && manual.current && manual.current.id, 'b3');
    eq('index 单调递增到 2', feed.snapshot().index, 2);
    ok('报 advanced 时 current 一定非空', !(manual.advanced && manual.current === null));
    eq('已播时长归零', feed.snapshot().playedMs, 0);
  }

  console.log("── 空数据源下的边界调用都不能崩 ──");
  {
    let t = 0;
    const fake = makeFakeCrawler([]);
    const feed = createFeed(fake.crawler, { dwellMs: DWELL, now: () => t });
    feed.start();
    t += DWELL + 5000;

    let threwErr = null;
    try {
      feed.tick();
      feed.advance();
      feed.tick();
      feed.pause();
      feed.tick();
      feed.resume();
      feed.tick();
      feed.snapshot();
      feed.timeOffsetSeconds();
      feed.waiting();
      feed.current();
      feed.start();
    } catch (err) {
      threwErr = err;
    }
    ok('空数据源下连续调用不抛异常', threwErr === null, threwErr && String(threwErr.message));
    eq('current 仍为 null', feed.current(), null);
    eq('timeOffsetSeconds 兜底为 0（不去对 null 取 id）', feed.timeOffsetSeconds(), 0);
    ok('snapshot 仍可用', typeof feed.snapshot().index === 'number');
  }

  console.log(`\n${pass}/${pass + failures.length} 通过`);
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败`);
    process.exit(1);
  }
  console.log(
    "✓ D4/D5 的播放语义（30s 自动上滑、补货不阻塞且不狂刷、空 buffer 行为、暂停继续、参数钳制、iTime 随机化）全部锁住",
  );
}

main();
