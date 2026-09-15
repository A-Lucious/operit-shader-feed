/**
 * 测试共用的内存 FS 与字节数助手。
 *
 * 提到这里是因为 store 的测试和自测的测试都要用同一份 ——
 * 复制两份就是"共享代码变两份"，那正是我当初拒绝拆成两个 ToolPkg 的理由。
 *
 * 行为必须与 host-fs.ts 的契约一致：
 *   - 文件不存在 → readText 返回 null、size 返回 -1（不是抛异常）
 *   - recursive 删除要连子树一起删
 *   - move 是覆盖式（先写后移的原子写依赖它）
 */

/** 生成「恰好 n 字节」的**合法** base64（带 padding）。用合法输入才能验证字节记账是否准。 */
export function b64(bytes) {
  const full = Math.floor(bytes / 3);
  const rem = bytes % 3;
  let s = "A".repeat(full * 4);
  if (rem === 1) s += "AA==";
  else if (rem === 2) s += "AAA=";
  return s;
}

/** 与 store 同口径的 padding 感知字节数。 */
export function b64Bytes(s) {
  let padding = 0;
  if (s.endsWith("==")) padding = 2;
  else if (s.endsWith("=")) padding = 1;
  return (s.length / 4) * 3 - padding;
}

/** 内存 FS。可注入删除失败，用来验证 onWarn 出口。 */
export function makeMemFs() {
  const files = new Map(); // path -> { text } | { base64 }
  const dirs = new Set();
  const calls = { writeBinary: 0, move: 0, removed: [] };
  let failRemove = null;
  const sizeOf = (v) =>
    v.base64 === undefined
      ? Buffer.byteLength(v.text, "utf8")
      : b64Bytes(v.base64);
  return {
    files,
    dirs,
    calls,
    setFailRemove(fn) {
      failRemove = fn;
    },
    fs: {
      async readText(p) {
        const f = files.get(p);
        return f === undefined ? null : f.text === undefined ? null : f.text;
      },
      async writeText(p, text) {
        files.set(p, { text });
      },
      async writeBinary(p, base64) {
        calls.writeBinary++;
        files.set(p, { base64 });
      },
      async list(p) {
        const out = [];
        for (const [path, v] of files) {
          if (path.startsWith(p + "/")) {
            const rest = path.slice(p.length + 1);
            if (!rest.includes("/"))
              out.push({ name: rest, size: sizeOf(v), isDir: false });
          }
        }
        return out;
      },
      async mkdir(p) {
        dirs.add(p);
      },
      async remove(p, recursive) {
        calls.removed.push(p);
        if (failRemove && failRemove(p)) throw new Error("模拟删除失败");
        if (recursive) {
          for (const k of [...files.keys()]) {
            if (k === p || k.startsWith(p + "/")) files.delete(k);
          }
        } else {
          files.delete(p);
        }
      },
      async move(from, to) {
        const v = files.get(from);
        if (v === undefined) throw new Error("源文件不存在: " + from);
        files.set(to, v);
        files.delete(from);
        calls.move++;
      },
      async size(p) {
        const v = files.get(p);
        return v === undefined ? -1 : sizeOf(v);
      },
    },
  };
}

/** 与生产同口径的确定性哈希（测试里不该依赖 CryptoJS）。 */
export function deterministicHash(s) {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
