"use strict";
/**
 * P2b：真实 FS 适配器 —— 把宿主桥接的 `Tools.Files` 接到 `StoreFs` 上。
 *
 * 这一层只做映射，不含任何业务逻辑（索引/去重/淘汰都在 store.ts 里）。
 * 它引用的 `Tools` / `CryptoJS` 是宿主全局，所以能在 Node 里打桩测试字段名映射
 * （例如 `contentBase64` 还是 `base64`、`isDirectory` 还是 `isDir`）——
 * 这类错误在真机上表现是「什么都没存下来」，很难查。
 *
 * 另外两件在真机上会咬人的事都在这层处理：
 *   1. `Tools.Files.read()` 对不存在的文件会抛，而 StoreFs 的契约要求返回 null。
 *   2. `move()` 不保证覆盖已存在的目标。而原子写每次都往同一个目标名上覆盖，
 *      所以必须带「删了再来一次」的退路，否则第二次保存就永远失败。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_STORE_ROOT = void 0;
exports.createHostFs = createHostFs;
exports.hashTextureUrl = hashTextureUrl;
exports.verifyRootWritable = verifyRootWritable;
/**
 * 默认根目录。这是平台约定（见 OPERIT 插件的既有写法），而且它**可见**，
 * 正好满足「告诉用户存哪以便清理」这条需求。
 * 用户可通过工具参数覆盖（官方插件也是这么做的）。
 */
exports.DEFAULT_STORE_ROOT = "/sdcard/Download/Operit/plugins/shader_feed";
/** 我们的根目录是 /sdcard/...，属 android 环境。 */
const ENV = "android";
function isMissingError(err) {
    const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return (text.includes("no such file") ||
        text.includes("not exist") ||
        text.includes("does not exist") ||
        text.includes("enoent") ||
        text.includes("找不到") ||
        text.includes("不存在"));
}
function createHostFs() {
    return {
        async readText(path) {
            try {
                const file = await Tools.Files.read(path, ENV);
                return file ? file.content : null;
            }
            catch (err) {
                // 「不存在」是首次运行的正常状态，返回 null。
                if (isMissingError(err)) {
                    return null;
                }
                // 其它错误（权限等）**必须抛出去**。
                // 返回 null 会让「不可读」与「不存在」变得无法区分，而 store 会把
                // 「不可读」当成「首次运行」，随后**覆盖**掉用户原有缓存 ——
                // 几十条缓存就这样无声消失。抛出去后 store 能上报（走 onWarn），
                // 用户至少知道缓存为什么没了。
                throw err;
            }
        },
        async writeText(path, text) {
            await Tools.Files.write(path, text, false, ENV);
        },
        async writeBinary(path, base64) {
            await Tools.Files.writeBinary(path, base64, ENV);
        },
        async list(path) {
            const listing = await Tools.Files.list(path, ENV);
            const entries = (listing && listing.entries) || [];
            return entries.map((e) => ({
                name: e.name,
                size: typeof e.size === "number" ? e.size : 0,
                isDir: !!e.isDirectory,
            }));
        },
        async mkdir(path) {
            // create_parents=true：首次运行时 /sdcard/Download/Operit/plugins/ 可能整条都不存在。
            await Tools.Files.mkdir(path, true, ENV);
        },
        async remove(path, recursive) {
            await Tools.Files.deleteFile(path, recursive, ENV);
        },
        async move(from, to) {
            try {
                await Tools.Files.move(from, to, ENV);
            }
            catch (err) {
                // move 不保证覆盖。原子写每次都要覆盖同一个目标名，
                // 所以这里必须退化成「先删目标、再移一次」，否则第二次保存起就永远失败。
                if (isMissingError(err)) {
                    throw err;
                }
                await Tools.Files.deleteFile(to, false, ENV);
                await Tools.Files.move(from, to, ENV);
            }
        },
        async size(path) {
            try {
                const info = await Tools.Files.info(path, ENV);
                if (!info || !info.exists) {
                    return -1;
                }
                return typeof info.size === "number" ? info.size : -1;
            }
            catch (err) {
                if (isMissingError(err)) {
                    return -1;
                }
                return -1;
            }
        },
    };
}
/**
 * 纹理 URL → 缓存键。
 *
 * 用 MD5 是因为**宿主桥接的 CryptoJS 只暴露 MD5**（没有 sha256，见
 * docs/doc-src/package-dev/cryptojs.md）。这里只是拿它当解缓存键，
 * 128 位足够避免碰撞，不涉及任何安全用途 —— 所以"弱哈希"在这里不是问题。
 */
function hashTextureUrl(url) {
    return CryptoJS.MD5(url).toString();
}
/**
 * 真机首次运行时，根目录可能因作用域存储/权限写不进去。
 * 提前探一下并给出**可读的原因**，比让用户面对一个空白的缓存页好得多。
 */
async function verifyRootWritable(root) {
    const probe = root.replace(/\/+$/, "") + "/.write_probe";
    try {
        await Tools.Files.mkdir(root, true, ENV);
    }
    catch (err) {
        return {
            ok: false,
            message: "无法创建缓存目录 " +
                root +
                "：" +
                (err instanceof Error ? err.message : String(err)),
        };
    }
    try {
        await Tools.Files.write(probe, "ok", false, ENV);
    }
    catch (err) {
        return {
            ok: false,
            message: "缓存目录不可写 " +
                root +
                "：" +
                (err instanceof Error ? err.message : String(err)),
        };
    }
    try {
        const back = await Tools.Files.read(probe, ENV);
        if (!back || back.content !== "ok") {
            return { ok: false, message: "缓存目录写入后读回不一致：" + root };
        }
    }
    catch (err) {
        return {
            ok: false,
            message: "缓存目录写入后无法读回 " +
                root +
                "：" +
                (err instanceof Error ? err.message : String(err)),
        };
    }
    finally {
        try {
            await Tools.Files.deleteFile(probe, false, ENV);
        }
        catch {
            // 探针文件删不掉不影响功能，留个垃圾文件而已。
        }
    }
    return { ok: true, message: "缓存目录可读写：" + root };
}
