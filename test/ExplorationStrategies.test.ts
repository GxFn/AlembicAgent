import { describe, expect, it } from 'vitest';
import {
  effectiveMemoryFindingCount,
  STRATEGY_ANALYST,
  STRATEGY_PRODUCER,
  targetMemoryFindingCount,
  targetProducerSubmitCount,
} from '../src/agent/context/exploration/ExplorationStrategies.js';
import { PlanTracker } from '../src/agent/context/exploration/PlanTracker.js';
import { ExplorationTracker } from '../src/agent/context/index.js';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import { ActiveContext } from '../src/agent/memory/ActiveContext.js';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
import { SCAN_TASK_CONFIGS } from '../src/agent/prompts/scanPrompts.js';
import type { AgentRuntime, LoopContext } from '../src/agent/runtime/index.js';
import { createToolPipeline, DiagnosticsCollector } from '../src/agent/runtime/index.js';
import type { ToolResultEnvelope } from '../src/tools/kernel/index.js';
import type { ToolContext } from '../src/tools/kernel/registry.js';
import { handle as handleMemory } from '../src/tools/runtime/handlers/memory.js';
import { ScanProduce } from '../src/tools/runtime/toolsets/ScanProduce.js';
import { createTempProject } from './helpers/tempProject.js';

describe('analyst exploration strategy boundaries', () => {
  it('counts only persisted candidate submissions as producer progress', () => {
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'producer' },
      { maxIterations: 10 }
    );
    for (const action of ['search', 'detail', 'manage']) {
      tracker?.recordToolCall('knowledge', { action }, { status: 'success' });
    }
    tracker?.recordToolCall('knowledge', { action: 'submit' }, { status: 'duplicate_blocked' });
    expect(tracker?.totalSubmits).toBe(0);
    tracker?.recordToolCall(
      'knowledge',
      { action: 'submit' },
      { status: 'created', id: 'recipe-1', lifecycle: 'pending' }
    );
    expect(tracker?.totalSubmits).toBe(1);
  });
  it('keeps SCAN as a no-tool briefing phase and transitions to EXPLORE after one round', () => {
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'analyst' },
      { maxIterations: 12, searchBudget: 8 }
    );

    expect(tracker).not.toBeNull();
    expect(tracker?.phase).toBe('SCAN');
    expect(tracker?.getToolChoice()).toBe('none');

    tracker?.tick();
    const transition = tracker?.endRound({ hasNewInfo: false, submitCount: 0, toolNames: [] });

    expect(tracker?.phase).toBe('EXPLORE');
    expect(transition?.text).toContain('轻量计划阶段已完成');
  });

  it('does not let analyst text-only rounds leave EXPLORE before code evidence exists', () => {
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'analyst' },
      { maxIterations: 12, searchBudget: 8 }
    );

    expect(tracker).not.toBeNull();

    tracker?.tick();
    tracker?.endRound({ hasNewInfo: false, submitCount: 0, toolNames: [] });
    expect(tracker?.phase).toBe('EXPLORE');
    expect(tracker?.getToolChoice()).toBe('required');

    for (let i = 0; i < 5; i++) {
      tracker?.tick();
      tracker?.endRound({ hasNewInfo: false, submitCount: 0, toolNames: [] });
      const textResult = tracker?.onTextResponse();

      expect(tracker?.phase).toBe('EXPLORE');
      expect(tracker?.getToolChoice()).toBe('required');
      expect(textResult?.isFinalAnswer).toBe(false);
      expect(textResult?.shouldContinue).toBe(true);
      expect(textResult?.nudge).toContain('真实代码证据');
    }
  });

  it('allows analyst progress after at least one evidence tool call', () => {
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'analyst' },
      { maxIterations: 12, searchBudget: 8 }
    );

    expect(tracker).not.toBeNull();

    tracker?.tick();
    tracker?.endRound({ hasNewInfo: false, submitCount: 0, toolNames: [] });
    tracker?.tick();
    tracker?.recordToolCall(
      'code',
      { action: 'search', patterns: ['Repository', 'Manager'] },
      'Sources/App/Repository.swift:12: final class Repository'
    );
    tracker?.endRound({ hasNewInfo: true, submitCount: 0, toolNames: ['code'] });

    for (let i = 0; i < 4; i++) {
      tracker?.tick();
      tracker?.endRound({ hasNewInfo: false, submitCount: 0, toolNames: [] });
    }

    expect(tracker?.phase).toBe('VERIFY');
  });

  it('lets analyst phases converge once enough evidence-backed findings are recorded', () => {
    const budget = {
      idleRoundsToExit: 3,
      maxIterations: 20,
      maxSubmits: 10,
      searchBudget: 12,
      searchBudgetGrace: 3,
      softSubmitLimit: 10,
    };
    const metrics = {
      consecutiveIdleRounds: 0,
      evidenceToolCallCount: 2,
      iteration: 8,
      memoryFindingCount: 3,
      phaseRounds: 2,
      roundsSinceNewInfo: 0,
      searchRoundsInPhase: 2,
      submitCount: 0,
      totalToolCalls: 6,
    };

    expect(STRATEGY_ANALYST.transitions['EXPLORE→VERIFY'].onMetrics(metrics, budget)).toBe(true);
    expect(STRATEGY_ANALYST.transitions['VERIFY→RECORD'].onMetrics(metrics, budget)).toBe(true);
  });

  it('does not cap structured findings at six when the evidence surface is broad', () => {
    const budget = {
      idleRoundsToExit: 3,
      maxIterations: 20,
      maxSubmits: 10,
      searchBudget: 12,
      searchBudgetGrace: 3,
      softSubmitLimit: 10,
    };
    const metrics = {
      consecutiveIdleRounds: 0,
      evidenceToolCallCount: 19,
      iteration: 8,
      memoryFindingCount: 3,
      phaseRounds: 2,
      roundsSinceNewInfo: 0,
      searchRoundsInPhase: 2,
      submitCount: 0,
      totalToolCalls: 24,
    };

    expect(targetMemoryFindingCount(metrics)).toBe(10);
    expect(STRATEGY_ANALYST.transitions['RECORD→SUMMARIZE'].onMetrics(metrics, budget)).toBe(false);
    expect(
      STRATEGY_ANALYST.transitions['RECORD→SUMMARIZE'].onMetrics(
        { ...metrics, memoryFindingCount: 10 },
        budget
      )
    ).toBe(true);
  });

  it('keeps producer in PRODUCE until structured finding submit target is covered', () => {
    const budget = {
      idleRoundsToExit: 3,
      maxIterations: 24,
      maxSubmits: 10,
      searchBudget: 4,
      searchBudgetGrace: 3,
      softSubmitLimit: 10,
      targetSubmits: 6,
    };
    const metrics = {
      consecutiveIdleRounds: 0,
      evidenceToolCallCount: 0,
      iteration: 8,
      memoryFindingCount: 0,
      phaseRounds: 6,
      roundsSinceNewInfo: 3,
      searchRoundsInPhase: 0,
      submitCount: 1,
      totalToolCalls: 8,
      roundsSinceSubmit: 3,
    };

    expect(targetProducerSubmitCount(budget)).toBe(6);
    expect(STRATEGY_PRODUCER.transitions['PRODUCE→SUMMARIZE'].onMetrics?.(metrics, budget)).toBe(
      false
    );
    expect(
      STRATEGY_PRODUCER.transitions['PRODUCE→SUMMARIZE'].onMetrics?.(
        { ...metrics, submitCount: 6, roundsSinceSubmit: 0 },
        budget
      )
    ).toBe(true);
  });

  it('does not accept producer completion text before target submits are reached', () => {
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'producer' },
      { maxIterations: 10, pipelineType: 'producer', targetSubmits: 6 }
    );

    expect(tracker).not.toBeNull();
    tracker?.tick();
    tracker?.recordToolCall(
      'knowledge',
      { action: 'submit' },
      { id: 'candidate-1', status: 'created', lifecycle: 'pending' }
    );
    tracker?.endRound({ hasNewInfo: true, submitCount: 1, toolNames: ['knowledge'] });

    tracker?.tick();
    tracker?.endRound({ hasNewInfo: false, submitCount: 0, toolNames: [] });
    const earlyText = tracker?.onTextResponse(
      '所有 6 个知识候选已成功提交，覆盖了 Analyst 分析中的全部 6 项发现。无未提交发现，无阻断。'
    );

    expect(earlyText?.isFinalAnswer).toBe(false);
    expect(earlyText?.shouldContinue).toBe(true);

    for (let i = 2; i <= 6; i++) {
      tracker?.tick();
      tracker?.recordToolCall(
        'knowledge',
        { action: 'submit' },
        { id: `candidate-${i}`, status: 'created', lifecycle: 'pending' }
      );
      tracker?.endRound({ hasNewInfo: true, submitCount: 1, toolNames: ['knowledge'] });
    }

    tracker?.tick();
    tracker?.endRound({ hasNewInfo: false, submitCount: 0, toolNames: [] });
    const completeText = tracker?.onTextResponse(
      '所有 6 个知识候选已成功提交，覆盖了 Analyst 分析中的全部 6 项发现。无未提交发现，无阻断。'
    );

    expect(completeText?.isFinalAnswer).toBe(true);
    expect(completeText?.shouldContinue).toBe(false);
  });

  it.each([
    {
      label: 'lets producer final completion text stop after successful submissions',
      targetSubmits: undefined,
      count: 1,
      text: '## 候选生产总结\n已完成 1 个候选提交。无未提交发现，不需要 Analyst 补证。',
    },
    {
      label: 'recognizes Package K producer completion wording as terminal',
      targetSubmits: undefined,
      count: 1,
      text: '所有 6 个知识候选已成功提交，覆盖了 Analyst 分析中的全部 6 项发现。无未提交发现，无阻断。',
    },
    {
      label: 'recognizes Package M submitted/unsubmitted table as terminal',
      targetSubmits: undefined,
      count: 1,
      text: '## 提交完成报告\n\n**已提交候选**: 5\n**未提交**: 0\n\n覆盖情况：结构化发现已完成候选提交。',
    },
    {
      label: 'recognizes Package O mixed English completion summary as terminal',
      targetSubmits: undefined,
      count: 1,
      text: [
        'All 7 structured Analyst findings have been successfully submitted.',
        '',
        '## 提交总结',
        '- **提交候选数**: 7/7',
        '- **覆盖率**: 100%',
        '- **阻塞项**: 无',
      ].join('\n'),
    },
    {
      label: 'recognizes Package U all-structured-findings wording as terminal',
      targetSubmits: 6,
      count: 6,
      text: '所有 6 个结构化发现已全部提交完毕，无需继续。提交数: 6/6，未提交: 0，阻塞: 无。',
    },
    {
      label: 'recognizes Package W Analyst-confirmed completion summary as terminal',
      targetSubmits: 6,
      count: 6,
      text: [
        '所有 6 个 Analyst 已确认结构化发现均已提交，无重复、无遗漏。',
        '```json',
        '{"phase":"PRODUCE","status":"complete","totalSubmitted":6,"blockers":[],"unsubmittedFindings":[]}',
        '```',
      ].join('\n'),
    },
  ])('$label', ({ targetSubmits, count, text }) => {
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'producer' },
      { maxIterations: 10, pipelineType: 'producer', ...(targetSubmits ? { targetSubmits } : {}) }
    );
    expect(tracker).not.toBeNull();
    for (let i = 1; i <= count; i++) {
      tracker?.tick();
      tracker?.recordToolCall(
        'knowledge',
        { action: 'submit' },
        { id: `candidate-${i}`, status: 'created', lifecycle: 'pending' }
      );
      tracker?.endRound({ hasNewInfo: true, submitCount: 1, toolNames: ['knowledge'] });
    }
    tracker?.tick();
    tracker?.endRound({ hasNewInfo: false, submitCount: 0, toolNames: [] });
    const result = tracker?.onTextResponse(text);
    expect(result?.isFinalAnswer).toBe(true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.nudge).toBeNull();
  });

  it('keeps Producer focused on submit coverage instead of detail/tools exploration', async () => {
    const diagnostics = new DiagnosticsCollector();
    let executeCount = 0;
    const runtime = {
      id: 'producer-submit-boundary-runtime',
      presetName: 'test',
      container: null,
      dataRoot: '/tmp/alembic-agent-test',
      fileCache: null,
      lang: null,
      logger: { info: () => undefined, warn: () => undefined },
      aiProvider: null,
      policies: { get: () => null },
      toolRegistry: { getManifest: () => null },
      toolRouter: {
        execute: async (request: { toolId: string }) => {
          executeCount++;
          return {
            ok: true,
            status: 'success',
            text: 'ok',
            structuredContent:
              request.toolId === 'knowledge'
                ? {
                    id: 'recipe-1',
                    status: 'created',
                    lifecycle: 'pending',
                    title: 'FeatureCoordinator',
                  }
                : { ok: true },
            durationMs: 1,
            startedAt: new Date().toISOString(),
            toolId: request.toolId,
            callId: `producer-boundary-call-${executeCount}`,
          };
        },
      },
    } as unknown as AgentRuntime;
    const loopCtx = {
      allowedToolIds: ['code', 'graph', 'terminal', 'memory', 'knowledge', 'meta'],
      abortSignal: null,
      context: { pipelinePhase: 'produce' },
      diagnostics,
      iteration: 1,
      memoryCoordinator: null,
      sharedState: {
        submittedPatterns: new Set(),
        submittedTitles: new Set(),
        submittedTriggers: new Set(),
      },
      source: 'system',
      toolCalls: [],
      tracker: {
        pipelineType: 'producer',
        phase: 'PRODUCE',
        recordToolCall: () => ({ isNew: false }),
      },
      trace: null,
    } as unknown as LoopContext;
    const pipeline = createToolPipeline();

    const blockedDetail = await pipeline.execute(
      {
        id: 'knowledge-detail',
        name: 'knowledge',
        args: { action: 'detail', params: { id: 'r1' } },
      },
      { runtime, loopCtx, iteration: 1 }
    );
    const blockedMetaTools = await pipeline.execute(
      { id: 'meta-tools', name: 'meta', args: { action: 'tools', params: { tool: 'knowledge' } } },
      { runtime, loopCtx, iteration: 1 }
    );
    const blockedTerminal = await pipeline.execute(
      {
        id: 'terminal-run',
        name: 'terminal',
        args: { action: 'exec', params: { cmd: 'rg Producer' } },
      },
      { runtime, loopCtx, iteration: 1 }
    );
    const allowedSubmit = await pipeline.execute(
      {
        id: 'knowledge-submit',
        name: 'knowledge',
        args: {
          action: 'submit',
          params: {
            content: {
              markdown: 'Feature coordinator routes navigation ownership.',
              rationale: 'The recipe captures the source-grounded coordinator pattern.',
            },
            description: 'Feature coordinator recipe.',
            doClause: 'Use the coordinator to own navigation transitions.',
            kind: 'pattern',
            reasoning: { sources: ['Sources/App/FeatureCoordinator.swift'] },
            title: 'FeatureCoordinator',
            trigger: 'FeatureCoordinator',
            whenClause: 'When a feature owns navigation transitions.',
          },
        },
      },
      { runtime, loopCtx, iteration: 1 }
    );
    const allowedReview = await pipeline.execute(
      { id: 'meta-review', name: 'meta', args: { action: 'review', params: {} } },
      { runtime, loopCtx, iteration: 1 }
    );

    expect(blockedDetail.metadata.blocked).toBe(true);
    expect(blockedMetaTools.metadata.blocked).toBe(true);
    expect(blockedTerminal.metadata.blocked).toBe(true);
    expect(allowedSubmit.metadata.blocked).toBe(false);
    expect(allowedReview.metadata.blocked).toBe(false);
    expect(loopCtx.sharedState?._producerSubmitLedger).toMatchObject({
      createdCount: 1,
      entries: [
        {
          payloadStored: true,
          requiredFieldsComplete: true,
          sourceCount: 1,
          status: 'created',
          title: 'FeatureCoordinator',
        },
      ],
    });
    expect(executeCount).toBe(2);
  });
});

