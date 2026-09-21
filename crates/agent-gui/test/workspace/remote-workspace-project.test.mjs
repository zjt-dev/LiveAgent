import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const remote = loader.loadModule("@liveagent/ui/lib/workspaceRemoteProject.ts");
const settingsProjects = loader.loadModule("@liveagent/ui/lib/settings/workspaceProjects.ts");
const settings = loader.loadModule("@liveagent/ui/lib/settings/index.ts");
const chatPageRuntime = loader.loadModule(
  "@liveagent/app/pages/chat/runtime/chatPageRuntime.ts",
);

const REMOTE_WORKDIR = "ssh://e9635c44-f026-41b7-8ca8-19e42d9b9fdf/data/cursor2api";

const {
  buildRemoteWorkspacePath,
  buildRemoteWorkspacePrompt,
  classifyRemoteWorkspaceError,
  createRemoteWorkspaceProject,
  findUsableSessionForHost,
  isRemoteWorkspaceProject,
  isRemoteWorkspaceSessionUsable,
  normalizeRemoteDirectoryPath,
  parseRemoteWorkspacePath,
  remoteDirectoryBreadcrumbs,
  remoteDirectoryListingPath,
  remoteDirectoryParentPath,
  remoteWorkspaceDirectoryCheck,
  remoteWorkspaceDirectoryEntries,
  remoteWorkspaceDisplayTarget,
  remoteWorkspaceHostOptions,
  remoteWorkspaceRoot,
  remoteWorkspaceSessionIssue,
  resolveRemoteDirectoryPath,
  selectableRemoteWorkspaceSessions,
} = remote;

function sshSession(overrides = {}) {
  return {
    id: "s1",
    projectPathKey: "/local/project",
    cwd: "/local/project",
    shell: "",
    title: "ssh",
    kind: "ssh",
    ssh: {
      hostId: "host-1",
      hostName: "prod",
      username: "deploy",
      host: "10.0.0.1",
      port: 22,
      authType: "privateKey",
      status: "connected",
      reconnectAttempt: 0,
      reconnectMaxAttempts: 3,
      sftpEnabled: true,
    },
    cols: 80,
    rows: 24,
    createdAt: 0,
    updatedAt: 0,
    running: true,
    ...overrides,
  };
}

/** 【SSH 隧道】里的一条已添加主机。只带选择器会读到的字段。 */
function sshHost(overrides = {}) {
  return {
    id: "host-1",
    name: "prod",
    host: "10.0.0.1",
    port: 22,
    username: "deploy",
    ...overrides,
  };
}

describe("remote workspace identity path", () => {
  test("round-trips host and absolute root", () => {
    const path = buildRemoteWorkspacePath("host-1", "/srv/app");
    assert.equal(path, "ssh://host-1/srv/app");
    assert.deepEqual(parseRemoteWorkspacePath(path), { hostId: "host-1", rootPath: "/srv/app" });
  });

  test("normalizes the root and forces it absolute", () => {
    assert.equal(buildRemoteWorkspacePath("h", "srv//app/"), "ssh://h/srv/app");
    assert.equal(buildRemoteWorkspacePath("h", "/srv/./app"), "ssh://h/srv/app");
    assert.equal(buildRemoteWorkspacePath("h", "/srv/x/../app"), "ssh://h/srv/app");
  });

  test("refuses an empty host or a home-only root", () => {
    // `.` 表示家目录，不是一个可持久化的根目录身份。
    assert.equal(buildRemoteWorkspacePath("", "/srv/app"), "");
    assert.equal(buildRemoteWorkspacePath("h", "."), "");
    assert.equal(buildRemoteWorkspacePath("h", ""), "");
  });

  test("parses nothing out of local paths", () => {
    for (const value of ["/srv/app", "C:\\projects\\app", "ssh://", "ssh://host", "", null]) {
      assert.equal(parseRemoteWorkspacePath(value), null, String(value));
    }
  });

  test("keeps the hostId in the identity so two hosts can share a remote path", () => {
    const first = buildRemoteWorkspacePath("host-a", "/srv/app");
    const second = buildRemoteWorkspacePath("host-b", "/srv/app");
    assert.notEqual(
      settingsProjects.workspaceProjectPathKey(first),
      settingsProjects.workspaceProjectPathKey(second),
    );
  });
});

