import type { RemoteWorkspaceBrowseClient } from "@liveagent/ui/components/chat/WorkspaceRemoteFolderPicker";
import { tauriSftpClient } from "../lib/sftp/tauriSftpClient";
import { tauriTerminalClient } from "../lib/terminal/tauriTerminalClient";

/**
 * 宿主提供的「浏览 SSH 隧道内远程目录」适配器。
 *
 * SFTP 的远程接口同时要求 `project_path_key` 与本地锚点 `workdir`（后端
 * `ensure_session_allowed` / `workdir_for_session` 会校验会话归属），这两者都
 * 挂在会话记录上，所以一律从传入的 `session` 里取，调用方不需要自己拼。
 *
 * `connect` 必须带 `sftpEnabled: true`：选择器接下来就要列目录，没开 SFTP 的会话
 * 会被后端直接拒绝，用户会看到「连接成功但读不了目录」这种半成品状态。
 */
export const tauriRemoteWorkspaceBrowseClient: RemoteWorkspaceBrowseClient = {
  listSessions: () => tauriTerminalClient.list(),
  connect: ({ hostId, cwd, projectPathKey }) =>
    tauriTerminalClient.createSsh({ cwd, projectPathKey, hostId, sftpEnabled: true }),
  answerPrompt: ({ promptId, answer, trustHostKey }) =>
    tauriTerminalClient.answerSshPrompt({ promptId, answer, trustHostKey }),
  cancelPrompt: (promptId) => tauriTerminalClient.cancelSshPrompt(promptId),
  list: ({ session, path }) =>
    tauriSftpClient.list({
      sessionId: session.id,
      projectPathKey: session.projectPathKey,
      workdir: session.cwd,
      side: "remote",
      path,
    }),
  stat: ({ session, path }) =>
    tauriSftpClient.stat({
      sessionId: session.id,
      projectPathKey: session.projectPathKey,
      workdir: session.cwd,
      side: "remote",
      path,
    }),
};
