# LiveAgent 首次发送消息延迟分析报告

> 分析对象：`E:\ai\LiveAgent`（分支 `Owen`，HEAD `4826cceb`）
> 分析方式：静态代码走查。**报告中所有耗时量级均为基于代码结构的推断，未做实测**；已用「代码确认 / 待实测」明确标注证据强度。
> 分析日期：2026-09-17

> **落地状态（2026-09-17 11:25 更新）**
>
> - ✅ **已实施（第 1 批）**：连接池 `pool_idle_timeout` 90s→300s（`proxy.rs` +
>   `system_proxy.rs` 两处，直连与代理是两个独立连接池）；`resolveRuntimePlatform`
>   缓存 Promise；新增三条 perf span（`turn.send_prepare` / `turn.prepare` /
>   `provider_request.prepare`）；反代 `send()` 建连计时（`[proxy] upstream` 日志）。
> - ✅ **已实施（第 2 批）**：上游连接预热 —— Rust 侧 `proxy_prewarm` 命令
>   （`services/proxy.rs`）+ 前端 `lib/providers/prewarm.ts`，在 `App.tsx` 的
>   `settingsReady` 后经 `requestIdleCallback` 触发，只预热当前选中的供应商。
> - ❌ **评估后决定不做**：`checkpoint_begin_turn` 不再阻塞。`begin_turn_at`
>   （`checkpoint.rs:537-572`）只是建目录 + 读写小索引文件，毫秒级；而其副作用
>   （写 turn 索引记录）是后续 `capture_pre_image` 的前提，fire-and-forget 会让两者
>   交错。收益远小于风险。
> - ⏸ **未实施**：MCP 预热 + 软超时（第 3 批，取决于是否配了 MCP server）；
>   `refreshSkills` 后台化与标题生成延后（第 4 批，需产品确认）。
> - ⚠️ **本报告 §3 中的「P1-3 动态 import 空闲预热」已被证伪并作废**，理由见
>   「落地补充说明」一节。
> - 改动**尚未 git 提交**，且**尚未跑过真实量测** —— 下一步应在 `tauri dev` 下
>   观察 `[Agent perf]` 与 `[proxy] upstream` 的实际数字。

---

## 0. 技术栈与运行环境（由代码推断）

| 层 | 技术 | 证据 |
| --- | --- | --- |
| 桌面壳 | Tauri 2（Rust + 系统 WebView） | `crates/agent-gui/src-tauri/tauri.conf.json`、`Cargo.toml` workspace member |
| 前端 | React 19.2 + Vite 8（rolldown）+ TypeScript 7 | `crates/agent-gui/package.json` |
| 包管理 | pnpm 10 workspace（monorepo） | `pnpm-workspace.yaml`、`package.json` |
| LLM SDK | `@earendil-works/pi-ai` 0.84 / `pi-agent-core` 0.84 | `crates/agent-gui/package.json` |
| 出网链路 | WebView `fetch` → 本地 axum 反代（127.0.0.1 随机端口 + UUID token）→ `reqwest` 0.13.4（default-tls，Windows 即 SChannel）→ 上游 provider | `crates/agent-gui/src-tauri/src/services/proxy.rs:85-130`、`Cargo.toml:30` |
| 伴生服务 | Go 网关（独立进程，服务远程 WebUI / 浏览器扩展） | `crates/agent-gateway/cmd/gateway/main.go` |
| 存储 | SQLite（历史库 / agenttoken / STT 设置，WAL + `busy_timeout(5000)`） | `crates/agent-gateway/internal/db/sqlite.go:20` |
| 编辑器 | Monaco 0.56（worker 独立分片） | `dist/assets/ts.worker-*.js` 6.6 MB |

**关键架构事实（决定问题定位方向）**：桌面 GUI 发送消息**不经过 Go 网关**，而是前端直连本地 Rust 反代再出网。Go 网关只在启用「远程 / 浏览器接入」时参与，两条链路互相独立，排查必须分开。

---

## 1. 现象与初步分析

### 1.1 典型表现

用户描述为「启动后第一次发送消息反应很慢」。从代码结构看，这个体感实际是**三段时间叠加**的结果，而非单一原因：

1. **应用启动段**（窗口已可见 → 用户开始打字）：24 MB 单 chunk 的解析与编译。
2. **点击发送 → 请求出网**（真正被感知为「卡住」）：一条 10 余步的串行 `await` 链，含 IPC、读盘、建目录。
3. **请求出网 → 首个 token**：完整的一次 DNS + TCP + TLS 建连（连接池为空），且首轮还会并发一个标题生成请求抢同一条冷链路。

### 1.2 冷启动慢的常见原因对照

| 常见原因 | 本项目是否命中 | 判定依据 |
| --- | --- | --- |
| 连接未预热 | **命中（主因之一）** | 全仓 `grep -i "warmup\|prewarm\|预热"` 在出网路径上**零命中**；唯一的 `warmup` 是子代理 run 预热（`src/lib/subagents/store.ts:318`），与网络无关 |
| DNS 解析耗时 | **命中** | `proxy.rs:326-430` `handle_proxy` 直接 `client.request(...).send()`，首个请求才触发解析；无任何解析缓存或预热 |
| TLS 握手 | **命中** | `reqwest` 默认 `default-tls`（Windows → SChannel）。首次握手需加载系统根证书存储，属一次性成本，后续走连接池复用 |
| 懒加载阻塞 | **命中（主因之一）** | `ChatRuntimeHost.ts:22` 动态 import；`mcpTools.ts:208` 首次 `mcp_list_tools` 会 spawn 子进程；`proxy.ts:59` 单例首次 IPC |
| 初始化逻辑同步执行 | **命中** | `useSendChatTurn.ts` 中 `listWorkspaceRootGrants`(387) → `resolveTrajectoryTurnNumber`(1163) → `checkpoint_begin_turn`(1271) → 动态 import(1283) → `refreshSkills`(1473) → `buildMemoryOverviewSection`(1542) 全部在 `llm.stream` **之前**依次 await |
| 主线程阻塞 | 部分命中 | `vite.config.ts` 显式 `codeSplitting: false`，产物为**单个 25,256,680 字节**的 `index-Bc869DQX.js`；V8 惰性编译会把巨型函数体（`runAgentConversationTurn` 1787 行）的编译成本记到首次调用上 |
| SQLite 首次写入 | 命中（次要） | 首次会话需建目录树（`checkpoint.rs:575-583`）、首次写入付 WAL 初始化与 fsync |
| 网关同步探活 | 仅远程链路命中 | `browser_local.go:164-172` 的 `ProbeRuntimeForCommand` 最长阻塞 2s，**不影响桌面 GUI 自身发送** |

---

## 2. 根因定位

按证据强度与预期收益排序。**R1/R2 为代码确认的高置信根因；R4 的量级待实测。**

### R1 — 首个出网请求走完整冷建连，全链路无预热【代码确认】

**调用链**：

