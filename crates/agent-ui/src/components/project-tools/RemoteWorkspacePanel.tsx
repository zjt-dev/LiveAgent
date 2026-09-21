import type { SshHostConfig, WorkspaceRemoteRoot } from "@liveagent/app/lib/settings";
import { AlertTriangle, Loader2, RefreshCw, Server } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { SftpClient } from "@liveagent/ui/lib/sftp/types";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  sshSessionEndpointLabel,
  sshSessionStatus,
} from "@liveagent/ui/lib/terminal/sshSessionStatus";
import type {
  TerminalClient,
  TerminalSession,
  TerminalSnapshot,
  TerminalSshPrompt,
} from "@liveagent/ui/lib/terminal/types";
import {
  findUsableSessionForHost,
  isRemoteWorkspaceSessionUsable,
  remoteWorkspaceShellCdCommand,
} from "@liveagent/ui/lib/workspaceRemoteProject";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SftpOpenFileRequest } from "../workspace-editor/WorkspaceSftpPanel";
import {
  clampRemoteWorkspaceSplitRatio,
  MAX_REMOTE_WORKSPACE_SPLIT_RATIO,
  MIN_REMOTE_WORKSPACE_SPLIT_RATIO,
} from "./rightDockModel";
import { XTermViewport } from "./XTermViewport";

// SFTP 面板懒加载：它自带完整的双栏浏览器与传输队列，和 SSH overlay 一样不该被
// dock 的初始 chunk 拖进来（两边共用同一份实现）。
const WorkspaceSftpPanel = lazy(async () => {
  const module = await import("../workspace-editor/WorkspaceSftpPanel");
  return { default: module.WorkspaceSftpPanel };
});

export type RemoteWorkspacePanelProps = {
  /** 该工具是不是当前可见的 dock tab / Pane；非活跃时不挂 Bash 视口。 */
  active: boolean;
  /** 项目身份串（`ssh://…`）：会话归属、终端分组都用它，不是本地路径。 */
  projectPathKey: string;
  /** 活动项目的远程根：Bash 的起始目录 + SFTP 的远端根。 */
  target: WorkspaceRemoteRoot;
  theme: "light" | "dark";
  client: TerminalClient;
  sftpClient: SftpClient;
  /** 【SSH 隧道】里已添加的主机，用来解析端点标签与缺失主机提示。 */
  hosts: SshHostConfig[];
  /** 当前所有 SSH 会话：面板只关心本项目主机上的那几条。 */
  sessions: TerminalSession[];
  onSessionSnapshot: (snapshot: TerminalSnapshot) => void;
  onSessionClosed: (sessionId: string) => void;
  onSessionsReconcile: (sessions: TerminalSession[]) => void;
  onOpenFile?: (session: TerminalSession, request: SftpOpenFileRequest) => void;
  onAddTerminalSelectionToConversation?: (text: string) => void;
  /** Bash 区占面板高度的比例（持久化值）。 */
  splitRatio: number;
  /** 拖动/键盘调整结束时才提交，避免拖动过程反复写设置。 */
  onSplitRatioCommit: (ratio: number) => void;
};

const SPLITTER_KEYBOARD_STEP = 0.02;
const SPLITTER_KEYBOARD_STEP_LARGE = 0.1;

/**
 * 已经发过 `cd <远端根>` 的 (会话, 远端根) 组合。
 *
 * 刻意放在模块级而不是组件里：dock 与工作台是两个面板实例，把工具拖到工作台时 dock
 * 卸载、工作台新挂 —— 实例级记账会把它当新会话再发一次，把用户手动 cd 到的目录拽回
 * 远端根。按「会话 + 远端根」记账：换项目（= 换远端根）会重新发，重挂不会。
 */
const remoteWorkspaceCdSentKeys = new Set<string>();

