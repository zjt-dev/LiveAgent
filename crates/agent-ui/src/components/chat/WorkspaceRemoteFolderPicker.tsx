import {
  AlertTriangle,
  ChevronRight,
  Folder,
  FolderOpen,
  Link2,
  Loader2,
  RefreshCw,
  Server,
  Shield,
  Terminal,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Label } from "@liveagent/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { SshHostConfig } from "@liveagent/ui/lib/settings/types";
import type { SftpEntry, SftpListResponse, SftpStatResponse } from "@liveagent/ui/lib/sftp/types";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type {
  TerminalSession,
  TerminalSshCreateResult,
  TerminalSshPrompt,
} from "@liveagent/ui/lib/terminal/types";
import {
  classifyRemoteWorkspaceError,
  isRemoteWorkspaceSessionUsable,
  type RemoteWorkspaceErrorCode,
  remoteDirectoryBreadcrumbs,
  remoteDirectoryListingPath,
  remoteDirectoryParentPath,
  remoteWorkspaceDirectoryCheck,
  remoteWorkspaceDirectoryEntries,
  remoteWorkspaceErrorI18nKey,
  remoteWorkspaceHostOptions,
  resolveRemoteDirectoryPath,
} from "@liveagent/ui/lib/workspaceRemoteProject";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * 远程目录浏览所需的最小客户端面。宿主（桌面端 / WebUI）用终端与 SFTP 客户端实现；
 * 测试可以注入假实现而不碰 Tauri / 网关。
 */
export type RemoteWorkspaceBrowseClient = {
  /** 当前所有终端会话，用来判断某条隧道是否已经连上、以及确认时复核会话仍然活着。 */
  listSessions: () => Promise<TerminalSession[]>;
  /**
   * 建立到该主机的 SSH 连接。必须开 SFTP，否则后续列目录会被后端
   * `ensure_session_allowed` 拒绝。
   *
   * `cwd` / `projectPathKey` 是会话的本地锚点与归属：SFTP 的远程接口会校验会话
   * 是否属于该项目，二者必须与之后 `list` / `stat` 用的是同一套。
   */
  connect: (params: {
    hostId: string;
    cwd: string;
    projectPathKey: string;
  }) => Promise<TerminalSshCreateResult>;
  /** 回答连接过程中的待决提示（信任主机密钥 / 输入认证口令）。 */
  answerPrompt: (params: {
    promptId: string;
    answer?: string;
    trustHostKey?: boolean;
  }) => Promise<TerminalSshCreateResult>;
  /** 用户放弃回答时释放后端待决的提示，避免连接悬在那里。 */
  cancelPrompt: (promptId: string) => Promise<void>;
  list: (params: { session: TerminalSession; path: string }) => Promise<SftpListResponse>;
  stat: (params: { session: TerminalSession; path: string }) => Promise<SftpStatResponse>;
};

export type RemoteWorkspaceSelection = {
  sessionId: string;
  hostId: string;
  hostName: string;
  rootPath: string;
};

type WorkspaceRemoteFolderPickerProps = {
  client: RemoteWorkspaceBrowseClient;
  /** 【SSH 隧道】设置里已添加的全部主机，无论当前是否已连接。 */
  hosts: SshHostConfig[];
  /** 建立会话时的本地锚点。远程身份串不是本地路径，调用方要保证传本地目录。 */
  cwd: string;
  /** 会话归属的项目标识，与【SSH 隧道】面板保持同一口径。 */
  projectPathKey: string;
  onConfirm: (selection: RemoteWorkspaceSelection) => Promise<void>;
  onOpenSshTunnelPanel?: () => void;
  onClose: () => void;
};

type PickerError = {
  code: RemoteWorkspaceErrorCode;
  detail: string;
};

// SFTP 语义下 `.` 就是登录用户的家目录；首帧用它起手，list 回来后会换成真实绝对路径。
const INITIAL_REMOTE_PATH = ".";

function toPickerError(error: unknown): PickerError {
  return {
    code: classifyRemoteWorkspaceError(error),
    detail: error instanceof Error ? error.message.trim() : String(error ?? "").trim(),
  };
}