```
agentRunner.ts:538  prepareProviderRequest(providerId, runtime, ...)
  └─ requestOptions.ts:102  prepareProxyRequest(...)
       └─ agent-ui/src/lib/providers/proxy.ts:223  getProxyServerInfo()
            └─ proxy.ts:81-90  首次 invoke("proxy_get_server_info")   ← 单例，仅首次
       └─ proxy.ts:230  buildProxyBaseUrl()  → baseUrl = http://127.0.0.1:<随机端口>/proxy/<provider>
agentRunner.ts:1449  llm.stream(...)  → pi-ai 发起 fetch
  └─ WebView fetch → 127.0.0.1:<port>            ← 第 1 段：新建本地 TCP
       └─ proxy.rs:326  handle_proxy
            └─ proxy.rs:417  client.request(method, target_url).send()
                 └─ reqwest 连接池为空 → DNS → TCP → TLS(SChannel)   ← 第 2 段：真正耗时段
                      └─ 上游 provider
```

**为什么「只有第一次」慢**：

- `proxy.rs:96-105` 的 `reqwest::Client` 在 `start_proxy_server()` 时构建（`lib.rs:905`，setup 期），但 `Client::build()` 只做配置，**连接池是空的**。首个请求必然付 DNS + TCP + TLS。
- 之后请求命中 reqwest 连接池（`pool_idle_timeout` 默认约 90s），故「第二次起正常」。
- **双段建连**放大了感知：WebView → 反代是本地 TCP（快，但仍是新连接），反代 → 上游才是主要成本。

**排除项（避免误诊）**：`proxy.rs:105` 的 `reqwest::Client::builder().no_proxy().build()` 与 `system_proxy.rs:250-278` 的 `cached_client()` 都**不是**首次慢的原因 —— 前者在启动时即构建完成，后者仅在「系统代理已启用」时才走（`proxy.rs:407-419` 按 `x-liveagent-use-system-proxy` 头分支）。若用户未启用应用代理，`cached_client()` 根本不被调用。

### R2 — 首次发送时 `llm.stream` 之前存在长串行 await 链【代码确认】

全部位于出网之前，逐项串行（`useSendChatTurn.ts` → `runAgentConversationTurn.ts`）：

| # | 位置 | 操作 | 首次成本 |
| --- | --- | --- | --- |
| 1 | `useSendChatTurn.ts:387` | `await listWorkspaceRootGrants()` | IPC + 读授权表 |
| 2 | `useSendChatTurn.ts:1058 / 1163` | `await resolveTrajectoryTurnNumber()` | IPC + 历史分段查询 |
| 3 | `useSendChatTurn.ts:1271` | `await invoke("checkpoint_begin_turn")` | IPC → `checkpoint.rs:576` `spawn_blocking` 建目录树 |
| 4 | `useSendChatTurn.ts:1283` | `await Promise.all([import(memoryInjection), import(prompts/injection)])` | 模块求值（**注**：因 `codeSplitting: false` 已内联，不产生额外 chunk 下载，但仍触发模块初始化） |
| 5 | `useSendChatTurn.ts:1473` | `await refreshSkills()`（条件：选中 skill 未就绪） | **全量重扫**，含 `system_ensure_builtin_skills` + `system_manage_skill list` |
| 6 | `useSendChatTurn.ts:1542` | `await buildMemoryOverviewSection(effectiveWorkdir)` | 读盘构建记忆概览 |
| 7 | `runAgentConversationTurn.ts:515` | `await subagentStore.ready()` | 首次两次 IPC（`listIdentities` / `listRuns`），见 `store.ts:150,200-208` |
| 8 | `runAgentConversationTurn.ts:621` | `await resolveRuntimePlatform()` | **无缓存，每次发送都付**（`runtimePlatform.ts:30-37`） |
| 9 | `runAgentConversationTurn.ts:624` | `await buildBuiltinToolRegistry(...)` | 见 R3 |
| 10 | `runAgentConversationTurn.ts:707` | `await compaction.maybeCompactPreSend(...)` | 首轮无历史，通常快速返回 |

第 8 项是**纯浪费**：`resolveRuntimePlatform()` 已有同步兜底 `inferRuntimePlatform()`（`runtimePlatform.ts:14-22`），却仍每次 await 一次 IPC。

### R3 — 首次 `mcp_list_tools` 触发子进程冷启动（条件性，命中时是最重的一段）【代码确认】

```
runAgentConversationTurn.ts:624  buildBuiltinToolRegistry
  └─ builtinRegistry.ts:310  createMcpTools
       └─ mcpTools.ts:208  await invoke<McpToolInfo[]>("mcp_list_tools", { servers })
            └─ integration/mcp.rs:1866  mcp_list_tools
                 └─ mcp.rs:1678  McpRuntimeManager::ensure_client(cfg)
                      └─ mcp.rs:1286  McpClient::spawn(cfg)   ← Command::new("npx"/"uvx") + initialize 握手
                 └─ 逐个 server 串行 tools_list()
```

- `mcp.rs:239` `clients: Mutex<HashMap<String, Arc<Mutex<McpClient>>>>` 会缓存 client，**故仅首次付 spawn 成本**，这精确对应「第一次慢」。
- 若用户配置了 stdio transport 的 MCP server（如 `npx` 拉起的包），首次 spawn 含 `npx` 自身的包解析/下载，量级可达**数秒**。
- 若用户未配置任何 MCP server：`mcpTools.ts:187-203` 提前返回空 bundle，**不构成延迟**。这条是条件性根因，需先确认用户配置。
- 注意 `mcp.rs:1866` 内部是 `run_blocking`，不会阻塞 Tauri 主线程，但会阻塞该次 IPC 的返回。

### R4 — 单 chunk 24 MB，动态 import 的收益被 `codeSplitting: false` 抵消【代码确认，量级待实测】

`crates/agent-gui/vite.config.ts`：

```ts
rolldownOptions: {
  output: {
    codeSplitting: false,   // 注释：曾因 style-to-js → style-to-object → inline-style-parser
  },                        // 的 CJS interop 链跨 chunk 导致 __commonJSMin 初始化失败、黑屏
}
```

**后果**：`dist/assets/` 下只有 `index-Bc869DQX.js`（25,256,680 B）+ Monaco workers，**无任何业务逻辑分片**。因此：

- `ChatRuntimeHost.ts:22` 的 `await import("../turns/runAgentConversationTurn")` **不节省任何解析成本** —— 模块早已随主 chunk 加载。
- V8 的惰性编译（lazy compilation）会把该文件内巨型函数的完整编译推迟到首次调用，于是 `runAgentConversationTurn`（1787 行）的首次执行成本被计入「点击发送之后」。
- 这段成本同时抬高**启动时间**（解析 24 MB）与**首次发送时间**（编译巨型函数），是用户把两个现象混为一谈的结构性原因。

> 待实测：需用 Performance 面板确认「主 chunk 解析」与「首次调用编译」各自的实际毫秒数。仅凭代码无法判断其是否达到「明显卡顿」量级。

### R5 — 首轮并发标题生成请求抢同一条冷链路【代码确认】

`useSendChatTurn.ts:694, 715-738`：

```ts
const isFirstTurn = baseConversationState.meta.totalMessageCount === 0;
...
if (isFirstTurn || isBranchDefaultTitle) {
  titlePromise = startConversationTitleJob({ ... });   // 不 await，与主请求同时刻发出
}
```

