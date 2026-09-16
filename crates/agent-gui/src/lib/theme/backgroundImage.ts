/**
 * 宿主（桌面 gui）侧的换肤背景图存储。
 *
 * 职责划分：`@liveagent/ui/lib/theme/appTheme` 只管"值长什么样"（磁盘引用
 * `theme:<文件名>` / 历史 dataURL）与重编码；图片字节的读写走 Tauri 命令落在
 * 应用目录 `~/.liveagent/theme/`，渲染前再读回字节转成 Blob objectURL，交给
 * `applyBackgroundImage` 写 CSS 变量。设置里因此只留几十字节，不再和
 * localStorage 的 5MB 配额较劲。
 */
import {
  approximateDataUrlBytes,
  encodeBackgroundImage,
  isLegacyBackgroundDataUrl,
  MAX_BACKGROUND_FILE_BYTES,
  THEME_BACKGROUND_REF_PREFIX,
  themeBackgroundFileName,
} from "@liveagent/ui/lib/theme/appTheme";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

/**
 * WebView 能直接当背景渲染的格式。画布重编码失败时，只有这些格式允许按原样落盘，
 * 否则就是"设置成功但画不出来"的静默失效（HEIC / TIFF 等），必须明确报错。
 */
const RENDERABLE_MIME_TYPES = new Set([
  "image/webp",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/avif",
  "image/bmp",
  "image/svg+xml",
]);

export type StoreBackgroundImageResult =
  | { status: "stored"; value: string }
  | { status: "too-large" }
  | { status: "failed" };

function base64ToBytes(dataBase64: string): Uint8Array {
  const binary = window.atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** 拆 dataURL 为 `{ mimeType, base64 }`；结构不完整时返回 null。 */
function splitDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) return null;
  const header = dataUrl.slice(0, commaIndex);
  if (!/^data:/i.test(header) || !/;base64$/i.test(header)) return null;
  const mimeType = header
    .slice(5, header.length - ";base64".length)
    .trim()
    .toLowerCase();
  const base64 = dataUrl.slice(commaIndex + 1).replace(/\s/g, "");
  if (!mimeType || !base64) return null;
  return { mimeType, base64 };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

async function storeDataUrl(dataUrl: string): Promise<string | null> {
  const parsed = splitDataUrl(dataUrl);
  // 非 base64 dataURL 或未知格式：不猜测，交给调用方按"失败"处理。
  if (!parsed?.base64 || !RENDERABLE_MIME_TYPES.has(parsed.mimeType)) return null;
  const name = await invoke<string>("system_save_theme_background_image", {
    data_base64: parsed.base64,
    mime_type: parsed.mimeType,
  });
  return `${THEME_BACKGROUND_REF_PREFIX}${name}`;
}

/**
 * 把用户选择的背景图存成磁盘引用。
 *
 * 先走画布重编码（归一格式 + 控制体积）；编码不可用时，只有"浏览器本来就画得出来"
 * 的格式才按原样落盘，其余明确返回失败，绝不存一张渲染不出来的图。
 */
export async function storeBackgroundImageFile(file: File): Promise<StoreBackgroundImageResult> {
  if (file.size > MAX_BACKGROUND_FILE_BYTES) return { status: "too-large" };
  try {
    const encoded = await encodeBackgroundImage(file);
    if (encoded) {
      const stored = await storeDataUrl(encoded.dataUrl);
      if (stored) return { status: "stored", value: stored };
      return { status: "failed" };
    }
    if (file.type && !RENDERABLE_MIME_TYPES.has(file.type.toLowerCase())) {
      return { status: "failed" };
    }
    const stored = await storeDataUrl(await readFileAsDataUrl(file));
    return stored ? { status: "stored", value: stored } : { status: "failed" };
  } catch (error) {
    console.warn("failed to store theme background image", error);
    return { status: "failed" };
  }
}

