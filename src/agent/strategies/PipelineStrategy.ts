/**
 * PipelineStrategy — 顺序多阶段执行策略
 *
 * 从 strategies.js 提取的独立模块。
 * 每个阶段可以有不同的 Capability 和 Budget，
 * 阶段间可插入质量门控 (Quality Gate)。
 *
 * 等价于 Anthropic 的 "Prompt Chaining" + "Evaluator-Optimizer"。
 *
 * 增强特性 (v3):
 *   - Gate 支持自定义 evaluator 函数 (三态: pass/retry/degrade)
 *   - Gate retry: 失败时回退重新执行前一阶段
 *   - Stage 支持 promptBuilder(context), systemPrompt, onToolCall
 *   - Per-stage 硬超时保护
 *   - 阶段隔离 (ContextWindow/ExplorationTracker 状态)
 *
 * @module PipelineStrategy
 */

import { DIMENSION_COMPLETION_FLOOR } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import { runOperation } from '#shared/operation.js';
import { ExplorationTracker } from '../context/ExplorationTracker.js';
import type { PipelineType } from '../context/exploration/ExplorationStrategies.js';
import {
  createStrictAnalysisEpochSnapshotV1,
  createStrictTypedGateReturnV1,
  type StrictAnalysisContextProjectionV1,
  type StrictAnalysisEpochTransitionV1,
  validateStrictStageToolCallsV1,
} from '../production/StrictProductionPipeline.js';
import { buildRecordRepairPrompt, buildSummaryRewritePrompt } from '../prompts/insightGate.js';
import { AgentEventBus, AgentEvents } from '../runtime/AgentEventBus.js';
import type { AgentMessage } from '../runtime/AgentMessage.js';
import { DiagnosticsCollector } from '../runtime/DiagnosticsCollector.js';
import { expandSystemRunContext } from '../runtime/SystemRunContext.js';
import { runStageAttempt, type StageAttemptScope } from './pipeline/attempt.js';
import type { PipelineRuntime, StageResult } from './pipeline/contracts.js';
import { Strategy } from './Strategy.js';

// ───── Local Types for PipelineStrategy ──────────────────

/** Budget configuration for a pipeline stage */
interface StageBudget {
  maxIterations?: number;
  timeoutMs?: number;
  [key: string]: unknown;
}

/** Capability reference: plain string name or object with a name property */
type CapabilityRef = string | { name: string; [key: string]: unknown };

/** Quality Gate configuration */
interface GateConfig {
  evaluator?: (
    source: unknown,
    phaseResults: Record<string, unknown>,
    strategyContext: Record<string, unknown>
  ) =>
    | { action?: string; pass?: boolean; reason?: string; artifact?: unknown }
    | Promise<{ action?: string; pass?: boolean; reason?: string; artifact?: unknown }>;
  maxRetries?: number;
  maxRecordRepairRetries?: number;
  recordRepairMinFindings?: number;
  recordRepairMaxRounds?: number;
  recordRepairTimeoutMs?: number;
  recordRepairMaxTokens?: number;
  /** summary_rewrite(纯写作重组)配置：与 record_repair 同一微阶段范式 */
  maxSummaryRewriteRetries?: number;
  summaryRewriteTimeoutMs?: number;
  summaryRewriteMaxTokens?: number;
  useCumulativeToolCalls?: boolean;
  minEvidenceLength?: number;
  minFileRefs?: number;
  minToolCalls?: number;
  custom?: (source: Record<string, unknown>) => { pass: boolean; reason?: string };
  /** 严格链非通过时的 Core typed return 所需 owner/resume 边界。 */
  strictGate?: {
    gate: 'G1' | 'ADMISSION' | 'G2' | 'G3' | 'G4' | 'DURABLE' | 'PUBLIC';
    reasonCode: string;
    owner: string;
    resumePoint: string;
    permittedMutation: string;
    semanticRepairDepth?: number;
    passReasonCode?: string;
    retryMode?: 'strict-analysis-epoch';
  };
  [key: string]: unknown;
}

/** Pipeline stage definition */
interface PipelineStage {
  name: string;
  /** Strict runs must carry an immutable role marker from the strict stage factory. */
  strictRoleSurface?: 'strict-analyst-v1' | 'strict-producer-v1';
  gate?: GateConfig;
  capabilities?: CapabilityRef[];
  additionalTools?: string[];
  promptBuilder?: (ctx: Record<string, unknown>) => Promise<string> | string;
  retryPromptBuilder?: (
    retryCtx: { reason?: string; artifact?: unknown },
    content: string,
    phaseResults: Record<string, unknown>
  ) => string;
  promptTransform?: (content: string, phaseResults: Record<string, unknown>) => string;
  systemPrompt?: string;
  onToolCall?: (...args: unknown[]) => unknown;
  budget?: StageBudget;
  retryBudget?: StageBudget;
  skipOnDegrade?: boolean;
  skipOnFail?: boolean;
  submitToolName?: string;
  decisionOnlyOnRetry?: boolean;
  recordRepairOnly?: boolean;
  disableTracker?: boolean;
  toolChoiceOverride?: string;
  recordRepairEvidencePaths?: string[];
  /** 管线类型标识 — 传递至 ExplorationTracker 用于统一场景判别 */
  pipelineType?: PipelineType;
  source?: string;
  [key: string]: unknown;
}

/** Pipeline execution context (internal mutable state passed between stages) */
interface PipelineContext {
  phaseResults: Record<string, unknown>;
  strategyContext: Record<string, unknown>;
  totalToolCalls: Array<Record<string, unknown>>;
  totalTokenUsage: { input: number; output: number };
  totalIterations: number;
  gateArtifact: unknown;
  degraded: boolean;
  diagnostics: DiagnosticsCollector;
  execStageCount: number;
  lastExecutedStageName: string | null;
  /**
   * P0-4(挖掘质量升级)：degrade 的一等化信息。此前 degrade 只置布尔+日志，弱维度
   * 静默产 0 候选，父 run/调用方拿不到"哪个门、什么动作、什么原因"——这里在
   * #storeGateResult 单点捕获首个 degrade 类动作(degrade / degraded_no_findings /
   * degraded_budget_exhausted，均为终态)，最终投影进 phases._pipelineOutcome。
   */
  abandonInfo: { stage: string; action: string; reason: string } | null;
  /**
   * P1-A F2：第三种静默归零形态——analysis_retry 耗尽后 break(不设 degraded)此前产出
   * `completed + 0 候选`且无原因留痕。此标记让 outcome 如实报 abandoned(action='retry_exhausted')，
   * 而 degraded 布尔保持原语义不动(不触发 skipOnDegrade 等既有分支)。
   */
  retryExhausted: boolean;
  /** 严格链失败不是可降级成功，也不沿用 legacy abandoned 语义。 */
  strictFailed: boolean;
  /** 父信号或阶段主动停止都终止本管线；诊断只投影原因，不反向控制流程。 */
  cancelled: boolean;
}

interface GateEvalResult {
  action: string;
  pass: boolean;
  reason?: string;
  artifact?: unknown;
}

function producerStructuredFindingTarget(artifact: unknown): number {
  if (!artifact || typeof artifact !== 'object') {
    return 0;
  }
  const findings = (artifact as { findings?: unknown }).findings;
  return Array.isArray(findings) ? findings.length : 0;
}

