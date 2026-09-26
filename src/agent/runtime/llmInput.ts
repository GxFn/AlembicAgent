/**
 * 单次模型输入策略：工具可见性/choice兼容、阶段投影预算和输入长度校验。
 * 不持有Runtime或完整LoopContext，不压缩历史、不写PCV、不调用provider，也不决定重试。
 * 实际消息装配与PCV→measurement→Hook顺序由Runtime保留，原有预算值和兼容分支不变。
 */
import type { ToolSchema } from '#ai/AiProvider.js';
import { resolveModelQuirks } from '#ai/registry/ModelQuirks.js';
import type { LLMInputStageProfile } from './LLMInputAssembly.js';
import type { LLMInputAssemblyMeasurement } from './LLMInputMeasurement.js';
import {
  observeForcedToolChoiceMode,
  type ProviderToolChoiceContext,
  resolveProviderToolChoice,
} from './ProviderToolChoicePolicy.js';

export function selectLlmInputTools(
  ctx: ProviderToolChoiceContext,
  modelRef: string,
  requestedToolChoice: string,
  schemas: Array<Record<string, unknown>>
) {
  const harmful = resolveModelQuirks(modelRef).dropToolSchemasWhenToolChoiceNone;
  const decision = resolveProviderToolChoice(ctx, modelRef, requestedToolChoice);
  const selected = decision.keepToolSchemasVisible
    ? schemas.length > 0
      ? schemas
      : undefined
    : requestedToolChoice === 'none' && harmful
      ? undefined
      : schemas.length > 0
        ? schemas
        : undefined;
  // schema已经过catalog边界校验；这里保持原provider DTO投影，不改定义或调用者数组。
  const tools = selected as ToolSchema[] | undefined;
  const effectiveToolChoice = decision.keepToolSchemasVisible
    ? 'auto'
    : tools
      ? requestedToolChoice
      : 'none';
  return {
    tools,
    effectiveToolChoice,
    // 诊断决策mode和实际choice观察mode职责不同，不能合并或从PCV反向读取。
    providerDecisionMode: decision.mode,
    observedToolChoiceMode: observeForcedToolChoiceMode(
      modelRef,
      requestedToolChoice,
      effectiveToolChoice
    ),
  };
}

export function resolveProviderInputBudget(stageProfile: LLMInputStageProfile) {
  switch (stageProfile) {
    case 'record':
      return { maxProjectedMessages: 40, maxProjectedTokens: 14_000 };
    case 'produce':
      return { maxProjectedMessages: 20, maxProjectedTokens: 12_000 };
    case 'analyze':
    case 'summarize':
      return { maxProjectedMessages: 44, maxProjectedTokens: 16_000 };
    default:
      return null;
  }
}

const DEFAULT_LLM_INPUT_TOKEN_LIMIT = 128_000;

export const LLM_INPUT_TOO_LARGE_CODE = 'LLM_INPUT_TOO_LARGE';

export function validateLlmInputSize(
  budget: Readonly<Record<string, unknown>>,
  measurement: LLMInputAssemblyMeasurement
):
  | { ok: true }
  | {
      ok: false;
      code: typeof LLM_INPUT_TOO_LARGE_CODE;
      estimatedTokens: number;
      maxTokens: number;
      message: string;
    } {
  const maxTokens = resolveLlmInputTokenLimit(budget);
  if (measurement.estimatedTokens <= maxTokens) {
    return { ok: true };
  }
  return {
    ok: false,
    code: LLM_INPUT_TOO_LARGE_CODE,
    estimatedTokens: measurement.estimatedTokens,
    maxTokens,
    message: `LLM input exceeds provider input budget (${measurement.estimatedTokens}/${maxTokens} tokens)`,
  };
}

function resolveLlmInputTokenLimit(budget: Readonly<Record<string, unknown>>): number {
  const limits = budget || {};
  const numeric = Number(
    limits.maxProviderInputTokens ?? limits.maxInputTokens ?? limits.contextWindowTokens
  );
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_LLM_INPUT_TOKEN_LIMIT;
  }
  return Math.floor(numeric);
}
