import { Switch } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import { SettingsGroup, SettingsRow } from "@liveagent/ui/pages/settings/shared";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { asErrorMessage } from "../chat/chatPageUtils";

type ContextMenuStatus = {
  supported: boolean;
  enabled: boolean;
};

/**
 * 资源管理器右键菜单（「在 LiveAgent 中打开」）开关。
 *
 * 注册状态的真源是 HKCU 注册表而非应用设置：用户可能手动改过，或应用重装到
 * 新路径后 command 已指向旧 exe，因此每次进入都读回后端状态，开关只写不缓存。
 */
export function SystemIntegrationSection() {
  const { t } = useLocale();
  const [status, setStatus] = useState<ContextMenuStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void invoke<ContextMenuStatus>("app_context_menu_status")
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        // 非 Tauri 环境：按不支持处理，避免开关停在加载态。
        if (!cancelled) setStatus({ supported: false, enabled: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleToggle(enabled: boolean) {
    setPending(true);
    setError(null);
    void invoke<ContextMenuStatus>("app_context_menu_set", { enabled })
      .then(setStatus)
      .catch((reason: unknown) => {
        setError(asErrorMessage(reason, t("settings.contextMenuToggleFailed")));
      })
      .finally(() => {
        setPending(false);
      });
  }

  return (
    <SettingsGroup title={t("settings.systemIntegrationTitle")}>
      {status?.supported === false ? (
        <SettingsRow
          title={t("settings.contextMenuTitle")}
          description={t("settings.contextMenuUnsupported")}
          control={null}
        />
      ) : (
        <SettingsRow
          title={t("settings.contextMenuTitle")}
          description={t("settings.contextMenuDesc")}
          control={
            <Switch
              checked={status?.enabled === true}
              disabled={status === null || pending}
              aria-label={t("settings.contextMenuTitle")}
              onCheckedChange={(checked) => handleToggle(checked === true)}
            />
          }
        />
      )}
      {error ? <p className="px-5 pb-4 text-xs text-destructive">{error}</p> : null}
    </SettingsGroup>
  );
}
