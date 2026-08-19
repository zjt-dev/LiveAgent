/**
 * App 换肤（Theme / 换肤）共享纯逻辑（host 无关）：
 * - 配色预设 id 与元信息；CSS 变量覆盖定义在 host 的 index.css（[data-theme-preset=...]）。
 * - 背景图 dataURL 与强度的规范化（settings 持久化用）。
 * DOM 侧应用（applyBackgroundImage / applyThemePresetId）与图片压缩留在宿主（gui）。
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

/** 背景图内联 CSS 变量名（背景层在宿主 ChatPage 消费）。 */
export const THEME_BACKGROUND_IMAGE_VAR = "--theme-background-image";
export const THEME_BACKGROUND_OPACITY_VAR = "--theme-background-opacity";

export const DEFAULT_BACKGROUND_OPACITY = 0.35;

export function normalizeBackgroundOpacity(value: unknown): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_BACKGROUND_OPACITY;
  return Math.min(0.85, Math.max(0.1, parsed));
}

/**
 * 背景图压缩目标：base64 dataURL 的近似字节上限。
 * 超过 localStorage 5MB 配额 / WebView 大 dataURL 渲染上限会静默失效。
 */
export const MAX_BACKGROUND_DATAURL_BYTES = 700 * 1024;

const MAX_BACKGROUND_DIMENSION = 2560;

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
    // dataURL 内可能含 `"`（如未压缩的 SVG dataURL），直接拼进 url("...") 会
    // 提前闭合引号破坏 CSS 值导致背景静默失效。转义 `\` 与 `"` 后再写入。
    const escaped = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    root.style.setProperty(THEME_BACKGROUND_IMAGE_VAR, `url("${escaped}")`);
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
 * 把用户选择的背景图压缩成紧凑的 dataURL。
 * - 限制最长边 ≤ 2560，避免巨图；canvas 缩放。
 * - 统一先试 WebP（保留透明、体积小），不支持时回退 JPEG。
 * - 循环降质直到 ≤ 上限（或质量下限 0.3）。
 * 仍压不进上限返回空串，由调用方决定是否回退原始 dataURL（需自行校验大小）。
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

    // 统一先 WebP 再 JPEG：WebP 体积更小且保留透明；JPEG 源也可 WebP 编码。
    for (const mime of ["image/webp", "image/jpeg"] as const) {
      let quality = 0.82;
      let dataUrl = canvas.toDataURL(mime, quality);
      // toDataURL 不支持该 mime 时返回 "data:,"（空）。
      if (dataUrl === "data:,") continue;
      while (dataUrl.length > MAX_BACKGROUND_DATAURL_BYTES && quality > 0.3) {
        quality -= 0.12;
        dataUrl = canvas.toDataURL(mime, quality);
      }
      if (dataUrl.length <= MAX_BACKGROUND_DATAURL_BYTES) return dataUrl;
    }
    // 兜底：JPEG 最低质量，canvas 编码 JPEG 几乎必然成功；仍超限则返回空。
    const fallback = canvas.toDataURL("image/jpeg", 0.3);
    if (fallback !== "data:," && fallback.length <= MAX_BACKGROUND_DATAURL_BYTES) return fallback;
    return "";
  } catch {
    return "";
  }
}
