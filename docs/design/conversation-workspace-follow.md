# 会话切换 → 活动工作区跟随

> 状态：已实现。本文档说明「打开一个会话（本地 ↔ 远程、跨项目）时，侧栏的选中/高亮、
> 列表内容、右栏项目上下文必须立即跟到该会话所属的工作区」，以及这条同步的边界。

## 1. 问题

在侧栏里点一个**属于另一个项目**的会话（典型场景：本地项目 ↔ 远程文件夹之间来回切），
会话内容换了，但：

- 侧栏高亮的项目行仍停在旧项目；
- 侧栏列表仍按旧项目的 scope 过滤 —— 刚打开的会话根本不在列表里；
- 右栏（终端/文件树/远程工作空间）仍挂在旧项目上。

只有再点一次那个项目的文件夹行，三者才对齐。

## 2. 根因

侧栏高亮、列表 scope、右栏上下文**全部由活动项目派生**：

| 表现 | 派生自 |
|---|---|
| 项目行高亮 | `ChatHistorySidebar.activeProjectId` ← `activeWorkspaceProject.id` |
| 列表 scope | `useWorkspaceProjects.sidebarScope` ← `activeWorkspaceProjectPath` |
| 右栏项目上下文 | `terminalProjectPathKey` / dock 的 `workspaceProject` ← 同上 |

而活动项目只由**显式入口**写入：`activateWorkspaceProject` / `setActiveWorkspaceProjectId`
（点文件夹行、新建对话、删除项目后的兜底、搜索跳转、工作台 Pane 聚焦……）。
「打开一个已有会话」这条路（`handleSelectConversation` → `openController.open` →
`activateConversation`）**只换会话，不动项目** —— 于是派生出来的三者与新会话互相矛盾。

## 3. 修复

新增一条「跟随」规则：**可见会话的身份或其项目归属键变化时，把活动项目同步到该会话
所属的工作区**。

### 3.1 会话的项目归属键

会话自己的锚点就是它的项目归属键：

- 本地会话：落盘 `cwd` = 本地路径；
- 远程会话：落盘 `cwd` = 身份串 `ssh://<hostId>/<abs>`
  （见 `resolveConversationPersistedCwd`；侧栏也按它分组，`chat_history_list` 精确匹配它）。

取值顺序：**运行时 workdir → 侧栏行的落盘 cwd**。

绝不能改用 `resolveConversationDisplayWorkdir` 的结果：那是**本地根视图**，远程下恒为空，
拿它反解会把远程会话错认成「不属于任何项目」（这与上传/终端路径必须剥掉身份串的要求
正好相反，是同一份数据在两处的不同用途）。

### 3.2 共享纯函数（`@liveagent/ui/lib/workspaceProjects`）

| 函数 | 作用 |
|---|---|
| `conversationWorkspaceProjectPathKey(anchor)` | 归属键（与侧栏分组/scope 同一套归一化） |
| `resolveConversationWorkspaceProject(anchor, { workspaceProjects, archivedWorkspaceProjectPathKeys })` | 反解项目；反解不出返回 `null` |
| `conversationWorkspaceSyncSignature(conversationId, anchor)` | 幂等签名（会话身份 + 归属键） |

### 3.3 宿主接线

两端各一个 effect（桌面 `ChatPage.tsx`、WebUI `GatewayApp.tsx`）：

1. 取可见会话 id（桌面 `currentConversationId` / WebUI `displayedConversationId`）；
2. 取锚点（运行时 workdir → `sidebarStore.peek(id)?.cwd`）；
3. 算签名，与上次相同则**直接返回**；
4. 反解项目并 `activateWorkspaceProject(project, { preserveMissing: true })`。

`preserveMissing` 是必须的：自动跟随不该替用户清掉「目录缺失」标记 —— 探测与复位是
用户显式选文件夹时的职责。

## 4. 不变量与边界

- **不回退、不造项目**：反解不出（路径已不在项目列表、无根草稿）就什么都不做。远程身份串
  若交给 `createWorkspaceProjectFromPath` 会变成「路径是 `ssh://` 的本地项目」，比不切更糟。
- **不复活归档项目**：`activateWorkspaceProject` 会顺手取消归档，所以归档项目一律不激活。
- **不与显式选择互相覆盖**：只在「会话身份或其归属键」变化时同步。点文件夹行不改这两个
  值，所以「点文件夹 → 只换 scope、保持当前会话」的既有语义不变。
- **后台水合不抢活动项目**：非聚焦 Pane 的后台水合不改变可见会话，因此不触发跟随。
- **与工作台 Pane 聚焦同向**：`activateWorkbenchPaneProject`（Pane 的 ProjectRef）与跟随
  规则指向同一项目；Pane 的 ref 陈旧到解析不出项目时，跟随规则补上「可见会话自己的项目」。
- **点文件夹行仍是「显式换工作区」**：它不改会话身份，所以不触发跟随 —— 列表按新项目
  过滤、当前会话保持打开（既有语义，未改动）。此时若当前会话属于别的项目，它只是不在
  新 scope 的列表里；一旦再切一次会话，跟随规则会把活动项目拉回该会话的项目。
- **草稿**：远程「新建对话」的草稿在首次落盘前 workdir 为空（签名里的归属键为空），
  此时不触发跟随 —— 该流程本来就由 `activateWorkspaceProject({ startConversation: true })`
  激活了正确项目；首次发送会写入身份串，之后一切照常。

## 5. 测试

`crates/agent-gui/test/chat/conversation-workspace-follow.test.mjs`：

- 纯函数：本地路径 / 远程身份串各自反解到项目、同根不同主机不匹配、归档不激活、未知与
  空锚点返回 `null`（不回退）、签名对「同会话同项目」「换会话」「同会话换项目」的幂等与区分；
- 宿主接线：两端都从会话自己的锚点（运行时 workdir / 侧栏 cwd）反解、都不碰
  `displayedConversationWorkdir`、都带 `preserveMissing`、都有签名守卫、依赖数组含会话身份
  与锚点。
