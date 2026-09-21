# 远程工作空间侧栏（Bash + SFTP 协同）

> 状态：已实现。本文档描述在「活动项目是远程文件夹（`ssh://<hostId>/<abs>`）」时，
> 右侧项目工具侧栏（Right Dock）新增的 `remoteWorkspace` 工具：一个面板里同时给
> Bash 交互终端与 SFTP 文件管理器，二者绑定**同一条 SSH 会话**、**同一个远端根**。
> 前置阅读：[workbench-project-tool-panes.md](workbench-project-tool-panes.md)、
> [session-workbench-pane-architecture.md](session-workbench-pane-architecture.md)。

## 1. 背景与目标

远程工作空间下 `localWorkspaceProjectPath` / `cwd` 都是空串（身份串不是本地路径，
见 `ChatPage.tsx` 的解析层），于是 Right Dock 的项目工具（文件树 / 审查 / SSH 隧道）
按既有规则整体禁用。用户此时唯一能碰远程文件的方式是全屏 SSH overlay（bash tab 与
SFTP tab 二选一显示），既看不到「当前远程文件夹」，也无法边看文件边敲命令。

目标：

1. 在远程文件夹的上下文里提供一个**可打开的侧栏**：Bash 与 SFTP 同屏，且都停在
   当前项目的远端根上。
2. **不复制**任何既有实现：Bash 区是 `XTermViewport`，SFTP 区是
   `WorkspaceSftpPanel`，连接/主机密钥/认证提示沿用【SSH 隧道】面板与远程文件夹
   选择器的那套 `createSsh` / `answerSshPrompt` 流程。
3. 会话只有一条：侧栏、dock 终端 tab、工作台 Pane 看到的是同一个 `sessionId`，
   因此 `exit`、重连、关闭的状态处处一致。
4. 桌面端与 WebUI 行为一致：实现放在共享层 `@liveagent/ui`，两端只注入 client 与
   回调；它同时是 Right Dock tab 与 Workbench Pane（租约语义不变）。

非目标：

- 不改变本地项目下任何工具的行为（`showLocalPane` / `initialRemotePath` 都是可选
  参数，省略即原行为）。
- 不在远程工作空间里提供「本地↔远端」传输（见 §8）。

## 2. 领域模型

### 2.1 新的工具种类

```ts
// crates/agent-ui/src/lib/settings/types.ts
export const RIGHT_DOCK_TOOL_KINDS = [
  "fileTree", "gitReview", "tunnel", "sshTunnel", "remoteWorkspace",
] as const;
```

- tab id：`tool:remoteWorkspace`（`RIGHT_DOCK_SINGLETON_TAB_IDS`），沿用既有的
  「项目级单例 + tabOrder + activeTabId」持久化与归并规则。
- 它同时加入 `PROJECT_TOOL_SURFACE_KINDS`，因此自动获得 Pane 化能力（身份键
  `remoteWorkspace:<projectPathKey>`、拖拽载荷、租约隐藏、布局恢复、最小尺寸
  `320×320`）。
- 标题/图标统一由 `PROJECT_TOOL_SURFACE_TITLE_KEYS` 与 registry 提供
  （`projectTools.remoteWorkspaceTitle`）。

### 2.2 可用性（与其它项目工具互补）

| 工具 | 依赖 |
|---|---|
| fileTree / gitReview / sshTunnel | `projectReady`（本地项目根非空） |
| tunnel | `tunnelAvailable` |
| **remoteWorkspace** | `remoteWorkspaceTarget`（身份串解析出的 `{hostId, hostName, rootPath}`）+ 宿主注入的 `clients.sftp` |

`projectRequired` 保留原义，新增 `remoteRequired?: boolean`；`RightDockLauncher`
把「可用性」与「禁用说明」收敛成 `toolAvailable()` / `toolDisabledMessage()` 两个纯
函数，三个类别各取一句话：

- 项目工具 → `disabledMessage`
- 远程工作空间 → `projectTools.remoteWorkspaceNeedsRemote`
- 内网穿透 → 不挂 tooltip（原因由面板自己解释）

`rightDockTabRequiresProject()` 相应改为「只排除 tunnel 与 remoteWorkspace」，
`getRightDockVisibleTabs()` 增加 `remoteWorkspaceAvailable` 选项：项目被换成非远程
后残留的持久化 tab 会自然消失，而不是渲染一个空面板。

### 2.3 入口可达性（顶栏折叠按钮的例外）

两个入口（dock 空态卡片、dock「+」菜单）都在 Right Dock 里面，所以「能不能打开
dock」本身就是这个功能的前置条件，而它此前恰好是断的：

- 远程项目的本地根恒为空 → 宿主的 `terminalDisabledMessage` /
  `projectToolsDisabledMessage` 必定有值；
