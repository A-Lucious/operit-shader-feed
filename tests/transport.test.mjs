#!/usr/bin/env node
/**
 * P1c 传输层的离线测试。
 *
 * transport.ts 只跟一个 SessionBridge 打交道（不认识 WebView / ToolPkg），
 * 所以请求编号、结果关联、超时、错误映射都能用假 bridge 在 Node 里真测。
 *
 * 这里最重要的一组是**并发反串包**：20 条并发详情请求如果结果串了，
 * 真机上的表现是「滑到某条 shader 出来的是别人的画面」——极难查。
 *
 * 用法： node tests/transport.test.mjs   （需先跑 npx tsc）
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPILED = join(ROOT, "dist/feed/transport.js");
if (!existsSync(COMPILED)) {
  console.error(`✗ 找不到 ${COMPILED}，先跑 npx tsc`);
  process.exit(2);
}
const require = createRequire(import.meta.url);
const { createSessionTransport, buildFetchScript, defaultRecipe } = require(
  COMPILED,
);

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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 假 bridge：记录注入的脚本，并允许测试手动投递结果（可乱序）。 */
function makeFakeBridge() {
  const injected = [];
  let callback = null;
  return {
    injected,
    bridge: {
      inject(script) {
        injected.push(script);
      },
      onResult(cb) {
        callback = cb;
        return () => {
          callback = null;
        };
      },
    },
    /** 投递结果；返回 false 表示当前没有回调可投（用来验证 dispose 真的解绑了）。 */
    deliver(requestId, ok_, payload) {
      if (!callback) return false;
      callback(requestId, ok_, payload);
      return true;
    },
    /** 从注入脚本里抠出 requestId —— 顺带验证脚本确实带上了这个形状的 id。 */
    requestIds() {
      return injected.map((s) => {
        const m = s.match(/"id":"(r[0-9_]+)"/);
        return m ? m[1] : null;
      });
    },
    lastRequestId() {
      const ids = this.requestIds();
      return ids[ids.length - 1];
    },
  };
}

