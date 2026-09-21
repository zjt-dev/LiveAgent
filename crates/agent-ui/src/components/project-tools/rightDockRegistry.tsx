import { FolderTree, GitBranch, Globe, Key, Server } from "@liveagent/ui/components/IconSet";
import { FileTreePanel } from "@liveagent/ui/components/project-tools/file-tree/index";
import { GitReviewPanel } from "@liveagent/ui/components/project-tools/git-review/index";
import type { ReactNode } from "react";
import { LocalTunnelPanel } from "./LocalTunnelPanel";
import { RemoteWorkspacePanel } from "./RemoteWorkspacePanel";
import { type RightDockToolContextValue, useRightDockToolContext } from "./RightDockContext";
import type { RightDockSingletonTabKind } from "./rightDockModel";
import { SshTunnelPanel } from "./SshTunnelPanel";

export type { RightDockSingletonTabKind } from "./rightDockModel";

export type RightDockToolRenderInput = {
  active: boolean;
};

export type RightDockToolDefinition = {
  kind: RightDockSingletonTabKind;
  titleKey: string;
  createTitleKey: string;
  descriptionKey: string;
  closeKey: string;
  /** 需要「有本地项目根」才能用（终端 / 文件树 / 审查 / SSH 隧道）。 */
  projectRequired: boolean;
  /**
   * 需要「活动项目是远程工作空间」才能用（远程工作空间侧栏）。与 projectRequired
   * 互斥：它要的是远端根 + hostId，恰恰是本地根缺失的那种项目。
   */
  remoteRequired?: boolean;
  icon: (className: string) => ReactNode;
  // Classes RightDockContent applies to the keep-alive wrapper while this tool
  // is the active tab (inactive tools stay mounted behind "hidden").
  containerActiveClassName: string;
  isAvailable: (context: RightDockToolContextValue) => boolean;
  render: (input: RightDockToolRenderInput) => ReactNode;
};

// Each tool body is a component of its own so it can read the dock context via
// useRightDockToolContext; definition.render only instantiates it.
function FileTreeTool(props: RightDockToolRenderInput) {
  // FileTreePanel reads the dock context itself and keeps per-project state
  // in an LRU bucket, so it deliberately has no projectPathKey remount key:
  // staying mounted across project switches is what makes the bucket useful.
  return <FileTreePanel active={props.active} />;
}

function GitReviewTool(props: RightDockToolRenderInput) {
  const { active } = props;
  const context = useRightDockToolContext();
  // The panel reads everything else (clients, capabilities, git callbacks)
  // from the right-dock tool context itself.
  return <GitReviewPanel key={`${context.projectPathKey}:git-review`} active={active} />;
}

function TunnelTool(props: RightDockToolRenderInput) {
  const { active } = props;
  const context = useRightDockToolContext();
  return (
    <LocalTunnelPanel
      active={active}
      client={context.clients.tunnel ?? null}
      enabled={context.capabilities.tunnelEnabled}
      disabledMessage={context.capabilities.tunnelDisabledMessage}
      projectPathKey={context.projectPathKey}
      publicBaseUrl={context.capabilities.tunnelPublicBaseUrl}
      onOpenExternal={context.openExternal}
    />
  );
}

function SshTunnelTool(props: RightDockToolRenderInput) {
  const { active } = props;
  const context = useRightDockToolContext();
  const { ssh } = context;
  return (
    <SshTunnelPanel
      active={active}
      cwd={context.cwd}
      projectPathKey={context.projectPathKey}
      hosts={ssh.hosts}
      associatedHostIds={ssh.associatedHostIds}
      client={context.clients.terminal}
      sessions={ssh.sessions}
      onSessionSnapshot={ssh.onSessionSnapshot}
      onSessionClosed={ssh.onSessionClosed}
      onSshSessionsReconcile={ssh.onSessionsReconcile}
      onOpenSession={(session, kind) => ssh.onOpenSession?.(session, kind)}
      onAssociatedHostIdsChange={(hostIds) => {
        ssh.onAssociatedHostIdsChange?.(hostIds);
      }}
    />
  );
}

function projectToolAvailable(context: RightDockToolContextValue) {
  return context.projectPathKey.trim() !== "";
}

/**
 * 远程工作空间侧栏：一个面板里同时给 Bash 与 SFTP。
 *
 * 会话与 SFTP 通道都从 dock context 取（`ssh` 组 + `clients.sftp`），因此它与
 * 【SSH 隧道】面板、dock 终端 tab 共用同一条 SSH 会话、同一份会话列表；`key` 绑
 * 项目身份串，切换项目即重挂（会话解析与「已 cd」标记都按项目算）。
 */
