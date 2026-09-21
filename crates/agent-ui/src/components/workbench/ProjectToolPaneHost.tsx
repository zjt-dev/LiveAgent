import type {
  RightDockFileTreeState,
  RightDockFileTreeStatePatch,
  SshHostConfig,
  WorkspaceProject,
} from "@liveagent/app/lib/settings";
import { workspaceProjectPathKey } from "@liveagent/app/lib/settings";
import type { WorkspaceProjectRootClient } from "@liveagent/ui/contracts/workspaceProjectRoots";
import type { FileMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import { type CSSProperties, type ReactNode, useEffect, useMemo } from "react";
import { ensureManagedProcessInit } from "../../lib/managed-process/store";
import type { TerminalSession, TerminalSnapshot } from "../../lib/terminal/types";
import type { ProjectToolWorkbenchSurface } from "../../lib/workbench/types";
import { remoteWorkspaceRoot } from "../../lib/workspaceRemoteProject";
import { BackgroundTasksPanel } from "../project-tools/BackgroundTasksPanel";
import { FileTreePaneSurface } from "../project-tools/file-tree/index";
import { GitReviewPanel } from "../project-tools/git-review/index";
import { LocalTunnelPanel } from "../project-tools/LocalTunnelPanel";
import {
  type RightDockGitContext,
  type RightDockToolCapabilities,
  type RightDockToolClients,
  RightDockToolContext,
  type RightDockToolContextValue,
} from "../project-tools/RightDockContext";
import { getRightDockToolDefinition } from "../project-tools/rightDockRegistry";
import { SshTunnelPanel } from "../project-tools/SshTunnelPanel";
import type { SftpOpenFileRequest } from "../workspace-editor/WorkspaceSftpPanel";
import { UnsupportedPaneSurface } from "./surfaces/UnsupportedPaneSurface";

const NO_EXTERNAL_ROOTS: readonly never[] = [];
const noop = () => {};
const refreshNoop = async () => {};

export type ProjectToolPaneOpenFileRequest = {
  projectPathKey: string;
  workdir: string;
  path: string;
  imagePaths?: string[];
};

/**
 * Everything a project tool needs when it renders in a workbench pane instead
 * of the Right Dock. The page builds one memoized environment (the same
 * clients/callbacks it already hands the dock); the host resolves the pane's
 * own project from the surface and derives a `RightDockToolContext` from it,
 * so the tool panels run unchanged in both hosts.
 */
export type ProjectToolPaneEnvironment = {
  theme: "light" | "dark";
  /** Right-dock zone font scale; panes render tools at the dock's size. */
  fontScale?: number;
  workspaceProjects: readonly WorkspaceProject[];
  /**
   * The Right Dock's current project. Composer mention insertion and
   * git-review focus requests are page-level features that target this
   * project only; panes for other projects render without them.
   */
  activeProjectPathKey: string;
  clients: RightDockToolClients;
  capabilities: Pick<
    RightDockToolCapabilities,
    | "disabledMessage"
    | "terminalDisabledMessage"
    | "gitWriteEnabled"
    | "gitDisabledMessage"
    | "tunnelEnabled"
    | "tunnelDisabledMessage"
    | "tunnelPublicBaseUrl"
    | "remoteWorkspaceDisabledMessage"
  >;
  workspaceProjectRootClient?: WorkspaceProjectRootClient;
  workspaceRootRevision?: number;
  fileTree: {
    getState: (projectPathKey: string) => RightDockFileTreeState;
    onStateChange: (projectPathKey: string, patch: RightDockFileTreeStatePatch) => void;
    onInsertFileMentions?: (references: readonly FileMentionReference[]) => void;
    onOpenFile: (request: ProjectToolPaneOpenFileRequest) => void;
    /** Git review "reveal" → page-level file tree reveal (dock or pane). */
    onRevealInFileTree?: (projectPathKey: string, path: string) => void;
  };
  git: RightDockGitContext;
  /**
   * 远程工作空间侧栏在 Pane 里的持久化与回调：与 dock 用同一份 per-project 状态
   * （分割比例）和同一批宿主回调（打开远端文件、终端选中入会话输入框）。
   */
  remoteWorkspace: {
    getSplitRatio: (projectPathKey: string) => number;
    onSplitRatioCommit: (projectPathKey: string, ratio: number) => void;
    onOpenFile?: (session: TerminalSession, request: SftpOpenFileRequest) => void;
    onAddTerminalSelectionToConversation?: (text: string) => void;
  };
  ssh: {
    hosts: SshHostConfig[];
    getAssociatedHostIds: (projectPathKey: string) => string[];
    onAssociatedHostIdsChange?: (projectPathKey: string, hostIds: string[]) => void;
    /** Window-wide session list; the SSH panel filters its own kind. */
    sessions: TerminalSession[];
    onSessionSnapshot: (snapshot: TerminalSnapshot) => void;
    onSessionClosed: (sessionId: string) => void;
    onSessionsReconcile: (sessions: TerminalSession[]) => void;
    onOpenSession?: (session: TerminalSession, kind?: "bash" | "sftp") => void;
  };
  openExternal: (url: string) => void;
};

export type ProjectToolPaneHostProps = {
  paneId: string;
  surface: ProjectToolWorkbenchSurface;
  environment: ProjectToolPaneEnvironment;
};

function findWorkspaceProject(
  projects: readonly WorkspaceProject[],
  projectPathKey: string,
): WorkspaceProject | undefined {
  return projects.find((entry) => workspaceProjectPathKey(entry.path) === projectPathKey);
}

/**
 * Pane host for the singleton project tools (file tree, git review, tunnel,
 * SSH, background tasks). Layout only stores `{ kind, project }`; the host
 * resolves the live project and provides the dock tool context so the shared
 * panels render identically to their dock incarnation. A pane always counts
 * as `active` — nothing hides behind a tab here.
 */
export function ProjectToolPaneHost(props: ProjectToolPaneHostProps) {
  const { paneId, surface, environment } = props;
  const projectPathKey = surface.project.projectPathKey;
  const project = findWorkspaceProject(environment.workspaceProjects, projectPathKey);
  const cwd = project?.path ?? "";
  const isActiveProject = projectPathKey === environment.activeProjectPathKey;
  const { capabilities, clients, fileTree, git, remoteWorkspace, ssh, openExternal, theme } =
    environment;

  useEffect(() => {
    if (surface.kind !== "backgroundTasks") return;
    ensureManagedProcessInit().catch((error) => {
      console.error("managed process init failed", error);
    });
  }, [surface.kind]);

  const projectReady = Boolean(project) && !capabilities.disabledMessage;
  const terminalReady = projectReady && !capabilities.terminalDisabledMessage;
  // 远程工作空间侧栏只在项目是远程文件夹时可用（身份串能解析出 hostId + 远端根）。
  const remoteWorkspaceTarget = project ? remoteWorkspaceRoot(project) : null;

  const contextValue = useMemo<RightDockToolContextValue>(
    () => ({
      projectPathKey,
      cwd,
      theme,
      clients,
      capabilities: {
        ...capabilities,
        projectReady,
        terminalReady,
        remoteWorkspaceTarget,
      },
      fileTree: {
        state: fileTree.getState(projectPathKey),
        initialized: true,
        // The file tree pane fetches its own multi-root grants through
        // FileTreePaneSurface; other tools only need the reveal callback.
        externalRoots: NO_EXTERNAL_ROOTS,
        refreshExternalRoots: refreshNoop,
        onInitializedChange: noop,
        onStateChange: (patch) => fileTree.onStateChange(projectPathKey, patch),
        onInsertFileMentions: isActiveProject ? fileTree.onInsertFileMentions : undefined,
        onOpenFile: (path, imagePaths) =>
          fileTree.onOpenFile({ projectPathKey, workdir: cwd, path, imagePaths }),
        onRevealInFileTree: (path) => fileTree.onRevealInFileTree?.(projectPathKey, path),
      },
      // Composer insertion targets the Right Dock's current project only, so
      // every git → composer bridge is gated the same way as the file tree's
      // onInsertFileMentions; GitReviewPanel disables its buttons when absent.
      git: {
        ...git,
        onInsertCodeReviewSkill: isActiveProject ? git.onInsertCodeReviewSkill : undefined,
        onInsertCommitMention: isActiveProject ? git.onInsertCommitMention : undefined,
        onInsertGitFileMention: isActiveProject ? git.onInsertGitFileMention : undefined,
        focusRequest: isActiveProject ? git.focusRequest : null,
      },
      ssh: {
        hosts: ssh.hosts,
        associatedHostIds: ssh.getAssociatedHostIds(projectPathKey),
        sessions: ssh.sessions,
        onOpenSession: ssh.onOpenSession,
        onAssociatedHostIdsChange: ssh.onAssociatedHostIdsChange
          ? (hostIds) => ssh.onAssociatedHostIdsChange?.(projectPathKey, hostIds)
          : undefined,
        onSessionSnapshot: ssh.onSessionSnapshot,
        onSessionClosed: ssh.onSessionClosed,
        onSessionsReconcile: ssh.onSessionsReconcile,
      },
      remoteWorkspace: {
        splitRatio: remoteWorkspace.getSplitRatio(projectPathKey),
        onSplitRatioCommit: (ratio) => remoteWorkspace.onSplitRatioCommit(projectPathKey, ratio),
        onOpenFile: remoteWorkspace.onOpenFile,
        onAddTerminalSelectionToConversation: isActiveProject
          ? remoteWorkspace.onAddTerminalSelectionToConversation
          : undefined,
      },
      openExternal,
    }),
    [
      capabilities,
      clients,
      cwd,
      fileTree,
      git,
      isActiveProject,
      openExternal,
      projectPathKey,
      projectReady,
      remoteWorkspace,
      remoteWorkspaceTarget,
      ssh,
      terminalReady,
      theme,
    ],
  );

  const missingProject = !project;
  let body: ReactNode;
  switch (surface.kind) {
    case "fileTree":
      body = missingProject ? (
        <UnsupportedPaneSurface paneId={paneId} originalKind="fileTree:missing" />
      ) : (
        <FileTreePaneSurface
          active
          projectPathKey={projectPathKey}
          cwd={cwd}
          state={contextValue.fileTree.state}
          workspaceProject={project}
          workspaceProjectRootClient={environment.workspaceProjectRootClient}
          workspaceRootRevision={environment.workspaceRootRevision}
          workspaceActivityClient={clients.workspaceActivity ?? null}
          onStateChange={contextValue.fileTree.onStateChange}
          onInsertFileMentions={contextValue.fileTree.onInsertFileMentions}
          onOpenFile={contextValue.fileTree.onOpenFile}
        />
      );
      break;
    case "gitReview":
      body = missingProject ? (
        <UnsupportedPaneSurface paneId={paneId} originalKind="gitReview:missing" />
      ) : (
        <GitReviewPanel key={`${projectPathKey}:git-review`} active />
      );
      break;
    case "tunnel":
      body = (
        <LocalTunnelPanel
          active
          client={clients.tunnel ?? null}
          enabled={capabilities.tunnelEnabled}
          disabledMessage={capabilities.tunnelDisabledMessage}
          projectPathKey={project ? projectPathKey : undefined}
          publicBaseUrl={capabilities.tunnelPublicBaseUrl}
          onOpenExternal={openExternal}
        />
      );
      break;
    case "sshTunnel":
      body = missingProject ? (
        <UnsupportedPaneSurface paneId={paneId} originalKind="sshTunnel:missing" />
      ) : (
        <SshTunnelPanel
          active
          cwd={cwd}
          projectPathKey={projectPathKey}
          hosts={contextValue.ssh.hosts}
          associatedHostIds={contextValue.ssh.associatedHostIds}
          client={clients.terminal}
          sessions={contextValue.ssh.sessions}
          onSessionSnapshot={contextValue.ssh.onSessionSnapshot}
          onSessionClosed={contextValue.ssh.onSessionClosed}
          onSshSessionsReconcile={contextValue.ssh.onSessionsReconcile}
          onOpenSession={(session, kind) => contextValue.ssh.onOpenSession?.(session, kind)}
          onAssociatedHostIdsChange={(hostIds) => {
            contextValue.ssh.onAssociatedHostIdsChange?.(hostIds);
          }}
        />
      );
      break;
    case "backgroundTasks":
      body = <BackgroundTasksPanel active />;
      break;
    case "remoteWorkspace":
      // 复用 registry 里的同一个工具组件：它在 dock 与 Pane 里读同一份 context，
      // 所以两个宿主的行为（会话解析、连接流程、Bash/SFTP 协同）完全一致。
      body = missingProject ? (
        <UnsupportedPaneSurface paneId={paneId} originalKind="remoteWorkspace:missing" />
      ) : (
        (getRightDockToolDefinition("remoteWorkspace")?.render({ active: true }) ?? null)
      );
      break;
  }

  return (
    <RightDockToolContext.Provider value={contextValue}>
      <div
        data-workbench-pane-id={paneId}
        data-workbench-surface={surface.kind}
        className="zone-font-scale flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        style={{ "--zone-font-scale": environment.fontScale ?? 1 } as CSSProperties}
      >
        {body}
      </div>
    </RightDockToolContext.Provider>
  );
}
