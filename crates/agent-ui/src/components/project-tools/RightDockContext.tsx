// Shared context for right-dock tool panels. RightDockPanel assembles one
// memoized value per project scope; registry tool components and
// RightDockContent consume it instead of prop-drilling through the tree.

import type {
  RightDockFileTreeState,
  RightDockFileTreeStatePatch,
  SshHostConfig,
  WorkspaceRemoteRoot,
} from "@liveagent/app/lib/settings";
import type {
  GitCommitContextPayload,
  GitFileContextPayload,
} from "@liveagent/ui/components/project-tools/git-review/index";
import type { FileMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import type { GitClient } from "@liveagent/ui/lib/git/types";
import { createContext, useContext } from "react";
import type { ProjectToolTextGenerationClient } from "../../lib/ai/projectToolTextGeneration";
import type { SftpClient } from "../../lib/sftp/types";
import type { TerminalClient, TerminalSession, TerminalSnapshot } from "../../lib/terminal/types";
import type { WorkspaceActivityClient } from "../../lib/workspace-activity/types";
import type { SftpOpenFileRequest } from "../workspace-editor/WorkspaceSftpPanel";
import type { FileTreeExternalRoot } from "./file-tree/model";
import type { LocalTunnelClient } from "./LocalTunnelPanel";

export type RightDockToolClients = {
  terminal: TerminalClient;
  git?: GitClient | null;
  textGeneration?: ProjectToolTextGenerationClient | null;
  tunnel?: LocalTunnelClient | null;
  workspaceActivity?: WorkspaceActivityClient | null;
  /**
   * 远程工作空间侧栏的 SFTP 通道。与终端 client 一样由宿主注入（桌面端 Tauri、
   * WebUI 网关）；null/省略时该工具整体不可用，而不是渲染一个读不了目录的面板。
   */
  sftp?: SftpClient | null;
};

export type RightDockToolCapabilities = {
  projectReady: boolean;
  terminalReady: boolean;
  disabledMessage?: string;
  terminalDisabledMessage?: string;
  gitWriteEnabled: boolean;
  gitDisabledMessage?: string;
  tunnelEnabled: boolean;
  tunnelDisabledMessage?: string;
  tunnelPublicBaseUrl: string;
  /**
   * 活动项目的远程根（身份串 `ssh://<hostId>/<abs>` 的解析结果）。null/省略 =
   * 当前项目不是远程工作空间 → 远程工作空间侧栏不可用：它要靠 hostId 找/建
   * 那条 SSH 会话、靠 rootPath 给 Bash 定 cwd 并给 SFTP 定远端根。
   */
  remoteWorkspaceTarget?: WorkspaceRemoteRoot | null;
  remoteWorkspaceDisabledMessage?: string;
};

export type RightDockFileTreeContext = {
  state: RightDockFileTreeState;
  initialized: boolean;
  externalRoots: readonly FileTreeExternalRoot[];
  refreshExternalRoots: () => Promise<void>;
  onInitializedChange: (initialized: boolean) => void;
  onStateChange: (patch: RightDockFileTreeStatePatch) => void;
  onInsertFileMentions?: (references: readonly FileMentionReference[]) => void;
  onOpenFile?: (path: string, imagePaths?: string[]) => void;
  onRevealInFileTree: (path: string) => void;
};

// One-shot focus request from the chat layer (reply-footer changed-files
// card): switch GitReview to the changes view and select `path`'s diff.
// Consumers must call onFocusRequestHandled(nonce) after applying so the
// request never replays on a later panel remount.
export type GitReviewFocusRequest = {
  /** Empty string = just open the changes view without picking a file. */
  path: string;
  nonce: number;
};

export type RightDockGitContext = {
  onInsertCodeReviewSkill?: () => void;
  onInsertCommitMention?: (commit: GitCommitContextPayload) => void;
  onInsertGitFileMention?: (file: GitFileContextPayload) => void;
  focusRequest?: GitReviewFocusRequest | null;
  onFocusRequestHandled?: (nonce: number) => void;
  /** Desktop-only: generate a commit message from the staged diff. Absent on
   *  the web mirror (no direct model access), so the panel hides the button. */
  onGenerateCommitMessage?: () => Promise<{ title: string; body: string }>;
};

export type RightDockSshContext = {
  hosts: SshHostConfig[];
  associatedHostIds: string[];
  sessions: TerminalSession[];
  onOpenSession?: (session: TerminalSession, kind?: "bash" | "sftp") => void;
  onAssociatedHostIdsChange?: (hostIds: string[]) => void;
  onSessionSnapshot: (snapshot: TerminalSnapshot) => void;
  onSessionClosed: (sessionId: string) => void;
  onSessionsReconcile: (sessions: TerminalSession[]) => void;
};

/**
 * 远程工作空间侧栏的回调面。会话本身复用 `ssh` 组（同一条 SSH 会话既喂 Bash
 * 视口也喂 SFTP 通道），这里只补两个「往外走」的动作：打开远端文件、把终端
 * 选中内容插进会话输入框。
 */
export type RightDockRemoteWorkspaceContext = {
  /** Bash 区占面板高度的比例（持久化在 `tools.remoteWorkspace.uiState`）。 */
  splitRatio: number;
  /** 拖动/键盘调整结束时提交，避免拖动过程反复写设置。 */
  onSplitRatioCommit: (ratio: number) => void;
  onOpenFile?: (session: TerminalSession, request: SftpOpenFileRequest) => void;
  onAddTerminalSelectionToConversation?: (text: string) => void;
};

export type RightDockToolContextValue = {
  projectPathKey: string;
  cwd: string;
  theme: "light" | "dark";
  clients: RightDockToolClients;
  capabilities: RightDockToolCapabilities;
  fileTree: RightDockFileTreeContext;
  git: RightDockGitContext;
  ssh: RightDockSshContext;
  remoteWorkspace: RightDockRemoteWorkspaceContext;
  openExternal: (url: string) => void;
};

export const RightDockToolContext = createContext<RightDockToolContextValue | null>(null);

export function useRightDockToolContext(): RightDockToolContextValue {
  const value = useContext(RightDockToolContext);
  if (!value) {
    throw new Error("useRightDockToolContext must be used inside RightDockToolContext.Provider");
  }
  return value;
}
