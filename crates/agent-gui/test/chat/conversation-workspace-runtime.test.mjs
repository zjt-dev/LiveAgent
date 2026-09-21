import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const llmModulePath = path.join(rootDir, "src/lib/providers/llm.ts");

const loader = createTsModuleLoader({
  mocks: {
    [llmModulePath]: {
      normalizeErrorMessage(value, fallback = "Request failed") {
        return typeof value === "string" && value.trim() ? value.trim() : fallback;
      },
    },
  },
});

const {
  resolveConversationPersistedCwd,
  resolveConversationPromptWorkdir,
  resolveEffectiveConversationWorkdir,
  syncMovedConversationRuntimeWorkdir,
} = loader.loadModule("src/pages/chat/runtime/chatPageRuntime.ts");

test("persisted moved cwd wins over stale GUI runtime cwd for the next agent turn", () => {
  assert.equal(
    resolveEffectiveConversationWorkdir({
      isAgentMode: true,
      persistedWorkdir: "C:/workspace-b",
      runtimeWorkdir: "C:/workspace-a",
      globalWorkdir: "C:/global",
    }),
    "C:/workspace-b",
  );
});

test("explicit turn workdir overrides persisted cwd and text mode has no workdir", () => {
  const input = {
    persistedWorkdir: "C:/workspace-b",
    runtimeWorkdir: "C:/workspace-a",
    globalWorkdir: "C:/global",
  };

  assert.equal(
    resolveEffectiveConversationWorkdir({
      ...input,
      isAgentMode: true,
      workdirOverride: "C:/explicit",
    }),
    "C:/explicit",
  );
  assert.equal(resolveEffectiveConversationWorkdir({ ...input, isAgentMode: false }), "");
  assert.equal(resolveConversationPromptWorkdir({ ...input, isAgentMode: false }), "C:/workspace-b");
  assert.equal(
    resolveConversationPromptWorkdir({
      isAgentMode: false,
      globalWorkdir: "C:/unrelated-global",
    }),
    "",
  );
});

test("empty text-mode workdir override preserves the conversation cwd for prompts", () => {
  const input = {
    isAgentMode: false,
    workdirOverride: "",
    persistedWorkdir: "C:/workspace-b",
    runtimeWorkdir: "C:/workspace-a",
    globalWorkdir: "C:/global",
  };

  assert.equal(resolveEffectiveConversationWorkdir(input), "");
  assert.equal(resolveConversationPromptWorkdir(input), "C:/workspace-b");
});

test("a remote workspace identity string resolves to an empty workdir", () => {
  // 这是「远程工作空间」一连串故障的共同起点，值得显式锁住：
  // 身份串（ssh://…）不是本地路径，绝不能下发给本地文件系统/命令子系统，所以
  // effectiveWorkdir 被刻意清空 —— 它是**预期状态，不是错误**。
  //
  // 推论（改这条链路前必须先想清楚）：
  // - 「有没有项目」不能只看 workdir，要看项目身份串（runAgentConversationTurn 的门）；
  // - 按项目分组/归属/查关联的地方必须用身份串（SSH 关联、隧道归属）；
  // - 工具层没有本地根，就不能注册以本地根为作用域的工具。
  // 上面每一条都曾因「拿空 workdir 当正常值」而炸过。
  const remote = "ssh://host-1/srv/app";

  assert.equal(
    resolveEffectiveConversationWorkdir({
      isAgentMode: true,
      persistedWorkdir: remote,
      runtimeWorkdir: remote,
      globalWorkdir: "C:/global",
    }),
    "",
  );
  assert.equal(
    resolveEffectiveConversationWorkdir({
      isAgentMode: true,
      workdirOverride: remote,
      globalWorkdir: "C:/global",
    }),
    "",
  );
  // 关键：不得「回退到全局 workdir」。那会把本地目录悄悄变成远程会话的工作根。
  assert.notEqual(
    resolveEffectiveConversationWorkdir({
      isAgentMode: true,
      persistedWorkdir: remote,
      globalWorkdir: "C:/global",
    }),
    "C:/global",
  );
});

// 用户实测复现：在远程文件夹下发消息，会话却归到了另一个本地工作空间。
// 根因是 globalWorkdir 在设置加载时被 normalizeWorkdir 从身份串改写成**本地默认项目**
// （Rust default_project_workdir），于是「持久化/运行时都为空」的新会话兜底到了它。
// 所以这里刻意让 globalWorkdir 就是那个本地默认项目 —— 这正是真实配置的形态。
const LOCAL_DEFAULT_PROJECT = "C:\\Users\\tester\\.liveagent\\default-project";
const REMOTE_IDENTITY = "ssh://e9635c44-f026-41b7-8ca8-19e42d9b9fdf/data/upload";

