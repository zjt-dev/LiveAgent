import { cn } from "@liveagent/ui/lib/shared/utils";
import { PanelRightClose, PanelRightOpen } from "../IconSet";
import { Button } from "../ui/button";

export function ProjectToolsPanelToggle(props: {
  isOpen: boolean;
  sessionCount: number;
  disabledMessage?: string;
  /**
   * 活动项目是远程工作空间时，面板里的「远程工作空间」侧栏（Bash + SFTP）依然可用。
   * `disabledMessage` 描述的是**本地项目工具**为什么不可用（本地根缺失），此时它不
   * 能把整块面板的入口一起锁死 —— 否则用户在远程文件夹里根本打不开 dock，也就永远
   * 看不到那个侧栏，更没法把它拖到工作台。所以这里单独放行。
   */
  remoteWorkspaceAvailable?: boolean;
  className?: string;
  onToggle: () => void;
}) {
  const {
    isOpen,
    sessionCount,
    disabledMessage,
    remoteWorkspaceAvailable = false,
    className = "",
    onToggle,
  } = props;
  const localToolsUnavailable = Boolean(disabledMessage) && !remoteWorkspaceAvailable;
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onToggle}
      disabled={localToolsUnavailable && !isOpen}
      aria-expanded={isOpen}
      title={
        isOpen
          ? "Collapse project tools panel"
          : localToolsUnavailable
            ? disabledMessage
            : "Expand project tools panel"
      }
      className={cn(
        className,
        "relative h-8 w-8 rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 hover:text-foreground active:scale-95",
        isOpen ? "bg-muted text-foreground" : "",
      )}
    >
      {isOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
      {sessionCount > 0 ? (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[calc(10px*var(--zone-font-scale,1))] font-semibold leading-none text-white">
          {sessionCount}
        </span>
      ) : null}
    </Button>
  );
}
