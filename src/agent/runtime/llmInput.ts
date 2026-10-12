/**
 * 单次模型输入策略：工具可见性/choice兼容、阶段投影预算和输入长度校验。
 * 不持有Runtime或完整LoopContext，不压缩历史、不写PCV、不调用provider，也不决定重试。
 * 实际消息装配与PCV→measurement→Hook顺序由Runtime保留，原有预算值和兼容分支不变。
 * 输入长度上限（I14）按“显式覆盖 → 模型注册表 contextWindow 减输出预留 → 128k 默认”解析；
 * 这里只做纯计算、不查注册表也不写日志；注册表查询与来源诊断由 Runtime 在组装预算与拒绝时完成。
 */
import type { ToolSchema } from '#ai/AiProvider.js';
import type { ModelDef } from '#ai/registry/ModelDefs.js';
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

/**
 * 模型注册表查不到可信上下文窗口时的输入上限（与模型无关的保守默认）。
 * 只有“无显式覆盖 + 注册表未登记/provider 未知”才走到这里，来源标注为 default。
 */
const DEFAULT_LLM_INPUT_TOKEN_LIMIT = 128_000;

export const LLM_INPUT_TOO_LARGE_CODE = 'LLM_INPUT_TOO_LARGE';

/**
 * 输入上限来源（I14）：
 * - explicit：budget.maxProviderInputTokens 是正有限数（宿主/阶段显式覆盖，优先级最高）；
 * - model-registry：模型注册表 contextWindow 减去本轮输出预留；
 * - default：两者都没有，保留 128k 默认。
 */
export type ProviderInputLimitSource = 'explicit' | 'model-registry' | 'default';

export interface ProviderInputLimitResolution {
  /** 本轮输入估算允许的最大 token 数。 */
  maxTokens: number;
  source: ProviderInputLimitSource;
  /** 注册表命中的模型 id（仅 model-registry）。 */
  registryModelId?: string;
  /** 注册表声明的上下文窗口（仅 model-registry）。 */
  contextWindow?: number;
  /** 从上下文窗口中预留给输出的 token 数（仅 model-registry；预留被跳过时为 0）。 */
  outputReserveTokens?: number;
  /** 输出预留不小于上下文窗口时跳过预留、直接用整个窗口（仅 model-registry，诊断用）。 */
  outputReserveSkipped?: boolean;
  /** budget 里有 maxProviderInputTokens 但不是正有限数，被忽略时记录其截断字符串（诊断用）。 */
  invalidExplicitValue?: string;
}

/** 非法显式值写进诊断时只保留短前缀，避免把任意宿主输入整段打进日志。 */
const INVALID_EXPLICIT_LOG_LIMIT = 32;