export function WorkspaceRemoteFolderPicker({
  client,
  hosts,
  cwd,
  projectPathKey,
  onConfirm,
  onOpenSshTunnelPanel,
  onClose,
}: WorkspaceRemoteFolderPickerProps) {
  const { t } = useLocale();
  const [sessions, setSessions] = useState<TerminalSession[] | null>(null);
  const [sessionsError, setSessionsError] = useState<PickerError | null>(null);
  const [selectedHostId, setSelectedHostId] = useState("");
  const [connectingHostId, setConnectingHostId] = useState("");
  const [connectError, setConnectError] = useState<PickerError | null>(null);
  const [prompt, setPrompt] = useState<TerminalSshPrompt | null>(null);
  const [promptAnswer, setPromptAnswer] = useState("");
  const [path, setPath] = useState(INITIAL_REMOTE_PATH);
  const [manualPath, setManualPath] = useState(INITIAL_REMOTE_PATH);
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<PickerError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<PickerError | null>(null);
  const listRequestId = useRef(0);

  const hostOptions = useMemo(
    () => remoteWorkspaceHostOptions(hosts, sessions ?? []),
    [hosts, sessions],
  );
  const selectedHost =
    hostOptions.find((option) => option.hostId === selectedHostId) ?? hostOptions[0] ?? null;
  // 该隧道当前可用于浏览的会话：已经连着的，或刚连上被并入 sessions 的那条。
  const activeSession = useMemo(() => {
    if (!selectedHost?.sessionId) return null;
    return (sessions ?? []).find((session) => session.id === selectedHost.sessionId) ?? null;
  }, [selectedHost, sessions]);

  const refreshSessions = useCallback(async () => {
    setSessions(null);
    setSessionsError(null);
    try {
      setSessions(await client.listSessions());
    } catch (error) {
      setSessions([]);
      setSessionsError(toPickerError(error));
    }
  }, [client]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // 默认选中第一条隧道：列表为空时不设，让空态顶上来。
  useEffect(() => {
    if (selectedHostId || hostOptions.length === 0) return;
    setSelectedHostId(hostOptions[0].hostId);
  }, [hostOptions, selectedHostId]);

  /**
   * 把刚连上的会话并入 `sessions` 而不是重新拉一次列表：重拉会把 `sessions` 置回
   * null 触发整屏 loading，而这里只多了一条会话。并入后 `hostOptions` 会重算出
   * `sessionId`，浏览区自然就接上了。
   */
  const adoptSession = useCallback((session: TerminalSession) => {
    setSessions((prev) => [...(prev ?? []).filter((item) => item.id !== session.id), session]);
    // 连接已经成功了，之前那次「读不到会话列表」的报错就没有意义了。
    setSessionsError(null);
  }, []);

  const browse = useCallback(
    async (session: TerminalSession, targetPath: string) => {
      const requestId = ++listRequestId.current;
      setListing(true);
      setListError(null);
      setSubmitError(null);
      try {
        const response = await client.list({ session, path: targetPath });
        if (requestId !== listRequestId.current) return;
        const resolved = remoteDirectoryListingPath(targetPath, response);
        setEntries(remoteWorkspaceDirectoryEntries(response.entries));
        setPath(resolved);
        setManualPath(resolved);
      } catch (error) {
        if (requestId !== listRequestId.current) return;
        // 列目录失败时保留当前路径，让用户能改路径或重试，而不是把界面清空。
        setEntries([]);
        setListError(toPickerError(error));
      } finally {
        if (requestId === listRequestId.current) setListing(false);
      }
    },
    [client],
  );

  // 换隧道（或刚连上）后回到该隧道的家目录重新起手：不同主机的同名路径没有可比性。
  useEffect(() => {
    if (!activeSession) {
      setEntries([]);
      setPath(INITIAL_REMOTE_PATH);
      setManualPath(INITIAL_REMOTE_PATH);
      return;
    }
    setPath(INITIAL_REMOTE_PATH);
    setManualPath(INITIAL_REMOTE_PATH);
    setEntries([]);
    void browse(activeSession, INITIAL_REMOTE_PATH);
  }, [activeSession, browse]);

  /** 消费一次 `createSsh` / `answerSshPrompt` 的结果：拿到会话就并入，拿到提示就继续问。 */
  const consumeConnectResult = useCallback(
    (result: TerminalSshCreateResult) => {
      if (result.prompt) {
        setPrompt(result.prompt);
        setPromptAnswer("");
        return;
      }
      setPrompt(null);
      setPromptAnswer("");
      if (result.snapshot) {
        adoptSession(result.snapshot.session);
        return;
      }
      throw new Error("SSH connect did not return a session");
    },
    [adoptSession],
  );

  const connectHost = useCallback(
    async (hostId: string) => {
      if (!hostId || connectingHostId) return;
      setConnectingHostId(hostId);
      setConnectError(null);
      try {
        consumeConnectResult(await client.connect({ hostId, cwd, projectPathKey }));
      } catch (error) {
        setConnectError(toPickerError(error));
      } finally {
        setConnectingHostId("");
      }
    },
    [client, connectingHostId, consumeConnectResult, cwd, projectPathKey],
  );

  const submitPrompt = useCallback(
    async (payload: { answer?: string; trustHostKey?: boolean }) => {
      if (!prompt || connectingHostId) return;
      const current = prompt;
      setConnectingHostId(current.hostId);
      setConnectError(null);
      try {
        consumeConnectResult(
          await client.answerPrompt({
            promptId: current.id,
            answer: payload.trustHostKey ? undefined : payload.answer,
            trustHostKey: payload.trustHostKey,
          }),
        );
      } catch (error) {
        setPrompt(null);
        setConnectError(toPickerError(error));
      } finally {
        setConnectingHostId("");
      }
    },
    [client, connectingHostId, consumeConnectResult, prompt],
  );

  const abandonPrompt = useCallback(async () => {
    const current = prompt;
    setPrompt(null);
    setPromptAnswer("");
    if (!current) return;
    // 后端可能已经把这轮连接收掉了，取消失败不是用户需要处理的问题。
    try {
      await client.cancelPrompt(current.id);
    } catch {
      // ignore
    }
  }, [client, prompt]);

  const parentPath = remoteDirectoryParentPath(path);
  const breadcrumbs = useMemo(() => remoteDirectoryBreadcrumbs(path), [path]);

  async function goTo(targetPath: string) {
    if (!activeSession || listing) return;
    const resolved = resolveRemoteDirectoryPath(path, targetPath);
    await browse(activeSession, resolved);
  }

  async function confirmSelection() {
    if (!activeSession || submitting) return;
    const ssh = activeSession.ssh;
    if (!ssh) return;
    // `path` 已经过 list 的 canonicalize（或手动输入后归一化），直接用；
    // 不要拿它对自己再 resolve 一次，相对路径会变成 `a/b/a/b`。
    const rootPath = path;
    if (rootPath === ".") return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // 会话可能在浏览过程中断开；落盘前再验一次，避免存下一个指向死连接的根目录。
      const liveSessions = await client.listSessions();
      const live = liveSessions.find((session) => session.id === activeSession.id);
      if (!live || !isRemoteWorkspaceSessionUsable(live)) {
        throw new Error("SSH session is not connected");
      }
      const stat = await client.stat({ session: live, path: rootPath });
      const check = remoteWorkspaceDirectoryCheck(stat);
      if (check) throw new Error(check === "not-found" ? "no such file" : "not a directory");
      await onConfirm({
        sessionId: live.id,
        hostId: ssh.hostId,
        hostName: ssh.hostName,
        rootPath,
      });
      onClose();
    } catch (error) {
      setSubmitError(toPickerError(error));
    } finally {
      setSubmitting(false);
    }
  }

  const canConfirm = Boolean(activeSession && path !== "." && !listing && !submitting);
  const sessionsLoading = sessions === null;
  const hostKeyPrompt = prompt?.kind === "hostKey";
  const canSubmitPrompt = Boolean(prompt) && (hostKeyPrompt || promptAnswer.trim().length > 0);
  const busy = Boolean(connectingHostId) || submitting;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] max-w-2xl flex-col p-0"
        closeDisabled={busy}
        closeLabel={t("settings.cancel")}
        showCloseButton
      >
        <DialogHeader className="flex-row items-center gap-3 px-6 py-5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-muted/50 text-muted-foreground shadow-xs">
            <Server className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-base leading-normal">
              {t("chat.workspaceRemotePickerTitle")}
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-xs leading-relaxed">
              {t("chat.workspaceRemotePickerDescription")}
            </DialogDescription>
          </div>
        </DialogHeader>

        <DialogBody className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-5">
          {sessionsLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("chat.workspaceRemoteHostsLoading")}
            </div>
          ) : null}

          {!sessionsLoading && hostOptions.length === 0 ? (
            sessionsError ? (
              <RemotePickerErrorPanel
                error={sessionsError}
                onRetry={() => void refreshSessions()}
                t={t}
              />
            ) : (
              <div className="space-y-3 rounded-2xl border border-border/60 bg-muted/20 p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold">
                      {t("chat.workspaceRemoteNoHostsTitle")}
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {t("chat.workspaceRemoteNoHostsDescription")}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  {onOpenSshTunnelPanel ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        onOpenSshTunnelPanel();
                        onClose();
                      }}
                    >
                      <Terminal className="h-4 w-4" />
                      {t("chat.workspaceRemoteOpenTunnelPanel")}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void refreshSessions()}
                  >
                    <RefreshCw className="h-4 w-4" />
                    {t("chat.workspaceRemoteRetry")}
                  </Button>
                </div>
              </div>
            )
          ) : null}

          {!sessionsLoading && hostOptions.length > 0 ? (
            <>
              {/* 隧道列表本身不依赖会话：读会话失败只降级成「连接状态未知」，
                  不能让用户连隧道都选不了。 */}
              {sessionsError ? (
                <RemotePickerErrorPanel
                  error={sessionsError}
                  onRetry={() => void refreshSessions()}
                  t={t}
                />
              ) : null}

              <div className="space-y-1.5">
                <Label htmlFor="workspace-remote-tunnel">{t("chat.workspaceRemoteTunnel")}</Label>
                <Select
                  value={selectedHost?.hostId ?? null}
                  onValueChange={(value) => {
                    setSelectedHostId(value);
                    setConnectError(null);
                  }}
                  // 有待决提示时不允许换隧道：回答会被送回到原来那条主机上，而界面
                  // 已经切到另一条，连上的会话就再也显示不出来了。
                  disabled={busy || prompt !== null}
                >
                  <SelectTrigger id="workspace-remote-tunnel" className="h-10">
                    <SelectValue placeholder={t("chat.workspaceRemoteTunnelPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent className="max-h-60 w-[26rem] max-w-[calc(100vw-2rem)]">
                    {hostOptions.map((option) => (
                      <SelectItem key={option.hostId} value={option.hostId}>
                        {option.connected
                          ? `${option.name} · ${t("chat.workspaceRemoteConnected")}`
                          : option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedHost ? (
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {selectedHost.endpoint}
                  </p>
                ) : null}
              </div>

              {prompt ? (
                <div className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-3">
                  <div className="flex items-start gap-2.5">
                    <Shield className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold">
                        {hostKeyPrompt
                          ? t("chat.workspaceRemotePromptHostKeyTitle")
                          : t("chat.workspaceRemotePromptAuthTitle")}
                      </h3>
                      <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
                        {prompt.message}
                      </p>
                      {prompt.fingerprintSha256 ? (
                        <p className="mt-1.5 break-all font-mono text-[11px] text-muted-foreground">
                          {prompt.fingerprintSha256}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {!hostKeyPrompt ? (
                    <Input
                      className="h-10 text-xs"
                      type={prompt.answerEcho ? "text" : "password"}
                      value={promptAnswer}
                      onChange={(event) => setPromptAnswer(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        if (canSubmitPrompt) void submitPrompt({ answer: promptAnswer });
                      }}
                      aria-label={t("chat.workspaceRemotePromptAuthTitle")}
                      autoFocus
                      autoComplete="off"
                    />
                  ) : null}
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={!canSubmitPrompt || Boolean(connectingHostId)}
                      onClick={() =>
                        void (hostKeyPrompt
                          ? submitPrompt({ trustHostKey: true })
                          : submitPrompt({ answer: promptAnswer }))
                      }
                    >
                      {connectingHostId ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Shield className="h-4 w-4" />
                      )}
                      {hostKeyPrompt
                        ? t("chat.workspaceRemotePromptTrust")
                        : t("chat.workspaceRemotePromptSubmit")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={Boolean(connectingHostId)}
                      onClick={() => void abandonPrompt()}
                    >
                      {t("chat.workspaceRemotePromptCancel")}
                    </Button>
                  </div>
                </div>
              ) : null}

              {!prompt && !activeSession ? (
                <div className="space-y-3 rounded-2xl border border-border/60 bg-muted/20 p-4">
                  <div className="flex items-start gap-3">
                    <Link2 className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold">
                        {t("chat.workspaceRemoteConnectRequiredTitle")}
                      </h3>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {t("chat.workspaceRemoteConnectRequiredDescription")}
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!selectedHost || Boolean(connectingHostId)}
                    onClick={() => {
                      if (selectedHost) void connectHost(selectedHost.hostId);
                    }}
                  >
                    {connectingHostId ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Link2 className="h-4 w-4" />
                    )}
                    {connectingHostId
                      ? t("chat.workspaceRemoteConnecting")
                      : t("chat.workspaceRemoteConnect")}
                  </Button>
                </div>
              ) : null}

              {connectError ? (
                <RemotePickerErrorPanel
                  error={connectError}
                  onRetry={
                    selectedHost
                      ? () => {
                          void connectHost(selectedHost.hostId);
                        }
                      : undefined
                  }
                  t={t}
                />
              ) : null}

              {activeSession ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="workspace-remote-path">
                      {t("chat.workspaceRemotePathLabel")}
                    </Label>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={t("chat.workspaceRemoteUp")}
                        disabled={!parentPath || listing || submitting}
                        onClick={() => {
                          if (parentPath) void goTo(parentPath);
                        }}
                      >
                        <ChevronRight className="h-4 w-4 -rotate-90" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={t("chat.workspaceRemoteRefresh")}
                        disabled={listing || submitting}
                        onClick={() => void goTo(path)}
                      >
                        <RefreshCw className={cn("h-4 w-4", listing && "animate-spin")} />
                      </Button>
                      <Input
                        id="workspace-remote-path"
                        className="h-10 flex-1 font-mono text-xs"
                        value={manualPath}
                        onChange={(event) => setManualPath(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          void goTo(manualPath);
                        }}
                        placeholder={t("chat.workspaceRemotePathPlaceholder")}
                        autoComplete="off"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={listing || submitting || !manualPath.trim()}
                        onClick={() => void goTo(manualPath)}
                      >
                        {t("chat.workspaceRemoteGo")}
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      {breadcrumbs.map((crumb, index) => (
                        <span key={crumb.path} className="flex items-center gap-1">
                          {index > 0 ? <ChevronRight className="h-3 w-3" /> : null}
                          <button
                            type="button"
                            className="max-w-[12rem] truncate rounded px-1 py-0.5 hover:bg-muted hover:text-foreground disabled:opacity-60"
                            disabled={listing || submitting}
                            onClick={() => void goTo(crumb.path)}
                          >
                            {crumb.label}
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="min-h-40 flex-1 overflow-y-auto rounded-xl border border-border/60 bg-muted/10 p-1">
                    {listing ? (
                      <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {t("chat.workspaceRemoteLoading")}
                      </div>
                    ) : null}
                    {!listing && listError ? (
                      <RemotePickerErrorPanel
                        error={listError}
                        onRetry={() => void goTo(path)}
                        t={t}
                      />
                    ) : null}
                    {!listing && !listError && entries.length === 0 ? (
                      <div className="px-3 py-4 text-xs text-muted-foreground">
                        {t("chat.workspaceRemoteEmptyDir")}
                      </div>
                    ) : null}
                    {!listing && !listError
                      ? entries.map((entry) => (
                          <button
                            key={entry.path}
                            type="button"
                            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
                            disabled={submitting}
                            onClick={() => void goTo(entry.path)}
                          >
                            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                          </button>
                        ))
                      : null}
                  </div>

                  <div className="flex items-start gap-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-xs">
                    <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0 break-all text-muted-foreground">
                      {t("chat.workspaceRemoteSelectedPath")}
                      <span className="ml-1 font-mono text-foreground">{path}</span>
                    </span>
                  </div>

                  {submitError ? <RemotePickerErrorPanel error={submitError} t={t} /> : null}
                </>
              ) : null}
            </>
          ) : null}
        </DialogBody>

        <DialogActions className="border-t border-border/60 px-6 py-4">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("settings.cancel")}
          </Button>
          <Button onClick={() => void confirmSelection()} disabled={!canConfirm}>
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Folder className="h-4 w-4" />
            )}
            {t("chat.workspaceRemoteSelect")}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

function RemotePickerErrorPanel({
  error,
  onRetry,
  t,
}: {
  error: PickerError;
  onRetry?: () => void;
  t: (key: string) => string;
}) {
  return (
    <div className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5">
      <div className="flex items-start gap-2 text-xs text-destructive">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 break-all">
          {t(remoteWorkspaceErrorI18nKey(error.code))}
          {/* 兜底分类拿不到针对性文案时把原始报错带上，否则用户无从下手。 */}
          {error.code === "unknown" && error.detail ? ` (${error.detail})` : null}
        </span>
      </div>
      {onRetry ? (
        <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
          <RefreshCw className="h-3.5 w-3.5" />
          {t("chat.workspaceRemoteRetry")}
        </Button>
      ) : null}
    </div>
  );
}
