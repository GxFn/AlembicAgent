/**
 * 单次模型输入策略：工具可见性/choice兼容、阶段投影预算和输入长度校验。
 * 不持有Runtime或完整LoopContext，不压缩历史、不写PCV、不调用provider，也不决定重试。
 * 实际消息装配与PCV→measurement→Hook顺序由Runtime保留，原有预算值和兼容分支不变。
 */
import type { ToolSchema } from '#ai/AiProvider.js';
import type { LLMInputStageProfile } from './LLMInputAssembly.js';
import type { LLMInputAssemblyMeasurement } from './LLMInputMeasurement.js';
import {
  observeForcedToolChoiceMode,
  type ProviderToolChoiceContext,
  resolveProviderToolChoice,
} from './ProviderToolChoicePolicy.js';

/**
 * DeepSeek V4 首轮本应“保留工具可见、effective=auto”，但本轮没有任何可用 schema 时的决策侧 mode。
 * 只用于 Runtime “LLM call start” 日志的 deepseekV4ToolChoiceMode 字段：日志里同时能看到触发条件
 * （requestedToolChoice=none + 首轮例外）、选择路径（降级为隐藏）与结果（toolSchemaCount=0、effective=none）。
 * PCV 仍只记录观察侧 mode（schemas-hidden-no-tool-choice），两者职责不同、不能互相替代。
 */
const FIRST_BURN_VISIBILITY_SKIPPED_MODE = 'tools-visible-skipped-no-schemas';

/**
 * 选择本轮真正发给 provider 的工具与 toolChoice。
 *
 * 与 Gateway 契约对齐（I13）：LLMGateway.chatWithTools 在 toolChoice='none' 时对所有 provider 都丢弃 tools，
 * 所以这里只要请求 none（且不是 V4 首轮例外）就返回 tools=undefined。输入装配的 toolContract、
 * 输入长度测量、PCV 证据和调用日志都以本返回值为准，因此它们只描述实际发送的工具；
 * provider 收到的 wire 请求不变（none 下本来就没有 tools，SDK 在无 tools 时也不发送 tool_choice）。
 *
 * 唯一例外是 DeepSeek V4 analyze 首轮：provider 兼容策略要求保留 schema 可见并改为 effective='auto'。
 * 该例外只有在本轮确实有 schema 时才成立；schema 为空时回到 none 分支，否则诊断会宣称“工具可见”，
 * Runtime 也会因此放行 toolChoice=none 下返回的工具调用。
 */
export function selectLlmInputTools(
  ctx: ProviderToolChoiceContext,
  modelRef: string,
  requestedToolChoice: string,
  schemas: Array<Record<string, unknown>>
) {
  const decision = resolveProviderToolChoice(ctx, modelRef, requestedToolChoice);
  const hasSchemas = schemas.length > 0;
  const keepVisible = decision.keepToolSchemasVisible && hasSchemas;
  const selected =
    keepVisible || (requestedToolChoice !== 'none' && hasSchemas) ? schemas : undefined;
  // schema已经过catalog边界校验；这里保持原provider DTO投影，不改定义或调用者数组。
  const tools = selected as ToolSchema[] | undefined;
  // 例外成立 → auto；有工具发出 → 保持请求值；没有工具发出（请求 none 或本轮无 schema）→ none。
  const effectiveToolChoice = keepVisible ? 'auto' : tools ? requestedToolChoice : 'none';
  // 例外被跳过时决策侧 mode 换成显式的“跳过”值，避免日志写着 tools-visible 却没有任何 schema。
  const providerDecisionMode =
    decision.keepToolSchemasVisible && !keepVisible
      ? FIRST_BURN_VISIBILITY_SKIPPED_MODE
      : decision.mode;
  return {
    tools,
    effectiveToolChoice,
    // 诊断决策mode和实际choice观察mode职责不同，不能合并或从PCV反向读取。
    providerDecisionMode,
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
