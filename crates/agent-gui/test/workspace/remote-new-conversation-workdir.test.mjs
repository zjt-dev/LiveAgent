import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// 回归：在远程文件夹里点「新建对话」，会话没留在远程工作空间，而是跳回**之前打开的
// 本地文件夹**。两条独立的成因一起锁在这里：
//
// 1. `activateWorkspaceProject(project, { startConversation: true })` 把项目的
//    `path` 原样当作新会话的 workdir 下发 —— 远程项目的 path 是 `ssh://…` 身份串，
//    它进不了本地文件子系统（`normalizeWorkdir` 会把它清成空串），于是会话的
//    workdir 实际为空；
// 2. 会话的「本地根视图」（`displayedConversationWorkdir`）在 workdir 为空时按
//    `localWorkspaceProjectPath || 全局 workdir` 回退，而远程活动项目下前者恒为空
//    —— 后者正是设置加载时从身份串改写出来的**本地默认/上次打开的项目**。
//
// 合起来就是：远程文件夹里开的新对话，根目录显示与资源解析全部落在本地文件夹上。

const LOCAL_WORKDIR = "/repo/local";

const env = await createDomTestEnv({
  mocks: {
    // 本地项目行的目录探测：只有「目录存在」这一种答案对本测试有意义。
    "@liveagent/ui/lib/tools/fsBackend": {
      invokeFs: async () => ({ entries: [] }),
    },
  },
});
const { React, act, createRoot } = env;
const { createSidebarStore } = env.loadModule("@liveagent/ui/lib/sidebar/store.ts");
const remoteProjectLib = env.loadModule("@liveagent/ui/lib/workspaceRemoteProject.ts");
const { workspaceProjectPathKey, getDefaultSettings, DEFAULT_WORKSPACE_PROJECT_ID } =
  env.loadModule("src/lib/settings/index.ts");
const { useWorkspaceProjects } = env.loadModule(
  "src/pages/chat/workspace/useWorkspaceProjects.ts",
);

const { createRemoteWorkspaceProject, resolveConversationDisplayWorkdir } = remoteProjectLib;

const remoteProject = createRemoteWorkspaceProject({
  hostId: "host-1",
  hostName: "prod",
  rootPath: "/srv/app",
});
const REMOTE_PATH = remoteProject.path;

const LOCAL_WORKSPACE_PROJECT = {
  id: DEFAULT_WORKSPACE_PROJECT_ID,
  name: "local",
  path: LOCAL_WORKDIR,
  kind: "managed",
  createdAt: 1,
  updatedAt: 1,
};

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function buildSettings({ missing = [] } = {}) {
  const defaults = getDefaultSettings();
  return {
    ...defaults,
    system: {
      ...defaults.system,
      workdir: LOCAL_WORKDIR,
      workspaceProjects: [LOCAL_WORKSPACE_PROJECT, remoteProject],
      activeWorkspaceProjectId: LOCAL_WORKSPACE_PROJECT.id,
      hiddenWorkspaceProjectPaths: [],
      missingWorkspaceProjectPaths: missing,
      archivedWorkspaceProjectPaths: [],
    },
  };
}

/**
 * 真实渲染 `useWorkspaceProjects`：断言的是行为（下发给新会话的 workdir、活动项目、
 * missing 标记），不是源码里的字符串。
 */
async function harness(t, options = {}) {
  const initialSettings = buildSettings(options);
  const startedWith = [];
  const store = createSidebarStore(
    {
      listConversations: async () => ({ items: [], totalCount: 0 }),
      listWorkdirs: async () => [],
      subscribeEvents: () => () => {},
    },
    { pageSize: 5 },
  );
  let api;
  let settings = initialSettings;
  function Host() {
    const [value, setValue] = React.useState(initialSettings);
    settings = value;
    api = useWorkspaceProjects({
      settings: value,
      setSettings: (update) => setValue(update),
      sidebarStore: store,
      isAgentMode: true,
      workdir: LOCAL_WORKDIR,
      t: (key) => key,
      setErrorMessage: () => {},
      setActiveView: () => {},
      setRightDockOpen: () => {},
      startNewConversationActionRef: {
        current: (startOptions) => {
          startedWith.push(startOptions ?? {});
          return "conv-new";
        },
      },
      prepareComposerForConversationChangeActionRef: { current: () => {} },
    });
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Host));
  });
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return {
    get api() {
      return api;
    },
    get settings() {
      return settings;
    },
    startedWith,
  };
}