/** 移除背景图时清掉磁盘上的图片文件（设置项由调用方置空）。 */
export async function forgetBackgroundImageFile(value: string | undefined): Promise<void> {
  if (!themeBackgroundFileName(value)) return;
  try {
    await invoke("system_clear_theme_background_image");
  } catch (error) {
    // 磁盘残留只多占空间，不影响界面状态。
    console.warn("failed to clear theme background image file", error);
  }
}

/**
 * 历史 dataURL 一次性迁移到磁盘。
 * 失败（命令不可用 / 格式不支持 / 超限）时原样返回旧值，背景继续按 dataURL 渲染，
 * 下次启动再试——迁移是优化，不能变成"升级后背景消失"。
 */
export async function migrateLegacyBackgroundImage(value: string): Promise<string> {
  if (!isLegacyBackgroundDataUrl(value)) return value;
  if (approximateDataUrlBytes(value) > MAX_BACKGROUND_FILE_BYTES) return value;
  try {
    const stored = await storeDataUrl(value.trim());
    return stored ?? value;
  } catch (error) {
    console.warn("failed to migrate legacy theme background image", error);
    return value;
  }
}

type CacheEntry = {
  refs: number;
  url: string | null;
  promise: Promise<string> | null;
};

// 同一张图（同一设置值）只读盘一次：App 的背景层与设置页的预览共用一个 objectURL。
const cache = new Map<string, CacheEntry>();

async function loadImageUrl(value: string): Promise<string> {
  if (isLegacyBackgroundDataUrl(value)) return value;
  const name = themeBackgroundFileName(value);
  if (!name) return "";
  const response = await invoke<{ mimeType: string; data: string }>(
    "system_read_theme_background_image",
    { name },
  );
  const bytes = base64ToBytes(response.data);
  // 与仓库其它 base64 → Blob 的写法一致：`slice()` 得到 ArrayBuffer 支撑的视图，
  // 避免 Uint8Array<ArrayBufferLike> 不能直接当 BlobPart 的类型问题。
  return URL.createObjectURL(new Blob([bytes.slice().buffer], { type: response.mimeType }));
}

function releaseEntry(key: string, entry: CacheEntry): void {
  if (entry.refs > 0) return;
  // 引用归零即出缓存并释放 URL；下次用到时重新读盘。
  if (cache.get(key) === entry) cache.delete(key);
  if (entry.url && !entry.url.startsWith("data:")) {
    URL.revokeObjectURL(entry.url);
    entry.url = null;
  }
}

/**
 * 取该设置值可直接用于 CSS 的 URL（blob: / 历史 dataURL），并登记一次引用。
 * 调用方必须在 effect 清理里 `release()`。
 */
export function acquireBackgroundImageUrl(value: string): {
  promise: Promise<string>;
  release: () => void;
} {
  const key = value.trim();
  if (!key) return { promise: Promise.resolve(""), release: () => {} };

  let entry = cache.get(key);
  if (!entry) {
    entry = { refs: 0, url: null, promise: null };
    cache.set(key, entry);
  }
  const active = entry;
  active.refs += 1;
  if (!active.promise) {
    active.promise = loadImageUrl(key).then((url) => {
      active.url = url;
      return url;
    });
    active.promise.catch(() => {
      // 读盘失败不能让缓存里留着一个永远 resolve 不出的 promise。
      if (cache.get(key) === active && active.refs === 0) cache.delete(key);
      active.promise = null;
    });
  }
  const promise = active.promise;

  let released = false;
  return {
    promise,
    release: () => {
      if (released) return;
      released = true;
      active.refs -= 1;
      releaseEntry(key, active);
    },
  };
}

/** 解析背景图设置为可直接渲染的 URL（无效/读盘失败时为空串）。 */
export function useBackgroundImageUrl(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!trimmed) {
      setUrl("");
      return;
    }
    let active = true;
    const { promise, release } = acquireBackgroundImageUrl(trimmed);
    promise.then(
      (resolved) => {
        if (active) setUrl(resolved);
        else release();
      },
      () => {
        if (active) setUrl("");
        else release();
      },
    );
    return () => {
      active = false;
      release();
    };
  }, [trimmed]);
  return url;
}
