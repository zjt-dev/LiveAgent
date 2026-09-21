import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 远程工作空间侧栏（Right Dock 的 `remoteWorkspace` 工具）：一个面板里同时给
// Bash 交互终端与 SFTP 文件管理器，二者绑定同一条 SSH 会话、同一个远端根。
//
// 这里锁三类东西：
// 1. 纯函数：shell 落位命令的 POSIX 转义、分割比例的夹紧与持久化；
// 2. 可用性：它与其它项目工具互补（要远程项目，而不是本地根）；
// 3. 接线合同：两个宿主都注入了 SFTP 通道、分割比例读写与打开文件回调，且面板
//    复用的是既有 XTermViewport / WorkspaceSftpPanel，而不是新写的实现。

const loader = createTsModuleLoader();
const remote = loader.loadModule("@liveagent/ui/lib/workspaceRemoteProject.ts");
const rightDockModel = loader.loadModule(
  "@liveagent/ui/components/project-tools/rightDockModel.ts",
);
const settings = loader.loadModule("src/lib/settings/index.ts");

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const panelSource = readSource(
  "../../../agent-ui/src/components/project-tools/RemoteWorkspacePanel.tsx",
);
const registrySource = readSource(
  "../../../agent-ui/src/components/project-tools/rightDockRegistry.tsx",
);
const launcherSource = readSource(
  "../../../agent-ui/src/components/project-tools/RightDockLauncher.tsx",
);
const dockPanelSource = readSource(
  "../../../agent-ui/src/components/project-tools/RightDockPanel.tsx",
);
const sftpPanelSource = readSource(
  "../../../agent-ui/src/components/workspace-editor/WorkspaceSftpPanel.tsx",
);
const viewportSource = readSource(
  "../../../agent-ui/src/components/project-tools/XTermViewport.tsx",
);
const paneHostSource = readSource(
  "../../../agent-ui/src/components/workbench/ProjectToolPaneHost.tsx",
);
const toggleSource = readSource(
  "../../../agent-ui/src/components/project-tools/ProjectToolsPanelToggle.tsx",
);
const chatPageSource = readSource("../../src/pages/ChatPage.tsx");
const gatewayViewSource = readSource("../../../agent-gateway/web/src/app/GatewayAppView.tsx");
const zhSource = readSource("../../../agent-ui/src/i18n/translations/zhCNCommon.ts");
const enSource = readSource("../../../agent-ui/src/i18n/translations/enUSCommon.ts");

describe("远程工作空间的 shell 落位命令", () => {
  test("quotes the remote root for a POSIX shell", () => {
    assert.equal(remote.remoteWorkspaceShellCdCommand("/srv/app"), "cd '/srv/app'");
    // 单引号是唯一无副作用的转义方式：远端可能是 bash / sh / zsh。
    assert.equal(
      remote.remoteWorkspaceShellCdCommand("/srv/it's here"),
      "cd '/srv/it'\\''s here'",
    );
  });

  test("normalizes the root and stays silent for the home directory", () => {
    assert.equal(remote.remoteWorkspaceShellCdCommand("/srv//app/"), "cd '/srv/app'");
    assert.equal(remote.remoteWorkspaceShellCdCommand("/srv/x/../app"), "cd '/srv/app'");
    // `.` 是 SFTP 语义下的家目录：服务端默认行为已经是它，不该再发命令。
    assert.equal(remote.remoteWorkspaceShellCdCommand("."), "");
    assert.equal(remote.remoteWorkspaceShellCdCommand(""), "");
  });
});