function withProducerCoverageBudget(
  stage: PipelineStage,
  budget: StageBudget | undefined,
  gateArtifact: unknown,
  strictProduction: boolean
): StageBudget | undefined {
  if (stage.name !== 'produce' && stage.name !== 'producer') {
    return budget;
  }
  if (strictProduction) {
    return budget;
  }
  const targetSubmits = producerStructuredFindingTarget(gateArtifact);
  if (targetSubmits <= 0) {
    return budget;
  }
  // H3(2026-07-02 数量专项)：maxSubmits 随 findings 放大——静态 10 会把丰富维度硬顶
  // (真机 findings=24 只能提 10)。放大到 findings+4(拒绝重试余量)，原值作下限。
  const baseMaxSubmits = Number((budget as { maxSubmits?: unknown } | undefined)?.maxSubmits) || 10;
  const scaledMaxSubmits = Math.max(baseMaxSubmits, targetSubmits + 4);
  // P-5：produce 时间预算随目标提交数放大——真机 DeepSeek 每轮提交(长 reasoning+payload)
  // 60-90s，静态 900s 只够约 10 轮；目标更高时时间不放大等于数量白给。90s/轮估算，
  // 下限保持原值、上限 1800s 防失控。
  const baseTimeoutMs = Number((budget as { timeoutMs?: unknown } | undefined)?.timeoutMs) || 0;
  const scaledTimeoutMs =
    baseTimeoutMs > 0
      ? Math.min(1_800_000, Math.max(baseTimeoutMs, scaledMaxSubmits * 90_000))
      : baseTimeoutMs;
  return {
    ...(budget || {}),
    targetSubmits,
    maxSubmits: scaledMaxSubmits,
    ...(scaledTimeoutMs > 0 ? { timeoutMs: scaledTimeoutMs } : {}),
  };
}

/**
 * P0-4：读取 knowledge.submit 修复层的会话命中计数。计数宿主是 sharedState._sessionCounters
 * 嵌套盒(handler 侧 sessionCounterBox 写入)——不能挂 runtime：ToolExecutionPipeline 给
 * handler 的 ctx.runtime 是每次调用现造的一次性投影,写上去即弃(门0 真跑实测假零后根修)；
 * 嵌套盒同时对阶段级 sharedState 浅拷贝免疫(拷贝保留盒引用)。这里只做防御性读取——
 * 形状不对/为空一律返回 null(不投影)，绝不让观测面影响执行。
 */
