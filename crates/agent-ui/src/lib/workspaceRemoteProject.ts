import type { SshHostConfig, WorkspaceProject, WorkspaceRemoteRoot } from "./settings/types";
import type { SftpEntry, SftpListResponse, SftpStatResponse } from "./sftp/types";
import { createUuid } from "./shared/id";
import type { TerminalSession } from "./terminal/types";

/**
 * 远程工作空间根目录的纯函数层。
 *
 * 设计要点：`WorkspaceProject.path` 对远程项目保存的是**身份串**
 * `ssh://<hostId>/<abs>`，而不是可直接喂给本地 fs 的路径。理由是
 * 全局所有按路径去重/分组/右栏 tab 键的逻辑都基于 `workspaceProjectPathKey(path)`，
 * 把 hostId 编进身份串可以让「两台主机上的同名目录」天然不冲突，同时让
 * 任何误把 `project.path` 当本地路径用的代码立刻失败而不是静默读错目录。
 * 真正的远程根目录以 `remote.rootPath` 为准。
 */

export const REMOTE_WORKSPACE_PATH_SCHEME = "ssh://";

function readMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return String(error ?? "").trim();
}

// ---------------------------------------------------------------------------
// 身份串构造 / 解析
// ---------------------------------------------------------------------------

/** `rootPath` 会被归一化并强制为绝对路径；hostId 或根目录非法时返回空串。 */
export function buildRemoteWorkspacePath(hostId: string, rootPath: string) {
  const host = hostId.trim();
  if (!host) return "";
  const normalized = normalizeRemoteDirectoryPath(rootPath);
  if (!normalized || normalized === ".") return "";
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `${REMOTE_WORKSPACE_PATH_SCHEME}${encodeURIComponent(host)}${absolute}`;
}

export function parseRemoteWorkspacePath(path: unknown) {
  const value = typeof path === "string" ? path.trim() : "";
  if (!value.startsWith(REMOTE_WORKSPACE_PATH_SCHEME)) return null;
  const rest = value.slice(REMOTE_WORKSPACE_PATH_SCHEME.length);
  const separator = rest.indexOf("/");
  if (separator <= 0) return null;
  let hostId = "";
  try {
    hostId = decodeURIComponent(rest.slice(0, separator)).trim();
  } catch {
    return null;
  }
  const rootPath = normalizeRemoteDirectoryPath(rest.slice(separator));
  if (!hostId || !rootPath || rootPath === ".") return null;
  return { hostId, rootPath };
}

export function isRemoteWorkspacePath(path: unknown) {
  return parseRemoteWorkspacePath(path) !== null;
}

/**
 * 会话的**本地根视图**：workspace root 展示、资源（skills/MCP/项目提示词）解析、
 * 上传归属等都读它。两端（桌面 ChatPage / WebUI GatewayApp）必须共用这一处实现，
 * 各自内联一份已经漏掉过入口。
 *
 * 取值顺序沿用旧的内联表达式：会话自身的锚点（已落盘 cwd → 运行时 workdir）优先，
 * 其次搜索视图，最后才是活动项目与全局兜底。差别只有一条：**活动项目是远程时，
 * 既不能把身份串当本地根返回，也不能回退到全局 workdir**。
 *
 * 全局 workdir 这一条最容易踩：远程项目的 `path` 进不了本地文件系统，
 * `normalizeWorkdir` 会在设置加载时把它改写成**本地默认项目**目录（Rust 的
 * `default_project_workdir`，实际就是上次打开的那个本地文件夹）。于是「在远程文件夹里
 * 点新建对话」会开出一个根目录指向本地文件夹的会话 —— 用户看到的正是工作空间被
 * 静默换掉，而 agent 同时面对本地根与远端两个互相矛盾的事实。
 */
