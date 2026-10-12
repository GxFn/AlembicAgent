import Logger from '@alembic/core/logging';
import { createFinalExpandedMiningScheduleReceiptV1 } from '@alembic/core/production';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisGateOutcomeV1,
  type StrictAnalysisContextProjectionV1,
  type StrictAnalysisEpochSnapshotV1,
  type StrictAnalysisGateOutcomeV1,
  validateStrictAnalysisEpochTransitionV1,
} from '../src/agent/production/StrictProductionPipeline.js';
import { buildStrictAnalystPrompt } from '../src/agent/production/StrictProductionPrompts.js';
import {
  buildStrictProductionPipelineStagesV1,
  type StrictProductionRuntimePortV1,
} from '../src/agent/production/StrictProductionStages.js';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';
import type { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';

const message = {
  role: 'internal',
  content: 'run iterative strict analysis',
  metadata: {},
} as AgentMessage;

function createContext(
  overrides: Partial<Omit<StrictAnalysisContextProjectionV1, 'schemaVersion' | 'contextHash'>> = {}
): StrictAnalysisContextProjectionV1 {
  return createStrictAnalysisContextProjectionV1({
    runId: 'run-iterative',
    journalId: 'journal-iterative',
    manifestHash: 'manifest-iterative',
    planCognitionHash: 'plan-cognition-iterative',
    planHash: 'plan-iterative',
    requiredUniverseHash: 'universe-iterative',
    baselineScheduleHash: 'schedule-baseline',
    expansionHeadHash: null,
    currentExpandedScheduleHash: 'schedule-baseline',
    finalExpandedScheduleHash: null,
    analysisFixpointHash: null,
    privateCorpusRevision: null,
    hypothesisExpressionSetHash: null,
    lensBindingsHash: 'lens-iterative',
    sourceArtifactHash: 'artifact-iterative',
    sourceRevisionVectorHash: 'vector-iterative',
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

function createInitialEpoch(): StrictAnalysisEpochSnapshotV1 {
  return createStrictAnalysisEpochSnapshotV1({
    epoch: 1,
    context: createContext(),
    populations: [{ populationId: 'population-main', revision: 1, factIds: ['fact-base'] }],
    terminalObligationIds: ['base-1'],
    outstandingObligationIds: [],
  });
}

/** 由真实 Core 纯构造器预先生成匹配 hash，不触发待测 expansion port 的 seal 副作用。 */
function createReadyEpoch(): StrictAnalysisEpochSnapshotV1 {
  const schedule = createFinalExpandedMiningScheduleReceiptV1({
    baselineScheduleHash: 'schedule-baseline',
    baselineObligationIds: ['base-1'],
    expansionReceipts: [],
  });
  const { schemaVersion: _version, snapshotHash: _hash, ...initial } = createInitialEpoch();
  return createStrictAnalysisEpochSnapshotV1({
    ...initial,
    context: createContext({
      finalExpandedScheduleHash: schedule.finalExpandedScheduleHash,
      analysisFixpointHash: 'analysis-fixpoint-1',
    }),
  });
}

function nextContext(
  previous: StrictAnalysisContextProjectionV1,
  input: {
    expansionHeadHash: string;
    obligationId: string;
    factId: string;
    witnessId: string;
    populationHash: string;
  }
): StrictAnalysisContextProjectionV1 {
  const { schemaVersion: _schemaVersion, contextHash: _contextHash, ...contextInput } = previous;
  return createStrictAnalysisContextProjectionV1({
    ...contextInput,
    expansionHeadHash: input.expansionHeadHash,
    currentExpandedScheduleHash: input.expansionHeadHash,
    factQueryObligationIds: [...previous.factQueryObligationIds, input.obligationId],
    factIds: [...previous.factIds, input.factId],
    witnessIds: [...previous.witnessIds, input.witnessId],
    populationHashes: [...previous.populationHashes, input.populationHash],
  });
}

function sealFixpointEpoch(
  observedEpoch: StrictAnalysisEpochSnapshotV1,
  expansionPort: ReturnType<typeof createStrictAnalysisExpansionPortV1>
): StrictAnalysisEpochSnapshotV1 {
  const {
    schemaVersion: _schemaVersion,
    contextHash: _contextHash,
    ...contextInput
  } = observedEpoch.context;
  return createStrictAnalysisEpochSnapshotV1({
    epoch: observedEpoch.epoch,
    context: createStrictAnalysisContextProjectionV1({
      ...contextInput,
      finalExpandedScheduleHash: expansionPort.seal().finalExpandedScheduleHash,
      analysisFixpointHash: `analysis-fixpoint-${observedEpoch.epoch}`,
    }),
    populations: observedEpoch.populations,
    terminalObligationIds: observedEpoch.terminalObligationIds,
    outstandingObligationIds: observedEpoch.outstandingObligationIds,
  });
}

function buildRuntimePort(input: {
  readAnalysisEpoch: () => StrictAnalysisEpochSnapshotV1;
  validateAnalystResult: StrictProductionRuntimePortV1['validateAnalystResult'];
  maxEpochs?: number;
  maxObligations?: number;
  expansionPort?: ReturnType<typeof createStrictAnalysisExpansionPortV1>;
}): StrictProductionRuntimePortV1 {
  return {
    enabled: true,
    analysisLimits: {
      maxEpochs: input.maxEpochs ?? 3,
      maxObligations: input.maxObligations ?? 3,
    },
    expansionPort:
      input.expansionPort ??
      createStrictAnalysisExpansionPortV1({
        baselineScheduleHash: 'schedule-baseline',
        baselineObligationIds: ['base-1'],
        knownFactFamilies: [
          {
            id: 'syntax-patterns',
            capabilityId: 'facts.syntax',
            supportedScales: ['file'],
          },
        ],
        knownSubjectRefs: ['file:base', 'file:counter'],
        obligationCap: 2,
      }),
    readAnalysisEpoch: input.readAnalysisEpoch,
    buildProducerInput: (analysisArtifact) => ({
      analysisArtifact,
      producerEligibleHypothesisIds: [],
    }),
    validateAnalystResult: input.validateAnalystResult,
    reviewProducerResult: () => ({
      action: 'pass',
      pass: true,
      artifact: { verdict: 'pass', decisionHash: 'review-pass' },
    }),
  };
}

async function executeStrict(
  runtimePort: StrictProductionRuntimePortV1,
  prompts: string[],
  abortSignal?: AbortSignal
) {
  const stages = new AgentStageFactoryRegistry().build('generateDimensionPipeline', {
    params: { needsCandidates: true },
    context: { strategyContext: { strictProduction: runtimePort } },
  });
  const strategy = new PipelineStrategy({ stages });
  return strategy.execute(
    {
      id: 'strict-iterative-runtime',
      reactLoop: async (prompt: string) => {
        prompts.push(prompt);
        return {
          reply: prompt.includes('strict cold-start Producer')
            ? 'producer expression set'
            : `analyst epoch ${prompts.length}`,
          toolCalls: [],
          tokenUsage: { input: 1, output: 1 },
          iterations: 1,
        };
      },
    },
    message,
    { strategyContext: { strictProduction: runtimePort }, abortSignal }
  );
}

describe('strict iterative Analyst epochs', () => {
  it('does not seal the actual port before rejecting a corrupted typed outcome', async () => {
    const epoch = createReadyEpoch();
    const port = buildRuntimePort({
      readAnalysisEpoch: () => epoch,
      validateAnalystResult: (_source, observed) => ({
        ...createStrictAnalysisGateOutcomeV1({
          action: 'pass',
          reasonCode: 'corrupted-pass',
          observedEpochHash: observed.snapshotHash,
        }),
        outcomeHash: 'tampered',
      }),
    });
    const prompts: string[] = [];
    const output = await executeStrict(port, prompts);
    expect(output.outcome).toBe('failed');
    expect(output.phases.analyst_fixpoint_gate).toMatchObject({
      action: 'reject',
      reason: expect.stringContaining('STRICT_ANALYSIS_GATE_OUTCOME_HASH_MISMATCH'),
    });
    expect(port.expansionPort.finalSchedule).toBeNull();
    expect(prompts).toHaveLength(1);
  });

  it('checks an expected schedule hash before committing seal and keeps the no-argument contract', () => {
    const port = createStrictAnalysisExpansionPortV1({
      baselineScheduleHash: 'schedule-baseline',
      baselineObligationIds: ['base-1'],
      knownFactFamilies: [],
      knownSubjectRefs: [],
      obligationCap: 1,
    });
    expect(() => port.seal('mismatched-schedule')).toThrow(
      'STRICT_ANALYSIS_FIXPOINT_SCHEDULE_MISMATCH'
    );
    expect(port.finalSchedule).toBeNull();
    const sealed = port.seal();
    expect(port.seal(sealed.finalExpandedScheduleHash)).toBe(sealed);
    expect(() => port.seal('mismatched-schedule')).toThrow(
      'STRICT_ANALYSIS_FIXPOINT_SCHEDULE_MISMATCH'
    );
    expect(port.finalSchedule).toBe(sealed);
  });
  it('does not read or seal after a late validator response reaches a cancelled strict factory', async () => {
    const epoch = createReadyEpoch();
    const controller = new AbortController();
    const readEpoch = vi.fn(() => epoch);
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (outcome: StrictAnalysisGateOutcomeV1) => void;
    const outcome = createStrictAnalysisGateOutcomeV1({
      action: 'pass',
      reasonCode: 'valid-late-review',
      observedEpochHash: epoch.snapshotHash,
    });
    const port = buildRuntimePort({
      readAnalysisEpoch: readEpoch,
      validateAnalystResult: () => {
        entered();
        return new Promise<StrictAnalysisGateOutcomeV1>((resolve) => {
          release = resolve;
        });
      },
    });
    const seal = vi.spyOn(port.expansionPort, 'seal');
    const prompts: string[] = [];
    const pending = executeStrict(port, prompts, controller.signal);
    try {
      await entering;
      controller.abort();
      const output = await pending;
      const readsAtReturn = readEpoch.mock.calls.length;
      expect(output.outcome).toBe('aborted');
      expect(port.expansionPort.finalSchedule).toBeNull();
      release(outcome); // 外部 validator 只返回回执，不调用 seal；后续副作用只能来自 adapter。
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(readEpoch).toHaveBeenCalledTimes(readsAtReturn);
      expect(seal).not.toHaveBeenCalled();
      expect(port.expansionPort.finalSchedule).toBeNull();
      expect(prompts).toHaveLength(1);
      expect(output.phases).not.toHaveProperty('analyst_fixpoint_gate');
    } finally {
      controller.abort();
      release?.(outcome);
    }
  });

  it('does not invoke strict ports when the factory evaluator is already cancelled', async () => {
    const epoch = createReadyEpoch();
    const readEpoch = vi.fn(() => epoch);
    const validate = vi.fn(() =>
      createStrictAnalysisGateOutcomeV1({
        action: 'pass',
        reasonCode: 'unused-review',
        observedEpochHash: epoch.snapshotHash,
      })
    );
    const port = buildRuntimePort({
      readAnalysisEpoch: readEpoch,
      validateAnalystResult: validate,
    });
    const review = vi.spyOn(port, 'reviewProducerResult');
    const signal = AbortSignal.abort();
    const stages = buildStrictProductionPipelineStagesV1();
    for (const index of [1, 3]) {
      const result = await stages[index].gate?.evaluator(
        {},
        {},
        { strictProduction: port, abortSignal: signal }
      );
      expect(result).toMatchObject({
        action: 'reject',
        pass: false,
        reason: 'STRICT_PRODUCTION_ABORTED',
        // C19：取消仍按语义拒绝失败关闭，但 artifact 记录 aborted=true，便于与模型拒绝区分。
        artifact: { classification: 'semantic-reject', aborted: true },
      });
    }
    expect(readEpoch).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(port.expansionPort.finalSchedule).toBeNull();
  });
  it('enrolls and executes a discovered counterquery, then reruns Analyst to a stable fixpoint', async () => {
    const expansionPort = createStrictAnalysisExpansionPortV1({
      baselineScheduleHash: 'schedule-baseline',
      baselineObligationIds: ['base-1'],
      knownFactFamilies: [
        {
          id: 'syntax-patterns',
          capabilityId: 'facts.syntax',
          supportedScales: ['file'],
        },
      ],
      knownSubjectRefs: ['file:base', 'file:counter'],
      obligationCap: 2,
    });
    let currentEpoch = createInitialEpoch();
    let gateCalls = 0;
    const runtimePort = buildRuntimePort({
      expansionPort,
      readAnalysisEpoch: () => currentEpoch,
      validateAnalystResult: (_source, observedEpoch) => {
        gateCalls += 1;
        if (gateCalls === 1) {
          const enrollment = expansionPort.enroll({
            obligationId: 'counter-1',
            purpose: 'counterexample',
            factFamilyId: 'syntax-patterns',
            capabilityId: 'facts.syntax',
            canonicalSubjectRef: 'file:counter',
            analysisScale: 'file',
            reasonCode: 'analyst-discovered-counterexample',
          });
          expansionPort.assertExecutionAllowed('counter-1');
          currentEpoch = createStrictAnalysisEpochSnapshotV1({
            epoch: 2,
            context: nextContext(observedEpoch.context, {
              expansionHeadHash: enrollment.receiptHash,
              obligationId: 'counter-1',
              factId: 'fact-counter',
              witnessId: 'witness-counter',
              populationHash: 'population-2',
            }),
            populations: [
              {
                populationId: 'population-main',
                revision: 2,
                parentPopulationHash: observedEpoch.context.populationHashes[0],
                factIds: ['fact-base', 'fact-counter'],
              },
            ],
            terminalObligationIds: ['base-1', 'counter-1'],
            outstandingObligationIds: [],
          });
          return createStrictAnalysisGateOutcomeV1({
            action: 'analysis_retry',
            reasonCode: 'accepted-counterquery-executed',
            observedEpochHash: observedEpoch.snapshotHash,
            enrolledObligationIds: ['counter-1'],
            executedObligationIds: ['counter-1'],
          });
        }
        const {
          schemaVersion: _schemaVersion,
          contextHash: _contextHash,
          ...contextInput
        } = observedEpoch.context;
        currentEpoch = createStrictAnalysisEpochSnapshotV1({
          epoch: observedEpoch.epoch,
          context: createStrictAnalysisContextProjectionV1({
            ...contextInput,
            finalExpandedScheduleHash: expansionPort.seal().finalExpandedScheduleHash,
            analysisFixpointHash: 'analysis-fixpoint-2',
          }),
          populations: observedEpoch.populations,
          terminalObligationIds: observedEpoch.terminalObligationIds,
          outstandingObligationIds: [],
        });
        return createStrictAnalysisGateOutcomeV1({
          action: 'pass',
          reasonCode: 'stable-analysis-fixpoint',
          observedEpochHash: observedEpoch.snapshotHash,
        });
      },
    });
    const prompts: string[] = [];

    const output = await executeStrict(runtimePort, prompts);

    expect(output.outcome).toBe('completed');
    expect(gateCalls).toBe(2);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain('Analysis epoch: 1');
    expect(prompts[1]).toContain('Analysis epoch: 2');
    expect(prompts[1]).toContain('fact-counter');
    expect(prompts[1]).toContain('counter-1');
    expect(output.phases._strictRoleRouteReceipt).toEqual({
      kind: 'StrictRoleRouteReceiptV1',
      strictAnalystCalls: 2,
      strictProducerCalls: 1,
      legacyAnalystCalls: 0,
      legacyProducerCalls: 0,
    });
    expect(output.phases._strictAnalysisLoopReceipt).toMatchObject({
      kind: 'StrictAnalysisLoopReceiptV1',
      terminalAction: 'pass',
      epochs: [
        { epoch: 1, action: 'analysis_retry' },
        { epoch: 2, action: 'pass' },
      ],
    });
  });

  it('rejects a pre-authorized shadow obligation omitted from the typed retry outcome', async () => {
    const expansionPort = createStrictAnalysisExpansionPortV1({
      baselineScheduleHash: 'schedule-baseline',
      baselineObligationIds: ['base-1'],
      knownFactFamilies: [
        {
          id: 'syntax-patterns',
          capabilityId: 'facts.syntax',
          supportedScales: ['file'],
        },
      ],
      knownSubjectRefs: ['file:counter', 'file:shadow'],
      obligationCap: 3,
    });
    let currentEpoch = createInitialEpoch();
    let gateCalls = 0;
    const prompts: string[] = [];
    const output = await executeStrict(
      buildRuntimePort({
        expansionPort,
        maxObligations: 3,
        readAnalysisEpoch: () => currentEpoch,
        validateAnalystResult: (_source, observedEpoch) => {
          gateCalls += 1;
          if (gateCalls === 1) {
            expansionPort.enroll({
              obligationId: 'counter-1',
              purpose: 'counterexample',
              factFamilyId: 'syntax-patterns',
              capabilityId: 'facts.syntax',
              canonicalSubjectRef: 'file:counter',
              analysisScale: 'file',
              reasonCode: 'declared-counterexample',
            });
            const shadowEnrollment = expansionPort.enroll({
              obligationId: 'shadow-1',
              purpose: 'exploration',
              factFamilyId: 'syntax-patterns',
              capabilityId: 'facts.syntax',
              canonicalSubjectRef: 'file:shadow',
              analysisScale: 'file',
              reasonCode: 'hidden-shadow-query',
            });
            const {
              schemaVersion: _schemaVersion,
              contextHash: _contextHash,
              ...contextInput
            } = observedEpoch.context;
            currentEpoch = createStrictAnalysisEpochSnapshotV1({
              epoch: 2,
              context: createStrictAnalysisContextProjectionV1({
                ...contextInput,
                expansionHeadHash: shadowEnrollment.receiptHash,
                currentExpandedScheduleHash: shadowEnrollment.receiptHash,
                factQueryObligationIds: [
                  ...observedEpoch.context.factQueryObligationIds,
                  'counter-1',
                  'shadow-1',
                ],
                factIds: [...observedEpoch.context.factIds, 'fact-counter', 'fact-shadow'],
                witnessIds: [
                  ...observedEpoch.context.witnessIds,
                  'witness-counter',
                  'witness-shadow',
                ],
                populationHashes: [...observedEpoch.context.populationHashes, 'population-2'],
              }),
              populations: [
                {
                  populationId: 'population-main',
                  revision: 2,
                  factIds: ['fact-base', 'fact-counter', 'fact-shadow'],
                },
              ],
              terminalObligationIds: ['base-1', 'counter-1', 'shadow-1'],
              outstandingObligationIds: [],
            });
            return createStrictAnalysisGateOutcomeV1({
              action: 'analysis_retry',
              reasonCode: 'declares-only-one-of-two-appended-obligations',
              observedEpochHash: observedEpoch.snapshotHash,
              enrolledObligationIds: ['counter-1'],
              executedObligationIds: ['counter-1'],
            });
          }
          currentEpoch = sealFixpointEpoch(observedEpoch, expansionPort);
          return createStrictAnalysisGateOutcomeV1({
            action: 'pass',
            reasonCode: 'shadow-obligation-was-not-detected',
            observedEpochHash: observedEpoch.snapshotHash,
          });
        },
      }),
      prompts
    );

    expect(output.outcome).toBe('failed');
    expect(gateCalls).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(output.phases.analyst_fixpoint_gate).toMatchObject({
      action: 'reject',
      reason: expect.stringContaining('STRICT_ANALYSIS_RETRY_ENROLLMENT_DIFF_MISMATCH'),
    });
    expect(output.phases).not.toHaveProperty('produce');
  });

  it('authorizes every appended obligation instead of trusting the typed declaration subset', async () => {
    const expansionPort = createStrictAnalysisExpansionPortV1({
      baselineScheduleHash: 'schedule-baseline',
      baselineObligationIds: ['base-1'],
      knownFactFamilies: [
        {
          id: 'syntax-patterns',
          capabilityId: 'facts.syntax',
          supportedScales: ['file'],
        },
      ],
      knownSubjectRefs: ['file:counter', 'file:shadow'],
      obligationCap: 3,
    });
    let currentEpoch = createInitialEpoch();
    let gateCalls = 0;
    const prompts: string[] = [];
    const output = await executeStrict(
      buildRuntimePort({
        expansionPort,
        maxObligations: 3,
        readAnalysisEpoch: () => currentEpoch,
        validateAnalystResult: (_source, observedEpoch) => {
          gateCalls += 1;
          if (gateCalls === 1) {
            const enrollment = expansionPort.enroll({
              obligationId: 'counter-1',
              purpose: 'counterexample',
              factFamilyId: 'syntax-patterns',
              capabilityId: 'facts.syntax',
              canonicalSubjectRef: 'file:counter',
              analysisScale: 'file',
              reasonCode: 'declared-counterexample',
            });
            const {
              schemaVersion: _schemaVersion,
              contextHash: _contextHash,
              ...contextInput
            } = observedEpoch.context;
            currentEpoch = createStrictAnalysisEpochSnapshotV1({
              epoch: 2,
              context: createStrictAnalysisContextProjectionV1({
                ...contextInput,
                expansionHeadHash: enrollment.receiptHash,
                currentExpandedScheduleHash: enrollment.receiptHash,
                factQueryObligationIds: [
                  ...observedEpoch.context.factQueryObligationIds,
                  'counter-1',
                  'shadow-1',
                ],
                factIds: [...observedEpoch.context.factIds, 'fact-counter', 'fact-shadow'],
                witnessIds: [
                  ...observedEpoch.context.witnessIds,
                  'witness-counter',
                  'witness-shadow',
                ],
                populationHashes: [...observedEpoch.context.populationHashes, 'population-2'],
              }),
              populations: [
                {
                  populationId: 'population-main',
                  revision: 2,
                  factIds: ['fact-base', 'fact-counter', 'fact-shadow'],
                },
              ],
              terminalObligationIds: ['base-1', 'counter-1', 'shadow-1'],
              outstandingObligationIds: [],
            });
            return createStrictAnalysisGateOutcomeV1({
              action: 'analysis_retry',
              reasonCode: 'hidden-query-never-enrolled',
              observedEpochHash: observedEpoch.snapshotHash,
              enrolledObligationIds: ['counter-1'],
              executedObligationIds: ['counter-1'],
            });
          }
          currentEpoch = sealFixpointEpoch(observedEpoch, expansionPort);
          return createStrictAnalysisGateOutcomeV1({
            action: 'pass',
            reasonCode: 'unenrolled-shadow-was-not-detected',
            observedEpochHash: observedEpoch.snapshotHash,
          });
        },
      }),
      prompts
    );

    expect(output.outcome).toBe('failed');
    expect(gateCalls).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(output.phases.analyst_fixpoint_gate).toMatchObject({
      action: 'reject',
      reason: expect.stringContaining('STRICT_ANALYSIS_QUERY_UNENROLLED: shadow-1'),
    });
    expect(output.phases).not.toHaveProperty('produce');
  });

  it('rejects an undeclared terminal transition that resolves prior outstanding work in parallel', async () => {
    const expansionPort = createStrictAnalysisExpansionPortV1({
      baselineScheduleHash: 'schedule-baseline',
      baselineObligationIds: ['base-1', 'pending-1'],
      knownFactFamilies: [
        {
          id: 'syntax-patterns',
          capabilityId: 'facts.syntax',
          supportedScales: ['file'],
        },
      ],
      knownSubjectRefs: ['file:counter'],
      obligationCap: 3,
    });
    let currentEpoch = createStrictAnalysisEpochSnapshotV1({
      epoch: 1,
      context: createContext({
        factQueryObligationIds: ['base-1', 'pending-1'],
      }),
      populations: [{ populationId: 'population-main', revision: 1, factIds: ['fact-base'] }],
      terminalObligationIds: ['base-1'],
      outstandingObligationIds: ['pending-1'],
    });
    let gateCalls = 0;
    const prompts: string[] = [];
    const output = await executeStrict(
      buildRuntimePort({
        expansionPort,
        maxObligations: 3,
        readAnalysisEpoch: () => currentEpoch,
        validateAnalystResult: (_source, observedEpoch) => {
          gateCalls += 1;
          if (gateCalls === 1) {
            const enrollment = expansionPort.enroll({
              obligationId: 'counter-1',
              purpose: 'counterexample',
              factFamilyId: 'syntax-patterns',
              capabilityId: 'facts.syntax',
              canonicalSubjectRef: 'file:counter',
              analysisScale: 'file',
              reasonCode: 'declared-counterexample',
            });
            currentEpoch = createStrictAnalysisEpochSnapshotV1({
              epoch: 2,
              context: nextContext(observedEpoch.context, {
                expansionHeadHash: enrollment.receiptHash,
                obligationId: 'counter-1',
                factId: 'fact-counter',
                witnessId: 'witness-counter',
                populationHash: 'population-2',
              }),
              populations: [
                {
                  populationId: 'population-main',
                  revision: 2,
                  factIds: ['fact-base', 'fact-counter'],
                },
              ],
              terminalObligationIds: ['base-1', 'counter-1', 'pending-1'],
              outstandingObligationIds: [],
            });
            return createStrictAnalysisGateOutcomeV1({
              action: 'analysis_retry',
              reasonCode: 'also-resolved-prior-outstanding-work',
              observedEpochHash: observedEpoch.snapshotHash,
              enrolledObligationIds: ['counter-1'],
              executedObligationIds: ['counter-1'],
            });
          }
          currentEpoch = sealFixpointEpoch(observedEpoch, expansionPort);
          return createStrictAnalysisGateOutcomeV1({
            action: 'pass',
            reasonCode: 'parallel-terminal-mutation-was-not-detected',
            observedEpochHash: observedEpoch.snapshotHash,
          });
        },
      }),
      prompts
    );

    expect(output.outcome).toBe('failed');
    expect(gateCalls).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(output.phases.analyst_fixpoint_gate).toMatchObject({
      action: 'reject',
      reason: expect.stringContaining('STRICT_ANALYSIS_RETRY_TERMINAL_DIFF_MISMATCH'),
    });
    expect(output.phases).not.toHaveProperty('produce');
  });

  it('fails closed when a retry does not advance the append-only epoch state', async () => {
    const currentEpoch = createInitialEpoch();
    const expansionPort = createStrictAnalysisExpansionPortV1({
      baselineScheduleHash: 'schedule-baseline',
      baselineObligationIds: ['base-1'],
      knownFactFamilies: [
        {
          id: 'syntax-patterns',
          capabilityId: 'facts.syntax',
          supportedScales: ['file'],
        },
      ],
      knownSubjectRefs: ['file:counter'],
      obligationCap: 2,
    });
    expansionPort.enroll({
      obligationId: 'counter-1',
      purpose: 'counterexample',
      factFamilyId: 'syntax-patterns',
      capabilityId: 'facts.syntax',
      canonicalSubjectRef: 'file:counter',
      analysisScale: 'file',
      reasonCode: 'analyst-discovered-counterexample',
    });
    const prompts: string[] = [];
    const output = await executeStrict(
      buildRuntimePort({
        expansionPort,
        readAnalysisEpoch: () => currentEpoch,
        validateAnalystResult: (_source, observedEpoch) =>
          createStrictAnalysisGateOutcomeV1({
            action: 'analysis_retry',
            reasonCode: 'claimed-progress-without-revision',
            observedEpochHash: observedEpoch.snapshotHash,
            enrolledObligationIds: ['counter-1'],
            executedObligationIds: ['counter-1'],
          }),
      }),
      prompts
    );

    expect(output.outcome).toBe('failed');
    expect(prompts).toHaveLength(1);
    expect(output.phases.analyst_fixpoint_gate).toMatchObject({
      action: 'reject',
      reason: expect.stringContaining('STRICT_ANALYSIS_RETRY_NON_PROGRESS'),
    });
    expect(output.phases).not.toHaveProperty('produce');
  });

  it('fails closed when a typed retry would exceed the explicit epoch bound', async () => {
    const expansionPort = createStrictAnalysisExpansionPortV1({
      baselineScheduleHash: 'schedule-baseline',
      baselineObligationIds: ['base-1'],
      knownFactFamilies: [
        {
          id: 'syntax-patterns',
          capabilityId: 'facts.syntax',
          supportedScales: ['file'],
        },
      ],
      knownSubjectRefs: ['file:counter'],
      obligationCap: 2,
    });
    let currentEpoch = createInitialEpoch();
    const prompts: string[] = [];
    const output = await executeStrict(
      buildRuntimePort({
        expansionPort,
        maxEpochs: 1,
        readAnalysisEpoch: () => currentEpoch,
        validateAnalystResult: (_source, observedEpoch) => {
          const enrollment = expansionPort.enroll({
            obligationId: 'counter-1',
            purpose: 'counterexample',
            factFamilyId: 'syntax-patterns',
            capabilityId: 'facts.syntax',
            canonicalSubjectRef: 'file:counter',
            analysisScale: 'file',
            reasonCode: 'analyst-discovered-counterexample',
          });
          currentEpoch = createStrictAnalysisEpochSnapshotV1({
            epoch: 2,
            context: nextContext(observedEpoch.context, {
              expansionHeadHash: enrollment.receiptHash,
              obligationId: 'counter-1',
              factId: 'fact-counter',
              witnessId: 'witness-counter',
              populationHash: 'population-2',
            }),
            populations: [
              { populationId: 'population-main', revision: 2, factIds: ['fact-counter'] },
            ],
            terminalObligationIds: ['base-1', 'counter-1'],
            outstandingObligationIds: [],
          });
          return createStrictAnalysisGateOutcomeV1({
            action: 'analysis_retry',
            reasonCode: 'retry-past-bound',
            observedEpochHash: observedEpoch.snapshotHash,
            enrolledObligationIds: ['counter-1'],
            executedObligationIds: ['counter-1'],
          });
        },
      }),
      prompts
    );

    expect(output.outcome).toBe('failed');
    expect(prompts).toHaveLength(1);
    expect(output.phases.analyst_fixpoint_gate).toMatchObject({
      action: 'reject',
      reason: expect.stringContaining('STRICT_ANALYSIS_EPOCH_LIMIT_EXHAUSTED'),
    });
    expect(output.phases).not.toHaveProperty('produce');
  });

  it('fails closed when an enrolled retry would exceed the explicit obligation bound', async () => {
    const expansionPort = createStrictAnalysisExpansionPortV1({
      baselineScheduleHash: 'schedule-baseline',
      baselineObligationIds: ['base-1'],
      knownFactFamilies: [
        {
          id: 'syntax-patterns',
          capabilityId: 'facts.syntax',
          supportedScales: ['file'],
        },
      ],
      knownSubjectRefs: ['file:counter'],
      obligationCap: 2,
    });
    let currentEpoch = createInitialEpoch();
    const prompts: string[] = [];
    const output = await executeStrict(
      buildRuntimePort({
        expansionPort,
        maxEpochs: 3,
        maxObligations: 1,
        readAnalysisEpoch: () => currentEpoch,
        validateAnalystResult: (_source, observedEpoch) => {
          const enrollment = expansionPort.enroll({
            obligationId: 'counter-1',
            purpose: 'counterexample',
            factFamilyId: 'syntax-patterns',
            capabilityId: 'facts.syntax',
            canonicalSubjectRef: 'file:counter',
            analysisScale: 'file',
            reasonCode: 'analyst-discovered-counterexample',
          });
          currentEpoch = createStrictAnalysisEpochSnapshotV1({
            epoch: 2,
            context: nextContext(observedEpoch.context, {
              expansionHeadHash: enrollment.receiptHash,
              obligationId: 'counter-1',
              factId: 'fact-counter',
              witnessId: 'witness-counter',
              populationHash: 'population-2',
            }),
            populations: [
              { populationId: 'population-main', revision: 2, factIds: ['fact-counter'] },
            ],
            terminalObligationIds: ['base-1', 'counter-1'],
            outstandingObligationIds: [],
          });
          return createStrictAnalysisGateOutcomeV1({
            action: 'analysis_retry',
            reasonCode: 'retry-past-obligation-bound',
            observedEpochHash: observedEpoch.snapshotHash,
            enrolledObligationIds: ['counter-1'],
            executedObligationIds: ['counter-1'],
          });
        },
      }),
      prompts
    );

    expect(output.outcome).toBe('failed');
    expect(prompts).toHaveLength(1);
    expect(output.phases.analyst_fixpoint_gate).toMatchObject({
      action: 'reject',
      reason: expect.stringContaining('STRICT_ANALYSIS_OBLIGATION_LIMIT_EXHAUSTED'),
    });
    expect(output.phases).not.toHaveProperty('produce');
  });

  it('fails closed when a typed pass does not match the sealed expansion schedule', async () => {
    const expansionPort = createStrictAnalysisExpansionPortV1({
      baselineScheduleHash: 'schedule-baseline',
      baselineObligationIds: ['base-1'],
      knownFactFamilies: [
        {
          id: 'syntax-patterns',
          capabilityId: 'facts.syntax',
          supportedScales: ['file'],
        },
      ],
      knownSubjectRefs: ['file:base'],
      obligationCap: 1,
    });
    let currentEpoch = createInitialEpoch();
    const prompts: string[] = [];
    const output = await executeStrict(
      buildRuntimePort({
        expansionPort,
        maxObligations: 1,
        readAnalysisEpoch: () => currentEpoch,
        validateAnalystResult: (_source, observedEpoch) => {
          const {
            schemaVersion: _schemaVersion,
            contextHash: _contextHash,
            ...contextInput
          } = observedEpoch.context;
          currentEpoch = createStrictAnalysisEpochSnapshotV1({
            epoch: observedEpoch.epoch,
            context: createStrictAnalysisContextProjectionV1({
              ...contextInput,
              finalExpandedScheduleHash: 'mismatched-schedule',
              analysisFixpointHash: 'analysis-fixpoint-1',
            }),
            populations: observedEpoch.populations,
            terminalObligationIds: observedEpoch.terminalObligationIds,
            outstandingObligationIds: [],
          });
          return createStrictAnalysisGateOutcomeV1({
            action: 'pass',
            reasonCode: 'claimed-fixpoint',
            observedEpochHash: observedEpoch.snapshotHash,
          });
        },
      }),
      prompts
    );

    expect(output.outcome).toBe('failed');
    expect(prompts).toHaveLength(1);
    expect(output.phases.analyst_fixpoint_gate).toMatchObject({
      action: 'reject',
      reason: expect.stringContaining('STRICT_ANALYSIS_FIXPOINT_SCHEDULE_MISMATCH'),
    });
    expect(expansionPort.finalSchedule).toBeNull();
    expect(output.phases).not.toHaveProperty('produce');
  });

  it('rejects an untyped analysis_retry instead of entering the strict retry loop', async () => {
    const prompts: string[] = [];
    const output = await executeStrict(
      buildRuntimePort({
        readAnalysisEpoch: createInitialEpoch,
        validateAnalystResult: () =>
          ({
            action: 'analysis_retry',
            pass: false,
            reason: 'legacy untyped retry',
          }) as unknown as StrictAnalysisGateOutcomeV1,
      }),
      prompts
    );

    expect(output.outcome).toBe('failed');
    expect(prompts).toHaveLength(1);
    expect(output.phases.analyst_fixpoint_gate).toMatchObject({
      action: 'reject',
      reason: expect.stringContaining('STRICT_ANALYSIS_GATE_OUTCOME_UNTYPED'),
    });
    expect(output.phases).not.toHaveProperty('produce');
  });

  it('preserves the existing non-strict analysis_retry behavior', async () => {
    let analyzeCalls = 0;
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        {
          name: 'quality_gate',
          source: 'analyze',
          gate: {
            evaluator: () =>
              analyzeCalls === 1
                ? { action: 'analysis_retry', pass: false, reason: 'legacy retry' }
                : { action: 'pass', pass: true },
            maxRetries: 1,
          },
        },
        { name: 'produce' },
      ],
    });

    const output = await strategy.execute(
      {
        id: 'legacy-runtime',
        reactLoop: async () => {
          analyzeCalls += 1;
          return {
            reply: 'legacy stage result',
            toolCalls: [],
            tokenUsage: { input: 1, output: 1 },
            iterations: 1,
          };
        },
      },
      message
    );

    expect(output.outcome).toBe('completed');
    expect(analyzeCalls).toBe(3);
  });
});

// C20：宿主对 population 只做 append-only 追加，Analyst 提示只能把末项当作当前份全量内联；
// 历史份只给身份字段并标 superseded，避免同一观测在多 epoch 下重复出现、分母错乱、提示膨胀。
describe('strict Analyst prompt population projection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function populationRow(input: {
    revision: number;
    parentPopulationHash: string | null;
    observationIds: readonly string[];
  }) {
    return {
      schemaVersion: 1,
      populationId: 'population-main',
      revision: input.revision,
      parentPopulationHash: input.parentPopulationHash,
      populationHash: `population-hash-${input.revision}`,
      sourceRevisionVectorHash: 'vector-iterative',
      completion: 'complete',
      denominator: {
        kind: 'frozen-complete-subjects',
        expectedObservationIds: [...input.observationIds],
      },
      observations: input.observationIds.map((observationId) => ({
        observationId,
        factIds: [observationId.replace('observation:', '')],
      })),
    };
  }

  /** 按宿主 executeAnalysisExpansion 的形状构造 3 个 epoch 的超集 population 链。 */
  function createThreeEpochSnapshot(): StrictAnalysisEpochSnapshotV1 {
    return createStrictAnalysisEpochSnapshotV1({
      epoch: 3,
      context: createContext({
        factQueryObligationIds: ['base-1', 'counter-1', 'counter-2'],
        factIds: ['fact-base', 'fact-counter-1', 'fact-counter-2'],
        witnessIds: ['witness-base', 'witness-counter-1', 'witness-counter-2'],
        populationHashes: ['population-hash-1', 'population-hash-2', 'population-hash-3'],
      }),
      populations: [
        populationRow({
          revision: 1,
          parentPopulationHash: null,
          observationIds: ['observation:fact-base'],
        }),
        populationRow({
          revision: 2,
          parentPopulationHash: 'population-hash-1',
          observationIds: ['observation:fact-base', 'observation:fact-counter-1'],
        }),
        populationRow({
          revision: 3,
          parentPopulationHash: 'population-hash-2',
          observationIds: [
            'observation:fact-base',
            'observation:fact-counter-1',
            'observation:fact-counter-2',
          ],
        }),
      ],
      terminalObligationIds: ['base-1', 'counter-1', 'counter-2'],
      outstandingObligationIds: [],
    });
  }

  function countOccurrences(text: string, needle: string): number {
    return text.split(needle).length - 1;
  }

  function promptLine(prompt: string, prefix: string): string {
    const line = prompt.split('\n').find((candidate) => candidate.startsWith(prefix));
    if (!line) {
      throw new Error(`prompt line missing: ${prefix}`);
    }
    return line;
  }

  it('inlines only the last population as current and lists superseded ones by identity only', () => {
    const epoch = createThreeEpochSnapshot();
    const info = vi.spyOn(Logger.getInstance(), 'info');
    const prompt = buildStrictAnalystPrompt({
      epoch,
      limits: { maxEpochs: 8, maxObligations: 4 },
    });

    // 同一观测行只在当前份出现一次；分母（expectedObservationIds）也只出现一份。
    for (const observationId of [
      'observation:fact-base',
      'observation:fact-counter-1',
      'observation:fact-counter-2',
    ]) {
      expect(countOccurrences(prompt, `"observationId":"${observationId}"`)).toBe(1);
    }
    expect(countOccurrences(prompt, '"expectedObservationIds"')).toBe(1);
    expect(countOccurrences(prompt, '"observations"')).toBe(1);
    expect(prompt).not.toContain('Complete populations:');

    const currentLine = promptLine(prompt, 'Current population');
    const current = JSON.parse(currentLine.slice(currentLine.indexOf('{'))) as unknown;
    expect(current).toEqual(epoch.populations[2]);
    expect(currentLine).toContain('"observation:fact-base"');

    const supersededLine = promptLine(prompt, 'Superseded populations');
    expect(JSON.parse(supersededLine.slice(supersededLine.indexOf('[')))).toEqual([
      {
        populationHash: 'population-hash-1',
        revision: 1,
        parentPopulationHash: null,
        status: 'superseded',
      },
      {
        populationHash: 'population-hash-2',
        revision: 2,
        parentPopulationHash: 'population-hash-1',
        status: 'superseded',
      },
    ]);
    expect(supersededLine).not.toContain('observation:');

    // 分母措辞针对当前 population，而不是“所有 populations”。
    expect(prompt).not.toContain('Consume the complete multiscale observation populations');
    expect(prompt).toMatch(/current observation population.*denominators/iu);
    // 快照结构与 hash 不变：提示投影不回写快照。
    expect(epoch.populations).toHaveLength(3);
    expect(info).toHaveBeenCalledWith(
      '[StrictProductionPrompts] analyst prompt inlines only the current population',
      expect.objectContaining({
        epoch: 3,
        populationCount: 3,
        currentPopulationHash: 'population-hash-3',
        supersededPopulationHashes: ['population-hash-1', 'population-hash-2'],
        selectedPath: 'current-inline-superseded-identity-only',
      })
    );
  });

  it('keeps a single-population epoch fully inlined as current with no superseded rows', () => {
    const info = vi.spyOn(Logger.getInstance(), 'info');
    const warn = vi.spyOn(Logger.getInstance(), 'warn');
    const epoch = createInitialEpoch();
    const prompt = buildStrictAnalystPrompt({
      epoch,
      limits: { maxEpochs: 3, maxObligations: 3 },
    });
    const currentLine = promptLine(prompt, 'Current population');
    expect(JSON.parse(currentLine.slice(currentLine.indexOf('{')))).toEqual(epoch.populations[0]);
    const supersededLine = promptLine(prompt, 'Superseded populations');
    expect(JSON.parse(supersededLine.slice(supersededLine.indexOf('[')))).toEqual([]);
    expect(info).not.toHaveBeenCalledWith(
      '[StrictProductionPrompts] analyst prompt inlines only the current population',
      expect.anything()
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('renders an explicit null current population and warns when the host supplied none', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn');
    const prompt = buildStrictAnalystPrompt({
      epoch: createStrictAnalysisEpochSnapshotV1({
        epoch: 1,
        context: createContext(),
        populations: [],
        terminalObligationIds: ['base-1'],
        outstandingObligationIds: [],
      }),
      limits: { maxEpochs: 3, maxObligations: 3 },
    });
    expect(promptLine(prompt, 'Current population').endsWith(': null')).toBe(true);
    expect(prompt).not.toContain('undefined');
    expect(warn).toHaveBeenCalledWith(
      '[StrictProductionPrompts] analyst prompt has no current population',
      expect.objectContaining({
        epoch: 1,
        populationCount: 0,
        selectedPath: 'render-null-current-population',
      })
    );
  });

  it('nulls missing identity fields of a malformed superseded population and warns', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn');
    const prompt = buildStrictAnalystPrompt({
      epoch: createStrictAnalysisEpochSnapshotV1({
        epoch: 2,
        context: createContext(),
        populations: [
          'legacy-population-payload',
          { revision: 1, observations: [{ observationId: 'observation:stale' }] },
          populationRow({
            revision: 2,
            parentPopulationHash: null,
            observationIds: ['observation:fact-base'],
          }),
        ],
        terminalObligationIds: ['base-1'],
        outstandingObligationIds: [],
      }),
      limits: { maxEpochs: 3, maxObligations: 3 },
    });
    const supersededLine = promptLine(prompt, 'Superseded populations');
    expect(JSON.parse(supersededLine.slice(supersededLine.indexOf('[')))).toEqual([
      { populationHash: null, revision: null, parentPopulationHash: null, status: 'superseded' },
      { populationHash: null, revision: 1, parentPopulationHash: null, status: 'superseded' },
    ]);
    expect(prompt).not.toContain('observation:stale');
    expect(prompt).not.toContain('legacy-population-payload');
    expect(warn).toHaveBeenCalledWith(
      '[StrictProductionPrompts] superseded population identity incomplete',
      expect.objectContaining({
        epoch: 2,
        supersededIndexes: [0, 1],
        selectedPath: 'render-null-identity-fields',
      })
    );
  });
});

