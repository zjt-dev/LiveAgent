import { invoke } from "@tauri-apps/api/core";

import { type AppSettings, selectEnabledMcpServers } from "../settings";

/**
 * 空闲预热已启用的 MCP server。
 *
 * 动机：npx 型 MCP server（`npx -y <pkg>@latest`）冷启动约 5s，且耗时几乎全在
 * 等 npx 回查 registry 并把 Node 拉起来，不在协议握手上。这段成本原本整体压在
 * 首条消息的关键路径上（构建工具注册表 → `mcp_list_tools`），本机实测 10 个
 * enabled server 串行约 27s。在用户打字期间提前把进程拉起并完成握手，首条消息
 * 就能直接命中 `ensure_client` 的缓存。
 *
 * 预热集合取「全局已启用」而非当前工作区过滤后的子集：过滤结果随工作区变化，
 * 而预热时未必已知用户会开哪个工作区；多拉起的进程本来也会在首次用到它时被拉起，
 * 这里只是把时机提前。代价是启动后会常驻这些子进程的内存。
 *
 * best-effort：失败静默 —— 预热纯属优化，不该有任何用户可见后果。真正的失败会
 * 在对话时经 `mcp_list_tools` 呈现（那里才有 `onLoadError` 通道）。
 */
export async function prewarmMcpServers(settings: AppSettings): Promise<void> {
  // 预热不是校验点：设置尚未就绪时静默跳过即可，不该抛出。
  const mcp = settings?.mcp;
  if (!mcp) return;
  const servers = selectEnabledMcpServers(mcp);
  if (servers.length === 0) return;
  try {
    await invoke<number>("mcp_prewarm", { servers });
  } catch (error) {
    console.warn("MCP server prewarm failed", error);
  }
}