async function main() {
  console.log("── 请求配方（契约探测的输出就填这一处）──");
  {
    const recipe = defaultRecipe();
    const detail = recipe.detail("4dXGR8");
    eq("详情走站点内部接口", detail.path, "/shadertoy");
    eq("详情用 POST", detail.method, "POST");
    ok(
      "详情 body 带上 shader id",
      detail.body.includes("s=4dXGR8"),
      detail.body,
    );
    const list = recipe.list("", 12);
    eq("列表也走同一个接口", list.path, "/shadertoy");
    ok("列表 body 带分页参数", list.body.includes("nl="), list.body);
  }

  console.log("── 注入脚本：不能有反斜杠（模板字面量会吞掉转义）──");
  {
    const script = buildFetchScript("r1_1", {
      path: "/shadertoy",
      method: "POST",
      body: "s=x",
    });
    ok("脚本里没有任何反斜杠", !script.includes("\\"), script.slice(0, 80));
    ok("脚本带上了 requestId", script.includes('"id":"r1_1"'));
    ok(
      "脚本用的是相对路径（同源才能带 cf_clearance）",
      script.includes('"/shadertoy"'),
    );
    ok("脚本带 credentials:include", script.includes('credentials: "include"'));
    ok("脚本通过 fetchResult 回传", script.includes("ShaderHost.fetchResult"));
  }

  console.log("── 正常流程 ──");
  {
    const fake = makeFakeBridge();
    const transport = createSessionTransport(fake.bridge, defaultRecipe(), {
      timeoutMs: 200,
    });
    const promise = transport.fetchShader("abc123");
    await wait(0);
    eq("注入了一次脚本", fake.injected.length, 1);
    fake.deliver(
      fake.lastRequestId(),
      true,
      '{"Shader":{"info":{"id":"abc123"}}}',
    );
    const result = await promise;
    eq("拿到 ok", result.ok, true);
    ok("文本原样回传", result.text.includes("abc123"), result.text);
  }

  console.log("── 非 2xx / 网络错误 → ok:false ──");
  {
    const fake = makeFakeBridge();
    const transport = createSessionTransport(fake.bridge, defaultRecipe(), {
      timeoutMs: 200,
    });
    const promise = transport.fetchShader("bad");
    await wait(0);
    fake.deliver(fake.lastRequestId(), false, "fetch failed: 403");
    const result = await promise;
    eq("ok=false", result.ok, false);
    ok("错误信息保留", result.error.includes("403"), result.error);
  }

  console.log("── 反串包：并发结果乱序投递也必须各拿各的 ──");
  {
    const fake = makeFakeBridge();
    const transport = createSessionTransport(fake.bridge, defaultRecipe(), {
      timeoutMs: 2000,
    });
    const ids = ["aa1", "bb2", "cc3", "dd4", "ee5"];
    const promises = ids.map((id) => transport.fetchShader(id));
    await wait(0);
    eq("5 条并发都注入了", fake.injected.length, 5);

    const requestIds = fake.requestIds();
    eq(
      "5 个 requestId 互不相同",
      new Set(requestIds).size,
      5,
      JSON.stringify(requestIds),
    );

    // 关键：**逆序**投递结果
    for (let i = ids.length - 1; i >= 0; i--) {
      fake.deliver(requestIds[i], true, "payload-for-" + ids[i]);
    }
    const results = await Promise.all(promises);
    let allMatched = true;
    for (let i = 0; i < ids.length; i++) {
      if (!results[i].text.includes(ids[i])) {
        allMatched = false;
        console.log(
          `      串包: 第 ${i} 条期望含 ${ids[i]}，实际 ${results[i].text}`,
        );
      }
    }
    ok("逆序投递下每条都拿到自己的响应（无串包）", allMatched);
  }

  console.log("── 超时兜底（bridge 不回头时不能让爬虫永久停摆）──");
  {
    const fake = makeFakeBridge();
    const transport = createSessionTransport(fake.bridge, defaultRecipe(), {
      timeoutMs: 60,
    });
    const started = Date.now();
    const result = await transport.fetchShader("never");
    const elapsed = Date.now() - started;
    eq("超时后返回 ok=false", result.ok, false);
    ok("错误信息说明是超时", result.error.includes("超时"), result.error);
    ok("确实等了约 timeoutMs", elapsed >= 50 && elapsed < 1000, elapsed + "ms");

    // 超时之后再迟到的结果不应该再影响任何人，也不应抛异常
    let threw = null;
    try {
      fake.deliver(fake.lastRequestId(), true, "late");
    } catch (err) {
      threw = err;
    }
    ok(
      "迟到结果被安全忽略（不抛、不串包）",
      threw === null,
      threw && String(threw.message),
    );
  }

  console.log("── 注入失败要立刻落地，不能等到超时 ──");
  {
    const bridge = {
      inject() {
        throw new Error("WebView 已销毁");
      },
      onResult() {
        return () => {};
      },
    };
    const transport = createSessionTransport(bridge, defaultRecipe(), {
      timeoutMs: 5000,
    });
    const started = Date.now();
    const result = await transport.fetchShader("x");
    eq("注入失败 → ok=false", result.ok, false);
    ok("原因可读", result.error.includes("注入脚本失败"), result.error);
    ok("没有白等超时", Date.now() - started < 500, Date.now() - started + "ms");
  }

  console.log("── 列表响应：多变体抽取 + 耗尽判定 ──");
  {
    const fake = makeFakeBridge();
    const transport = createSessionTransport(fake.bridge, defaultRecipe(), {
      timeoutMs: 500,
    });
    const promise = transport.listIds("", 12);
    await wait(0);
    fake.deliver(
      fake.lastRequestId(),
      true,
      JSON.stringify(["idA", "idB", "idC"]),
    );
    const page = await promise;
    eq("ok", page.ok, true);
    eq("抽到 3 个 id", page.ids.length, 3);
    eq("返回的 id 正确", page.ids.join(","), "idA,idB,idC");
    eq("游标推进到最后一条", page.nextCursor, "idC");
    eq("没到底", page.exhausted, false);
  }
  {
    const fake = makeFakeBridge();
    const transport = createSessionTransport(fake.bridge, defaultRecipe(), {
      timeoutMs: 500,
    });
    const promise = transport.listIds("", 12);
    await wait(0);
    fake.deliver(fake.lastRequestId(), true, JSON.stringify([]));
    const page = await promise;
    eq("空列表 → exhausted", page.exhausted, true);
    eq("空列表 → ids 为空", page.ids.length, 0);
  }
  {
    const fake = makeFakeBridge();
    const transport = createSessionTransport(fake.bridge, defaultRecipe(), {
      timeoutMs: 500,
    });
    const promise = transport.listIds("", 12);
    await wait(0);
    fake.deliver(
      fake.lastRequestId(),
      true,
      JSON.stringify({
        Results: [
          { id: "ok1" },
          { id: "ok2" },
          { name: "hello world" },
          { id: "x".repeat(40) },
        ],
      }),
    );
    const page = await promise;
    eq("对象数组取 .id", page.ids.join(","), "ok1,ok2");
  }
  {
    const fake = makeFakeBridge();
    const transport = createSessionTransport(fake.bridge, defaultRecipe(), {
      timeoutMs: 500,
    });
    const promise = transport.listIds("", 12);
    await wait(0);
    fake.deliver(fake.lastRequestId(), true, "<<< 不是 JSON");
    const page = await promise;
    eq("非法 JSON → exhausted（不崩、不空转）", page.exhausted, true);
    eq("非法 JSON → ids 为空", page.ids.length, 0);
  }

  console.log("── 自定义配方：契约探测出真值后只改这一处 ──");
  {
    const fake = makeFakeBridge();
    const recipe = {
      list: () => ({ path: "/api/v1/shaders/query/newest", method: "GET" }),
      detail: (id) => ({ path: "/api/v1/shaders/" + id, method: "GET" }),
    };
    const transport = createSessionTransport(fake.bridge, recipe, {
      timeoutMs: 500,
    });
    // 这个请求不会被投递结果，所以它应当按超时落地。
    // （原先写的是 `const promise = ...` 但从不 await —— 浮动 Promise 一旦 reject 就是
    //  未处理的 rejection，而且不报任何错。）
    const settled = await transport.fetchShader("zz9");
    eq("未投递的请求按超时落地（不永久挂起）", settled.ok, false);
    await wait(0);
    ok(
      "自定义详情的路径进了脚本",
      fake.injected[0].includes("/api/v1/shaders/zz9"),
      fake.injected[0].slice(0, 120),
    );
    ok(
      "GET 不带 body",
      !fake.injected[0].includes("init.body = REQ.body;") ||
        fake.injected[0].includes("if (REQ.body)"),
    );
  }

  console.log("── dispose：未决请求必须就地失败，不能只从表里删掉 ──");
  {
    const fake = makeFakeBridge();
    // 超时故意设得很长（60 秒）：若不就地失败，这条测试会挂在这里而不是通过
    const transport = createSessionTransport(fake.bridge, defaultRecipe(), { timeoutMs: 60000 });

    const p1 = transport.fetchShader('a');
    const p2 = transport.fetchShader('b');
    await wait(0);
    eq('两个请求都注入了', fake.injected.length, 2);
    eq('dispose 之前 bridge 是接着的', fake.deliver(fake.requestIds()[0], true, 'x'), true);

    // p1 已被上面的投递落地；再造一个未决的来验证取消
    const p3 = transport.fetchShader('c');
    await wait(0);

    transport.dispose();

    const r1 = await p1;
    const r2 = await p2;
    const r3 = await p3;
    ok('未决请求立刻失败，而不是等 60 秒超时', r2.ok === false && r3.ok === false,
      JSON.stringify([r1.ok, r2.ok, r3.ok]));
    ok('错误信息说明是被关闭/取消的', String(r3.error).includes('已关闭'), String(r3.error));
    eq('dispose 之后 bridge 确实解绑了', fake.deliver(fake.requestIds()[0], true, 'late'), false);
    // 不要写成 `r1.ok === true || r1.ok === false` —— 那是恒真的同义反复，
    // 比没有断言更糟（它把“没验证”伪装成“验证通过”）。
    eq('dispose 之前已落地的结果保持 ok:true', r1.ok, true);

    // dispose 之后的新请求要立刻失败，而不是挂在那儿等超时
    const started = Date.now();
    const after = await transport.fetchShader('d');
    eq('dispose 后新请求立刻失败', after.ok, false);
    ok('没有白等超时', Date.now() - started < 500, Date.now() - started + 'ms');
    ok('新请求的失败原因可读', String(after.error).includes('已关闭'), String(after.error));
  }

  console.log(`\n${pass}/${pass + failures.length} 通过`);
  if (failures.length) {
    console.error(`✗ ${failures.length} 项失败`);
    process.exit(1);
  }
  console.log(
    "✓ 传输层（配方构造 / 脚本无反斜杠 / 乱序投递不串包 / 超时兜底 / 注入失败短路 / 多变体列表抽取）全部锁住",
  );
}

main();
