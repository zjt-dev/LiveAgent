import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

// 「从 SSH 隧道选择远程文件夹」这条入口的接线不变量。远程目录浏览本身的规则由
// remote-workspace-project.test.mjs 覆盖；这里锁的是三件最容易在重构中静悄悄
// 丢掉的事：入口确实挂上了、异常分类没被绕过、本地选文件夹的路径没被改坏。

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing marker: ${endMarker}`);
  return source.slice(start, end);
}

const modalSource = readSource(
  "../../../agent-ui/src/components/chat/WorkspaceCloneModal.tsx",
);
const pickerSource = readSource(
  "../../../agent-ui/src/components/chat/WorkspaceRemoteFolderPicker.tsx",
);
const chatPageSource = readSource("../../src/pages/ChatPage.tsx");
const workspaceProjectsSource = readSource(
  "../../src/pages/chat/workspace/useWorkspaceProjects.ts",
);
const sendChatTurnSource = readSource("../../src/pages/chat/runtime/useSendChatTurn.ts");
const turnRunnerSource = readSource(
  "../../src/pages/chat/turns/runAgentConversationTurn.ts",
);
const gatewayProjectToolsSource = readSource(
  "../../../agent-gateway/web/src/app/hooks/useGatewayProjectTools.ts",
);
const gatewayWorkspaceProjectsSource = readSource(
  "../../../agent-gateway/web/src/app/hooks/useGatewayWorkspaceProjects.ts",
);
const gatewayAppSource = readSource("../../../agent-gateway/web/src/app/GatewayApp.tsx");
const gatewayAppViewSource = readSource("../../../agent-gateway/web/src/app/GatewayAppView.tsx");
const chatPresentationSource = readSource(
  "../../../agent-gateway/web/src/app/hooks/useGatewayChatPresentation.tsx",
);
const composerBarSource = readSource("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx");
const gatewayChatCommandActionsSource = readSource(
  "../../../agent-gateway/web/src/app/gatewayChatCommandActions.ts",
);
const gatewayConversationActionsSource = readSource(
  "../../../agent-gateway/web/src/app/gatewayConversationActions.ts",
);
const manualCompactionSource = readSource(
  "../../src/pages/chat/runtime/useManualCompaction.ts",
);

describe("新建工作空间弹窗的远程入口", () => {
  test("the modal exposes the remote-folder entry next to the local one", () => {
    assert.match(modalSource, /onOpenRemoteFolder: \(\) => void;/);
    assert.match(modalSource, /onOpenRemoteFolder\(\);/);
    assert.match(modalSource, /chat\.workspaceRemoteFolder/);
  });

  test("the local folder and clone flows are still wired", () => {
    // 新增入口不得挤掉原有两种方式。
    assert.match(modalSource, /onOpenFolder: \(\) => void;/);
    assert.match(modalSource, /chat\.workspaceOpenFolder\b/);
    assert.match(modalSource, /chat\.workspaceCloneRepository/);
    assert.match(modalSource, /onLoadBranches/);
  });

  test("ChatPage mounts the picker and hands the modal the new entry", () => {
    assert.match(chatPageSource, /onOpenRemoteFolder=\{handleOpenRemoteWorkspaceFolder\}/);
    assert.match(chatPageSource, /<WorkspaceRemoteFolderPicker/);
    assert.match(chatPageSource, /client=\{tauriRemoteWorkspaceBrowseClient\}/);
    assert.match(chatPageSource, /handleSelectRemoteWorkspaceFolder/);
  });
});

describe("远程目录选择器的异常处理", () => {
  test("failures are classified instead of surfaced raw", () => {
    assert.match(pickerSource, /classifyRemoteWorkspaceError/);
    assert.match(pickerSource, /remoteWorkspaceErrorI18nKey/);
    // 只有兜底分类才允许把原始报错附在文案后面。
    assert.match(pickerSource, /error\.code === "unknown"/);
  });

  test("the tunnel list comes from the settings hosts, not from live sessions", () => {
    // 关键约定：列出【SSH 隧道】里已添加的全部主机，未连接的也要出现 —— 连接动作
    // 就发生在选择器里。曾经只列「已有可用会话」的隧道，等于让用户先去终端面板
    // 手动建一条会话再回来，把连接藏进了另一个界面。
    assert.match(pickerSource, /remoteWorkspaceHostOptions\(hosts, sessions \?\? \[\]\)/);
    assert.match(pickerSource, /hosts: SshHostConfig\[\]/);
    assert.doesNotMatch(pickerSource, /selectableRemoteWorkspaceSessions/);
  });

  test("the picker connects a tunnel itself instead of sending users away", () => {
    assert.match(pickerSource, /client\.connect\(/);
    assert.match(pickerSource, /client\.answerPrompt\(/);
    // 放弃回答时要释放后端待决的提示，否则连接会悬在那里。
    assert.match(pickerSource, /client\.cancelPrompt\(/);
    // 未连接时给出的不是「去别处建会话」，而是就地连接。
    assert.match(pickerSource, /chat\.workspaceRemoteConnectRequiredTitle/);
    assert.match(pickerSource, /chat\.workspaceRemoteConnect\b/);
    assert.match(pickerSource, /chat\.workspaceRemoteConnecting/);
  });

  test("a pending prompt pins the tunnel selection", () => {
    // 提示的答案是送回到原来那条主机的；期间允许换隧道，界面就切到了另一条，
    // 而连上的会话是按当前选中项反查的，于是刚连上的会话再也显示不出来。
    assert.match(pickerSource, /disabled=\{busy \|\| prompt !== null\}/);
  });

  test("a session-list failure degrades to unknown state, not to an empty picker", () => {
    // 隧道列表来自设置，不依赖会话。读会话失败只该让「已连接」标记失效，
    // 不该让用户连隧道都选不了。
    assert.match(pickerSource, /!sessionsLoading && hostOptions\.length === 0 \?/);
    assert.match(pickerSource, /!sessionsLoading && hostOptions\.length > 0 \?/);
  });

  test("both prompt kinds are handled, host key and auth", () => {
    assert.match(pickerSource, /prompt\?\.kind === "hostKey"/);
    assert.match(pickerSource, /chat\.workspaceRemotePromptHostKeyTitle/);
    assert.match(pickerSource, /chat\.workspaceRemotePromptAuthTitle/);
    assert.match(pickerSource, /trustHostKey: true/);
  });

  test("the empty state (no hosts at all) still offers a way out", () => {
    assert.match(pickerSource, /chat\.workspaceRemoteNoHostsTitle/);
    assert.match(pickerSource, /chat\.workspaceRemoteOpenTunnelPanel/);
    assert.match(pickerSource, /onOpenSshTunnelPanel/);
  });

  test("both hosts hand the picker the tunnel list and the session anchor", () => {
    // 会话的 cwd / projectPathKey 必须是本地锚点：远程身份串不是本地路径，而
    // projectPathKey 要和右栏【SSH 隧道】面板同一口径，会话才会归到同一个项目下。
    const desktopMount = sliceBetween(
      chatPageSource,
      "<WorkspaceRemoteFolderPicker",
      "onConfirm={handleSelectRemoteWorkspaceFolder}",
    );
    assert.match(desktopMount, /hosts=\{settings\.ssh\.hosts\}/);
    assert.match(desktopMount, /cwd=\{localWorkspaceProjectPath \|\| workdir\}/);
    assert.match(
      desktopMount,
      /projectPathKey=\{workspaceProjectPathKey\(activeWorkspaceProjectPath\)\}/,
    );

    const webMount = sliceBetween(
      gatewayAppViewSource,
      "<WorkspaceRemoteFolderPicker",
      "onConfirm={handleSelectRemoteWorkspaceFolder}",
    );
    assert.match(webMount, /hosts=\{settings\.ssh\.hosts\}/);
    assert.match(
      webMount,
      /projectPathKey=\{workspaceProjectPathKey\(activeWorkspaceProjectPath\)\}/,
    );
  });

  test("only directories can be confirmed as the workspace root", () => {
    assert.match(pickerSource, /remoteWorkspaceDirectoryCheck/);
    assert.match(pickerSource, /remoteWorkspaceDirectoryEntries/);
  });

  test("the session is re-checked right before the workspace is created", () => {
    // 浏览过程中隧道可能断开；落盘前必须再验一次，否则会存下指向死连接的根。
    const confirmBody = sliceBetween(pickerSource, "async function confirmSelection()", "\n  const canConfirm");
    assert.match(confirmBody, /client\.listSessions\(\)/);
    assert.match(confirmBody, /isRemoteWorkspaceSessionUsable/);
    assert.match(confirmBody, /onConfirm\(/);
  });

  test("the confirmed root is the already-canonical path, not re-resolved against itself", () => {
    // `resolveRemoteDirectoryPath(path, path)` 对相对路径会产出 `a/b/a/b`。
    const confirmBody = sliceBetween(pickerSource, "async function confirmSelection()", "\n  const canConfirm");
    assert.doesNotMatch(confirmBody, /resolveRemoteDirectoryPath/);
  });
});

describe("远程工作空间不污染本地路径语义", () => {
  test("the local directory probe is skipped for remote projects", () => {
    const checkBody = sliceBetween(
      workspaceProjectsSource,
      "const checkWorkspaceProjectDirectory = useCallback(",
      "const activateWorkspaceProject = useCallback(",
    );
    const remoteGuardIndex = checkBody.indexOf("isRemoteWorkspaceProject(project)");
    const localProbeIndex = checkBody.indexOf('invokeFs("fs_list"');
    assert.notEqual(remoteGuardIndex, -1, "remote guard missing");
    assert.notEqual(localProbeIndex, -1, "local probe missing");
    assert.ok(
      remoteGuardIndex < localProbeIndex,
      "remote projects must return before the local fs probe marks them missing",
    );
  });

  test("local-only actions reject remote projects with an explicit reason", () => {
    // 只有「本地才能做」的事才拒绝：在本地文件管理器里打开、在本地文件树里展开。
    // 对话不在此列 —— agent 走 SSHManager 在远端干活，远程工作空间照常能对话。
    assert.match(workspaceProjectsSource, /chat\.workspaceRemoteRevealUnsupported/);
    assert.match(workspaceProjectsSource, /chat\.workspaceRemoteFileTreeUnsupported/);
    assert.doesNotMatch(workspaceProjectsSource, /workspaceRemoteConversationUnsupported/);
  });

  test("the created project keeps host identity, not a local path", () => {
    const createBody = sliceBetween(
      workspaceProjectsSource,
      "const handleSelectRemoteWorkspaceFolder = useCallback(",
      "const handleDropWorkspaceFolders",
    );
    assert.match(createBody, /createRemoteWorkspaceProject\(/);
    assert.match(createBody, /hostId: selection\.hostId/);
    assert.match(createBody, /rootPath: selection\.rootPath/);
  });

  test("the chosen tunnel is recorded in the project SSH association on both hosts", () => {
    // 选完目录就把「这个工作空间属于哪条隧道」写进【SSH 隧道】的【项目 SSH】。
    // 不写这一步，用户事后得自己去面板里再勾一次，而那时他多半已经记不得当初
    // 选的是哪条隧道。key 用 project.path（身份串），与面板同一口径。
    const desktopBody = sliceBetween(
      workspaceProjectsSource,
      "const handleSelectRemoteWorkspaceFolder = useCallback(",
      "const handleDropWorkspaceFolders",
    );
    assert.match(
      desktopBody,
      /updateSshProjectHostIds\(prev, project\.path, \[selection\.hostId\]\)/,
    );

    const webBody = sliceBetween(
      gatewayWorkspaceProjectsSource,
      "const handleSelectRemoteWorkspaceFolder = useCallback(",
      "const handleCloneWorkspaceProject = useCallback(",
    );
    assert.match(webBody, /updateSshProjectHostIds\(prev, project\.path, \[selection\.hostId\]\)/);
  });
});

// 回归：身份串曾经从四条旁路进到会话 workdir，agent 的每个工作区工具都报 workdir 非法。
// 现在的口径是「拦身份串，不拦会话」：远程工作空间照常开新会话、照常发送，但 workdir
// 必须留空 —— agent 走 SSHManager 在远端干活，不需要本地根目录。
//
// 早先的版本把这两件事混在一起，结果是用户连话都说不出来，而 agent 本来就有远程文件
// 读写能力（SSHManager 的 exec / sftp_*）。下面锁住「别再退回去」。
describe("会话入口与发送路径拦的是身份串，不是会话本身", () => {
  test("every new-conversation entry lets a remote workspace through", () => {
    const menuBody = sliceBetween(
      workspaceProjectsSource,
      "const handleNewConversationForProject = useCallback(",
      "const ensureTunnelToolTab = useCallback(",
    );
    assert.doesNotMatch(menuBody, /isRemoteWorkspaceProject\(project\)/);
    assert.doesNotMatch(menuBody, /workspaceRemoteConversationUnsupported/);

    const buttonBody = sliceBetween(
      chatPageSource,
      "const handleNewConversation = useCallback(",
      "const handleNewConversationRef = useRef(handleNewConversation)",
    );
    assert.doesNotMatch(buttonBody, /isRemoteWorkspacePath\(activeWorkspaceProjectPath\)/);
    assert.doesNotMatch(buttonBody, /workspaceRemoteConversationUnsupported/);
    // workdir 仍然只走本地派生值，身份串不会下发。
    assert.match(
      buttonBody,
      /workdir: isAgentMode \? localWorkspaceProjectPath \|\| undefined : undefined/,
    );

    const defaultWorkdirBody = sliceBetween(
      chatPageSource,
      "getDefaultNewConversationWorkdir:",
      "resolveConversationSelectedModel:",
    );
    assert.match(defaultWorkdirBody, /isRemoteWorkspacePath\(activeWorkspaceProjectPath\)/);
  });

  test("the blank-conversation workdir sync skips a remote identity string", () => {
    // 这条是实际踩中的旁路：空白会话的 workdir 会被自动同步成当前工作区路径。
    const syncBody = sliceBetween(
      chatPageSource,
      "const nextWorkdir = activeWorkspaceProjectPath.trim();",
      "updateConversationRuntimeEntry(conversationId, (prev) => ({",
    );
    assert.match(syncBody, /isRemoteWorkspacePath\(nextWorkdir\)/);
  });

  test("the send path no longer blocks a remote workspace", () => {
    // 远程下 workdir 必然为空，但那是预期状态（本地工具本就无从作用），不是错误。
    assert.doesNotMatch(sendChatTurnSource, /workspaceRemoteConversationUnsupported/);
    assert.doesNotMatch(sendChatTurnSource, /if \(effectiveIsAgentMode && !effectiveWorkdir\) \{/);
  });

  test("the send path binds the session to the remote project instead of a local workspace", () => {
    // 落盘 cwd 是**侧栏归属键**：远程项目下它必须是身份串（工具 workdir 则恒为空）。
    // 曾经 resolveConversationPersistedCwd 算出来了却没人用 —— 发送路径的每一次历史写入
    // 都传工具 workdir（远程下为空），而 upsert 是 `cwd = excluded.cwd`：agent 轮次内部
    // 写好的身份串会被外层的收尾写入**清空**，连待发消息的乐观行也一起归零。
    // 用户看到的就是「在远程文件夹里发消息，会话跑到了另一个本地工作空间下」。
    assert.doesNotMatch(
      sendChatTurnSource,
      /historyCwd/,
      "工具 workdir 不得再被当作落盘 cwd",
    );
    const cwdWrites = (sendChatTurnSource.match(/cwd:/g) ?? []).length;
    assert.ok(cwdWrites > 0, "发送路径应当有历史写入点");
    assert.equal(
      (sendChatTurnSource.match(/cwd: conversationCwd,/g) ?? []).length,
      cwdWrites,
      "所有历史写入点（含待发消息的乐观行）都必须用会话锚点",
    );
    // 运行时 workdir 与落盘 cwd 同源：侧栏 running 分组键、草稿的项目身份判定都读它。
    assert.match(sendChatTurnSource, /workdir: conversationCwd,/);
    // text 模式的兜底必须继续传进去，否则它每轮都会把 cwd 写成空。
    assert.match(sendChatTurnSource, /^\s*promptWorkdir,$/m);
    // 身份串仍要下发到 turn runner（SSHManager 注册与隧道归属都靠它）。
    assert.match(sendChatTurnSource, /^\s*conversationCwd,$/m);
  });

  test("the optimistic pending row keeps the conversation anchor, not the local-root view", () => {
    // 第三个写入点：ChatPage 给「运行中但还没进侧栏列表」的会话补一行乐观行。
    // 它原来用 displayedConversationWorkdir —— 那是**本地根视图**，远程下恒为空
    // （身份串被剥掉），于是这行要么过不了远程项目的 scope 匹配，要么掉进
    // 「无工作空间」桶。运行时 workdir 才是锚点：打开会话时由 record.conversation.cwd
    // 写入，发送时被会话锚点覆盖。
    const pendingBody = sliceBetween(
      chatPageSource,
      "const pendingItem = createPendingHistoryItem({",
      "if (!conversationMatchesScope(pendingItem, sidebarScope))",
    );
    assert.match(pendingBody, /cwd: runtimeEntry\?\.workdir \|\| displayedConversationWorkdir/);
  });

  test("the SSH association is queried by project identity, not by the empty workdir", () => {
    // 用 workdir 查关联会恒返回空 —— agent 就永远看不到隧道，只会说「没有可用的
    // SSH 主机」，哪怕【项目 SSH】里明明关联着。必须用项目身份查，且与写入侧
    // （选择器按 project.path 存）同源。
    const body = sliceBetween(
      sendChatTurnSource,
      "const activeWorkspaceProject = workspaceProjects.find(",
      "const effectiveIsAgentDevExecutionMode",
    );
    assert.match(body, /const workspaceProjectPath = activeWorkspaceProject\?\.path\?\.trim\(\) \|\| effectiveWorkdir;/);
    assert.match(body, /workspaceProjectPathKey\(workspaceProjectPath\)/);
    assert.match(body, /getSshProjectHostIds\(settings\.ssh, sshProjectPathKey\)/);
    // 身份串还得继续下发到 turn runner：SSHManager 的注册门槛与隧道归属都靠它。
    const turnParams = sliceBetween(
      sendChatTurnSource,
      'await chatRuntimeHost.runTurn({',
      "agentTemplates: settings.agents",
    );
    assert.match(turnParams, /^\s*workspaceProjectPath,$/m);
  });

  test("the turn runner no longer requires a local workdir for a remote workspace", () => {
    // 这是最后一层闸门：runAgentConversationTurn 原本对空 workdir 直接 throw，
    // 远程会话一发消息就会炸在「Tool mode requires a project directory」。
    const gate = sliceBetween(
      turnRunnerSource,
      "const remoteWorkspaceProjectPath = isRemoteWorkspacePath(",
      "// Reset per-turn dedup state",
    );
    assert.match(gate, /isRemoteWorkspacePath\(workspaceProjectPath\)/);
    assert.match(gate, /if \(!effectiveWorkdir && !remoteWorkspaceProjectPath\) \{/);
    assert.match(gate, /throw new Error\("Tool mode requires a project directory from the chat sidebar\."\)/);
    // 放行不等于不校验：本地仍然要求 workdir，这一层不能被削成无条件跳过。
    assert.doesNotMatch(gate, /if \(!effectiveWorkdir\) \{\s*\n\s*throw/);
  });

  test("the tunnel ownership key follows the project identity, not the empty workdir", () => {
    // SSHManager 的注册门槛是 `projectPathKey.trim()` 为真（见 sshManagerTools）。
    // 隧道归属 key 若在远程下为空，工具根本不注册 —— agent 连 SSHManager 都拿不到。
    // `|| effectiveWorkdir` 是本地退回：本地 remoteWorkspaceProjectPath 为空，
    // 原样用 workdir，本地行为不变。
    assert.match(
      turnRunnerSource,
      /tunnelProjectPathKey: workspaceProjectPathKey\(remoteWorkspaceProjectPath \|\| effectiveWorkdir\)/,
    );
  });

  test("the remote workspace context is injected into the system prompt", () => {
    // 远程下 workdir 为空、本地工具无从作用，agent 必须被显式告知改走 SSHManager。
    const body = sliceBetween(
      sendChatTurnSource,
      "const activeRemoteRoot = activeWorkspaceProject",
      "const effectiveIsAgentDevExecutionMode",
    );
    assert.match(body, /remoteWorkspaceRoot\(activeWorkspaceProject\)/);
    assert.match(body, /buildRemoteWorkspacePrompt\(activeRemoteRoot\)/);

    const buildersSource = readSource(
      "../../src/pages/chat/runtime/conversationContextBuilders.ts",
    );
    assert.match(buildersSource, /remoteWorkspacePrompt\?: string;/);
    assert.match(
      buildersSource,
      /if \(params\.remoteWorkspacePrompt\) \{\s*\n\s*systemPrompt = appendSystemPrompt\(systemPrompt, params\.remoteWorkspacePrompt\);/,
    );
    // 追加顺序必须与轨迹的 TRAJECTORY_PROMPT_SECTION_SLOTS 逐项一致（agent →
    // remoteWorkspace → skills），否则 composeTrajectorySystemPrompt 重建不出原样，
    // 每轮都会掉进 drift fallback 并把整段 prompt 记成 runtime。
    assert.match(
      buildersSource,
      /appendSystemPrompt\(systemPrompt, params\.activeAgentPrompt\)[\s\S]*?appendSystemPrompt\(systemPrompt, params\.remoteWorkspacePrompt\)[\s\S]*?appendSystemPrompt\(systemPrompt, params\.skillsPrompt\)/,
    );
  });
});

// 回归：身份串是「不透明的项目身份」，不是本地路径。凡是把它下发给本地文件系统、
// 终端或文件选择器的地方都会失败，这里把已识别的几处一起锁住。
describe("本地子系统拿不到远程身份串", () => {
  test("the desktop terminal cwd is emptied for a remote workspace", () => {
    assert.match(
      chatPageSource,
      /const localWorkspaceProjectPath = isRemoteWorkspacePath\(activeWorkspaceProjectPath\)/,
    );
    assert.match(
      chatPageSource,
      /const terminalProjectPath = isAgentMode \? localWorkspaceProjectPath : "";/,
    );
    // key 仍保留项目身份，否则右栏终端的分组与会话归属会错位。
    assert.match(
      chatPageSource,
      /const terminalProjectPathKey = isAgentMode\s*\n\s*\? workspaceProjectPathKey\(activeWorkspaceProjectPath\)/,
    );
  });

  test("initial directories never fall back to the identity string", () => {
    assert.match(chatPageSource, /initialParent=\{localWorkspaceProjectPath \|\| workdir\}/);
    assert.match(
      workspaceProjectsSource,
      /initial_workdir:[\s\S]{0,90}isRemoteWorkspacePath\(activeWorkspaceProjectPath\)/,
    );
    assert.match(
      gatewayAppViewSource,
      /initialWorkdir=\{localWorkspaceProjectPath \|\| settings\.system\.workdir\.trim\(\)\}/,
    );
    assert.match(
      gatewayAppViewSource,
      /initialParent=\{localWorkspaceProjectPath \|\| settings\.system\.workdir\.trim\(\)\}/,
    );
  });

  test("the webui terminal and resource workdirs reject the identity string too", () => {
    assert.match(
      gatewayProjectToolsSource,
      /const terminalProjectPath =\s*\n\s*isAgentMode && !isRemoteWorkspacePath\(activeWorkspaceProjectPath\)/,
    );
    // 选择器/终端的本地根派生已经下移到挂载点（GatewayAppView），GatewayApp 只负责
    // 会话与资源的根视图解析，两者都不得把身份串当本地路径。
    assert.match(
      gatewayAppViewSource,
      /const localWorkspaceProjectPath = isRemoteWorkspacePath\(activeWorkspaceProjectPath\)/,
    );
    // 两处本地根视图（资源解析、会话根目录）都改走共享解析函数：远程活动项目下留空，
    // 不再各自内联「本地项目 || 全局 workdir」的回退链（那会把会话挂到之前打开的本地文件夹）。
    for (const name of ["resourceWorkdir", "displayedConversationWorkdir"]) {
      assert.match(
        gatewayAppSource,
        new RegExp(`const ${name} = resolveConversationDisplayWorkdir\\(`),
        `${name} 必须走共享的本地根视图解析`,
      );
    }
  });
});

// 回归：WebUI 侧的会话 workdir 有和桌面端完全同构的问题 —— 身份串会从「发送」、
// 「上传路由」、「Pane composer」、「新建会话」四条路径进入 gateway 的 workdir。
// 这里锁住每条路径都过同一个 helper，而不是各自散落一个判断。
describe("WebUI 的会话 workdir 同样拒绝身份串", () => {
  test("the send path wraps the whole fallback chain, not each source", () => {
    const body = sliceBetween(
      gatewayChatCommandActionsSource,
      "const effectiveWorkdir = rejectRemoteWorkdir(",
      "if (effectiveWorkdir)",
    );
    // 五条来源都必须在被包裹的表达式里，否则漏掉的那条会直接把身份串送出去。
    for (const source of [
      "sendOptions?.workdir",
      "persistedWorkdir",
      "runtimeWorkdir",
      "activeWorkspaceProjectPath",
      "settings.system.workdir",
    ]) {
      assert.ok(body.includes(source), `fallback chain is missing ${source}`);
    }
  });

  test("the queued-turn path and the upload route are gated too", () => {
    assert.equal(
      (gatewayChatCommandActionsSource.match(/rejectRemoteWorkdir\(/g) ?? []).length,
      3,
      "expected one helper definition plus two call sites in gatewayChatCommandActions",
    );
    assert.match(
      gatewayAppSource,
      /return rejectRemoteWorkdir\(\s*\n\s*resolveConversationUploadWorkdir\(\{/,
    );
    assert.match(
      gatewayAppSource,
      /conversationWorkdirFor: \(conversationId\) => \{\s*\n\s*\/\/[\s\S]{0,200}rejectRemoteWorkdir\(/,
    );
  });

  test("every startNewConversation call in webui goes through one shared gate", () => {
    // 桌面端就是因为只拦了一个入口而漏掉另外两条，这里要求三处共用同一个表达式。
    assert.equal(
      (
        gatewayConversationActionsSource.match(
          /workdir: newConversationWorkdir\(options\.isAgentMode, options\.activeWorkspaceProjectPath\)/g,
        ) ?? []
      ).length,
      3,
      "all three startNewConversation call sites must share newConversationWorkdir",
    );
    assert.doesNotMatch(
      gatewayConversationActionsSource,
      /workdir: options\.isAgentMode \? options\.activeWorkspaceProjectPath/,
    );
    assert.match(
      gatewayConversationActionsSource,
      /function newConversationWorkdir\(isAgentMode: boolean, activeWorkspaceProjectPath: string\)/,
    );
  });
});

// 远程工作空间照常可以输入与发送：agent 走 SSHManager 在远端干活，workdir 为空是预期
// 状态。这里锁住「别再把远程当成 composer 的禁用条件」—— 早先那样做，等于让用户连话
// 都说不出来，而 agent 本来就有远程文件读写能力。
describe("远程工作空间不再禁用 composer", () => {
  test("the composer surfaces still share one disabled switch", () => {
    // 与远程无关的通用前提：isInputDisabled 必须同时盖住输入框与发送按钮，
    // 否则会出现「能打字但发不出去」的更差体验。
    assert.match(composerBarSource, /disabled=\{isInputDisabled \|\| stt\.active\}/);
    assert.match(
      composerBarSource,
      /const sendDisabled = isInputDisabled \|\| stt\.active \|\| isUploadingFiles \|\| !hasSendableDraft;/,
    );
  });

  test("desktop no longer keys the composer off the remote workspace", () => {
    assert.doesNotMatch(chatPageSource, /isRemoteWorkspaceConversation/);
    assert.doesNotMatch(chatPageSource, /workspaceRemoteComposerDisabled/);

    const disabledBody = sliceBetween(
      chatPageSource,
      "const isComposerInputDisabled =",
      "const canDropUpload =",
    );
    assert.match(disabledBody, /^const isComposerInputDisabled =\s*\n\s*isCompactionRunning \|\|/);

    const placeholderBody = sliceBetween(
      chatPageSource,
      "const composerPlaceholder = isCompactionRunning",
      "const isComposerInputDisabled =",
    );
    assert.match(placeholderBody, /chat\.compactingContextWait/);
  });

  test("the workbench primary pane keeps the same disabled list", () => {
    // 桌面端 workbench 会重新推导一次 isInputDisabled（多 Pane 场景），这里漏掉就白改。
    assert.match(
      chatPageSource,
      /isInputDisabled:\s*\n\s*isCompactionRunning \|\|\s*\n\s*isConversationHydrationFailed/,
    );
  });

  test("the empty-state suggestion cards share the same gate", () => {
    // 建议卡片点一下就是发消息：必须和 composer 共用同一个「不可输入」判定，
    // 否则会出现「输入框禁了但卡片还能点」的第二条旁路。
    assert.match(
      chatPageSource,
      /suggestionsDisabled: isSuggestionTyping \|\| isComposerInputDisabled,/,
    );
    assert.match(
      gatewayAppViewSource,
      /suggestionsDisabled: isSuggestionTyping \|\| composerInputDisabled,/,
    );
    assert.match(
      gatewayAppViewSource,
      /suggestionsDisabled=\{\s*\n\s*isSuggestionTyping \|\| composerInputDisabled\s*\n\s*\}/,
    );
  });

  test("webui no longer keys its composer off the remote workspace either", () => {
    assert.doesNotMatch(chatPresentationSource, /isRemoteWorkspaceConversation/);
    assert.doesNotMatch(chatPresentationSource, /workspaceRemoteComposerDisabled/);

    const disabledBody = sliceBetween(
      chatPresentationSource,
      "const composerInputDisabled =",
      "const composerPlaceholder =",
    );
    assert.match(disabledBody, /!status\?\.online/);
  });
});

describe("远程环境事实在压缩后仍然保留", () => {
  // 远程工作空间的环境事实（连哪台主机、远端根在哪）由发送链路拼进 system prompt。
  // 压缩会用**另一条**绑定重建同一份 system prompt —— 两个绑定不同源，压缩后 agent
  // 就只剩「没有本地根」，不知道该连哪台主机，等于把发送时给过的上下文静默丢掉。
  // 这条是纯接线检查：压缩绑定必须把 remoteWorkspacePrompt 一起传下去。
  test("the compaction binding forwards remoteWorkspacePrompt to both builders", () => {
    for (const builder of ["buildPreparedConversationContext", "buildResumeConversationContext"]) {
      const body = sliceBetween(manualCompactionSource, `${builder}({`, "}),");
      assert.match(
        body,
        /remoteWorkspacePrompt,/,
        `${builder} must receive remoteWorkspacePrompt, otherwise compaction drops the remote facts`,
      );
    }
  });

  test("the compaction prompt inputs actually produce a remote workspace prompt", () => {
    const body = sliceBetween(
      chatPageSource,
      "const resolveManualCompactionPromptInputs = useCallback(",
      "const handleManualCompact = useManualCompaction(",
    );
    // 必须真的构造出来，而不只是把空串传下去。
    assert.match(body, /remoteWorkspaceRoot\(/);
    assert.match(body, /buildRemoteWorkspacePrompt\(/);
    // 返回值里必须带上这个字段，否则压缩绑定解构出来是 undefined。
    assert.match(body, /remoteWorkspacePrompt:\s*""/);
    assert.match(body, /^\s*remoteWorkspacePrompt,$/m);
  });

  test("the send path and the compaction path resolve the remote project the same way", () => {
    // 两边都必须按活动项目取（远程下 workdir 是空串，按它推导只会得到空）。
    for (const source of [sendChatTurnSource, chatPageSource]) {
      assert.match(source, /activeWorkspaceProjectId/);
    }
    assert.match(sendChatTurnSource, /remoteWorkspaceRoot\(activeWorkspaceProject\)/);
    assert.match(chatPageSource, /remoteWorkspaceRoot\(activeProject\)/);
  });

  test("both paths inject it only in agent mode", () => {
    // text 模式的 provider 边界会追加 textOnlyRuntime 的规则段
    // 「You are currently in text-only mode: do not make any tool calls.」，而远程段
    // 通篇在教模型怎么调 SSHManager —— 两句直接打架。text 模式下没有任何工具，
    // 远端工作空间无从作用，这段环境事实也就不该出现。
    assert.match(
      sendChatTurnSource,
      /activeRemoteRoot && effectiveIsAgentMode \? buildRemoteWorkspacePrompt\(activeRemoteRoot\) : ""/,
    );
    assert.match(
      chatPageSource,
      /remoteRoot && isAgentMode \? buildRemoteWorkspacePrompt\(remoteRoot\) : ""/,
    );
    // 反向对照：这两句规则段必须真的存在，否则上面的门控断言可能只是名字对上了。
    const textOnlySuffix = readSource(
      "../../src/lib/providers/runtime/textOnlyRuntime.ts",
    );
    assert.match(textOnlySuffix, /do not make any tool calls/);
  });
});

describe("远程工作空间不把本地文件夹挂成附属目录", () => {
  // 附属目录是「给本地文件工具追加可访问的本地根」，而远程会话下本地文件工具根本不注册
  // （builtinRegistry 的 hasLocalWorkspace 门）。所以挂载不仅无用，下发到 Rust 还会被
  // canonical_directory 拒绝（身份串不是绝对路径）—— 用户看到的是与真实原因无关的
  // 「挂载失败」。两条入口（原生拖拽、选择文件夹）都汇到同一个 dispatcher。
  const uploadZoneDropSource = readSource("../../src/pages/chat/hooks/useUploadZoneDrop.ts");
  const tauriDropSource = readSource("../../src/pages/chat/hooks/useTauriFileDrop.ts");
  const zhSource = readSource("../../../agent-ui/src/i18n/translations/zhCNCommon.ts");
  const enSource = readSource("../../../agent-ui/src/i18n/translations/enUSCommon.ts");

  test("分发器在触碰附属目录之前就拦下远程项目", () => {
    const mount = sliceBetween(
      uploadZoneDropSource,
      "const project = targetProject ?? activeWorkspaceProject;",
      "const existing = await desktopWorkspaceProjectRootClient.list(project);",
    );
    assert.match(mount, /isRemoteWorkspaceProject\(project\)/);
    assert.match(mount, /t\("chat\.workspaceRemoteMountUnsupported"\)/);
    // 正向对照：判定必须早于 list/save 这两次下发，否则错误照样会从 Rust 冒出来。
    assert.ok(
      mount.indexOf("isRemoteWorkspaceProject(project)") <
        mount.indexOf("chat.workspaceRemoteMountUnsupported"),
    );
  });

  test("拖拽与选择文件夹两条入口都走这个分发器", () => {
    assert.match(
      tauriDropSource,
      /importUploadZonePaths\(event\.payload\.paths, targetConversationId\)/,
    );
    assert.match(
      chatPageSource,
      /await importUploadZonePaths\(\[folderPath\], targetConversationId\)/,
    );
  });

  test("提示文案两端都补齐", () => {
    assert.match(zhSource, /"chat\.workspaceRemoteMountUnsupported":/);
    assert.match(enSource, /"chat\.workspaceRemoteMountUnsupported":/);
  });
});

// 远程工作空间下 workdir 为空是**合法状态**（项目锚点是身份串，本地根刻意不给）。
// 「空 workdir 是否合法」只能由知道事实的调用方声明 —— 按长度反推会把真正的配置
// 缺失（没选项目）也一并放行，那正是 runner 要拦的那个错。
describe("空 workdir 的合法性是声明出来的，不是按长度推断的", () => {
  const builtinRegistrySource = readSource("../../src/lib/tools/builtinRegistry.ts");
  const turnSource = readSource("../../src/pages/chat/turns/runAgentConversationTurn.ts");

  test("父轮把这个事实显式交给注册表与 runner", () => {
    assert.match(
      turnSource,
      /allowEmptyWorkdir: Boolean\(remoteWorkspaceProjectPath\),\s*\n\s*runtimeScope: "chat",/,
    );
    assert.match(
      turnSource,
      /allowEmptyWorkdir: Boolean\(remoteWorkspaceProjectPath\),\s*\n\s*additionalRoots,/,
    );
  });

  test("注册表原样透传给子代理，不自己反推", () => {
    assert.match(builtinRegistrySource, /allowEmptyWorkdir\?: boolean;/);
    assert.match(builtinRegistrySource, /allowEmptyWorkdir: params\.allowEmptyWorkdir === true,/);
    // 反向对照：`workdir 长度为 0` 是「有没有本地根」，不是「项目锚点在别处」。
    assert.equal(
      /allowEmptyWorkdir: params\.workdir\.trim\(\)\.length === 0/.test(builtinRegistrySource),
      false,
    );
  });
});
