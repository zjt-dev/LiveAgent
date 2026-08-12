import { parseModelValue } from "@liveagent/app/lib/providers/llm";
import {
  type CustomProvider,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  isThinkingAlwaysOnForModel,
} from "@liveagent/app/lib/settings";

export const CRON_REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type CronReasoningLevel = (typeof CRON_REASONING_LEVELS)[number];

export const DEFAULT_CRON_REASONING: CronReasoningLevel = "medium";

export function isCronReasoningLevel(value: string): value is CronReasoningLevel {
  return (CRON_REASONING_LEVELS as readonly string[]).includes(value);
}

export function getCronReasoningLevels(
  selectedModelValue: string,
  providers: CustomProvider[],
): CronReasoningLevel[] {
  const selectedModel = parseModelValue(selectedModelValue);
  const provider = selectedModel
    ? providers.find((item) => item.id === selectedModel.customProviderId)
    : undefined;
  if (!selectedModel || !provider) return [...CRON_REASONING_LEVELS];

  const modelConfig = findProviderModelConfig(provider, selectedModel.model);
  const supportedLevels = getChatRuntimeReasoningLevelsForProvider({
    providerId: provider.type,
    requestFormat: provider.requestFormat,
    modelId: selectedModel.model,
    modelConfig,
  }).filter(isCronReasoningLevel);
  const thinkingAlwaysOn = isThinkingAlwaysOnForModel(
    provider.type,
    selectedModel.model,
    modelConfig.reasoningLevels,
  );
  if (!thinkingAlwaysOn) return ["off", ...supportedLevels];
  // 常开思考模型即使显式清空可调档位（reasoningLevels: []）也不能给出空
  // 下拉：回落到目录推断档位；目录也无档位（单档 toggle 模型）时只给默认档，
  // 保证下拉与落库值恒在可选集合内。
  if (supportedLevels.length > 0) return supportedLevels;
  const catalogLevels = getChatRuntimeReasoningLevelsForProvider({
    providerId: provider.type,
    requestFormat: provider.requestFormat,
    modelId: selectedModel.model,
  }).filter(isCronReasoningLevel);
  return catalogLevels.length > 0 ? catalogLevels : [DEFAULT_CRON_REASONING];
}

export function coerceCronReasoningLevel(
  levels: CronReasoningLevel[],
  current: CronReasoningLevel,
): CronReasoningLevel {
  if (levels.includes(current)) return current;
  if (levels.includes(DEFAULT_CRON_REASONING)) return DEFAULT_CRON_REASONING;
  return levels[0] ?? DEFAULT_CRON_REASONING;
}
