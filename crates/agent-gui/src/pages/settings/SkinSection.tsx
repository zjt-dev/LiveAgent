import { CheckCircle2, ImageOff, Palette, Upload } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  compressBackgroundImage,
  DEFAULT_BACKGROUND_OPACITY,
  MAX_BACKGROUND_DATAURL_BYTES,
  normalizeThemePresetId,
  THEME_PRESET_META,
} from "@liveagent/ui/lib/theme/appTheme";
import { useRef, useState } from "react";
import { updateCustomSettings } from "../../lib/settings";
import type { SettingsSectionProps } from "./types";

// 换肤：背景图大小上限（localStorage 预算内）。
const MAX_BACKGROUND_IMAGE_MB = 4;
const MAX_BACKGROUND_IMAGE_BYTES = MAX_BACKGROUND_IMAGE_MB * 1024 * 1024;

export function SkinSection(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();

  // ── 换肤（Skin）本地状态 ─────────────────────────────────────────
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);
  const backgroundImage = settings.customSettings.backgroundImage?.trim() ?? "";
  const backgroundOpacity = settings.customSettings.backgroundOpacity ?? DEFAULT_BACKGROUND_OPACITY;

  function handleBackgroundFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_BACKGROUND_IMAGE_BYTES) {
      setBackgroundError(
        t("settings.skinTooLarge").replace("{mb}", String(MAX_BACKGROUND_IMAGE_MB)),
      );
      return;
    }
    setBackgroundError(null);
    // 背景图走压缩：原图 base64 可能达数 MB，超 localStorage 配额 / WebView
    // 大 dataURL 渲染上限会静默失效；压缩成紧凑 dataURL 再存。
    void (async () => {
      const compressed = await compressBackgroundImage(file);
      if (!compressed) {
        // 压缩失败（canvas/编码不可用或压不进上限）：回退原始 dataURL，但必须
        // 先校验其大小——超大 dataURL 写入 localStorage 会被配额异常静默丢弃，
        // 用户无感知丢图。超过压缩目标上限即报错，绝不静默回退。
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = typeof reader.result === "string" ? reader.result : "";
          if (!dataUrl) return;
          // base64 dataURL 近似字节数 = 去 header 后 base64 长度 × 3/4。
          const commaIndex = dataUrl.indexOf(",");
          const approxBytes =
            commaIndex >= 0 ? Math.round((dataUrl.length - commaIndex - 1) * 0.75) : dataUrl.length;
          if (approxBytes > MAX_BACKGROUND_DATAURL_BYTES) {
            setBackgroundError(
              t("settings.skinCompressFailed").replace(
                "{mb}",
                String(Math.ceil(MAX_BACKGROUND_DATAURL_BYTES / (1024 * 1024))),
              ),
            );
            return;
          }
          setSettings((prev) => updateCustomSettings(prev, { backgroundImage: dataUrl }));
        };
        reader.readAsDataURL(file);
        return;
      }
      setSettings((prev) => updateCustomSettings(prev, { backgroundImage: compressed }));
    })();
  }

  function clearBackgroundImage() {
    setBackgroundError(null);
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
              <img
                src={backgroundImage}
                alt={t("settings.skinBackgroundPreview")}
                className="h-24 w-full object-cover"
              />
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