describe("远程工作空间的 Bash / SFTP 高度分配", () => {
  test("clamps any persisted value into the usable range", () => {
    assert.equal(rightDockModel.clampRemoteWorkspaceSplitRatio(0.5), 0.5);
    assert.equal(rightDockModel.clampRemoteWorkspaceSplitRatio(0), 0.2);
    assert.equal(rightDockModel.clampRemoteWorkspaceSplitRatio(1), 0.8);
    assert.equal(rightDockModel.clampRemoteWorkspaceSplitRatio("0.9"), 0.5);
    assert.equal(rightDockModel.clampRemoteWorkspaceSplitRatio(Number.NaN), 0.5);
  });

  test("round-trips through the persisted project state", () => {
    const base = settings.getRightDockProjectState(
      { rightDock: { width: 420, projects: {} } },
      "/workspace/project-main",
    );
    assert.equal(
      rightDockModel.remoteWorkspaceSplitRatio(base),
      rightDockModel.DEFAULT_REMOTE_WORKSPACE_SPLIT_RATIO,
    );
    const next = rightDockModel.withRemoteWorkspaceSplitRatio(base, 0.7);
    assert.equal(rightDockModel.remoteWorkspaceSplitRatio(next), 0.7);
    // 归一化只保留声明过的键，所以比例必须能被序列化回来。
    const normalized = settings.normalizeRightDockProjectState(JSON.parse(JSON.stringify(next)));
    assert.equal(rightDockModel.remoteWorkspaceSplitRatio(normalized), 0.7);
    // 同值写入必须是 no-op（否则拖动手势会不断产生新的设置版本）。
    assert.equal(rightDockModel.withRemoteWorkspaceSplitRatio(next, 0.7), next);
  });
});

