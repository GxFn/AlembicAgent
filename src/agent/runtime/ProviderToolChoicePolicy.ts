import Logger from '@alembic/core/logging';
import { resolveModelQuirks } from '#ai/registry/ModelQuirks.js';

/** 兼容决策只观察阶段及指标；不取得预算、消息写口或整个循环状态。 */
export interface ProviderToolChoiceContext {
  readonly tracker?: {
    readonly phase?: unknown;
    readonly pipelineType?: unknown;
    getMetrics?(): Record<string, unknown> | null | undefined;
  } | null;
  readonly context?: Readonly<Record<string, unknown>>;
}

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
  ctx: ProviderToolChoiceContext,
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
 * I47：EXPLORE 下 tracker.getMetrics 抛错时判为不适格并告警（旧实现按零证据放行且无日志）。
 */
export function isAnalyzeFirstBurnGuardEligible(
  ctx: ProviderToolChoiceContext,
  modelRef: string
): boolean {
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
  // 只有 EXPLORE 需要看指标；其它阶段结论与指标无关，不再调用 tracker.getMetrics。
  if (trackerPhase !== 'EXPLORE') {
    return false;
  }
  const metricsRead = readTrackerMetrics(ctx);
  if (!metricsRead.ok) {
    // 保守降级：指标读不到时不能当成“零证据首轮”放行（那会在 requestedToolChoice=none 时
    // 把 schema 改为可见 + auto，并让 AnalyzeGroundingGuard 按首轮阻断）。判为不适格并告警，
    // 日志里带 modelRef / 阶段 / 错误原文，便于定位注入 tracker 的缺陷。
    Logger.getInstance().warn(
      '[ProviderToolChoicePolicy] tracker.getMetrics threw; analyze first-burn guard treated as ineligible',
      {
        modelRef,
        trackerPhase,
        pipelineType: pipelineType || null,
        pipelinePhase: pipelinePhase || null,
        error: metricsRead.error,
      }
    );
    return false;
  }
  const metrics = metricsRead.metrics;
  const evidenceToolCallCount = Number(metrics?.evidenceToolCallCount || 0);
  const memoryFindingCount = Number(metrics?.memoryFindingCount || 0);
  return evidenceToolCallCount === 0 && memoryFindingCount === 0;
}

// ── module-private helpers（本仓惯例为每模块自带小工具）─────────────

/** 诊断里错误原文的展示上限。 */
const MAX_METRICS_ERROR_CHARS = 200;

type TrackerMetricsRead =
  | { ok: true; metrics: Record<string, unknown> | null }
  | { ok: false; error: string };

/** 读取 tracker 指标；区分“没有指标”（ok + null）与“读取抛错”（ok=false + 错误原文）。 */
function readTrackerMetrics(ctx: ProviderToolChoiceContext): TrackerMetricsRead {
  try {
    return { ok: true, metrics: ctx.tracker?.getMetrics?.() ?? null };
  } catch (err: unknown) {
    return { ok: false, error: describeMetricsError(err) };
  }
}

function describeMetricsError(err: unknown): string {
  let text: string;
  if (err instanceof Error) {
    text = err.message || err.name;
  } else {
    try {
      text = String(err);
    } catch (stringifyErr: unknown) {
      text =
        stringifyErr instanceof Error
          ? `unprintable ${typeof err} (${stringifyErr.message})`
          : `unprintable ${typeof err}`;
    }
  }
  return text.length > MAX_METRICS_ERROR_CHARS
    ? `${text.slice(0, MAX_METRICS_ERROR_CHARS)}…`
    : text;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