function readSubmitRepairStats(sharedState: unknown): Record<string, number> | null {
  if (!sharedState || typeof sharedState !== 'object') {
    return null;
  }
  const box = (sharedState as Record<string, unknown>)._sessionCounters;
  if (!box || typeof box !== 'object' || Array.isArray(box)) {
    return null;
  }
  const raw = (box as Record<string, unknown>).submitRepairStats;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function readRecipeReadinessReports(sharedState: unknown): Array<Record<string, unknown>> | null {
  if (!sharedState || typeof sharedState !== 'object') {
    return null;
  }
  const box = (sharedState as Record<string, unknown>)._sessionCounters;
  if (!box || typeof box !== 'object' || Array.isArray(box)) {
    return null;
  }
  const reports = (box as Record<string, unknown>).recipeReadinessReports;
  if (!Array.isArray(reports)) {
    return null;
  }
  const valid = reports.filter(
    (report): report is Record<string, unknown> =>
      !!report && typeof report === 'object' && !Array.isArray(report)
  );
  return valid.length > 0 ? valid : null;
}

/** Lightweight ContextWindow subset consumed by pipeline stages */
interface StageContextWindow {
  resetForNewStage(): void;
  tokenCount?: number;
  [key: string]: unknown;
}

// AD4: lazy logger accessor — the Core logger singleton materializes on first
// use instead of at module import (no import-time work; same singleton).
const _pipelineLogger = () => Logger.getInstance();

export class PipelineStrategy extends Strategy {
  #stages: PipelineStage[];

  /** 最大重试次数 (Gate 失败时全局兜底) */
  #maxRetries;

  constructor({
    stages = [],
    maxRetries = 1,
  }: { stages?: PipelineStage[]; maxRetries?: number } = {}) {
    super();
    this.#stages = stages;
    this.#maxRetries = maxRetries;
  }

  get name() {
    return 'pipeline';
  }

  async execute(
    runtime: PipelineRuntime,
    message: AgentMessage,
    opts: Record<string, unknown> = {}
  ) {
    const bus = AgentEventBus.getInstance();
    const rawStrategyContext = {
      ...(opts.systemRunContext ? { systemRunContext: opts.systemRunContext } : {}),
      ...((opts.strategyContext || {}) as Record<string, unknown>),
    };
    // AgentService 会把资源平铺到 RuntimeOptions；只接收这五项，不把 budget 等运行控制
    // 混入 prompt context。既有 system/显式 strategy 投影优先，资源本身保持原引用。
    const flatResources = Object.fromEntries(
      ['contextWindow', 'trace', 'memoryCoordinator', 'sharedState', 'source']
        .filter((key) => opts[key] !== undefined)
        .map((key) => [key, opts[key]])
    );
    const incomingStrategyContext = {
      ...flatResources,
      ...expandSystemRunContext(rawStrategyContext),
    };
    _pipelineLogger().debug('[PipelineStrategy] Context resource projection', {
      flatDefaults: Object.keys(flatResources),
      precedence: 'flat-defaults < system-context < explicit-strategy-context',
    });
    const diagnostics = DiagnosticsCollector.from(
      opts.diagnostics || incomingStrategyContext.diagnostics
    );
    const ctx: PipelineContext = {
      phaseResults: {} as Record<string, unknown>,
      strategyContext: {
        ...incomingStrategyContext,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
        diagnostics,
      },
      totalToolCalls: [] as Array<Record<string, unknown>>,
      totalTokenUsage: { input: 0, output: 0 },
      totalIterations: 0,
      gateArtifact: null,
      degraded: false,
      diagnostics,
      execStageCount: 0,
      lastExecutedStageName: null,
      abandonInfo: null,
      retryExhausted: false,
      strictFailed: false,
      cancelled: false,
    };

    // 会话计数盒预建：必须在任何阶段对 sharedState 做浅拷贝之前把嵌套盒挂上——
    // handler 侧经 ToolExecutionPipeline 每次调用一次性 runtime 投影里的 sharedState 引用
    // 写入同一个盒(修复层计量/waiver 上限/拒绝止损三族计数)，收尾投影从盒读取。
    // 无 sharedState 的宿主保持原静默不计语义。
    const baseSharedStateForCounters = ctx.strategyContext.sharedState as
      | Record<string, unknown>
      | null
      | undefined;
    if (
      baseSharedStateForCounters &&
      typeof baseSharedStateForCounters === 'object' &&
      !baseSharedStateForCounters._sessionCounters
    ) {
      baseSharedStateForCounters._sessionCounters = {};
    }

    let lastMainStageName: string | null = null;
    for (let i = 0; i < this.#stages.length; i++) {
      if (this.#isCancelled(ctx)) {
        this.#recordCancellation(ctx);
        break;
      }
      const stage = this.#stages[i];

      // ── Quality Gate 阶段 ──
      if (stage.gate) {
        if (ctx.degraded) {
          continue;
        }
        const gateAction = await this.#processGate(runtime, message, stage, i, ctx, bus);
        if (gateAction === 'break') {
          break;
        }
        if (gateAction === 'continue') {
          continue;
        }
        if (typeof gateAction === 'number') {
          i = gateAction; // retry: jump back
          continue;
        }
        break; // unknown action fallback
      }

      // ── 执行阶段 ──
      if (ctx.degraded && stage.skipOnDegrade !== false) {
        continue;
      }

      await this.#executeStage(runtime, message, stage, ctx, bus);
      lastMainStageName = stage.name;
    }

    // 最终回复 = 最后一个执行阶段的输出
    // phaseResults 同时保存修复微阶段；覆写已有键不会改变插入顺序，不能据此猜最后主阶段。
    const lastStage = lastMainStageName
      ? (ctx.phaseResults[lastMainStageName] as StageResult | undefined)
      : undefined;

    // P0-4：管线结局一等化。phases 会原样穿透 AgentRuntime.execute → AgentRunResult.phases
    // → coordinator child result → merger，因此 _pipelineOutcome 是父 run 聚合
    // abandonedModules 的唯一读取面(下划线内部键与 _retries_/_retryContext 同一先例)。
    // submitRepairs 是 knowledge.submit 各确定性修复层的会话命中计数(宿主=sharedState 的
    // _sessionCounters 嵌套盒,见 readSubmitRepairStats 注释)——在此投影，
    // 评估 harness 据此算 repair-hit-rate。
    const submitRepairs = readSubmitRepairStats(ctx.strategyContext.sharedState);
    const recipeReadiness = readRecipeReadinessReports(ctx.strategyContext.sharedState);
    // F2：abandoned 覆盖 degrade 族 + retry_exhausted 两类放弃；degraded 布尔语义不变。
    const abandoned = ctx.degraded || ctx.retryExhausted;
    const aborted = this.#isCancelled(ctx);
    if (aborted) {
      this.#recordCancellation(ctx);
    }
    const outcome = aborted
      ? 'aborted'
      : ctx.strictFailed
        ? 'failed'
        : abandoned
          ? 'abandoned'
          : 'completed';
    ctx.phaseResults._pipelineOutcome = {
      outcome,
      ...(abandoned && ctx.abandonInfo ? ctx.abandonInfo : {}),
      ...(submitRepairs ? { submitRepairs } : {}),
      ...(recipeReadiness ? { recipeReadiness } : {}),
    };

    return {
      reply: lastStage?.reply || '',
      toolCalls: ctx.totalToolCalls,
      tokenUsage: ctx.totalTokenUsage,
      iterations: ctx.totalIterations,
      phases: ctx.phaseResults,
      degraded: ctx.degraded,
      outcome,
      diagnostics: ctx.diagnostics.toJSON(),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // Private: Gate 处理
  // ═══════════════════════════════════════════════════════════

  /**
   * 处理 Quality Gate 阶段
   *
   * @returns break/continue 或 retry 回退索引 (i-1)
   */
  async #processGate(
    runtime: PipelineRuntime,
    message: AgentMessage,
    stage: PipelineStage,
    stageIndex: number,
    ctx: PipelineContext,
    bus: AgentEventBus
  ) {
    const { phaseResults } = ctx;
    if (!stage.gate) {
      return 'continue';
    }
    const gate = stage.gate;
    let gateResult = await this.#evaluateGateResult(stage, ctx, bus);
    if (this.#isCancelled(ctx)) {
      return 'break';
    }
    this.#storeGateResult(stage, gateResult, ctx, bus);
    const strictContext = this.#strictProductionContext(ctx);
    const strictAnalysisRetryEnabled =
      Boolean(strictContext) && gate.strictGate?.retryMode === 'strict-analysis-epoch';

    // 三态处理
    if (gateResult.action === 'pass') {
      if (strictAnalysisRetryEnabled) {
        const transition = this.#readStrictAnalysisTransition(gateResult, 'pass');
        this.#appendStrictAnalysisLoopReceipt(ctx, transition);
        // Gate artifact 保留 transition 供审计；Producer 仍消费既有 analysisArtifact 语义，
        // 避免把控制回执误当成 authored input。
        ctx.gateArtifact = transition.resultArtifact;
      }
      if (strictContext && gate.strictGate?.passReasonCode) {
        this.#appendStrictGateReturn(
          ctx,
          createStrictTypedGateReturnV1({
            gate: gate.strictGate.gate,
            verdict: 'pass',
            reasonCode: gate.strictGate.passReasonCode,
          })
        );
      }
      return 'continue';
    }

    // 严格冷启动在第一个非通过门立即失败关闭。legacy repair/degrade/skip 逻辑均不得接管，
    // 否则 Producer 会消费未达到 fixpoint 或已漂移的结果。
    if (strictContext) {
      const strictGate = gate.strictGate;
      if (!strictGate) {
        throw new Error(`STRICT_GATE_CONFIG_REQUIRED: ${stage.name || 'gate'}`);
      }
      if (gateResult.action === 'analysis_retry' && strictAnalysisRetryEnabled) {
        const transition = this.#readStrictAnalysisTransition(gateResult, 'analysis_retry');
        this.#appendStrictAnalysisLoopReceipt(ctx, transition);
        const previousStageIndex = this.#findPrevExecStageIdx(stageIndex);
        const retryStage = this.#stages[previousStageIndex];
        if (
          previousStageIndex < 0 ||
          retryStage?.name !== 'analyze' ||
          retryStage.strictRoleSurface !== 'strict-analyst-v1'
        ) {
          throw new Error('STRICT_ANALYSIS_RETRY_TARGET_INVALID');
        }
        phaseResults._retryContext = {
          reason: gateResult.reason,
          artifact: transition,
        };
        phaseResults._strictAnalysisRetryCount =
          Number(phaseResults._strictAnalysisRetryCount || 0) + 1;
        phaseResults[`_was_retry_${retryStage.name}`] = true;
        return previousStageIndex - 1;
      }
      if (
        gateResult.artifact &&
        typeof gateResult.artifact === 'object' &&
        !Array.isArray(gateResult.artifact) &&
        (gateResult.artifact as { kind?: unknown }).kind === 'StrictAnalysisEpochTransitionV1'
      ) {
        this.#appendStrictAnalysisLoopReceipt(
          ctx,
          gateResult.artifact as StrictAnalysisEpochTransitionV1
        );
      }
      const { passReasonCode: _passReasonCode, retryMode: _retryMode, ...failureGate } = strictGate;
      const typedReturn = createStrictTypedGateReturnV1({
        ...failureGate,
        verdict: 'failed',
      });
      this.#appendStrictGateReturn(ctx, typedReturn);
      ctx.strictFailed = true;
      return 'break';
    }

    if (gateResult.action === 'degrade') {
      ctx.degraded = true;
      ctx.diagnostics.markDegraded();
      return 'break';
    }

    if (gateResult.action === 'record_repair') {
      const repairKey = `_recordRepairRetries_${stage.name || 'gate'}`;
      phaseResults[repairKey] = ((phaseResults[repairKey] as number) || 0) + 1;
      const maxRecordRepairRetries = gate.maxRecordRepairRetries ?? 1;

      if ((phaseResults[repairKey] as number) <= maxRecordRepairRetries) {
        const repairResult = await this.#runRecordRepairStage(
          runtime,
          message,
          stage,
          gateResult,
          ctx,
          bus
        );
        if (this.#isCancelled(ctx)) {
          return 'break';
        }
        phaseResults._recordRepairToolWritten = this.#stageHasNoteFindingCall(repairResult);

        gateResult = await this.#evaluateGateResult(stage, ctx, bus);
        if (this.#isCancelled(ctx)) {
          return 'break';
        }
        this.#storeGateResult(stage, gateResult, ctx, bus);
        if (gateResult.action === 'pass') {
          return 'continue';
        }
      }

      // 记录补写仍未满足门控时，宁可显式降级也不能让 Producer 基于缺失证据继续提交。
      const failureReason =
        gateResult.reason || 'Record repair did not produce enough validated note_finding records';
      const degradedGate: GateEvalResult = {
        action: 'degraded_no_findings',
        pass: false,
        reason: failureReason,
        artifact: gateResult.artifact,
      };
      this.#storeGateResult(stage, degradedGate, ctx, bus);
      ctx.degraded = true;
      ctx.diagnostics.markDegraded();
      return 'break';
    }

    if (gateResult.action === 'summary_rewrite') {
      // 写作类失败(文本短/缺结构/缺接地深度断言)且证据面已达标：不重跑整段 analyze
      // (最贵路径)，改用零工具单调用把 memory 里的已验证发现重组成合格分析文本。
      // 产出只替换 reply——toolCalls 等证据面保持原样(重写不产生新证据)。
      const rewriteKey = `_summaryRewriteRetries_${stage.name || 'gate'}`;
      phaseResults[rewriteKey] = ((phaseResults[rewriteKey] as number) || 0) + 1;
      const maxRewrites = gate.maxSummaryRewriteRetries ?? 1;

      if ((phaseResults[rewriteKey] as number) <= maxRewrites) {
        const sourceName = (stage.source || this.#prevStageName(stage)) as string;
        const source = phaseResults[sourceName] as Record<string, unknown> | undefined;
        const rewriteResult = await this.#runSummaryRewriteStage(
          runtime,
          message,
          stage,
          gateResult,
          ctx,
          bus
        );
        if (this.#isCancelled(ctx)) {
          return 'break';
        }
        const newReply = typeof rewriteResult?.reply === 'string' ? rewriteResult.reply.trim() : '';
        if (source && newReply.length > 0) {
          phaseResults[sourceName] = { ...source, reply: newReply };
          gateResult = await this.#evaluateGateResult(stage, ctx, bus);
          if (this.#isCancelled(ctx)) {
            return 'break';
          }
          this.#storeGateResult(stage, gateResult, ctx, bus);
          if (gateResult.action === 'pass') {
            return 'continue';
          }
          if (gateResult.action === 'degrade') {
            ctx.degraded = true;
            ctx.diagnostics.markDegraded();
            return 'break';
          }
        } else {
          _pipelineLogger().info(
            `[PipelineStrategy] summary_rewrite produced no usable text for "${stage.name}" — falling back to analysis_retry`
          );
        }
      }
      // 重写没有救回来(或产出为空/再次判 rewrite)：转整段重挖路径，与 analysis_retry
      // 共享次数上限与预算压制判断，绝不在 rewrite 里无限打转。
      if (gateResult.action === 'summary_rewrite') {
        gateResult = { ...gateResult, action: 'analysis_retry' };
      }
    }

    if (gateResult.action === 'analysis_retry' || gateResult.action === 'retry') {
      const maxRetries = gate.maxRetries ?? this.#maxRetries;
      const retryKey = `_retries_${stage.name || 'gate'}`;
      phaseResults[retryKey] = ((phaseResults[retryKey] as number) || 0) + 1;

      if ((phaseResults[retryKey] as number) <= maxRetries) {
        const prevIdx = this.#findPrevExecStageIdx(stageIndex);
        if (prevIdx >= 0) {
          const retryTargetStage = this.#stages[prevIdx];
          const budgetSuppression = this.#getRetryBudgetSuppression(retryTargetStage, gate, ctx);
          if (budgetSuppression) {
            const degradedGate: GateEvalResult = {
              action: 'degraded_budget_exhausted',
              pass: false,
              reason: budgetSuppression.reason,
              artifact: gateResult.artifact,
            };
            this.#storeGateResult(stage, degradedGate, ctx, bus);
            ctx.degraded = true;
            ctx.diagnostics.markDegraded();
            return 'break';
          }
          phaseResults._retryContext = {
            reason: gateResult.reason,
            artifact: gateResult.artifact,
          };
          phaseResults[`_was_retry_${retryTargetStage.name}`] = true;
          return prevIdx - 1; // 循环 i++ 后回到 prevIdx
        }
      }
      // 重试次数耗尽 —— P1-A F2：此前静默 break(completed + 0 候选，无原因)；现在如实
      // 记为第三种放弃形态。不设 ctx.degraded(保持 skipOnDegrade 等既有分支语义不变)，
      // 只让 outcome/abandonedModules 观测面如实报 retry_exhausted。
      ctx.retryExhausted = true;
      if (!ctx.abandonInfo) {
        ctx.abandonInfo = {
          stage: stage.name || 'gate',
          action: 'retry_exhausted',
          reason: gateResult.reason || 'gate retries exhausted',
        };
      }
      if (stage.skipOnFail !== false) {
        return 'break';
      }
      return 'continue';
    }

    // 兜底: 未知 action
    if (stage.skipOnFail !== false) {
      return 'break';
    }
    return 'continue';
  }

  #getRetryBudgetSuppression(
    retryTargetStage: PipelineStage,
    gate: GateConfig,
    ctx: PipelineContext
  ): { reason: string } | null {
    const maxSessionInputTokens =
      numberFromUnknown(retryTargetStage.retryBudget?.maxSessionInputTokens) ??
      numberFromUnknown(retryTargetStage.budget?.maxSessionInputTokens);
    if (!maxSessionInputTokens || maxSessionInputTokens <= 0) {
      return null;
    }

    const threshold = numberFromUnknown(gate.retryBudgetExhaustedRatio) ?? 0.9;
    const ratio = ctx.totalTokenUsage.input / maxSessionInputTokens;
    if (ratio < threshold) {
      return null;
    }

    return {
      reason: `Analysis retry suppressed because session input budget is exhausted (${Math.round(
        ratio * 100
      )}% of maxSessionInputTokens=${maxSessionInputTokens}).`,
    };
  }

  async #evaluateGateResult(
    stage: PipelineStage,
    ctx: PipelineContext,
    bus: AgentEventBus
  ): Promise<GateEvalResult> {
    const { phaseResults, strategyContext } = ctx;
    const gate = stage.gate;
    if (!gate) {
      return { action: 'pass', pass: true };
    }
    const sourceName = (stage.source || this.#prevStageName(stage)) as string;
    const source = phaseResults[sourceName];

    if (typeof gate.evaluator === 'function') {
      this.#ensureGateActiveContext(stage, strategyContext, phaseResults, bus, ctx.diagnostics);
      const gateSource = gate.useCumulativeToolCalls
        ? this.#withCumulativeToolCalls(source, ctx)
        : source;
      const gateDiagnostics = new DiagnosticsCollector();
      const evaluation = await runOperation(
        (signal) =>
          gate.evaluator?.(gateSource, phaseResults, {
            ...strategyContext,
            abortSignal: signal,
            diagnostics: gateDiagnostics,
          }),
        { abortSignal: strategyContext.abortSignal as AbortSignal | undefined }
      );
      ctx.diagnostics.merge(gateDiagnostics.toJSON());
      if (evaluation.status === 'aborted') {
        ctx.cancelled = true;
        this.#recordCancellation(ctx);
        return { action: 'aborted', pass: false };
      }
      if (evaluation.status !== 'ok') {
        throw evaluation.error instanceof Error
          ? evaluation.error
          : new Error('Pipeline gate evaluation failed');
      }
      const evaluated = evaluation.value as GateEvalResult;
      return {
        ...evaluated,
        action: evaluated.action || (evaluated.pass ? 'pass' : 'analysis_retry'),
      };
    }

    // 向后兼容: 阈值评估
    const legacyResult = this.#evaluateGate(gate, phaseResults, sourceName);
    return {
      action: legacyResult.pass ? 'pass' : 'analysis_retry',
      pass: legacyResult.pass,
      reason: legacyResult.reason,
    };
  }

  #storeGateResult(
    stage: PipelineStage,
    gateResult: GateEvalResult,
    ctx: PipelineContext,
    bus: AgentEventBus
  ) {
    bus.publish(AgentEvents.PROGRESS, {
      type: 'quality_gate',
      pass: gateResult.action === 'pass',
      action: gateResult.action,
      reason: gateResult.reason,
      stage: stage.name || 'gate',
    });

    ctx.phaseResults[stage.name || 'gate'] = {
      pass: gateResult.action === 'pass',
      action: gateResult.action,
      reason: gateResult.reason || '',
      artifact: gateResult.artifact || null,
    };
    if (gateResult.artifact) {
      ctx.gateArtifact = gateResult.artifact;
    }

    if (gateResult.action !== 'pass') {
      ctx.diagnostics.recordGateFailure(stage.name || 'gate', gateResult.action, gateResult.reason);
    }

    // P0-4：degrade 类动作(degrade / degraded_no_findings / degraded_budget_exhausted)都是
    // 终态(存储后必然 ctx.degraded=true + break)，在此单点捕获首个即可覆盖全部 4 个降级点，
    // 不必在每个分支重复。只记首个：后续不会再有(终态)，防御性保留 first-wins 语义。
    if (
      !ctx.abandonInfo &&
      (gateResult.action === 'degrade' || gateResult.action.startsWith('degraded_'))
    ) {
      ctx.abandonInfo = {
        stage: stage.name || 'gate',
        action: gateResult.action,
        reason: gateResult.reason || '',
      };
    }
  }

  async #runRecordRepairStage(
    runtime: PipelineRuntime,
    message: AgentMessage,
    gateStage: PipelineStage,
    gateResult: GateEvalResult,
    ctx: PipelineContext,
    bus: AgentEventBus
  ) {
    const gate = gateStage.gate || {};
    // C-3：record_repair 的 findings 底线与两宿主完成阈值同源(Core 单源)。
    const minFindings = gate.recordRepairMinFindings ?? DIMENSION_COMPLETION_FLOOR.minKeyFindings;
    // 与 summary_rewrite 同型:微阶段不干扰外层 stage 隔离判定(快照恢复)。
    const lastStageSnapshot = ctx.lastExecutedStageName;
    const repairStage: PipelineStage = {
      name: `${gateStage.name || 'quality_gate'}_record_repair`,
      capabilities: [],
      additionalTools: ['memory', 'evidence'],
      budget: {
        maxIterations: gate.recordRepairMaxRounds ?? 3,
        timeoutMs: gate.recordRepairTimeoutMs ?? 90_000,
        maxTokens: gate.recordRepairMaxTokens ?? 2048,
        temperature: 0.2,
        maxSessionInputTokens: 12_000,
        maxSessionTokens: 16_000,
      },
      disableTracker: true,
      recordRepairOnly: true,
      toolChoiceOverride: 'auto',
      recordRepairEvidencePaths: this.#extractRecordRepairEvidencePaths(gateResult.artifact),
      systemPrompt:
        'You are in a record-only repair stage. Do not explore. Retrieve already captured evidence with evidence.get/search, then use note_finding with evidenceRefs to record verified findings.',
      promptBuilder: () =>
        buildRecordRepairPrompt({
          reason: gateResult.reason || '',
          artifact: gateResult.artifact,
          minFindings,
        }),
    };

    try {
      return await this.#executeStage(runtime, message, repairStage, ctx, bus);
    } finally {
      ctx.lastExecutedStageName = lastStageSnapshot;
    }
  }

  /**
   * summary_rewrite 微阶段：与 record_repair 同一范式(小预算、disableTracker、inline 重评)，
   * 但更进一步——零工具纯写作。LLM 拿着 artifact 里的已验证发现重组分析文本，
   * 产出经调用方写回 analyze 阶段的 reply 后重评。成本≈一次 chat 调用。
   */
  async #runSummaryRewriteStage(
    runtime: PipelineRuntime,
    message: AgentMessage,
    gateStage: PipelineStage,
    gateResult: GateEvalResult,
    ctx: PipelineContext,
    bus: AgentEventBus
  ) {
    const gate = gateStage.gate || {};
    // 微阶段对「阶段隔离」透明:#executeStage 会把 ctx.lastExecutedStageName 写成微阶段名,
    // 若之后 rewrite 失败转 analysis_retry,analyze 重跑会被误判 isNewStage 而 reset
    // ContextWindow——旧 retry 路径的「♻️ preserving」保留机制被击穿(审计缺陷①)。
    // 快照恢复使微阶段不干扰外层 stage 的隔离判定;record_repair 同型处理。
    const lastStageSnapshot = ctx.lastExecutedStageName;
    const rewriteStage: PipelineStage = {
      name: `${gateStage.name || 'quality_gate'}_summary_rewrite`,
      capabilities: [],
      additionalTools: [],
      budget: {
        maxIterations: 1,
        timeoutMs: (gate.summaryRewriteTimeoutMs as number | undefined) ?? 120_000,
        maxTokens: (gate.summaryRewriteMaxTokens as number | undefined) ?? 4096,
        temperature: 0.3,
        maxSessionInputTokens: 24_000,
        maxSessionTokens: 30_000,
      },
      disableTracker: true,
      systemPrompt:
        'You are in a summary-rewrite stage. Do not explore or call tools. Rewrite the analysis text using only the verified findings provided in the prompt.',
      promptBuilder: () =>
        buildSummaryRewritePrompt({
          reason: gateResult.reason || '',
          artifact: gateResult.artifact as Record<string, unknown> | null,
        }),
    };

    try {
      return await this.#executeStage(runtime, message, rewriteStage, ctx, bus);
    } finally {
      ctx.lastExecutedStageName = lastStageSnapshot;
    }
  }

  #stageHasNoteFindingCall(stageResult: StageResult) {
    return (stageResult.toolCalls || []).some((call) => {
      const args = (call.args || call.params || {}) as Record<string, unknown>;
      const toolName = String(call.tool || call.name || '');
      const isNoteFinding =
        toolName === 'note_finding' ||
        (toolName === 'memory' && String(args.action || '') === 'note_finding');
      if (!isNoteFinding) {
        return false;
      }
      return this.#isSuccessfulNoteFindingResult(call.result || call.structuredContent);
    });
  }

  #isSuccessfulNoteFindingResult(result: unknown) {
    if (typeof result === 'string') {
      return !result.startsWith('⚠');
    }
    if (!result || typeof result !== 'object') {
      return false;
    }
    const record = result as Record<string, unknown>;
    return record.recorded === true && record.target === 'activeContext';
  }

  #extractRecordRepairEvidencePaths(artifact: unknown) {
    const paths = new Set<string>();
    const record = artifact as
      | {
          referencedFiles?: unknown;
          evidenceMap?: unknown;
          findings?: Array<{ evidence?: unknown }>;
        }
      | null
      | undefined;
    if (Array.isArray(record?.referencedFiles)) {
      for (const path of record.referencedFiles) {
        if (typeof path === 'string' && path.trim()) {
          paths.add(path.trim());
        }
      }
    }
    if (record?.evidenceMap instanceof Map) {
      for (const path of record.evidenceMap.keys()) {
        if (typeof path === 'string' && path.trim()) {
          paths.add(path.trim());
        }
      }
    } else if (record?.evidenceMap && typeof record.evidenceMap === 'object') {
      for (const path of Object.keys(record.evidenceMap)) {
        paths.add(path);
      }
    }
    if (Array.isArray(record?.findings)) {
      for (const finding of record.findings) {
        const evidence =
          typeof finding.evidence === 'string'
            ? finding.evidence
            : Array.isArray(finding.evidence)
              ? finding.evidence.join(', ')
              : '';
        for (const match of evidence.match(/[\w/.-]+\.[A-Za-z0-9]+/g) || []) {
          paths.add(match);
        }
      }
    }
    return [...paths];
  }

  #ensureGateActiveContext(
    stage: PipelineStage,
    strategyContext: Record<string, unknown>,
    phaseResults: Record<string, unknown>,
    bus: AgentEventBus,
    diagnostics: DiagnosticsCollector
  ) {
    if (!stage.name?.includes('quality') || strategyContext.activeContext) {
      return;
    }

    const warning = strategyContext.trace
      ? 'quality gate missing activeContext; aliased strategyContext.trace to activeContext'
      : 'quality gate missing activeContext and trace; evaluator may fall back to text-only analysis';
    if (strategyContext.trace) {
      strategyContext.activeContext = strategyContext.trace;
    }
    diagnostics.warn({ code: 'pipeline_context_warning', message: warning, stage: stage.name });

    const phaseDiagnostics = (phaseResults._diagnostics || {}) as { warnings?: unknown[] };
    phaseResults._diagnostics = {
      ...phaseDiagnostics,
      warnings: [
        ...(Array.isArray(phaseDiagnostics.warnings) ? phaseDiagnostics.warnings : []),
        { stage: stage.name, warning },
      ],
    };
    bus.publish(AgentEvents.PROGRESS, {
      type: 'pipeline_context_warning',
      stage: stage.name,
      warning,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Private: Stage 执行
  // ═══════════════════════════════════════════════════════════

  /** 执行单个 Pipeline 阶段 */
  async #executeStage(
    runtime: PipelineRuntime,
    message: AgentMessage,
    stage: PipelineStage,
    ctx: PipelineContext,
    bus: AgentEventBus
  ) {
    const { phaseResults, strategyContext } = ctx;

    this.#validateStrictRoleRoute(stage, ctx);

    bus.publish(AgentEvents.PROGRESS, {
      type: 'pipeline_stage_start',
      stage: stage.name,
      capabilities: stage.capabilities?.map((c: CapabilityRef) =>
        typeof c === 'string' ? c : c.name
      ),
    });

    // 在准备前捕获预算；异步 promptBuilder 不能为同一次 attempt 延长或替换期限。
    const isRetry = !!phaseResults[`_was_retry_${stage.name}`];
    const decisionOnly = isRetry && stage.decisionOnlyOnRetry === true;
    const computedBudget = (strategyContext._computedBudget || null) as StageBudget | null;
    const configuredBudget =
      isRetry && stage.retryBudget
        ? stage.retryBudget
        : stage.budget || computedBudget || undefined;
    const strictProduction = Boolean(this.#strictProductionContext(ctx));
    const effectiveBudget = withProducerCoverageBudget(
      stage,
      configuredBudget ? { ...configuredBudget } : undefined,
      ctx.gateArtifact,
      strictProduction
    );
    const retryBudget = stage.retryBudget ? { ...stage.retryBudget } : undefined;
    delete phaseResults[`_was_retry_${stage.name}`];
    const ctxWin = (strategyContext.contextWindow || null) as StageContextWindow | null;
    let stagePrompt = '';

    const executeAttempt = async (budget: StageBudget | undefined, fastRetry: boolean) => {
      const timeoutMs = budget?.timeoutMs;
      const attempt = await runStageAttempt(
        runtime,
        {
          stage: stage.name,
          abortSignal: strategyContext.abortSignal as AbortSignal | undefined,
          // 保留原来的 forced-summary 60s 缓冲，但准备与执行只共享这一份期限。
          ...(timeoutMs ? { timeoutMs: timeoutMs + 60_000 } : {}),
          diagnostics: ctx.diagnostics,
          onToolCall: stage.onToolCall,
        },
        async (scope) => {
          const attemptContext = {
            ...strategyContext,
            abortSignal: scope.signal,
            diagnostics: scope.diagnostics,
          };
          const prompt = fastRetry
            ? stage.retryPromptBuilder
              ? stage.retryPromptBuilder(
                  { reason: 'Stage hard timeout with 0 tool calls', artifact: null },
                  message.content,
                  phaseResults
                )
              : stagePrompt
            : await this.#buildStagePrompt(stage, message, phaseResults, attemptContext, ctx);
          // 不合作的准备任务即使晚到，也不能重置上下文或启动一次新的工具循环。
          if (scope.signal.aborted) {
            return { reply: '', toolCalls: [], iterations: 0, tokenUsage: { input: 0, output: 0 } };
          }
          if (!fastRetry) {
            stagePrompt = prompt;
          }
          const isNewStage = ctx.lastExecutedStageName !== stage.name;
          if (ctxWin && (fastRetry || (ctx.execStageCount > 0 && isNewStage))) {
            ctxWin.resetForNewStage();
          } else if (ctxWin && ctx.execStageCount > 0) {
            _pipelineLogger().info(
              `[PipelineStrategy] Retry stage "${stage.name}" — preserving ContextWindow (${ctxWin.tokenCount || 0} tokens)`
            );
          }
          const tracker = this.#resolveStageTracker(stage, ctx, attemptContext, budget);
          if (!fastRetry) {
            ctx.lastExecutedStageName = stage.name;
            ctx.execStageCount++;
          }
          _pipelineLogger().info(
            `[PipelineStrategy] Stage "${stage.name}"${fastRetry || isRetry ? ' (retry)' : ''} — budget: ${budget?.maxIterations || '∞'} iters, timeout: ${budget?.timeoutMs || '∞'}ms`
          );
          return this.#runPreparedStage(
            prompt,
            message,
            stage,
            budget,
            ctxWin,
            tracker,
            attemptContext,
            phaseResults,
            decisionOnly,
            scope
          );
        }
      );
      ctx.cancelled ||= attempt.result.aborted === true;
      this.#accumulateStageAttempt(ctx, attempt.result);
      if (attempt.status === 'error') {
        throw attempt.error instanceof Error
          ? attempt.error
          : new Error(String(attempt.error || 'Pipeline stage failed'));
      }
      if (attempt.result.timedOut) {
        bus.publish(AgentEvents.PROGRESS, {
          type: 'pipeline_stage_timeout',
          stage: stage.name,
          timeoutMs: timeoutMs ? timeoutMs + 60_000 : null,
        });
      }
      return attempt;
    };

    let attempt = await executeAttempt(effectiveBudget, false);
    if (!strictProduction && !isRetry && retryBudget && attempt.canFastRetry) {
      _pipelineLogger().info(
        `[PipelineStrategy] Stage "${stage.name}" confirmed no tools — fast-retrying with retryBudget`
      );
      bus.publish(AgentEvents.PROGRESS, { type: 'pipeline_stage_fast_retry', stage: stage.name });
      attempt = await executeAttempt(retryBudget, true);
    }
    const stageResult = attempt.result;
    phaseResults[stage.name] = stageResult;
    if (this.#isCancelled(ctx)) {
      return stageResult;
    }

    if (strictProduction) {
      const strictContext = this.#strictProductionContext(ctx);
      this.#appendStrictRoleRouteReceipt(stage, ctx);
      validateStrictStageToolCallsV1(
        stage.name,
        stageResult.toolCalls || [],
        strictContext?.factQueryObligationIds || []
      );
    }

    _pipelineLogger().info(
      `[PipelineStrategy] ✅ Stage "${stage.name}" done — ` +
        `${stageResult.iterations || 0} iters, ${stageResult.toolCalls?.length || 0} tool calls, ` +
        `reply: ${stageResult.reply?.length || 0} chars${stageResult.timedOut ? ' (TIMED OUT)' : ''}`
    );

    bus.publish(AgentEvents.PROGRESS, {
      type: 'pipeline_stage_done',
      stage: stage.name,
      iterations: stageResult.iterations,
    });

    return stageResult;
  }

  #isCancelled(ctx: PipelineContext): boolean {
    return (
      ctx.cancelled ||
      (ctx.strategyContext.abortSignal as AbortSignal | undefined)?.aborted === true
    );
  }

  #recordCancellation(ctx: PipelineContext): void {
    const parentAborted =
      (ctx.strategyContext.abortSignal as AbortSignal | undefined)?.aborted === true;
    ctx.diagnostics.recordCancelReason(parentAborted ? 'abort_signal' : 'stage_aborted');
  }

  /** 每次尝试的已知成本均入总账，最终阶段结果仍只表示最后一次尝试。 */
  #accumulateStageAttempt(ctx: PipelineContext, result: StageResult): void {
    ctx.totalToolCalls.push(...(result.toolCalls || []));
    ctx.totalIterations += result.iterations || 0;
    ctx.totalTokenUsage.input += result.tokenUsage?.input || 0;
    ctx.totalTokenUsage.output += result.tokenUsage?.output || 0;
  }

  // ═══════════════════════════════════════════════════════════
  // Private: Helpers
  // ═══════════════════════════════════════════════════════════

  /** 构建阶段 prompt (优先级: retryPromptBuilder > promptBuilder > promptTransform > 原始) */
  async #buildStagePrompt(
    stage: PipelineStage,
    message: AgentMessage,
    phaseResults: Record<string, unknown>,
    strategyContext: Record<string, unknown>,
    ctx: PipelineContext
  ) {
    let prompt: string;
    if (phaseResults._retryContext && stage.retryPromptBuilder) {
      const retryCtx = phaseResults._retryContext as { reason?: string; artifact?: unknown };
      prompt = stage.retryPromptBuilder(retryCtx, message.content, phaseResults);
    } else if (stage.promptBuilder) {
      prompt = await stage.promptBuilder({
        message: message.content,
        phaseResults,
        gateArtifact: ctx.gateArtifact,
        ...strategyContext,
      });
    } else if (stage.promptTransform) {
      prompt = stage.promptTransform(message.content, phaseResults);
    } else {
      prompt = message.content;
    }

    // 清除已消费的 retryContext
    if (
      !(strategyContext.abortSignal as AbortSignal | undefined)?.aborted &&
      phaseResults._retryContext
    ) {
      delete phaseResults._retryContext;
    }
    return prompt;
  }

  /** 为阶段解析 ExplorationTracker */
  #resolveStageTracker(
    stage: PipelineStage,
    ctx: PipelineContext,
    strategyContext: Record<string, unknown>,
    effectiveBudget: StageBudget | undefined
  ) {
    if (this.#strictProductionContext(ctx)) {
      return null;
    }
    if (stage.disableTracker || stage.recordRepairOnly) {
      return null;
    }

    let stageTracker = (strategyContext.tracker || null) as ExplorationTracker | null;
    const submitToolName = (stage.submitToolName || strategyContext.submitToolName || undefined) as
      | string
      | undefined;
    const pipelineType = (stage.pipelineType || strategyContext.pipelineType || undefined) as
      | PipelineType
      | undefined;

    if (stageTracker && ctx.execStageCount > 0) {
      const trackerStrategy =
        stage.name === 'produce' || stage.name === 'producer' ? 'producer' : 'analyst';
      stageTracker = ExplorationTracker.resolve(
        { source: strategyContext.source || 'system', strategy: trackerStrategy },
        {
          ...(effectiveBudget || {}),
          ...(submitToolName ? { submitToolName } : {}),
          ...(pipelineType ? { pipelineType } : {}),
        }
      );
    } else if (stageTracker && ctx.execStageCount === 0 && submitToolName) {
      if (stageTracker.submitToolName !== submitToolName) {
        stageTracker = ExplorationTracker.resolve(
          { source: strategyContext.source || 'system', strategy: 'analyst' },
          {
            ...(effectiveBudget || {}),
            submitToolName,
            ...(pipelineType ? { pipelineType } : {}),
          }
        );
      }
    }

    return stageTracker;
  }

  #strictProductionContext(ctx: PipelineContext): StrictAnalysisContextProjectionV1 | null {
    const strictProduction = ctx.strategyContext.strictProduction;
    if (
      !strictProduction ||
      typeof strictProduction !== 'object' ||
      Array.isArray(strictProduction)
    ) {
      return null;
    }
    const record = strictProduction as Record<string, unknown>;
    if (record.enabled !== true) {
      return null;
    }
    const readAnalysisEpoch = record.readAnalysisEpoch;
    if (typeof readAnalysisEpoch !== 'function') {
      throw new Error('STRICT_ANALYSIS_EPOCH_READER_REQUIRED');
    }
    const snapshot = readAnalysisEpoch.call(record) as ReturnType<
      typeof createStrictAnalysisEpochSnapshotV1
    > | null;
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      Array.isArray(snapshot) ||
      snapshot.schemaVersion !== 1
    ) {
      throw new Error('STRICT_ANALYSIS_EPOCH_INVALID');
    }
    const { schemaVersion: _schemaVersion, snapshotHash, ...snapshotInput } = snapshot;
    const normalized = createStrictAnalysisEpochSnapshotV1(snapshotInput);
    if (normalized.snapshotHash !== snapshotHash) {
      throw new Error('STRICT_ANALYSIS_EPOCH_HASH_MISMATCH');
    }
    return normalized.context;
  }

  #validateStrictRoleRoute(stage: PipelineStage, ctx: PipelineContext): void {
    if (!this.#strictProductionContext(ctx)) {
      return;
    }
    const expected =
      stage.name === 'analyze'
        ? 'strict-analyst-v1'
        : stage.name === 'produce'
          ? 'strict-producer-v1'
          : null;
    if (expected && stage.strictRoleSurface !== expected) {
      throw new Error(`STRICT_PRODUCTION_STAGE_ROUTE_REQUIRED:${stage.name}`);
    }
  }

  #appendStrictRoleRouteReceipt(stage: PipelineStage, ctx: PipelineContext): void {
    if (
      stage.strictRoleSurface !== 'strict-analyst-v1' &&
      stage.strictRoleSurface !== 'strict-producer-v1'
    ) {
      return;
    }
    const previous = (ctx.phaseResults._strictRoleRouteReceipt || {}) as Record<string, unknown>;
    ctx.phaseResults._strictRoleRouteReceipt = {
      kind: 'StrictRoleRouteReceiptV1',
      strictAnalystCalls:
        Number(previous.strictAnalystCalls || 0) +
        (stage.strictRoleSurface === 'strict-analyst-v1' ? 1 : 0),
      strictProducerCalls:
        Number(previous.strictProducerCalls || 0) +
        (stage.strictRoleSurface === 'strict-producer-v1' ? 1 : 0),
      legacyAnalystCalls: 0,
      legacyProducerCalls: 0,
    };
  }

  #appendStrictGateReturn(ctx: PipelineContext, typedReturn: unknown): void {
    const previous = Array.isArray(ctx.phaseResults._strictGateReturns)
      ? ctx.phaseResults._strictGateReturns
      : [];
    ctx.phaseResults._strictGateReturns = [...previous, typedReturn];
  }

  #readStrictAnalysisTransition(
    gateResult: GateEvalResult,
    expectedAction: 'pass' | 'analysis_retry'
  ): StrictAnalysisEpochTransitionV1 {
    const transition = gateResult.artifact as Partial<StrictAnalysisEpochTransitionV1> | null;
    if (
      !transition ||
      transition.kind !== 'StrictAnalysisEpochTransitionV1' ||
      transition.schemaVersion !== 1 ||
      transition.action !== expectedAction ||
      typeof transition.transitionHash !== 'string' ||
      transition.transitionHash.length === 0
    ) {
      throw new Error('STRICT_ANALYSIS_RETRY_TRANSITION_REQUIRED');
    }
    return transition as StrictAnalysisEpochTransitionV1;
  }

  #appendStrictAnalysisLoopReceipt(
    ctx: PipelineContext,
    transition: StrictAnalysisEpochTransitionV1
  ): void {
    const previous =
      ctx.phaseResults._strictAnalysisLoopReceipt &&
      typeof ctx.phaseResults._strictAnalysisLoopReceipt === 'object' &&
      !Array.isArray(ctx.phaseResults._strictAnalysisLoopReceipt)
        ? (ctx.phaseResults._strictAnalysisLoopReceipt as Record<string, unknown>)
        : null;
    const epochs = Array.isArray(previous?.epochs) ? previous.epochs : [];
    ctx.phaseResults._strictAnalysisLoopReceipt = {
      kind: 'StrictAnalysisLoopReceiptV1',
      limits: transition.limits,
      epochs: [
        ...epochs,
        {
          epoch: transition.before.epoch,
          nextEpoch: transition.after.epoch,
          action: transition.action,
          reasonCode: transition.reasonCode,
          beforeSnapshotHash: transition.before.snapshotHash,
          afterSnapshotHash: transition.after.snapshotHash,
          currentExpandedScheduleHash: transition.after.currentExpandedScheduleHash,
          terminalObligationIds: transition.after.terminalObligationIds,
          outstandingObligationIds: transition.after.outstandingObligationIds,
          enrolledObligationIds: transition.enrolledObligationIds,
          executedObligationIds: transition.executedObligationIds,
          transitionHash: transition.transitionHash,
        },
      ],
      terminalAction: transition.action === 'analysis_retry' ? null : transition.action,
      finalEpoch: transition.after.epoch,
    };
  }

  /** 真实 stage→reactLoop 投影；signal、诊断与观察钩子由唯一 attempt 边界注入。 */
  #runPreparedStage(
    stagePrompt: string,
    message: AgentMessage,
    stage: PipelineStage,
    effectiveBudget: StageBudget | undefined,
    ctxWin: StageContextWindow | null,
    stageTracker: ExplorationTracker | null,
    strategyContext: Record<string, unknown>,
    phaseResults: Record<string, unknown>,
    decisionOnly: boolean,
    scope: StageAttemptScope
  ): Promise<StageResult> {
    const dimensionScopeId =
      typeof (strategyContext.sharedState as Record<string, unknown> | undefined)
        ?._dimensionScopeId === 'string'
        ? ((strategyContext.sharedState as Record<string, unknown>)._dimensionScopeId as string)
        : typeof strategyContext.scopeId === 'string'
          ? strategyContext.scopeId
          : undefined;
    const baseSharedState = ((strategyContext.sharedState as Record<string, unknown>) ||
      null) as Record<string, unknown> | null;
    const messageContext = ((message.metadata.context as Record<string, unknown>) ||
      null) as Record<string, unknown> | null;
    const pcvStageNodeMap =
      messageContext?.pcvStageNodeMap ??
      strategyContext.pcvStageNodeMap ??
      baseSharedState?._pcvStageNodeMap ??
      baseSharedState?.pcvStageNodeMap ??
      null;
    const pcvChainNodes =
      messageContext?.pcvChainNodes ??
      strategyContext.pcvChainNodes ??
      baseSharedState?._pcvChainNodes ??
      baseSharedState?.pcvChainNodes ??
      null;
    const stageNodeMap =
      messageContext?.stageNodeMap ??
      strategyContext.stageNodeMap ??
      baseSharedState?.stageNodeMap ??
      null;
    const sourceIdentities =
      messageContext?.sourceIdentities ??
      messageContext?.projectScopeSourceIdentities ??
      strategyContext.sourceIdentities ??
      strategyContext.projectScopeSourceIdentities ??
      baseSharedState?._sourceIdentities ??
      baseSharedState?._projectScopeSourceIdentities ??
      baseSharedState?.sourceIdentities ??
      baseSharedState?.projectScopeSourceIdentities ??
      null;
    const stageSharedState = decisionOnly
      ? {
          ...(baseSharedState || {}),
          _evolutionDecisionOnly: true,
          ...(sourceIdentities !== null ? { _sourceIdentities: sourceIdentities } : {}),
        }
      : stage.recordRepairOnly
        ? {
            ...(baseSharedState || {}),
            _recordRepairOnly: true,
            _recordRepairEvidencePaths: stage.recordRepairEvidencePaths || [],
            ...(sourceIdentities !== null ? { _sourceIdentities: sourceIdentities } : {}),
          }
        : sourceIdentities !== null
          ? {
              ...(baseSharedState || {}),
              _sourceIdentities: sourceIdentities,
            }
          : baseSharedState;

    return scope.runLoop(stagePrompt, {
      history: message.history,
      context: {
        ...(messageContext || {}),
        ...(pcvStageNodeMap !== null ? { pcvStageNodeMap } : {}),
        ...(pcvChainNodes !== null ? { pcvChainNodes } : {}),
        ...(stageNodeMap !== null ? { stageNodeMap } : {}),
        ...(sourceIdentities !== null ? { sourceIdentities } : {}),
        pipelinePhase: stage.name,
        previousPhases: phaseResults,
        evidenceStarters: strategyContext.evidenceStarters || null,
        toolPolicyHints: strategyContext.toolPolicyHints || null,
        ...(stage.recordRepairOnly
          ? {
              recordRepairOnly: true,
              recordRepairEvidencePaths: stage.recordRepairEvidencePaths || [],
            }
          : {}),
        ...(dimensionScopeId ? { dimensionScopeId } : {}),
      },
      capabilityOverride: stage.capabilities,
      additionalToolsOverride: stage.additionalTools,
      budgetOverride: effectiveBudget,
      systemPromptOverride: stage.systemPrompt,
      contextWindow: ctxWin,
      tracker: stageTracker,
      trace: strategyContext.trace || null,
      memoryCoordinator: strategyContext.memoryCoordinator || null,
      sharedState: stageSharedState,
      source: strategyContext.source || null,
      toolChoiceOverride: stage.toolChoiceOverride || null,
    });
  }

  /** 质量门控评估 (向后兼容: 阈值模式) */
  #evaluateGate(gateConfig: GateConfig, phaseResults: Record<string, unknown>, sourceName: string) {
    const source = phaseResults[sourceName] as StageResult | undefined;
    if (!source?.reply) {
      return { pass: false, reason: `No output from stage "${sourceName}"` };
    }

    const reply = source.reply;
    const reasons: string[] = [];

    if (gateConfig.minEvidenceLength && reply.length < gateConfig.minEvidenceLength) {
      reasons.push(`分析长度不足: ${reply.length} < ${gateConfig.minEvidenceLength}`);
    }

    if (gateConfig.minFileRefs) {
      const fileRefCount = (reply.match(/[\w/]+\.\w+/g) || []).length;
      if (fileRefCount < gateConfig.minFileRefs) {
        reasons.push(`文件引用不足: ${fileRefCount} < ${gateConfig.minFileRefs}`);
      }
    }

    if (gateConfig.minToolCalls) {
      const toolCalls = source.toolCalls?.length || 0;
      if (toolCalls < gateConfig.minToolCalls) {
        reasons.push(`工具调用不足: ${toolCalls} < ${gateConfig.minToolCalls}`);
      }
    }

    if (gateConfig.custom && typeof gateConfig.custom === 'function') {
      const customResult = gateConfig.custom(source);
      if (!customResult.pass) {
        reasons.push(customResult.reason ?? '');
      }
    }

    return reasons.length === 0 ? { pass: true } : { pass: false, reason: reasons.join('; ') };
  }

  #withCumulativeToolCalls(source: unknown, ctx: PipelineContext) {
    const base =
      source && typeof source === 'object' && !Array.isArray(source)
        ? ({ ...(source as Record<string, unknown>) } as Record<string, unknown>)
        : { value: source };

    return {
      ...base,
      toolCalls: ctx.totalToolCalls,
      iterations: ctx.totalIterations,
      tokenUsage: ctx.totalTokenUsage,
    };
  }

  /** 找到当前 gate 之前最近的执行阶段索引 (用于 retry 回退) */
  #findPrevExecStageIdx(currentIdx: number) {
    for (let j = currentIdx - 1; j >= 0; j--) {
      if (!this.#stages[j].gate) {
        return j;
      }
    }
    return -1;
  }

  #prevStageName(currentStage: PipelineStage) {
    const idx = this.#stages.indexOf(currentStage);
    for (let i = idx - 1; i >= 0; i--) {
      if (!this.#stages[i].gate && this.#stages[i].name) {
        return this.#stages[i].name;
      }
    }
    return null;
  }
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
