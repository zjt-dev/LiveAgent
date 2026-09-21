import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const SSH_HOST = {
  id: "host-1",
  name: "Prod",
  description: "Production host",
  host: "ssh.example.test",
  port: 22,
  username: "deploy",
  authType: "privateKey",
  password: "secret-password",
  privateKey: "secret-key",
  privateKeyPath: "/Users/me/.ssh/id_rsa",
  privateKeyPassphrase: "secret-passphrase",
  proxy: {
    type: "socks5",
    url: "",
    port: 0,
    username: "",
    password: "",
  },
};

function createToolCall(args) {
  return {
    type: "toolCall",
    id: "call-ssh",
    name: "SSHManager",
    arguments: args,
  };
}

function createSshSession(overrides = {}) {
  return {
    id: "ssh-session-1",
    projectPathKey: "/workspace",
    cwd: "/workspace",
    shell: "ssh",
    title: "SSHManager: Prod",
    kind: "ssh",
    ssh: {
      hostId: "host-1",
      hostName: "Prod",
      username: "deploy",
      host: "ssh.example.test",
      port: 22,
      authType: "privateKey",
      status: "connected",
      sftpEnabled: true,
    },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    running: true,
    ...overrides,
  };
}

async function buildRegistry(params = {}) {
  const loader = createTsModuleLoader();
  const { buildBuiltinToolRegistry } = loader.loadModule("src/lib/tools/builtinRegistry.ts");
  const { createFileToolState } = loader.loadModule("src/lib/tools/fileToolState.ts");
  return buildBuiltinToolRegistry({
    workdir: "/workspace",
    providerId: "codex",
    fileState: createFileToolState(),
    skillsEnabled: false,
    runtimeScope: "chat",
    currentChatModel: { customProviderId: "p", model: "m" },
    getMcpSettings: () => ({ selected: [], servers: [] }),
    sshHosts: [SSH_HOST],
    associatedSshHostIds: ["host-1"],
    tunnelProjectPathKey: "/workspace",
    ...params,
  });
}

test("SSHManager is auto-registered by project hosts, runtime, and remote switch", async () => {
  const registry = await buildRegistry();
  assert.equal(registry.hasTool("SSHManager"), true);
  assert.equal(registry.metadataByName.get("SSHManager").kind, "ssh_manager");
  assert.equal(registry.metadataByName.get("SSHManager").displayCategory, "terminal");

  assert.equal(
    (
      await buildRegistry({
        associatedSshHostIds: [],
      })
    ).hasTool("SSHManager"),
    false,
  );

  assert.equal(
    (
      await buildRegistry({
        runtimeScope: "cron_auto_prompt",
      })
    ).hasTool("SSHManager"),
    false,
  );

  assert.equal(
    (
      await buildRegistry({
        sshManagerRemoteAllowed: false,
      })
    ).hasTool("SSHManager"),
    false,
  );
});

// 远程工作空间（workdir 为空）的工具面。
//
// 背景：`createFsTools` / `createShellTools` / `createMcpManagerTools` / `createSSHManagerTools`
// 都会 `new ToolPathResolver({ workdir })`，而它构造期调 `normalizeRootPath(workdir)`，
// 空串直接抛 "Workspace root is not configured"（pathNormalization.ts:62）。fsTools 排在
// bundle 列表首位，所以异常从它抛出 —— 整个注册表建不起来，整轮对话死在发请求之前。
//
// 现在按「有没有本地工作空间」裁剪：workdir 为空时不注册以本地根为作用域的工具
// （fs / shell / skills / cron / McpManager / memory / terminal），只留 SSHManager 等。
// 以本地根为作用域的工具（名字取自各 bundle 的实际定义，别凭印象写）。
const LOCAL_WORKSPACE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "List",
  "Delete",
  "Bash",
  "ManagedProcess",
  "ReadTerminal",
  "McpManager",
  "MemoryManager",
];

test("a remote workspace still registers SSHManager with an empty workdir", async () => {
  // 远程工作空间下 workdir 必然为空：身份串（ssh://…）不是本地路径，会在解析层被清空。
  // SSHManager 的注册门槛是 `projectPathKey.trim()` 为真，只能靠项目身份串兜住。
  const registry = await buildRegistry({
    workdir: "",
    tunnelProjectPathKey: "ssh://host-1/srv/app",
  });
  assert.equal(registry.hasTool("SSHManager"), true);
  // 本地工作空间类工具一个都不该在：它们的作用域（本地根）不存在。
  for (const name of LOCAL_WORKSPACE_TOOLS) {
    assert.equal(
      registry.hasTool(name),
      false,
      `${name} must not be registered without a local root`,
    );
  }
});

