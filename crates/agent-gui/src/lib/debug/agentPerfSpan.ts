import type { StreamDebugLogger } from "./agentDebug";

/**
 * 超过该阈值的 span 会额外打到 `console.warn`，便于在 DevTools 里直接看到，
 * 不必先开启 debug logger。
 */
export const AGENT_PERF_LOG_THRESHOLD_MS = 250;

export function perfNowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * 收口一次性能 span：写进 debug JSONL（仅 logger 启用时），并在超过阈值时打
 * `console.warn`。
 *
 * 放在 `lib/debug` 而非对话目录，是因为 `agentRunner`（`lib/chat/runner`）也要
 * 埋点，而它被 `runAgentConversationTurn`（`pages/chat/turns`）引用 —— 放在
 * pages 下会让 lib 反向依赖 pages。
 *
 * `logger` 允许缺省：真实调用点里 `debugLogger` 是可选参数，且 `console.warn`
 * 这条通道不依赖 logger，未开调试日志时依然可见。
 */
export function finishAgentPerfSpan(
  logger: StreamDebugLogger | undefined,
  span: string,
  startedAt: number,
  fields: Record<string, unknown> = {},
  thresholdMs = AGENT_PERF_LOG_THRESHOLD_MS,
) {
  const durationMs = Math.round(perfNowMs() - startedAt);
  const payload = {
    type: "perf_span",
    span,
    durationMs,
    ...fields,
  };
  if (logger?.enabled) {
    logger.logResult(payload);
  }
  if (durationMs >= thresholdMs) {
    console.warn(`[Agent perf] ${span} took ${durationMs}ms`, fields);
  }
  return durationMs;
}
