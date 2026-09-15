/**
 * 工具脚本侧的逻辑：把 main 里的编译结果读回来，变成给 AI 看的文本。
 *
 * 为什么单独一个模块：工具脚本跑在 sandbox 上下文，`ToolPkg.ipc` 在那边才有；
 * 但**逻辑**（读不到时怎么说话、拿到非文本怎么办）跟运行环境无关，放这里就能离线测，
 * 工具脚本本身只留一行 RPC 调用。
 *
 * 两条硬要求：
 *   1. 这个函数**永远不抛异常**。工具抛异常的话，AI 拿到的是一段堆栈，
 *      而不是"现在该怎么办" —— 它就没法自己修了。
 *   2. 失败时**把原始错误放在最前面**。真机上工具结果是折叠的，前缀太长会把
 *      唯一有用的信息（宿主那条具体校验错误）截掉 —— 实测踩过一次：
 *      屏幕上只剩「读不到编译结果（跨运行时通…」，看不出到底哪一步错了。
 */

import { IPC_COMPILE_READ } from "../shared/chat-shader-state.js";

/** 与 `ToolPkg.ipc.call` 同形（第三个参数是可选的调用选项），便于测试注入。 */
export type IpcCaller = (
  channel: string,
  payload?: unknown,
  options?: { targetRuntime?: string },
) => Promise<unknown>;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 把通道返回值变成可用文本；不可用时返回 null（调用方负责兜底措辞）。 */
function asUsableText(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  return null;
}

export async function readCompileResultText(
  callIpc: IpcCaller,
): Promise<string> {
  const failures: string[] = [];

  // 第一次：不传选项。官方文档说非 main 上下文调用默认就发给本包的 main。
  try {
    const value = await callIpc(IPC_COMPILE_READ, {});
    const text = asUsableText(value);
    if (text !== null) {
      return text;
    }
    failures.push(
      "默认目标：通道回了非文本内容（" + describeUnexpected(value) + "）",
    );
  } catch (err) {
    failures.push("默认目标：" + errText(err));
  }

  // 第二次：显式指定 main。走的是宿主里**另一条**校验分支，所以值得再试一次。
  try {
    const value = await callIpc(
      IPC_COMPILE_READ,
      {},
      { targetRuntime: "main" },
    );
    const text = asUsableText(value);
    if (text !== null) {
      return text;
    }
    failures.push(
      "显式 main：通道回了非文本内容（" + describeUnexpected(value) + "）",
    );
  } catch (err) {
    failures.push("显式 main：" + errText(err));
  }

  // 原始错误放最前面（真机上工具结果折叠，后面的说明可能被截断）。
  return (
    "读不到编译结果。宿主的原始错误如下：\n" +
    failures.map((line) => "  - " + line).join("\n") +
    "\n（渲染框里的状态条仍然会显示编译结果，可以让用户念给你；" +
    "若渲染框本身就是黑屏，那说明要先修渲染那条链路，与此无关。）"
  );
}

/** 描述一个不该出现的值（用于报错文案），避免在调用处写嵌套三元。 */
function describeUnexpected(value: unknown): string {
  if (typeof value === "string") {
    return "空字符串";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}