test("a local workspace still registers the whole local tool surface", async () => {
  // 正向对照：有本地根时这些工具必须都在。缺了这条，上面那组 doesNotMatch 式的断言
  // 可能因为「名字写错」而平凡通过。
  const registry = await buildRegistry({
    workdir: "/workspace",
    tunnelProjectPathKey: "/workspace",
  });
  for (const name of LOCAL_WORKSPACE_TOOLS) {
    assert.equal(registry.hasTool(name), true, `${name} must be registered for a local root`);
  }
});

test("an empty workdir no longer aborts the whole tool registry", async () => {
  // 构造本身不能抛 —— 这是本次修复的核心：空 workdir 曾让注册表构造直接失败。
  const registry = await buildRegistry({
    workdir: "",
    tunnelProjectPathKey: "",
  });
  // 两层都空 → 没有项目身份可依，SSHManager 不注册（而不是整个注册表炸掉）。
  assert.equal(registry.hasTool("SSHManager"), false);
});

test("SSHManager list_hosts redacts configured secrets", async () => {
  const loader = createTsModuleLoader();
  const { createSSHManagerTools } = loader.loadModule("src/lib/tools/sshManagerTools.ts");
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const result = await bundle.executeToolCall(createToolCall({ action: "list_hosts" }));
  assert.equal(result.isError, false);
  assert.deepEqual(result.details.hosts, [
    {
      host_id: "host-1",
      name: "Prod",
      endpoint: "deploy@ssh.example.test:22",
      username: "deploy",
      host: "ssh.example.test",
      port: 22,
      authType: "privateKey",
      credentialConfigured: true,
      credentialStatus: "saved",
    },
  ]);
  assert.doesNotMatch(result.content[0].text, /secret|privateKeyPath|passphrase/i);
  assert.match(result.content[0].text, /credential=saved/);
  assert.match(result.content[0].text, /do not ask the user/i);
  assert.equal(JSON.stringify(result.details).includes("secret"), false);
});

test("SSHManager create_session defaults SFTP on and refuses SSH prompts", async () => {
  const invocations = [];
  const changes = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_create_ssh") {
            return { session: createSshSession(), output: "", truncated: false };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule("src/lib/tools/sshManagerTools.ts");
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
    onSshSessionsChanged: (change) => changes.push(change),
  });

  const result = await bundle.executeToolCall(
    createToolCall({ action: "create_session", host_id: "host-1" }),
  );
  assert.equal(result.isError, false);
  assert.equal(result.details.session.session_id, "ssh-session-1");
  assert.deepEqual(changes, [{ action: "create", projectPathKey: "/workspace" }]);
  assert.deepEqual(invocations, [
    {
      command: "terminal_create_ssh",
      args: {
        cwd: "/workspace",
        project_path_key: "/workspace",
        ssh_host_id: "host-1",
        title: undefined,
        cols: undefined,
        rows: undefined,
        sftp_enabled: true,
      },
    },
  ]);
});

test("SSHManager exec auto-creates a visible session before running command", async () => {
  const invocations = [];
  const changes = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return { sessions: [] };
          }
          if (command === "terminal_create_ssh") {
            return { session: createSshSession(), output: "", truncated: false };
          }
          if (command === "terminal_ssh_exec") {
            return {
              sessionId: args.session_id,
              command: args.command,
              cwd: args.cwd,
              exitCode: 0,
              stdout: "ok\n",
              stderr: "",
              timedOut: false,
            };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule("src/lib/tools/sshManagerTools.ts");
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
    onSshSessionsChanged: (change) => changes.push(change),
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "exec",
      host_id: "host-1",
      command: "pwd",
      cwd: "/srv/app",
      timeout_ms: 5_000,
    }),
  );
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /stdout:\nok/);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["terminal_list", "terminal_create_ssh", "terminal_ssh_exec"],
  );
  assert.equal(invocations[2].args.session_id, "ssh-session-1");
  assert.equal(invocations[2].args.command, "pwd");
  assert.equal(invocations[2].args.cwd, "/srv/app");
  assert.deepEqual(changes, [{ action: "create", projectPathKey: "/workspace" }]);
  assert.equal(result.details.session_reused, false);
  assert.equal(result.details.session_created, true);
});