首轮时，标题生成（一次完整的 LLM 调用，走同一条反代）与主对话请求**并发发出**。两者都在冷连接状态下，各自需要一次 DNS/TCP/TLS，且共享上行带宽与 provider 速率配额。这不会让首次变慢一倍，但会实打实地恶化首 token 延迟。

### R6 — 网关链路（仅远程 / 浏览器接入时）2s 同步探活【代码确认，不影响桌面 GUI】

```
browser_local.go:117  handleChatCommand
  └─ browser_local.go:164-172  ProbeRuntimeForCommand   ← 同步阻塞在 handler 内，先于 accepted 回执
       └─ chatcmd.go:136-172  ProbeRuntime
            └─ requestID 前缀 "chat-runtime-wake-"  → 要求桌面端唤醒 Chat WebView
       └─ 超时 = config.go:60 ChatPrepareTimeout = 2s
```

- 客户端 `CHAT_COMMAND_ACK_TIMEOUT_MS = 4000`（`web/src/lib/gatewaySocketShared.ts:625`），**2s 探活吃掉一半预算**。
- 探活复用窗口仅 `chatcmd.go:33 runtimeProbeReuseWindow = 2s`，这正是「后续正常」的成因。
- 若桌面端 WebView 冷启动未驻留，该次探活吃满 2s 甚至超时失败。

**本节结论**：桌面 GUI 自身发送**不经过**此路径（GUI 直连 provider）。只有在使用远程 WebUI / 浏览器扩展时，R6 才是首条消息的主因。

---

## 3. 修复 / 优化方案

按「收益 / 风险比」排序。**建议按 P0 → P2 分批落地并逐项验证，不要一次性全上。**

### P0-1：启动后空闲预热上游连接

**目标**：把 R1 的 DNS + TCP + TLS 成本从「点击发送后」移到「用户打字期间」。

**实现位置**：`crates/agent-gui/src-tauri/src/services/proxy.rs`

```rust
/// 预热：用与真实请求同一条路径（同一 reqwest client）打一次轻量请求，
/// 目的是把 DNS 结果与 TCP/TLS 连接放进连接池，而非获取响应内容。
/// 必须静默失败——预热绝不参与任何错误上报。
pub fn spawn_prewarm(state: Arc<ProxyServerState>, origin: String) {
    tauri::async_runtime::spawn(async move {
        let url = match reqwest::Url::parse(&origin) {
            Ok(u) => u,
            Err(_) => return,
        };
        // 只做建连，不要 body：HEAD 到 origin 根路径即可。
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            state.client.head(url).send(),
        )
        .await;
    });
}
```

**触发点**：`lib.rs` setup 之后，**监听前端 ready 信号**再触发（项目已有 `FrontendReadyState`，见 `lib.rs:854`），避免与窗口首帧争资源：

```rust
// setup 内，proxy 已 manage 之后
// 注意：不要在这里同步 await；也不要放在 start_proxy_server 之前
```

**同时必须做的配套调整**（否则预热形同虚设）：

```rust
// proxy.rs:96-105 的 client 构建处
client: reqwest::Client::builder()
    .no_proxy()
    .pool_idle_timeout(std::time::Duration::from_secs(300))  // 默认约 90s，太短
    .pool_max_idle_per_host(4)
    .build()
```

**注意**：预热目标 origin 需要前端告知（provider baseUrl 存于前端 settings）。可选做法是前端在 settings 加载完成后调一次 `proxy_prewarm` 命令，而不是 Rust 侧硬编码 —— 这样能正确处理多 provider 与自定义 baseUrl。

### P0-2：串行 await 链并行化 + 去掉冗余 IPC

**a) 消除 `resolveRuntimePlatform()` 的每次 IPC**（`runAgentConversationTurn.ts:621`）

改为与 `proxy.ts:59` 同款的模块级单例缓存，或用已有的同步兜底：

```ts
// runtimePlatform.ts
let cached: RuntimePlatform | null = null;
export async function resolveRuntimePlatform(): Promise<RuntimePlatform> {
  if (cached) return cached;
  try {
    const r = await invoke<RuntimePlatformResponse>("app_runtime_platform");
    cached = normalizeRuntimePlatform(r?.platform) ?? inferRuntimePlatform();
  } catch {
    cached = inferRuntimePlatform();
  }
  return cached;
}
```

> 平台在进程生命周期内不可能变化，缓存无正确性风险。更激进的做法是直接用 `inferRuntimePlatform()` 同步取值，彻底去掉 IPC。

**b) 把互不依赖的 IPC / 读盘操作并行**

`useSendChatTurn.ts` 中第 1/2/3/6 项彼此无数据依赖，可合并为一次 `Promise.all`。收益是「取最大值」而非「求和」，在 IPC 密集场景下通常省 30%–60% 的准备耗时。

**c) `buildMemoryOverviewSection`（`:1542`）后置**

它只影响 system prompt 的记忆注入，不参与请求装配。可移到请求发出之后、首个 token 之前完成；或按现有「首轮进 system prompt、后续进 user 尾部」的机制（见 `:1535-1539` 注释），干脆延到第二轮。

**d) `refreshSkills()`（`:1473`）改后台**

当前是「发现缺失 → 阻塞式全量重扫 → 再决定成败」。可改为：本轮先用已有列表，缺失的 skill 记入警告并后台重扫，下一轮生效。这会改变「找不到 Skill 直接拒绝发送」的语义（`:1485-1496`），**需产品确认是否接受**。

### P1-1：MCP 工具列表预热 + 软超时收口

**a) 启动预热**：窗口 ready 后异步调一次 `mcp_list_tools`，把 `ensure_client` 的 spawn + initialize 握手挪出关键路径。

**b) 软超时**：`mcpTools.ts:208` 的 invoke 包一层短超时，超时则本轮不带 MCP 工具继续：

```ts
const MCP_LIST_SOFT_TIMEOUT_MS = 1500;
toolInfos = await Promise.race([
  invoke<McpToolInfo[]>("mcp_list_tools", { servers: enabledServers }),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("MCP tools/list 超时，本轮跳过 MCP 工具")), MCP_LIST_SOFT_TIMEOUT_MS),
  ),
]);
```

现有 `loadFailureMode: "continue"` + `onLoadError` 语义（`mcpTools.ts:211-218`、`runAgentConversationTurn.ts:658-662`）可直接复用，降级路径已存在。

> **务必只对「用户已启用且上一轮真实使用过」的 server 预热** —— 启动即拉起 `npx` 类子进程会产生用户未预期的网络访问与常驻资源占用。见注意事项 §5.6。

### P1-2：首轮标题生成延后

`useSendChatTurn.ts:715-738`：把 `startConversationTitleJob` 从「发送同时」改为「首个 token 到达后」或「主请求结束后」触发。

- 依赖检查：标题仅依赖 `titleSourceText`（用户首条消息文本），延后不影响正确性。
- 需保留会话列表的 pending 标题占位（`sidebarStore.upsertLocal` 在 `:740-752` 已独立处理，不依赖 titlePromise 的时机）。
- 收益：首次发送少一次完整 TLS 握手 + 少一次并发上行。

### P1-3：让动态 import 真正预热编译

在窗口显示后、用户输入期间，用 `requestIdleCallback` 主动 import 一次：