function tracker() {
  const value = new ExplorationTracker(STRATEGY_ANALYST, { maxIterations: 20 });
  value.tick();
  value.endRound({});
  return value;
}
function fixture(
  value: ExplorationTracker,
  payload: unknown,
  status: ToolResultEnvelope['status'] = 'success',
  trace: ActiveContext | null = null
) {
  let calls = 0;
  const runtime = {
    id: 'r06-probe',
    presetName: 'test',
    projectRoot: '.',
    dataRoot: 'tmp/agent-context-review-2026-09-26',
    fileCache: null,
    lang: null,
    logger: { info() {}, warn() {} },
    aiProvider: null,
    policies: {
      get() {
        return null;
      },
    },
    toolRegistry: {
      getManifest() {
        return null;
      },
    },
    toolRouter: {
      async execute(request: { toolId: string }) {
        calls++;
        return {
          ok: status === 'success' || status === 'partial',
          status,
          text: 'controlled fixture',
          structuredContent: payload,
          toolId: request.toolId,
          callId: `probe-${calls}`,
          startedAt: new Date().toISOString(),
          durationMs: 1,
        };
      },
    },
  } as unknown as AgentRuntime;
  const loopCtx = {
    allowedToolIds: ['code', 'graph', 'terminal', 'memory', 'knowledge'],
    abortSignal: null,
    context: { pipelinePhase: 'analyze' },
    diagnostics: null,
    iteration: 2,
    memoryCoordinator: null,
    sharedState: {},
    source: 'system',
    toolCalls: [],
    tracker: value,
    trace,
  } as unknown as LoopContext;
  return { runtime, loopCtx, iteration: 2 };
}