test("SSHManager exec abort requests runtime cancellation", async () => {
  let resolveExec;
  const execPromise = new Promise((resolve) => {
    resolveExec = resolve;
  });
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return { sessions: [createSshSession()] };
          }
          if (command === "terminal_ssh_exec") {
            return execPromise;
          }
          if (command === "runtime_cancel") {
            return { cancelled: true };
          }
          throw new Error("unexpected invoke " + command);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule("src/lib/tools/sshManagerTools.ts");
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });
  const controller = new AbortController();

  const resultPromise = bundle.executeToolCall(
    createToolCall({
      action: "exec",
      host_id: "host-1",
      command: "sleep 30",
    }),
    controller.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await resultPromise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Cancelled/);
  const execCall = invocations.find(
    (call) =>
      call.command === "terminal_ssh_exec" &&
      typeof call.args.run_id === "string" &&
      call.args.run_id.startsWith("ssh-exec:call-ssh:"),
  );
  assert.ok(execCall, "exec must carry a unique ssh-exec run id");
  assert.ok(
    invocations.some(
      (call) => call.command === "runtime_cancel" && call.args.run_id === execCall.args.run_id,
    ),
    "runtime cancel must target the same run id as the exec call",
  );

  resolveExec({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
});

test("SSHManager exec reuses an existing running SSH session for the same host", async () => {
  const invocations = [];
  const changes = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return {
              sessions: [
                createSshSession({
                  id: "older-disconnected",
                  running: false,
                  createdAt: 1,
                }),
                createSshSession({
                  id: "ssh-session-newer",
                  createdAt: 3,
                  ssh: { ...createSshSession().ssh, sftpEnabled: false },
                }),
                createSshSession({
                  id: "ssh-session-reused",
                  createdAt: 2,
                  ssh: { ...createSshSession().ssh, sftpEnabled: false },
                }),
              ],
            };
          }
          if (command === "terminal_ssh_exec") {
            return {
              sessionId: args.session_id,
              command: args.command,
              exitCode: 0,
              stdout: "reused\n",
              stderr: "",
              timedOut: false,
            };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule("src/lib/tools/sshManagerTools.ts");
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
    onSshSessionsChanged: (change) => changes.push(change),
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "exec",
      host_id: "host-1",
      command: "whoami",
    }),
  );
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /session_reused: true/);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["terminal_list", "terminal_ssh_exec"],
  );
  assert.equal(invocations[1].args.session_id, "ssh-session-reused");
  assert.deepEqual(changes, []);
  assert.equal(result.details.session_strategy, "reuse_or_create");
  assert.equal(result.details.session_reused, true);
  assert.equal(result.details.session_created, false);
});

test("SSHManager exec can intentionally create an additional SSH session", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_create_ssh") {
            return {
              session: createSshSession({
                id: "ssh-session-second",
                title: args.title,
              }),
              output: "",
              truncated: false,
            };
          }
          if (command === "terminal_ssh_exec") {
            return {
              sessionId: args.session_id,
              command: args.command,
              exitCode: 0,
              stdout: "second\n",
              stderr: "",
              timedOut: false,
            };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule("src/lib/tools/sshManagerTools.ts");
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "exec",
      host_id: "host-1",
      session_strategy: "new",
      title: "isolated diagnostics",
      command: "hostname",
    }),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["terminal_create_ssh", "terminal_ssh_exec"],
  );
  assert.equal(invocations[0].args.title, "isolated diagnostics");
  assert.equal(invocations[1].args.session_id, "ssh-session-second");
  assert.equal(result.details.session_strategy, "new");
  assert.equal(result.details.session_reused, false);
  assert.equal(result.details.session_created, true);
});

test("SSHManager can require an existing session without implicitly creating one", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return { sessions: [] };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule("src/lib/tools/sshManagerTools.ts");
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "exec",
      host_id: "host-1",
      session_strategy: "require_existing",
      command: "pwd",
    }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No reusable SSH session exists/);
  assert.deepEqual(invocations, [
    {
      command: "terminal_list",
      args: { project_path_key: "/workspace" },
    },
  ]);
});

