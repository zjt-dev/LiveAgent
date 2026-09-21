import { ChevronRight, Columns2, Cpu, Plus, Terminal } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { PointerEvent as ReactPointerEvent } from "react";
import { cn } from "../../lib/shared/utils";
import type { TerminalShellOption } from "../../lib/terminal/types";
import { buttonVariants } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { NO_LEASED_RIGHT_DOCK_TOOLS, type RightDockLeasedToolKind } from "./rightDockModel";
import {
  RIGHT_DOCK_TOOL_DEFINITIONS,
  type RightDockSingletonTabKind,
  type RightDockToolDefinition,
} from "./rightDockRegistry";

export type RightDockToolDragStartEvent = {
  pointerId: number;
  clientX: number;
  clientY: number;
  currentTarget?: EventTarget | null;
};

/** 一个工具的入口是否可用：三类最小条件分别对应 project / remoteWorkspace / tunnel。 */
type RightDockToolAvailability = {
  projectReady: boolean;
  remoteWorkspaceAvailable: boolean;
  tunnelAvailable: boolean;
};

type RightDockToolDisabledMessages = {
  disabledMessage?: string;
  remoteWorkspaceDisabledMessage?: string;
};

function toolAvailable(
  definition: RightDockToolDefinition,
  availability: RightDockToolAvailability,
) {
  if (definition.projectRequired) return availability.projectReady;
  if (definition.remoteRequired) return availability.remoteWorkspaceAvailable;
  return availability.tunnelAvailable;
}

/**
 * 禁用原因只给「需要某个项目形态」的工具挂 tooltip：内网穿透的不可用原因由面板
 * 自己解释（它能在无项目时打开），项目工具与远程工作空间侧栏则需要一句话说明
 * 「该切到哪种工作空间」。
 */
function toolDisabledMessage(
  definition: RightDockToolDefinition,
  messages: RightDockToolDisabledMessages,
) {
  if (definition.projectRequired) return messages.disabledMessage;
  if (definition.remoteRequired) return messages.remoteWorkspaceDisabledMessage;
  return undefined;
}

type RightDockLauncherActions = {
  /** Tools whose surface lives in a workbench pane: no launcher entry for them. */
  leasedTools?: ReadonlySet<RightDockLeasedToolKind>;
  onCreateTerminal: (shell?: string) => void;
  onOpenNewTerminalInWorkbench?: () => void;
  onStartTool: (kind: RightDockSingletonTabKind) => void;
  // Opens the derived background-tasks tab via ephemeral session state; it
  // is not a registry tool and never writes persisted right-dock settings.
  onOpenBackgroundTasks: () => void;
};

type RightDockCreateMenuProps = RightDockLauncherActions & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shellOptions: TerminalShellOption[];
  terminalReady: boolean;
  terminalDisabledMessage?: string;
  projectReady: boolean;
  tunnelAvailable: boolean;
  remoteWorkspaceAvailable: boolean;
  remoteWorkspaceDisabledMessage?: string;
  creating: boolean;
};

type RightDockChooserProps = RightDockLauncherActions & {
  terminalReady: boolean;
  terminalDisabledMessage?: string;
  disabledMessage?: string;
  projectReady: boolean;
  tunnelAvailable: boolean;
  remoteWorkspaceAvailable: boolean;
  remoteWorkspaceDisabledMessage?: string;
  creating: boolean;
  loading: boolean;
  error: string | null;
  /**
   * 存在时"新建终端"入口可拖出到工作台画板(拖到落点新建终端 Pane);
   * 点击行为不变(新建并进 dock)。拖拽阈值与点击抑制由工作台拖拽会话处理。
   */
  onNewTerminalDragStart?: (event: RightDockToolDragStartEvent) => void;
  /**
   * 存在时每个工具入口(文件树/审查/内网穿透/SSH/后台任务)可拖出到工作台
   * 画板,在落点直接打开该工具 Pane;点击行为不变(在 dock 内打开)。
   */
  onToolDragStart?: (kind: RightDockLeasedToolKind, event: RightDockToolDragStartEvent) => void;
};

