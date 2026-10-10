/**
 * I05(L5-P33)：严格生产链上的「阶段最终回执超时即终态」及其 producer 边界。
 *
 * 非严格链在源阶段超时时把 pass/summary_rewrite/record_repair 改写成 analysis_retry 整段重跑；
 * 严格链不能这样改写——strict analysis_retry 只接受评估器签发的 StrictAnalysisEpochTransitionV1，
 * 管线无权合成 transition。因此严格 analyst 超时 + G1 pass 只能终止：不执行 strict producer，
 * 不追加 pass 的 typed gate return(门没有被消费为 transition)，写 pipeline_timeout_terminal。
 * 门自身非通过(degrade 等)仍走既有 fail-closed：typed failed return + strictFailed。
 *
 * 规则只覆盖 produce 上游的分析类阶段：严格 producer 超时 + G2(independent_review_gate，裁决的是
 * produce)pass 保持改动前语义——G2 追加 pass typed return、管线正常结束、outcome 按最终回执判
 * failed、phases.produce 保留首轮回执、不重跑 produce、不写 pipeline_timeout_terminal。
 *
 * 阶段形状与 buildStrictProductionPipelineStagesV1 同构：
 *   [analyze(strict-analyst-v1), analyst_fixpoint_gate(G1, strict-analysis-epoch),
 *    produce(strict-producer-v1), independent_review_gate(G2)]。
 */
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisGateOutcomeV1,
  validateStrictAnalysisEpochTransitionV1,
} from '../src/agent/production/StrictProductionPipeline.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';

const expansionPort = createStrictAnalysisExpansionPortV1({
  baselineScheduleHash: 'schedule-1',
  baselineObligationIds: ['base-1', 'counter-1'],
  knownFactFamilies: [],
  knownSubjectRefs: [],
  obligationCap: 2,
});
const finalSchedule = expansionPort.seal();

const strictContext = createStrictAnalysisContextProjectionV1({
  runId: 'run-1',
  journalId: 'journal-1',
  manifestHash: 'manifest-1',
  planCognitionHash: 'plan-cognition-1',
  planHash: 'plan-1',
  requiredUniverseHash: 'universe-1',
  baselineScheduleHash: 'schedule-1',
  expansionHeadHash: null,
  currentExpandedScheduleHash: 'schedule-1',
  finalExpandedScheduleHash: finalSchedule.finalExpandedScheduleHash,
  analysisFixpointHash: 'fixpoint-1',
  privateCorpusRevision: null,
  hypothesisExpressionSetHash: null,
  lensBindingsHash: 'lens-1',
  sourceArtifactHash: 'artifact-1',
  sourceRevisionVectorHash: 'vector-1',
  questionIds: ['q-root'],
  factQueryObligationIds: ['base-1', 'counter-1'],
  analysisUnitIds: ['unit-1'],
  factIds: ['fact-a', 'fact-b', 'fact-outlier'],
  witnessIds: ['witness-a', 'witness-b', 'witness-outlier'],
  populationHashes: ['population-1'],
  clusterSetHashes: ['cluster-set-1'],
  inductionReceiptHashes: ['induction-1'],
  hypothesisIds: ['hypothesis-1'],
  falsificationReceiptHashes: ['falsification-1'],
  dispositionReviewIds: ['review-1'],
  evidenceEntryIds: ['E-1', 'E-2'],
  derivedFindingCount: 0,
});

const strictAnalysisEpoch = createStrictAnalysisEpochSnapshotV1({
  epoch: 1,
  context: strictContext,
  populations: [{ populationHash: 'population-1' }],
  terminalObligationIds: strictContext.factQueryObligationIds,
  outstandingObligationIds: [],
});

/** PipelineStrategy 只读取 enabled + readAnalysisEpoch；其余端口字段与本测试无关。 */
function strictRuntimePort() {
  return {
    enabled: true as const,
    readAnalysisEpoch: () => strictAnalysisEpoch,
  };
}

