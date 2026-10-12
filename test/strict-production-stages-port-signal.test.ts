import Logger from '@alembic/core/logging';
import { createFinalExpandedMiningScheduleReceiptV1 } from '@alembic/core/production';
import { describe, expect, it, vi } from 'vitest';
import {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisGateOutcomeV1,
  type StrictAnalysisEpochSnapshotV1,
  type StrictAnalysisGateOutcomeV1,
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
 * C25：严格宿主端口必须拿到 Agent 侧的取消信号，宿主才能在 enroll 扩展或改写 state 之前停止。
 * 这里只验证 Agent 侧透传契约；宿主是否响应 signal 属于宿主仓的跟进工作。
 */

const message = {
  role: 'internal',
  content: 'strict port signal probe',
  metadata: {},
} as AgentMessage;

/** 已封口 fixpoint 的 epoch：hash 由 Core 纯构造器预先算出，与端口 seal(expectedHash) 一致。 */
function createReadyEpoch(): StrictAnalysisEpochSnapshotV1 {
  const schedule = createFinalExpandedMiningScheduleReceiptV1({
    baselineScheduleHash: 'schedule-baseline',
    baselineObligationIds: ['base-1'],
    expansionReceipts: [],
  });
  return createStrictAnalysisEpochSnapshotV1({
    epoch: 1,
    context: createStrictAnalysisContextProjectionV1({
      runId: 'run-signal',
      journalId: 'journal-signal',
      manifestHash: 'manifest-signal',
      planCognitionHash: 'plan-cognition-signal',
      planHash: 'plan-signal',
      requiredUniverseHash: 'universe-signal',
      baselineScheduleHash: 'schedule-baseline',
      expansionHeadHash: null,
      currentExpandedScheduleHash: 'schedule-baseline',
      finalExpandedScheduleHash: schedule.finalExpandedScheduleHash,
      analysisFixpointHash: 'analysis-fixpoint-signal',
      privateCorpusRevision: null,
      hypothesisExpressionSetHash: null,
      lensBindingsHash: 'lens-signal',
      sourceArtifactHash: 'artifact-signal',
      sourceRevisionVectorHash: 'vector-signal',
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
    }),
    populations: [{ populationId: 'population-main', revision: 1, factIds: ['fact-base'] }],
    terminalObligationIds: ['base-1'],
    outstandingObligationIds: [],
  });
}

function passOutcome(observed: StrictAnalysisEpochSnapshotV1): StrictAnalysisGateOutcomeV1 {
  return createStrictAnalysisGateOutcomeV1({
    action: 'pass',
    reasonCode: 'stable-fixpoint',
    observedEpochHash: observed.snapshotHash,
  });
}

/** 端口记录每次调用收到的全部实参，用来断言 Stages 透传的第二/第三参数。 */
function buildRecordingPort(input: {
  validateAnalystResult?: (...args: unknown[]) => unknown;
  reviewProducerResult?: (...args: unknown[]) => unknown;
}) {
  const epoch = createReadyEpoch();
  const analystCalls: unknown[][] = [];
  const reviewCalls: unknown[][] = [];
  const port = {
    enabled: true as const,
    analysisLimits: { maxEpochs: 3, maxObligations: 3 },
    expansionPort: createStrictAnalysisExpansionPortV1({
      baselineScheduleHash: 'schedule-baseline',
      baselineObligationIds: ['base-1'],
      knownFactFamilies: [],
      knownSubjectRefs: [],
      obligationCap: 2,
    }),
    readAnalysisEpoch: () => epoch,
    buildProducerInput: (analysisArtifact: unknown) => ({
      analysisArtifact,
      producerEligibleHypothesisIds: [],
    }),
    validateAnalystResult: (...args: unknown[]) => {
      analystCalls.push(args);
      return (input.validateAnalystResult?.(...args) ??
        passOutcome(args[1] as StrictAnalysisEpochSnapshotV1)) as StrictAnalysisGateOutcomeV1;
    },
    reviewProducerResult: (...args: unknown[]) => {
      reviewCalls.push(args);
      return (input.reviewProducerResult?.(...args) ?? {
        action: 'pass',
        pass: true,
        artifact: { verdict: 'pass' },
      }) as StrictProductionGateResultV1;
    },
  } satisfies StrictProductionRuntimePortV1;
  return { port, analystCalls, reviewCalls };
}

function readSignalOption(args: unknown[] | undefined, index: number): AbortSignal | undefined {
  const options = args?.[index];
  if (!options || typeof options !== 'object') {
    return undefined;
  }
  return (options as { signal?: AbortSignal }).signal;
}

async function executeStrict(port: StrictProductionRuntimePortV1, abortSignal?: AbortSignal) {
  const stages = new AgentStageFactoryRegistry().build('generateDimensionPipeline', {
    params: { needsCandidates: true },
    context: { strategyContext: { strictProduction: port } },
  });
  return new PipelineStrategy({ stages }).execute(
    {
      id: 'strict-port-signal',
      reactLoop: async (prompt: string) => ({
        reply: prompt.includes('strict cold-start Producer') ? 'producer output' : 'analyst output',
        toolCalls: [],
        tokenUsage: { input: 1, output: 1 },
        iterations: 1,
      }),
    },
    message,
    { strategyContext: { strictProduction: port }, abortSignal }
  );
}

describe('strict production runtime port cancellation signal (C25)', () => {
  it('forwards the G1 strategy abortSignal to validateAnalystResult as options.signal', async () => {
    const { port, analystCalls } = buildRecordingPort({});
    const controller = new AbortController();
    const stages = buildStrictProductionPipelineStagesV1();
    const result = await stages[1].gate?.evaluator(
      { reply: 'analyst output' },
      {},
      { strictProduction: port, abortSignal: controller.signal }
    );
    expect(result).toMatchObject({ action: 'pass', pass: true });
    expect(analystCalls).toHaveLength(1);
    expect(analystCalls[0]).toHaveLength(3);
    expect(readSignalOption(analystCalls[0], 2)).toBe(controller.signal);
  });

  it('forwards the G2 strategy abortSignal to reviewProducerResult as options.signal', async () => {
    const { port, reviewCalls } = buildRecordingPort({});
    const controller = new AbortController();
    const source = { reply: 'producer output' };
    const stages = buildStrictProductionPipelineStagesV1();
    const result = await stages[3].gate?.evaluator(
      source,
      {},
      { strictProduction: port, abortSignal: controller.signal }
    );
    expect(result).toMatchObject({ action: 'pass', pass: true });
    expect(reviewCalls).toHaveLength(1);
    expect(reviewCalls[0][0]).toBe(source);
    expect(readSignalOption(reviewCalls[0], 1)).toBe(controller.signal);
  });

  it('passes an options object without a signal when the gate has no cancellation scope', async () => {
    const { port, analystCalls, reviewCalls } = buildRecordingPort({});
    const stages = buildStrictProductionPipelineStagesV1();
    await expect(
      stages[1].gate?.evaluator({ reply: 'analyst output' }, {}, { strictProduction: port })
    ).resolves.toMatchObject({ action: 'pass' });
    await expect(
      stages[3].gate?.evaluator({ reply: 'producer output' }, {}, { strictProduction: port })
    ).resolves.toMatchObject({ action: 'pass' });
    expect(analystCalls[0][2]).toEqual({});
    expect(reviewCalls[0][1]).toEqual({});
  });

  it('omits a malformed abortSignal and reports the skipped forwarding', async () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn');
    try {
      const { port, analystCalls, reviewCalls } = buildRecordingPort({});
      const stages = buildStrictProductionPipelineStagesV1();
      const malformed = { aborted: false };
      await expect(
        stages[1].gate?.evaluator(
          { reply: 'analyst output' },
          {},
          { strictProduction: port, abortSignal: malformed }
        )
      ).resolves.toMatchObject({ action: 'pass' });
      await expect(
        stages[3].gate?.evaluator(
          { reply: 'producer output' },
          {},
          { strictProduction: port, abortSignal: malformed }
        )
      ).resolves.toMatchObject({ action: 'pass' });
      expect(readSignalOption(analystCalls[0], 2)).toBeUndefined();
      expect(readSignalOption(reviewCalls[0], 1)).toBeUndefined();
      const skipped = warn.mock.calls.filter(
        ([text]) => text === '[StrictProductionStages] strict port abort signal not forwarded'
      );
      expect(skipped.map(([, meta]) => meta)).toEqual([
        {
          gate: 'G1',
          port: 'validateAnalystResult',
          reason: 'abort-signal-not-an-AbortSignal',
          receivedType: 'object',
          selectedPath: 'call-port-without-signal',
        },
        {
          gate: 'G2',
          port: 'reviewProducerResult',
          reason: 'abort-signal-not-an-AbortSignal',
          receivedType: 'object',
          selectedPath: 'call-port-without-signal',
        },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('hands both ports a live pipeline signal on a completed strict run', async () => {
    const { port, analystCalls, reviewCalls } = buildRecordingPort({});
    const controller = new AbortController();
    const output = await executeStrict(port, controller.signal);
    expect(output.outcome).toBe('completed');
    const analystSignal = readSignalOption(analystCalls[0], 2);
    const reviewSignal = readSignalOption(reviewCalls[0], 1);
    expect(analystSignal).toBeInstanceOf(AbortSignal);
    expect(reviewSignal).toBeInstanceOf(AbortSignal);
    expect(analystSignal?.aborted).toBe(false);
    expect(reviewSignal?.aborted).toBe(false);
  });

  it('lets a pending host port observe run cancellation through the forwarded signal', async () => {
    const controller = new AbortController();
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (outcome: StrictAnalysisGateOutcomeV1) => void;
    let abortedAtEntry: boolean | undefined;
    let hostObservedAbort = false;
    const { port, analystCalls } = buildRecordingPort({
      validateAnalystResult: (_source, _observed, options) => {
        const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
        abortedAtEntry = signal?.aborted;
        // 模拟宿主：收到取消后不再 enroll 或改写 state。
        signal?.addEventListener('abort', () => {
          hostObservedAbort = true;
        });
        entered();
        return new Promise<StrictAnalysisGateOutcomeV1>((resolve) => {
          release = resolve;
        });
      },
    });
    const seal = vi.spyOn(port.expansionPort, 'seal');
    const pending = executeStrict(port, controller.signal);
    try {
      await entering;
      expect(abortedAtEntry).toBe(false);
      controller.abort();
      const output = await pending;
      expect(output.outcome).toBe('aborted');
      expect(hostObservedAbort).toBe(true);
      expect(readSignalOption(analystCalls[0], 2)?.aborted).toBe(true);
      release(passOutcome(createReadyEpoch()));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(seal).not.toHaveBeenCalled();
      expect(port.expansionPort.finalSchedule).toBeNull();
    } finally {
      controller.abort();
      release?.(passOutcome(createReadyEpoch()));
    }
  });
});
