/**
 * ModelQuirks — P1-B-3(挖掘质量升级)：provider 行为特化的单一查询面。
 *
 * 目标(需求 §15.4)：内核(src/agent/{runtime,evaluation,strategies})零 provider 名分支——
 * 所有"这个模型行为特殊吗"的判定收敛到本文件的 resolveModelQuirks()，内核只读旗标。
 * provider 名正则/字符串只允许存在于 src/ai/**(本文件与 transport/providers)。
 *
 * 语义保真(迁移不改行为的口径)：
 * - 旧内核直接对【裸 modelRef】做正则(注册表未命中也生效)——本解析器保留同款正则回退，
 *   注册表命中时优先使用声明数据(`parameterConstraints.toolChoice.allowed===false` 已是
 *   forced-tool-choice 轴的现成单源，deepseek.ts V4 两型早已声明)。
 * - 一处已声明的修正:deepseek-reasoner 注册表声明 toolChoice.allowed=false，旧内核 V4 正则
 *   漏掉它——本解析器按声明数据判 forcedToolChoiceUnsupported=true(数据先于名字)。
 */
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
  /** provider 走文本工具调用兼容桥(transport 层把文本解析为 functionCalls)。 */
  usesTextToolCallCompat: boolean;
}

/** 文本兼容桥的 call-id 前缀与来源标记(与 transport 的 deepseekToolCallCompat 同宿)。 */
export const TEXT_COMPAT_CALL_ID_PREFIX = 'call_deepseek_compat_';
export const TEXT_COMPAT_CALL_SOURCE = 'deepseek_text_compat';
export const NATIVE_TOOL_CALL_SOURCE = 'native_or_provider_tool_call';

export function isTextCompatToolCallId(callId: string | null | undefined): boolean {
  return typeof callId === 'string' && callId.startsWith(TEXT_COMPAT_CALL_ID_PREFIX);
}

// V4 家族与 gemini 的名字回退正则(与旧内核逐字同款,保证未注册 ref 行为不变)。
const V4_NAME_RE = /deepseek.*v4|deepseek-v4/i;
const DEEPSEEK_NAME_RE = /deepseek/i;
const GEMINI_NAME_RE = /gemini/i;

const V4_GROUNDING_NOTE =
  ' DeepSeek V4 cannot rely on forced tool_choice; use visible tools or cited deterministic refs.';

/**
 * 单点解析：modelRef → 行为特化档案。注册表命中用声明数据,未命中回退旧内核同款名字正则。
 * 纯函数无副作用；每次调用重算(轻量,无缓存需求)。
 */
export function resolveModelQuirks(modelRef: string | null | undefined): ModelQuirkProfile {
  const ref = modelRef || '';
  const registry = getModelRegistry();
  // 裸 apiModelId(运行时 modelRef 常见形态)也要命中注册表声明——get 只认 provider:apiModelId 精确 id。
  const def = registry.get(ref) ?? registry.findByApiModelId(ref);
  const nameLooksV4 = V4_NAME_RE.test(ref) || V4_NAME_RE.test(def?.apiModelId || '');
  const isDeepSeek = def ? def.provider === 'deepseek' : DEEPSEEK_NAME_RE.test(ref);
  const isGoogle = def ? def.provider === 'google' : GEMINI_NAME_RE.test(ref);

  const forcedToolChoiceUnsupported = def
    ? def.parameterConstraints.toolChoice?.allowed === false
    : nameLooksV4;
  const analyzeGroundingGuardEligible = isDeepSeek && nameLooksV4;

  return {
    forcedToolChoiceUnsupported,
    analyzeGroundingGuardEligible,
    dropToolSchemasWhenToolChoiceNone: nameLooksV4 || isGoogle,
    groundingPolicyProviderNote: analyzeGroundingGuardEligible ? V4_GROUNDING_NOTE : null,
    usesTextToolCallCompat: isDeepSeek,
  };
}