/** G1 通过所需的真实 transition(评估器签发，管线只读取不合成)：fixpoint 已达、同一 epoch。 */
function passedAnalystTransition() {
  return validateStrictAnalysisEpochTransitionV1({
    before: strictAnalysisEpoch,
    after: strictAnalysisEpoch,
    outcome: createStrictAnalysisGateOutcomeV1({
      action: 'pass',
      reasonCode: 'analyst-fixpoint-passed',
      observedEpochHash: strictAnalysisEpoch.snapshotHash,
      artifact: { analysisText: 'fixpoint reached' },
    }),
    limits: { maxEpochs: 2, maxObligations: 2 },
  });
}

const message = new AgentMessage({ content: 'strict timeout' });

function strictStages(
  analystGate: () => Record<string, unknown>,
  reviewGate: () => Record<string, unknown>
) {
  return [
    { name: 'analyze', strictRoleSurface: 'strict-analyst-v1' as const },
    {
      name: 'analyst_fixpoint_gate',
      gate: {
        evaluator: analystGate,
        strictGate: {
          gate: 'G1' as const,
          reasonCode: 'analyst-fixpoint-failed',
          owner: 'strict-analyst',
          resumePoint: 'analysis-fixpoint',
          permittedMutation: 'append-enrolled-analysis-epoch',
          passReasonCode: 'analyst-fixpoint-passed',
          retryMode: 'strict-analysis-epoch' as const,
        },
      },
    },
    { name: 'produce', strictRoleSurface: 'strict-producer-v1' as const },
    {
      name: 'independent_review_gate',
      gate: {
        evaluator: reviewGate,
        strictGate: {
          gate: 'G2' as const,
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

/** 指定阶段的最终回执超时(宿主 stage_timeout 回执：非空文案 + timedOut)，其余阶段正常。 */
function strictRuntime(timedOutStage: 'analyze' | 'produce') {
  const phases: string[] = [];
  return {
    phases,
    runtime: {
      id: 'strict-timeout-runtime',
      reactLoop: vi.fn(async (_prompt: string, opts?: Record<string, unknown>) => {
        const phase = String((opts?.context as Record<string, unknown> | undefined)?.pipelinePhase);
        phases.push(phase);
        const timedOut = phase === timedOutStage;
        return {
          reply: timedOut
            ? `[run stopped: stage_timeout] partial strict ${phase} output`
            : `${phase} output`,
          toolCalls: [],
          tokenUsage: { input: 1, output: 1 },
          iterations: 1,
          ...(timedOut ? { timedOut: true } : {}),
        };
      }),
    },
  };
}

function terminalWarnings(diagnostics: { warnings?: unknown[] }) {
  return (diagnostics.warnings ?? []) as Array<{ code: string; stage?: string; message: string }>;
}

function timeoutTerminalWarnings(diagnostics: { warnings?: unknown[] }) {
  return terminalWarnings(diagnostics).filter(
    (warning) => warning.code === 'pipeline_timeout_terminal'
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PipelineStrategy — 严格链的超时终态(I05)', () => {
  it('严格 analyst 超时 + G1 pass → 终止：不跑 strict producer、不追加 pass typed return、写 pipeline_timeout_terminal', async () => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const { runtime, phases } = strictRuntime('analyze');
    const analystGate = vi.fn(() => ({ action: 'pass', pass: true }));
    const reviewGate = vi.fn(() => ({ action: 'pass', pass: true }));
    const result = await new PipelineStrategy({
      stages: strictStages(analystGate, reviewGate),
    }).execute(runtime, message, { strategyContext: { strictProduction: strictRuntimePort() } });

    expect(phases).toEqual(['analyze']);
    expect(analystGate).toHaveBeenCalledTimes(1);
    expect(reviewGate).not.toHaveBeenCalled();
    expect(result.outcome).toBe('failed');
    expect(result.timedOut).toBe(true);
    expect(result.phases.produce).toBeUndefined();
    // 门没有被消费为 transition：既无 pass typed return，也无 loop receipt，也不是 strict fail-closed。
    expect(result.phases._strictGateReturns).toBeUndefined();
    expect(result.phases._strictAnalysisLoopReceipt).toBeUndefined();
    expect(result.phases._pipelineOutcome).toMatchObject({
      outcome: 'failed',
      stage: 'analyst_fixpoint_gate',
      action: 'timeout_terminal',
    });
    const terminal = timeoutTerminalWarnings(result.diagnostics);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].stage).toBe('analyst_fixpoint_gate');
    expect(terminal[0].message).toMatch(/strict/i);
    expect(terminal[0].message).toContain('analyze');
  });

  it('严格 analyst 超时 + G1 degrade → 仍是既有 fail-closed：typed failed return，不写 pipeline_timeout_terminal', async () => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const { runtime, phases } = strictRuntime('analyze');
    const analystGate = vi.fn(() => ({
      action: 'degrade',
      pass: false,
      reason: 'drifted evidence',
    }));
    const reviewGate = vi.fn(() => ({ action: 'pass', pass: true }));
    const result = await new PipelineStrategy({
      stages: strictStages(analystGate, reviewGate),
    }).execute(runtime, message, { strategyContext: { strictProduction: strictRuntimePort() } });

    expect(phases).toEqual(['analyze']);
    expect(reviewGate).not.toHaveBeenCalled();
    expect(result.outcome).toBe('failed');
    expect(result.phases.produce).toBeUndefined();
    expect(result.phases._strictGateReturns).toEqual([
      expect.objectContaining({ gate: 'G1', verdict: 'failed', owner: 'strict-analyst' }),
    ]);
    expect(timeoutTerminalWarnings(result.diagnostics)).toHaveLength(0);
  });

  it('严格 producer 超时 + G2 pass → 规则不覆盖 producer：G2 追加 pass typed return、不重跑 produce、首轮回执保留、不写 pipeline_timeout_terminal', async () => {
    const infoLog = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const { runtime, phases } = strictRuntime('produce');
    const analystGate = vi.fn(() => ({
      action: 'pass',
      pass: true,
      artifact: passedAnalystTransition(),
    }));
    const reviewGate = vi.fn(() => ({ action: 'pass', pass: true }));
    const result = await new PipelineStrategy({
      stages: strictStages(analystGate, reviewGate),
    }).execute(runtime, message, { strategyContext: { strictProduction: strictRuntimePort() } });

    // 每个执行阶段各跑一次；G2 的 pass 不被改写，也不走终态。
    expect(phases).toEqual(['analyze', 'produce']);
    expect(analystGate).toHaveBeenCalledTimes(1);
    expect(reviewGate).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('failed');
    expect(result.timedOut).toBe(true);
    expect(result.phases.produce).toMatchObject({
      timedOut: true,
      reply: '[run stopped: stage_timeout] partial strict produce output',
    });
    expect(result.phases.independent_review_gate).toMatchObject({ pass: true, action: 'pass' });
    expect(result.phases._strictGateReturns).toEqual([
      expect.objectContaining({ gate: 'G1', verdict: 'pass' }),
      expect.objectContaining({ gate: 'G2', verdict: 'pass' }),
    ]);
    expect(result.phases._strictAnalysisLoopReceipt).toMatchObject({ terminalAction: 'pass' });
    expect(result.phases._pipelineOutcome).toEqual({ outcome: 'failed' });
    expect(timeoutTerminalWarnings(result.diagnostics)).toHaveLength(0);
    // 分叉留痕：日志能看出是 producer 超时、规则未套用。
    expect(
      infoLog.mock.calls.some((call) => {
        const text = String(call[0]);
        return text.includes('producer stage') && text.includes('"independent_review_gate"');
      })
    ).toBe(true);
  });
});