export function resolveConversationDisplayWorkdir(params: {
  /** 该会话已落盘的 cwd；远程下是身份串，会被剥成空串。 */
  persistedCwd?: string;
  /** 该会话的运行时 workdir；与落盘 cwd 同一套取值规则。 */
  runtimeWorkdir?: string;
  /** `undefined` = 不在搜索视图；`""` = 搜索命中的是无根会话。 */
  searchWorkdir?: string;
  isAgentMode: boolean;
  activeWorkspaceProjectPath: string;
  globalWorkdir?: string;
}): string {
  const localRoot = (value: unknown) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return isRemoteWorkspacePath(trimmed) ? "" : trimmed;
  };
  const persisted = localRoot(params.persistedCwd);
  if (persisted) return persisted;
  const runtime = localRoot(params.runtimeWorkdir);
  if (runtime) return runtime;
  if (params.searchWorkdir === "") return "";
  if (!params.isAgentMode) return "";
  // 镜像情形：会话自己锚在远程工作空间（落盘 cwd 是身份串），而用户把活动项目切回了
  // 本地文件夹 —— 屏幕上仍是那个远程会话。这时借用活动项目 / 全局 workdir，等于给它挂上
  // 无关本地项目的 skills、MCP 与项目提示词，所以同样归零。
  if (isRemoteWorkspacePath(params.persistedCwd) || isRemoteWorkspacePath(params.runtimeWorkdir)) {
    return "";
  }
  // 远程活动项目没有本地根：既不返回身份串，也不许借用全局 workdir（那是另一个项目）。
  const projectPath = params.activeWorkspaceProjectPath.trim();
  if (isRemoteWorkspacePath(projectPath)) return "";
  return projectPath || (params.globalWorkdir ?? "").trim();
}

/**
 * 取远程根描述：优先用持久化的 `remote` 字段，缺失时（例如旧存档只留了身份串）
 * 回退到从 `path` 解析，hostName 用 hostId 兜底。
 */
export function remoteWorkspaceRoot(
  project: Pick<WorkspaceProject, "path" | "remote">,
): WorkspaceRemoteRoot | null {
  const remote = project.remote;
  if (remote) {
    const hostId = typeof remote.hostId === "string" ? remote.hostId.trim() : "";
    const rootPath = normalizeRemoteDirectoryPath(remote.rootPath);
    if (hostId && rootPath && rootPath !== ".") {
      const hostName = typeof remote.hostName === "string" ? remote.hostName.trim() : "";
      return { hostId, hostName: hostName || hostId, rootPath };
    }
  }
  const parsed = parseRemoteWorkspacePath(project.path);
  if (!parsed) return null;
  return { hostId: parsed.hostId, hostName: parsed.hostId, rootPath: parsed.rootPath };
}

export function isRemoteWorkspaceProject(project: Pick<WorkspaceProject, "path" | "remote">) {
  return remoteWorkspaceRoot(project) !== null;
}

export function remoteWorkspaceRootPath(project: Pick<WorkspaceProject, "path" | "remote">) {
  return remoteWorkspaceRoot(project)?.rootPath ?? "";
}

/** 展示用目标，形如 `hostName:/srv/app`；无法识别为远程项目时返回空串。 */
export function remoteWorkspaceDisplayTarget(project: Pick<WorkspaceProject, "path" | "remote">) {
  const root = remoteWorkspaceRoot(project);
  return root ? `${root.hostName}:${root.rootPath}` : "";
}

