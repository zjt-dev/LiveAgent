import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

// WebUI 侧的远程工作空间侧栏接线合同。面板、可用性判定与 tab 语义都在共享层
// （`@liveagent/ui`），这里只锁 WebUI 宿主必须自己做的三件事：注入 SFTP 通道、
// 提供 per-project 的分割比例读写、把「打开远端文件」接到编辑器/预览 overlay。
// 桌面端对应合同见 crates/agent-gui/test/workspace/remote-workspace-sidebar.test.mjs。

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const viewSource = readSource("../../web/src/app/GatewayAppView.tsx");
const appSource = readSource("../../web/src/app/GatewayApp.tsx");
const projectToolsSource = readSource("../../web/src/app/hooks/useGatewayProjectTools.ts");
const workbenchSource = readSource("../../web/src/app/workbench/useGatewayWorkbench.ts");
const chatCommandSource = readSource("../../web/src/app/gatewayChatCommandActions.ts");

describe("WebUI 远程工作空间侧栏", () => {
  test("the pane environment carries the SFTP client and the remote target", () => {
    assert.match(viewSource, /clients: \{\s*terminal: terminalClient,[\s\S]{0,220}sftp: sftpClient,/);
    assert.match(
      viewSource,
      /remoteWorkspaceDisabledMessage: translate\(\s*"projectTools\.remoteWorkspaceNeedsRemote",/,
    );
    // 远端根由共享层从活动项目解析（`remoteWorkspaceRoot`），所以宿主必须把活动
    // 项目原样交给 dock；这里锁住这条唯一依赖。
    assert.match(viewSource, /workspaceProject=\{activeWorkspaceProject\}/);
  });

  test("the dock gets the SFTP channel and the remote-file opener", () => {
    assert.match(viewSource, /sftpClient=\{sftpClient\}/);
    assert.match(viewSource, /onOpenSftpFile=\{handleOpenSftpFile\}/);
  });

  test("the split ratio is persisted per project, not per mount", () => {
    assert.match(
      viewSource,
      /getSplitRatio: \(projectPathKey\) =>\s*remoteWorkspaceSplitRatio\(\s*getRightDockProjectState\(settings\.customSettings, projectPathKey\),/,
    );
    assert.match(
      viewSource,
      /updateRightDockProjectState\(current, projectPathKey, \(projectState\) =>\s*withRemoteWorkspaceSplitRatio\(projectState, ratio\),/,
    );
  });

  test("the identity string still never reaches the local project path", () => {
    // 远程项目下本地根必须留空：远程工作空间侧栏的存在不改变这条既有约束，
    // 它自己从项目的 remote 字段解析远端根。
    assert.match(
      viewSource,
      /const localWorkspaceProjectPath = isRemoteWorkspacePath\(activeWorkspaceProjectPath\)/,
    );
    assert.match(
      projectToolsSource,
      /isAgentMode && !isRemoteWorkspacePath\(activeWorkspaceProjectPath\)/,
    );
  });

  test("the dock toggle is not locked by the local-project disabled message", () => {
    // `projectToolsDisabledMessage` 在远程项目下必定有值（本地根为空）。它描述的是
    // 本地项目工具为什么不可用，不能顺手把 dock 的入口也关掉 —— 那样侧栏的入口
    // （都在 dock 里）永远见不到。
    assert.match(
      viewSource,
      /const remoteWorkspaceDockAvailable = Boolean\(\s*activeWorkspaceProject && remoteWorkspaceRoot\(activeWorkspaceProject\) && sftpClient,\s*\);/,
    );
    assert.match(
      viewSource,
      /<ProjectToolsPanelToggle[\s\S]{0,320}remoteWorkspaceAvailable=\{remoteWorkspaceDockAvailable\}/,
    );
    assert.match(
      viewSource,
      /import \{\s*isRemoteWorkspacePath,\s*remoteWorkspaceRoot,\s*\} from "@liveagent\/ui\/lib\/workspaceRemoteProject";/,
    );
  });

  test("the queued-turn workdir resolves the target conversation's own anchor first", () => {
    // 队列补发（`submitCurrentComposerToGuiQueue`）打的是**目标会话**，未必是屏幕上那个。
    // 缺了「目标会话已落盘 cwd」这一环，锚在远程工作空间的会话会掉到显示中/活动项目/
    // 全局那几层 —— 那些是**另一个本地项目**的路径，而桌面侧的 cwd upsert 是
    // `cwd = excluded.cwd`：这个远程会话会被就此改归到本地项目组（用户看到工作空间
    // 被静默换掉）。
    assert.match(
      chatCommandSource,
      /conversationWorkdirsRef\.current\.get\(conversationId\)\?\.trim\(\) \|\|[\s\S]{0,160}sidebarStore\.peek\(conversationId\)\?\.cwd\?\.trim\(\) \|\|/,
    );
    // 整条回退链仍被拒收身份串的闸包着（`ssh://…` 不是本地路径，剥成空串后才轮到
    // 真正的兜底，所以不会串项目）。
    assert.match(
      chatCommandSource,
      /const workdir = rejectRemoteWorkdir\(\s*\([\s\S]{0,600}?settings\.system\.workdir\s*\)\.trim\(\),\s*\);/,
    );
  });

  test("the picker's empty-state exit opens the SSH tunnel pane, not the local tunnel", () => {
    // 选择器空态写的是「先到【SSH 隧道】面板添加一条主机」。内网穿透（kind `tunnel`）
    // 只有端口映射表单、没有主机列表，用它会把人带到一个添加不了主机的界面 ——
    // 而这两个入口在 WebUI 里是两条独立的 kind，光看函数名分不出来。
    assert.match(viewSource, /onOpenSshTunnelPanel=\{\(\) => ensureSshTunnelToolTab\(\)\}/);
    assert.match(appSource, /openRightDockSingletonTab\(prev, targetProjectPathKey, "sshTunnel"\)/);
  });

  test("project-tool drag and open-in-split follow the project identity, not the local root", () => {
    // 远程工作空间没有本地根（`terminalProjectPath` 是空串），但「拖到工作台 / 在分屏中
    // 打开」要的只是「是哪个项目」。按本地路径反推身份会让远程下唯一的工具（远程工作
    // 空间侧栏）在 WebUI 里拖不动，而桌面端按身份键判定 —— 两端行为必须一致。
    assert.match(workbenchSource, /terminalProjectPathKey: string;/);
    assert.match(workbenchSource, /const projectPathKey = terminalProjectPathKey\.trim\(\);/);
    assert.match(appSource, /terminalProjectPathKey,\s*\n\s*newTerminalTitle:/);
    assert.match(
      viewSource,
      /onToolDragStart=\{\s*sessionWorkbench\.enabled && terminalProjectPathKey/,
    );
    assert.match(
      viewSource,
      /onOpenToolInWorkbench=\{\s*sessionWorkbench\.enabled && terminalProjectPathKey/,
    );
    // 反向对照：「新建终端」仍必须看本地根 —— 远程下没有本地目录可建 PTY，
    // 上面两条一旦被顺手改成同一个判据，这里会先失败。
    assert.match(workbenchSource, /const path = terminalProjectPath\.trim\(\);\s*\n\s*if \(!path\) return;/);
  });
});