function RemoteWorkspaceTool(props: RightDockToolRenderInput) {
  const context = useRightDockToolContext();
  const target = context.capabilities.remoteWorkspaceTarget ?? null;
  const sftpClient = context.clients.sftp ?? null;
  if (!target || !sftpClient) {
    // 可用性判定已经把入口禁掉了；这里只是兜底：项目被换成非远程后旧 tab 仍在。
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
        {context.capabilities.remoteWorkspaceDisabledMessage ?? ""}
      </div>
    );
  }
  return (
    <RemoteWorkspacePanel
      key={context.projectPathKey}
      active={props.active}
      projectPathKey={context.projectPathKey}
      target={target}
      theme={context.theme}
      client={context.clients.terminal}
      sftpClient={sftpClient}
      hosts={context.ssh.hosts}
      sessions={context.ssh.sessions}
      onSessionSnapshot={context.ssh.onSessionSnapshot}
      onSessionClosed={context.ssh.onSessionClosed}
      onSessionsReconcile={context.ssh.onSessionsReconcile}
      onOpenFile={context.remoteWorkspace.onOpenFile}
      onAddTerminalSelectionToConversation={
        context.remoteWorkspace.onAddTerminalSelectionToConversation
      }
      splitRatio={context.remoteWorkspace.splitRatio}
      onSplitRatioCommit={context.remoteWorkspace.onSplitRatioCommit}
    />
  );
}

export const RIGHT_DOCK_TOOL_DEFINITIONS: readonly RightDockToolDefinition[] = [
  {
    kind: "fileTree",
    titleKey: "projectTools.fileTreeTitle",
    createTitleKey: "projectTools.newFileTree",
    descriptionKey: "projectTools.fileTreeDescription",
    closeKey: "projectTools.closeFileTree",
    projectRequired: true,
    icon: (className) => <FolderTree className={className} />,
    containerActiveClassName: "block",
    isAvailable: projectToolAvailable,
    render: (input) => <FileTreeTool active={input.active} />,
  },
  {
    kind: "gitReview",
    titleKey: "projectTools.gitReviewTitle",
    createTitleKey: "projectTools.newGitReview",
    descriptionKey: "projectTools.gitReviewDescription",
    closeKey: "projectTools.closeGitReview",
    projectRequired: true,
    icon: (className) => <GitBranch className={className} />,
    containerActiveClassName: "flex flex-col",
    isAvailable: projectToolAvailable,
    render: (input) => <GitReviewTool active={input.active} />,
  },
  {
    kind: "tunnel",
    titleKey: "projectTools.tunnelTitle",
    createTitleKey: "projectTools.newTunnel",
    descriptionKey: "projectTools.tunnelDescription",
    closeKey: "projectTools.closeTunnelTab",
    projectRequired: false,
    icon: (className) => <Globe className={className} />,
    containerActiveClassName: "flex flex-col",
    isAvailable: (context) => Boolean(context.clients.tunnel),
    render: (input) => <TunnelTool active={input.active} />,
  },
  {
    kind: "sshTunnel",
    titleKey: "projectTools.sshTunnelTitle",
    createTitleKey: "projectTools.newSshTunnel",
    descriptionKey: "projectTools.sshTunnelDescription",
    closeKey: "projectTools.closeSshTunnelTab",
    projectRequired: true,
    icon: (className) => <Key className={className} />,
    containerActiveClassName: "flex flex-col",
    isAvailable: projectToolAvailable,
    render: (input) => <SshTunnelTool active={input.active} />,
  },
  {
    kind: "remoteWorkspace",
    titleKey: "projectTools.remoteWorkspaceTitle",
    createTitleKey: "projectTools.newRemoteWorkspace",
    descriptionKey: "projectTools.remoteWorkspaceDescription",
    closeKey: "projectTools.closeRemoteWorkspace",
    // 与其它项目工具相反：它只在**远程**项目下可用（本地根缺失正是它的前提）。
    projectRequired: false,
    remoteRequired: true,
    icon: (className) => <Server className={className} />,
    containerActiveClassName: "flex flex-col",
    isAvailable: (context) =>
      Boolean(context.capabilities.remoteWorkspaceTarget && context.clients.sftp),
    render: (input) => <RemoteWorkspaceTool active={input.active} />,
  },
];

const RIGHT_DOCK_TOOL_DEFINITION_BY_KIND = new Map(
  RIGHT_DOCK_TOOL_DEFINITIONS.map((definition) => [definition.kind, definition]),
);

export function getRightDockToolDefinition(kind: RightDockSingletonTabKind) {
  return RIGHT_DOCK_TOOL_DEFINITION_BY_KIND.get(kind);
}
