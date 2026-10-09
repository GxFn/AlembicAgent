/**
 * ModelQuirks — P1-B-3(挖掘质量升级)：provider 行为特化的单一查询面。
 *
 * 目标(需求 §15.4)：内核(src/agent/{runtime,evaluation,strategies})零 provider 名分支——
 * 所有"这个模型行为特殊吗"的判定收敛到本文件的 resolveModelQuirks()，内核只读旗标。
 * provider 名正则/字符串只允许存在于 src/ai/**(本文件与 transport/providers)。
 *
 * DeepSeek V4 家族判定单源：isDeepSeekV4Family() 同时供本文件的档案解析与
 * transport/DeepSeekTransport 的按请求参数策略使用，两处不再各自维护名字正则。
 *
 * 语义保真(迁移不改行为的口径)：
 * - 注册表命中时优先使用声明数据(`parameterConstraints.toolChoice.allowed===false` 已是
 *   forced-tool-choice 轴的现成单源，deepseek.ts V4 两型早已声明)。
 * - 注册表未命中(裸名、代理前缀名、未登记变体)时回退一条共享名字正则；该正则是旧内核
 *   `deepseek.*v4` 与旧 transport `deepseek-(flash|pro)` 的并集，使两处对未登记名的判定一致。
 * - 一处已声明的修正:deepseek-reasoner 注册表声明 toolChoice.allowed=false，旧内核 V4 正则
 *   漏掉它——本解析器按声明数据判 forcedToolChoiceUnsupported=true(数据先于名字)；但它不支持
 *   工具调用，不属于 V4 家族(guard/提示附加句/thinking 切换都不适用)。
 */
import type { ModelDef } from './ModelDefs.js';
import { getModelRegistry } from './ModelRegistry.js';

export interface ModelQuirkProfile {
  /** provider 不接受强制 tool_choice(发了会丢工具可见性/被忽略)。 */
  forcedToolChoiceUnsupported: boolean;
  /** analyze 首轮接地守卫适格(DeepSeek V4 家族:首轮文本 burn 需 guard/nudge 语义)。 */
  analyzeGroundingGuardEligible: boolean;
  /** toolChoice=none 时应隐藏 tool schemas(部分 provider 见 schema 即污染思维/破坏缓存)。 */
  dropToolSchemasWhenToolChoiceNone: boolean;
  /** 接地策略文案的 provider 附加句(null=不附加)。 */
  groundingPolicyProviderNote: string | null;
}

/**
 * 文本兼容桥的 call-id 前缀与来源标记。生成方 src/ai/deepseekToolCallCompat.ts 直接导入本常量，
 * AgentRuntime 用 isTextCompatToolCallId 区分兼容转译与 provider 原生 tool_calls——两侧必须同源。
 */
export const TEXT_COMPAT_CALL_ID_PREFIX = 'call_deepseek_compat_';
export const TEXT_COMPAT_CALL_SOURCE = 'deepseek_text_compat';
export const NATIVE_TOOL_CALL_SOURCE = 'native_or_provider_tool_call';

export function isTextCompatToolCallId(callId: string | null | undefined): boolean {
  return typeof callId === 'string' && callId.startsWith(TEXT_COMPAT_CALL_ID_PREFIX);
}

// 注册表未命中时的 V4 家族名字回退：旧内核 `deepseek.*v4` 与旧 transport `deepseek-(flash|pro)`
// 的并集(与 @ai-sdk/deepseek 的 V4 名字判定同向)。只在此处维护，transport 不得另写正则。
const V4_FAMILY_NAME_RE = /deepseek.*v4|deepseek-(?:flash|pro)/i;
const DEEPSEEK_NAME_RE = /deepseek/i;
const GEMINI_NAME_RE = /gemini/i;

const V4_GROUNDING_NOTE =
  ' DeepSeek V4 cannot rely on forced tool_choice; use visible tools or cited deterministic refs.';

/** V4 家族判定的来源：registry=注册表声明，name-fallback=未登记名走共享正则，none=空 ref。 */
export type DeepSeekV4FamilySource = 'registry' | 'name-fallback' | 'none';

export interface DeepSeekV4FamilyResolution {
  isV4: boolean;
  source: DeepSeekV4FamilySource;
}

function lookupModelDef(ref: string): ModelDef | undefined {
  const registry = getModelRegistry();
  // 裸 apiModelId(运行时 modelRef / transport request.model 的常见形态)也要命中注册表声明——
  // get 只认 provider:apiModelId 精确 id。
  return registry.get(ref) ?? registry.findByApiModelId(ref);
}

/**
 * DeepSeek V4 家族(thinking + 工具调用、拒绝强制 tool_choice)的单一判定，并返回判定来源，
 * 供 transport 在诊断日志中区分注册表声明与名字回退。
 *
 * 注册表命中：provider=deepseek 且声明 toolChoice.allowed=false 且支持工具调用。
 * 这样 deepseek-reasoner(toolChoice 不允许但不支持工具)与 deepseek-chat(允许 toolChoice)都不算 V4，
 * 与改造前已登记模型的判定逐一相同。注册表未命中：V4_FAMILY_NAME_RE。
 */
export function resolveDeepSeekV4Family(
  modelRef: string | null | undefined
): DeepSeekV4FamilyResolution {
  const ref = modelRef || '';
  if (!ref) {
    return { isV4: false, source: 'none' };
  }
  const def = lookupModelDef(ref);
  if (def) {
    return { isV4: isRegisteredV4Def(def), source: 'registry' };
  }
  return { isV4: V4_FAMILY_NAME_RE.test(ref), source: 'name-fallback' };
}

export function isDeepSeekV4Family(modelRef: string | null | undefined): boolean {
  return resolveDeepSeekV4Family(modelRef).isV4;
}

function isRegisteredV4Def(def: ModelDef): boolean {
  return (
    def.provider === 'deepseek' &&
    def.parameterConstraints.toolChoice?.allowed === false &&
    def.capabilities.toolCalling
  );
}

/**
 * 单点解析：modelRef → 行为特化档案。注册表命中用声明数据,未命中回退共享名字正则。
 * 纯函数无副作用；每次调用重算(轻量,无缓存需求)。
 */
export function resolveModelQuirks(modelRef: string | null | undefined): ModelQuirkProfile {
  const ref = modelRef || '';
  const def = ref ? lookupModelDef(ref) : undefined;
  const isV4Family = def ? isRegisteredV4Def(def) : V4_FAMILY_NAME_RE.test(ref);
  const isDeepSeek = def ? def.provider === 'deepseek' : DEEPSEEK_NAME_RE.test(ref);
  const isGoogle = def ? def.provider === 'google' : GEMINI_NAME_RE.test(ref);

  const forcedToolChoiceUnsupported = def
    ? def.parameterConstraints.toolChoice?.allowed === false
    : isV4Family;
  const analyzeGroundingGuardEligible = isDeepSeek && isV4Family;

  return {
    forcedToolChoiceUnsupported,
    analyzeGroundingGuardEligible,
    dropToolSchemasWhenToolChoiceNone: isV4Family || isGoogle,
    groundingPolicyProviderNote: analyzeGroundingGuardEligible ? V4_GROUNDING_NOTE : null,
  };
}
