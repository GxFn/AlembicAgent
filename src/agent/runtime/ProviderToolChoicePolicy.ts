import { resolveModelQuirks } from '#ai/registry/ModelQuirks.js';
import type { LoopContext } from './LoopContext.js';

/**
 * Provider tool-choice 正确性策略（provider 兼容层）。
 *
 * 背景：DeepSeek V4 在 analyze 首轮若被强制 `tool_choice='none'`，会丢失工具可见性（provider 兼容缺陷）。
 * 本策略把「首轮 toolChoice=none → 保留 tool schema 可见 + effective='auto'」收敛为 provider 正确性处理。
 *
 * 职责边界（PCV observe-only 收敛 AP-1）：
 * - 这是 **provider 兼容正确性**，不是 grounding 质量门，也不随 groundingEnforcement 开关（PD1：默认保留、不回归）。
 * - 本模块**自持** tool-choice mode 计算；`PcvNodeEvidence` 仅**观察**其结果（effective vs requested），
 *   主循环不再「把决策写入 PCV burn 再读回」——消除 R4 读写往返耦合。
 * - 命名归位：本模块不带 `Pcv*` 前缀，与证据层概念分离。
 *
 * 行为对等：所有判定函数体均由 AgentRuntime / PcvNodeEvidence 原样迁出，AP-1 不改变任何对外行为。
 */

/** DeepSeek V4 analyze 首轮 tool-choice 决策（provider 正确性）。 */
export interface ProviderToolChoiceDecision {
  /** 是否在 requestedToolChoice=none 下仍保留 tool schema 可见（DeepSeek V4 首轮 provider 兼容）。 */
  keepToolSchemasVisible: boolean;
  /** provider 决策侧 tool-choice mode（供诊断日志；null=非首轮 / 不适用）。 */
  mode: string | null;
}

/**
 * 解析 DeepSeek V4 analyze 首轮 tool-choice provider 决策。
 * 行为对等迁出自 `AgentRuntime.buildDeepSeekV4AnalyzeGroundingPolicy`。
 */
export function resolveProviderToolChoice(
  ctx: LoopContext,
  modelRef: string,
  requestedToolChoice: string
): ProviderToolChoiceDecision {
  if (!isAnalyzeFirstBurnGuardEligible(ctx, modelRef)) {
    return { keepToolSchemasVisible: false, mode: null };
  }
  if (requestedToolChoice !== 'none') {
    return { keepToolSchemasVisible: false, mode: 'tool-choice-filtered-by-provider-guard' };
  }
  return {
    keepToolSchemasVisible: true,
    mode: 'tools-visible-no-forced-tool-choice',
  };
}

/**
 * PCV 观察用：由 effective vs requested toolChoice 归一化出 DeepSeek V4 tool-choice mode。
 * 行为对等迁出自 `PcvNodeEvidence.buildDeepSeekV4ToolChoiceMode`（含 isDeepSeekV4 门控，非 DeepSeek V4 → null）。
 * 计算源迁到本 provider 模块；`PcvNodeEvidence` 仅记录其结果，主循环抑制例外直接读本地结果（不回读 PCV burn）。
 */
export function observeForcedToolChoiceMode(
  modelRef: string | null | undefined,
  requestedToolChoice: string | null | undefined,
  effectiveToolChoice: string | null | undefined
): string | null {
  // P1-B-3：provider 判定收敛到 ModelQuirks(内核零 provider 名分支)。
  if (!resolveModelQuirks(modelRef).forcedToolChoiceUnsupported) {
    return null;
  }
  if (effectiveToolChoice === 'auto' && requestedToolChoice === 'none') {
    return 'tools-visible-no-forced-tool-choice';
  }
  if (effectiveToolChoice === 'none') {
    return 'schemas-hidden-no-tool-choice';
  }
  return 'tool-choice-filtered-by-provider-guard';
}

/**
 * 工具调用抑制的 DeepSeek V4 例外：当 provider policy 选择「首轮保留工具可见、不强制 tool_choice」时，
 * 即使 requestedToolChoice=none 也不抑制模型返回的工具调用（provider 正确性，避免误吞首轮取证调用）。
 */
export function allowsToolCallsUnderForcedNone(mode: string | null | undefined): boolean {
  return mode === 'tools-visible-no-forced-tool-choice';
}

/**
 * DeepSeek V4 analyze 首轮判定（analyst/analyze 下的 SCAN，或零证据的 EXPLORE）。
 * 行为对等迁出自 `AgentRuntime.isDeepSeekV4AnalyzeFirstGroundingBurn`；
 * analyze grounding gate（AP-2 领地）亦复用此首轮判定。
 */
export function isAnalyzeFirstBurnGuardEligible(ctx: LoopContext, modelRef: string): boolean {
  // P1-B-3：guard 适格由 ModelQuirks 声明(V4 家族)；phase 判定是 provider 中立的内核逻辑,保留。
  if (!resolveModelQuirks(modelRef).analyzeGroundingGuardEligible) {
    return false;
  }
  const trackerPhase = typeof ctx.tracker?.phase === 'string' ? ctx.tracker.phase : '';
  const pipelineType =
    typeof ctx.tracker?.pipelineType === 'string' ? ctx.tracker.pipelineType : '';
  const pipelinePhase = stringValue(ctx.context?.pipelinePhase) || '';
  if (pipelineType !== 'analyst' && pipelinePhase !== 'analyze') {
    return false;
  }
  if (trackerPhase === 'SCAN') {
    return true;
  }
  const metrics = safeCall<Record<string, unknown>>(() => ctx.tracker?.getMetrics?.());
  const evidenceToolCallCount = Number(metrics?.evidenceToolCallCount || 0);
  const memoryFindingCount = Number(metrics?.memoryFindingCount || 0);
  return trackerPhase === 'EXPLORE' && evidenceToolCallCount === 0 && memoryFindingCount === 0;
}

// ── module-private helpers（与 AgentRuntime 同形；本仓惯例为每模块自带小工具）─────────────
function safeCall<T>(fn: () => T | null | undefined): T | null {
  try {
    return fn() ?? null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
