/**
 * App 换肤（Theme / 换肤）：
 * - 配色预设：`<html data-theme-preset="...">` 驱动，预设的 CSS 变量覆盖定义在
 *   index.css 的 `[data-theme-preset=...]` / `.dark[data-theme-preset=...]` 选择器中，
 *   与现有 `:root` / `.dark` 体系同构。JS 侧只负责把 id 写到根节点。
 * - 背景图：图片以 dataURL 存在 settings（local-only），这里把它与强度写入
 *   `--theme-background-image` / `--theme-background-opacity` 内联变量，由
 *   ChatPage 主内容区的背景层消费。
 */

export type ThemePresetId = "default" | "ocean" | "midnight" | "forest" | "sunset";

export type ThemePresetMeta = {
  id: ThemePresetId;
  /** i18n key，如 settings.themePreset.ocean */
  nameKey: string;
  /** 一句话描述（i18n key） */
  hintKey: string;
};

export const THEME_PRESET_META: readonly ThemePresetMeta[] = [
  {
    id: "default",
    nameKey: "settings.themePreset.default",
    hintKey: "settings.themePreset.defaultHint",
  },
  {
    id: "ocean",
    nameKey: "settings.themePreset.ocean",
    hintKey: "settings.themePreset.oceanHint",
  },
  {
    id: "midnight",
    nameKey: "settings.themePreset.midnight",
    hintKey: "settings.themePreset.midnightHint",
  },
  {
    id: "forest",
    nameKey: "settings.themePreset.forest",
    hintKey: "settings.themePreset.forestHint",
  },
  {
    id: "sunset",
    nameKey: "settings.themePreset.sunset",
    hintKey: "settings.themePreset.sunsetHint",
  },
];

export function isThemePresetId(value: unknown): value is ThemePresetId {
  return THEME_PRESET_META.some((preset) => preset.id === value);
}

export function normalizeThemePresetId(value: unknown): ThemePresetId {
  return isThemePresetId(value) ? value : "default";
}

/** 背景图内联 CSS 变量名（背景层在 ChatPage 消费）。 */
export const THEME_BACKGROUND_IMAGE_VAR = "--theme-background-image";
export const THEME_BACKGROUND_OPACITY_VAR = "--theme-background-opacity";

export const DEFAULT_BACKGROUND_OPACITY = 0.35;

export function normalizeBackgroundOpacity(value: unknown): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_BACKGROUND_OPACITY;
  return Math.min(0.85, Math.max(0.1, parsed));
}

/**
 * 把用户背景图（dataURL）与强度写入根节点内联变量。
 * 图片为空时清除变量（背景层自动隐藏）。
 */
export function applyBackgroundImage(
  imageDataUrl: string,
  opacity: number,
  root: HTMLElement = document.documentElement,
): void {
  const trimmed = imageDataUrl.trim();
  if (trimmed) {
    root.style.setProperty(THEME_BACKGROUND_IMAGE_VAR, `url("${trimmed}")`);
    root.style.setProperty(THEME_BACKGROUND_OPACITY_VAR, String(opacity));
  } else {
    root.style.removeProperty(THEME_BACKGROUND_IMAGE_VAR);
    root.style.removeProperty(THEME_BACKGROUND_OPACITY_VAR);
  }
}

/** 把主题预设 id 写到根节点 data-theme-preset；default 时移除（走内置 :root/.dark）。 */
export function applyThemePresetId(
  presetId: ThemePresetId,
  root: HTMLElement = document.documentElement,
): void {
  if (presetId === "default") {
    root.removeAttribute("data-theme-preset");
  } else {
    root.setAttribute("data-theme-preset", presetId);
  }
}

/**
 * 背景图压缩目标：base64 dataURL 的近似字节上限。
 * 超过 localStorage 5MB 配额 / WebView 大 dataURL 渲染上限会静默失效，
 * 所以上传时先把图压缩到远小于该阈值。
 */
const MAX_BACKGROUND_DATAURL_BYTES = 700 * 1024;
const MAX_BACKGROUND_DIMENSION = 2560;

/**
 * 把用户选择的背景图压缩成紧凑的 dataURL。
 * - 限制最长边 ≤ 2560，避免巨图；canvas 缩放。
 * - 编码优先 WebP（保留透明、体积小），不支持时回退 JPEG；PNG 原样兜底。
 * - 循环降质直到 ≤ 上限（或质量下限）。
 * 失败返回空串，调用方回退原始 dataURL。
 */
export async function compressBackgroundImage(file: File): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_BACKGROUND_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return "";
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const sourceType = (file.type || "").toLowerCase();
    const candidates: string[] = [];
    if (sourceType === "image/png" || sourceType === "image/webp") {
      candidates.push("image/webp", "image/jpeg");
    } else {
      candidates.push("image/jpeg");
    }

    for (const mime of candidates) {
      let quality = 0.82;
      let dataUrl = canvas.toDataURL(mime, quality);
      // toDataURL 不支持该 mime 时返回 "data:,"（空）。
      if (dataUrl === "data:,") continue;
      while (dataUrl.length > MAX_BACKGROUND_DATAURL_BYTES && quality > 0.45) {
        quality -= 0.12;
        dataUrl = canvas.toDataURL(mime, quality);
      }
      if (dataUrl.length <= MAX_BACKGROUND_DATAURL_BYTES) return dataUrl;
    }
    return "";
  } catch {
    return "";
  }
}
