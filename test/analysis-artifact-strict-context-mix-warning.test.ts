import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ActiveContextLike,
  buildAnalysisArtifact,
} from '../src/agent/evaluation/analysisArtifact.js';
import { ActiveContext } from '../src/agent/memory/ActiveContext.js';
import {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisExpansionPortV1,
} from '../src/agent/production/StrictProductionPipeline.js';

// 背景（module-review L7 / P27，问题 C45）：buildAnalysisArtifact 只有在 strictColdStart=true 时
// 才把严格路径与 legacy reply / tool trace / note_finding 隔离；未开启时，一旦 ActiveContext
// 带着 strictAnalysisContext（例如 ActiveContext.fromJSON 恢复的严格上下文），工件会把严格投影
// 与 legacy 派生 findings 混在一起透传。是否删除 strictColdStart 选项属于待决定④，落地前不改
// 公开参数与透传行为，只对“有严格上下文但未开启 strictColdStart”的组合打可定位告警。

const MIX_LOG_MESSAGE =
  '[AnalysisArtifact] strict analysis context passed through a legacy (non-cold-start) artifact';

const finalSchedule = createStrictAnalysisExpansionPortV1({
  baselineScheduleHash: 'schedule-1',
  baselineObligationIds: ['base-1'],
  knownFactFamilies: [],
  knownSubjectRefs: [],
  obligationCap: 1,
}).seal();

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
  factQueryObligationIds: ['base-1'],
  analysisUnitIds: ['unit-1'],
  factIds: ['fact-a'],
  witnessIds: ['witness-a'],
  populationHashes: ['population-1'],
  clusterSetHashes: ['cluster-set-1'],
  inductionReceiptHashes: ['induction-1'],
  hypothesisIds: ['hypothesis-1'],
  falsificationReceiptHashes: ['falsification-1'],
  dispositionReviewIds: ['review-1'],
  evidenceEntryIds: ['E-1'],
  derivedFindingCount: 0,
});

function restoredStrictContext(): ActiveContextLike {
  // 与生产恢复路径一致：严格上下文经 toJSON/fromJSON 恢复后，legacy scratchpad 仍在。
  const activeContext = new ActiveContext();
  activeContext.bindStrictAnalysisContext(strictContext);
  activeContext.noteKeyFinding('legacy scratchpad finding', 'src/live.ts:1', 8);
  return ActiveContext.fromJSON(activeContext.toJSON());
}

function spyWarn() {
  // winston 的 warn 返回 Logger 本身；mock 返回同一实例以满足签名，不触发真实输出。
  return vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => Logger.getInstance());
}

function mixLogs(warn: ReturnType<typeof spyWarn>) {
  return warn.mock.calls.filter(([msg]) => msg === MIX_LOG_MESSAGE);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildAnalysisArtifact strict context without strictColdStart (C45)', () => {
  it('warns with locating fields while keeping the current pass-through behavior', () => {
    const warn = spyWarn();
    const artifact = buildAnalysisArtifact(
      { reply: 'legacy reply', toolCalls: [] },
      'architecture',
      null,
      restoredStrictContext()
    );

    // 行为保持不变（决定④前不收窄）：严格投影照旧透传，legacy findings 照旧进入工件。
    expect(artifact.strictAnalysisContext).toEqual(strictContext);
    expect(artifact.findings.map((f) => f.finding)).toEqual(['legacy scratchpad finding']);

    const logs = mixLogs(warn);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.[1]).toMatchObject({
      reasonCode: 'strict-context-without-strict-cold-start',
      dimensionId: 'architecture',
      strictColdStart: false,
      contextHash: strictContext.contextHash,
      memoryFindingCount: 1,
      derivedFindingCount: 0,
      legacyToolCallCount: 0,
      postHocLiveReadCount: 0,
      resolution: 'pass-through-mixed',
    });
  });

  it('stays silent on the isolated strict cold-start path', () => {
    const warn = spyWarn();
    const artifact = buildAnalysisArtifact(
      { reply: 'legacy reply', toolCalls: [] },
      'architecture',
      null,
      restoredStrictContext(),
      { strictColdStart: true }
    );
    expect(artifact.findings).toEqual([]);
    expect(mixLogs(warn)).toHaveLength(0);
  });

  it('stays silent on the plain legacy path without a strict context', () => {
    const warn = spyWarn();
    const legacy = new ActiveContext();
    legacy.noteKeyFinding('legacy only', 'src/live.ts:1', 8);
    const artifact = buildAnalysisArtifact(
      { reply: 'legacy reply', toolCalls: [] },
      'architecture',
      null,
      legacy
    );
    expect(artifact).not.toHaveProperty('strictAnalysisContext');
    expect(mixLogs(warn)).toHaveLength(0);
  });
});
