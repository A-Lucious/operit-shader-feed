/* METADATA
{
    "name": "shader_compile",
    "version": "0.1.0",
    "display_name": {
        "zh": "Shader 编译结果",
        "en": "Shader Compile Report"
    },
    "description": {
        "zh": "读取聊天里最近一次 shader 的编译结果，包含 GLSL 编译器的报错原文。",
        "en": "Read the latest in-chat shader compile result, including the raw GLSL compiler log."
    },
    "author": ["lilia"],
    "tools": [
        {
            "name": "shader_last_compile_result",
            "description": {
                "zh": "读取聊天里最近一次 shader 的编译结果。在聊天里写出 <shader>…</shader> 之后应当调用它：编译 GLSL 需要一个 WebGL 上下文，而工具跑在没有 GL 的运行时里，所以结果必须由渲染框回传。返回内容包含成功/失败，失败时附带 GLSL 编译器报错原文，据此修改代码直到成功。若返回「还在编译中」，等 1～2 秒再调用一次。",
                "en": "Read the latest in-chat shader compile result. Call it right after writing a <shader>…</shader> block: compiling GLSL needs a WebGL context, which the tool runtime does not have, so the result must be relayed back from the render box. The result reports success/failure and, on failure, the raw GLSL compiler log to fix the code against. If it says compilation is still in progress, wait 1-2 seconds and call again."
            },
            "parameters": []
        }
    ]
}
*/

import { readCompileResultText } from "../plugin/compile-tool.js";

/**
 * 工具实现。函数名必须与 METADATA 里 `tools[].name` **完全一致** ——
 * 宿主是按名字找导出的，改名只会表现为「工具不存在」，而且只能真机发现。
 *
 * 本文件其余部分刻意保持"只有一行 RPC"：逻辑都在 compile-tool.ts 里，那里能离线测。
 */
export async function shader_last_compile_result(): Promise<string> {
  return readCompileResultText((channel, payload) =>
    ToolPkg.ipc.call(channel, payload),
  );
}