```ts
// 窗口 ready 后
requestIdleCallback?.(() => {
  void import("../turns/runAgentConversationTurn");
  void import("../turns/runTextConversationTurn");
});
```

由于 `codeSplitting: false`，这不产生 chunk 下载，但会**触发模块求值与巨型函数的首次编译**，把 R4 的成本从「点击发送后」挪到「用户打字时」。

**根治方向**（非本次修复范围）：恢复 code splitting 需先定位注释里那条 CJS interop 链（`style-to-js → style-to-object → inline-style-parser`）在 rolldown 下的 `__commonJSMin` 跨 chunk 初始化问题。这是独立课题，不要为了体积直接打开开关 —— 会复现黑屏。

### P2：网关探活异步化（仅远程链路）

`browser_local.go:164-172`：

- 把 `ProbeRuntimeForCommand` 移出 handler 同步路径，改为「先回 accepted → 探活失败再走降级」。
- 或把 `chatcmd.go:33 runtimeProbeReuseWindow`（2s）提高到与会话生命周期一致，避免每条消息都付一次往返。

---

## 4. 验证方法

### 4.1 项目已有的埋点（可直接用）

**埋点 1：`[Agent perf]` 控制台日志**

`runAgentConversationTurn.ts:199-220` `finishAgentPerfSpan`，阈值 `AGENT_PERF_LOG_THRESHOLD_MS = 250`（`:140`）。超过 250ms 的 span 会 `console.warn`：

```
[Agent perf] builtin_registry.build took 1832ms { toolCount: 24, enabledMcpServerCount: 2 }
```

现有 span 名：`subagent_store.ready`（`:524`）、`builtin_registry.build`（`:675`）、`conversation.pre_compaction`（`:716`）。

**用法**：`tauri dev` 打开 DevTools → Console 过滤 `[Agent perf]` → **冷启动后立即发送一次**，记录各 span 耗时。

**埋点 2：debug JSONL**

`commands/app/system.rs:141-145, 1557-1570`，落盘于 `<app_storage_dir>/debug/<conversationId>.jsonl`。当 `conversationDebugLogger.enabled` 为真时，每条 `perf_span` 写入 `{ type: "perf_span", span, durationMs, ... }`。

**用法**：同一会话发送两次，`diff` 两条 JSONL 中 `perf_span` 的 `durationMs`，直接量化「首次 vs 后续」的差值。

> **注意**：`system_append_debug_jsonl_sync` 每次 `OpenOptions + write + flush`，属同步 IO。生产环境务必保持 debug logger 关闭。

### 4.2 需要补充的埋点（当前缺失的关键观测点）

现有 span **覆盖不到** R1（出网建连）与 R4（编译），需补两处：

**a) Rust 侧反代转发计时**（定位 R1）

`proxy.rs:326` `handle_proxy` 内，在 `request.send().await` 前后加计时，分别记录「到响应头到达」与「body 流结束」：

```rust
let started = std::time::Instant::now();
let upstream_response = match request.send().await { ... };
let ttfb = started.elapsed();
// 首请求 vs 后续请求的 ttfb 差值 ≈ DNS + TCP + TLS 成本
```

**b) 前端准备阶段总耗时 + TTFT**（定位 R2/R4）

- 在 `agentRunner.ts:538` `prepareProviderRequest` 之前打点，在 `:1449` `llm.stream` 之前收口 → `"provider_request.prepare"`。
- TTFT 可复用已有的 `trajectory.firstToken`（`runAgentConversationTurn.ts:1147, 1179` 等），无需新埋点。

### 4.3 对照实验（区分根因，成本最低）

| 实验 | 操作 | 判读 |
| --- | --- | --- |
| A. 冷启动时间窗 | 启动后**立即**发送 vs 启动后**等 2 分钟**发送 | 两者接近 → 瓶颈不在连接冷启动（R1 权重低）；差异显著 → 坐实 R1 |
| B. MCP 开关 | 禁用全部 MCP server 后冷启动发送 | 耗时大幅下降 → R3 是主因 |
| C. 代理旁路 | 临时把 provider baseUrl 指向一个本地 echo 服务，测纯准备耗时 | 隔离出 R2/R4 的净成本 |
| D. 第二会话 | 同一进程内新建会话再发第一条 | 与首次发送接近 → 瓶颈是「进程级冷启动」（R1/R4）；明显更快 → 瓶颈是「会话级首次」（R2/R5） |

### 4.4 网络层取证（可选，用于精确拆分 R1）

Wireshark 过滤 `tcp.port == <反代端口> || tls`，观察首个请求的握手时序；或临时在反代内分段计时（DNS / TCP connect / TLS handshake），确认三段各占多少。

### 4.5 回归口径

修复后应满足：**首次发送 P95 与第二次发送的差值 < 200ms**，且 `[Agent perf]` 中不再出现 > 250ms 的 span。

---

## 5. 注意事项与潜在风险

1. **预热必须放在窗口 ready 之后**。放进 `setup` 同步路径会直接拖慢窗口首帧显示（`lib.rs:889-957` 已是串行初始化，含 `initialize_history_db`、`configure_system_tray`、`ensure_builtin_agent_skills_sync`、`sync_bundled_browser_extension`）。预热请求须设短超时（建议 ≤3s）且**静默失败**，绝不参与错误上报或阻断启动。

2. **预热是概率性收益，不是确定性收益**。reqwest 连接池默认 `pool_idle_timeout` 约 90s，且服务端可能主动关闭 keep-alive。用户若启动后长时间不发消息，连接可能已失效，首个请求仍需重连（此时是「复用失败」而非「未预热」）。须显式调大 `pool_idle_timeout` 并接受这一局限，不要把它当成 100% 修复。

3. **预热与真实请求的并发去重**。若预热尚未完成时用户就点击发送，两个请求可能各自建连（连接池去重只在请求已进入同一池的队列时生效）。要么让真实请求等待预热完成（增加最坏情况延迟），要么接受偶发重复建连 —— 二选一，需明确取舍。

4. **并行化 await 链会改变失败语义**。当前串行链中任一步失败都按顺序短路。改成 `Promise.all` 后，必须逐项明确「哪步失败应阻断发送、哪步应降级继续」。现有代码已区分这两类（如 MCP 的 `loadFailureMode: "continue"` 与 skills 缺失的硬失败 `:1485-1496`），**不能一刀切**。特别注意 `listWorkspaceRootGrants` 是 fail-closed 语义（`:395-399`），并行化不得让它变成 fail-open —— 那会静默放宽结构化文件工具的能力边界。

5. **`refreshSkills()` 后台化会改变用户可见行为**。当前「找不到 Skill → 直接拒绝发送并报错」。改为后台重扫后，首次发送可能带着缺失的 skill 继续。这是**语义变更**，需产品确认，不能当作纯性能优化。

6. **MCP 预热会拉起用户未主动使用的子进程**。`npx`/`uvx` 可能触发网络下载与常驻内存占用。建议只预热「已启用 且 上一轮真实调用过」的 server，并在设置页给出明确提示。

7. **`codeSplitting: false` 是有原因的规避，不要为体积直接打开**。`vite.config.ts` 注释已记录：曾因 `style-to-js → style-to-object → inline-style-parser` 的 CJS interop 链跨 chunk 导致 `__commonJSMin` 初始化失败、渲染期黑屏（release 崩、`tauri dev` 正常）。重开分片前必须先定位并修复那条链。

