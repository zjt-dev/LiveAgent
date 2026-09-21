import type { AssistantMessage } from "@earendil-works/pi-ai";
import { HOOK_EVENT_TRANSLATION_KEYS } from "@liveagent/ui/lib/automation/index";
import { isRemoteWorkspacePath } from "@liveagent/ui/lib/workspaceRemoteProject";
import type { HookRunWarning } from "../../../lib/automation/hookRunner";
import type { CompactionStatus } from "../../../lib/chat/compaction/types";
import type { ConversationViewState } from "../../../lib/chat/conversation/conversationState";
import type { ConversationPersistenceCursor } from "../../../lib/chat/history/chatHistory";
import { normalizeErrorMessage } from "../../../lib/providers/llm";
import type { AppSettings, SelectedModel } from "../../../lib/settings";

export const MAX_IDLE_CONVERSATION_RUNTIME_CACHE_ENTRIES = 12;

export type ConversationRuntimeEntry = {
  state: ConversationViewState;
  compactionStatus: CompactionStatus;
  isSending: boolean;
  errorMessage: string | null;
  hookWarning: string | null;
  sessionId: string;
  createdAt: number;
  workdir?: string;
  selectedModel?: SelectedModel;
};

/**
 * 远程工作空间的身份串（`ssh://<hostId>/<abs>`）不是本地路径。它一旦进入会话
 * workdir，下游 Rust 的 `canonicalize_workdir` 会判它非绝对路径并拒绝，文件与
 * 命令类工具会全线报 `workdir must be an existing absolute directory`。
 *
 * 拦在解析层而不是各个调用点：workdir 的来源有多条（显式覆盖、持久化、运行时、
 * 全局设置），逐个入口拦截必然遗漏。
 */
function rejectRemoteWorkdir(workdir: string) {
  return isRemoteWorkspacePath(workdir) ? "" : workdir;
}

export function resolveConversationPromptWorkdir(params: {
  isAgentMode: boolean;
  workdirOverride?: string;
  gatewayWorkdirOverride?: string;
  persistedWorkdir?: string;
  runtimeWorkdir?: string;
  globalWorkdir: string;
  /**
   * 活动工作空间项目是否为远程。
   *
   * 远程工作空间**没有本地根**，所以「会话自身的锚点」与「全局兜底」都不该生效：
   *
   * - `globalWorkdir` 最隐蔽 —— 它在设置加载时已被 `normalizeWorkdir` 从身份串
   *   改写成**本地默认项目**（Rust 的 `default_project_workdir`）。让它兜底，会话就会
   *   静默落到一个不相关的工作空间：本地文件/命令工具按那个根注册、会话 cwd 也被写成
   *   它并落盘，agent 同时看到「本地某项目 + 远端」两个根，只能反问用户「你说的这个
   *   项目指哪个」。这正是「回退会让用户在错误的根目录下工作却不自知」。
   * - 持久化/运行时值同样可能指向别的项目（迁移前的旧本地路径、拖拽移动写进的身份串）。
   *
   * **显式覆盖不在此列**：它属于被发送的那个会话（队列排空、网关代发都可能不是活动
   * 会话），可能是合法的本地项目，所以在上面的分支里已经返回，不能被这里吃掉。
   */
  activeWorkspaceIsRemote?: boolean;
}) {
  const explicitWorkdir = params.workdirOverride?.trim() || params.gatewayWorkdirOverride?.trim();
  if (explicitWorkdir) return rejectRemoteWorkdir(explicitWorkdir);
  if (params.activeWorkspaceIsRemote) return "";
  return rejectRemoteWorkdir(
    params.persistedWorkdir?.trim() ||
      params.runtimeWorkdir?.trim() ||
      (params.isAgentMode ? params.globalWorkdir.trim() : ""),
  );
}

export function resolveEffectiveConversationWorkdir(
  params: Parameters<typeof resolveConversationPromptWorkdir>[0],
) {
  const explicitWorkdir = params.workdirOverride ?? params.gatewayWorkdirOverride;
  if (explicitWorkdir !== undefined) return rejectRemoteWorkdir(explicitWorkdir.trim());
  if (!params.isAgentMode) return "";
  return resolveConversationPromptWorkdir(params);
}

