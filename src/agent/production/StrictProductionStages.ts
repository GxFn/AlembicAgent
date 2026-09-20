import Logger from '@alembic/core/logging';
import {
  createStrictAnalysisEpochSnapshotV1,
  type StrictAnalysisEpochSnapshotV1,
  type StrictAnalysisExpansionPortV1,
  type StrictAnalysisGateOutcomeV1,
  type StrictAnalysisLoopLimitsV1,
  validateStrictAnalysisEpochTransitionV1,
} from './StrictProductionPipeline.js';
import { buildStrictAnalystPrompt, buildStrictProducerPrompt } from './StrictProductionPrompts.js';

export interface StrictProductionGateResultV1 {
  readonly action?: string;
  readonly pass?: boolean;
  readonly reason?: string;
  readonly artifact?: unknown;
}

export interface StrictProductionRuntimePortV1 {
  readonly enabled: true;
  readonly analysisLimits: StrictAnalysisLoopLimitsV1;
  readonly expansionPort: StrictAnalysisExpansionPortV1;
  readonly readAnalysisEpoch: () => StrictAnalysisEpochSnapshotV1;
  readonly buildProducerInput: (analysisArtifact: unknown) => Readonly<Record<string, unknown>>;
  readonly validateAnalystResult: (
    source: unknown,
    observedEpoch: StrictAnalysisEpochSnapshotV1
  ) => StrictAnalysisGateOutcomeV1 | Promise<StrictAnalysisGateOutcomeV1>;
  readonly reviewProducerResult: (
    source: unknown
  ) => StrictProductionGateResultV1 | Promise<StrictProductionGateResultV1>;
}

/**
 * 严格生产路径复用既有 PipelineStrategy。调用方提供经验证的 Agent/Core 端口；端口缺失时
 * 失败关闭，且任何阶段都不获得工具权限。
 */
export function buildStrictProductionPipelineStagesV1() {
  return [
    {
      name: 'analyze',
      strictRoleSurface: 'strict-analyst-v1',
      capabilities: [],
      additionalTools: [],
      disableTracker: true,
      toolChoiceOverride: 'none',
      promptBuilder: (ctx: Record<string, unknown>) => {
        const strict = readStrictPort(ctx);
        return buildStrictAnalystPrompt({
          epoch: readStrictAnalysisEpoch(strict),
          limits: strict.analysisLimits,
        });
      },
    },
    {
      name: 'analyst_fixpoint_gate',
      gate: {
        evaluator: async (
          source: unknown,
          _phaseResults: Record<string, unknown>,
          strategyContext: Record<string, unknown>
        ) => invokeStrictAnalysisGate(source, strategyContext),
        strictGate: {
          gate: 'G1',
          reasonCode: 'analyst-fixpoint-failed',
          owner: 'strict-analyst',
          resumePoint: 'analysis-fixpoint',
          permittedMutation: 'append-enrolled-analysis-epoch',
          passReasonCode: 'analyst-fixpoint-passed',
          retryMode: 'strict-analysis-epoch',
        },
      },
    },
    {
      name: 'produce',
      strictRoleSurface: 'strict-producer-v1',
      capabilities: [],
      additionalTools: [],
      disableTracker: true,
      toolChoiceOverride: 'none',
      promptBuilder: (ctx: Record<string, unknown>) => {
        const strict = readStrictPort(ctx);
        return buildStrictProducerPrompt(strict.buildProducerInput(ctx.gateArtifact));
      },
    },
    {
      name: 'independent_review_gate',
      gate: {
        evaluator: async (
          source: unknown,
          _phaseResults: Record<string, unknown>,
          strategyContext: Record<string, unknown>
        ) =>
          invokeGatePort(
            () => readStrictPort(strategyContext).reviewProducerResult(source),
            strategyContext
          ),
        strictGate: {
          gate: 'G2',
          reasonCode: 'independent-review-failed',
          owner: 'independent-reviewer',
          resumePoint: 'review-frozen-evidence',
          permittedMutation: 'causal-authoring-repair',
          passReasonCode: 'independent-review-passed',
        },
      },
    },
  ];
}

