import type { LoopContext } from './LoopContext.js';
import { getLatestPcvBurnGrounding } from './PcvNodeEvidence.js';
import { isDeepSeekV4AnalyzeFirstBurn } from './ProviderToolChoicePolicy.js';

/**
 * AnalyzeGroundingGuard — analyze grounding enforcement（runtime 质量门层）。
 *
 * 收敛 analyze 阶段的 grounding **强约束**：
 * - grounding-policy 指令文本注入（CP1）：always-on 静态文本，按 modelRef / refCount 参数化；
 * - invalid-no-evidence 文本轮**阻断 + nudge** 决策（CP4）：只读消费 PCV grounding classification。
 *
 * 职责边界（PCV observe-only 收敛 AP-2）：
 * - 输入 = PCV grounding `classification`（**只读消费，不反写证据**）；输出 = 政策文本 / block-nudge 决策。
 * - 命名归位：不带 `Pcv*` 前缀，与证据记录层分离。
 * - PD5：guard **仅含**「政策文本 + nudge + 阻断」；证据 ref 列表注入（deterministicEvidenceRefs /
 *   evidenceStarterRefs）**不属本 guard**，保留为默认 analyze 上下文（有用 grounding 材料、非强制控制）。
 * - 依赖方向：guard 单向读 `ProviderToolChoicePolicy.isDeepSeekV4AnalyzeFirstBurn`（guard→provider 下行），
 *   provider 不依赖 guard（无反向 / 循环）。
 * - 行为对等：AP-2 仅迁移、不改行为；AP-3 已将 groundingEnforcement 默认切为 `'off'`。
 *   本 guard 只在 runtime 默认或 per-run override 显式 opt-in 为 `'guard'` 时注入政策文本并触发阻断。
 *
 * block/nudge/rollback 的**应用**（appendUserNudge / rollbackTick / 诊断 / 进度事件）仍由 AgentRuntime
 * 主循环执行；本 guard 只产出决策。
 */

/**
 * analyze 阶段 grounding-policy 指令文本（analyze always-on 静态文本，按 modelRef/refCount 参数化）。
 * 行为对等迁出自 `LLMInputAssembly.buildAnalyzeGroundingPolicy`。
 */
export function buildAnalyzeGroundingPolicy(
  modelRef: string,
  deterministicRefCount: number
): string {
  const deepseekMode = /deepseek.*v4|deepseek-v4/i.test(modelRef)
    ? ' DeepSeek V4 cannot rely on forced tool_choice; use visible tools or cited deterministic refs.'
    : '';
  return `Every analyze burn that advances a conclusion must consume cited deterministic evidence refs or produce new tool evidence. Planning-only text may choose the next evidence frontier but must not assert verified facts.${deterministicRefCount > 0 ? ' Cite the relevant deterministicEvidenceRefs when using injected evidence.' : ''}${deepseekMode}`;
}

/**
 * analyze 文本轮 grounding 门：DeepSeek V4 analyze 首轮且 classification=invalid-no-evidence → 阻断 + nudge。
 * 只读消费 PCV grounding burn 的 classification / deterministicEvidenceRefs；不反写证据。
 * 行为对等迁出自 `AgentRuntime.#evaluateAnalyzeTextGroundingGate`。
 */
export function evaluateAnalyzeTextGroundingGate(
  ctx: LoopContext,
  modelRef: string
): { block: boolean; nudge: string; reason: string } {
  const burn = getLatestPcvBurnGrounding(ctx.pcvNodeEvidence);
  if (!burn || !isDeepSeekV4AnalyzeFirstBurn(ctx, modelRef)) {
    return { block: false, nudge: '', reason: '' };
  }
  if (burn.classification !== 'invalid-no-evidence') {
    return { block: false, nudge: '', reason: '' };
  }
  const deterministicRefs = burn.deterministicEvidenceRefs.slice(0, 8);
  const refsHint =
    deterministicRefs.length > 0
      ? `请明确引用并消费这些 deterministicEvidenceRefs 中的相关项：${deterministicRefs.join(', ')}。`
      : '当前没有足够的 deterministicEvidenceRefs；请调用 code / graph / terminal 取得可复核代码证据。';
  return {
    block: true,
    reason:
      'DeepSeek V4 analyze burn returned text without deterministic evidence consumption, evidence tool calls, or finding delta.',
    nudge:
      '本轮 analyze 文本没有可观测证据 grounding，不能推进阶段。' +
      `${refsHint} 如果只是规划下一步，只输出取证计划并绑定 evidence refs；如果要推进事实结论，必须先产生或消费可复核证据。`,
  };
}
