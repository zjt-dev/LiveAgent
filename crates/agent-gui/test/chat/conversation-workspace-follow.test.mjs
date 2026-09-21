import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 切换会话（本地 ↔ 远程、跨项目）必须让**活动工作区**立即跟随。
//
// 侧栏高亮、侧栏作用域列表、右栏项目上下文全部由活动项目派生；「打开会话」这条路
// 以前只换会话、不动项目，于是会话切到另一个项目后侧栏仍高亮旧项目、列表里看不到
// 刚打开的会话，直到用户再点一次文件夹行才对齐。
//
// 这里锁两件事：
// 1. 纯函数：会话锚点 → 项目的反解规则（本地路径与远程身份串同一套键空间、归档不
//    激活、找不到项目不回退、签名幂等）；
// 2. 两端宿主的接线：锚点取会话自己的归属键（**不是**本地根视图），激活用
//    `preserveMissing`，并且只在「会话身份或归属键」变化时才同步。

const loader = createTsModuleLoader();
const workspaceProjects = loader.loadModule("@liveagent/ui/lib/workspaceProjects.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const chatPageSource = readSource("../../src/pages/ChatPage.tsx");
const gatewayAppSource = readSource("../../../agent-gateway/web/src/app/GatewayApp.tsx");

const REMOTE_PATH = "ssh://host-1/srv/app";
const OTHER_HOST_PATH = "ssh://host-2/srv/app";

function project(id, path) {
  return { id, name: id, path, kind: "manual", createdAt: 1, updatedAt: 1 };
}

const LOCAL_PROJECT = project("local-a", "C:/workspaces/local-a");
const OTHER_LOCAL_PROJECT = project("local-b", "C:/workspaces/local-b");
const REMOTE_PROJECT = {
  ...project("remote-b", REMOTE_PATH),
  remote: { hostId: "host-1", hostName: "Build", rootPath: "/srv/app" },
};

const PROJECTS = [LOCAL_PROJECT, OTHER_LOCAL_PROJECT, REMOTE_PROJECT];

function resolve(anchor, options = {}) {
  return workspaceProjects.resolveConversationWorkspaceProject(anchor, {
    workspaceProjects: options.projects ?? PROJECTS,
    archivedWorkspaceProjectPathKeys: options.archived ?? new Set(),
  });
}

describe("会话归属 → 活动工作区（纯函数）", () => {
  test("a local conversation resolves to the project that owns its cwd", () => {
    assert.equal(resolve("C:/workspaces/local-b")?.id, "local-b");
    // 尾部分隔符/大小写走同一套归一化键：否则「同一个目录」会被当成两个项目。
    assert.equal(resolve("c:/workspaces/local-b/")?.id, "local-b");
  });

  test("a remote conversation resolves through its identity string, not a local path", () => {
    // 远程会话落盘 cwd 是身份串（resolveConversationPersistedCwd），侧栏也按它分组。
    const resolved = resolve(REMOTE_PATH);
    assert.equal(resolved?.id, "remote-b");
    assert.equal(
      workspaceProjects.conversationWorkspaceProjectPathKey(REMOTE_PATH),
      settings.workspaceProjectPathKey(REMOTE_PATH),
    );
  });

  test("the same root on another host never matches", () => {
    // 身份串把 hostId 编进去就是为了这个：两台机器上的 /srv/app 不是一个工作区。
    assert.equal(resolve(OTHER_HOST_PATH), null);
  });

  test("an archived project is never activated", () => {
    // activateWorkspaceProject 会顺手取消归档 —— 自动跟随不能静默复活用户归档过的工作区。
    assert.equal(
      resolve("C:/workspaces/local-b", {
        archived: new Set([settings.workspaceProjectPathKey("C:/workspaces/local-b")]),
      }),
      null,
    );
    assert.equal(resolve(REMOTE_PATH, { archived: new Set([settings.workspaceProjectPathKey(REMOTE_PATH)]) }), null);
  });

  test("an unknown anchor resolves to nothing instead of falling back", () => {
    // 不回退、也不凭空造项目：远程身份串经 createWorkspaceProjectFromPath 会变成
    // 「路径是 ssh:// 的本地项目」，比不切更糟。
    assert.equal(resolve("C:/workspaces/never-opened"), null);
    assert.equal(resolve(""), null);
    assert.equal(resolve("   "), null);
    assert.equal(resolve(undefined), null);
    assert.equal(resolve(null), null);
  });

  test("the sync signature is idempotent per conversation and anchor", () => {
    const signature = workspaceProjects.conversationWorkspaceSyncSignature("conv-1", REMOTE_PATH);
    assert.equal(
      signature,
      workspaceProjects.conversationWorkspaceSyncSignature("conv-1", `${REMOTE_PATH}/`),
      "same conversation + same project must produce the same signature",
    );
    assert.notEqual(
      signature,
      workspaceProjects.conversationWorkspaceSyncSignature("conv-2", REMOTE_PATH),
      "another conversation must sync again",
    );
    assert.notEqual(
      signature,
      workspaceProjects.conversationWorkspaceSyncSignature("conv-1", "C:/workspaces/local-a"),
      "the same conversation moved to another project must sync again",
    );
    // 会话身份缺失（草稿未落盘）时不给签名，宿主据此跳过同步。
    assert.equal(workspaceProjects.conversationWorkspaceSyncSignature("  ", REMOTE_PATH), "");
  });
});


// ---------------------------------------------------------------------------
// 宿主接线
// ---------------------------------------------------------------------------

/** 截取「跟随」effect 的正文：从签名 ref 声明到它的依赖数组收尾。 */
function followEffectBody(source, marker = "const syncedConversationWorkspaceRef") {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${marker}`);
  const end = source.indexOf("]);", start);
  assert.ok(end > start, `unterminated follow effect after ${marker}`);
  return source.slice(start, end);
}

describe("两端宿主的跟随接线", () => {
  const hosts = [
    ["ChatPage", () => chatPageSource],
    ["GatewayApp", () => gatewayAppSource],
  ];

  test("both hosts resolve the opened conversation's project", () => {
    for (const [name, source] of hosts) {
      const text = source();
      assert.match(text, /conversationWorkspaceSyncSignature,/, `${name} import`);
      assert.match(text, /resolveConversationWorkspaceProject,/, `${name} import`);
      assert.match(text, /conversationWorkspaceSyncSignature\(conversationId, anchor\)/, name);
      assert.match(text, /resolveConversationWorkspaceProject\(anchor, \{/, name);
    }
  });

  test("the anchor is the conversation's own identity, never the local root view", () => {
    for (const [name, source] of hosts) {
      const body = followEffectBody(source());
      // 会话自己的锚点：运行时 workdir → 侧栏行的落盘 cwd。二者对远程会话都是身份串。
      assert.match(
        body,
        /currentConversationRuntimeWorkdir \|\|\s*sidebarStore\.peek\(conversationId\)\?\.cwd|conversationWorkdirsRef\.current\.get\(conversationId\)\?\.trim\(\) \|\|\s*sidebarConversationsById\.get\(conversationId\)\?\.cwd/,
        `${name} must anchor on the conversation's own workdir/cwd`,
      );
      // `displayedConversationWorkdir` 是**本地根视图**（远程恒为空）：用它反解会把远程
      // 会话错认成「不属于任何项目」，跟随链路里绝不能出现它。
      assert.doesNotMatch(body, /displayedConversationWorkdir/, name);
    }
  });

  test("activation preserves the missing mark and is signature-guarded", () => {
    for (const [name, source] of hosts) {
      const body = followEffectBody(source());
      assert.match(body, /activateWorkspaceProject\(project, \{ preserveMissing: true \}\)/, name);
      assert.match(
        body,
        /if \(!signature \|\| syncedConversationWorkspaceRef\.current === signature\) return;/,
        `${name} must sync once per conversation/anchor combination`,
      );
      assert.match(body, /syncedConversationWorkspaceRef\.current = signature;/, name);
    }
  });

  test("the sync is keyed on the visible conversation and its anchor", () => {
    assert.match(followEffectBody(chatPageSource), /currentConversationId/);
    assert.match(followEffectBody(gatewayAppSource), /displayedConversationId/);
    // 依赖数组里必须有会话身份与锚点，否则换会话/换项目时 effect 不会重跑。
    assert.match(
      chatPageSource,
      /currentConversationId,\s*\n\s*currentConversationRuntimeWorkdir,\s*\n\s*sidebarStore,/,
    );
    assert.match(
      gatewayAppSource,
      /archivedWorkspaceProjectPathKeys,\s*\n\s*displayedConversationId,\s*\n\s*sidebarConversationsById,/,
    );
  });
});
