import { invoke } from "@tauri-apps/api/core";

import type { AppSettings } from "../settings";

type PrewarmTarget = {
  origin: string;
  useSystemProxy: boolean;
};

/**
 * 从 baseUrl 取出纯 origin（scheme + host + port）。
 *
 * 取不出合法 http(s) origin 时返回 null —— 预热不是校验点，静默跳过即可，不该
 * 因此抛出或上报。`isFullUrl` 的供应商 baseUrl 带路径，`URL.origin` 同样正确。
 */
function resolvePrewarmOrigin(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * 只预热「当前选中的供应商」。
 *
 * 不做全量预热是刻意的：用户启动后第一条消息最可能用当前选中的模型；而预热会向
 * 目标发一次真实请求（HEAD），对用户并未使用的供应商发起这种请求既浪费带宽，也
 * 可能在对方侧留下无谓的访问记录。
 */
export function collectPrewarmTargets(settings: AppSettings): PrewarmTarget[] {
  const selected = settings.selectedModel;
  if (!selected) return [];
  const provider = settings.customProviders.find((item) => item.id === selected.customProviderId);
  if (!provider) return [];
  const origin = resolvePrewarmOrigin(provider.baseUrl);
  if (!origin) return [];
  return [{ origin, useSystemProxy: provider.useSystemProxy === true }];
}

/**
 * 把本地反代到上游的连接提前建好，使启动后的第一条消息不必再付
 * DNS + TCP + TLS 的冷启动成本。
 *
 * 纯优化，因此失败一律吞掉：预热出问题不该有任何用户可见后果，也不该重试。
 * 真正的建连与超时控制在 Rust 侧（`proxy_prewarm`），那里才能保证用的是真实
 * 请求所用的同一个 client 实例。
 */
export async function prewarmProviderConnections(settings: AppSettings): Promise<void> {
  const targets = collectPrewarmTargets(settings);
  if (targets.length === 0) return;
  try {
    await invoke("proxy_prewarm", { targets });
  } catch (error) {
    console.warn("provider connection prewarm failed", error);
  }
}
