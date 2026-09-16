import { CheckCircle2, ImageOff, Palette, Upload } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  DEFAULT_BACKGROUND_OPACITY,
  MAX_BACKGROUND_FILE_BYTES,
  normalizeThemePresetId,
  THEME_PRESET_META,
} from "@liveagent/ui/lib/theme/appTheme";
import { useRef, useState } from "react";
import { updateCustomSettings } from "../../lib/settings";
import {
  forgetBackgroundImageFile,
  storeBackgroundImageFile,
  useBackgroundImageUrl,
} from "../../lib/theme/backgroundImage";
import type { SettingsSectionProps } from "./types";

// 换肤：背景图原始文件大小上限（与宿主落盘上限同口径，图片存磁盘不再受 localStorage 配额约束）。
const MAX_BACKGROUND_IMAGE_MB = Math.round(MAX_BACKGROUND_FILE_BYTES / (1024 * 1024));

export function SkinSection(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();

  // ── 换肤（Skin）本地状态 ─────────────────────────────────────────
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);
  const backgroundImage = settings.customSettings.backgroundImage?.trim() ?? "";
  const backgroundOpacity = settings.customSettings.backgroundOpacity ?? DEFAULT_BACKGROUND_OPACITY;
  // 设置项存的是磁盘引用（theme:<文件名>），预览要先读回字节转 Blob URL。
  const backgroundPreviewUrl = useBackgroundImageUrl(backgroundImage);

  function handleBackgroundFile(file: File | undefined) {
    if (!file) return;
    // 立刻清空 input 的值：同一个文件只有值变化才会再触发 change，
    // 否则失败后重试 / 换回上一张都会变成"点了没反应"。
    if (backgroundInputRef.current) backgroundInputRef.current.value = "";
    setBackgroundError(null);
    // 背景图落盘 ~/.liveagent/theme，设置里只存引用：先经画布重编码归一格式
    // （WebP/JPEG、最长边 2560），只有浏览器本来就画得出来的格式才允许按原样
    // 存；无法处理时明确报错，绝不存一张渲染不出来的图让用户以为生效了。
    void (async () => {
      const outcome = await storeBackgroundImageFile(file);
      if (outcome.status === "too-large") {
        setBackgroundError(
          t("settings.skinTooLarge").replace("{mb}", String(MAX_BACKGROUND_IMAGE_MB)),
        );
        return;
      }
      if (outcome.status === "failed") {
        setBackgroundError(t("settings.skinCompressFailed"));
        return;
      }
      // 新图写入成功即替换：宿主顺手清掉了目录里的旧背景图，无需额外回收。
      setSettings((prev) => updateCustomSettings(prev, { backgroundImage: outcome.value }));
    })();
  }

  function clearBackgroundImage() {
    setBackgroundError(null);
    void forgetBackgroundImageFile(backgroundImage);
    setSettings((prev) =>
      updateCustomSettings(prev, {
        backgroundImage: "",
        backgroundOpacity: DEFAULT_BACKGROUND_OPACITY,
      }),
    );
    if (backgroundInputRef.current) backgroundInputRef.current.value = "";
  }

  function setBackgroundOpacityValue(value: number) {
    setSettings((prev) =>
      updateCustomSettings(prev, {
        backgroundOpacity: Math.min(0.85, Math.max(0.1, value)),
      }),
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-start gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Palette className="h-4 w-4 text-muted-foreground" />
              {t("settings.skinTitle")}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("settings.skinDesc")}
            </p>
          </div>
        </div>

        {/* 配色预设 */}
        <div className="grid gap-2 sm:grid-cols-3">
          {THEME_PRESET_META.map((preset) => {
            const selected =
              normalizeThemePresetId(settings.customSettings.themePresetId) === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() =>
                  setSettings((prev) => updateCustomSettings(prev, { themePresetId: preset.id }))
                }
                className={`group relative flex items-start gap-3 rounded-xl border px-3.5 py-3.5 text-left transition-all ${
                  selected
                    ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
                    : "border-border/60 bg-background/80 hover:border-border hover:bg-muted/35"
                }`}
              >
                <div
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
                    selected ? "bg-primary/10" : "bg-muted group-hover:bg-accent/80"
                  }`}
                >
                  {/* 色板带 data-theme-preset 作用域：index.css 的预设变量选择器
                      （[data-theme-preset=...]）作用于该元素自身，渐变用该预设的
                      真实 --background → --primary 渲染，与界面实际配色单源一致，
                      不再硬编码一份可能失真的 PRESET_SWATCH。 */}
                  <div
                    data-theme-preset={preset.id}
                    className="h-5 w-5 overflow-hidden rounded-full ring-1 ring-black/10 dark:ring-white/20"
                    style={{
                      background:
                        "linear-gradient(135deg, hsl(var(--background)), hsl(var(--primary)))",
                    }}
                  />
                </div>
                <div className="min-w-0 pr-6">
                  <div className="text-sm font-semibold">{t(preset.nameKey)}</div>
                  <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                    {t(preset.hintKey)}
                  </div>
                </div>
                {selected ? (
                  <div className="absolute right-3 top-3">
                    <CheckCircle2 className="h-4.5 w-4.5 text-primary" />
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>

        {/* 背景图 */}
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-foreground">
              {t("settings.skinBackground")}
            </span>
            {backgroundImage ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs text-muted-foreground"
                onClick={clearBackgroundImage}
              >
                <ImageOff className="h-3.5 w-3.5" />
                {t("settings.skinRemove")}
              </Button>
            ) : null}
          </div>

          {backgroundImage ? (
            <div className="relative overflow-hidden rounded-xl border border-border/60">
              {backgroundPreviewUrl ? (
                <img
                  src={backgroundPreviewUrl}
                  alt={t("settings.skinBackgroundPreview")}
                  className="h-24 w-full object-cover"
                />
              ) : (
                // 读盘解析中（或引用已失效）：先占位，避免出现破图图标。
                <div className="h-24 w-full animate-pulse bg-muted/40" />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => backgroundInputRef.current?.click()}
              className="flex h-24 w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/70 bg-background/50 text-muted-foreground transition-colors hover:border-border hover:bg-muted/35 hover:text-foreground"
            >
              <Upload className="h-5 w-5" />
              <span className="text-xs">{t("settings.skinUpload")}</span>
              <span className="text-[10px] opacity-70">
                {t("settings.skinUploadLimit").replace("{mb}", String(MAX_BACKGROUND_IMAGE_MB))}
              </span>
            </button>
          )}
          <input
            ref={backgroundInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => handleBackgroundFile(event.target.files?.[0])}
          />

          {backgroundError ? (
            <p className="text-[11px] text-destructive">{backgroundError}</p>
          ) : null}

          {backgroundImage ? (
            <div className="flex items-center gap-3">
              <span className="shrink-0 text-xs text-muted-foreground">
                {t("settings.skinOpacity")}
              </span>
              <input
                type="range"
                min={0.1}
                max={0.85}
                step={0.05}
                value={backgroundOpacity}
                onChange={(event) => setBackgroundOpacityValue(Number(event.target.value))}
                className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-border accent-primary"
              />
              <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {Math.round(backgroundOpacity * 100)}%
              </span>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