describe("远程工作空间侧栏的可用性与宿主接线", () => {
  test("it is the one project tool that needs a remote project instead of a local root", () => {
    assert.equal(rightDockModel.rightDockTabRequiresProject("remoteWorkspace"), false);
    assert.equal(rightDockModel.rightDockTabRequiresProject("fileTree"), true);
    assert.equal(rightDockModel.rightDockTabRequiresProject("tunnel"), false);
    assert.match(registrySource, /kind: "remoteWorkspace"/);
    assert.match(registrySource, /remoteRequired: true/);
    assert.match(
      registrySource,
      /Boolean\(context\.capabilities\.remoteWorkspaceTarget && context\.clients\.sftp\)/,
    );
  });

  test("the launcher gates and explains the remote-only tool", () => {
    assert.match(
      launcherSource,
      /if \(definition\.remoteRequired\) return availability\.remoteWorkspaceAvailable;/,
    );
    assert.match(
      launcherSource,
      /if \(definition\.remoteRequired\) return messages\.remoteWorkspaceDisabledMessage;/,
    );
  });

  test("the panel reuses the existing Bash viewport and SFTP panel", () => {
    assert.match(panelSource, /import \{ XTermViewport \} from "\.\/XTermViewport"/);
    assert.match(panelSource, /await import\("\.\.\/workspace-editor\/WorkspaceSftpPanel"\)/);
    assert.match(panelSource, /initialRemotePath=\{target\.rootPath\}/);
    assert.match(panelSource, /showLocalPane=\{false\}/);
    // 协同的关键：两块区域共用同一条会话，且都停在远端根上。
    assert.match(panelSource, /findUsableSessionForHost\(sessions, target\.hostId\)/);
    assert.match(panelSource, /initialInput=\{initialInput\}/);
    assert.match(panelSource, /reconnectInput=\{reconnectInput\}/);
    assert.match(panelSource, /sftpEnabled: true/);
  });

  // cd 的记账粒度是「(会话, 远端根)」而不是「面板实例」：dock 与工作台是两个实例
  // （拖到工作台时 dock 卸载、工作台新挂），实例级记账会重发 cd，把用户手动 cd 到的
  // 目录拽回远端根。反过来，重连换的是**新 shell**（会话 id 不变），必须重发。
  test("the panel books the cd command per (session, remote root), not per panel instance", () => {
    assert.match(panelSource, /const remoteWorkspaceCdSentKeys = new Set<string>\(\);/);
    assert.match(
      panelSource,
      /function remoteWorkspaceCdKey\(sessionId: string, rootPath: string\) \{/,
    );
    assert.match(panelSource, /!remoteWorkspaceCdSentKeys\.has\(cdKey\)/);
    assert.match(panelSource, /remoteWorkspaceCdSentKeys\.add\(cdKey\)/);
    // 记账时机是「视口真的挂上了」：tab 只是被打开还不是活跃 tab 时不能消费掉这次机会。
    assert.match(panelSource, /if \(!active \|\| !cdKey \|\| !initialInput\) return;/);
    assert.match(panelSource, /const reconnectInput = cdCommand \? `\$\{cdCommand\}\\n` : undefined;/);
  });

  test("the SFTP panel keeps its dual-pane default for the SSH overlay", () => {
    assert.match(sftpPanelSource, /const showLocalPane = props\.showLocalPane \?\? true;/);
    assert.match(sftpPanelSource, /initialRemotePath\?: string;/);
    assert.match(sftpPanelSource, /const singlePane = isMobileLayout \|\| !showLocalPane;/);
  });

  // 单栏（移动端 / 远程侧栏）没有本地面板可当下载目标：菜单里留着「下载到本地」是
  // 死操作（点了没反应），触控拖动也要按「是不是单栏」而不是「是不是移动端」来放行。
  test("the SFTP panel hides the download-to-local action when there is no local pane", () => {
    assert.match(
      sftpPanelSource,
      /contextMenu\.side === "local" \? \([\s\S]*?\) : showLocalPane \? \([\s\S]*?transferItem\([\s\S]*?"local",[\s\S]*?localPane\.path,/,
    );
    assert.match(sftpPanelSource, /const singlePane = isMobileLayout \|\| !showLocalPane;/);
    assert.equal(/!isMobileLayout && "touch-none"/.test(sftpPanelSource), false);
  });

  test("the viewport re-arms its anchor input on session change and re-sends it after reconnect", () => {
    assert.match(viewportSource, /initialInput\?: string;/);
    assert.match(viewportSource, /reconnectInput\?: string;/);
    assert.match(viewportSource, /const initialInputRef = useRef\(initialInput\);/);
    assert.match(viewportSource, /const reconnectInputRef = useRef\(reconnectInput\);/);
    // 值只增不减：变空是「已经写过」的记账，不是「撤销写入」的指令；重新变非空
    // 说明会话换了，必须重新武装（否则新 shell 永远收不到锚点）。
    assert.match(viewportSource, /if \(initialInput\) initialInputRef\.current = initialInput;/);
    assert.match(viewportSource, /handle\.write\(new TextEncoder\(\)\.encode\(pendingInput\)\)/);
    assert.match(viewportSource, /if \(event\.kind === "reconnected"\) \{/);
    assert.match(
      viewportSource,
      /streamHandle\.write\(new TextEncoder\(\)\.encode\(anchorInput\)\)/,
    );
    assert.match(viewportSource, /else initialInputRef\.current = anchorInput;/);
  });

  test("the dock passes the SFTP channel and the persisted ratio", () => {
    assert.match(dockPanelSource, /const remoteWorkspaceTarget = useMemo\(/);
    assert.match(
      dockPanelSource,
      /const remoteWorkspaceAvailable = Boolean\(remoteWorkspaceTarget && sftpClient\);/,
    );
    assert.match(dockPanelSource, /if \(kind === "remoteWorkspace"\) \{/);
    // 可用性为假时 tab 不出现（例如项目被换成非远程后残留的持久化 tab）。
    const base = settings.getRightDockProjectState(
      { rightDock: { width: 420, projects: {} } },
      "ssh://host-1/srv/app",
    );
    const withTool = {
      ...base,
      tools: { remoteWorkspace: { openedAt: 1 } },
      tabOrder: ["tool:remoteWorkspace"],
    };
    const visibleKinds = (remoteWorkspaceAvailable) =>
      rightDockModel
        .getRightDockVisibleTabs({
          backgroundTasksVisible: false,
          localSessions: [],
          projectPathKey: "ssh://host-1/srv/app",
          projectState: withTool,
          remoteWorkspaceAvailable,
          tunnelAvailable: false,
        })
        .map((tab) => tab.kind);
    assert.deepEqual(visibleKinds(true), ["remoteWorkspace"]);
    assert.deepEqual(visibleKinds(false), []);
  });

  test("both hosts inject the SFTP client, the ratio accessors and the file opener", () => {
    assert.match(chatPageSource, /sftp: tauriSftpClient,/);
    assert.match(chatPageSource, /sftpClient=\{tauriSftpClient\}/);
    assert.match(chatPageSource, /onOpenSftpFile=\{workspaceOverlays\.handleOpenSftpFile\}/);
    assert.match(chatPageSource, /withRemoteWorkspaceSplitRatio\(projectState, ratio\)/);
    assert.match(gatewayViewSource, /sftp: sftpClient,/);
    assert.match(gatewayViewSource, /sftpClient=\{sftpClient\}/);
    assert.match(gatewayViewSource, /onOpenSftpFile=\{handleOpenSftpFile\}/);
    assert.match(gatewayViewSource, /withRemoteWorkspaceSplitRatio\(projectState, ratio\)/);
    // Pane 宿主复用 registry 的同一份工具组件，不复制一个面板实现。
    assert.match(paneHostSource, /case "remoteWorkspace":/);
    assert.match(
      paneHostSource,
      /getRightDockToolDefinition\("remoteWorkspace"\)\?\.render\(\{ active: true \}\)/,
    );
  });

  test("both locales carry the new labels", () => {
    for (const key of [
      "projectTools.remoteWorkspaceTitle",
      "projectTools.newRemoteWorkspace",
      "projectTools.remoteWorkspaceDescription",
      "projectTools.closeRemoteWorkspace",
      "projectTools.remoteWorkspaceNeedsRemote",
      "projectTools.remoteWorkspaceReconnect",
      "projectTools.remoteWorkspaceResize",
      "projectTools.remoteWorkspaceHostMissing",
      "projectTools.remoteWorkspaceSessionGone",
    ]) {
      assert.ok(zhSource.includes(`"${key}"`), `zhCN missing ${key}`);
      assert.ok(enSource.includes(`"${key}"`), `enUS missing ${key}`);
    }
  });
});

// 入口可达性：这是「功能写好了但用户找不到按钮」的那一类回归。
//
// 顶栏的 dock 折叠按钮此前按 `disabledMessage` 直接禁用，而远程项目下本地根为空，
// `disabledMessage` 必定有值 —— 于是 dock 打不开，里面的 chooser/「+」菜单（也就是
// 唯一两个入口）永远见不到，更别说把侧栏拖到工作台。可用性必须跟着「远程工作空间
// 侧栏能不能用」一起放行。
describe("远程工作空间侧栏的入口可达性", () => {
  test("the dock toggle stays enabled while the remote sidebar is available", () => {
    assert.match(toggleSource, /remoteWorkspaceAvailable\?: boolean;/);
    assert.match(
      toggleSource,
      /const localToolsUnavailable = Boolean\(disabledMessage\) && !remoteWorkspaceAvailable;/,
    );
    assert.match(toggleSource, /disabled=\{localToolsUnavailable && !isOpen\}/);
    // 不可用原因只在真的不可用时才当 tooltip；远程项目下说的是「展开」。
    assert.match(
      toggleSource,
      /:\s*localToolsUnavailable\s*\?\s*disabledMessage\s*:\s*"Expand project tools panel"/,
    );
  });

  test("both hosts feed the remote-project availability into that toggle", () => {
    for (const [name, source] of [
      ["ChatPage", chatPageSource],
      ["GatewayAppView", gatewayViewSource],
    ]) {
      assert.match(
        source,
        /const remoteWorkspaceDockAvailable = Boolean\(/,
        `${name} must derive the remote availability`,
      );
      assert.match(
        source,
        /remoteWorkspaceAvailable=\{remoteWorkspaceDockAvailable\}/,
        `${name} must pass it to ProjectToolsPanelToggle`,
      );
    }
    // 判据与 dock 自己那份一致：远程项目身份 + SFTP 通道。
    assert.match(
      chatPageSource,
      /remoteWorkspaceRoot\(activeWorkspaceProject\) && tauriSftpClient/,
    );
    assert.match(
      gatewayViewSource,
      /remoteWorkspaceRoot\(activeWorkspaceProject\) && sftpClient/,
    );
  });

  test("the disabled local-project message never hides the chooser for a remote project", () => {
    // `disabledMessage` 仍要传给面板（本地项目工具就是靠它被禁用的），但
    // `showDisabledMessage` 会因为 remoteWorkspaceAvailable 而让位给 chooser。
    assert.match(
      dockPanelSource,
      /const showDisabledMessage = Boolean\(\s*disabledMessage &&[\s\S]*?!remoteWorkspaceAvailable,\s*\);/,
    );
    assert.match(
      dockPanelSource,
      /const showRightDockChooser =\s*!showDisabledMessage &&\s*\(projectReady \|\| tunnelAvailable \|\| remoteWorkspaceAvailable\)/,
    );
  });
});