test("an active remote workspace must not fall back to the local default project", () => {
  const resolution = {
    isAgentMode: true,
    persistedWorkdir: undefined,
    runtimeWorkdir: undefined,
    globalWorkdir: LOCAL_DEFAULT_PROJECT,
    activeWorkspaceIsRemote: true,
  };

  // 工具侧：没有本地根，绝不能让本地默认项目当根（否则 agent 同时看到两个根）。
  assert.equal(resolveEffectiveConversationWorkdir(resolution), "");
  assert.equal(resolveConversationPromptWorkdir(resolution), "");
  // 反向对照：同一个输入若没有这个事实，就会掉进本地默认项目 —— 证明这条断言不是空转。
  assert.equal(
    resolveEffectiveConversationWorkdir({ ...resolution, activeWorkspaceIsRemote: false }),
    LOCAL_DEFAULT_PROJECT,
  );
});

test("an active remote workspace still honors an explicit workdir override", () => {
  // 队列排空 / 网关代发可以针对**非活动**会话，那条会话可能本来就是本地的。
  // 一刀切「远程 → 空」会把它的本地根吃掉，所以显式覆盖必须优先于远程短路。
  assert.equal(
    resolveEffectiveConversationWorkdir({
      isAgentMode: true,
      workdirOverride: "C:/other-project",
      globalWorkdir: LOCAL_DEFAULT_PROJECT,
      activeWorkspaceIsRemote: true,
    }),
    "C:/other-project",
  );
});

test("persisted cwd is the project path, not the tool workdir, for remote workspaces", () => {
  // 落盘 cwd 同时是侧栏归属键：`chat_history_list` 按 TRIM(COALESCE(cwd,'')) = ?1
  // 精确匹配，而远程项目的 scope 就是身份串。所以它与工具 workdir 的取值规则相反。
  assert.equal(
    resolveConversationPersistedCwd({
      activeWorkspaceIsRemote: true,
      workspaceProjectPath: REMOTE_IDENTITY,
      effectiveWorkdir: "",
      persistedWorkdir: undefined,
    }),
    REMOTE_IDENTITY,
  );
  // 这就是用户看到的症状：会话落盘成本地默认项目，于是出现在另一个工作空间下。
  assert.notEqual(
    resolveConversationPersistedCwd({
      activeWorkspaceIsRemote: true,
      workspaceProjectPath: REMOTE_IDENTITY,
      effectiveWorkdir: "",
      persistedWorkdir: undefined,
    }),
    LOCAL_DEFAULT_PROJECT,
  );
});

test("persisted cwd prefers an explicit override so background sends keep their own project", () => {
  // 镜像错误：活动项目是远程，但被代发的是另一个本地会话。若用活动项目的身份串
  // 顶掉，本地会话会在后台代发后被悄悄改归到远程项目组。
  assert.equal(
    resolveConversationPersistedCwd({
      workdirOverride: "C:/other-project",
      activeWorkspaceIsRemote: true,
      workspaceProjectPath: REMOTE_IDENTITY,
      effectiveWorkdir: "",
    }),
    "C:/other-project",
  );
});

test("persisted cwd keeps an existing remote key instead of clearing it", () => {
  // cwd 的 upsert 是 `cwd = excluded.cwd`，传空即**清空** —— 会话随即从远程项目下消失。
  assert.equal(
    resolveConversationPersistedCwd({
      activeWorkspaceIsRemote: false,
      workspaceProjectPath: "",
      effectiveWorkdir: "",
      persistedWorkdir: REMOTE_IDENTITY,
    }),
    REMOTE_IDENTITY,
  );
  // 本地会话且没有任何候选时才留空（掉进「无工作空间」桶），不能凭空造一个 key。
  assert.equal(
    resolveConversationPersistedCwd({
      activeWorkspaceIsRemote: false,
      workspaceProjectPath: "",
      effectiveWorkdir: "",
      persistedWorkdir: "C:/workspace-a",
    }),
    undefined,
  );
  assert.equal(
    resolveConversationPersistedCwd({
      activeWorkspaceIsRemote: false,
      workspaceProjectPath: "C:/workspace-a",
      effectiveWorkdir: "C:/workspace-a",
    }),
    "C:/workspace-a",
  );
});

