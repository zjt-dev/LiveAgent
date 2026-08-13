import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";

export function AppEnvironmentBadge({ compact = false }: { compact?: boolean }) {
  const { t } = useLocale();

  if (!import.meta.env.DEV) {
    return null;
  }

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center border border-amber-500/35 bg-amber-400/15 font-semibold text-amber-800 dark:border-amber-400/30 dark:bg-amber-300/10 dark:text-amber-300",
        compact
          ? "h-4 rounded px-1 text-[9px] leading-none"
          : "h-5 rounded px-1.5 text-[10px] leading-none",
      )}
      title={t("app.localDevelopment")}
    >
      {t("app.localDevelopment")}
    </span>
  );
}