- `ProjectToolsPanelToggle` 当时是 `disabled={Boolean(disabledMessage) && !isOpen}`，
  于是**远程文件夹里顶栏的 dock 折叠按钮是灰的**，dock 打不开 → 侧栏无处可见，
  也谈不上拖到工作台。

修法是把「本地项目工具的不可用原因」与「面板入口能不能点」解耦：折叠按钮新增
`remoteWorkspaceAvailable?: boolean`，判据与 dock 内部那份一致（远程项目身份 +
宿主注入的 SFTP 通道），只有两者都假时才禁用；`title` 也只在真的禁用时使用
`disabledMessage`，可用时回到「展开项目工具面板」。

与之配套的两点：

- `disabledMessage` 仍照旧传给 `RightDockPanel`（本地项目工具就是靠它被禁用的），
  但 `showDisabledMessage` 会因为 `remoteWorkspaceAvailable` 为真而让位给
  `RightDockChooser` —— 否则远程项目下只会看到那句「Select a project…」，卡片
  永远不出现。
- launcher 的禁用原因（tooltip）只在**该项真的禁用**时才挂。可点的一项带着
  「该功能只在远程文件夹中可用」会让人以为点不动。

## 3. 组件改动

| 文件 | 改动 |
|---|---|
| `lib/settings/types.ts` | 新增工具种类 `remoteWorkspace` |
| `lib/settings/rightDockNormalization.ts` | 新增 tab id `tool:remoteWorkspace`（`uiState` 走通用 `normalizeRightDockRecord`，因此分割比例可持久化） |
| `lib/workbench/types.ts` · `geometry.ts` · `reducer.ts` · `projectToolSurfaces.ts` | 新 kind 的身份键、最小尺寸、项目引用校验、标题键 |
| `lib/workspaceRemoteProject.ts` | 新增纯函数 `remoteWorkspaceShellCdCommand(rootPath)`：POSIX 单引号转义 + `..` 折叠，`.`/空返回空串 |
| `components/project-tools/rightDockModel.ts` | 新增分割比例的夹紧/读写纯函数（`clampRemoteWorkspaceSplitRatio` / `remoteWorkspaceSplitRatio` / `withRemoteWorkspaceSplitRatio`）与 `remoteWorkspaceInitialized` |
| `components/project-tools/RightDockContext.tsx` | `clients.sftp`、`capabilities.remoteWorkspaceTarget/DisabledMessage`、新增 `remoteWorkspace` 上下文组（比例 + 两个回调） |
| `components/project-tools/RemoteWorkspacePanel.tsx` | **新面板**（见 §4/§5） |
| `components/project-tools/rightDockRegistry.tsx` | 注册 `remoteWorkspace`：`remoteRequired: true`、`isAvailable` 判定、`render` 里 `key={projectPathKey}` 保证切项目即重挂 |
| `components/project-tools/RightDockPanel.tsx` | 从 `workspaceProject` 解析远端根、`sftpClient` 注入、`showDisabledMessage`/`showRightDockChooser`/`startToolTab` 增加远程分支、装配 context |
| `components/project-tools/RightDockLauncher.tsx` | 可用性/禁用说明收敛为 `toolAvailable()` / `toolDisabledMessage()`；禁用原因（tooltip）只在禁用态挂 |
| `components/project-tools/ProjectToolsPanelToggle.tsx` | 新增 `remoteWorkspaceAvailable`：本地项目工具的禁用文案不再锁死整块面板的入口（见 §2.3） |
| `components/project-tools/useRightDockProjectTabs.ts` | `remoteWorkspaceInitialized`（tab 初始化/渲染开关） |
| `components/project-tools/XTermViewport.tsx` | 新增可选 `initialInput`（attach 成功后写入；值重新变非空视为换会话，重新武装）与 `reconnectInput`（`reconnected` 事件后重发） |
| `components/workspace-editor/WorkspaceSftpPanel.tsx` | 新增可选 `initialRemotePath` 与 `showLocalPane`（默认 true，overlay 行为不变）；单栏时不做并排滚动与移动端切换器 |
| `components/workbench/ProjectToolPaneHost.tsx` | 环境新增 `remoteWorkspace` 组；`case "remoteWorkspace"` 直接复用 registry 的同一工具组件 |
| `crates/agent-gui/src/pages/ChatPage.tsx` | 注入 `sftpClient` / `onOpenSftpFile` / 比例读写回调 |
| `crates/agent-gateway/web/src/app/GatewayAppView.tsx` | 同上（WebUI 镜像） |
| `i18n/translations/{zhCN,enUS}Common.ts` | 9 条新文案 |

## 4. 状态管理

### 4.1 会话解析与所有权