function readPositiveTokenCount(value: unknown): number | null {
  const numeric = Number(value);
  if (value === null || value === undefined || !Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.floor(numeric);
}

/**
 * 注册表模型声明中输入上限需要的字段。注册表查询（modelRef → ModelDef）由 Runtime 完成：
 * 本文件的 layer-contract 文件白名单不含 ModelRegistry，这里只做纯计算。
 */
export type ProviderInputLimitModel = Pick<ModelDef, 'id' | 'contextWindow' | 'maxOutputTokens'>;

/**
 * 解析本次 loop 的 provider 输入上限（显式覆盖 → 注册表窗口减输出预留 → 128k 默认）。
 *
 * 输出预留口径与真实请求一致：Runtime 发给 provider 的 maxTokens 是
 * budget.maxTokens ?? defaultMaxOutputTokens，ParameterGuard 再截到模型 maxOutputTokens，
 * 所以这里取 min(请求值, maxOutputTokens)。纯函数，不写日志；来源与诊断字段由调用方记录。
 */
export function resolveProviderInputLimit(input: {
  budget: Readonly<Record<string, unknown>>;
  /** Runtime 按 modelRef 查到的注册表声明；未登记或 provider 未知时为 null/undefined。 */
  registeredModel: ProviderInputLimitModel | null | undefined;
  /** budget.maxTokens 缺省时 Runtime 实际发送的输出上限（system 8192 / 其它 4096）。 */
  defaultMaxOutputTokens: number;
}): ProviderInputLimitResolution {
  const budget = input.budget || {};
  const explicit = readPositiveTokenCount(budget.maxProviderInputTokens);
  if (explicit !== null) {
    return { maxTokens: explicit, source: 'explicit' };
  }
  const invalidExplicitValue =
    budget.maxProviderInputTokens === undefined || budget.maxProviderInputTokens === null
      ? undefined
      : String(budget.maxProviderInputTokens).slice(0, INVALID_EXPLICIT_LOG_LIMIT);
  const invalidField = invalidExplicitValue === undefined ? {} : { invalidExplicitValue };

  const def = input.registeredModel;
  const contextWindow = readPositiveTokenCount(def?.contextWindow);
  if (!def || contextWindow === null) {
    return { maxTokens: DEFAULT_LLM_INPUT_TOKEN_LIMIT, source: 'default', ...invalidField };
  }
  const requestedOutput =
    readPositiveTokenCount(budget.maxTokens) ?? Math.floor(input.defaultMaxOutputTokens);
  const modelOutputCap = readPositiveTokenCount(def.maxOutputTokens);
  const outputReserve =
    modelOutputCap === null ? requestedOutput : Math.min(requestedOutput, modelOutputCap);
  const remaining = contextWindow - outputReserve;
  // 降级分支：输出预留吃掉了整个窗口（注册值或 maxTokens 配置异常）。若照减会得到 ≤0 的上限、
  // 拒绝一切输入；这里退回整个窗口并标注 outputReserveSkipped，由调用方打 warn。
  if (remaining <= 0) {
    return {
      maxTokens: contextWindow,
      source: 'model-registry',
      registryModelId: def.id,
      contextWindow,
      outputReserveTokens: 0,
      outputReserveSkipped: true,
      ...invalidField,
    };
  }
  return {
    maxTokens: remaining,
    source: 'model-registry',
    registryModelId: def.id,
    contextWindow,
    outputReserveTokens: outputReserve,
    ...invalidField,
  };
}

/**
 * 输入长度守卫：只读 budget.maxProviderInputTokens（I14 删除了生产中无人写入的
 * maxInputTokens / contextWindowTokens 两个别名）。Runtime 在组装预算时已按
 * resolveProviderInputLimit 把注册表窗口写进该键，并通过 limitSource 传入真实来源；
 * 直接调用方不传来源时，键存在即视为 explicit，否则为 default。
 */
export function validateLlmInputSize(
  budget: Readonly<Record<string, unknown>>,
  measurement: LLMInputAssemblyMeasurement,
  limitSource?: ProviderInputLimitSource
):
  | { ok: true }
  | {
      ok: false;
      code: typeof LLM_INPUT_TOO_LARGE_CODE;
      estimatedTokens: number;
      maxTokens: number;
      limitSource: ProviderInputLimitSource;
      message: string;
    } {
  const configured = readPositiveTokenCount(budget?.maxProviderInputTokens);
  const maxTokens = configured ?? DEFAULT_LLM_INPUT_TOKEN_LIMIT;
  if (measurement.estimatedTokens <= maxTokens) {
    return { ok: true };
  }
  const source: ProviderInputLimitSource =
    configured === null ? 'default' : (limitSource ?? 'explicit');
  return {
    ok: false,
    code: LLM_INPUT_TOO_LARGE_CODE,
    estimatedTokens: measurement.estimatedTokens,
    maxTokens,
    limitSource: source,
    message: `LLM input exceeds provider input budget (${measurement.estimatedTokens}/${maxTokens} tokens; limitSource=${source})`,
  };
}