export function RightDockCreateMenu(props: RightDockCreateMenuProps) {
  const {
    leasedTools = NO_LEASED_RIGHT_DOCK_TOOLS,
    open,
    onOpenChange,
    shellOptions,
    terminalReady,
    terminalDisabledMessage,
    projectReady,
    tunnelAvailable,
    remoteWorkspaceAvailable,
    remoteWorkspaceDisabledMessage,
    creating,
    onCreateTerminal,
    onOpenNewTerminalInWorkbench,
    onStartTool,
    onOpenBackgroundTasks,
  } = props;
  const { t } = useLocale();
  const availability: RightDockToolAvailability = {
    projectReady,
    remoteWorkspaceAvailable,
    tunnelAvailable,
  };
  const disabledMessages: RightDockToolDisabledMessages = {
    disabledMessage: terminalDisabledMessage,
    remoteWorkspaceDisabledMessage,
  };

  const terminalItem =
    shellOptions.length > 1 ? (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={!terminalReady || creating} className="gap-2 text-xs">
          <Terminal className="h-3.5 w-3.5" />
          <span className="min-w-0 flex-1">{t("projectTools.newTerminal")}</span>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-36">
          {shellOptions.map((option) => (
            <DropdownMenuItem
              key={option.id}
              onSelect={() => onCreateTerminal(option.id)}
              disabled={!terminalReady || creating}
              className="gap-2 text-xs"
              title={option.command || option.label}
            >
              <Terminal className="h-3.5 w-3.5" />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    ) : (
      <DropdownMenuItem
        onSelect={() => onCreateTerminal()}
        disabled={!terminalReady || creating}
        className="gap-2 text-xs"
        title={terminalDisabledMessage}
      >
        <Terminal className="h-3.5 w-3.5" />
        {t("projectTools.newTerminal")}
      </DropdownMenuItem>
    );

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      {/* Native trigger button styled via buttonVariants: Base UI Trigger
          renders a plain <button>, so this stays identical on GUI and web. */}
      <DropdownMenuTrigger
        disabled={!(projectReady || tunnelAvailable || remoteWorkspaceAvailable) || creating}
        title={t("projectTools.newProjectTool")}
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon" }),
          "h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground",
        )}
      >
        <Plus className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-40">
        {terminalItem}
        {onOpenNewTerminalInWorkbench ? (
          <DropdownMenuItem
            onSelect={onOpenNewTerminalInWorkbench}
            disabled={!terminalReady || creating}
            className="gap-2 text-xs"
            title={terminalDisabledMessage}
          >
            <Columns2 className="h-3.5 w-3.5" />
            {t("workbench.openNewTerminalInSplit")}
          </DropdownMenuItem>
        ) : null}
        {RIGHT_DOCK_TOOL_DEFINITIONS.filter((definition) => !leasedTools.has(definition.kind)).map(
          (definition) => {
            const disabled = !toolAvailable(definition, availability);
            return (
              <DropdownMenuItem
                key={definition.kind}
                onSelect={() => onStartTool(definition.kind)}
                disabled={disabled}
                // 「为什么不可用」只在真的不可用时才是有效信息：可用的项挂着
                // 一句禁用原因会让人以为点不动。
                title={disabled ? toolDisabledMessage(definition, disabledMessages) : undefined}
                className="gap-2 text-xs"
              >
                {definition.icon("h-3.5 w-3.5")}
                {t(definition.createTitleKey)}
              </DropdownMenuItem>
            );
          },
        )}
        {leasedTools.has("backgroundTasks") ? null : (
          <DropdownMenuItem onSelect={onOpenBackgroundTasks} className="gap-2 text-xs">
            <Cpu className="h-3.5 w-3.5" />
            {t("projectTools.backgroundTasksTitle")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RightDockChooser(props: RightDockChooserProps) {
  const {
    leasedTools = NO_LEASED_RIGHT_DOCK_TOOLS,
    terminalReady,
    terminalDisabledMessage,
    disabledMessage,
    projectReady,
    tunnelAvailable,
    remoteWorkspaceAvailable,
    remoteWorkspaceDisabledMessage,
    creating,
    loading,
    error,
    onCreateTerminal,
    onStartTool,
    onOpenBackgroundTasks,
    onNewTerminalDragStart,
    onToolDragStart,
  } = props;
  const { t } = useLocale();
  const availability: RightDockToolAvailability = {
    projectReady,
    remoteWorkspaceAvailable,
    tunnelAvailable,
  };
  const disabledMessages: RightDockToolDisabledMessages = {
    disabledMessage,
    remoteWorkspaceDisabledMessage,
  };
  const terminalTileDisabled = !terminalReady || creating;
  // Drag-out arms on primary-button mouse/pen only; touch keeps scrolling the
  // chooser (same rule as the terminal tile and dock tab drag-out).
  const toolDragHandler = (kind: RightDockLeasedToolKind, disabled: boolean) =>
    onToolDragStart && !disabled
      ? (event: ReactPointerEvent<HTMLButtonElement>) => {
          if (event.button !== 0 || event.pointerType === "touch") return;
          onToolDragStart(kind, {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            currentTarget: event.currentTarget,
          });
        }
      : undefined;
  const tools = [
    {
      key: "terminal",
      title: t("projectTools.newTerminal"),
      description: t("projectTools.terminalDescription"),
      icon: <Terminal className="h-4.5 w-4.5" />,
      disabled: terminalTileDisabled,
      titleAttr: terminalDisabledMessage,
      onClick: () => onCreateTerminal(),
      onPointerDown:
        onNewTerminalDragStart && !terminalTileDisabled
          ? (event: ReactPointerEvent<HTMLButtonElement>) => {
              if (event.button !== 0 || event.pointerType === "touch") return;
              onNewTerminalDragStart({
                pointerId: event.pointerId,
                clientX: event.clientX,
                clientY: event.clientY,
                currentTarget: event.currentTarget,
              });
            }
          : undefined,
    },
    ...RIGHT_DOCK_TOOL_DEFINITIONS.filter((definition) => !leasedTools.has(definition.kind)).map(
      (definition) => {
        const disabled = !toolAvailable(definition, availability);
        return {
          key: definition.kind,
          title: t(definition.createTitleKey),
          description: t(definition.descriptionKey),
          icon: definition.icon("h-4.5 w-4.5"),
          disabled,
          // 同 create 菜单：禁用原因只属于禁用态，否则可点的一项会带着
          // 「该功能只在远程文件夹中可用」这类 tooltip，反而把人劝退。
          titleAttr: disabled ? toolDisabledMessage(definition, disabledMessages) : undefined,
          onClick: () => onStartTool(definition.kind),
          onPointerDown: toolDragHandler(definition.kind, disabled),
        };
      },
    ),
    ...(leasedTools.has("backgroundTasks")
      ? []
      : [
          {
            key: "backgroundTasks",
            title: t("projectTools.backgroundTasksTitle"),
            description: t("projectTools.backgroundTasksDescription"),
            icon: <Cpu className="h-4.5 w-4.5" />,
            disabled: false,
            titleAttr: undefined,
            onClick: onOpenBackgroundTasks,
            onPointerDown: toolDragHandler("backgroundTasks", false),
          },
        ]),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-5 py-6">
      <div className="flex flex-col items-center gap-1">
        <h3 className="text-sm font-medium text-foreground">{t("projectTools.getStarted")}</h3>
        <p className="text-xs text-muted-foreground">{t("projectTools.getStartedHint")}</p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-2">
        {tools.map((tool) => (
          <button
            key={tool.key}
            type="button"
            onClick={tool.onClick}
            onPointerDown={tool.onPointerDown}
            disabled={tool.disabled}
            title={tool.titleAttr}
            className="group flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3.5 py-3 text-left text-sm text-foreground transition-all hover:border-border hover:bg-muted/60 hover:shadow-sm disabled:pointer-events-none disabled:opacity-50"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted/80 text-muted-foreground transition-colors group-hover:bg-muted group-hover:text-foreground">
              {tool.icon}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium leading-tight">{tool.title}</div>
              <div className="mt-0.5 text-xs leading-tight text-muted-foreground">
                {tool.description}
              </div>
            </div>
          </button>
        ))}
      </div>
      {loading ? (
        <div className="text-center text-xs text-muted-foreground">{t("projectTools.loading")}</div>
      ) : null}
      {error ? <div className="text-center text-xs text-destructive">{error}</div> : null}
    </div>
  );
}