export function remoteWorkspaceName(rootPath: string) {
  const normalized = normalizeRemoteDirectoryPath(rootPath);
  if (normalized === "." || normalized === "/") return normalized;
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

/**
 * 让远程 shell 停在远端根的命令：`cd '<rootPath>'`。
 *
 * 为什么需要它：SSH shell 通道的起始目录由服务端决定（通常是登录用户的家目录），
 * `createSsh` 的 `cwd` 参数记录的是**本地锚点**、对远端目录没有任何作用。所以
 * 「终端停在当前远程文件夹」只能靠会话建立后显式 `cd` 一次。
 *
 * 单引号包裹 + `'\''` 是 POSIX shell 里唯一无副作用的转义方式：远端可能是
 * bash / sh / zsh，不能套用本地 Windows 的引号规则。根目录缺失或等于家目录
 * 时返回空串（调用方据此不发命令，保持服务端默认行为）。
 */
export function remoteWorkspaceShellCdCommand(rootPath: string) {
  const normalized = normalizeRemoteDirectoryPath(rootPath);
  if (!normalized || normalized === ".") return "";
  return `cd '${normalized.replace(/'/g, "'\\''")}'`;
}

export function createRemoteWorkspaceProject(input: {
  hostId: string;
  hostName: string;
  rootPath: string;
}): WorkspaceProject {
  const hostId = input.hostId.trim();
  const rootPath = normalizeRemoteDirectoryPath(input.rootPath);
  const path = buildRemoteWorkspacePath(hostId, rootPath);
  if (!path) {
    throw new Error("createRemoteWorkspaceProject requires a host and an absolute remote path");
  }
  const now = Date.now();
  return {
    id: `remote-${now}-${createUuid().slice(0, 8)}`,
    name: remoteWorkspaceName(rootPath),
    path,
    kind: "remote",
    remote: {
      hostId,
      hostName: input.hostName.trim() || hostId,
      rootPath,
    },
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// 远程目录路径
// ---------------------------------------------------------------------------

/**
 * 归一化远程目录路径：`.`/空 归为 `"."`（即 SFTP 语义下的家目录），
 * `..` 就地折叠。注意 Rust 侧 `normalize_remote_path` 是**丢弃** `..` 段而不是
 * 回退，所以调用方必须先把路径折叠好再发给后端。
 */
export function normalizeRemoteDirectoryPath(input: unknown) {
  const raw = typeof input === "string" ? input.trim().replace(/\\/g, "/") : "";
  // `~` 单独出现时按家目录处理：多数 SFTP 服务端不会展开波浪号，
  // 直接下发会变成 not-found，而用户的意图显然是家目录。
  if (!raw || raw === "." || raw === "~") return ".";
  const absolute = raw.startsWith("/");
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push("..");
      }
      continue;
    }
    segments.push(segment);
  }
  if (absolute) return segments.length ? `/${segments.join("/")}` : "/";
  return segments.length ? segments.join("/") : ".";
}

/** 相对路径基于当前目录解析；绝对路径直接采用。 */
export function resolveRemoteDirectoryPath(current: string, target: string) {
  const next = typeof target === "string" ? target.trim() : "";
  if (!next) return normalizeRemoteDirectoryPath(current);
  if (next.startsWith("/")) return normalizeRemoteDirectoryPath(next);
  const base = normalizeRemoteDirectoryPath(current);
  return normalizeRemoteDirectoryPath(base === "." ? next : `${base}/${next}`);
}

/** 家目录 / 根目录没有可去的上级，返回 null 让 UI 置灰。 */
export function remoteDirectoryParentPath(path: string): string | null {
  const normalized = normalizeRemoteDirectoryPath(path);
  if (normalized === "." || normalized === "/") return null;
  const absolute = normalized.startsWith("/");
  const segments = normalized.split("/").filter(Boolean);
  segments.pop();
  if (absolute) return segments.length ? `/${segments.join("/")}` : "/";
  return segments.length ? segments.join("/") : ".";
}

export type RemoteDirectoryCrumb = { label: string; path: string };

export function remoteDirectoryBreadcrumbs(path: string): RemoteDirectoryCrumb[] {
  const normalized = normalizeRemoteDirectoryPath(path);
  if (normalized === ".") return [{ label: ".", path: "." }];
  const absolute = normalized.startsWith("/");
  const parts = normalized.split("/").filter(Boolean);
  const crumbs: RemoteDirectoryCrumb[] = absolute ? [{ label: "/", path: "/" }] : [];
  parts.forEach((part, index) => {
    const prefix = parts.slice(0, index + 1).join("/");
    crumbs.push({ label: part, path: absolute ? `/${prefix}` : prefix });
  });
  return crumbs;
}

/**
 * 只保留可作为根目录的项：目录本身。符号链接一律排除——SFTP 的
 * `read_dir` 无法在不额外 stat 的情况下区分「指向目录的链接」和「指向文件的
 * 链接」，让用户选到后者会得到一个不可用的工作空间根。
 */
export function remoteWorkspaceDirectoryEntries(entries: readonly SftpEntry[]) {
  return entries
    .filter((entry) => entry.kind === "directory")
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
}

/** 列出结果里的 `path` 是后端 canonicalize 过的绝对路径，优先用它当当前目录。 */
export function remoteDirectoryListingPath(
  requestedPath: string,
  response: Pick<SftpListResponse, "path">,
) {
  const resolved = typeof response.path === "string" ? response.path.trim() : "";
  return resolved || normalizeRemoteDirectoryPath(requestedPath);
}

export type RemoteWorkspaceDirectoryCheck = "not-found" | "not-directory" | null;