function remoteWorkspaceCdKey(sessionId: string, rootPath: string) {
  return `${sessionId}\u0000${rootPath}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isTerminalSessionNotFoundError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return message.includes("terminal session not found") || message.includes("session not found");
}

function hostEndpointLabel(host: SshHostConfig | undefined, fallbackHostId: string) {
  if (!host) return fallbackHostId;
  const userPrefix = host.username.trim() ? `${host.username.trim()}@` : "";
  return `${userPrefix}${host.host.trim() || fallbackHostId}:${host.port || 22}`;
}

/**
 * 远程工作空间侧栏：在当前远程文件夹上同时给一个 Bash 交互终端和一个 SFTP 文件
 * 管理器，二者绑定**同一条 SSH 会话**、同一个远端根。
 *
 * 与现有面板的关系：
 * - Bash 区是 `XTermViewport`（与 dock 终端、SSH overlay 同一个视口实现）；
 * - SFTP 区是 `WorkspaceSftpPanel`（与 SSH overlay 的 SFTP tab 同一个面板），只
 *   多了两个可选参数：`initialRemotePath`（远端根）与 `showLocalPane={false}`
 *   （远程工作空间没有本地根，本地栏只会显示空目录）；
 * - 连接、主机密钥/认证提示、错误呈现沿用【SSH 隧道】面板与远程文件夹选择器那套
 *   `createSsh` / `answerSshPrompt` 流程，不另造一套。
 *
 * 会话所有权：面板只复用或创建会话，创建成功后通过 `onSessionSnapshot` 把会话并进
 * 页面级会话列表 —— 与 SSH 隧道面板完全一致，因此 dock 的终端 tab、工作台 Pane 与
 * 其它项目视图都能立刻看到它。
 */
export function RemoteWorkspacePanel(props: RemoteWorkspacePanelProps) {
  const {
    active,
    projectPathKey,
    target,
    theme,
    client,
    sftpClient,
    hosts,
    sessions,
    onSessionSnapshot,
    onSessionClosed,
    onSessionsReconcile,
    onOpenFile,
    onAddTerminalSelectionToConversation,
    splitRatio,
    onSplitRatioCommit,
  } = props;
  const { t } = useLocale();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<TerminalSshPrompt | null>(null);
  const [promptAnswer, setPromptAnswer] = useState("");
  const [answeringPrompt, setAnsweringPrompt] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [ratio, setRatio] = useState(() => clampRemoteWorkspaceSplitRatio(splitRatio));
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const splitterDragPointerRef = useRef<number | null>(null);
  const [draggingSplitter, setDraggingSplitter] = useState(false);

  const host = useMemo(
    () => hosts.find((entry) => entry.id.trim() === target.hostId.trim()),
    [hosts, target.hostId],
  );
  const hostSessions = useMemo(
    () => sessions.filter((entry) => entry.kind === "ssh" && entry.ssh?.hostId === target.hostId),
    [sessions, target.hostId],
  );
  // 同主机可能有多条会话：优先本项目那条，其次任意一条可用于 SFTP 的。
  const session = useMemo(() => {
    const own = hostSessions.find(
      (entry) => entry.projectPathKey === projectPathKey && isRemoteWorkspaceSessionUsable(entry),
    );
    return own ?? findUsableSessionForHost(sessions, target.hostId);
  }, [hostSessions, projectPathKey, sessions, target.hostId]);
  const reattachableSession = useMemo(
    () =>
      hostSessions.find((entry) => entry.running && sshSessionStatus(entry) === "disconnected") ??
      null,
    [hostSessions],
  );
  const endpoint = session
    ? sshSessionEndpointLabel(session)
    : hostEndpointLabel(host, target.hostId);
  const cdCommand = useMemo(
    () => remoteWorkspaceShellCdCommand(target.rootPath),
    [target.rootPath],
  );
  // 每条 (会话, 远端根) 只发一次 `cd <远端根>`：视口会随 tab 切换重挂（`initialInput`
  // 会重新武装），重发会把用户手动 cd 到的目录拽回远端根。模块级集合让 dock 与工作台
  // 两个实例共享同一份记账，租借转移不再重发。
  const cdKey = session && cdCommand ? remoteWorkspaceCdKey(session.id, target.rootPath) : "";
  const initialInput =
    cdKey && !remoteWorkspaceCdSentKeys.has(cdKey) ? `${cdCommand}\n` : undefined;
  // 重连是**新 shell**（起始目录=家目录），必须把锚点补回去，否则 Bash 停在家目录而
  // SFTP 还在远端根。会话 id 不变，所以只能由视口在 reconnected 事件上重发。
  const reconnectInput = cdCommand ? `${cdCommand}\n` : undefined;

  // 标记「已发过 cd」的时机必须是视口真的挂上了（active），否则 tab 只是被打开但
  // 不是当前活跃 tab 时会白白消费掉这次机会，切回来就再也不会 cd 到远端根。
  useEffect(() => {
    if (!active || !cdKey || !initialInput) return;
    remoteWorkspaceCdSentKeys.add(cdKey);
  }, [active, cdKey, initialInput]);

  // 跨端/跨窗口同步：持久化值被别处改过（另一台设备拖过、设置被合并）而本地没有
  // 正在进行的拖动时跟进；本地提交后 prop 会等于本地值，因此这里是幂等的。
  useEffect(() => {
    if (draggingSplitter) return;
    setRatio(clampRemoteWorkspaceSplitRatio(splitRatio));
  }, [draggingSplitter, splitRatio]);

  const consumeConnectResult = useCallback(
    (result: { snapshot?: TerminalSnapshot; prompt?: TerminalSshPrompt }) => {
      if (result.prompt) {
        setPrompt(result.prompt);
        setPromptAnswer("");
        return;
      }
      setPrompt(null);
      setPromptAnswer("");
      if (result.snapshot) onSessionSnapshot(result.snapshot);
    },
    [onSessionSnapshot],
  );

  const connect = useCallback(() => {
    if (connecting) return;
    setConnecting(true);
    setError(null);
    // `cwd` 是会话的**本地锚点**：远程项目的身份串没有本地根，后端
    // `resolve_ssh_session_local_anchor` 也会把它清空；这里直接传空串，语义明确。
    // `sftpEnabled: true` 是必须的：SFTP 区接下来就要列目录，没开的会话会被后端
    // `ensure_session_allowed` 直接拒绝。
    void client
      .createSsh({
        cwd: "",
        projectPathKey,
        hostId: target.hostId,
        title: target.hostName || target.hostId,
        sftpEnabled: true,
      })
      .then(consumeConnectResult)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setConnecting(false));
  }, [client, connecting, consumeConnectResult, projectPathKey, target.hostId, target.hostName]);

  const submitPrompt = useCallback(() => {
    if (!prompt || answeringPrompt) return;
    const hostKeyPrompt = prompt.kind === "hostKey";
    if (!hostKeyPrompt && !promptAnswer.trim()) return;
    setAnsweringPrompt(true);
    setError(null);
    void client
      .answerSshPrompt({
        promptId: prompt.id,
        answer: hostKeyPrompt ? undefined : promptAnswer,
        trustHostKey: hostKeyPrompt,
      })
      .then(consumeConnectResult)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setAnsweringPrompt(false));
  }, [answeringPrompt, client, consumeConnectResult, prompt, promptAnswer]);

  const abandonPrompt = useCallback(() => {
    const promptId = prompt?.id;
    setPrompt(null);
    setPromptAnswer("");
    if (promptId) void client.cancelSshPrompt(promptId).catch(() => undefined);
  }, [client, prompt?.id]);

  const reconnect = useCallback(() => {
    const targetSession = reattachableSession ?? session;
    if (!targetSession || reconnecting) return;
    setReconnecting(true);
    setError(null);
    void client
      .sshReconnect(targetSession.id, targetSession.projectPathKey)
      .then((updated) => {
        onSessionsReconcile(sessions.map((entry) => (entry.id === updated.id ? updated : entry)));
      })
      .catch((err: unknown) => {
        const message = errorMessage(err);
        if (isTerminalSessionNotFoundError(err)) {
          // 后端已丢这条会话（幽灵记录）：让宿主把它从列表里清掉，用户点「连接」
          // 会拿到一条新会话，而不是对着死记录反复重连。
          onSessionClosed(targetSession.id);
          setError(t("projectTools.remoteWorkspaceSessionGone"));
          return;
        }
        // keyboard-interactive 主机无法在重连路径里重新认证（那条路径没有提示
        // 通道）；指引用户回【SSH 隧道】面板走完整流程，而不是给一个死按钮。
        setError(
          message.includes("keyboard-interactive")
            ? t("workspaceSshTerminal.reconnectKbiHint")
            : message,
        );
      })
      .finally(() => setReconnecting(false));
  }, [
    client,
    onSessionClosed,
    onSessionsReconcile,
    reattachableSession,
    reconnecting,
    session,
    sessions,
    t,
  ]);

  // 会话换了（新建/重连/幽灵清理）就把上一轮的错误清掉，避免旧错误贴在新视口上。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这里的依赖就是「会话身份变化」这个事件，不是 effect 内部读到的值。
  useEffect(() => {
    setTerminalError(null);
  }, [session?.id]);

  const handleTerminalError = useCallback((_sessionId: string, message: string | null) => {
    setTerminalError(message);
  }, []);

  const applyRatioFromPointer = useCallback((clientY: number) => {
    const element = splitContainerRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0) return;
    setRatio(clampRemoteWorkspaceSplitRatio((clientY - rect.top) / rect.height));
  }, []);

  const handleSplitterPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    splitterDragPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingSplitter(true);
  }, []);

  const handleSplitterPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (splitterDragPointerRef.current !== event.pointerId) return;
      applyRatioFromPointer(event.clientY);
    },
    [applyRatioFromPointer],
  );

  const finishSplitterDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (splitterDragPointerRef.current !== event.pointerId) return;
      splitterDragPointerRef.current = null;
      setDraggingSplitter(false);
      onSplitRatioCommit(ratioRef.current);
    },
    [onSplitRatioCommit],
  );

  const handleSplitterKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? SPLITTER_KEYBOARD_STEP_LARGE : SPLITTER_KEYBOARD_STEP;
      const direction = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      if (direction === 0) return;
      event.preventDefault();
      const next = clampRemoteWorkspaceSplitRatio(ratioRef.current + direction * step);
      setRatio(next);
      onSplitRatioCommit(next);
    },
    [onSplitRatioCommit],
  );
  if (!session || prompt) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-5 py-6 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground">
          <Server className="h-5 w-5" />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="truncate text-sm font-medium text-foreground">
            {target.hostName || target.hostId}
          </div>
          <div className="truncate font-mono text-xs text-muted-foreground" title={endpoint}>
            {endpoint}
          </div>
          <div className="truncate font-mono text-xs text-muted-foreground" title={target.rootPath}>
            {target.rootPath}
          </div>
        </div>
        {prompt ? (
          <div className="w-full max-w-xs rounded-lg border border-border/70 bg-card/70 p-3 text-left">
            <div className="text-xs font-medium text-foreground">
              {prompt.kind === "hostKey"
                ? t("chat.workspaceRemotePromptHostKeyTitle")
                : t("chat.workspaceRemotePromptAuthTitle")}
            </div>
            <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
              {prompt.message}
            </p>
            {prompt.fingerprintSha256 ? (
              <p className="mt-1.5 break-all font-mono text-[11px] text-muted-foreground">
                {prompt.fingerprintSha256}
              </p>
            ) : null}
            {prompt.kind === "hostKey" ? null : (
              <Input
                className="mt-2 h-8 text-xs"
                type={prompt.answerEcho ? "text" : "password"}
                value={promptAnswer}
                onChange={(event) => setPromptAnswer(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  submitPrompt();
                }}
                aria-label={t("chat.workspaceRemotePromptAuthTitle")}
                autoComplete="off"
              />
            )}
            <div className="mt-2 flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={answeringPrompt || (prompt.kind !== "hostKey" && !promptAnswer.trim())}
                onClick={submitPrompt}
              >
                {prompt.kind === "hostKey"
                  ? t("chat.workspaceRemotePromptTrust")
                  : t("chat.workspaceRemotePromptSubmit")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={answeringPrompt}
                onClick={abandonPrompt}
              >
                {t("chat.workspaceRemotePromptCancel")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <Button type="button" size="sm" disabled={connecting} onClick={connect}>
              {connecting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              {connecting ? t("chat.workspaceRemoteConnecting") : t("chat.workspaceRemoteConnect")}
            </Button>
            {reattachableSession ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={reconnecting}
                onClick={reconnect}
              >
                <RefreshCw
                  className={cn("mr-1.5 h-3.5 w-3.5", reconnecting && "animate-spin")}
                  aria-hidden="true"
                />
                {t("projectTools.remoteWorkspaceReconnect")}
              </Button>
            ) : null}
          </div>
        )}
        {host ? null : (
          <div className="max-w-xs text-xs text-muted-foreground">
            {t("projectTools.remoteWorkspaceHostMissing")}
          </div>
        )}
        {error ? (
          <div className="max-w-xs break-words text-xs text-destructive">{error}</div>
        ) : null}
      </div>
    );
  }

  const banner = error ?? terminalError;
  const status = sshSessionStatus(session);
  const statusLabel =
    status === "connected"
      ? t("workbench.sshStatusConnected")
      : status === "reconnecting"
        ? t("workbench.sshStatusReconnecting")
        : t("workbench.sshStatusDisconnected");

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border/60 bg-muted/40 px-3 text-[11px] text-muted-foreground">
        <span
          aria-hidden="true"
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            status === "connected"
              ? "bg-emerald-500"
              : status === "reconnecting"
                ? "bg-amber-500"
                : "bg-destructive",
          )}
        />
        <span className="sr-only">{statusLabel}</span>
        <span className="min-w-0 flex-1 truncate font-mono" title={endpoint}>
          {endpoint}
        </span>
        <span
          className="max-w-[45%] shrink-0 truncate font-mono text-muted-foreground/80"
          title={target.rootPath}
        >
          {target.rootPath}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-5 gap-1 px-1.5 text-[11px]"
          title={t("projectTools.remoteWorkspaceReconnect")}
          aria-label={t("projectTools.remoteWorkspaceReconnect")}
          disabled={reconnecting}
          onClick={reconnect}
        >
          <RefreshCw className={cn("h-3 w-3", reconnecting && "animate-spin")} aria-hidden="true" />
        </Button>
      </div>

      {banner ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1 break-words">{banner}</div>
        </div>
      ) : null}

      {/* 上下两块用 flexGrow 分配高度：Bash 区在上、SFTP 区在下，中间是可拖动的
          分隔条。两块都 `min-h-0` + `flexBasis: 0`，否则内容（xterm 的 canvas 与
          SFTP 的行列表）会撑破 dock 的高度。 */}
      <div ref={splitContainerRef} className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-col" style={{ flexGrow: ratio, flexBasis: 0 }}>
          <div className="relative min-h-0 flex-1">
            {active ? (
              <XTermViewport
                client={client}
                session={session}
                theme={theme}
                isActive
                initialInput={initialInput}
                reconnectInput={reconnectInput}
                onError={handleTerminalError}
                onAddToConversation={onAddTerminalSelectionToConversation}
              />
            ) : null}
          </div>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: 分隔条需要一个可聚焦的
            role="separator" 容器来同时承载指针拖拽与方向键调整。 */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("projectTools.remoteWorkspaceResize")}
          aria-valuemin={Math.round(MIN_REMOTE_WORKSPACE_SPLIT_RATIO * 100)}
          aria-valuemax={Math.round(MAX_REMOTE_WORKSPACE_SPLIT_RATIO * 100)}
          aria-valuenow={Math.round(ratio * 100)}
          tabIndex={0}
          className={cn(
            "group relative h-2 shrink-0 cursor-row-resize touch-none select-none border-y border-border/60 bg-muted/30 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60",
            draggingSplitter && "bg-muted/60",
          )}
          onPointerDown={handleSplitterPointerDown}
          onPointerMove={handleSplitterPointerMove}
          onPointerUp={finishSplitterDrag}
          onPointerCancel={finishSplitterDrag}
          onKeyDown={handleSplitterKeyDown}
        >
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-1/2 h-0.5 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border"
          />
        </div>
        <div className="flex min-h-0 flex-col" style={{ flexGrow: 1 - ratio, flexBasis: 0 }}>
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {t("workspaceSftp.loading")}
              </div>
            }
          >
            <WorkspaceSftpPanel
              client={sftpClient}
              session={session}
              isActive={active}
              initialRemotePath={target.rootPath}
              showLocalPane={false}
              onError={setError}
              onOpenFile={onOpenFile ? (request) => onOpenFile(session, request) : undefined}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