describe("createRemoteWorkspaceProject", () => {
  test("marks the project remote and keeps the real root in remote.rootPath", () => {
    const project = createRemoteWorkspaceProject({
      hostId: "host-1",
      hostName: "prod",
      rootPath: "/srv/app/",
    });
    assert.equal(project.kind, "remote");
    assert.equal(project.path, "ssh://host-1/srv/app");
    assert.equal(project.name, "app");
    assert.deepEqual(project.remote, {
      hostId: "host-1",
      hostName: "prod",
      rootPath: "/srv/app",
    });
    assert.equal(isRemoteWorkspaceProject(project), true);
    assert.equal(remoteWorkspaceRoot(project).rootPath, "/srv/app");
  });

  test("falls back to hostId when no host label is given", () => {
    const project = createRemoteWorkspaceProject({
      hostId: "host-1",
      hostName: "  ",
      rootPath: "/srv/app",
    });
    assert.equal(project.remote.hostName, "host-1");
  });

  test("throws instead of producing a project without a remote root", () => {
    assert.throws(() =>
      createRemoteWorkspaceProject({ hostId: "", hostName: "prod", rootPath: "/srv/app" }),
    );
  });

  test("recovers the root from the identity path when remote is missing", () => {
    const project = { path: "ssh://host-9/opt/data", kind: "remote" };
    assert.equal(isRemoteWorkspaceProject(project), true);
    assert.equal(remoteWorkspaceRoot(project).hostId, "host-9");
    assert.equal(remoteWorkspaceRoot(project).hostName, "host-9");
    assert.equal(remoteWorkspaceDisplayTarget(project), "host-9:/opt/data");
  });

  test("local projects stay non-remote", () => {
    assert.equal(isRemoteWorkspaceProject({ path: "/srv/app" }), false);
    assert.equal(isRemoteWorkspaceProject({ path: "C:\\projects\\app" }), false);
    assert.equal(remoteWorkspaceDisplayTarget({ path: "/srv/app" }), "");
  });
});

describe("remote directory paths", () => {
  test("folds dot segments instead of dropping them", () => {
    // Rust 侧 normalize_remote_path 会直接丢掉 `..` 段，所以前端必须先把路径
    // 折叠成规范形态，否则「上一级」会静默失效。
    assert.equal(normalizeRemoteDirectoryPath("/a/b/../c"), "/a/c");
    assert.equal(normalizeRemoteDirectoryPath("/a/./b//"), "/a/b");
    assert.equal(normalizeRemoteDirectoryPath(".."), "..");
    assert.equal(normalizeRemoteDirectoryPath("/.."), "/");
    assert.equal(normalizeRemoteDirectoryPath(""), ".");
    assert.equal(normalizeRemoteDirectoryPath("~"), ".");
  });

  test("resolves relative targets against the current directory", () => {
    assert.equal(resolveRemoteDirectoryPath("/a/b", "c"), "/a/b/c");
    assert.equal(resolveRemoteDirectoryPath("/a/b", "../c"), "/a/c");
    assert.equal(resolveRemoteDirectoryPath("/a/b", "/x"), "/x");
    assert.equal(resolveRemoteDirectoryPath(".", "sub"), "sub");
  });

  test("parent is null exactly where there is nowhere to go up", () => {
    assert.equal(remoteDirectoryParentPath("."), null);
    assert.equal(remoteDirectoryParentPath("/"), null);
    assert.equal(remoteDirectoryParentPath("/a"), "/");
    assert.equal(remoteDirectoryParentPath("/a/b"), "/a");
    assert.equal(remoteDirectoryParentPath("a"), ".");
  });

  test("breadcrumbs rebuild cumulative absolute paths", () => {
    assert.deepEqual(remoteDirectoryBreadcrumbs("/srv/app/src"), [
      { label: "/", path: "/" },
      { label: "srv", path: "/srv" },
      { label: "app", path: "/srv/app" },
      { label: "src", path: "/srv/app/src" },
    ]);
    assert.deepEqual(remoteDirectoryBreadcrumbs("."), [{ label: ".", path: "." }]);
  });

  test("uses the canonicalized path reported by the backend", () => {
    // 家目录起手时后端会把 "." 换成真实绝对路径，界面必须跟着换。
    assert.equal(remoteDirectoryListingPath(".", { path: "/home/deploy" }), "/home/deploy");
    assert.equal(remoteDirectoryListingPath("/srv", { path: "" }), "/srv");
  });
});