test("a conversation without a project anchor keeps its own workdir instead of being cleared", () => {
  // text（非 agent）模式没有项目锚点：effectiveWorkdir 恒为空，也没有全局兜底。
  // 不拿「该会话自己的本地 workdir」兜底，每发一轮都会把 cwd 写成空 —— 而 upsert 是
  // `cwd = excluded.cwd`，传空即**清空归属**，本地会话从自己的项目侧栏掉进「无工作空间」。
  assert.equal(
    resolveConversationPersistedCwd({
      activeWorkspaceIsRemote: false,
      workspaceProjectPath: "C:/active-project",
      effectiveWorkdir: "",
      persistedWorkdir: "C:/workspace-a",
      promptWorkdir: "C:/workspace-a",
    }),
    "C:/workspace-a",
  );
  // 活动项目路径只在 agent 模式下才是锚点：text 模式不得借它悄悄改归属，
  // 一个候选都没有时也必须留空（掉进「无工作空间」桶），不能凭空造 key。
  assert.equal(
    resolveConversationPersistedCwd({
      activeWorkspaceIsRemote: false,
      workspaceProjectPath: "C:/active-project",
      effectiveWorkdir: "",
      persistedWorkdir: "",
      promptWorkdir: "",
    }),
    undefined,
  );
  // agent 模式下这个兜底与 effectiveWorkdir 同源，不引入第二个答案。
  assert.equal(
    resolveConversationPersistedCwd({
      activeWorkspaceIsRemote: false,
      workspaceProjectPath: "",
      effectiveWorkdir: "C:/workspace-a",
      promptWorkdir: "C:/workspace-a",
    }),
    "C:/workspace-a",
  );
});

test("a text-mode conversation under a remote workspace keeps the identity, not the local default project", () => {
  // 与上面 agent 用例同一条复现路径的 text 版本：promptWorkdir 已被
  // rejectRemoteWorkdir 剥成空串，绝不能因此回退到 globalWorkdir（= 本地默认项目）。
  const resolution = {
    isAgentMode: false,
    persistedWorkdir: REMOTE_IDENTITY,
    runtimeWorkdir: undefined,
    globalWorkdir: LOCAL_DEFAULT_PROJECT,
    activeWorkspaceIsRemote: true,
  };
  const promptWorkdir = resolveConversationPromptWorkdir(resolution);
  assert.equal(promptWorkdir, "");
  assert.equal(
    resolveConversationPersistedCwd({
      activeWorkspaceIsRemote: true,
      workspaceProjectPath: REMOTE_IDENTITY,
      effectiveWorkdir: resolveEffectiveConversationWorkdir(resolution),
      persistedWorkdir: resolution.persistedWorkdir,
      promptWorkdir,
    }),
    REMOTE_IDENTITY,
  );
});

test("successful move updates an existing idle GUI runtime entry", () => {
  const runtimeCache = new Map([
    ["current", { isSending: false, workdir: "C:/workspace-a" }],
  ]);
  const updates = [];

  assert.equal(
    syncMovedConversationRuntimeWorkdir({
      conversationId: "current",
      cwd: "C:/workspace-b",
      runtimeCache,
      isConversationRunning: () => false,
      updateConversationRuntimeEntry(id, updater) {
        const next = updater(runtimeCache.get(id));
        runtimeCache.set(id, next);
        updates.push(id);
      },
    }),
    true,
  );
  assert.equal(runtimeCache.get("current").workdir, "C:/workspace-b");
  assert.deepEqual(updates, ["current"]);
});

test("move does not rewrite sending, running, or missing GUI runtime entries", () => {
  const runtimeCache = new Map([
    ["sending", { isSending: true, workdir: "C:/workspace-a" }],
    ["running", { isSending: false, workdir: "C:/workspace-a" }],
  ]);
  const updates = [];
  const sync = (conversationId) =>
    syncMovedConversationRuntimeWorkdir({
      conversationId,
      cwd: "C:/workspace-b",
      runtimeCache,
      isConversationRunning: (id) => id === "running",
      updateConversationRuntimeEntry(id) {
        updates.push(id);
      },
    });

  assert.equal(sync("sending"), false);
  assert.equal(sync("running"), false);
  assert.equal(sync("missing"), false);
  assert.deepEqual(updates, []);
});