describe("远程文件夹的新会话不得继承上一处本地根目录", () => {
  test("项目行的新建对话不下发远程身份串", async (t) => {
    const h = await harness(t);
    await act(async () => {
      await h.api.handleNewConversationForProject(remoteProject);
    });
    assert.equal(h.startedWith.length, 1, "远程项目行必须真的开出一个新会话");
    assert.notEqual(
      h.startedWith[0].workdir,
      REMOTE_PATH,
      "远程身份串不是本地路径，作为 workdir 下发会被下游清空",
    );
    assert.equal(
      h.startedWith[0].workdir,
      "",
      "必须显式留空：undefined 会让新会话回退到**上一个**活动项目的本地路径",
    );
  });

  test("新建之后活动项目仍是远程项目，而不是回落到本地文件夹", async (t) => {
    const h = await harness(t);
    await act(async () => {
      await h.api.handleNewConversationForProject(remoteProject);
    });
    assert.equal(h.api.activeWorkspaceProjectPath, REMOTE_PATH);
    assert.equal(h.settings.system.activeWorkspaceProjectId, remoteProject.id);
  });

  test("本地项目行的新建对话继续带上本地路径", async (t) => {
    const h = await harness(t);
    await act(async () => {
      await h.api.handleNewConversationForProject(LOCAL_WORKSPACE_PROJECT);
    });
    assert.equal(h.startedWith.length, 1);
    assert.equal(h.startedWith[0].workdir, LOCAL_WORKDIR);
  });

  test("远程项目永远不会被当成「目录缺失」而丢掉新建入口", async (t) => {
    // 历史上远程项目被本地目录探测误标为 missing（探测跳过的守卫是那之后才加的），
    // 存量设置里留下这条标记时，侧栏行会把「新建对话」换成「删除」，用户就再也无法
    // 在这个文件夹里开新会话。missing 的语义是「本地目录不存在」，对远程项目不成立。
    const h = await harness(t, { missing: [REMOTE_PATH] });
    assert.equal(
      h.api.missingWorkspaceProjectPathKeys.has(workspaceProjectPathKey(REMOTE_PATH)),
      false,
      "远程身份串不能出现在 missing 集合里",
    );
  });
});

describe("会话的本地根视图在远程工作空间下保持为空", () => {
  test("远程活动项目 + 空 workdir 时不回退到全局本地 workdir", () => {
    assert.equal(
      resolveConversationDisplayWorkdir({
        persistedCwd: "",
        runtimeWorkdir: "",
        isAgentMode: true,
        activeWorkspaceProjectPath: REMOTE_PATH,
        globalWorkdir: LOCAL_WORKDIR,
      }),
      "",
    );
  });

  test("远程身份串既不进视图、也不逼出本地回退", () => {
    for (const persistedCwd of [REMOTE_PATH, ""]) {
      for (const runtimeWorkdir of [REMOTE_PATH, ""]) {
        assert.equal(
          resolveConversationDisplayWorkdir({
            persistedCwd,
            runtimeWorkdir,
            isAgentMode: true,
            activeWorkspaceProjectPath: REMOTE_PATH,
            globalWorkdir: LOCAL_WORKDIR,
          }),
          "",
        );
      }
    }
  });

  test("会话自身的本地锚点优先于活动项目", () => {
    // 打开别的项目下的会话时（远程项目仍活动），会话自己的 cwd 才是根视图。
    assert.equal(
      resolveConversationDisplayWorkdir({
        persistedCwd: "/repo/other",
        runtimeWorkdir: "",
        isAgentMode: true,
        activeWorkspaceProjectPath: REMOTE_PATH,
        globalWorkdir: LOCAL_WORKDIR,
      }),
      "/repo/other",
    );
  });

  // 镜像情形：屏幕上是那个远程会话，用户却把**活动项目**切回了本地文件夹。会话自己
  // 的锚点（身份串）被剥成空串后，回退链会把无关本地项目的路径交出去 —— 于是这个
  // 远程会话的 skills / MCP / 项目提示词全来自另一个项目。锚点是远程时必须归零。
  test("锚在远程的会话不会借用后来切成的本地活动项目", () => {
    for (const anchor of [
      { persistedCwd: REMOTE_PATH, runtimeWorkdir: "" },
      { persistedCwd: "", runtimeWorkdir: REMOTE_PATH },
    ]) {
      assert.equal(
        resolveConversationDisplayWorkdir({
          ...anchor,
          isAgentMode: true,
          activeWorkspaceProjectPath: LOCAL_WORKDIR,
          globalWorkdir: LOCAL_WORKDIR,
        }),
        "",
      );
    }
  });

  test("本地项目的既有回退链保持不变", () => {
    const base = {
      persistedCwd: "",
      runtimeWorkdir: "",
      isAgentMode: true,
      globalWorkdir: LOCAL_WORKDIR,
    };
    assert.equal(
      resolveConversationDisplayWorkdir({ ...base, activeWorkspaceProjectPath: "/repo/a" }),
      "/repo/a",
    );
    assert.equal(
      resolveConversationDisplayWorkdir({ ...base, activeWorkspaceProjectPath: "" }),
      LOCAL_WORKDIR,
    );
    assert.equal(
      resolveConversationDisplayWorkdir({
        ...base,
        activeWorkspaceProjectPath: "/repo/a",
        isAgentMode: false,
      }),
      "",
      "text 模式没有工作空间根",
    );
    assert.equal(
      resolveConversationDisplayWorkdir({
        ...base,
        activeWorkspaceProjectPath: "/repo/a",
        searchWorkdir: "",
      }),
      "",
      "搜索命中的无根会话必须留在空视图",
    );
  });
});

