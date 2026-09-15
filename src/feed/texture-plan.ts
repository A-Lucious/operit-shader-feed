/**
 * 纹理下发的"计划"：哪些要下载、哪些下发时改成虚拟域。
 *
 * 背景（这是 D3/D6 里建好但一直没接线的部分）：
 *   - D3 说 v1 支持图片纹理，D6 说「拔网后仍能刷已缓存内容」
 *   - 但 deck 用的是**原始 URL**（`new Image(); img.src = src`），资源拦截也只服务 runner 的三个资源。
 *     于是带纹理的 shader：在线能看（WebView 直接拉原图），**离线渲染失败**。
 *   - 而 Shadertoy 上大量 shader 用 iChannel0 采样噪声纹理，这不是边角情况。
 *
 * 本模块只做**决定**，不碰 I/O，所以能离线测：
 *   - 哪些纹理需要下载（只看 ctype=texture、有 src、按 URL 去重）
 *   - 下发时每条通道的 src 该写成什么（缓存命中 → 虚拟域；否则保留原 URL 作为在线回退）
 *
 * 真正的字节搬运在别处：下载走 WebView 会话（那边有 CF 通行证，且 JS 侧能可靠转 base64），
 * 服务走资源拦截的 filePath 应答。两者都只能在真机验证。
 */

import type { ShaderChannel } from "./parse.js";

/** 待下载的一张纹理。已按 URL 去重。 */
export interface TextureWanted {
  url: string;
  ext: string;
}

/** 缓存命中时，台账里那张纹理的身份。 */
export interface CachedTexture {
  hash: string;
  ext: string;
}

/** 一条通道下发时的最终形态。 */
export interface ChannelPlan {
  channel: number;
  ctype: string;
  src: string;
  /** true = src 已被改写成虚拟域（由本地缓存服务）；false = 仍是原始 URL（在线回退）。 */
  cached: boolean;
}

/**
 * 从 URL 里取扩展名。取不到就返回空串（调用方会兜底成 "bin"）。
 *
 * 必须经得起 Shadertoy 的真实 URL：它们常带查询串（`?w=1`）、有时大写、有时根本没有扩展名。
 * 写错的后果是落盘文件没有扩展名 → WebView 拿不到 MIME → 图片加载失败。
 */
export function extFromUrl(url: string): string {
  if (typeof url !== "string") {
    return "";
  }
  // 去掉查询串与锚点，再取最后一个点之后的部分。
  const withoutHash = url.split("#", 1)[0] || "";
  const withoutQuery = withoutHash.split("?", 1)[0] || "";
  const lastSlash = withoutQuery.lastIndexOf("/");
  const name = lastSlash >= 0 ? withoutQuery.slice(lastSlash + 1) : withoutQuery;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return "";
  }
  const ext = name.slice(dot + 1).toLowerCase();
  // 只接受字母数字：防止把更长的杂串当扩展名（也就挡住 `a.b?` 这类残留）。
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

/** 从台账里的落盘路径反推扩展名（`recordTexture` 存进去时用的那个）。 */
export function extFromFile(file: string): string {
  return extFromUrl(file);
}

/**
 * 哪些纹理需要下载。
 *
 * 只挑 `ctype === "texture"` 且有 src 的通道 —— 其余（keyboard/audio/cubemap 等）
 * 解析层已经标记为不支持，这里不重复判断，但要**跳过**它们，别把 cursor 之类的假 URL 也去下载。
 */
export function planTextureDownloads(channels: ShaderChannel[]): TextureWanted[] {
  const seen: Record<string, boolean> = {};
  const out: TextureWanted[] = [];
  for (const ch of channels) {
    if (!ch || ch.ctype !== "texture") {
      continue;
    }
    const url = typeof ch.src === "string" ? ch.src.trim() : "";
    // 相对/空 URL 不下载：Shadertoy 的图片纹理都是绝对 https URL，
    // 其余形态（例如自引用 pass）拿不到字节，下载只会白费一轮。
    if (!url || !/^https?:/i.test(url)) {
      continue;
    }
    if (seen[url]) {
      continue;
    }
    seen[url] = true;
    out.push({ url, ext: extFromUrl(url) || "bin" });
  }
  return out;
}

/**
 * 下发时每条通道的 src。
 *
 * `lookup` 命中说明本地有这张纹理 → 换成虚拟域 URL，由资源拦截用 filePath 应答；
 * 没命中就**保留原 URL** —— 在线时 WebView 自己会去拉，行为与改造前一致，不会更糟。
 */
export function planChannelDispatch(
  channels: ShaderChannel[],
  lookup: (url: string) => CachedTexture | null,
  virtualHost: string,
): ChannelPlan[] {
  const out: ChannelPlan[] = [];
  for (const ch of channels) {
    if (!ch) {
      continue;
    }
    const url = typeof ch.src === "string" ? ch.src.trim() : "";
    const hit = url && /^https?:/i.test(url) ? lookup(url) : null;
    if (hit) {
      out.push({
        channel: ch.channel,
        ctype: ch.ctype,
        src: virtualHost + "/tex/" + hit.hash + "." + (hit.ext || "bin"),
        cached: true,
      });
      continue;
    }
    out.push({ channel: ch.channel, ctype: ch.ctype, src: ch.src, cached: false });
  }
  return out;
}

/**
 * 从虚拟域路径里取回 hash 与扩展名（资源拦截侧用）。
 * 不是 `/tex/...` 形状就返回 null —— 拦截器据此决定"是不是我的请求"。
 */
export function parseVirtualTexturePath(
  pathname: string,
): { hash: string; ext: string } | null {
  if (typeof pathname !== "string") {
    return null;
  }
  const prefix = "/tex/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const name = pathname.slice(prefix.length);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  const hash = name.slice(0, dot);
  const ext = name.slice(dot + 1).toLowerCase();
  // hash 必须是安全文件名：它会被拼进落盘路径，带 `/` 或 `..` 就成了路径穿越。
  if (!/^[a-z0-9]{1,64}$/i.test(hash) || !/^[a-z0-9]{1,8}$/.test(ext)) {
    return null;
  }
  return { hash, ext };
}
