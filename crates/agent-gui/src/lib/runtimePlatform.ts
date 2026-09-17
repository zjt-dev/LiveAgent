import { invoke } from "@tauri-apps/api/core";

export type RuntimePlatform = "windows" | "macos" | "linux";

type RuntimePlatformResponse = {
  platform?: unknown;
};

export function normalizeRuntimePlatform(value: unknown): RuntimePlatform | undefined {
  if (value === "windows" || value === "macos" || value === "linux") return value;
  return undefined;
}

export function inferRuntimePlatform(): RuntimePlatform {
  const nav =
    typeof navigator !== "undefined"
      ? `${navigator.userAgent || ""} ${navigator.platform || ""}`
      : "";
  if (/\bWindows\b|Win32|Win64|WOW64/i.test(nav)) return "windows";
  if (/Mac|iPhone|iPad|iPod/i.test(nav)) return "macos";
  return "linux";
}

export function runtimePlatformLabel(platform: RuntimePlatform) {
  if (platform === "windows") return "Windows";
  if (platform === "macos") return "macOS";
  return "Linux";
}

let runtimePlatformPromise: Promise<RuntimePlatform> | null = null;

/**
 * 解析宿主平台。结果在进程生命周期内不可能变化，因此首次解析后永久缓存。
 *
 * 缓存的是 Promise 而非结果值：同一轮对话里多处并发解析时只会触发一次 IPC。
 * 与 `providers/proxy.ts` 的 `getProxyServerInfo` 同一模式。
 *
 * 注意 `resolveRuntimePlatform` 原本每次调用都打一次 IPC，而它在
 * `runAgentConversationTurn` 的发送路径上 —— 每一轮消息都要白付一次跨进程往返。
 */
export function resolveRuntimePlatform(): Promise<RuntimePlatform> {
  if (!runtimePlatformPromise) {
    runtimePlatformPromise = invoke<RuntimePlatformResponse>("app_runtime_platform")
      .then((response) => normalizeRuntimePlatform(response?.platform) ?? inferRuntimePlatform())
      // IPC 失败不是异常路径：同步兜底给出的答案同样正确，且缓存住可避免
      // 每次发送都重试一次注定失败的 IPC。
      .catch(() => inferRuntimePlatform());
  }
  return runtimePlatformPromise;
}