describe('R06 real pipeline exploration observations', () => {
  it.each([
    'error',
    'blocked',
    'aborted',
    'timeout',
  ] as const)('does not promote %s into code evidence', async (status) => {
    const t = tracker();
    const output = await createToolPipeline().execute(
      { id: 'read', name: 'code', args: { action: 'read', params: { path: 'src/unread.ts' } } },
      fixture(t, { path: 'src/unread.ts', content: 'inaccessible' }, status)
    );
    expect(output.metadata.isNew).toBe(false);
    expect(t.metrics.evidenceToolCallCount).toBe(0);
    expect(t.metrics.totalToolCalls).toBe(1);
  });
  it('records successful nested V2 read paths and structured search discoveries', async () => {
    const t = tracker();
    const pipeline = createToolPipeline();
    const output = await pipeline.execute(
      { id: 'read', name: 'code', args: { action: 'read', params: { path: 'src/actual.ts' } } },
      fixture(t, 'export const actual = 1;')
    );
    await pipeline.execute(
      { id: 'search', name: 'code', args: { action: 'search', params: { pattern: 'actual' } } },
      fixture(t, {
        total: 1,
        shown: 1,
        matches: [{ file: 'src/other.ts', line: 1, content: 'export const actual = 2;' }],
      })
    );
    expect(output.metadata.isNew).toBe(true);
    expect(t.metrics.uniqueFiles).toBe(2);
    expect(t.metrics.uniquePatterns).toBe(1);
  });
  it('distinguishes different graph entities through the real nested V2 call shape', async () => {
    const t = tracker();
    const pipeline = createToolPipeline();
    const a = await pipeline.execute(
      {
        id: 'a',
        name: 'graph',
        args: { action: 'query', params: { type: 'class', entity: 'Alpha' } },
      },
      fixture(t, { className: 'Alpha' })
    );
    const b = await pipeline.execute(
      {
        id: 'b',
        name: 'graph',
        args: { action: 'query', params: { type: 'class', entity: 'Beta' } },
      },
      fixture(t, { className: 'Beta' })
    );
    expect(a.metadata.isNew).toBe(true);
    expect(b.metadata.isNew).toBe(true);
    expect(t.metrics.uniqueQueries).toBe(2);
  });
  it('does not complete a plan step when its read failed', async () => {
    const t = tracker();
    const trace = new ActiveContext();
    trace.setPlan('1. Read src/actual.ts', 1);
    trace.startRound(2);
    await createToolPipeline().execute(
      { id: 'read', name: 'code', args: { action: 'read', params: { path: 'src/actual.ts' } } },
      fixture(t, { error: 'permission denied' }, 'error', trace)
    );
    t.updatePlanProgress(trace);
    expect(trace.getPlan()?.steps[0].status).toBe('pending');
  });
  it('does not finish one concrete file plan while reading another', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. Read src/auth.ts', 1);
    trace.startRound(2);
    trace.recordToolCall(
      'code',
      { action: 'read', params: { path: 'src/payment.ts' } },
      { content: 'export const payment=1;' },
      true
    );
    plans.updatePlanProgress(trace);
    expect(trace.getPlan()?.steps[0].status).toBe('pending');
  });
  it('does not transfer unverified depth credit onto other verified findings', async () => {
    const dataRoot = createTempProject('exploration-depth-');
    const ledger = new EvidenceLedgerStore({
      dataRoot,
      jobId: 'probe',
      sessionId: 'probe',
      dimensionId: 'probe',
    });
    const file = ledger.append({
      tool: 'code.read',
      callId: 'read',
      file: 'src/a.ts',
      range: { start: 1, end: 1 },
      content: 'export const a=1;',
    });
    const overview = ledger.append({
      tool: 'graph.overview',
      callId: 'graph',
      content: 'Architecture overview without a file',
    });
    const coordinator = new MemoryCoordinator();
    coordinator.createDimensionScope('probe');
    const t = tracker();
    for (let i = 0; i < 4; i++) {
      const verified = i < 2;
      const params = {
        finding: `finding-${i}`,
        evidenceRefs: [verified ? file.id : overview.id],
        importance: 5,
        ...(!verified ? { designIntent: 'A hypothesis not backed by a source file.' } : {}),
      };
      const result = await handleMemory('note_finding', params, {
        memoryCoordinator: coordinator,
        runtime: { evidenceLedger: ledger, dimensionScopeId: 'probe' },
      } as unknown as ToolContext);
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ recorded: true, verified });
      t.recordToolCall('memory', { action: 'note_finding', params }, result.data);
    }
    expect(t.metrics.verifiedFindingCount).toBe(2);
    expect(effectiveMemoryFindingCount(t.metrics)).toBe(2);
  });
});

