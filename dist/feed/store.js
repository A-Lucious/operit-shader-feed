"use strict";
/**
 * P2 存储层：索引 + 正文分文件 + 纹理去重 + 配额淘汰。
 *
 * 布局（根目录默认 /sdcard/Download/Operit/plugins/shader_feed，可由用户覆盖）：
 *   index.json           shader 元数据索引（**不含代码**，所以很小，每次保存重写代价可接受）
 *   textures.json        纹理台账（hash → url/字节/最后使用时间），配额淘汰只动这里
 *   shaders/<id>.json    完整记录（含代码）
 *   textures/<hash>.<ext>
 *
 * 两个刻意的设计：
 *
 * 1. **FS 注入**。本层不认识 ToolPkg 或 Tools.Files，只跟 StoreFs 打交道，
 *    所以索引/去重/淘汰/损坏恢复这些语义能在 Node 里用内存 FS 真测（见 tests/store.test.mjs）。
 *    真实 FS 适配器另外实现。
 *
 * 2. **只淘汰纹理，永不淘汰 shader 元数据**（PLAN §4 D6）。
 *    元数据只有几十 KB/条，淘汰它会毁掉「按日期往回翻」的能力；
 *    而纹理是唯一会把存储炸到 GB 级的东西。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStore = createStore;
const DEFAULT_QUOTA = 500 * 1024 * 1024;
const INDEX_VERSION = 1;
/**
 * base64 的字节数。必须 padding 感知：`round(len*3/4)` 对有 padding 的真实
 * base64 会算多，配额与「占用」显示跟着偏。
 */
function base64Bytes(b64) {
    const len = b64.length;
    if (len === 0)
        return 0;
    let padding = 0;
    if (b64.endsWith("=="))
        padding = 2;
    else if (b64.endsWith("="))
        padding = 1;
    return (len / 4) * 3 - padding;
}
function humanBytes(n) {
    if (n < 1024)
        return n + " B";
    if (n < 1024 * 1024)
        return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024)
        return (n / (1024 * 1024)).toFixed(1) + " MB";
    return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}