// 两端（桌面 / WebUI）同构：同一套规则只允许有一个实现处，否则又会各漏一条旁路。
describe("两端接线共用同一个闸", () => {
  const desktopChatPage = readSource("../../src/pages/ChatPage.tsx");
  const desktopWorkspaceProjects = readSource(
    "../../src/pages/chat/workspace/useWorkspaceProjects.ts",
  );
  const gatewayApp = readSource("../../../agent-gateway/web/src/app/GatewayApp.tsx");
  const gatewayWorkspaceProjects = readSource(
    "../../../agent-gateway/web/src/app/hooks/useGatewayWorkspaceProjects.ts",
  );

  test("会话根视图都走 resolveConversationDisplayWorkdir", () => {
    // 只看声明本身：`localWorkspaceProjectPath || workdir` 在原生目录选择器、终端 cwd
    // 那些「必须给一个真实本地目录」的地方是合法写法，锁死它只会挡住正确的修复。
    const slices = [
      [
        "ChatPage.tsx",
        desktopChatPage,
        "const displayedConversationWorkdir =",
        "const searchMentionableConversations",
      ],
      [
        "GatewayApp.tsx",
        gatewayApp,
        "const displayedConversationWorkdir =",
        "const searchMentionableConversations",
      ],
      ["GatewayApp.tsx", gatewayApp, "const resourceWorkdir =", "const {"],
    ];
    for (const [name, source, startMarker, endMarker] of slices) {
      const start = source.indexOf(startMarker);
      assert.notEqual(start, -1, `${name} missing ${startMarker}`);
      const end = source.indexOf(endMarker, start);
      assert.notEqual(end, -1, `${name} missing ${endMarker}`);
      const body = source.slice(start, end);
      assert.match(
        body,
        /= resolveConversationDisplayWorkdir\(/,
        `${name} 的 ${startMarker} 必须用共享的本地根视图解析`,
      );
      // 反向对照：手写的本地回退链一旦回来，远程会话就再次继承上一个打开的本地文件夹。
      assert.doesNotMatch(
        body,
        /localWorkspaceProjectPath|isRemoteWorkspacePath/,
        `${name} 的 ${startMarker} 不得再手工拼本地回退`,
      );
    }
  });

  test("新建会话的 workdir 都按项目身份过滤", () => {
    for (const [name, source] of [
      ["useWorkspaceProjects.ts", desktopWorkspaceProjects],
      ["useGatewayWorkspaceProjects.ts", gatewayWorkspaceProjects],
    ]) {
      assert.match(
        source,
        /workdir: isRemoteWorkspacePath\(targetProject\.path\)[\s\S]{0,40}\? ""[\s\S]{0,40}: targetProject\.path/,
        `${name} 的新会话 workdir 必须在远程项目下留空`,
      );
    }
  });

  test("missing 集合两端都排除远程身份串", () => {
    for (const [name, source] of [
      ["useWorkspaceProjects.ts", desktopWorkspaceProjects],
      ["useGatewayWorkspaceProjects.ts", gatewayWorkspaceProjects],
    ]) {
      assert.match(
        source,
        /const missingWorkspaceProjectPathKeys = useMemo\(\s*\n[\s\S]{0,320}isRemoteWorkspacePath/,
        `${name} 必须把远程项目挡在 missing 集合之外`,
      );
    }
  });
});