test("SSHManager never dials keyboard-interactive hosts itself", async () => {
  const kbiHost = {
    ...SSH_HOST,
    id: "host-kbi",
    name: "Jump",
    authType: "keyboardInteractive",
    password: "",
    privateKey: "",
    privateKeyPath: "",
    privateKeyPassphrase: "",
  };
  const kbiSession = createSshSession({
    id: "ssh-kbi-running",
    ssh: { ...createSshSession().ssh, hostId: "host-kbi", authType: "keyboardInteractive" },
  });
  const invocations = [];
  let listedSessions = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return { sessions: listedSessions };
          }
          if (command === "terminal_ssh_exec") {
            return {
              sessionId: args.session_id,
              command: args.command,
              exitCode: 0,
              stdout: "ok\n",
              stderr: "",
              timedOut: false,
            };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule("src/lib/tools/sshManagerTools.ts");
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [kbiHost],
    associatedHostIds: ["host-kbi"],
  });

  // create_session is refused outright, without touching the terminal runtime.
  const created = await bundle.executeToolCall(
    createToolCall({ action: "create_session", host_id: "host-kbi" }),
  );
  assert.equal(created.isError, true);
  assert.match(created.content[0].text, /键盘交互/);
  assert.deepEqual(invocations, []);

  // exec without a running session errors instead of implicitly connecting.
  const noSession = await bundle.executeToolCall(
    createToolCall({ action: "exec", host_id: "host-kbi", command: "pwd" }),
  );
  assert.equal(noSession.isError, true);
  assert.match(noSession.content[0].text, /键盘交互/);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["terminal_list"],
  );

  // exec with a user-opened running session reuses it.
  invocations.length = 0;
  listedSessions = [kbiSession];
  const reused = await bundle.executeToolCall(
    createToolCall({ action: "exec", host_id: "host-kbi", command: "whoami" }),
  );
  assert.equal(reused.isError, false);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["terminal_list", "terminal_ssh_exec"],
  );
  assert.equal(invocations[1].args.session_id, "ssh-kbi-running");
  assert.equal(reused.details.session_reused, true);

  // session_strategy=new never dials either.
  invocations.length = 0;
  const forcedNew = await bundle.executeToolCall(
    createToolCall({
      action: "exec",
      host_id: "host-kbi",
      session_strategy: "new",
      command: "pwd",
    }),
  );
  assert.equal(forcedNew.isError, true);
  assert.match(forcedNew.content[0].text, /键盘交互/);
  assert.deepEqual(invocations, []);
});

test("SSHManager rejects conflicting session_id and new session strategy", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule("src/lib/tools/sshManagerTools.ts");
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "exec",
      session_id: "ssh-session-1",
      session_strategy: "new",
      command: "pwd",
    }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cannot be combined/);
  assert.deepEqual(invocations, []);
});

test("SSHManager validates current project sessions before SFTP actions", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return { sessions: [createSshSession()] };
          }
          if (command === "sftp_list") {
            return { path: ".", entries: [] };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule("src/lib/tools/sshManagerTools.ts");
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "sftp_list",
      session_id: "ssh-session-1",
      path: "/var/log",
    }),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(invocations, [
    {
      command: "terminal_list",
      args: { project_path_key: "/workspace" },
    },
    {
      command: "sftp_list",
      args: {
        session_id: "ssh-session-1",
        project_path_key: "/workspace",
        workdir: "/workspace",
        side: "remote",
        path: "/var/log",
      },
    },
  ]);
});

test("SSHManager SFTP actions reuse SFTP-enabled host sessions", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return {
              sessions: [
                createSshSession({
                  id: "ssh-no-sftp",
                  ssh: { ...createSshSession().ssh, sftpEnabled: false },
                }),
                createSshSession({
                  id: "ssh-sftp-reused",
                  ssh: { ...createSshSession().ssh, sftpEnabled: true },
                }),
              ],
            };
          }
          if (command === "sftp_list") {
            return { path: "/tmp", entries: [] };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule("src/lib/tools/sshManagerTools.ts");
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "sftp_list",
      host_id: "host-1",
      path: "/tmp",
    }),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["terminal_list", "sftp_list"],
  );
  assert.equal(invocations[1].args.session_id, "ssh-sftp-reused");
  assert.equal(result.details.session_reused, true);
  assert.equal(result.details.session_created, false);
});

test("SSHManager SFTP actions create a new session when no SFTP-enabled session exists", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return {
              sessions: [
                createSshSession({
                  id: "ssh-no-sftp",
                  ssh: { ...createSshSession().ssh, sftpEnabled: false },
                }),
              ],
            };
          }
          if (command === "terminal_create_ssh") {
            return {
              session: createSshSession({ id: "ssh-created-for-sftp" }),
              output: "",
              truncated: false,
            };
          }
          if (command === "sftp_stat") {
            return { path: "/tmp", kind: "dir" };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule("src/lib/tools/sshManagerTools.ts");
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "sftp_stat",
      host_id: "host-1",
      path: "/tmp",
    }),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["terminal_list", "terminal_create_ssh", "sftp_stat"],
  );
  assert.equal(invocations[1].args.sftp_enabled, true);
  assert.equal(invocations[2].args.session_id, "ssh-created-for-sftp");
  assert.equal(result.details.session_reused, false);
  assert.equal(result.details.session_created, true);
});