- 解析：`findUsableSessionForHost(sessions, target.hostId)`，优先本项目那条
  （`projectPathKey` 匹配 + 已连接 + 已开 SFTP）。复用别项目在同主机上开的会话是
  刻意的：一条连接同时服务多处视图，避免同一主机堆叠会话。
- 创建：`client.createSsh({ cwd: "", projectPathKey, hostId, sftpEnabled: true })`。
  - `cwd` 是会话的**本地锚点**，远程项目按定义没有本地根，后端
    `resolve_ssh_session_local_anchor` 会清空它；这里显式传空串，语义一致。
  - `sftpEnabled: true` 是硬要求：SFTP 区马上要列目录，没开的会话会被后端
    `ensure_session_allowed` 拒绝。
- 提示：`result.prompt`（主机密钥 / 认证）内联成卡片，走 `answerSshPrompt` /
  `cancelSshPrompt`；成功后 `onSessionSnapshot(snapshot)` 把会话并进页面级列表 ——
  与 SSH 隧道面板完全一致，所以 dock 终端 tab、Pane、其他视图立刻能看到它。
- 重连：面板状态行有重连按钮；`sshReconnect` 成功后用 `onSessionsReconcile` 回写
  单条会话。后端报「session not found」（幽灵记录）时调 `onSessionClosed` 清掉，
  keyboard-interactive 主机则提示回【SSH 隧道】面板走完整流程（重连路径没有提示
  通道）。

### 4.2 面板内状态

| 状态 | 归属 | 说明 |
|---|---|---|
| 连接/提示/重连中的瞬时态、错误桶 | 面板 `useState` | 与 SshTunnelPanel 同口径：列表级错误与视口级错误分开 |
| 「已 cd 过的 (会话 id, 远端根)」 | **模块级** `Set<string>`（`remoteWorkspaceCdSentKeys`） | 见 §4.3 |
| Bash 区高度比例 | `tools.remoteWorkspace.uiState.splitRatio` | 拖动/键盘调整**结束时**才提交，避免拖动过程反复写设置；夹紧到 `[0.2, 0.8]` |
| 拖动中的比例 | 面板 `useState` | 只在本地跟手；外部改动（跨端同步）在没有拖动时跟进 |
| SFTP 双栏/远端路径、选中、传输队列 | `WorkspaceSftpPanel` 内部 | 复用既有实现，侧栏只透传 `session` 与 `client` |

### 4.3 为什么需要「一次性 `cd`」

SSH shell 通道的起始目录由服务端决定（通常是登录用户家目录），`createSsh` 的 `cwd`
对远端目录没有任何作用。因此「终端停在当前远程文件夹」只能靠会话建立后发一次
`cd '<远端根>'`：

- 命令由纯函数 `remoteWorkspaceShellCdCommand()` 生成（单引号 + `'\''` 转义是
  POSIX shell 里唯一无副作用的写法；远端可能是 bash / sh / zsh）。
- `XTermViewport` 的 `initialInput` 在**attach 成功后**写入，写入即清空自己的 ref；
  且 ref 只在值**非空**时被覆盖 —— 清空表示「这条已经写过」，不是「撤销写入」。
  值重新变非空（面板换了会话）说明这是新 shell，必须重新武装，否则新会话永远
  收不到锚点。
- 面板按 **(会话 id, 远端根)** 记账，集合放在**模块级**：dock 与工作台是两个面板
  实例，把工具拖到工作台时 dock 卸载、工作台新挂，实例级记账会重发 `cd`，把用户
  手动 `cd` 到的目录拽回远端根。换项目（= 换远端根）会重新发，重挂不会。
- 记账时机是「视口真的挂上了」（`active`）：tab 只是被打开但还不是活跃 tab 时不
  消费这次机会，切回来才发。
- **重连是例外，必须重发**：SSH 重连换的是新 shell（起始目录回到家目录），而会话
  id 不变 —— 面板的记账与 `initialInput` 都救不回来。因此视口额外接收
  `reconnectInput`，在 `reconnected` 事件后重写一次（后端在广播该事件前就装好了
  新的输入通道，写入不会丢；流尚未 attach 时先武装 `initialInput` ref，由 attach
  成功那一刻补写）。

## 5. 面板布局

```
┌───────────────────────────────────────────────┐
│ ● root@host:22            /srv/app        [⟳] │  状态行（状态点 / 端点 / 远端根 / 重连）
├───────────────────────────────────────────────┤
│ Bash 终端（XTermViewport）                     │  flexGrow = ratio
│                                               │  flexBasis = 0，min-height: 0
├────────────── 分隔条（可拖 / ↑↓）─────────────┤  role="separator"，h-2
│ SFTP：远端设备（WorkspaceSftpPanel）           │  flexGrow = 1 - ratio
│   initialRemotePath=<远端根> showLocalPane=false│
└───────────────────────────────────────────────┘
```