/**
 * 会话的**落盘 cwd**。它与上面的「工具 workdir」是**两个不同的值**，取值规则故意相反：
 *
 * - 工具 workdir 要「远程 → 空」（身份串不是本地路径，进了下游会被 Rust 拒绝）；
 * - 落盘 cwd 要「远程 → 身份串」，因为 `chat_history_list` 按
 *   `TRIM(COALESCE(cwd,'')) = ?1` **精确匹配**取列表，而远程项目的侧栏 scope
 *   就是项目身份串。写空只会让会话掉进「无工作空间」桶 —— 它仍可对话，但从
 *   远程项目下消失。
 *
 * 曾经这里取 `effectiveWorkdir || undefined`，于是远程会话落盘成 `globalWorkdir` ——
 * 而后者在设置加载时已被 `normalizeWorkdir` 从身份串改写成**本地默认项目**
 * （Rust 的 `default_project_workdir`）。用户看到的现象是：在远程文件夹下发的对话，
 * 出现在了另一个本地工作空间里。工具侧当时同样被带偏：agent 同时拿到「本地某项目」
 * 与远端两个根，只能反问用户「你说的这个项目指哪个」。
 *
 * **显式覆盖优先**（队列排空 / 网关代发）：它属于被发送的那个会话，可能不是活动会话，
 * 带着目标会话真正的项目路径。若被活动项目的身份串顶掉，就是上面那个错误的镜像 ——
 * 本地会话在后台代发后被悄悄改归到远程项目组。
 */
export function resolveConversationPersistedCwd(params: {
  workdirOverride?: string;
  gatewayWorkdirOverride?: string;
  /** 活动工作空间项目是否为远程。 */
  activeWorkspaceIsRemote: boolean;
  /** 活动工作空间项目的路径（远程下即身份串）。 */
  workspaceProjectPath: string;
  /** 解析后的工具 workdir —— 远程下恒为空，所以不能单独用它。 */
  effectiveWorkdir: string;
  /** 该会话已落盘的 cwd。远程身份串是合法归属键，不能因活动项目变了就抹掉。 */
  persistedWorkdir?: string;
  /**
   * 解析后的**工具 workdir**（`resolveConversationPromptWorkdir` 的结果）。
   *
   * 只在没有项目锚点的模式下兜底：text（非 agent）模式 `effectiveWorkdir` 恒为空，
   * 且没有全局兜底，`workdirResolution` 里的「已落盘 cwd → 运行时 workdir」就是该会话
   * 全部可用的身份信息。不兜这一下，text 会话每发一轮都会把 cwd 写成空 ——
   * 与远程会话写成空是同一个后果（`cwd = excluded.cwd` 直接清空归属），只是方向相反：
   * 本地会话从自己的项目侧栏掉进「无工作空间」。
   *
   * 这里不会把远程身份串带进本地会话：`rejectRemoteWorkdir` 已在
   * `resolveConversationPromptWorkdir` 里把身份串剥成空串。
   */
  promptWorkdir?: string;
}): string | undefined {
  const explicitPath =
    params.workdirOverride?.trim() || params.gatewayWorkdirOverride?.trim() || "";
  if (explicitPath) return explicitPath;
  const projectPath = params.activeWorkspaceIsRemote
    ? params.workspaceProjectPath
    : params.effectiveWorkdir;
  if (projectPath) return projectPath;
  // 活动项目与这个会话不是同一个（后台排空、网关代发）时，别把已有的远程归属键写成空。
  // cwd 的 upsert 是 `cwd = excluded.cwd`，传空即**清空**，会话随即从远程项目下消失。
  const persisted = params.persistedWorkdir?.trim() || "";
  if (isRemoteWorkspacePath(persisted)) return persisted;
  return params.promptWorkdir?.trim() || undefined;
}

export function syncMovedConversationRuntimeWorkdir(params: {
  conversationId: string;
  cwd: string;
  runtimeCache: ReadonlyMap<string, ConversationRuntimeEntry>;
  isConversationRunning: (conversationId: string) => boolean;
  updateConversationRuntimeEntry: (
    conversationId: string,
    updater: (prev: ConversationRuntimeEntry) => ConversationRuntimeEntry,
  ) => unknown;
}) {
  const conversationId = params.conversationId.trim();
  const cwd = params.cwd.trim();
  const runtimeEntry = params.runtimeCache.get(conversationId);
  if (
    !conversationId ||
    !cwd ||
    !runtimeEntry ||
    runtimeEntry.isSending ||
    params.isConversationRunning(conversationId)
  ) {
    return false;
  }
  params.updateConversationRuntimeEntry(conversationId, (prev) => ({
    ...prev,
    workdir: cwd,
  }));
  return true;
}

export function createConversationRuntimeEntry(params: {
  state: ConversationViewState;
  sessionId: string;
  createdAt: number;
  compactionStatus?: CompactionStatus;
  isSending?: boolean;
  errorMessage?: string | null;
  hookWarning?: string | null;
  workdir?: string;
  selectedModel?: SelectedModel;
}): ConversationRuntimeEntry {
  const {
    state,
    sessionId,
    createdAt,
    compactionStatus = { phase: "idle" },
    isSending = false,
    errorMessage = null,
    hookWarning = null,
    workdir,
    selectedModel,
  } = params;
  return {
    state,
    compactionStatus,
    isSending,
    errorMessage,
    hookWarning,
    sessionId,
    createdAt,
    workdir: workdir?.trim() || undefined,
    selectedModel,
  };
}

