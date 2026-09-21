import type { RemoteWorkspaceBrowseClient } from "@liveagent/ui/components/chat/WorkspaceRemoteFolderPicker";
import type { SftpClient } from "@liveagent/ui/lib/sftp/types";
import type { TerminalClient } from "@liveagent/ui/lib/terminal/types";

/**
 * WebUI 侧的「浏览 SSH 隧道内远程目录」适配器。与桌面端的
 * `tauriRemoteWorkspaceBrowseClient` 共用同一套 `TerminalClient` / `SftpClient`
 * 接口，差别只在底层传输（网关 WebSocket 而非 Tauri IPC）。
 *
 * `projectPathKey` 与 `workdir` 必须取自会话记录：网关侧同样会校验 SFTP 会话
 * 是否属于该项目，调用方自己拼容易拼错。
 *
 * `connect` 必须带 `sftpEnabled: true`，理由同桌面端。
 */
export function createGatewayRemoteWorkspaceBrowseClient(
  terminalClient: TerminalClient,
  sftpClient: SftpClient,
): RemoteWorkspaceBrowseClient {
  return {
    listSessions: () => terminalClient.list(),
    connect: ({ hostId, cwd, projectPathKey }) =>
      terminalClient.createSsh({ cwd, projectPathKey, hostId, sftpEnabled: true }),
    answerPrompt: ({ promptId, answer, trustHostKey }) =>
      terminalClient.answerSshPrompt({ promptId, answer, trustHostKey }),
    cancelPrompt: (promptId) => terminalClient.cancelSshPrompt(promptId),
    list: ({ session, path }) =>
      sftpClient.list({
        sessionId: session.id,
        projectPathKey: session.projectPathKey,
        workdir: session.cwd,
        side: "remote",
        path,
      }),
    stat: ({ session, path }) =>
      sftpClient.stat({
        sessionId: session.id,
        projectPathKey: session.projectPathKey,
        workdir: session.cwd,
        side: "remote",
        path,
      }),
  };
}