8. **埋点自身有 IO 开销**。`system_append_debug_jsonl_sync` 每条都 `OpenOptions + flush`。大量 span 会引入可观测的额外 IO，可能反过来污染测量结果。测量时保持 debug logger 开启，测量后关闭。

9. **R6 的修复范围要收窄**。`ProbeRuntimeForCommand` 的同步阻塞是**有意设计**（保证探活结果先于 accepted 回执，避免客户端拿到虚假成功）。异步化会削弱这一保证，需要重新论证「accepted 先于探活」是否会导致浏览器端状态不一致。

---

## 附：优先落地清单

| 优先级 | 动作 | 触及文件 | 预期收益 |
| --- | --- | --- | --- |
| P0 | 上游连接预热 + 调大 `pool_idle_timeout` | `services/proxy.rs`、`lib.rs` | 消除 DNS/TCP/TLS 冷启动成本（R1） |
| P0 | `resolveRuntimePlatform` 加缓存 | `lib/runtimePlatform.ts` | 去掉每次发送的冗余 IPC（R2-8） |
| P0 | 准备阶段 IPC / 读盘并行化 | `useSendChatTurn.ts:387/1058/1271/1542` | 准备耗时从「求和」变「取最大」（R2） |
| P1 | MCP 预热 + 软超时 | `integration/mcp.rs`、`lib/tools/mcpTools.ts` | 命中 MCP 时消除数秒级阻塞（R3） |
| P1 | 首轮标题生成延后 | `useSendChatTurn.ts:715-738` | 首次少一次冷建连（R5） |
| P1 | 动态 import 空闲预热编译 | `pages/chat/runtime/ChatRuntimeHost.ts` 调用侧 | 摊薄 24MB 单 chunk 的首次编译（R4） |
| P2 | 网关探活异步化 | `gateway/internal/protocol/pbws/browser_local.go` | 仅远程链路（R6） |
| P2 | 恢复 code splitting | `crates/agent-gui/vite.config.ts` | 根治启动解析成本（R4），需先解决 CJS interop |

---

## 落地补充说明（2026-09-17）

### 一、§3「P1-3 动态 import 空闲预热」已证伪

原文建议「窗口 ready 后用 `requestIdleCallback` 主动 import 一次大模块，触发其编译」。
**这条是错的**，两个原因：

1. `codeSplitting: false` 下所有模块的顶层代码在 `index.js` 执行时就已求值完毕，
   `await import()` 返回的是已求值的模块命名空间，是 no-op；
2. 即使有独立 chunk 也没用 —— V8 的**惰性编译（lazy compilation）只在函数被调用时**
   才编译函数体，`import` 不触发。想预热 `runAgentConversationTurn`（1787 行）的编译
   只能真的调用它，而那会真的发消息。

**因此 R4 的修复路径收窄为**：先实测 → 查 25MB 构成 → 需先解决 code splitting。
属独立课题，不应进首批优化。

### 二、R4 的成因已定位：monaco 全量注册

`crates/agent-ui/src/lib/monacoEditor.ts`（仅 43 行）做了三件重活：

- `import "monaco-editor/features/register.all"` —— 注册**全部**编辑器功能
- **32 个语言定义**逐一 `register`（cpp / csharp / css / dockerfile / go / graphql /
  hcl / html / ini / java / javascript / kotlin / less / lua / markdown / mdx / php /
  powershell / protobuf / python / ruby / rust / scss / shell / solidity / sql /
  swift / typescript / xml / yaml）
- 4 个语言特性（css / html / json / typescript）

`WorkspaceCodeEditorOverlay.tsx:48` 静态引入它。
**注意**：`WorkspaceOverlayHost.tsx:6` 与 `useWorkspaceOverlays.ts:3` 都是
`import type`，**不产生运行时依赖**，排查时别被它们误导。

**关键约束**：只要 `codeSplitting: false` 还在，把 overlay 改成 `React.lazy` 也**无效**
—— 动态 import 会被内联回 `index.js`。「把 monaco 移出启动路径」必须依赖先解决
code splitting。

### 三、连接池默认值（已查 `reqwest-0.13.4` 源码确认）

`reqwest-0.13.4/src/async_impl/client.rs:301-302`：

- `pool_idle_timeout` = `Some(Duration::from_secs(90))` —— **90s 太短**
- `pool_max_idle_per_host` = `usize::MAX` —— **容量不是瓶颈，只有超时是**

调 idle 超时时必须**同时改两处**：`services/proxy.rs` 的直连 client 与
`services/system_proxy.rs` 的代理 client —— 两者是彼此独立的连接池，只改前者的话
启用应用代理的用户享受不到。

### 四、量测方法（改动后可用）

新增的观测点：

| 通道 | 输出 | 位置 |
| --- | --- | --- |
| `[Agent perf]` | `turn.send_prepare` / `turn.prepare` / `provider_request.prepare` / `subagent_store.ready` / `builtin_registry.build` / `conversation.pre_compaction` | DevTools Console，阈值 250ms |
| `[proxy] upstream` | `{ms}ms first_contact={bool} {method} {origin}` | Rust stderr（`tauri dev` 控制台），首次建连或 >300ms 时打 |
| debug JSONL | 上述所有 `perf_span` | `<app_storage_dir>/debug/<conversationId>.jsonl` |

**关键读法**：`[proxy] upstream` 的 `first_contact=true` 那条与紧随其后的
`first_contact=false` 那条，**耗时之差就是 DNS + TCP + TLS 的净成本** ——
这是验证「连接预热」是否生效、以及预热该定多少 `pool_idle_timeout` 的直接依据。

### 五、准备链并行化的正确姿势

比 `Promise.all` 更安全的是「**提前启动 Promise + 使用点 await**」：

- `useSendChatTurn.ts:1271 checkpoint_begin_turn` —— **已是 fail-soft**（try/catch 仅
  warn），但**不要**改成 fire-and-forget：它的副作用（写 turn 索引记录）是后续
  `capture_pre_image` 的前提，见上文「落地状态」。
- `:1542 buildMemoryOverviewSection` —— 读盘，结果供 `memoryTurnInjection.planTurn`
- `:387 listWorkspaceRootGrants` —— **fail-closed**，可提前启动但必须在原使用点 await，
  绝不能让它变 fail-open（会静默放宽文件工具的能力边界）
- `:1283` 两个动态 import 已是 `Promise.all`，且因 `codeSplitting: false` 实为 no-op

### 六、上游连接预热（第 2 批）实现要点

| 环节 | 位置 |
| --- | --- |
| 命令实现 | `services/proxy.rs` — `proxy_prewarm` + `PrewarmTarget` + `parse_prewarm_origin` |
| 命令注册 | `src-tauri/src/lib.rs` |
| 目标收集与调用 | `lib/providers/prewarm.ts` — `collectPrewarmTargets` / `prewarmProviderConnections` |
| 触发时机 | `App.tsx` — `settingsReady` 后的 `requestIdleCallback`（timeout 3000ms） |

**三个必须守住的约束**：