describe("remote directory listing and validation", () => {
  test("keeps only directories, sorted naturally", () => {
    const entries = remoteWorkspaceDirectoryEntries([
      { name: "zeta", kind: "directory", path: "/z", sizeBytes: 0, mtime: 0 },
      { name: "readme.md", kind: "file", path: "/r", sizeBytes: 1, mtime: 0 },
      { name: "alpha", kind: "directory", path: "/a", sizeBytes: 0, mtime: 0 },
      { name: "v10", kind: "directory", path: "/v10", sizeBytes: 0, mtime: 0 },
      { name: "v9", kind: "directory", path: "/v9", sizeBytes: 0, mtime: 0 },
      // 符号链接可能是文件，不能当工作空间根，直接排除。
      { name: "link", kind: "symlink", path: "/l", sizeBytes: 0, mtime: 0 },
    ]);
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["alpha", "v9", "v10", "zeta"],
    );
  });

  test("a usable root must exist and be a directory", () => {
    assert.equal(remoteWorkspaceDirectoryCheck({ exists: false, entry: null }), "not-found");
    assert.equal(
      remoteWorkspaceDirectoryCheck({ exists: true, entry: { kind: "file" } }),
      "not-directory",
    );
    assert.equal(
      remoteWorkspaceDirectoryCheck({ exists: true, entry: { kind: "symlink" } }),
      "not-directory",
    );
    assert.equal(remoteWorkspaceDirectoryCheck({ exists: true, entry: { kind: "directory" } }), null);
  });
});

describe("ssh session usability", () => {
  test("only connected, running, sftp-enabled ssh sessions are selectable", () => {
    assert.equal(isRemoteWorkspaceSessionUsable(sshSession()), true);
    assert.equal(
      remoteWorkspaceSessionIssue(sshSession({ kind: "local", ssh: null })),
      "not-ssh",
    );
    assert.equal(remoteWorkspaceSessionIssue(sshSession({ running: false })), "finished");
    assert.equal(
      remoteWorkspaceSessionIssue(sshSession({ ssh: { ...sshSession().ssh, status: "reconnecting" } })),
      "disconnected",
    );
    assert.equal(
      remoteWorkspaceSessionIssue(sshSession({ ssh: { ...sshSession().ssh, sftpEnabled: false } })),
      "sftp-disabled",
    );
  });

  test("filters the session list down to usable tunnels", () => {
    const sessions = [
      sshSession({ id: "a" }),
      sshSession({ id: "b", running: false }),
      sshSession({ id: "c", kind: "local", ssh: null }),
      sshSession({ id: "d", ssh: { ...sshSession().ssh, sftpEnabled: false } }),
    ];
    assert.deepEqual(
      selectableRemoteWorkspaceSessions(sessions).map((session) => session.id),
      ["a"],
    );
  });

  test("findUsableSessionForHost matches by host and skips unusable sessions", () => {
    const sessions = [
      sshSession({ id: "dead", ssh: { ...sshSession().ssh, hostId: "host-a", status: "closed" } }),
      sshSession({ id: "no-sftp", ssh: { ...sshSession().ssh, hostId: "host-a", sftpEnabled: false } }),
      sshSession({ id: "live", ssh: { ...sshSession().ssh, hostId: "host-a" } }),
      sshSession({ id: "other", ssh: { ...sshSession().ssh, hostId: "host-b" } }),
    ];
    assert.equal(findUsableSessionForHost(sessions, "host-a")?.id, "live");
    assert.equal(findUsableSessionForHost(sessions, "host-b")?.id, "other");
    // 未知主机与空 id 都不该匹配到任何东西，否则会拿别的隧道的会话去浏览。
    assert.equal(findUsableSessionForHost(sessions, "host-z"), null);
    assert.equal(findUsableSessionForHost(sessions, "  "), null);
  });
});