- 上下两块都用 `flexBasis: 0 + flexGrow` 分配高度，两块都 `min-h-0`：xterm 的
  canvas 与 SFTP 的行列表都会撑破容器高度，必须显式允许收缩。
- 分隔条是 `role="separator"` + `tabIndex=0`：指针拖拽（`pointerdown/move/up` +
  `setPointerCapture`）与 `↑/↓`（`Shift` 大步长）都能调整；`aria-valuenow` 用百分比
  表达，拖动结束才提交持久化。
- Bash 视口只在「本 tab 是 dock 的活跃 tab / Pane 可见」时挂载：非活跃时隐藏容器
  尺寸为 0，xterm 的 fit 会算出无效行列；重新挂载时 attach 协议带 offset 快照，
  scrollback 无损重建，所以这里不需要 keep-alive。
- SFTP 区在 `showLocalPane={false}` 下是单栏：不做并排滚动（`overflow-x-hidden`），
  也不显示移动端本地/远端切换器。
- 面板最小尺寸 `320×320`（`MIN_REMOTE_WORKSPACE_PANE_*`）：终端 140 + SFTP 行列表
  ~160 + 状态行与分隔条。

## 6. 协同语义

| 协同点 | 实现 |
|---|---|
| 同一个远端文件夹 | 远端根来自 `remoteWorkspaceRoot(workspaceProject)`（`hostId` + `rootPath`），Bash 用它 `cd`，SFTP 用它作为远端栏初始目录 |
| 同一条连接 | 两个区域都只用 `session`（同 `sessionId`）：断开/重连/退出状态一致，不会出现「终端已断、SFTP 还在读」的错觉 |
| 打开远端文件 | SFTP 行 → `onOpenFile(session, request)` → 宿主的编辑器/预览 overlay（桌面端 `workspaceOverlays.handleOpenSftpFile`，WebUI `handleOpenSftpFile`） |
| 终端输出入会话 | 视口右键「加入会话」→ `onAddTerminalSelectionToConversation`（与 dock 终端同一条回调） |
| 与【SSH 隧道】面板 | 共用主机列表、会话列表与 snapshot/reconcile 回调；在隧道面板里开的会话会立刻出现在侧栏（反之亦然） |

## 7. 测试

| 文件 | 覆盖 |
|---|---|
| `crates/agent-gui/test/workspace/remote-workspace-sidebar.test.mjs` | `cd` 命令的转义与归一化、比例夹紧与持久化往返（含同值 no-op）、`rightDockTabRequiresProject` / `getRightDockVisibleTabs` 的可用性语义、registry/launcher/panel/viewport/SFTP 面板的源码合同、两端宿主注入、入口可达性（折叠按钮的放行判据与 `showDisabledMessage` 让位）、双语案 |
| `crates/agent-gui/test/workspace/remote-workspace-entry-dom.test.mjs` | jsdom + 真实 registry/launcher 渲染：远程项目下空态卡片与「+」菜单都出现且可点（点进去是同一个 kind）、本地项目工具同屏仍禁用并给出原因、本地项目下远程项灰显并解释、顶栏折叠按钮在远程侧栏可用时不被锁死 |
| `crates/agent-gateway/test/webui/remote-workspace-sidebar.test.mjs` | WebUI 宿主合同（SFTP 通道、比例读写、打开远端文件、身份串仍不进本地路径、折叠按钮不被本地项目禁用文案锁死） |
| 既有 `workbench-project-tool-surfaces.test.mjs` | `PROJECT_TOOL_SURFACE_KINDS` 列表已更新（新 kind 走同一套身份/最小尺寸/租约） |

`pnpm typecheck:ui`、gui/webui 的 `tsc --noEmit`、Biome（三端改动路径）、
`check:ui-boundaries` 与上述测试均通过。

## 8. 已知边界

- **本地↔远端传输**：侧栏的 SFTP 区没有本地栏（远程项目没有本地根），因此「上传到
  远端 / 下载至本地」的入口不出现。远端内部的新建、重命名、删除、编辑、复制路径
  不受影响；需要在本地与远端之间搬文件时，用 Bash 区在远端执行
  `scp` / `rsync` / `curl`。
- **租约**：与其它项目工具一样是项目级单例 —— 拖到工作台后 dock 隐藏该 tab，Pane
  关闭后回归；同一工具不会同时出现在两个宿主里。
- **仅远程可用**：本地项目下该工具入口禁用并给出原因文案；把活动项目换成远程
  文件夹后才出现。
- **实机矩阵**：本轮为模型/合同测试 + 三端 tsc/构建级验证，未做三平台实机 SSH
  连接与拖拽验证。