// C27：上下文投影的 5 个可空 hash 字段只接受 null 或非空字符串。undefined 曾被投影接受，
// 随后在 retry 校验里因 `undefined !== null` 被误报为“已达 fixpoint”；数字与空串也曾进入 contextHash。
describe('strict analysis context nullable hash fields', () => {
  const NULLABLE_CONTEXT_FIELDS = [
    'expansionHeadHash',
    'finalExpandedScheduleHash',
    'analysisFixpointHash',
    'privateCorpusRevision',
    'hypothesisExpressionSetHash',
  ] as const;

  it.each(
    NULLABLE_CONTEXT_FIELDS.flatMap((field) => [
      [field, 'undefined', undefined],
      [field, 'an empty string', ''],
      [field, 'a blank string', '   '],
      [field, 'a number', 42],
    ])
  )('rejects %s given %s with a field-specific code', (field, _label, value) => {
    expect(() => createContext({ [field]: value } as never)).toThrow(
      new RegExp(`^STRICT_CONTEXT_${field.toUpperCase()}_INVALID$`, 'u')
    );
  });

  it('rejects a context whose nullable field key is missing entirely', () => {
    const { schemaVersion: _version, contextHash: _hash, ...input } = createContext();
    const { analysisFixpointHash: _omitted, ...withoutField } = input;
    expect(() => createStrictAnalysisContextProjectionV1(withoutField as never)).toThrow(
      /^STRICT_CONTEXT_ANALYSISFIXPOINTHASH_INVALID$/u
    );
  });

  it('keeps null and non-empty values and the existing context hash format', () => {
    // 合法输入的 contextHash 与收紧前逐字节一致（钉住收紧前在 HEAD 上计算的值）。
    expect(createContext().contextHash).toBe(
      'bab0b87ca4778c9cbc1cf1929c28c32e85d54a112283c2d14571798c1527aa76'
    );
    const filled = createContext({
      expansionHeadHash: 'head-1',
      finalExpandedScheduleHash: 'final-1',
      analysisFixpointHash: 'fixpoint-1',
      privateCorpusRevision: 'revision-1',
      hypothesisExpressionSetHash: 'expression-set-1',
    });
    expect(filled).toMatchObject({
      expansionHeadHash: 'head-1',
      finalExpandedScheduleHash: 'final-1',
      analysisFixpointHash: 'fixpoint-1',
      privateCorpusRevision: 'revision-1',
      hypothesisExpressionSetHash: 'expression-set-1',
    });
    expect(filled.contextHash).toBe(
      '47a762b363cbcc109bc9a6785ee5940a2035d0d1756b0c0c0224ed7891bc4f17'
    );
  });

  it('fails an undefined final schedule at snapshot re-validation instead of a misleading retry code', () => {
    const initial = createInitialEpoch();
    const { schemaVersion: _version, snapshotHash: _hash, ...input } = initial;
    expect(() =>
      createStrictAnalysisEpochSnapshotV1({
        ...input,
        context: { ...initial.context, finalExpandedScheduleHash: undefined } as never,
      })
    ).toThrow(/^STRICT_CONTEXT_FINALEXPANDEDSCHEDULEHASH_INVALID$/u);
  });
});