// 关键交互约定：先列出【SSH 隧道】里已添加的全部主机（无论是否已连接），用户选中
// 一条、连上、再挑目录。曾经的做法是只列「已有可用会话」的隧道，等于要求用户先去
// 终端面板手动建一条会话，把「连接」这个动作藏进了另一个界面。
describe("选择器里的 SSH 隧道列表", () => {
  const hosts = [
    sshHost({ id: "host-b", name: "staging", host: "10.0.0.2", username: "deploy", port: 2222 }),
    sshHost({ id: "host-a", name: "prod", host: "10.0.0.1", username: "root" }),
  ];

  test("lists every added tunnel even when nothing is connected", () => {
    const options = remoteWorkspaceHostOptions(hosts, []);
    assert.deepEqual(
      options.map((option) => option.hostId),
      ["host-a", "host-b"],
    );
    assert.deepEqual(
      options.map((option) => option.connected),
      [false, false],
    );
    assert.deepEqual(
      options.map((option) => option.sessionId),
      [null, null],
    );
  });

  test("marks the tunnel that already has a usable session", () => {
    const options = remoteWorkspaceHostOptions(hosts, [
      sshSession({ id: "s-b", ssh: { ...sshSession().ssh, hostId: "host-b" } }),
    ]);
    const byId = Object.fromEntries(options.map((option) => [option.hostId, option]));
    assert.equal(byId["host-b"].connected, true);
    assert.equal(byId["host-b"].sessionId, "s-b");
    assert.equal(byId["host-a"].connected, false);
    assert.equal(byId["host-a"].sessionId, null);
  });

  test("an unusable session leaves the tunnel unconnected instead of hiding it", () => {
    const options = remoteWorkspaceHostOptions(hosts, [
      sshSession({ id: "s-a", running: false, ssh: { ...sshSession().ssh, hostId: "host-a" } }),
    ]);
    assert.equal(options.length, 2);
    assert.equal(options.find((option) => option.hostId === "host-a").connected, false);
  });

  test("endpoint carries user, host and port so same-named hosts stay apart", () => {
    const options = remoteWorkspaceHostOptions(hosts, []);
    assert.deepEqual(
      options.map((option) => option.endpoint),
      ["root@10.0.0.1:22", "deploy@10.0.0.2:2222"],
    );
  });

  test("falls back to the id as a label and drops hosts without an id", () => {
    const options = remoteWorkspaceHostOptions(
      [sshHost({ id: "host-x", name: "   " }), sshHost({ id: "  ", name: "orphan" })],
      [],
    );
    assert.deepEqual(
      options.map((option) => [option.hostId, option.name]),
      [["host-x", "host-x"]],
    );
  });
});

// 选完目录要立刻把「这个工作空间属于哪条隧道」写进【SSH 隧道】设置的【项目 SSH】，
// 否则用户事后得自己去面板里再勾一次，而那时他多半已经记不得当初选的是哪条。
describe("选中的隧道自动写进项目 SSH 关联", () => {
  test("the host is recorded under the project identity path", () => {
    const prev = {
      ssh: { hosts: [sshHost({ id: "host-a" })], projectHostAssociations: {} },
    };
    const identity = buildRemoteWorkspacePath("host-a", "/srv/app");
    const next = settings.updateSshProjectHostIds(prev, identity, ["host-a"]);
    assert.deepEqual(settings.getSshProjectHostIds(next.ssh, identity), ["host-a"]);
    // 关联的 key 必须与【SSH 隧道】面板同一口径，否则两处各写一份、互相看不见。
    assert.deepEqual(Object.keys(next.ssh.projectHostAssociations), [
      settingsProjects.workspaceProjectPathKey(identity),
    ]);
  });

  test("a host that no longer exists is not written", () => {
    const prev = {
      ssh: { hosts: [sshHost({ id: "host-a" })], projectHostAssociations: {} },
    };
    const identity = buildRemoteWorkspacePath("host-a", "/srv/app");
    const next = settings.updateSshProjectHostIds(prev, identity, ["host-gone"]);
    assert.deepEqual(settings.getSshProjectHostIds(next.ssh, identity), []);
  });
});