/** 校验选定目录能否作为工作空间根：必须存在且是目录。 */
export function remoteWorkspaceDirectoryCheck(
  response: Pick<SftpStatResponse, "exists" | "entry">,
): RemoteWorkspaceDirectoryCheck {
  if (!response.exists) return "not-found";
  const kind = response.entry?.kind;
  if (kind !== "directory") return "not-directory";
  return null;
}

// ---------------------------------------------------------------------------
// SSH 会话可用性
// ---------------------------------------------------------------------------

export type RemoteWorkspaceSessionIssue = "not-ssh" | "finished" | "disconnected" | "sftp-disabled";

/**
 * 判断某个终端会话能否用来浏览远程目录。SFTP 必须显式开启
 * （`createSsh` 的 `sftpEnabled`），否则后端 `ensure_session_allowed` 会直接拒绝。
 */
export function remoteWorkspaceSessionIssue(
  session: Pick<TerminalSession, "kind" | "running" | "ssh">,
): RemoteWorkspaceSessionIssue | null {
  if (session.kind !== "ssh" || !session.ssh) return "not-ssh";
  if (!session.running) return "finished";
  if (session.ssh.status !== "connected") return "disconnected";
  if (session.ssh.sftpEnabled !== true) return "sftp-disabled";
  return null;
}

export function isRemoteWorkspaceSessionUsable(
  session: Pick<TerminalSession, "kind" | "running" | "ssh">,
) {
  return remoteWorkspaceSessionIssue(session) === null;
}

/** 只留下真正能浏览远程目录的会话（已建立 + 已连接 + 开了 SFTP）。 */
export function selectableRemoteWorkspaceSessions(sessions: readonly TerminalSession[]) {
  return sessions.filter((session) => isRemoteWorkspaceSessionUsable(session));
}

/**
 * 某主机上当前可直接用于 SFTP 的会话。
 *
 * 同一主机可能同时存在多条会话（用户手动开过好几条），这里只关心「有没有一条能用
 * 的」—— 浏览目录不需要关心是哪一条。断开的、没开 SFTP 的一律不算。
 */
export function findUsableSessionForHost(
  sessions: readonly TerminalSession[],
  hostId: string,
): TerminalSession | null {
  const target = hostId.trim();
  if (!target) return null;
  return (
    sessions.find(
      (session) => session.ssh?.hostId === target && isRemoteWorkspaceSessionUsable(session),
    ) ?? null
  );
}

/**
 * 选择器里的一行隧道。`hostId` 就是【SSH 隧道】设置里那条主机的 id，
 * 也是 `createSsh` / 项目 SSH 关联要用的标识。
 */
export type RemoteWorkspaceHostOption = {
  hostId: string;
  name: string;
  /** 形如 `user@host:port`：同名主机靠它区分。 */
  endpoint: string;
  /** 已经有一条可直接用的会话，不必再连一次。 */
  connected: boolean;
  /** 已连接时对应的会话 id；未连接为 null。 */
  sessionId: string | null;
};

/**
 * 把【SSH 隧道】里**已添加的主机**整理成选择器要展示的列表。
 *
 * 核心约定：**列出全部已添加的隧道，无论当前是否连接**。让用户先去终端面板手动建
 * 一条会话、再回来选目录，是把「连接」这个动作藏进了另一个界面；未连接在这里只是
 * 一个需要点一下「连接」的状态。
 */
export function remoteWorkspaceHostOptions(
  hosts: readonly SshHostConfig[],
  sessions: readonly TerminalSession[],
): RemoteWorkspaceHostOption[] {
  return hosts
    .map((host) => {
      const hostId = host.id.trim();
      const session = findUsableSessionForHost(sessions, hostId);
      return {
        hostId,
        name: host.name.trim() || hostId,
        endpoint: `${host.username.trim() || "?"}@${host.host.trim() || "?"}:${host.port || 22}`,
        connected: session !== null,
        sessionId: session?.id ?? null,
      };
    })
    .filter((option) => option.hostId !== "")
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
}

