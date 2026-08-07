import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Cpu,
  Globe,
  ImageOff,
  LogOut,
  MessageSquare,
  Minimize2,
  MonitorSmartphone,
  Moon,
  Palette,
  ScanText,
  Sun,
  Terminal,
  Upload,
  Wrench,
} from "../../components/icons";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { SUPPORTED_LOCALES, useLocale } from "../../i18n";
import { inferRuntimePlatform } from "../../lib/runtimePlatform";
import {
  CLOSE_WINDOW_BEHAVIOR_OPTIONS,
  type ExecutionMode,
  type FontScaleSettings,
  isValidSystemProxyHost,
  type SystemProxyConfig,
  type SystemProxyType,
  THEME_OPTIONS,
  type Theme,
  updateCustomSettings,
  updateSystem,
} from "../../lib/settings";
import {
  buildFontFamilySelectOptions,
  FONT_FAMILY_CUSTOM_SELECT_VALUE,
  FONT_FAMILY_DEFAULT_SELECT_VALUE,
  fromFontFamilySelectValue,
  listLocalFontFamilies,
  toFontFamilySelectValue,
} from "../../lib/system/fontFamily";
import {
  compressBackgroundImage,
  DEFAULT_BACKGROUND_OPACITY,
  MAX_BACKGROUND_DATAURL_BYTES,
  normalizeThemePresetId,
  THEME_PRESET_META,
} from "../../lib/theme/appTheme";
import { useTrayPrefs, writeTrayPrefs } from "../../lib/tray/trayPrefs";
import { AgentActivationSwitch } from "./shared";
import type { SettingsSectionProps } from "./types";

const FONT_SCALE_OPTIONS = [0.9, 1, 1.1, 1.2] as const;

const FONT_FAMILY_FIELDS = ["interfaceFontFamily", "chatFontFamily", "codeFontFamily"] as const;

type FontFamilySettingKey = (typeof FONT_FAMILY_FIELDS)[number];

// 换肤：背景图大小上限（localStorage 预算内）。
const MAX_BACKGROUND_IMAGE_MB = 4;
const MAX_BACKGROUND_IMAGE_BYTES = MAX_BACKGROUND_IMAGE_MB * 1024 * 1024;