1. **必须用与真实请求同一个 client 实例**（`state.client` 或
   `system_proxy::cached_client()`）。否则建好的连接不在真实请求用的那个连接池里，
   预热等于白做。这也是命令留在 `proxy.rs` 而不是让前端自己发请求的原因。
2. **只预热当前选中的供应商**。预热会向目标发一次**真实请求**（HEAD），对用户并未
   使用的供应商发这种请求既浪费带宽，也可能在对方侧留下无谓的访问记录。
3. **失败必须静默、不重试**。预热跑在 App 的空闲回调里，出问题不该有任何用户可见
   后果。

**只接受纯 http(s) origin**：`Url::parse` 会接受 `ftp://` 且其 `has_host()` 为真、
`path()` 为 `/`，所以必须显式收口 scheme。前端也做了同样的过滤，但 Rust 侧是安全
边界，两边都要有。

**这是概率性收益，不是确定性修复**：服务端可能主动关闭 keep-alive 连接，或用户
启动后隔很久才发消息、池中连接已过 `pool_idle_timeout`。验证它是否生效，看
`[proxy] upstream` 日志里 `first_contact=false` 那条的耗时是否已降到与热请求同量级。

---

## 七、根因修正（2026-09-17，实测后）

**§2 的根因排序是错的。** 用户实测反馈「发送消息二十秒后才有响应」，与 §1–§2 推断的
「几百 ms 到几秒」量级差了一个数量级。回到本机取证后，真实主因是 §2 里被标成
「条件性」的 **R3（MCP 子进程冷启动）**，且量级远超当时的估计。

### 7.1 实测数据（本机 `~/.liveagent/config.sqlite` 的真实配置）

当前启用 **10 个 MCP server**（`mcp_settings` 中 `enabled=true`）。按
`mcp_list_tools` 的语义（串行遍历 + `ensure_client` 冷启动）逐项计时：

| server | 冷启动总耗时 | 其中 `initialize` | 命令 |
| --- | --- | --- | --- |
| `context7` | 4.9–6.0s | 4.9–6.0s | `npx -y @upstash/context7-mcp@latest` |
| `exa` | 4.7–5.1s | 4.7–5.1s | `npx -y exa-mcp-server@latest` |
| `mcp-deepwiki` | 5.5–6.6s | 5.5–6.6s | `npx -y mcp-deepwiki@latest` |
| `sequential-thinking` | 4.7–5.3s | 4.7–5.3s | `npx -y @modelcontextprotocol/server-sequential-thinking@…` |
| `uni-app-x` | 4.9–7.7s | 4.9–7.7s | `npx @dcloudio/uni-app-x-mcp` |
| `codebase-memory-mcp` | 0.3s | 0.27s | 本地 exe |
| `cua-driver` | 0.8s | 0.66s | 本地 exe |
| `playwright-iso` | 0.9s | 0.81s | `node …/index.js` |
| `github-mcp-server` / `gitee mcp` | ≈1.8s（合计） | — | http transport |

**串行合计 26.8s（仅 stdio）+ ≈1.8s（http）≈ 28.6s。**

其中 **5 个 npx 型 server 占 24.8s**，且耗时几乎全在 `initialize` —— 等的是
`npx` 回查 registry 并把 Node 拉起来，不在协议握手上。

### 7.2 为什么只有「第一次」慢

`McpRuntimeManager::ensure_client` 按 server id 缓存已拉起的 client（配置与代理
revision 未变即复用）。因此**只有首个 turn 付全部冷启动成本**，后续 turn 只是一次
`tools/list` 往返（数 ms）。这与「程序启动后第一次发送消息特别慢」的现象完全吻合。

### 7.3 为什么 §2 的 R1（冷建连）不是主因

实测到当前选中供应商 `https://tokenrhythm.studio/v1` 的直连：
`connect=20ms`、`tls=391ms`、`total=470ms`（冷启）。DNS 由本地解析器
（`192.168.200.20`）毫秒级返回。**R1 的绝对量级是几百 ms，不是 20s。**

同理，`api.githubcopilot.com`（1.2s）、`api.gitee.com`（0.76s）、npm registry
（0.8–1.5s）全部可达且快。**「Windows TCP SYN 重传约 21s」这个猜测在本机不成立** ——
没有连接是建不上的。

### 7.4 修复

| 改动 | 位置 | 效果 |
| --- | --- | --- |
| `mcp_list_tools` 串行遍历 → 并发 | `commands/integration/mcp.rs` — `list_tools_concurrently` | 实测 33s → 9.0s（3.6x） |
| 新增 `mcp_prewarm` + 前端空闲触发 | `commands/integration/mcp.rs`、`lib/tools/mcpPrewarm.ts`、`App.tsx` | 首条消息命中热 client，≈0 |

两者共用 `ensure_client` 缓存，因此预热过的 server 在首条消息里是零成本的。

**顺序必须还原成配置顺序**：并发完成次序不稳定，而工具清单顺序会进入请求的 schema
排列，让它漂移会无谓地打掉 prompt cache 命中。

### 7.5 遗留风险：一个不响应的 server 要付 5 × `timeoutMs`

`ensure_initialized`（`mcp.rs:1340` 附近）按 5 个协议版本串行重试。内层
`Err(Message) => break` **只跳出内层 `loop`**，外层 `for v in candidates` 继续 ——
所以一个超时的 server 会把同一份超时付 5 遍。默认 `timeoutMs=60000` 时是 **5 分钟**。

测试里直接观测到了：4 个不响应的 server 共建立 **20 条连接（= 4 × 5 版本）**。

**未修**，因为它牵动错误分类且有真实取舍：`HttpTransport::request` 把 `.send()` 的
超时压平成 `Message`，与 JSON-RPC 错误无法区分；而"重试下一个版本"目前**意外地**
承担了「慢启动 stdio server 再试一次」的作用，直接改成 transport 失败即终止会让这
类 server 失去重试机会。

若要修，正确姿势是给整个 `ensure_initialized` 一个**共享 deadline**（总预算 =
`timeoutMs`，而非 5 ×），既保留预算内的重试，又让死掉的 server 只花 `timeoutMs`。

### 7.6 那 5s 不是固有成本 —— npx 自身的开销占了 ~85%

7.1 里我把 npx 型 server 的 ~5s 记成了「固有成本」。**这是错的**，拆开量之后：

| 调用方式 | `initialize` |
| --- | --- |
| `cmd /S /C npx -y @upstash/context7-mcp@latest`（现状） | 5234 / 5516ms |
| `npx --prefer-offline -y …@latest` | 8159ms |
| `npx --offline -y …@latest` | 4846ms |
| npx 缓存里的 `node_modules/.bin/context7-mcp.cmd` | 1633ms |
| **`node <cached>/node_modules/@upstash/context7-mcp/dist/index.js`** | **737 / 751ms** |

同一个包、同一台机器：**直连 node 比走 npx 快 7 倍**。那 ~4.5s 是 npx 自己的
registry 回查 + 多层进程启动（`cmd.exe` → `node`(npx) → `node`(server)）+
每次都要碰 npm cache，与 server 的启动速度无关。

`--prefer-offline` / `--offline` 都救不了 —— npx 的 bootstrap 本身是大头，
不是网络等待。

