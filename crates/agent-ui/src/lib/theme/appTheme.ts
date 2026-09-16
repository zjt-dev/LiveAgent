/**
 * App 换肤（Theme / 换肤）共享纯逻辑（host 无关）：
 * - 配色预设 id 与元信息；CSS 变量覆盖定义在 host 的 index.css（[data-theme-preset=...]）。
 * - 背景图的持久化形态（磁盘引用 `theme:<文件名>` / 历史 dataURL）、大小上限与强度规范化。
 * - 背景图重编码（canvas 缩放 + WebP/JPEG 归一化）。
 * 读写磁盘与 DOM 侧应用（applyBackgroundImage / applyThemePresetId）留在宿主（gui）。
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

/**
 * 设置了背景图时打在根节点上的标记属性。
 * CSS 无法判断某个自定义变量是否已定义，宿主样式表要作用域化「让默认不透明的
 * 表面（workbench 画布 / pane）透出背景层」就需要这样一个可选择的开关；
 * 没有背景图时属性缺席，那些表面保持原样，视觉零变化。
 */
export const THEME_BACKGROUND_ROOT_ATTR = "data-theme-background";

/**
 * 背景图在设置里的持久化形态：只存磁盘引用 `theme:<文件名>`，图片字节落在宿主的
 * 应用目录（桌面端为 `~/.liveagent/theme/`）。
 *
 * 为什么不直接存图：base64 dataURL 得塞进 localStorage 的 UI 设置里，既受 ~5MB
 * 配额限制（超限写入被静默丢弃 = 用户"设置成功但图没了"），也逼着上传一路压到
 * 几百 KB。改成引用之后设置只剩几十字节，画质上限交给磁盘。
 *
 * 历史值仍以 `data:` 开头，宿主读到时会一次性迁移落盘（见 gui 侧
 * `lib/theme/backgroundImage.ts`）。
 */
export const THEME_BACKGROUND_REF_PREFIX = "theme:";

/** 宿主落盘单图上限，需与 Rust 侧 `THEME_BACKGROUND_MAX_BYTES` 保持一致。 */
export const MAX_BACKGROUND_FILE_BYTES = 24 * 1024 * 1024;

/**
 * 重编码目标：不再受 localStorage 配额约束，这里只是把原图归一成浏览器必然
 * 支持的 WebP/JPEG（HEIC/TIFF 之类进不来），并把体积压到"读回 + 显存"都舒服的区间。
 */
export const MAX_BACKGROUND_ENCODED_BYTES = 4 * 1024 * 1024;

export const DEFAULT_BACKGROUND_OPACITY = 0.35;

export function normalizeBackgroundOpacity(value: unknown): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_BACKGROUND_OPACITY;
  return Math.min(0.85, Math.max(0.1, parsed));
}

const MAX_BACKGROUND_DIMENSION = 2560;

/** 设置值是否为磁盘引用（`theme:<文件名>`）。 */
export function isThemeBackgroundRef(value: unknown): value is string {
  return typeof value === "string" && value.trim().startsWith(THEME_BACKGROUND_REF_PREFIX);
}

/**
 * 从设置值里取出背景图文件名；非法/缺省返回空串。
 * 形状校验与 Rust 侧 `validate_theme_background_name` 同口径（`background-…`、
 * 只允许 `[A-Za-z0-9._-]`、不含 `..`）：设置项是用户可编辑的字符串，
 * 宿主拿它去读盘之前必须先挡住路径穿越与绝对路径。
 */
export function themeBackgroundFileName(value: unknown): string {
  if (!isThemeBackgroundRef(value)) return "";
  const name = value.trim().slice(THEME_BACKGROUND_REF_PREFIX.length).trim();
  if (
    !name.startsWith("background-") ||
    name.length > 128 ||
    name.includes("..") ||
    !/^[A-Za-z0-9._-]+$/.test(name) ||
    !/\.(webp|png|jpe?g|gif|avif|bmp|svg)$/i.test(name)
  ) {
    return "";
  }
  return name;
}

/**
 * 历史形态：整张图以 base64 dataURL 存在设置里。宿主渲染时照旧可用，
 * 并应尽快迁移到磁盘引用（见 gui 侧 `migrateLegacyBackgroundImage`）。
 */
export function isLegacyBackgroundDataUrl(value: unknown): boolean {
  return typeof value === "string" && value.trim().startsWith("data:");
}

/** dataURL 的近似字节数（去掉 header 后 base64 长度 × 3/4）。 */
export function approximateDataUrlBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  return commaIndex >= 0 ? Math.round((dataUrl.length - commaIndex - 1) * 0.75) : dataUrl.length;
}

/**
 * 把用户背景图（dataURL）与强度写入根节点内联变量，并同步
 * data-theme-background 标记。图片为空时清除两者（背景层自动隐藏）。
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
    root.setAttribute(THEME_BACKGROUND_ROOT_ATTR, "");
  } else {
    root.style.removeProperty(THEME_BACKGROUND_IMAGE_VAR);
    root.style.removeProperty(THEME_BACKGROUND_OPACITY_VAR);
    root.removeAttribute(THEME_BACKGROUND_ROOT_ATTR);
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

/** canvas 重编码后的背景图：归一化格式 + dataURL（宿主再落盘成 `theme:` 引用）。 */
export type EncodedBackgroundImage = {
  mimeType: string;
  dataUrl: string;
};

/**
 * 把用户选择的背景图重编码成可安全渲染的 dataURL。
 * - 限制最长边 ≤ 2560，避免巨图；canvas 缩放。
 * - 统一先试 WebP（保留透明、体积小），不支持时回退 JPEG。
 *   这一步同时兜住了格式：HEIC/TIFF 之类浏览器画不出来的输入会被归一化掉。
 * - 循环降质直到 ≤ 编码目标（或质量下限 0.35）。
 * 编码不可用或仍超限返回 null，由调用方决定是否回退原始文件字节（需自行校验大小）。
 */
export async function encodeBackgroundImage(file: File): Promise<EncodedBackgroundImage | null> {
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
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    // 统一先 WebP 再 JPEG：WebP 体积更小且保留透明；JPEG 源也可 WebP 编码。
    for (const mime of ["image/webp", "image/jpeg"] as const) {
      let quality = 0.9;
      let dataUrl = canvas.toDataURL(mime, quality);
      // toDataURL 不支持该 mime 时返回 "data:,"（空）。
      if (dataUrl === "data:,") continue;
      while (dataUrl.length > MAX_BACKGROUND_ENCODED_BYTES && quality > 0.35) {
        quality -= 0.1;
        dataUrl = canvas.toDataURL(mime, quality);
      }
      if (dataUrl.length <= MAX_BACKGROUND_ENCODED_BYTES) return { mimeType: mime, dataUrl };
    }
    // 兜底：JPEG 最低质量，canvas 编码 JPEG 几乎必然成功；仍超限则交给调用方处理。
    const fallback = canvas.toDataURL("image/jpeg", 0.35);
    if (fallback !== "data:," && fallback.length <= MAX_BACKGROUND_ENCODED_BYTES) {
      return { mimeType: "image/jpeg", dataUrl: fallback };
    }
    return null;
  } catch {
    return null;
  }
}