describe('R06 nudge truth and retained behavior controls', () => {
  it('does not claim submit starvation while producer receipts continue to arrive', () => {
    const t = ExplorationTracker.resolve(
      { source: 'system', strategy: 'producer' },
      { maxIterations: 24, targetSubmits: 10 }
    );
    if (!t) {
      throw new Error('Producer fixture must resolve');
    }
    for (let i = 1; i <= 9; i++) {
      t.tick();
      t.recordToolCall(
        'knowledge',
        { action: 'submit', params: {} },
        { status: 'created', id: `candidate-${i}`, lifecycle: 'pending' }
      );
      t.endRound({ hasNewInfo: false, submitCount: 1, toolNames: ['knowledge'] });
    }
    t.tick();
    expect(t.totalSubmits).toBe(9);
    expect(t.getNudge(null)?.type).not.toBe('convergence');
  });
  it('retains legacy flat read input and usable partial evidence', async () => {
    const t = tracker();
    const result = await createToolPipeline().execute(
      { id: 'legacy', name: 'code', args: { action: 'read', path: 'src/legacy.ts' } },
      fixture(t, 'usable partial body', 'partial')
    );
    expect(result.metadata.isNew).toBe(true);
    expect(t.metrics).toMatchObject({
      uniqueFiles: 1,
      evidenceToolCallCount: 1,
      totalToolCalls: 1,
    });
  });
  it('retains two allowed terminal attempts after the ordinary exploration budget', () => {
    const t = new ExplorationTracker(STRATEGY_ANALYST, { maxIterations: 2 });
    t.tick();
    expect(t.shouldExit()).toBe(false);
    t.endRound({});
    t.tick();
    expect(t.shouldExit()).toBe(false);
    expect(t.getToolChoice()).toBe('none');
    t.endRound({});
    t.tick();
    expect(t.shouldExit()).toBe(false);
    expect(t.getToolChoice()).toBe('none');
    t.endRound({});
    t.tick();
    expect(t.shouldExit()).toBe(true);
  });
  it('retains successful generic plan matching', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. Read a representative file', 1);
    trace.startRound(2);
    trace.recordToolCall(
      'code',
      { action: 'read', params: { path: 'src/a.ts' } },
      'complete file',
      true
    );
    plans.updatePlanProgress(trace);
    expect(trace.getPlan()?.steps[0].status).toBe('done');
  });
});