test("SSHManager SFTP actions can intentionally create an additional SFTP-enabled session", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_create_ssh") {
            return {
              session: createSshSession({
                id: "ssh-extra-sftp",
                title: args.title,
              }),
              output: "",
              truncated: false,
            };
          }
          if (command === "sftp_list") {
            return { path: "/var", entries: [] };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule("src/lib/tools/sshManagerTools.ts");
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const result = await bundle.executeToolCall(
    createToolCall({
      action: "sftp_list",
      host_id: "host-1",
      session_strategy: "new",
      title: "isolated sftp",
      path: "/var",
    }),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(
    invocations.map((call) => call.command),
    ["terminal_create_ssh", "sftp_list"],
  );
  assert.equal(invocations[0].args.title, "isolated sftp");
  assert.equal(invocations[0].args.sftp_enabled, true);
  assert.equal(invocations[1].args.session_id, "ssh-extra-sftp");
  assert.equal(result.details.session_strategy, "new");
  assert.equal(result.details.session_reused, false);
  assert.equal(result.details.session_created, true);
});

test("SSHManager rejects unauthorized hosts and cross-project sessions before invoking actions", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return {
              sessions: [
                createSshSession({
                  id: "other-session",
                  ssh: { ...createSshSession().ssh, hostId: "other-host" },
                }),
              ],
            };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule("src/lib/tools/sshManagerTools.ts");
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    workdir: "/workspace",
    projectPathKey: "/workspace",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  const hostResult = await bundle.executeToolCall(
    createToolCall({ action: "exec", host_id: "other-host", command: "id" }),
  );
  assert.equal(hostResult.isError, true);
  assert.match(hostResult.content[0].text, /not associated/);

  const sessionResult = await bundle.executeToolCall(
    createToolCall({ action: "read_session", session_id: "other-session" }),
  );
  assert.equal(sessionResult.isError, true);
  assert.match(sessionResult.content[0].text, /not authorized|not found/);
  assert.deepEqual(invocations, [
    {
      command: "terminal_list",
      args: { project_path_key: "/workspace" },
    },
  ]);
});

// ---------------------------------------------------------------------------
// 远程工作空间（无本地根）下，sftp_upload / sftp_download 不得解析出本地路径
//
// 本地侧边界由 pathResolver 的根决定，而传输分支只接受 scope === "workspace" 的结果。
// 所以「拿什么当根」=「传输能碰本地哪些文件」。曾经为了满足 resolver 的构造，在无本地
// 根时拿用户 home 兜底 —— 那等于把整个用户目录开给上传通道：实测 ~/.ssh/id_rsa 与
// ~/.liveagent/config.sqlite（内含 SSH 密码与私钥）都会解析成 scope=workspace 被放行，
// 比同场景下刻意删掉的本地文件工具还宽。现在无本地根就一律拒绝。
// ---------------------------------------------------------------------------
test("SSHManager refuses local-side SFTP transfers when there is no local workspace", async () => {
  const invocations = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          invocations.push({ command, args });
          if (command === "terminal_list") {
            return { sessions: [createSshSession()] };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    },
  });
  const { createSSHManagerTools } = loader.loadModule("src/lib/tools/sshManagerTools.ts");
  const bundle = createSSHManagerTools({
    enabled: true,
    runtimeScope: "chat",
    // 远程工作空间下 effectiveWorkdir 为空串。
    workdir: "",
    projectPathKey: "ssh://host-1/data/upload",
    hosts: [SSH_HOST],
    associatedHostIds: ["host-1"],
  });

  // 工具本身必须注册得起来 —— 否则 agent 连远端命令都跑不了。
  assert.ok(bundle.tools.some((tool) => tool.name === "SSHManager"));

  for (const action of ["sftp_upload", "sftp_download"]) {
    invocations.length = 0;
    const result = await bundle.executeToolCall(
      createToolCall({
        action,
        host_id: "host-1",
        local_path: "/Users/me/.ssh/id_rsa",
        remote_path: "/tmp/x",
      }),
    );
    assert.equal(result.isError, true, `${action} must fail without a local root`);
    assert.match(result.content[0].text, /no local root/);
    // 关键：不得真的发起传输。
    assert.equal(
      invocations.some((call) => call.command === "sftp_transfer"),
      false,
      `${action} must not start a transfer`,
    );
  }
});