**仍然成立的部分**：改**版本号**没用。实测固定版本（npx 缓存未命中）反而要 96s，
因为要全量下载 tarball；不带版本也是 5.5s。

**可用杠杆**（按性价比排序）：

1. **关掉当前对话用不到的 npx 型 server** —— 零成本，每关一个省约 5s（并发化后是
   省「最慢者」的候选，收益看它是否就是最慢的那个）。
2. **把 `npx -y <pkg>@latest` 换成直连 node** —— `npm i -g <pkg>` 后用
   `command: node` + `args: ["<全局路径>/node_modules/<pkg>/<entry>"]`，冷启动从
   ~5s 降到 ~0.75s，且路径稳定。代价是每个包要手动维护一次。
3. 依赖 7.4 的并发化 + 空闲预热（已实现）—— 预热跑完的话首条消息本来就不付这笔钱，
   所以杠杆 2 只在「启动后立刻发消息、预热还没跑完」时才有额外收益。

### 7.7 可直接用的直连配置（本机已解析）

当前 npx 缓存里这 5 个包的入口（`command` 设为 `node`，`args` 填路径）：

| server | 版本 | 入口路径 |
| --- | --- | --- |
| `context7` | 4.1.1 | `C:/Users/zjt/AppData/Local/npm-cache/_npx/c35ab75beed40a3c/node_modules/@upstash/context7-mcp/dist/index.js` |
| `exa` | 3.4.1 | `…/_npx/96788de746d735d3/node_modules/exa-mcp-server/dist/stdio.cjs` |
| `mcp-deepwiki` | 0.0.10 | `…/_npx/148cf8bd15154caa/node_modules/mcp-deepwiki/bin/cli.mjs` |
| `sequential-thinking` | 2026.7.4 | `…/_npx/9e6ab3a7b4bb5d37/node_modules/@modelcontextprotocol/server-sequential-thinking/dist/index.js` |
| `uni-app-x` | 0.0.5 | `…/_npx/53f4888e558832a3/node_modules/@dcloudio/uni-app-x-mcp/index` |

**这些路径会失效**：`npm cache clean` 会清掉 `_npx`；包发新版后 npx 缓存目录的哈希
也会变（哈希由 spec 字符串决定，`@latest` 解析到新版本会换目录）。所以长期方案是先
`npm i -g <pkg>`，再把 `args` 指向全局安装目录下的同名入口 —— 路径才稳定。

**注意**：`npm i -g` 装到哪个 node 取决于 PATH 上先命中哪个 npm。本机 bash 里
`npm root -g` 指向 managed node（`~/.workbuddy-ai/binaries/node/…`），而 LiveAgent
进程用的是它自己的 PATH。装之前先确认应用侧用的是哪一个，否则 `args` 里的路径对不上。

### 7.8 验证方法

改动后新增了两处日志（`eprintln!`，走 Rust 侧 stderr）：

- `[MCP] 拉起 \`<id>\` 耗时 <n>ms（并发列举，总耗时取最慢者）` —— 单个 server 超过
  1s 才打。npx 型会命中，本地 exe 型不会。**首条消息慢时先看这几行。**
- `[MCP] 空闲预热完成：<n>/<m> 个 server 就绪，耗时 <n>ms` —— 确认预热是否跑了、
  跑完了几个。

判定修复生效：启动后等到预热日志出现，再发第一条消息，`buildBuiltinToolRegistry`
那段应当不再出现慢项日志。

### 7.9 端到端校验（真实 10 个 server 配置，跑改后的代码）

用临时 `#[ignore]` 测试直接把本机 `mcp_enabled.json` 反序列化成
`Vec<McpServerConfig>`，喂给改后的 `list_tools_concurrently`（跑完已删除）：

```
并发列举完成：10 个就绪，0 个失败，总耗时 15.4925032s，工具数 188
```

逐项耗时（并发下）：

| server | 本次实测 | 离机探针 | 倍数 |
| --- | --- | --- | --- |
| `mcp-deepwiki` | 15489ms | 5503ms | 2.8x |
| `context7` | 14389ms | 6029ms | 2.4x |
| `sequential-thinking` | 12976ms | 4674ms | 2.8x |
| `uni-app-x` | 12221ms | 4889ms | 2.5x |
| `github-mcp-server` | 12007ms | 1220ms（curl） | 9.8x |
| `exa` | 11779ms | 4919ms | 2.4x |
| `cua-driver` | 6096ms | 754ms | 8.1x |
| `playwright-iso` | 2205ms | 893ms | 2.5x |
| `codebase-memory-mcp` | 1445ms | 295ms | 4.9x |
| `gitee mcp` | < 1000ms（未触发慢日志） | 757ms | — |

**结论一：并发化在真实配置上成立，且证据很干净** —— 总耗时 15.4925s 与最慢的单个
server 15.489s 几乎相等（差 3.5ms）。串行时总耗时会是各项之和（并发下的各项相加
≈ 89s，串行时单项更快，所以真实串行值应低于 89s），但无论如何远高于 15.5s。

**结论二：这些绝对数字不能与离机探针对比。** 每个 server 都慢了 2–4 倍，**包括纯
HTTP 的 `github-mcp-server`（12.0s vs curl 1.2s）和本地 exe 的 `cua-driver`
（6.1s vs 0.75s）** —— 没有进程 spawn、没有 npx 的也慢了。这是测试环境的整体性
开销：debug build（未优化）+ 10 路并发 spawn 进程的 CPU 争抢。**所以只能用它验证
「并发成立」，不能用来估生产环境的首条消息延迟。**

> **⚠️ 上面这段归因是错的，见 §7.12。** release 量测证明 debug build 几乎无影响
> （14.867s vs 15.493s，差 4%），并发争抢也被单独证伪（5 路并发只贵 1.01–1.24x）。
> 那 2.5x 的真实来源**至今未解释**。

**结论三：`initialize` 的多版本重试确实在放大成本。** `github-mcp-server` 走纯 HTTP、
curl 实测 1.2s，这里却要 12.0s —— 与该 server 的 `timeoutMs: 30000` 对照，量级上
符合「多个协议版本各走一轮」。这与 7.5 记的是同一个问题。

**仍未做**：在 `tauri dev` 里真正发一条消息。本次校验覆盖了 Rust 侧改动的正确性与
并发收益，但没覆盖前端触发链路（`App.tsx` 的 idle 回调 → `prewarmMcpServers` →
IPC）在真实应用里的行为。

### 7.10 补充：握手是**懒**的（对 §7.2 / §7.4 的重要澄清）

之前我对 `ensure_client` 的理解有个错误前提，值得单独记下来。

读代码确认：**`ensure_client` 不做协议握手**。

- `McpClient::spawn`（`mcp.rs:1291`）只建 transport，并把 `initialized` 置 `false`；
- `ensure_initialized` 的调用点是 `tools_list()`（`mcp.rs:1444`）和 `call_tool()`
  （`mcp.rs:1501`）。

实测印证：`ensure_client(offline_http_config)` 返回只花 **1.1ms**；同样配置走
`list_tools_concurrently` 要 1508ms —— 差额全在 `tools_list` 触发的 initialize 里。