function crossTracker() {
  const t = new ExplorationTracker(STRATEGY_ANALYST, { maxIterations: 20 });
  t.tick();
  t.endRound({});
  return t;
}
function crossEnvelope(data?: unknown): ToolResultEnvelope {
  return {
    ok: true,
    status: 'success',
    toolId: 'code',
    callId: 'probe',
    text: 'actual source content',
    startedAt: new Date().toISOString(),
    durationMs: 1,
    ...(data === undefined ? {} : { structuredContent: data }),
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [],
      timedOutStages: [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [],
    },
    trust: {
      source: 'internal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}
function crossFixture(
  t: ExplorationTracker,
  result: ToolResultEnvelope,
  trace: ActiveContext | null = null
) {
  const runtime = {
    id: 'cross-probe',
    presetName: 'test',
    projectRoot: '.',
    dataRoot: 'tmp',
    logger: { info() {}, warn() {} },
    policies: {
      get() {
        return null;
      },
    },
    toolRegistry: {
      getManifest() {
        return null;
      },
    },
    toolRouter: {
      async execute() {
        return result;
      },
    },
  } as unknown as AgentRuntime;
  const loopCtx = {
    tracker: t,
    trace,
    allowedToolIds: ['code'],
    allowedToolActions: { code: ['read'] },
    abortSignal: null,
    context: { pipelinePhase: 'analyze' },
    source: 'system',
    sharedState: {},
    toolCalls: [],
    iteration: 2,
    memoryCoordinator: null,
  } as unknown as LoopContext;
  return { runtime, loopCtx, iteration: 2 };
}
describe('independent R06 repaired-boundary cases', () => {
  it('keeps failed batch paths out of observed file novelty', async () => {
    const t = crossTracker();
    const result = crossEnvelope({
      mode: 'batch',
      files: [
        { ok: true, path: 'src/good.ts', content: 'export const good = 1;' },
        { ok: false, path: 'src/missing.ts', error: 'Not found' },
      ],
      summary: { requested: 2, succeeded: 1, failed: 1, partialFailure: true },
    });
    await createToolPipeline().execute(
      {
        id: 'batch',
        name: 'code',
        args: { action: 'read', params: { filePaths: ['src/good.ts', 'src/missing.ts'] } },
      },
      crossFixture(t, result)
    );
    expect(t.metrics.uniqueFiles).toBe(1);
    const recovered = await createToolPipeline().execute(
      {
        id: 'recovered',
        name: 'code',
        args: { action: 'read', params: { path: 'src/missing.ts' } },
      },
      crossFixture(t, crossEnvelope('export const recovered = 1;'))
    );
    expect(recovered.metadata.isNew).toBe(true);
  });
  it('does not complete the failed member of a partially successful batch read', async () => {
    const t = crossTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. Read src/missing.ts', 1);
    trace.startRound(2);
    const result = crossEnvelope({
      mode: 'batch',
      files: [
        { ok: true, path: 'src/good.ts', content: 'export const good=1;' },
        { ok: false, path: 'src/missing.ts', error: 'Not found' },
      ],
    });
    await createToolPipeline().execute(
      {
        id: 'batch',
        name: 'code',
        args: { action: 'read', params: { filePaths: ['src/good.ts', 'src/missing.ts'] } },
      },
      crossFixture(t, result, trace)
    );
    t.updatePlanProgress(trace);
    expect(trace.getPlan()?.steps[0].status).toBe('pending');
  });
  it('keeps a successful text-only host envelope eligible for plan progress', async () => {
    const t = crossTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. Read src/a.ts', 1);
    trace.startRound(2);
    await createToolPipeline().execute(
      { id: 'read', name: 'code', args: { action: 'read', params: { path: 'src/a.ts' } } },
      crossFixture(t, crossEnvelope(), trace)
    );
    t.updatePlanProgress(trace);
    expect(trace.getCurrentRoundActions()[0]?.ok).toBe(true);
    expect(trace.getPlan()?.steps[0].status).toBe('done');
  });
  it('matches the exact file target despite sentence punctuation', () => {
    const p = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. Read src/auth.ts.', 1);
    trace.startRound(2);
    trace.recordToolCall(
      'code',
      { action: 'read', params: { path: 'src/auth.ts' } },
      'actual file',
      true
    );
    p.updatePlanProgress(trace);
    expect(trace.getPlan()?.steps[0].status).toBe('done');
  });
  it('does not use a path substring as exact file completion', () => {
    const p = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. Read src/auth.ts', 1);
    trace.startRound(2);
    trace.recordToolCall(
      'code',
      { action: 'read', params: { path: 'src/auth.tsx' } },
      'actual different file',
      true
    );
    p.updatePlanProgress(trace);
    expect(trace.getPlan()?.steps[0].status).toBe('pending');
  });
  it('keeps the scan repair route consistent with its actual callable contract', async () => {
    const cap = new ScanProduce();
    expect(cap.allowedTools.code).toContain('read');
    expect(cap.allowedTools.evidence).toBeUndefined();
    for (const config of Object.values(SCAN_TASK_CONFIGS)) {
      expect(config.producePrompt).not.toContain('禁止补读源码');
      expect(config.producePrompt).not.toContain('仅可从已有 evidence 台账检索支撑');
    }
  });
});

it('preserves the analyst verification phase before recording and summary', () => {
  expect(STRATEGY_ANALYST.phases).toEqual(['SCAN', 'EXPLORE', 'VERIFY', 'RECORD', 'SUMMARIZE']);
});
