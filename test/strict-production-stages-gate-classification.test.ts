import Logger from '@alembic/core/logging';
import { describe, expect, it, vi } from 'vitest';
import {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisGateOutcomeV1,
  type StrictAnalysisContextProjectionV1,
  type StrictAnalysisEpochSnapshotV1,
} from '../src/agent/production/StrictProductionPipeline.js';
import {
  buildStrictProductionPipelineStagesV1,
  type StrictProductionGateResultV1,
  type StrictProductionRuntimePortV1,
} from '../src/agent/production/StrictProductionStages.js';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';
import type { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';

/**
 * C19：严格门 G1/G2 的 catch 分支把任何异常都失败关闭为 reject。reject 行为不变，但必须能区分
 * 「Analyst/Reviewer 语义拒绝」（STRICT_* 语义码、STRICT_PRODUCTION_ABORTED）与「基础设施故障」
 * （TypeError、宿主 I/O 错误、非 Error 抛出值、STRICT_PRODUCTION_RUNTIME_PORT_* 接线错误），
 * 归类写进返回 artifact，并留下带 gate、错误名、消息、堆栈与取消状态的 warn 日志。
 *
 * C29（Stages 侧）：经 buildStrictProductionPipelineStagesV1 的 gate evaluator 精确断言端口形状非法、
 * 入口上限、封口后 retry，以及 reject 篡改快照、身份漂移、append-only 这几条 fail-closed 分支。
 */

const WARN_MESSAGE = '[StrictProductionStages] strict gate exception converted to reject';
const G1_INDEX = 1;
const G2_INDEX = 3;

const message = {
  role: 'internal',
  content: 'strict gate classification probe',
  metadata: {},
} as AgentMessage;

function createContext(
  overrides: Partial<Omit<StrictAnalysisContextProjectionV1, 'schemaVersion' | 'contextHash'>> = {}
): StrictAnalysisContextProjectionV1 {
  return createStrictAnalysisContextProjectionV1({
    runId: 'run-classify',
    journalId: 'journal-classify',
    manifestHash: 'manifest-classify',
    planCognitionHash: 'plan-cognition-classify',
    planHash: 'plan-classify',
    requiredUniverseHash: 'universe-classify',
    baselineScheduleHash: 'schedule-baseline',
    expansionHeadHash: null,
    currentExpandedScheduleHash: 'schedule-baseline',
    finalExpandedScheduleHash: null,
    analysisFixpointHash: null,
    privateCorpusRevision: null,
    hypothesisExpressionSetHash: null,
    lensBindingsHash: 'lens-classify',
    sourceArtifactHash: 'artifact-classify',
    sourceRevisionVectorHash: 'vector-classify',
    questionIds: ['question-1'],
    factQueryObligationIds: ['base-1'],
    analysisUnitIds: ['unit-1'],
    factIds: ['fact-base'],
    witnessIds: ['witness-base'],
    populationHashes: ['population-1'],
    clusterSetHashes: [],
    inductionReceiptHashes: [],
    hypothesisIds: [],
    falsificationReceiptHashes: [],
    dispositionReviewIds: [],
    evidenceEntryIds: ['evidence-base'],
    derivedFindingCount: 0,
    ...overrides,
  });
}

function createEpoch(
  input: {
    epoch?: number;
    context?: Partial<Omit<StrictAnalysisContextProjectionV1, 'schemaVersion' | 'contextHash'>>;
    terminalObligationIds?: readonly string[];
  } = {}
): StrictAnalysisEpochSnapshotV1 {
  return createStrictAnalysisEpochSnapshotV1({
    epoch: input.epoch ?? 1,
    context: createContext(input.context),
    populations: [{ populationId: 'population-main', revision: 1, factIds: ['fact-base'] }],
    terminalObligationIds: input.terminalObligationIds ?? ['base-1'],
    outstandingObligationIds: [],
  });
}

function createExpansionPort() {
  return createStrictAnalysisExpansionPortV1({
    baselineScheduleHash: 'schedule-baseline',
    baselineObligationIds: ['base-1'],
    knownFactFamilies: [],
    knownSubjectRefs: [],
    obligationCap: 1,
  });
}

function buildPort(
  overrides: Partial<StrictProductionRuntimePortV1> = {}
): StrictProductionRuntimePortV1 {
  const epoch = createEpoch();
  return {
    enabled: true,
    analysisLimits: { maxEpochs: 3, maxObligations: 3 },
    expansionPort: createExpansionPort(),
    readAnalysisEpoch: () => epoch,
    buildProducerInput: (analysisArtifact) => ({
      analysisArtifact,
      producerEligibleHypothesisIds: [],
    }),
    validateAnalystResult: (_source, observed) =>
      createStrictAnalysisGateOutcomeV1({
        action: 'reject',
        reasonCode: 'analyst-reject',
        observedEpochHash: observed.snapshotHash,
      }),
    reviewProducerResult: () => ({ action: 'pass', pass: true }),
    ...overrides,
  };
}

async function evaluateGate(
  index: typeof G1_INDEX | typeof G2_INDEX,
  strategyContext: Record<string, unknown>
): Promise<StrictProductionGateResultV1> {
  const evaluator = buildStrictProductionPipelineStagesV1()[index].gate?.evaluator;
  if (!evaluator) {
    throw new Error(`strict stage ${index} has no gate evaluator`);
  }
  return evaluator({ reply: 'strict output' }, {}, strategyContext);
}

function exceptionWarnings(warn: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return warn.mock.calls
    .filter(([text]) => text === WARN_MESSAGE)
    .map(([, meta]) => meta as Record<string, unknown>);
}

async function withWarnSpy<T>(
  run: (warn: ReturnType<typeof vi.spyOn>) => Promise<T>,
  implementation: () => void = () => undefined
): Promise<T> {
  const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(implementation);
  try {
    return await run(warn);
  } finally {
    warn.mockRestore();
  }
}

describe('strict gate exception classification (C19)', () => {
  it('classifies a G1 host TypeError as infrastructure and logs name, message, stack and cancellation', async () => {
    await withWarnSpy(async (warn) => {
      const port = buildPort({
        validateAnalystResult: () => {
          throw new TypeError("Cannot read properties of undefined (reading 'rows')");
        },
      });
      const result = await evaluateGate(G1_INDEX, { strictProduction: port });
      expect(result).toEqual({
        action: 'reject',
        pass: false,
        reason: "Cannot read properties of undefined (reading 'rows')",
        artifact: {
          kind: 'StrictProductionGateExceptionV1',
          gate: 'G1',
          classification: 'infrastructure',
          errorName: 'TypeError',
          errorCode: null,
          aborted: false,
        },
      });
      const warnings = exceptionWarnings(warn);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        gate: 'G1',
        classification: 'infrastructure',
        errorName: 'TypeError',
        errorCode: null,
        thrownType: 'object',
        message: "Cannot read properties of undefined (reading 'rows')",
        aborted: false,
        selectedPath: 'reject-fail-closed',
      });
      expect(warnings[0].stack).toEqual(expect.stringContaining('TypeError'));
    });
  });

  it('classifies a G1 host I/O failure from readAnalysisEpoch as infrastructure', async () => {
    await withWarnSpy(async (warn) => {
      const port = buildPort({
        readAnalysisEpoch: () => {
          throw new Error('EACCES: permission denied, open fact-store');
        },
      });
      const result = await evaluateGate(G1_INDEX, { strictProduction: port });
      expect(result).toMatchObject({
        action: 'reject',
        pass: false,
        reason: 'EACCES: permission denied, open fact-store',
        artifact: {
          gate: 'G1',
          classification: 'infrastructure',
          errorName: 'Error',
          errorCode: null,
        },
      });
      expect(exceptionWarnings(warn)).toHaveLength(1);
    });
  });

  it('classifies a non-Error thrown value as infrastructure without a stack', async () => {
    await withWarnSpy(async (warn) => {
      const port = buildPort({
        // 故意以非 Error 值拒绝：模拟不守契约的宿主端口。
        validateAnalystResult: () => Promise.reject('host exploded'),
      });
      const result = await evaluateGate(G1_INDEX, { strictProduction: port });
      expect(result).toMatchObject({
        action: 'reject',
        pass: false,
        reason: 'host exploded',
        artifact: { classification: 'infrastructure', errorName: 'NonError', errorCode: null },
      });
      const [warning] = exceptionWarnings(warn);
      expect(warning).toMatchObject({ thrownType: 'string', errorName: 'NonError' });
      expect(warning.stack).toBeUndefined();
    });
  });

  it('classifies a G2 reviewer TypeError as infrastructure', async () => {
    await withWarnSpy(async (warn) => {
      const port = buildPort({
        reviewProducerResult: () => {
          throw new TypeError('reviewer is not a function');
        },
      });
      const result = await evaluateGate(G2_INDEX, { strictProduction: port });
      expect(result).toMatchObject({
        action: 'reject',
        pass: false,
        reason: 'reviewer is not a function',
        artifact: { gate: 'G2', classification: 'infrastructure', errorName: 'TypeError' },
      });
      expect(exceptionWarnings(warn)).toEqual([
        expect.objectContaining({ gate: 'G2', classification: 'infrastructure' }),
      ]);
    });
  });

  it('classifies STRICT_* semantic codes as semantic-reject and keeps the reason unchanged', async () => {
    await withWarnSpy(async (warn) => {
      const hostSemantic = buildPort({
        validateAnalystResult: () => {
          throw new Error('STRICT_HOST_SCHEDULE_DRIFT: counter-1');
        },
      });
      await expect(
        evaluateGate(G1_INDEX, { strictProduction: hostSemantic })
      ).resolves.toMatchObject({
        action: 'reject',
        pass: false,
        reason: 'STRICT_HOST_SCHEDULE_DRIFT: counter-1',
        artifact: {
          gate: 'G1',
          classification: 'semantic-reject',
          errorCode: 'STRICT_HOST_SCHEDULE_DRIFT',
        },
      });
      const invalidReview = buildPort({ reviewProducerResult: () => ({ action: 'unexpected' }) });
      await expect(
        evaluateGate(G2_INDEX, { strictProduction: invalidReview })
      ).resolves.toMatchObject({
        action: 'reject',
        pass: false,
        reason: 'STRICT_PRODUCTION_GATE_RESULT_INVALID',
        artifact: {
          gate: 'G2',
          classification: 'semantic-reject',
          errorCode: 'STRICT_PRODUCTION_GATE_RESULT_INVALID',
        },
      });
      expect(exceptionWarnings(warn).map((meta) => meta.classification)).toEqual([
        'semantic-reject',
        'semantic-reject',
      ]);
    });
  });

  it('records cancellation as a semantic-reject with aborted=true on both gates', async () => {
    await withWarnSpy(async (warn) => {
      const validate = vi.fn();
      const review = vi.fn();
      const port = buildPort({ validateAnalystResult: validate, reviewProducerResult: review });
      for (const index of [G1_INDEX, G2_INDEX] as const) {
        const result = await evaluateGate(index, {
          strictProduction: port,
          abortSignal: AbortSignal.abort(),
        });
        expect(result).toMatchObject({
          action: 'reject',
          pass: false,
          reason: 'STRICT_PRODUCTION_ABORTED',
          artifact: {
            classification: 'semantic-reject',
            errorCode: 'STRICT_PRODUCTION_ABORTED',
            aborted: true,
          },
        });
      }
      expect(validate).not.toHaveBeenCalled();
      expect(review).not.toHaveBeenCalled();
      expect(exceptionWarnings(warn).map((meta) => [meta.gate, meta.aborted])).toEqual([
        ['G1', true],
        ['G2', true],
      ]);
    });
  });

  it('still fails closed with the classification when the logger observer throws', async () => {
    await withWarnSpy(
      async () => {
        const port = buildPort({
          validateAnalystResult: () => {
            throw new TypeError('host wiring broke');
          },
        });
        const result = await evaluateGate(G1_INDEX, { strictProduction: port });
        expect(result).toMatchObject({
          action: 'reject',
          pass: false,
          reason: 'host wiring broke',
          artifact: { classification: 'infrastructure' },
        });
      },
      () => {
        throw new Error('logger sink unavailable');
      }
    );
  });

  it('keeps the strict PipelineStrategy failure path while exposing the classification in phases', async () => {
    await withWarnSpy(async () => {
      const port = buildPort({
        validateAnalystResult: () => {
          throw new TypeError('fact schedule executor crashed');
        },
      });
      const stages = new AgentStageFactoryRegistry().build('generateDimensionPipeline', {
        params: { needsCandidates: true },
        context: { strategyContext: { strictProduction: port } },
      });
      const prompts: string[] = [];
      const output = await new PipelineStrategy({ stages }).execute(
        {
          id: 'strict-classification-runtime',
          reactLoop: async (prompt: string) => {
            prompts.push(prompt);
            return {
              reply: 'analyst epoch 1',
              toolCalls: [],
              tokenUsage: { input: 1, output: 1 },
              iterations: 1,
            };
          },
        },
        message,
        { strategyContext: { strictProduction: port } }
      );
      expect(output.outcome).toBe('failed');
      expect(output.phases.analyst_fixpoint_gate).toMatchObject({
        action: 'reject',
        pass: false,
        reason: 'fact schedule executor crashed',
        artifact: {
          kind: 'StrictProductionGateExceptionV1',
          gate: 'G1',
          classification: 'infrastructure',
        },
      });
      expect(output.phases._strictGateReturns).toContainEqual(
        expect.objectContaining({ gate: 'G1', verdict: 'failed', owner: 'strict-analyst' })
      );
      // 诊断 artifact 不是 epoch transition，不得被当成分析循环回执入账。
      expect(output.phases).not.toHaveProperty('_strictAnalysisLoopReceipt');
      expect(prompts).toHaveLength(1);
    });
  });
});

