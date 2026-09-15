/**
 * 工具脚本侧的逻辑：把 main 里的编译结果读回来，变成给 AI 看的文本。
 *
 * 为什么单独一个模块：工具脚本跑在 sandbox 上下文，`ToolPkg.ipc` 在那边才有；
 * 但**逻辑**（读不到时怎么说话、拿到非文本怎么办）跟运行环境无关，放这里就能离线测，
 * 工具脚本本身只留一行 RPC 调用。
 *
 * 一条硬要求：这个函数**永远不抛异常**。工具抛异常的话，AI 拿到的是一段堆栈，
 * 而不是"现在该怎么办" —— 它就没法自己修了。
 */

import { IPC_COMPILE_READ } from "../shared/chat-shader-state.js";

/** 与 `ToolPkg.ipc.call` 同形，便于测试注入。 */
export type IpcCaller = (channel: string, payload?: unknown) => Promise<unknown>;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

export async function readCompileResultText(
  callIpc: IpcCaller,
): Promise<string> {
  let value: unknown;
  try {
    value = await callIpc(IPC_COMPILE_READ, {});
  } catch (err) {
    // 最可能的原因：main 侧没注册这个通道（注册失败，或插件版本不匹配）。
    // 说清楚这一点比丢一段堆栈有用得多。
    return (
      "读不到编译结果（跨运行时通道未就绪）：" +
      errText(err) +
      "\n请让用户看一眼渲染框里的状态条，那里会显示编译报错。"
    );
  }

  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }

  // 通道通了但内容不对：多半是版本不匹配（比如 main 侧还没接上），
  // 也可能是 main 侧自己出了错、回了个空字符串。
  return (
    "通道通了，但拿到的不是可用文本（" +
    describeUnexpected(value) +
    "）。这通常意味着插件版本不匹配（main 侧还没接上编译结果）。\n" +
    "请让用户看一眼渲染框里的状态条。"
  );
}