// 远程工作空间下 workdir 为空、本地 fs / shell 工具无从作用，agent 必须被显式告知
// 「连哪台机器、远端根在哪、用什么工具」，否则会一直拿本地工具去试并逐个报错。
describe("buildRemoteWorkspacePrompt", () => {
  test("names the host, the remote root and the tool to use", () => {
    const prompt = buildRemoteWorkspacePrompt({
      hostId: "host-a",
      hostName: "prod",
      rootPath: "/srv/app",
    });
    assert.match(prompt, /host-a/);
    assert.match(prompt, /prod/);
    assert.match(prompt, /\/srv\/app/);
    assert.match(prompt, /SSHManager/);
    // 具体动作也要点到，否则 agent 可能只拿 list_hosts 转一圈就不知道下一步。
    assert.match(prompt, /sftp_read_text/);
    assert.match(prompt, /sftp_write_text/);
    assert.match(prompt, /exec/);
  });

  test("returns nothing when the host or the root is missing", () => {
    // 宁可不注入，也不要给 agent 一段「没有根的远程说明」。
    assert.equal(
      buildRemoteWorkspacePrompt({ hostId: "", hostName: "prod", rootPath: "/srv" }),
      "",
    );
    assert.equal(
      buildRemoteWorkspacePrompt({ hostId: "host-a", hostName: "prod", rootPath: "  " }),
      "",
    );
  });

  test("falls back to the host id when there is no label", () => {
    const prompt = buildRemoteWorkspacePrompt({
      hostId: "host-a",
      hostName: " ",
      rootPath: "/srv",
    });
    assert.match(prompt, /\(host-a\)/);
  });

  test("points at the real argument names and the real source of session ids", () => {
    // 这段说明是给模型看的操作指令，参数名/来源写错就是直接误导。
    // 与 sshManagerTools 的 SSH_MANAGER_TOOL 定义对齐：
    // - 主机参数叫 `host_id`；
    // - session id 来自 `create_session` / `list_sessions`，**不是** `list_hosts`
    //   （list_hosts 只列主机）。
    const prompt = buildRemoteWorkspacePrompt({
      hostId: "host-a",
      hostName: "prod",
      rootPath: "/srv/app",
    });
    assert.match(prompt, /host_id="host-a"/);
    assert.match(prompt, /create_session/);
    assert.match(prompt, /list_sessions/);
    assert.doesNotMatch(prompt, /session id from `list_hosts`/);
  });
});

describe("remote workspace error classification", () => {
  const cases = [
    ["SSH session is not connected", "session-disconnected"],
    ["SFTP is not enabled for this SSH session", "sftp-disabled"],
    ["SSH host not found: host-1", "host-missing"],
    ["SSH session does not belong to this project", "session-missing"],
    ["remote list failed: Permission denied (os error 13)", "permission-denied"],
    ["remote stat failed: No such file or directory (os error 2)", "not-found"],
    ["remote list failed: Not a directory", "not-directory"],
    ["something entirely unexpected", "unknown"],
  ];

  for (const [message, expected] of cases) {
    test(`maps ${JSON.stringify(message)} to ${expected}`, () => {
      assert.equal(classifyRemoteWorkspaceError(new Error(message)), expected);
    });
  }

  test("accepts raw strings and empty errors", () => {
    assert.equal(classifyRemoteWorkspaceError("Permission denied"), "permission-denied");
    assert.equal(classifyRemoteWorkspaceError(undefined), "unknown");
    assert.equal(classifyRemoteWorkspaceError(null), "unknown");
  });
});