export function createEmptyAssistantUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export function setConversationRuntimeCacheEntry(
  cache: Map<string, ConversationRuntimeEntry>,
  conversationId: string,
  entry: ConversationRuntimeEntry,
) {
  const key = conversationId.trim();
  if (!key) return;
  const observableCache = cache as Map<string, ConversationRuntimeEntry> & {
    setRuntimeEntry?: (conversationId: string, entry: ConversationRuntimeEntry) => void;
  };
  if (observableCache.setRuntimeEntry) {
    observableCache.setRuntimeEntry(key, entry);
    return;
  }
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, entry);
}

export function pruneIdleConversationRuntimeCaches(params: {
  runtimeCache: Map<string, ConversationRuntimeEntry>;
  persistenceCursors: Map<string, ConversationPersistenceCursor>;
  keepConversationIds?: Iterable<string | undefined | null>;
  maxIdleEntries?: number;
  isConversationRunning?: (conversationId: string) => boolean;
  onPruneConversation?: (conversationId: string) => void;
}) {
  const {
    runtimeCache,
    persistenceCursors,
    keepConversationIds = [],
    maxIdleEntries = MAX_IDLE_CONVERSATION_RUNTIME_CACHE_ENTRIES,
    isConversationRunning,
    onPruneConversation,
  } = params;
  const keepIds = new Set<string>();
  for (const rawId of keepConversationIds) {
    const id = rawId?.trim();
    if (id) keepIds.add(id);
  }
  const idleLimit = Math.max(0, Math.floor(maxIdleEntries));
  const prunedIds: string[] = [];

  const isProtected = (conversationId: string, entry?: ConversationRuntimeEntry) =>
    keepIds.has(conversationId) ||
    Boolean(entry?.isSending) ||
    Boolean(isConversationRunning?.(conversationId));

  const idleRuntimeIds: string[] = [];
  for (const [conversationId, entry] of runtimeCache.entries()) {
    const key = conversationId.trim();
    if (!key) continue;
    if (isProtected(key, entry)) continue;
    idleRuntimeIds.push(key);
  }

  const runtimePruneCount = Math.max(0, idleRuntimeIds.length - idleLimit);
  for (const conversationId of idleRuntimeIds.slice(0, runtimePruneCount)) {
    runtimeCache.delete(conversationId);
    persistenceCursors.delete(conversationId);
    onPruneConversation?.(conversationId);
    prunedIds.push(conversationId);
  }

  for (const conversationId of Array.from(persistenceCursors.keys())) {
    const key = conversationId.trim();
    if (!key || runtimeCache.has(key) || isProtected(key)) continue;
    persistenceCursors.delete(key);
    onPruneConversation?.(key);
    prunedIds.push(key);
  }

  return prunedIds;
}

export function buildErrorAssistantMessage(params: {
  model: {
    api: AssistantMessage["api"];
    provider: AssistantMessage["provider"];
    id: string;
  };
  errorMessage: string;
  timestamp?: number;
}): AssistantMessage {
  const errorMessage = normalizeErrorMessage(params.errorMessage, "Request failed");
  const displayText =
    errorMessage === "Request failed" ||
    errorMessage.startsWith("Request failed:") ||
    errorMessage.startsWith("Request failed：")
      ? errorMessage
      : `Request failed: ${errorMessage}`;
  return {
    role: "assistant",
    content: [{ type: "text", text: displayText }],
    api: params.model.api,
    provider: params.model.provider,
    model: params.model.id,
    usage: createEmptyAssistantUsage(),
    stopReason: "error",
    errorMessage,
    timestamp: params.timestamp ?? Date.now(),
  };
}

export function buildPartialAssistantMessage(params: {
  model: {
    api: AssistantMessage["api"];
    provider: AssistantMessage["provider"];
    id: string;
  };
  text: string;
  timestamp?: number;
  stopReason?: AssistantMessage["stopReason"];
}): AssistantMessage | null {
  const content = params.text.trim();
  if (!content) return null;
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: params.model.api,
    provider: params.model.provider,
    model: params.model.id,
    usage: createEmptyAssistantUsage(),
    stopReason: params.stopReason ?? "aborted",
    timestamp: params.timestamp ?? Date.now(),
  };
}

export function appendSystemPrompt(base: string | undefined, suffix: string) {
  const head = (base || "").trim();
  const tail = (suffix || "").trim();
  if (!tail) return head;
  if (!head) return tail;
  return `${head}\n\n${tail}`;
}

export function formatHookWarningMessage(
  locale: AppSettings["locale"],
  t: (key: string) => string,
  warning: HookRunWarning,
) {
  const eventLabel = t(HOOK_EVENT_TRANSLATION_KEYS[warning.event]);
  return locale === "en-US"
    ? `Hook "${warning.hookName}" failed during ${eventLabel}: ${warning.message}`
    : `Hook「${warning.hookName}」在 ${eventLabel} 执行失败：${warning.message}`;
}
