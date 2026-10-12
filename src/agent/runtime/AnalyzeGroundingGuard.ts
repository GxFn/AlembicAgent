import { resolveModelQuirks } from '#ai/registry/ModelQuirks.js';
import type { LoopContext } from './LoopContext.js';
import { getLatestPcvBurnGrounding } from './PcvNodeEvidenceRecorder.js';
import { isAnalyzeFirstBurnGuardEligible } from './ProviderToolChoicePolicy.js';

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
 * - 依赖方向：guard 单向读 `ProviderToolChoicePolicy.isAnalyzeFirstBurnGuardEligible`（guard→provider 下行），
 *   provider 不依赖 guard（无反向 / 循环）。
 * - 行为对等：AP-2 仅迁移、不改行为；AP-3 已将 groundingEnforcement 默认切为 `'off'`。
 *   本 guard 只在 runtime 默认或 per-run override 显式 opt-in 为 `'guard'` 时注入政策文本并触发阻断。
 *
 * block/nudge/rollback 的**应用**（appendUserNudge / rollbackTick / 诊断 / 进度事件）仍由 AgentRuntime
 * 主循环执行；本 guard 只产出决策。
 * - 连续阻断上限（I38）：决策读取 LoopContext.consecutiveGroundingBlocks，达到上限后返回 limitReached
 *   放行；计数的累加 / 清零同样由 AgentRuntime 调用点执行，guard 不写 ctx。
 */

/**
 * analyze 阶段 grounding-policy 指令文本（analyze always-on 静态文本，按 modelRef/refCount 参数化）。
 * 行为对等迁出自 `LLMInputAssembly.buildAnalyzeGroundingPolicy`。
 */
export function buildAnalyzeGroundingPolicy(
  modelRef: string,
  deterministicRefCount: number
): string {
  // P1-B-3：provider 附加句由 ModelQuirks 声明(字面量移入 src/ai)。
  const providerNote = resolveModelQuirks(modelRef).groundingPolicyProviderNote ?? '';
  return `Every analyze burn that advances a conclusion must consume cited deterministic evidence refs or produce new tool evidence. Planning-only text may choose the next evidence frontier but must not assert verified facts.${deterministicRefCount > 0 ? ' Cite the relevant deterministicEvidenceRefs when using injected evidence.' : ''}${providerNote}`;
}

/**
 * 同一连续段内 invalid-no-evidence 文本轮最多阻断的次数（I38）。
 *
 * 每次阻断都会 rollbackTick，tracker 轮次不前进；没有上限时，持续只输出无证据文本的模型会让循环
 * 只能靠 stage 超时 / token 预算 / 外部 abort 结束，且每轮都是一次完整 LLM 调用。取 2：保留“阻断一次后
 * 次轮合规”的 AP-0 行为（characterization 用例），并再给一次纠正机会；之后放行为普通文本轮。
 * 模块私有常量；调用点通过决策里的 blockLimit 读取，不经任何出口导出。
 */
const MAX_CONSECUTIVE_GROUNDING_BLOCKS = 2;

/** analyze 文本轮 grounding 门决策（模块内类型，不经公开出口导出）。 */
export interface AnalyzeTextGroundingGateDecision {
  /** true = 本轮应阻断（nudge + rollbackTick，不推进阶段） */
  block: boolean;
  nudge: string;
  reason: string;
  /**
   * true = 本轮分类仍是 invalid-no-evidence，但同一连续段内的阻断次数已达上限，改为放行
   * （调用点必须记 grounding_block_limit_reached 诊断，并按普通文本轮走 endRound/onTextResponse）。
   */
  limitReached: boolean;
  /** 本轮决策前已连续阻断的次数（读自 ctx.consecutiveGroundingBlocks） */
  consecutiveBlocks: number;
  /** 本次决策使用的连续阻断上限 */
  blockLimit: number;
}

/**
 * analyze 文本轮 grounding 门：DeepSeek V4 analyze 首轮且 classification=invalid-no-evidence → 阻断 + nudge。
 * 只读消费 PCV grounding burn 的 classification / deterministicEvidenceRefs；不反写证据。
 * 行为对等迁出自 `AgentRuntime.#evaluateAnalyzeTextGroundingGate`。
 *
 * I38：同一连续段内阻断次数达到 MAX_CONSECUTIVE_GROUNDING_BLOCKS 后不再阻断，返回 limitReached=true。
 * 本函数只读 ctx.consecutiveGroundingBlocks、不写；计数的累加与清零由 AgentRuntime 调用点执行。
 */
export function evaluateAnalyzeTextGroundingGate(
  ctx: LoopContext,
  modelRef: string
): AnalyzeTextGroundingGateDecision {
  const consecutiveBlocks = ctx.consecutiveGroundingBlocks;
  const pass: AnalyzeTextGroundingGateDecision = {
    block: false,
    nudge: '',
    reason: '',
    limitReached: false,
    consecutiveBlocks,
    blockLimit: MAX_CONSECUTIVE_GROUNDING_BLOCKS,
  };
  const burn = getLatestPcvBurnGrounding(ctx.pcvNodeEvidence);
  if (!burn || !isAnalyzeFirstBurnGuardEligible(ctx, modelRef)) {
    return pass;
  }
  if (burn.classification !== 'invalid-no-evidence') {
    return pass;
  }
  const reason =
    'Analyze burn returned text without deterministic evidence consumption, evidence tool calls, or finding delta.';
  // 上限分叉：本轮仍是 invalid-no-evidence，但已连续阻断到上限 → 放行，不再 nudge / rollback。
  // 放行原因与计数通过 limitReached / consecutiveBlocks 交给调用点记诊断。
  if (consecutiveBlocks >= MAX_CONSECUTIVE_GROUNDING_BLOCKS) {
    return { ...pass, reason, limitReached: true };
  }
  const deterministicRefs = burn.deterministicEvidenceRefs.slice(0, 8);
  const refsHint =
    deterministicRefs.length > 0
      ? `请明确引用并消费这些 deterministicEvidenceRefs 中的相关项：${deterministicRefs.join(', ')}。`
      : '当前没有足够的 deterministicEvidenceRefs；请调用 code / graph / terminal 取得可复核代码证据。';
  return {
    ...pass,
    block: true,
    reason,
    nudge:
      '本轮 analyze 文本没有可观测证据 grounding，不能推进阶段。' +
      `${refsHint} 如果只是规划下一步，只输出取证计划并绑定 evidence refs；如果要推进事实结论，必须先产生或消费可复核证据。`,
  };
}