describe("settings normalization keeps the remote descriptor", () => {
  test("preserves remote fields and derives kind from them", () => {
    const [project] = settingsProjects.normalizeWorkspaceProjects([
      {
        id: "p1",
        name: "app",
        path: "ssh://host-1/srv/app",
        kind: "remote",
        remote: { hostId: "host-1", hostName: "prod", rootPath: "/srv/app" },
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    assert.equal(project.kind, "remote");
    assert.deepEqual(project.remote, { hostId: "host-1", hostName: "prod", rootPath: "/srv/app" });
  });

  test("rebuilds a missing identity path from the remote descriptor", () => {
    const [project] = settingsProjects.normalizeWorkspaceProjects([
      { id: "p1", path: "", kind: "remote", remote: { hostId: "host-1", rootPath: "/srv/app" } },
    ]);
    assert.equal(project.path, "ssh://host-1/srv/app");
    assert.equal(project.remote.hostName, "host-1");
  });

  test("downgrades a remote kind that lost its descriptor", () => {
    // 否则会留下一个「声称远程但没有远程根」的项目，下游只能靠猜。
    const [project] = settingsProjects.normalizeWorkspaceProjects([
      { id: "p1", path: "/srv/app", kind: "remote" },
    ]);
    assert.equal(project.kind, "folder");
    assert.equal(project.remote, undefined);
  });

  test("drops an incomplete descriptor and keeps the project local", () => {
    const [project] = settingsProjects.normalizeWorkspaceProjects([
      { id: "p1", path: "/srv/app", kind: "remote", remote: { hostId: "host-1" } },
    ]);
    assert.equal(project.kind, "folder");
    assert.equal(project.remote, undefined);
  });

  test("local projects are untouched", () => {
    const [project] = settingsProjects.normalizeWorkspaceProjects([
      { id: "p1", name: "app", path: "/srv/app", kind: "folder", createdAt: 1, updatedAt: 2 },
    ]);
    assert.deepEqual(project, {
      id: "p1",
      name: "app",
      path: "/srv/app",
      kind: "folder",
      createdAt: 1,
      updatedAt: 2,
    });
  });
});

// 回归：身份串曾经一路进到会话 workdir，被下游 Rust 的 canonicalize_workdir 判为
// 非绝对路径，导致文件与命令类工具全线报
// `workdir must be an existing absolute directory`。
describe("远程身份串不得进入会话 workdir", () => {
  test("normalizeWorkdir clears the identity string but keeps local paths", () => {
    assert.equal(settingsProjects.normalizeWorkdir(REMOTE_WORKDIR), "");
    assert.equal(settingsProjects.normalizeWorkdir("E:\\ai\\LiveAgent"), "E:\\ai\\LiveAgent");
    assert.equal(settingsProjects.normalizeWorkdir("  /srv/app  "), "/srv/app");
    assert.equal(settingsProjects.normalizeWorkdir("~"), "~");
    assert.equal(settingsProjects.normalizeWorkdir(null), "");
    assert.equal(settingsProjects.normalizeWorkdir(42), "");
  });

  test("resolveConversationPromptWorkdir never returns the identity string", () => {
    // workdir 有四个来源，任何一个漏掉都会让工具全线报错。
    const cases = [
      { isAgentMode: true, globalWorkdir: REMOTE_WORKDIR },
      { isAgentMode: true, globalWorkdir: "/srv/local", runtimeWorkdir: REMOTE_WORKDIR },
      { isAgentMode: true, globalWorkdir: "/srv/local", persistedWorkdir: REMOTE_WORKDIR },
      { isAgentMode: true, globalWorkdir: "/srv/local", workdirOverride: REMOTE_WORKDIR },
      { isAgentMode: true, globalWorkdir: "/srv/local", gatewayWorkdirOverride: REMOTE_WORKDIR },
    ];
    for (const params of cases) {
      assert.equal(chatPageRuntime.resolveConversationPromptWorkdir(params), "");
    }
  });

  test("resolveEffectiveConversationWorkdir drops it too", () => {
    assert.equal(
      chatPageRuntime.resolveEffectiveConversationWorkdir({
        isAgentMode: true,
        globalWorkdir: REMOTE_WORKDIR,
      }),
      "",
    );
    assert.equal(
      chatPageRuntime.resolveEffectiveConversationWorkdir({
        isAgentMode: true,
        globalWorkdir: "/srv/local",
      }),
      "/srv/local",
    );
    // 非 agent 模式本来就没有 workdir，行为不变。
    assert.equal(
      chatPageRuntime.resolveEffectiveConversationWorkdir({
        isAgentMode: false,
        globalWorkdir: "/srv/local",
      }),
      "",
    );
  });

  test("clearing the identity string does not silently fall back to another root", () => {
    // 回退到别的目录会让用户在错误的根目录下工作却不自知。宁可留空，
    // 由发送路径显式拒绝（useSendChatTurn 的远程守卫）。
    assert.equal(
      chatPageRuntime.resolveConversationPromptWorkdir({
        isAgentMode: true,
        globalWorkdir: "/srv/local",
        runtimeWorkdir: REMOTE_WORKDIR,
      }),
      "",
    );
  });

  test("a local workdir is passed through untouched", () => {
    assert.equal(
      chatPageRuntime.resolveConversationPromptWorkdir({
        isAgentMode: true,
        globalWorkdir: "E:\\ai\\LiveAgent",
      }),
      "E:\\ai\\LiveAgent",
    );
    assert.equal(
      chatPageRuntime.resolveEffectiveConversationWorkdir({
        isAgentMode: true,
        persistedWorkdir: "  /srv/app  ",
        globalWorkdir: "E:\\ai\\LiveAgent",
      }),
      "/srv/app",
    );
  });
});