**推论一（对预热实现有约束）**：预热**必须经 `list_tools_concurrently` 走到
`tools_list`**。只调 `ensure_client` 等于只把进程/连接建起来，几秒的协议协商照样
压在首条消息上 —— 那样的"预热"是空的。当前 `mcp_prewarm` 是对的（它复用
`list_tools_concurrently`），这个坑已写进它的文档注释。

**推论二（对 §7.2 的细化）**：缓存里存的是**整个 client**（含 `initialized` 状态），
所以 §7.2 的结论成立 —— 首个 turn 付全部成本，后续 turn 只付一次 `tools/list`
往返。但"首个 turn"付的那笔钱主要发生在 `tools_list` 里，不在 `ensure_client` 里。

**推论三**：`ensure_client` 里「同 id 双拉起」的窗口只有建 transport 那一瞬
（http ≈ 1ms，stdio ≈ 进程创建几十 ms）。窗口之外本来就不会重复拉起：预热在 ~1ms
内就把 client 塞进 map，后到者命中缓存后阻塞在 `client.lock()` 上等握手完成。

### 7.11 一个已回退的尝试：per-id 拉起闸

基于上面那个错误前提（以为 `ensure_client` 会握手、以为预热让「双拉起」从罕见变
常见），我给 `McpRuntimeManager` 加过 `spawn_gates`（per-id mutex + 慢路径二次
复查）。弄清懒握手之后判定**收益不成立**，已 `git checkout --` 回退：

- 它只关一个 ~1ms（http）/ 几十 ms（stdio）的窗口；
- 代价是新增一把 mutex，以及「持闸时去锁 client」引入的一小段队头阻塞；
- 我为此写的测试**前提本身就是错的**（拿 `ensure_client` 的耗时当握手耗时，实测
  solo 只有 1.1ms，断言必然失败）。

**留的尾巴**：如果将来把 §7.5 的 `5 × timeoutMs` 修成「在 `ensure_client` 里就
完成握手」（让 `ensure` 名副其实），`ensure_client` 会变成秒级、双拉起窗口会真的
变宽 —— 那时再引入闸才有意义。

### 7.12 release 量测：debug 与争抢都被证伪，2.5x 仍未解释

用 `measure_real_mcp_cold_start`（`#[ignore]` 量测工具，用法见 §7.13）跑真实 10 个
server，**release profile**：

```
并发列举完成：10 就绪 / 0 失败，总耗时 14.867s，工具数 188
```

| server | release | debug（§7.9） | 离机探针单跑 | 类型 |
| --- | --- | --- | --- | --- |
| `mcp-deepwiki` | 14863ms | 15489ms | 5503ms | npx |
| `context7` | 14746ms | 14389ms | 6029ms | npx |
| `exa` | 13180ms | 11779ms | 4919ms | npx |
| `uni-app-x` | 12162ms | 12221ms | 4889ms | npx |
| `sequential-thinking` | 11776ms | 12976ms | 4674ms | npx |
| `cua-driver` | 4913ms | 6096ms | 754ms | 本地 exe |
| `github-mcp-server` | 4461ms | 12007ms | 1220ms（curl） | http |
| `playwright-iso` | 1724ms | 2205ms | 893ms | node |
| `codebase-memory-mcp` | 1030ms | 1445ms | 295ms | 本地 exe |
| `gitee mcp` | < 1000ms | < 1000ms | 757ms | http |

**证伪一：debug build 不是原因。** release 14.867s vs debug 15.493s，**只差 4%**。
§7.9 结论二把它归因于 debug build，是错的。

**证伪二：并发争抢不是原因。** `scripts/mcp-coldstart-probe.py` 对 5 个 npx 型
server 做「串行 vs 5 路并发」对照（同一批命令、同一台机器）：

| server | 串行 | 5 路并发 | 倍数 |
| --- | --- | --- | --- |
| `context7` | 5.674s | 7.045s | 1.24x |
| `exa` | 5.673s | 6.145s | 1.08x |
| `mcp-deepwiki` | 6.752s | 7.507s | 1.11x |
| `sequential-thinking` | 7.222s | 7.271s | 1.01x |
| `uni-app-x` | 5.511s | 6.076s | 1.10x |
| **合计** | **30.832s** | **7.517s（墙钟）** | **4.10x** |

5 路并发只贵 1.01–1.24x。**并发本身几乎不产生争抢**，4.1x 的提速是真实的。

**那 2.5x 在哪？仍未解释 —— 且已确认不在 server 侧。** 同一批 5 个 npx server：

- 离机 5 路并发：6.1–7.5s（墙钟 7.5s）
- in-app release 并发：8.5–12.4s（总 12.39s）

in-app 比离机再慢 ~1.5–1.7x。且与 npx 无关：`codebase-memory-mcp`（本地 exe、
无 npx、无网络）in-app 1.03s vs 离机 0.295s（3.5x）。**差异出在 in-app 的调用
路径上，不在被调用的 server 上。**

in-app 比探针多做的事（**尚未逐项实测拆开，所以只列为嫌疑，不给结论**）：
`initialize` → `notifications/initialized` → `tools/list` 三个往返（探针只做
`initialize`）；stdio 经 `build_stdio_command` 的 `cmd.exe /S /E:ON /V:OFF /D /S /C`
多转发一层；stderr 尾读线程（`STDERR_TAIL_MAX_LINES = 200`）。这些都看不出值几秒，
但**「看不出」不等于「不是」**——本轮已经因为「看不出就下结论」返工三次了。

**对 §7.4 收益数字的修正**：§7.4 写的「33s → 9.0s（3.6x）」是按 debug 数据算的。
release 下的真实收益是 **28.6s 串行 → 14.867s 并发（1.9x）**。并发确实有效，但远
达不到「N 路并发 ≈ 最慢单个」的理想值。

### 7.13 量测方法（可复用）

```bash
# 1. 导出真实配置（会把 config.sqlite 连 -wal/-shm 一起拷到临时目录再读，
#    否则读不到未 checkpoint 的改动）
python scripts/dump-mcp-configs.py          # → %TEMP%/real-mcp-configs.json

# 2. 量（必须 release；需要绕过沙箱，见下）
cargo test --release -p liveagent --lib measure_real_mcp_cold_start \
  -- --ignored --nocapture
```

**只量子集不必重新编译**：直接改 `real-mcp-configs.json` 的内容（例如只留 npx 型、
或删掉某几个 server 看收益），再跑**已编好的**
`target/release/deps/liveagent_lib-*.exe measure_real_mcp_cold_start --ignored --nocapture`
即可。release 全量重编要 ~17 分钟，这一步能省掉。

**沙箱**：`cargo test --release` 会失败在 `aws-lc-sys` 的 build script —— 它要调
`cl.exe` 写 `target/release/build/aws-lc-sys-*/out/*.o`，沙箱拒绝该写入（dev profile
下这些产物早就在了，所以从没触发过）。需要 `dangerouslyDisableSandbox`。

`scripts/mcp-coldstart-probe.py` 是另一条独立路径：它不经 app 代码，直接对指定
server 跑 MCP `initialize` 握手，支持「串行 vs 并发」对照（`python
scripts/mcp-coldstart-probe.py [server_id]`）。用来区分「server 侧成本」与
「app 侧成本」。*（§7.12 里那 2.5x 就是靠它定位到「不在 server 侧」的。）*