describe('strict stage fail-closed branches through gate evaluators (C29)', () => {
  it.each([
    { label: 'enabled is not true', patch: { enabled: false } },
    {
      label: 'maxEpochs below one',
      patch: { analysisLimits: { maxEpochs: 0, maxObligations: 3 } },
    },
    {
      label: 'maxObligations not an integer',
      patch: { analysisLimits: { maxEpochs: 3, maxObligations: 1.5 } },
    },
    { label: 'expansion port without assertExecutionAllowed', patch: { expansionPort: {} } },
    { label: 'readAnalysisEpoch missing', patch: { readAnalysisEpoch: undefined } },
    { label: 'buildProducerInput missing', patch: { buildProducerInput: 'not-a-function' } },
    { label: 'validateAnalystResult missing', patch: { validateAnalystResult: undefined } },
    { label: 'reviewProducerResult missing', patch: { reviewProducerResult: null } },
  ])('rejects an invalid runtime port shape on G1 and G2 as infrastructure: $label', async ({
    patch,
  }) => {
    await withWarnSpy(async () => {
      const validate = vi.fn();
      const review = vi.fn();
      const port = {
        ...buildPort({ validateAnalystResult: validate, reviewProducerResult: review }),
        ...patch,
      };
      for (const index of [G1_INDEX, G2_INDEX] as const) {
        const result = await evaluateGate(index, { strictProduction: port });
        expect(result).toMatchObject({
          action: 'reject',
          pass: false,
          reason: 'STRICT_PRODUCTION_RUNTIME_PORT_INVALID',
          artifact: {
            classification: 'infrastructure',
            errorCode: 'STRICT_PRODUCTION_RUNTIME_PORT_INVALID',
          },
        });
      }
      expect(validate).not.toHaveBeenCalled();
      expect(review).not.toHaveBeenCalled();
    });
  });

  it.each([
    { label: 'missing', strictProduction: undefined },
    { label: 'array', strictProduction: [] },
    { label: 'string', strictProduction: 'strict' },
  ])('rejects a $label runtime port as infrastructure wiring', async ({ strictProduction }) => {
    await withWarnSpy(async () => {
      for (const index of [G1_INDEX, G2_INDEX] as const) {
        const result = await evaluateGate(index, { strictProduction });
        expect(result).toMatchObject({
          action: 'reject',
          pass: false,
          reason: 'STRICT_PRODUCTION_RUNTIME_PORT_REQUIRED',
          artifact: {
            classification: 'infrastructure',
            errorCode: 'STRICT_PRODUCTION_RUNTIME_PORT_REQUIRED',
          },
        });
      }
    });
  });

  it.each([
    {
      label: 'epoch above maxEpochs',
      epoch: () => createEpoch({ epoch: 2 }),
      limits: { maxEpochs: 1, maxObligations: 3 },
    },
    {
      label: 'obligations above maxObligations',
      epoch: () =>
        createEpoch({
          context: { factQueryObligationIds: ['base-1', 'base-2'] },
          terminalObligationIds: ['base-1', 'base-2'],
        }),
      limits: { maxEpochs: 3, maxObligations: 1 },
    },
  ])('rejects an entry epoch beyond loop limits before calling the Analyst port: $label', async ({
    epoch,
    limits,
  }) => {
    await withWarnSpy(async () => {
      const snapshot = epoch();
      const validate = vi.fn();
      const port = buildPort({
        analysisLimits: limits,
        readAnalysisEpoch: () => snapshot,
        validateAnalystResult: validate,
      });
      const seal = vi.spyOn(port.expansionPort, 'seal');
      const result = await evaluateGate(G1_INDEX, { strictProduction: port });
      expect(result).toMatchObject({
        action: 'reject',
        pass: false,
        reason: 'STRICT_ANALYSIS_LOOP_LIMIT_INVALID_AT_ENTRY',
        artifact: {
          classification: 'semantic-reject',
          errorCode: 'STRICT_ANALYSIS_LOOP_LIMIT_INVALID_AT_ENTRY',
        },
      });
      expect(validate).not.toHaveBeenCalled();
      expect(seal).not.toHaveBeenCalled();
    });
  });

  it('rejects analysis_retry once the expansion schedule is already sealed', async () => {
    await withWarnSpy(async () => {
      const epoch = createEpoch();
      const expansionPort = createExpansionPort();
      const sealed = expansionPort.seal();
      const port = buildPort({
        expansionPort,
        readAnalysisEpoch: () => epoch,
        validateAnalystResult: (_source, observed) =>
          createStrictAnalysisGateOutcomeV1({
            action: 'analysis_retry',
            reasonCode: 'late-counterquery',
            observedEpochHash: observed.snapshotHash,
            enrolledObligationIds: ['counter-1'],
            executedObligationIds: ['counter-1'],
          }),
      });
      const result = await evaluateGate(G1_INDEX, { strictProduction: port });
      expect(result).toMatchObject({
        action: 'reject',
        pass: false,
        reason: 'STRICT_ANALYSIS_RETRY_AFTER_SCHEDULE_SEAL',
        artifact: {
          classification: 'semantic-reject',
          errorCode: 'STRICT_ANALYSIS_RETRY_AFTER_SCHEDULE_SEAL',
        },
      });
      expect(expansionPort.finalSchedule).toBe(sealed);
    });
  });

  it.each([
    {
      label: 'reject that mutates the observed epoch',
      after: () => createEpoch({ context: { witnessIds: ['witness-base', 'witness-late'] } }),
      reason: 'STRICT_ANALYSIS_REJECT_MUTATED_EPOCH',
      errorCode: 'STRICT_ANALYSIS_REJECT_MUTATED_EPOCH',
    },
    {
      label: 'run identity drift',
      after: () => createEpoch({ context: { runId: 'run-other' } }),
      reason: 'STRICT_ANALYSIS_EPOCH_IDENTITY_DRIFT: runId',
      errorCode: 'STRICT_ANALYSIS_EPOCH_IDENTITY_DRIFT',
    },
    {
      label: 'fact ids not append-only',
      after: () => createEpoch({ context: { factIds: [] } }),
      reason: 'STRICT_ANALYSIS_FACTIDS_NOT_APPEND_ONLY',
      errorCode: 'STRICT_ANALYSIS_FACTIDS_NOT_APPEND_ONLY',
    },
  ])('rejects $label through the G1 evaluator without sealing', async ({
    after,
    reason,
    errorCode,
  }) => {
    await withWarnSpy(async () => {
      const before = createEpoch();
      const mutated = after();
      const reads = [before, mutated];
      const port = buildPort({
        readAnalysisEpoch: () => reads.shift() ?? mutated,
      });
      const seal = vi.spyOn(port.expansionPort, 'seal');
      const result = await evaluateGate(G1_INDEX, { strictProduction: port });
      expect(result).toMatchObject({
        action: 'reject',
        pass: false,
        reason,
        artifact: { gate: 'G1', classification: 'semantic-reject', errorCode },
      });
      expect(seal).not.toHaveBeenCalled();
      expect(port.expansionPort.finalSchedule).toBeNull();
    });
  });
});