export function SystemSettingsForm(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();
  const trayPrefs = useTrayPrefs();
  const isMacPlatform = useMemo(() => inferRuntimePlatform() === "macos", []);

  const executionMode = settings.system.executionMode;
  const isClassicAgentMode = executionMode === "tools";
  const isAgentDevMode = executionMode === "agent-dev";
  const appearanceIcon =
    settings.theme === "system" ? (
      <MonitorSmartphone className="h-4 w-4 text-muted-foreground" />
    ) : settings.theme === "dark" ? (
      <Moon className="h-4 w-4 text-muted-foreground" />
    ) : (
      <Sun className="h-4 w-4 text-muted-foreground" />
    );

  function getThemeLabel(theme: Theme) {
    if (theme === "light") return t("settings.light");
    if (theme === "dark") return t("settings.dark");
    return t("settings.auto");
  }

  function renderThemeIcon(theme: Theme) {
    if (theme === "light") return <Sun className="h-4.5 w-4.5" />;
    if (theme === "dark") return <Moon className="h-4.5 w-4.5" />;
    return <MonitorSmartphone className="h-4.5 w-4.5" />;
  }

  const fontScale = settings.customSettings.fontScale;
  const fontScaleZones: Array<{ key: keyof FontScaleSettings; label: string }> = [
    { key: "sidebar", label: t("settings.fontSizeSidebar") },
    { key: "chat", label: t("settings.fontSizeChat") },
    { key: "rightDock", label: t("settings.fontSizeRightDock") },
  ];

  function getFontScaleLabel(value: number) {
    if (value === 0.9) return t("settings.fontSizeSmall");
    if (value === 1.1) return t("settings.fontSizeLarge");
    if (value === 1.2) return t("settings.fontSizeXLarge");
    return t("settings.fontSizeStandard");
  }

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

  const [localFontFamilies, setLocalFontFamilies] = useState<string[]>([]);
  const [customFontDrafts, setCustomFontDrafts] = useState<
    Partial<Record<FontFamilySettingKey, string>>
  >({});
  const [customFontModes, setCustomFontModes] = useState<
    Partial<Record<FontFamilySettingKey, boolean>>
  >({});
  const fontFamilyOptions = useMemo(
    () => buildFontFamilySelectOptions(localFontFamilies),
    [localFontFamilies],
  );

  useEffect(() => {
    let cancelled = false;
    void listLocalFontFamilies().then((families) => {
      if (!cancelled) setLocalFontFamilies(families);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setCustomFontDrafts((current) => {
      let changed = false;
      const next = { ...current };
      for (const key of FONT_FAMILY_FIELDS) {
        if (Object.hasOwn(current, key)) continue;
        const value = settings.customSettings[key];
        if (toFontFamilySelectValue(value, fontFamilyOptions) === FONT_FAMILY_CUSTOM_SELECT_VALUE) {
          next[key] = value;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [fontFamilyOptions, settings.customSettings]);

  function commitFontFamily(key: FontFamilySettingKey, value: string) {
    setSettings((prev) => updateCustomSettings(prev, { [key]: value }));
  }

  function handleFontFamilySelect(key: FontFamilySettingKey, selectValue: string) {
    if (selectValue === FONT_FAMILY_CUSTOM_SELECT_VALUE) {
      setCustomFontModes((current) => ({ ...current, [key]: true }));
      setCustomFontDrafts((current) => ({
        ...current,
        [key]: current[key] ?? settings.customSettings[key],
      }));
      return;
    }

    setCustomFontModes((current) => {
      if (!Object.hasOwn(current, key)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    setCustomFontDrafts((current) => {
      if (!Object.hasOwn(current, key)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    commitFontFamily(key, fromFontFamilySelectValue(selectValue));
  }

  function commitCustomFontFamily(key: FontFamilySettingKey) {
    const draft = customFontDrafts[key] ?? settings.customSettings[key];
    const normalized = fromFontFamilySelectValue(draft);
    // Empty custom input falls back to the built-in stack.
    commitFontFamily(key, normalized);
    setCustomFontDrafts((current) => {
      if (!Object.hasOwn(current, key)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    if (!normalized) {
      setCustomFontModes((current) => {
        if (!Object.hasOwn(current, key)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }

  function setZoneFontScale(zone: keyof FontScaleSettings, value: number) {
    setSettings((prev) =>
      updateCustomSettings(prev, {
        fontScale: { ...prev.customSettings.fontScale, [zone]: value },
      }),
    );
  }

  const systemProxy = settings.system.systemProxy;
  // host/port/username/password 走"本地草稿 + blur 提交"：失焦才写入 settings，
  // 避免逐字符触发同步；且 WebUI 设置 state 持久前会脱敏密码，草稿避免输入即被清空。
  const [proxyHostDraft, setProxyHostDraft] = useState<string | null>(null);
  const [proxyPortDraft, setProxyPortDraft] = useState<string | null>(null);
  const [proxyUsernameDraft, setProxyUsernameDraft] = useState<string | null>(null);
  const [proxyPasswordDraft, setProxyPasswordDraft] = useState<string | null>(null);
  // 护栏 A：host + port 有效才算配置可用（端口在启用时必填有效）。
  // 用"草稿优先"的生效值计算：blur 提交前开关若仍禁用，点击开关触发的 blur
  // 会先把按钮变回可用，但落在禁用按钮上的这次 click 已被浏览器吞掉，需点两次。
  const effectiveProxyHost = (proxyHostDraft ?? systemProxy.host).trim();
  const effectiveProxyPort =
    proxyPortDraft !== null ? Number.parseInt(proxyPortDraft, 10) : systemProxy.port;
  const proxyConfigValid =
    isValidSystemProxyHost(effectiveProxyHost) &&
    Number.isInteger(effectiveProxyPort) &&
    effectiveProxyPort >= 1 &&
    effectiveProxyPort <= 65535;
  const systemProxyInvalid = systemProxy.enabled && !proxyConfigValid;
  // 配置无效且当前未启用时禁止开启开关（护栏 A）；已启用时始终允许关闭。
  const proxyToggleDisabled = !systemProxy.enabled && !proxyConfigValid;

  function patchSystemProxy(patch: Partial<SystemProxyConfig>) {
    setSettings((prev) =>
      updateSystem(prev, {
        systemProxy: { ...prev.system.systemProxy, ...patch },
      }),
    );
  }

  function commitProxyHostDraft() {
    if (proxyHostDraft !== null) {
      patchSystemProxy({ host: proxyHostDraft.trim() });
      setProxyHostDraft(null);
    }
  }

  function commitProxyPortDraft() {
    if (proxyPortDraft !== null) {
      const parsed = Number.parseInt(proxyPortDraft, 10);
      patchSystemProxy({ port: Number.isNaN(parsed) ? 0 : parsed });
      setProxyPortDraft(null);
    }
  }

  function commitProxyUsernameDraft() {
    if (proxyUsernameDraft !== null) {
      patchSystemProxy({ username: proxyUsernameDraft.trim() });
      setProxyUsernameDraft(null);
    }
  }

  function commitProxyPasswordDraft() {
    if (proxyPasswordDraft !== null) {
      patchSystemProxy({ password: proxyPasswordDraft });
      setProxyPasswordDraft(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          {t("settings.executionMode")}
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <button
            type="button"
            onClick={() =>
              setSettings((prev) => updateSystem(prev, { executionMode: "text" as ExecutionMode }))
            }
            className={`group relative flex flex-col items-start gap-3 rounded-xl border-2 p-4 text-left transition-all ${
              executionMode === "text"
                ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
                : "border-transparent bg-muted/40 hover:border-border hover:bg-muted/60"
            }`}
          >
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
                executionMode === "text"
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground group-hover:bg-accent"
              }`}
            >
              <MessageSquare className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">{t("settings.chatMode")}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("settings.chatModeDesc")}
              </div>
            </div>
            {executionMode === "text" ? (
              <div className="absolute right-3 top-3">
                <CheckCircle2 className="h-4.5 w-4.5 text-primary" />
              </div>
            ) : null}
          </button>

          <button
            type="button"
            onClick={() =>
              setSettings((prev) => updateSystem(prev, { executionMode: "tools" as ExecutionMode }))
            }
            className={`group relative flex flex-col items-start gap-3 rounded-xl border-2 p-4 text-left transition-all ${
              isClassicAgentMode
                ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
                : "border-transparent bg-muted/40 hover:border-border hover:bg-muted/60"
            }`}
          >
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
                isClassicAgentMode
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground group-hover:bg-accent"
              }`}
            >
              <Wrench className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">{t("settings.agentMode")}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("settings.agentModeDesc")}
              </div>
            </div>
            {isClassicAgentMode ? (
              <div className="absolute right-3 top-3">
                <CheckCircle2 className="h-4.5 w-4.5 text-primary" />
              </div>
            ) : null}
          </button>

          <button
            type="button"
            onClick={() =>
              setSettings((prev) =>
                updateSystem(prev, { executionMode: "agent-dev" as ExecutionMode }),
              )
            }
            className={`group relative flex flex-col items-start gap-3 rounded-xl border-2 p-4 text-left transition-all ${
              isAgentDevMode
                ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
                : "border-transparent bg-muted/40 hover:border-border hover:bg-muted/60"
            }`}
          >
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
                isAgentDevMode
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground group-hover:bg-accent"
              }`}
            >
              <Cpu className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">{t("settings.agentDevMode")}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("settings.agentDevModeDesc")}
              </div>
            </div>
            {isAgentDevMode ? (
              <div className="absolute right-3 top-3">
                <CheckCircle2 className="h-4.5 w-4.5 text-primary" />
              </div>
            ) : null}
          </button>
        </div>
      </div>

      <div className="border-t" />

      <div className="grid gap-4 md:grid-cols-2">
        <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
          <div className="flex items-start gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                {appearanceIcon}
                {t("settings.appearance")}
              </div>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            {THEME_OPTIONS.map((theme) => {
              const selected = settings.theme === theme;
              return (
                <button
                  key={theme}
                  type="button"
                  onClick={() => setSettings((prev) => ({ ...prev, theme }))}
                  className={`group relative flex h-full items-start gap-3 rounded-xl border px-3.5 py-3.5 text-left transition-all ${
                    selected
                      ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
                      : "border-border/60 bg-background/80 hover:border-border hover:bg-muted/35"
                  }`}
                >
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
                      selected
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground group-hover:bg-accent/80"
                    }`}
                  >
                    {renderThemeIcon(theme)}
                  </div>
                  <div className="min-w-0 pr-6">
                    <div className="text-sm font-semibold">{getThemeLabel(theme)}</div>
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
        </section>

        <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4 md:col-span-2 md:order-last">
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

        <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
          <div className="flex items-start gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <MessageSquare className="h-4 w-4 text-muted-foreground" />
                {t("settings.language")}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {SUPPORTED_LOCALES.map((locale) => {
              const selected = settings.locale === locale;
              const localeLabel =
                locale === "zh-CN"
                  ? t("settings.chinese")
                  : locale === "en-US"
                    ? t("settings.english")
                    : locale;
              return (
                <button
                  key={locale}
                  type="button"
                  onClick={() => setSettings((prev) => ({ ...prev, locale }))}
                  className={`group relative flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-all ${
                    selected
                      ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
                      : "border-border/60 bg-background/80 hover:border-border hover:bg-muted/35"
                  }`}
                >
                  <span className="text-base leading-none">{locale === "zh-CN" ? "🇨🇳" : "🇺🇸"}</span>
                  <div className="min-w-0 flex-1 pr-5">
                    <div className="truncate text-sm font-semibold">{localeLabel}</div>
                    <div className="mt-0.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      {locale}
                    </div>
                  </div>
                  {selected ? (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <CheckCircle2 className="h-4.5 w-4.5 text-primary" />
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>
      </div>

      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Globe className="h-4 w-4 text-muted-foreground" />
            {t("settings.systemProxy")}
          </div>
          <AgentActivationSwitch
            checked={systemProxy.enabled}
            title={t("settings.systemProxyEnable")}
            disabled={proxyToggleDisabled}
            onToggle={() => patchSystemProxy({ enabled: !systemProxy.enabled })}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("settings.systemProxyDesc")}</p>
        {systemProxyInvalid ? (
          <p className="text-xs text-destructive">{t("settings.systemProxyInvalid")}</p>
        ) : proxyToggleDisabled ? (
          <p className="text-xs text-muted-foreground">{t("settings.systemProxyEnableHint")}</p>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-12 lg:items-start">
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-2">
            <Label className="text-xs font-medium text-muted-foreground">
              {t("settings.systemProxyType")}
            </Label>
            <Select
              value={systemProxy.type}
              onValueChange={(value) => patchSystemProxy({ type: value as SystemProxyType })}
            >
              <SelectTrigger className="w-full">
                <SelectValue>{systemProxy.type === "socks5" ? "SOCKS5" : "HTTP"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">HTTP</SelectItem>
                <SelectItem value="socks5">SOCKS5</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 lg:col-span-4">
            <Label
              htmlFor="system-proxy-host"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("settings.systemProxyHost")}
            </Label>
            <Input
              id="system-proxy-host"
              value={proxyHostDraft ?? systemProxy.host}
              placeholder="127.0.0.1"
              onChange={(event) => setProxyHostDraft(event.currentTarget.value)}
              onBlur={commitProxyHostDraft}
            />
          </div>
          <div className="space-y-1.5 lg:col-span-2">
            <Label
              htmlFor="system-proxy-port"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("settings.systemProxyPort")}
            </Label>
            <Input
              id="system-proxy-port"
              type="number"
              min={1}
              max={65535}
              value={proxyPortDraft ?? (systemProxy.port > 0 ? String(systemProxy.port) : "")}
              placeholder={systemProxy.type === "socks5" ? "1080" : "7890"}
              onChange={(event) => setProxyPortDraft(event.currentTarget.value)}
              onBlur={commitProxyPortDraft}
            />
          </div>
          <div className="space-y-1.5 lg:col-span-2">
            <Label
              htmlFor="system-proxy-username"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("settings.systemProxyUsername")}
            </Label>
            <Input
              id="system-proxy-username"
              value={proxyUsernameDraft ?? systemProxy.username}
              onChange={(event) => setProxyUsernameDraft(event.currentTarget.value)}
              onBlur={commitProxyUsernameDraft}
            />
          </div>
          <div className="space-y-1.5 lg:col-span-2">
            <Label
              htmlFor="system-proxy-password"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("settings.systemProxyPassword")}
            </Label>
            <Input
              id="system-proxy-password"
              type="password"
              value={proxyPasswordDraft ?? systemProxy.password}
              onChange={(event) => setProxyPasswordDraft(event.currentTarget.value)}
              onBlur={commitProxyPasswordDraft}
            />
            {systemProxy.passwordConfigured &&
            !(proxyPasswordDraft ?? systemProxy.password).trim() ? (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>{t("settings.systemProxyPasswordConfigured")}</span>
                <button
                  type="button"
                  className="underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => {
                    setProxyPasswordDraft(null);
                    patchSystemProxy({ password: "", passwordConfigured: false });
                  }}
                >
                  {t("settings.systemProxyPasswordClear")}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Minimize2 className="h-4 w-4 text-muted-foreground" />
          {t("settings.closeWindowBehavior")}
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {CLOSE_WINDOW_BEHAVIOR_OPTIONS.map((behavior) => {
            const selected = settings.closeWindowBehavior === behavior;
            const isMinimize = behavior === "minimize";
            return (
              <button
                key={behavior}
                type="button"
                onClick={() =>
                  setSettings((prev) => ({
                    ...prev,
                    closeWindowBehavior: behavior,
                  }))
                }
                className={`group relative flex h-full items-start gap-3 rounded-xl border px-3.5 py-3.5 text-left transition-all ${
                  selected
                    ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
                    : "border-border/60 bg-background/80 hover:border-border hover:bg-muted/35"
                }`}
              >
                <div
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
                    selected
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground group-hover:bg-accent/80"
                  }`}
                >
                  {isMinimize ? (
                    <Minimize2 className="h-4.5 w-4.5" />
                  ) : (
                    <LogOut className="h-4.5 w-4.5" />
                  )}
                </div>
                <div className="min-w-0 pr-6">
                  <div className="text-sm font-semibold">
                    {isMinimize ? t("settings.closeWindowMinimize") : t("settings.closeWindowExit")}
                  </div>
                  <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {isMinimize
                      ? t("settings.closeWindowMinimizeDesc")
                      : t("settings.closeWindowExitDesc")}
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
      </section>

      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <MonitorSmartphone className="h-4 w-4 text-muted-foreground" />
          {t("settings.trayTitle")}
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-foreground">{t("settings.trayShowTitles")}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("settings.trayShowTitlesDesc")}
            </p>
          </div>
          <AgentActivationSwitch
            checked={trayPrefs.showConversationTitles}
            title={t("settings.trayShowTitles")}
            onToggle={() =>
              writeTrayPrefs({ showConversationTitles: !trayPrefs.showConversationTitles })
            }
          />
        </div>
        {isMacPlatform ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm text-foreground">{t("settings.trayRunningBadge")}</div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("settings.trayRunningBadgeDesc")}
              </p>
            </div>
            <AgentActivationSwitch
              checked={trayPrefs.showRunningBadge}
              title={t("settings.trayRunningBadge")}
              onToggle={() => writeTrayPrefs({ showRunningBadge: !trayPrefs.showRunningBadge })}
            />
          </div>
        ) : null}
      </section>

      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ScanText className="h-4 w-4 text-muted-foreground" />
          {t("settings.fontFamily")}
        </div>

        <div className="space-y-2">
          {FONT_FAMILY_FIELDS.map((key) => {
            const currentValue = settings.customSettings[key];
            const selectValue = toFontFamilySelectValue(
              currentValue,
              fontFamilyOptions,
              customFontModes[key] === true,
            );
            const showCustomInput = selectValue === FONT_FAMILY_CUSTOM_SELECT_VALUE;
            const customDraft = customFontDrafts[key] ?? currentValue;
            return (
              <div key={key} className="space-y-1.5">
                <Label
                  htmlFor={`${key}-select`}
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t(`settings.${key}`)}
                </Label>
                <div className="flex min-w-0 items-center gap-2">
                  <Select
                    value={selectValue}
                    onValueChange={(value) => handleFontFamilySelect(key, value)}
                  >
                    <SelectTrigger
                      id={`${key}-select`}
                      className={showCustomInput ? "w-[9.5rem] shrink-0" : "w-full"}
                    >
                      <SelectValue placeholder={t("settings.fontFamilyDefault")}>
                        {(value) => {
                          if (value === FONT_FAMILY_DEFAULT_SELECT_VALUE) {
                            return t("settings.fontFamilyDefault");
                          }
                          if (value === FONT_FAMILY_CUSTOM_SELECT_VALUE) {
                            return t("settings.fontFamilyCustom");
                          }
                          const match = fontFamilyOptions.find((option) => option.value === value);
                          return match?.label ?? String(value ?? "");
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem value={FONT_FAMILY_DEFAULT_SELECT_VALUE}>
                        {t("settings.fontFamilyDefault")}
                      </SelectItem>
                      <SelectItem value={FONT_FAMILY_CUSTOM_SELECT_VALUE}>
                        {t("settings.fontFamilyCustom")}
                      </SelectItem>
                      {fontFamilyOptions.map((option) => (
                        <SelectItem
                          key={option.value}
                          value={option.value}
                          style={{ fontFamily: option.value }}
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {showCustomInput ? (
                    <Input
                      id={`${key}-custom-input`}
                      className="min-w-0 flex-1"
                      value={customDraft}
                      list="font-family-suggestions"
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={t("settings.fontFamilyPlaceholder")}
                      onChange={(event) =>
                        setCustomFontDrafts((current) => ({
                          ...current,
                          [key]: event.target.value,
                        }))
                      }
                      onBlur={() => commitCustomFontFamily(key)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <datalist id="font-family-suggestions">
          {localFontFamilies.map((family) => (
            <option key={family} value={family} />
          ))}
        </datalist>
      </section>

      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ScanText className="h-4 w-4 text-muted-foreground" />
          {t("settings.fontSize")}
        </div>

        <div className="space-y-2">
          {fontScaleZones.map((zone) => (
            <div
              key={zone.key}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 bg-background/80 px-3.5 py-2.5"
            >
              <div className="text-sm font-medium text-foreground">{zone.label}</div>
              <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-0.5">
                {FONT_SCALE_OPTIONS.map((value) => {
                  const selected = fontScale[zone.key] === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setZoneFontScale(zone.key, value)}
                      className={`rounded-md px-2.5 py-1 text-xs transition-all ${
                        selected
                          ? "bg-background font-semibold text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {getFontScaleLabel(value)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