function createStore(fs, options) {
    const root = options.root.replace(/\/+$/, "");
    const quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA;
    const hashOf = options.hash;
    const now = options.now ?? (() => Date.now());
    const onWarn = options.onWarn;
    function warn(message) {
        if (onWarn) {
            onWarn(message);
        }
    }
    function errText(err) {
        return err instanceof Error ? err.message : String(err);
    }
    /**
     * 不用 `Object.hasOwn`（ES2022，宿主 QuickJS 不一定有，tsc 的 lib 也不支持）；
     * 也不用 `key in obj`：shader id 是 base62，理论上能拼出 "constructor" 这类原型链上的名字。
     * `Object.keys` 只列自有属性，全平台都有 —— 而且 biome 不会把这个写法改回去。
     */
    function hasOwn(obj, key) {
        return Object.keys(obj).includes(key);
    }
    const indexFile = root + "/index.json";
    const ledgerFile = root + "/textures.json";
    const shaderDir = root + "/shaders";
    const textureDir = root + "/textures";
    /**
     * 索引与台账的惰性缓存。**缓存的是 Promise，不是值。**
     *
     * 为什么：缓存值的话，N 个并发调用会全部看到缓存为空 → 各自读盘 → 各自建一个对象 →
     * 最后一个赋值胜出，前 N-1 个的对象被丢弃。于是每个调用各自改**自己那份**，
     * 只有最后一份活下来 —— 表现为「并发保存 8 条，台账里只剩 1 条」，而且不报任何错。
     * （实测：12 条并发保存丢了 11 条。）
     */
    let indexPromise = null;
    let ledgerPromise = null;
    function shaderPath(id) {
        return shaderDir + "/" + id + ".json";
    }
    function texturePath(hash, ext) {
        return textureDir + "/" + hash + "." + (ext || "bin");
    }
    /**
     * 原子写：先写 .tmp 再 move。中途崩了也不会留下半个 JSON。
     * 损坏的索引会让插件再也启动不起来，所以这一步不能省。
     *
     * **必须串行化**：tmp 路径是固定的，两个写并发时后者会覆盖前者的 tmp，
     * 前者的 move 把后者的内容搬走，后者的 move 则因源文件已被搬走而抛错 ——
     * 表现为「保存随机失败」。串行后这一整类问题消失。
     */
    let writeQueue = Promise.resolve();
    function writeTextAtomic(path, text) {
        const run = async () => {
            const tmp = path + ".tmp";
            await fs.writeText(tmp, text);
            await fs.move(tmp, path);
        };
        // 排到队列尾部；前一个失败也必须继续（所以两个分支都指向 run）。
        const task = writeQueue.then(run, run);
        writeQueue = task.then(() => undefined, () => undefined);
        return task;
    }
    /**
     * 读 JSON。**任何解析失败都退化成空状态，绝不抛出** ——
     * 索引文件损坏不该让整个插件变成打不开的黑屏。
     */
    async function readJson(path, fallback) {
        let raw = null;
        try {
            raw = await fs.readText(path);
        }
        catch {
            return fallback;
        }
        if (raw === null || raw.trim() === "") {
            return fallback;
        }
        try {
            return JSON.parse(raw);
        }
        catch {
            return fallback;
        }
    }
    async function ensureDirs() {
        await fs.mkdir(shaderDir);
        await fs.mkdir(textureDir);
    }
    function loadIndex() {
        if (!indexPromise) {
            indexPromise = readJson(indexFile, {}).then((loaded) => ({
                version: INDEX_VERSION,
                shaders: loaded && typeof loaded.shaders === "object" && loaded.shaders
                    ? loaded.shaders
                    : {},
            }));
        }
        return indexPromise;
    }
    function loadLedger() {
        if (!ledgerPromise) {
            ledgerPromise = readJson(ledgerFile, {}).then((loaded) => ({
                version: INDEX_VERSION,
                textures: loaded && typeof loaded.textures === "object" && loaded.textures
                    ? loaded.textures
                    : {},
            }));
        }
        return ledgerPromise;
    }
    async function persistIndex() {
        const current = await loadIndex();
        await writeTextAtomic(indexFile, JSON.stringify(current));
    }
    async function persistLedger() {
        const current = await loadLedger();
        await writeTextAtomic(ledgerFile, JSON.stringify(current));
    }
    function toMeta(record, savedAt, singlePass) {
        return {
            id: record.id,
            name: record.name,
            username: record.username,
            likes: record.likes,
            views: record.views,
            date: record.date,
            passCount: record.passCount,
            hasBuffers: record.hasBuffers,
            isGLSL3: record.isGLSL3,
            singlePass,
            savedAt,
        };
    }
    /**
     * 淘汰实现放在闭包里，好让 recordTexture 也能直接调它 ——
     * 对象字面量里的方法互相用 this 调用很脆，容易在解构后失效。
     *
     * 只动纹理，绝不动 shader 元数据（PLAN §4 D6）。
     */
    async function evictImpl() {
        const led = await loadLedger();
        const entries = Object.values(led.textures);
        let textureBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
        if (textureBytes <= quotaBytes) {
            return 0;
        }
        // 最久未使用的先走
        entries.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
        let evicted = 0;
        for (const entry of entries) {
            if (textureBytes <= quotaBytes)
                break;
            try {
                await fs.remove(entry.file, false);
            }
            catch (err) {
                // 文件删不掉也要把台账清掉，否则这个条目会永远占着配额。
                warn("淘汰纹理时删除失败 " + entry.file + ": " + errText(err));
            }
            delete led.textures[entry.hash];
            textureBytes -= entry.bytes;
            evicted++;
        }
        if (evicted > 0) {
            await persistLedger();
        }
        return evicted;
    }
    return {
        root,
        /** 保存一条记录。同 id 覆盖，不会在索引里留两份。 */
        async saveShader(record, singlePass) {
            await ensureDirs();
            await writeTextAtomic(shaderPath(record.id), JSON.stringify(record));
            const idx = await loadIndex();
            idx.shaders[record.id] = toMeta(record, now(), singlePass);
            await persistIndex();
        },
        async loadShader(id) {
            const raw = await readJson(shaderPath(id), null);
            return raw && raw.id ? raw : null;
        },
        async hasShader(id) {
            const idx = await loadIndex();
            return hasOwn(idx.shaders, id);
        },
        /** 按保存时间倒序返回元数据 —— 这就是「拔网后仍能刷已缓存内容」的数据来源。 */
        async listShaders() {
            const idx = await loadIndex();
            return Object.values(idx.shaders).sort((a, b) => b.savedAt - a.savedAt);
        },
        /**
         * 记录一张纹理。同一个 URL 只会占一份文件（全局去重）。
         * 已存在时只更新 lastUsedAt，不重复写盘。
         */
        async recordTexture(url, base64, ext) {
            await ensureDirs();
            const led = await loadLedger();
            const hash = hashOf(url);
            const existing = led.textures[hash];
            if (existing) {
                existing.lastUsedAt = now();
                // 原来没写成功的场合（例如上次崩在写文件阶段）补写一次
                const size = await fs.size(existing.file);
                if (size < 0) {
                    await fs.writeBinary(existing.file, base64);
                    existing.bytes = base64Bytes(base64);
                }
                // 写完就自查配额：不能指望调用方记得去调 evictTextures。
                await persistLedger();
                await evictImpl();
                return existing;
            }
            const file = texturePath(hash, ext);
            await fs.writeBinary(file, base64);
            const entry = {
                hash,
                url,
                file,
                bytes: base64Bytes(base64),
                lastUsedAt: now(),
            };
            led.textures[hash] = entry;
            await persistLedger();
            await evictImpl();
            return entry;
        },
        /** 查纹理文件路径并刷新 LRU。返回 null 表示没有缓存，需要去下。 */
        async touchTexture(url) {
            const led = await loadLedger();
            const entry = led.textures[hashOf(url)];
            if (!entry)
                return null;
            const size = await fs.size(entry.file);
            if (size < 0) {
                // 台账有、文件没了（被用户手动清过）→ 以文件为准，清掉这条台账
                delete led.textures[entry.hash];
                await persistLedger();
                return null;
            }
            entry.lastUsedAt = now();
            await persistLedger();
            return entry;
        },
        /** 超配额就按 LRU 淘汰纹理。**只动纹理，绝不动 shader 元数据**。返回淘汰条数。 */
        evictTextures() {
            return evictImpl();
        },
        /** 占用统计。describe 里带**真实绝对路径**，供 UI 直接展示清理入口。 */
        async usage() {
            const idx = await loadIndex();
            const led = await loadLedger();
            const textures = Object.values(led.textures);
            const textureBytes = textures.reduce((sum, e) => sum + e.bytes, 0);
            let shaderBytes = 0;
            try {
                for (const entry of await fs.list(shaderDir)) {
                    if (!entry.isDir)
                        shaderBytes += entry.size;
                }
            }
            catch {
                shaderBytes = 0;
            }
            const totalBytes = shaderBytes + textureBytes;
            const shaderCount = Object.keys(idx.shaders).length;
            return {
                root,
                shaderCount,
                textureCount: textures.length,
                shaderBytes,
                textureBytes,
                totalBytes,
                quotaBytes,
                describe: "缓存位置：" +
                    root +
                    "\n" +
                    "已缓存 shader：" +
                    shaderCount +
                    " 条（" +
                    humanBytes(shaderBytes) +
                    "）\n" +
                    "已缓存纹理：" +
                    textures.length +
                    " 张（" +
                    humanBytes(textureBytes) +
                    "）\n" +
                    "合计：" +
                    humanBytes(totalBytes) +
                    " / 上限 " +
                    humanBytes(quotaBytes),
            };
        },
        /** 只清纹理（用户最常用的那个「清缓存」，因为纹理占绝大头）。 */
        async clearTextures() {
            const led = await loadLedger();
            for (const entry of Object.values(led.textures)) {
                try {
                    await fs.remove(entry.file, false);
                }
                catch (err) {
                    warn("清理纹理失败 " + entry.file + ": " + errText(err));
                }
            }
            ledgerPromise = Promise.resolve({ version: INDEX_VERSION, textures: {} });
            await persistLedger();
        },
        /** 全清（纹理 + shader）。 */
        async clearAll() {
            ledgerPromise = Promise.resolve({ version: INDEX_VERSION, textures: {} });
            indexPromise = Promise.resolve({ version: INDEX_VERSION, shaders: {} });
            try {
                await fs.remove(textureDir, true);
            }
            catch (err) {
                warn("删除纹理目录失败 " + textureDir + ": " + errText(err));
            }
            try {
                await fs.remove(shaderDir, true);
            }
            catch (err) {
                warn("删除 shader 目录失败 " + shaderDir + ": " + errText(err));
            }
            await persistLedger();
            await persistIndex();
        },
        texturePathFor(url, ext) {
            return texturePath(hashOf(url), ext);
        },
    };
}