// C29（U49-F10）：直接调用 validateStrictAnalysisEpochTransitionV1 覆盖 fail-closed 分支；
// 经 G1 evaluator 的同名分支由 strict-production-stages-gate-classification.test.ts 覆盖。
describe('strict analysis epoch transition fail-closed branches', () => {
  const LIMITS = { maxEpochs: 3, maxObligations: 3 };

  function snapshotInput(snapshot: StrictAnalysisEpochSnapshotV1) {
    const { schemaVersion: _version, snapshotHash: _hash, ...input } = snapshot;
    return input;
  }

  function rejectOutcome(observed: StrictAnalysisEpochSnapshotV1) {
    return createStrictAnalysisGateOutcomeV1({
      action: 'reject',
      reasonCode: 'analyst-rejected',
      observedEpochHash: observed.snapshotHash,
    });
  }

  function retryEpoch(input: {
    terminalObligationIds: readonly string[];
    outstandingObligationIds: readonly string[];
    finalExpandedScheduleHash?: string | null;
  }): StrictAnalysisEpochSnapshotV1 {
    const before = createInitialEpoch();
    const advanced = nextContext(before.context, {
      expansionHeadHash: 'head-2',
      obligationId: 'counter-1',
      factId: 'fact-counter',
      witnessId: 'witness-counter',
      populationHash: 'population-2',
    });
    const { schemaVersion: _version, contextHash: _hash, ...contextInput } = advanced;
    return createStrictAnalysisEpochSnapshotV1({
      epoch: 2,
      context: createStrictAnalysisContextProjectionV1({
        ...contextInput,
        finalExpandedScheduleHash: input.finalExpandedScheduleHash ?? null,
      }),
      populations: [{ populationId: 'population-main', revision: 2 }],
      terminalObligationIds: input.terminalObligationIds,
      outstandingObligationIds: input.outstandingObligationIds,
    });
  }

  function retryOutcome(observed: StrictAnalysisEpochSnapshotV1) {
    return createStrictAnalysisGateOutcomeV1({
      action: 'analysis_retry',
      reasonCode: 'counterquery-executed',
      observedEpochHash: observed.snapshotHash,
      enrolledObligationIds: ['counter-1'],
      executedObligationIds: ['counter-1'],
    });
  }

  it('accepts an unchanged reject and a well-formed retry as controls', () => {
    const before = createInitialEpoch();
    expect(
      validateStrictAnalysisEpochTransitionV1({
        before,
        after: before,
        outcome: rejectOutcome(before),
        limits: LIMITS,
      })
    ).toMatchObject({ action: 'reject', reasonCode: 'analyst-rejected' });
    const after = retryEpoch({
      terminalObligationIds: ['base-1', 'counter-1'],
      outstandingObligationIds: [],
    });
    expect(
      validateStrictAnalysisEpochTransitionV1({
        before,
        after,
        outcome: retryOutcome(before),
        limits: LIMITS,
      })
    ).toMatchObject({ action: 'analysis_retry', enrolledObligationIds: ['counter-1'] });
  });

  it.each([
    {
      label: 'epoch beyond maxEpochs',
      before: () =>
        createStrictAnalysisEpochSnapshotV1({ ...snapshotInput(createInitialEpoch()), epoch: 2 }),
      limits: { maxEpochs: 1, maxObligations: 3 },
    },
    {
      label: 'obligations beyond maxObligations',
      before: () =>
        createStrictAnalysisEpochSnapshotV1({
          epoch: 1,
          context: createContext({ factQueryObligationIds: ['base-1', 'base-2'] }),
          populations: [],
          terminalObligationIds: ['base-1', 'base-2'],
          outstandingObligationIds: [],
        }),
      limits: { maxEpochs: 3, maxObligations: 1 },
    },
  ])('rejects an entry snapshot with $label', ({ before, limits }) => {
    const snapshot = before();
    expect(() =>
      validateStrictAnalysisEpochTransitionV1({
        before: snapshot,
        after: snapshot,
        outcome: rejectOutcome(snapshot),
        limits,
      })
    ).toThrow(/^STRICT_ANALYSIS_LOOP_LIMIT_INVALID_AT_ENTRY$/u);
  });

  it('rejects a reject outcome whose after snapshot was mutated', () => {
    const before = createInitialEpoch();
    const after = createStrictAnalysisEpochSnapshotV1({
      ...snapshotInput(before),
      populations: [...before.populations, { populationId: 'population-shadow', revision: 2 }],
    });
    expect(() =>
      validateStrictAnalysisEpochTransitionV1({
        before,
        after,
        outcome: rejectOutcome(before),
        limits: LIMITS,
      })
    ).toThrow(/^STRICT_ANALYSIS_REJECT_MUTATED_EPOCH$/u);
  });

  it.each([
    ['runId', { runId: 'run-replaced' }],
    ['sourceRevisionVectorHash', { sourceRevisionVectorHash: 'vector-replaced' }],
    ['privateCorpusRevision', { privateCorpusRevision: 'revision-late' }],
    ['hypothesisExpressionSetHash', { hypothesisExpressionSetHash: 'expression-set-late' }],
  ] as const)('rejects %s identity drift between snapshots', (field, overrides) => {
    const before = createInitialEpoch();
    const after = createStrictAnalysisEpochSnapshotV1({
      ...snapshotInput(before),
      context: createContext(overrides),
    });
    expect(() =>
      validateStrictAnalysisEpochTransitionV1({
        before,
        after,
        outcome: rejectOutcome(before),
        limits: LIMITS,
      })
    ).toThrow(new RegExp(`^STRICT_ANALYSIS_EPOCH_IDENTITY_DRIFT: ${field}$`, 'u'));
  });

  it.each([
    ['FACTIDS', { factIds: [] }],
    ['WITNESSIDS', { witnessIds: [] }],
    ['POPULATIONHASHES', { populationHashes: [] }],
    ['EVIDENCEENTRYIDS', { evidenceEntryIds: [] }],
    ['QUESTIONIDS', { questionIds: [] }],
  ] as const)('rejects a context array %s that is not append-only', (code, overrides) => {
    const before = createInitialEpoch();
    const after = createStrictAnalysisEpochSnapshotV1({
      ...snapshotInput(before),
      context: createContext(overrides),
    });
    expect(() =>
      validateStrictAnalysisEpochTransitionV1({
        before,
        after,
        outcome: rejectOutcome(before),
        limits: LIMITS,
      })
    ).toThrow(new RegExp(`^STRICT_ANALYSIS_${code}_NOT_APPEND_ONLY$`, 'u'));
  });

  it('rejects removed fact query obligations as not append-only', () => {
    const before = createStrictAnalysisEpochSnapshotV1({
      epoch: 1,
      context: createContext({ factQueryObligationIds: ['base-1', 'base-2'] }),
      populations: [],
      terminalObligationIds: ['base-1', 'base-2'],
      outstandingObligationIds: [],
    });
    const after = createStrictAnalysisEpochSnapshotV1({
      ...snapshotInput(before),
      context: createContext({ factQueryObligationIds: ['base-1'] }),
      terminalObligationIds: ['base-1'],
    });
    expect(() =>
      validateStrictAnalysisEpochTransitionV1({
        before,
        after,
        outcome: rejectOutcome(before),
        limits: LIMITS,
      })
    ).toThrow(/^STRICT_ANALYSIS_FACTQUERYOBLIGATIONIDS_NOT_APPEND_ONLY$/u);
  });

  it('rejects a retry that moves a terminal obligation back to outstanding', () => {
    const before = createInitialEpoch();
    const after = retryEpoch({
      terminalObligationIds: ['counter-1'],
      outstandingObligationIds: ['base-1'],
    });
    expect(() =>
      validateStrictAnalysisEpochTransitionV1({
        before,
        after,
        outcome: retryOutcome(before),
        limits: LIMITS,
      })
    ).toThrow(/^STRICT_ANALYSIS_TERMINAL_OBLIGATIONS_NOT_APPEND_ONLY$/u);
  });

  it('reports retry after a real sealed schedule hash as retry-after-fixpoint', () => {
    const before = createInitialEpoch();
    const after = retryEpoch({
      terminalObligationIds: ['base-1', 'counter-1'],
      outstandingObligationIds: [],
      finalExpandedScheduleHash: 'final-sealed',
    });
    expect(() =>
      validateStrictAnalysisEpochTransitionV1({
        before,
        after,
        outcome: retryOutcome(before),
        limits: LIMITS,
      })
    ).toThrow(/^STRICT_ANALYSIS_RETRY_AFTER_FIXPOINT_FORBIDDEN$/u);
  });
});