async function invokeGatePort(
  operation: () => StrictProductionGateResultV1 | Promise<StrictProductionGateResultV1>,
  strategyContext: Record<string, unknown>
): Promise<StrictProductionGateResultV1> {
  try {
    assertStrictGateActive(strategyContext);
    const result = await operation();
    assertStrictGateActive(strategyContext);
    return normalizeStrictReviewResult(result);
  } catch (error: unknown) {
    return {
      action: 'reject',
      pass: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 外部 port 可能不响应 signal，但取消后 adapter 不得继续发起读取、授权检查或 seal。 */
function assertStrictGateActive(context: Record<string, unknown>): void {
  if ((context.abortSignal as AbortSignal | undefined)?.aborted) {
    throw new Error('STRICT_PRODUCTION_ABORTED');
  }
}

/** G2 的宿主回执先归一化，再交给 Pipeline 生成 Core typed return；truthy 值不是通过。 */
function normalizeStrictReviewResult(value: unknown): StrictProductionGateResultV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('STRICT_PRODUCTION_GATE_RESULT_INVALID');
  }
  const result = value as Record<string, unknown>;
  // Main 的真实独立 reviewer 以 continue/true 表示通过，只兼容这一明确组合。
  const action =
    result.action === 'continue' && result.pass === true
      ? 'pass'
      : result.action === undefined
        ? result.pass === true
          ? 'pass'
          : result.pass === false
            ? 'reject'
            : undefined
        : result.action;
  if (
    (action !== 'pass' && action !== 'reject') ||
    (result.pass !== undefined &&
      (typeof result.pass !== 'boolean' || result.pass !== (action === 'pass'))) ||
    (result.reason !== undefined && typeof result.reason !== 'string')
  ) {
    throw new Error('STRICT_PRODUCTION_GATE_RESULT_INVALID');
  }
  if (result.action === 'continue') {
    Logger.getInstance().info('[StrictProductionStages] G2 reviewer compatibility translation', {
      gate: 'G2',
      originalAction: 'continue',
      selectedAction: 'pass',
      reason: 'main-review-compatibility',
    });
  }
  return { ...result, action, pass: action === 'pass' };
}

async function invokeStrictAnalysisGate(
  source: unknown,
  strategyContext: Record<string, unknown>
): Promise<StrictProductionGateResultV1> {
  try {
    assertStrictGateActive(strategyContext);
    const strict = readStrictPort(strategyContext);
    const before = readStrictAnalysisEpoch(strict);
    assertStrictGateActive(strategyContext);
    const rawOutcome = await strict.validateAnalystResult(source, before);
    assertStrictGateActive(strategyContext);
    if (rawOutcome?.kind !== 'StrictAnalysisGateOutcomeV1' || rawOutcome.schemaVersion !== 1) {
      throw new Error('STRICT_ANALYSIS_GATE_OUTCOME_UNTYPED');
    }
    const after = readStrictAnalysisEpoch(strict, false);
    assertStrictGateActive(strategyContext);
    // 授权检查必须来自真实 epoch 差集，而不是模型声明的子集；否则影子 obligation
    // 可以写进 context/terminal 集合却绕过 expansion port。
    for (const obligationId of getAppendedAnalysisObligationIds(before, after)) {
      assertStrictGateActive(strategyContext);
      strict.expansionPort.assertExecutionAllowed(obligationId);
    }
    if (rawOutcome.action === 'analysis_retry' && strict.expansionPort.finalSchedule) {
      throw new Error('STRICT_ANALYSIS_RETRY_AFTER_SCHEDULE_SEAL');
    }
    assertStrictGateActive(strategyContext);
    // 先校验完整 typed transition。失败回执不得把仍可继续扩展的端口提前封口。
    const transition = validateStrictAnalysisEpochTransitionV1({
      before,
      after,
      outcome: rawOutcome,
      limits: strict.analysisLimits,
    });
    assertStrictGateActive(strategyContext);
    if (transition.action === 'pass') {
      // pass 校验已要求 hash；即使缺失也传入失败预期，不能退回无参 seal 的兼容路径。
      strict.expansionPort.seal(transition.after.finalExpandedScheduleHash ?? '');
      assertStrictGateActive(strategyContext);
    }
    return {
      action: transition.action,
      pass: transition.action === 'pass',
      reason: transition.reasonCode,
      artifact: transition,
    };
  } catch (error: unknown) {
    return {
      action: 'reject',
      pass: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function getAppendedAnalysisObligationIds(
  before: StrictAnalysisEpochSnapshotV1,
  after: StrictAnalysisEpochSnapshotV1
): string[] {
  const beforeIds = new Set(before.context.factQueryObligationIds);
  return after.context.factQueryObligationIds.filter(
    (obligationId) => !beforeIds.has(obligationId)
  );
}

function readStrictPort(context: Record<string, unknown>): StrictProductionRuntimePortV1 {
  const value = context.strictProduction;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('STRICT_PRODUCTION_RUNTIME_PORT_REQUIRED');
  }
  const port = value as Partial<StrictProductionRuntimePortV1>;
  if (
    port.enabled !== true ||
    !port.analysisLimits ||
    !Number.isSafeInteger(port.analysisLimits.maxEpochs) ||
    port.analysisLimits.maxEpochs < 1 ||
    !Number.isSafeInteger(port.analysisLimits.maxObligations) ||
    port.analysisLimits.maxObligations < 1 ||
    !port.expansionPort ||
    typeof port.expansionPort.assertExecutionAllowed !== 'function' ||
    typeof port.readAnalysisEpoch !== 'function' ||
    typeof port.buildProducerInput !== 'function' ||
    typeof port.validateAnalystResult !== 'function' ||
    typeof port.reviewProducerResult !== 'function'
  ) {
    throw new Error('STRICT_PRODUCTION_RUNTIME_PORT_INVALID');
  }
  return port as StrictProductionRuntimePortV1;
}

function readStrictAnalysisEpoch(
  port: StrictProductionRuntimePortV1,
  enforceEntryLimits = true
): StrictAnalysisEpochSnapshotV1 {
  const snapshot = port.readAnalysisEpoch();
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('STRICT_ANALYSIS_EPOCH_REQUIRED');
  }
  const { schemaVersion, snapshotHash, ...input } = snapshot;
  if (schemaVersion !== 1) {
    throw new Error('STRICT_ANALYSIS_EPOCH_VERSION_MISMATCH');
  }
  const normalized = createStrictAnalysisEpochSnapshotV1(input);
  if (normalized.snapshotHash !== snapshotHash) {
    throw new Error('STRICT_ANALYSIS_EPOCH_HASH_MISMATCH');
  }
  if (
    enforceEntryLimits &&
    (normalized.epoch > port.analysisLimits.maxEpochs ||
      normalized.context.factQueryObligationIds.length > port.analysisLimits.maxObligations)
  ) {
    throw new Error('STRICT_ANALYSIS_LOOP_LIMIT_INVALID_AT_ENTRY');
  }
  return normalized;
}
