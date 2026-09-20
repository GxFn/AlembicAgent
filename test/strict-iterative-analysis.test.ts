import { createFinalExpandedMiningScheduleReceiptV1 } from '@alembic/core/production';
import { describe, expect, it, vi } from 'vitest';
import {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisGateOutcomeV1,
  type StrictAnalysisContextProjectionV1,
  type StrictAnalysisEpochSnapshotV1,
  type StrictAnalysisGateOutcomeV1,
} from '../src/agent/production/StrictProductionPipeline.js';
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