/**
 * 给 agent 的远程工作空间说明。
 *
 * 为什么必须有这段：远程工作空间下 workdir 是空的（身份串不是本地路径，会在解析层被
 * 清空），本地 fs / shell 工具因此无从作用。agent 不会自己猜到「该用 SSHManager 去连
 * 哪台机器、远端根在哪」，所以要把主机与远端根显式写进 system prompt。
 *
 * 内容是稳定的（同一个工作空间不变），可以安全地作为缓存前缀的一部分。
 */
export function buildRemoteWorkspacePrompt(params: {
  hostId: string;
  hostName: string;
  rootPath: string;
}): string {
  const hostId = params.hostId.trim();
  const rootPath = params.rootPath.trim();
  if (!hostId || !rootPath) return "";
  const hostName = params.hostName.trim() || hostId;
  return [
    "## Remote workspace",
    "",
    "This conversation runs in a remote workspace reached over SSH. There is no local",
    "working directory: the workspace root lives on the remote host, and the local file",
    "and shell tools are not available here.",
    "",
    `- SSH host: \`${hostId}\` (${hostName})`,
    `- Remote root: \`${rootPath}\``,
    "",
    "Do all workspace work through the `SSHManager` tool:",
    "",
    `- pass \`host_id="${hostId}"\`; omit \`session_id\` to reuse that host's running session`,
    "  (the default), or pass a `session_id` returned by `create_session` / `list_sessions`",
    "- inspect and read with `sftp_list`, `sftp_stat`, `sftp_read_text`",
    "- write with `sftp_write_text`; create, move and remove with `sftp_mkdir`,",
    "  `sftp_rename`, `sftp_delete`",
    "- run commands with `exec`, setting `cwd` to a path under the remote root",
    "- exchange files with the local machine using `sftp_upload` / `sftp_download`",
    "",
    "Remote paths are absolute POSIX paths on that host. Never construct workspace-relative",
    "local paths, and never assume a `cwd` default — pass it explicitly.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 错误分类
// ---------------------------------------------------------------------------

export type RemoteWorkspaceErrorCode =
  | "no-session"
  | "session-missing"
  | "session-disconnected"
  | "sftp-disabled"
  | "host-missing"
  | "permission-denied"
  | "not-found"
  | "not-directory"
  | "unknown";

// 顺序即优先级：更具体的后端错误串必须排在宽泛的 not-found 之前。
const REMOTE_ERROR_PATTERNS: ReadonlyArray<[RemoteWorkspaceErrorCode, readonly string[]]> = [
  ["sftp-disabled", ["sftp is not enabled"]],
  ["session-missing", ["session not found", "does not belong to this project"]],
  ["session-disconnected", ["is not connected", "not connected", "disconnected", "session closed"]],
  ["host-missing", ["ssh host not found", "host not found"]],
  ["not-directory", ["not a directory", "enotdir", "ssh_fx_not_a_directory"]],
  [
    "permission-denied",
    ["permission denied", "eacces", "os error 13", "ssh_fx_permission_denied", "access denied"],
  ],
  ["not-found", ["no such file", "enoent", "os error 2", "ssh_fx_no_such_file", "not found"]],
];

/** 把后端/SFTP 的报错归一到有限集合，便于给出针对性文案而不是甩原始串。 */
export function classifyRemoteWorkspaceError(error: unknown): RemoteWorkspaceErrorCode {
  const message = readMessage(error).toLowerCase();
  if (!message) return "unknown";
  for (const [code, patterns] of REMOTE_ERROR_PATTERNS) {
    if (patterns.some((pattern) => message.includes(pattern))) return code;
  }
  return "unknown";
}

export function remoteWorkspaceErrorI18nKey(code: RemoteWorkspaceErrorCode) {
  switch (code) {
    case "no-session":
      return "chat.workspaceRemoteErrorNoSession";
    case "session-missing":
      return "chat.workspaceRemoteErrorSessionMissing";
    case "session-disconnected":
      return "chat.workspaceRemoteErrorDisconnected";
    case "sftp-disabled":
      return "chat.workspaceRemoteErrorSftpDisabled";
    case "host-missing":
      return "chat.workspaceRemoteErrorHostMissing";
    case "permission-denied":
      return "chat.workspaceRemoteErrorPermissionDenied";
    case "not-found":
      return "chat.workspaceRemoteErrorNotFound";
    case "not-directory":
      return "chat.workspaceRemoteErrorNotDirectory";
    default:
      return "chat.workspaceRemoteErrorUnknown";
  }
}
