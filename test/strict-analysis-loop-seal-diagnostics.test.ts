import Logger from '@alembic/core/logging';
import { describe, expect, it, vi } from 'vitest';
import {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisGateOutcomeV1,
  type StrictAnalysisEpochSnapshotV1,
} from '../src/agent/production/StrictProductionPipeline.js';
import type { StrictProductionRuntimePortV1 } from '../src/agent/production/StrictProductionStages.js';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';
import type { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';

/**
 * C26：expansion port 的无参 seal 是唯一宿主仍在使用的兼容路径（跳过调用方预期 hash 核对，
 * 且早于 Agent 的 transition 校验封口）。该路径必须留下可定位的诊断；带预期 hash 的路径不报兼容。
 */

const COMPAT_MESSAGE =
  '[StrictAnalysisExpansionPort] seal without expected schedule hash (compatibility path)';

function createPort() {
  return createStrictAnalysisExpansionPortV1({
    baselineScheduleHash: 'schedule-baseline',
    baselineObligationIds: ['base-1'],
    knownFactFamilies: [],
    knownSubjectRefs: [],
    obligationCap: 1,
  });
}

function compatCalls(info: { mock: { calls: unknown[][] } }): unknown[][] {
  return info.mock.calls.filter(([text]) => text === COMPAT_MESSAGE);
}

function createOpenEpoch(): StrictAnalysisEpochSnapshotV1 {
  return createStrictAnalysisEpochSnapshotV1({
    epoch: 1,
    context: createStrictAnalysisContextProjectionV1({
      runId: 'run-seal-compat',
      journalId: 'journal-seal-compat',
      manifestHash: 'manifest-seal-compat',
      planCognitionHash: 'plan-cognition-seal-compat',
      planHash: 'plan-seal-compat',
      requiredUniverseHash: 'universe-seal-compat',
      baselineScheduleHash: 'schedule-baseline',
      expansionHeadHash: null,
      currentExpandedScheduleHash: 'schedule-baseline',
      finalExpandedScheduleHash: null,
      analysisFixpointHash: null,
      privateCorpusRevision: null,
      hypothesisExpressionSetHash: null,
      lensBindingsHash: 'lens-seal-compat',
      sourceArtifactHash: 'artifact-seal-compat',
      sourceRevisionVectorHash: 'vector-seal-compat',
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

describe('strict analysis expansion port no-argument seal diagnostics (C26)', () => {
  it('reports the no-expected-hash compatibility path when seal() is called without arguments', () => {
    const info = vi.spyOn(Logger.getInstance(), 'info');
    try {
      const port = createPort();
      const sealed = port.seal();
      expect(port.finalSchedule).toBe(sealed);
      const calls = compatCalls(info);
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toEqual({
        component: 'StrictAnalysisExpansionPortV1',
        compatibility: 'no-argument-seal',
        reason: 'caller-omitted-expected-final-schedule-hash',
        selectedPath: 'commit-without-expected-hash-check',
        alreadyFinal: false,
        baselineScheduleHash: 'schedule-baseline',
        finalExpandedScheduleHash: sealed.finalExpandedScheduleHash,
        expansionReceiptCount: 0,
        followUpCheck: 'agent-gate-seal-with-expected-hash',
      });
    } finally {
      info.mockRestore();
    }
  });

  it('reports a repeated no-argument seal as reusing the already final schedule', () => {
    const info = vi.spyOn(Logger.getInstance(), 'info');
    try {
      const port = createPort();
      const first = port.seal();
      expect(port.seal()).toBe(first);
      const calls = compatCalls(info);
      expect(calls).toHaveLength(2);
      expect(calls.map(([, meta]) => (meta as { alreadyFinal: boolean }).alreadyFinal)).toEqual([
        false,
        true,
      ]);
    } finally {
      info.mockRestore();
    }
  });

  it('does not report compatibility when the caller supplies an expected hash', () => {
    const info = vi.spyOn(Logger.getInstance(), 'info');
    try {
      const reference = createPort().seal();
      info.mockClear();
      const port = createPort();
      expect(() => port.seal('mismatched-schedule')).toThrow(
        'STRICT_ANALYSIS_FIXPOINT_SCHEDULE_MISMATCH'
      );
      expect(port.finalSchedule).toBeNull();
      const sealed = port.seal(reference.finalExpandedScheduleHash);
      expect(sealed.finalExpandedScheduleHash).toBe(reference.finalExpandedScheduleHash);
      expect(port.finalSchedule).toBe(sealed);
      expect(compatCalls(info)).toHaveLength(0);
    } finally {
      info.mockRestore();
    }
  });

  it('still commits the schedule when the real logger data observer throws', () => {
    const prior = Logger.instance;
    Logger.instance = null;
    const logger = Logger.getInstance({ console: false });
    let observed = 0;
    const callback = (entry: { message?: unknown }) => {
      if (entry.message === COMPAT_MESSAGE) {
        observed++;
        throw new Error('observer fixture failure');
      }
    };
    logger.on('data', callback);
    try {
      const port = createPort();
      const sealed = port.seal();
      expect(observed).toBe(1);
      expect(port.finalSchedule).toBe(sealed);
    } finally {
      logger.removeListener('data', callback);
      logger.destroy();
      Logger.instance = prior;
    }
  });

  it('makes the production host-style early no-argument seal observable through the strict gate', async () => {
    const info = vi.spyOn(Logger.getInstance(), 'info');
    try {
      const expansionPort = createPort();
      let current = createOpenEpoch();
      const runtimePort: StrictProductionRuntimePortV1 = {
        enabled: true,
        analysisLimits: { maxEpochs: 3, maxObligations: 3 },
        expansionPort,
        readAnalysisEpoch: () => current,
        buildProducerInput: (analysisArtifact) => ({
          analysisArtifact,
          producerEligibleHypothesisIds: [],
        }),
        // 模拟唯一宿主 finalize：在 Agent transition 校验之前无参 seal，再用结果构造 pass 快照。
        validateAnalystResult: (_source, observed) => {
          const finalSchedule = expansionPort.seal();
          const { schemaVersion: _v, contextHash: _h, ...contextInput } = observed.context;
          current = createStrictAnalysisEpochSnapshotV1({
            epoch: observed.epoch,
            context: createStrictAnalysisContextProjectionV1({
              ...contextInput,
              finalExpandedScheduleHash: finalSchedule.finalExpandedScheduleHash,
              analysisFixpointHash: 'analysis-fixpoint-host',
            }),
            populations: observed.populations,
            terminalObligationIds: observed.terminalObligationIds,
            outstandingObligationIds: observed.outstandingObligationIds,
          });
          return createStrictAnalysisGateOutcomeV1({
            action: 'pass',
            reasonCode: 'host-finalized',
            observedEpochHash: observed.snapshotHash,
          });
        },
        reviewProducerResult: () => ({ action: 'pass', pass: true, artifact: {} }),
      };
      const stages = new AgentStageFactoryRegistry().build('generateDimensionPipeline', {
        params: { needsCandidates: true },
        context: { strategyContext: { strictProduction: runtimePort } },
      });
      const output = await new PipelineStrategy({ stages }).execute(
        {
          id: 'strict-seal-compat',
          reactLoop: async () => ({
            reply: 'strict stage output',
            toolCalls: [],
            tokenUsage: { input: 1, output: 1 },
            iterations: 1,
          }),
        },
        { role: 'internal', content: 'seal compat probe', metadata: {} } as AgentMessage,
        { strategyContext: { strictProduction: runtimePort } }
      );
      expect(output.outcome).toBe('completed');
      expect(output.phases.analyst_fixpoint_gate).toMatchObject({ action: 'pass' });
      // 宿主的无参 seal 只报一次；Agent 随后的 seal(expectedHash) 走核对路径，不再报兼容。
      const calls = compatCalls(info);
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatchObject({ alreadyFinal: false, expansionReceiptCount: 0 });
    } finally {
      info.mockRestore();
    }
  });
});
