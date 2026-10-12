import { readFileSync } from 'node:fs';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGenerateStrategy,
  type ExplorationStrategy,
  type ExplorationTrace,
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
    // L4-P30（I44）：扫描 Produce 开放只读 evidence.get/search 作为拒绝后的自救通道，
    // 阶段提示不能再说 evidence 工具未开放。
    expect(cap.allowedTools.evidence).toEqual(['get', 'search']);
    for (const config of Object.values(SCAN_TASK_CONFIGS)) {
      expect(config.producePrompt).not.toContain('禁止补读源码');
      expect(config.producePrompt).not.toContain('仅可从已有 evidence 台账检索支撑');
      expect(config.producePrompt).not.toContain('未开放的 evidence');
    }
    expect(SCAN_TASK_CONFIGS.extract.producePrompt).toContain('evidence.search');
  });
});

it('preserves the analyst verification phase before recording and summary', () => {
  expect(STRATEGY_ANALYST.phases).toEqual(['SCAN', 'EXPLORE', 'VERIFY', 'RECORD', 'SUMMARIZE']);
});

/**
 * L5-P17（I07）：阶段门放行的动作必须同时被能力白名单和真实 handler 接受，阻断文案也不能
 * 推荐会被下一道门或 handler 拒绝的调用，否则模型按文案重试只会白耗一轮预算。
 */
function phaseGateFixture(input: {
  allowedToolIds: string[];
  tracker: { pipelineType: string; phase: string };
}) {
  const diagnostics = new DiagnosticsCollector();
  const dispatched: string[] = [];
  const runtime = {
    id: 'phase-gate-alignment',
    presetName: 'test',
    container: null,
    dataRoot: 'tmp/phase-gate-alignment',
    fileCache: null,
    lang: null,
    logger: { info: () => undefined, warn: () => undefined },
    aiProvider: null,
    policies: { get: () => null },
    toolRegistry: { getManifest: () => null },
    toolRouter: {
      async execute(request: { toolId: string; args: Record<string, unknown> }) {
        dispatched.push(`${request.toolId}.${String(request.args?.action ?? '')}`);
        return {
          ok: true,
          status: 'success',
          text: 'ok',
          structuredContent: { ok: true },
          toolId: request.toolId,
          callId: `phase-gate-${dispatched.length}`,
          startedAt: new Date().toISOString(),
          durationMs: 1,
        };
      },
    },
  } as unknown as AgentRuntime;
  const loopCtx = {
    allowedToolIds: input.allowedToolIds,
    abortSignal: null,
    context: {},
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
    tracker: { ...input.tracker, recordToolCall: () => ({ isNew: false }) },
    trace: null,
  } as unknown as LoopContext;
  return { context: { runtime, loopCtx, iteration: 1 }, diagnostics, dispatched };
}

function blockedError(result: unknown): string {
  if (result && typeof result === 'object' && 'error' in result) {
    return String((result as { error?: unknown }).error ?? '');
  }
  return '';
}

describe('phase gates stay aligned with handlers and capability allowlists', () => {
  it('blocks producer code.read in PRODUCE even when the stage allowlists code, and never recommends it', async () => {
    // allowedToolIds 显式包含 code：否则 allowlistGate 先拦截，本门根本不会被执行到。
    const { context, diagnostics, dispatched } = phaseGateFixture({
      allowedToolIds: ['code', 'knowledge', 'memory', 'evidence', 'meta'],
      tracker: { pipelineType: 'producer', phase: 'PRODUCE' },
    });
    const output = await createToolPipeline().execute(
      { id: 'producer-read', name: 'code', args: { action: 'read', params: { path: 'src/a.ts' } } },
      context
    );
    expect(output.metadata.blocked).toBe(true);
    expect(dispatched).toEqual([]);
    const error = blockedError(output.result);
    expect(error).toContain('Producer phase is submit-first');
    // 阻断文案只能推荐 GenerateProduce 白名单里真实可调用的动作。
    expect(error).not.toContain('code.read');
    for (const allowed of ['knowledge.submit', 'evidence.get', 'memory.recall', 'meta.review']) {
      expect(error).toContain(allowed);
    }
    expect(diagnostics.toJSON().blockedTools).toEqual([{ tool: 'code', reason: error }]);
  });

  it('blocks every producer tool call in SUMMARIZE, including knowledge.submit', async () => {
    const { context, diagnostics, dispatched } = phaseGateFixture({
      allowedToolIds: ['knowledge', 'memory', 'evidence', 'meta'],
      tracker: { pipelineType: 'producer', phase: 'SUMMARIZE' },
    });
    const output = await createToolPipeline().execute(
      {
        id: 'producer-late-submit',
        name: 'knowledge',
        args: { action: 'submit', params: { title: 'LateCandidate' } },
      },
      context
    );
    expect(output.metadata.blocked).toBe(true);
    expect(dispatched).toEqual([]);
    expect(blockedError(output.result)).toContain('Producer is already in SUMMARIZE');
    expect(diagnostics.toJSON().blockedTools).toMatchObject([{ tool: 'knowledge' }]);
  });

  it.each([
    {
      label: 'path only',
      args: { action: 'query', params: { type: 'callers', path: 'src/a.ts' } },
    },
    {
      label: 'symbol only',
      args: { action: 'query', params: { type: 'callers', symbol: 'Alpha' } },
    },
    { label: 'name only', args: { action: 'query', params: { type: 'class', name: 'Alpha' } } },
    {
      label: 'blank entity',
      args: { action: 'query', params: { type: 'callers', entity: '   ' } },
    },
    {
      label: 'non-string entity',
      args: { action: 'query', params: { type: 'callers', entity: 42 } },
    },
    {
      // graph handler 只读取嵌套 params.entity；嵌套 params 之外的 entity 到不了 handler。
      label: 'entity outside nested params',
      args: { action: 'query', entity: 'Alpha', params: { type: 'callers' } },
    },
  ])('blocks analyst VERIFY graph.query with $label because the graph handler requires entity', async ({
    args,
  }) => {
    const { context, diagnostics, dispatched } = phaseGateFixture({
      allowedToolIds: ['code', 'graph', 'memory', 'evidence'],
      tracker: { pipelineType: 'analyst', phase: 'VERIFY' },
    });
    const output = await createToolPipeline().execute(
      { id: 'verify-graph', name: 'graph', args },
      context
    );
    expect(output.metadata.blocked).toBe(true);
    expect(dispatched).toEqual([]);
    const error = blockedError(output.result);
    expect(error).toContain('Analyst VERIFY is evidence-only');
    expect(error).toContain('with entity');
    expect(error).not.toContain('entity/path');
    expect(diagnostics.toJSON().blockedTools).toMatchObject([{ tool: 'graph' }]);
  });

  it.each([
    {
      label: 'nested params.entity',
      args: { action: 'query', params: { type: 'callers', entity: 'Alpha' } },
    },
    { label: 'flat entity', args: { action: 'query', type: 'callers', entity: 'Alpha' } },
  ])('allows a focused analyst VERIFY graph.query with $label', async ({ args }) => {
    const { context, dispatched } = phaseGateFixture({
      allowedToolIds: ['code', 'graph', 'memory', 'evidence'],
      tracker: { pipelineType: 'analyst', phase: 'VERIFY' },
    });
    const output = await createToolPipeline().execute(
      { id: 'verify-graph', name: 'graph', args },
      context
    );
    expect(output.metadata.blocked).toBe(false);
    expect(dispatched).toEqual(['graph.query']);
  });
});

/**
 * L6-P16（C16–C19）：PlanTracker 的偏差 replan 只由“连续 3 轮计划外探索动作”触发，deviationScore
 * 退为“自上次计划起的计划外动作占比”诊断值；语义回退不再让搜索完成总结步骤，也不把 Node.js/e.g
 * 当文件目标；记录类与失败动作不计入偏离；replan 被抑制时要能看到原因；trace 端口只有 ExplorationTrace。
 */
type PlanCall = [tool: string, args: Record<string, unknown>, result: unknown];

function planCheckState(
  iteration: number,
  overrides: {
    phase?: string;
    maxIterations?: number;
    replanInterval?: number;
    pipelineType?: 'scan' | 'bootstrap' | 'analyst' | 'producer';
  } = {}
) {
  return {
    phase: overrides.phase ?? 'EXPLORE',
    metrics: { iteration },
    budget: { maxIterations: overrides.maxIterations ?? 24 },
    strategy: { replanInterval: overrides.replanInterval ?? 8 },
    pipelineType: overrides.pipelineType ?? 'analyst',
    isTerminalPhase: false,
  };
}

function runPlanRound(
  plans: PlanTracker,
  trace: ActiveContext,
  iteration: number,
  calls: PlanCall[]
) {
  trace.startRound(iteration);
  for (const [tool, args, result] of calls) {
    trace.recordToolCall(tool, args, result, true);
  }
  plans.updatePlanProgress(trace);
}

const offPlanRead: PlanCall = [
  'code',
  { action: 'read', params: { path: 'src/unrelated.ts' } },
  'export const unrelated = 1;',
];
const recordedFinding: PlanCall = [
  'memory',
  {
    action: 'note_finding',
    params: { finding: 'Auth guard wraps every route', evidenceRefs: ['E-1'], importance: 5 },
  },
  { recorded: true, target: 'activeContext', verified: true },
];
const failedPlannedRead: PlanCall = [
  'code',
  { action: 'read', params: { path: 'src/auth.ts' } },
  { error: 'permission denied' },
];

function stepStatuses(trace: ActiveContext) {
  return trace.getPlan()?.steps.map((step) => step.status);
}

describe('PlanTracker deviation metric (L6-P16 C16)', () => {
  it('does not raise a deviation replan while every round completes one planned step', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan(
      [
        '1. 项目结构概览',
        '2. 搜索 auth 相关代码',
        '3. 阅读 src/auth.ts',
        '4. 分析类继承关系',
        '5. 总结分析发现',
      ].join('\n'),
      1
    );
    const onPlanRounds: PlanCall[] = [
      ['code', { action: 'structure', params: {} }, { tree: ['src'] }],
      ['code', { action: 'search', params: { pattern: 'auth' } }, { total: 1, matches: [] }],
      ['code', { action: 'read', params: { path: 'src/auth.ts' } }, 'export class Auth {}'],
      ['graph', { action: 'query', params: { type: 'class', entity: 'Auth' } }, { name: 'Auth' }],
    ];
    onPlanRounds.forEach((call, index) => {
      const iteration = index + 2;
      runPlanRound(plans, trace, iteration, [call]);
      // 按计划推进的每一轮都不是偏差：旧公式把“未完成比例”当偏差，第 3 轮就会发“计划偏差检查”。
      expect(plans.checkPlanning(planCheckState(iteration + 1), trace)).toBeNull();
    });
    expect(stepStatuses(trace)).toEqual(['done', 'done', 'done', 'done', 'pending']);
    expect(plans.progress).toMatchObject({
      coveredSteps: 4,
      totalSteps: 5,
      deviationScore: 0,
      unplannedActions: 0,
      consecutiveOffPlan: 0,
    });
    // 未完成度只交给周期触发：createdAtIteration=1 + replanInterval=8 → 第 9 轮才回顾计划。
    expect(plans.checkPlanning(planCheckState(8), trace)).toBeNull();
    expect(plans.checkPlanning(planCheckState(9), trace)?.text).toContain('📋 计划进度回顾');
    // adherence 与 completion 不再恒等：全部动作都在计划内，adherence=100，completion=80。
    const quality = plans.getQualityMetrics(trace);
    expect(quality.breakdown.planAdherence).toBe(100);
    expect(quality.breakdown.planCompletion).toBe(80);
  });

  it('fires a deviation replan only after three consecutive off-plan exploration rounds', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 src/auth.ts\n2. 阅读 src/payment.ts', 1);
    runPlanRound(plans, trace, 2, [offPlanRead]);
    expect(plans.checkPlanning(planCheckState(3), trace)).toBeNull();
    runPlanRound(plans, trace, 3, [offPlanRead]);
    expect(plans.checkPlanning(planCheckState(4), trace)).toBeNull();
    runPlanRound(plans, trace, 4, [offPlanRead]);
    const replan = plans.checkPlanning(planCheckState(5), trace);
    expect(replan?.text).toContain('📋 计划偏差检查');
    expect(replan?.text).toContain('连续 3 轮偏离');
    // deviationScore 只作诊断：3 个可计动作全部在计划外。
    expect(plans.progress).toMatchObject({
      consecutiveOffPlan: 3,
      unplannedActions: 3,
      deviationScore: 1,
    });
  });

  it('does not carry the deviation score or off-plan streak across a replan', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 src/auth.ts\n2. 阅读 src/payment.ts', 1);
    for (const iteration of [2, 3, 4]) {
      runPlanRound(plans, trace, iteration, [offPlanRead]);
    }
    expect(plans.checkPlanning(planCheckState(5), trace)?.text).toContain('计划偏差检查');
    trace.updatePlan('1. 阅读 src/unrelated.ts\n2. 阅读 src/billing.ts', 5);
    runPlanRound(plans, trace, 5, [offPlanRead]);
    expect(plans.progress).toMatchObject({
      coveredSteps: 1,
      totalSteps: 2,
      deviationScore: 0,
      unplannedActions: 0,
      consecutiveOffPlan: 0,
    });
    expect(plans.getQualityMetrics(trace).breakdown.planAdherence).toBe(100);
  });
});

describe('PlanTracker step matching (L6-P16 C17)', () => {
  it('does not let code.search complete the summary step of the elicitation example plan', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan(
      [
        '1. 获取项目概览和目录结构，识别核心模块',
        '2. 搜索网络请求相关类，分析请求模式',
        '3. 搜索错误处理和响应解析模式',
        '4. 深入阅读 3-5 个典型实现文件，确认关键细节',
        '5. 总结分析发现',
      ].join('\n'),
      1
    );
    runPlanRound(plans, trace, 2, [
      ['code', { action: 'search', params: { pattern: 'request' } }, { total: 0, matches: [] }],
      ['code', { action: 'search', params: { pattern: 'error' } }, { total: 0, matches: [] }],
      ['code', { action: 'search', params: { pattern: 'parse' } }, { total: 0, matches: [] }],
    ]);
    expect(stepStatuses(trace)).toEqual(['pending', 'done', 'done', 'pending', 'pending']);
  });

  it('does not complete steps through single-character or substring keyword hits', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 按类型分类整理所有发现\n2. Check thread safety of workers', 1);
    runPlanRound(plans, trace, 2, [
      ['graph', { action: 'query', params: { type: 'class', entity: 'Alpha' } }, { name: 'Alpha' }],
      ['code', { action: 'read', params: { path: 'src/worker.ts' } }, 'export class Worker {}'],
    ]);
    expect(stepStatuses(trace)).toEqual(['pending', 'pending']);
  });

  it('keeps multi-character class and word-bounded English keywords working', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 梳理 Vue.js 组件的类继承关系\n2. Read the worker entry file', 1);
    runPlanRound(plans, trace, 2, [
      [
        'graph',
        { action: 'query', params: { type: 'class', entity: 'Widget' } },
        { name: 'Widget' },
      ],
      ['code', { action: 'read', params: { path: 'src/worker.ts' } }, 'export class Worker {}'],
    ]);
    expect(stepStatuses(trace)).toEqual(['done', 'done']);
  });

  it.each([
    '1. 搜索 Node.js 服务端路由注册模式\n2. 总结分析发现结果',
    '1. 搜索路由注册入口（e.g. express router）\n2. 总结分析发现结果',
  ])('lets a search complete a step that names a technology instead of a file: %s', (plan) => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan(plan, 1);
    runPlanRound(plans, trace, 2, [
      ['code', { action: 'search', params: { pattern: 'router.get' } }, { total: 0, matches: [] }],
    ]);
    expect(stepStatuses(trace)).toEqual(['done', 'pending']);
  });

  it('treats file targets as a soft, prioritising signal for non-read tools', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 搜索 src/auth.ts 中的认证逻辑\n2. 搜索 src/billing.ts 中的计费逻辑', 1);
    runPlanRound(plans, trace, 2, [
      [
        'code',
        { action: 'search', params: { pattern: 'charge', path: 'src/billing.ts' } },
        { total: 0, matches: [] },
      ],
    ]);
    // 参数点名了第 2 步的文件目标：优先完成第 2 步，而不是按顺序落到第 1 步。
    expect(stepStatuses(trace)).toEqual(['pending', 'done']);
    runPlanRound(plans, trace, 3, [
      ['code', { action: 'search', params: { pattern: 'login' } }, { total: 0, matches: [] }],
    ]);
    // 非 read 工具不再被文件目标硬性排除，仍可经语义回退完成第 1 步。
    expect(stepStatuses(trace)).toEqual(['done', 'done']);
  });

  it('keeps note_finding-only and failed-read rounds out of the off-plan streak', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 src/auth.ts\n2. 阅读 src/payment.ts', 1);
    for (const iteration of [2, 3, 4]) {
      runPlanRound(plans, trace, iteration, [recordedFinding]);
    }
    for (const iteration of [5, 6, 7]) {
      runPlanRound(plans, trace, iteration, [failedPlannedRead]);
    }
    expect(plans.progress).toMatchObject({ consecutiveOffPlan: 0, unplannedActions: 0 });
    expect(stepStatuses(trace)).toEqual(['pending', 'pending']);
    expect(plans.checkPlanning(planCheckState(8, { phase: 'VERIFY' }), trace)).toBeNull();
  });

  it('holds (not resets) the off-plan streak across a round without countable actions', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 src/auth.ts\n2. 阅读 src/payment.ts', 1);
    runPlanRound(plans, trace, 2, [offPlanRead]);
    runPlanRound(plans, trace, 3, [offPlanRead]);
    runPlanRound(plans, trace, 4, [recordedFinding, failedPlannedRead]);
    expect(plans.progress.consecutiveOffPlan).toBe(2);
    expect(plans.checkPlanning(planCheckState(5), trace)).toBeNull();
    runPlanRound(plans, trace, 5, [offPlanRead]);
    expect(plans.checkPlanning(planCheckState(6), trace)?.text).toContain('连续 3 轮偏离');
  });
});

describe('PlanTracker suppressed replans are observable (L6-P16 C18)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const fixedPlanTrace: ExplorationTrace = {
    expectPlan: () => undefined,
    getPlan: () => ({
      createdAtIteration: 1,
      steps: [{ description: 'Read runtime entry', status: 'pending' }],
    }),
  };

  it('reports cooldown, replan cap and late-bootstrap suppressions to the caller', () => {
    const seen: Array<{ reason: string; iteration: number; replanCount: number }> = [];
    const record = (suppression: { reason: string; iteration: number; replanCount: number }) => {
      seen.push({
        reason: suppression.reason,
        iteration: suppression.iteration,
        replanCount: suppression.replanCount,
      });
    };
    const analyst = new PlanTracker();
    const state = (iteration: number) => planCheckState(iteration, { replanInterval: 1 });
    expect(analyst.checkPlanning(state(2), fixedPlanTrace, record)?.type).toBe('planning');
    expect(analyst.checkPlanning(state(3), fixedPlanTrace, record)).toBeNull();
    expect(analyst.checkPlanning(state(5), fixedPlanTrace, record)?.type).toBe('planning');
    expect(analyst.checkPlanning(state(8), fixedPlanTrace, record)).toBeNull();
    const bootstrap = new PlanTracker();
    expect(
      bootstrap.checkPlanning(
        planCheckState(7, { pipelineType: 'bootstrap', maxIterations: 10, replanInterval: 1 }),
        fixedPlanTrace,
        record
      )
    ).toBeNull();
    // 没有任何触发条件时返回 null 不是抑制，不应上报。
    expect(new PlanTracker().checkPlanning(planCheckState(3), fixedPlanTrace, record)).toBeNull();
    expect(seen).toEqual([
      { reason: 'cooldown', iteration: 3, replanCount: 1 },
      { reason: 'replan_cap', iteration: 8, replanCount: 2 },
      { reason: 'bootstrap_late', iteration: 7, replanCount: 0 },
    ]);
  });

  it('logs every suppression reason at debug through ExplorationTracker', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    const quietAnalyst: ExplorationStrategy = {
      ...STRATEGY_ANALYST,
      phases: ['EXPLORE', 'SUMMARIZE'],
      transitions: {},
      enableReflection: false,
      replanInterval: 1,
    };
    const analyst = new ExplorationTracker(quietAnalyst, { maxIterations: 40 });
    const analystNudges: Array<string | null> = [];
    for (let i = 1; i <= 6; i++) {
      analyst.tick();
      analystNudges.push(analyst.getNudge(fixedPlanTrace)?.type ?? null);
    }
    // 1=计划征集，2=replan#1，3/4=冷却，5=replan#2，6=配额已满。
    expect(analystNudges).toEqual(['planning', 'planning', null, null, 'planning', null]);

    const quietBootstrap: ExplorationStrategy = {
      ...createGenerateStrategy(),
      enableReflection: false,
      replanInterval: 12,
    };
    const bootstrap = new ExplorationTracker(quietBootstrap, { maxIterations: 20 });
    for (let i = 1; i <= 13; i++) {
      bootstrap.tick();
      const nudge = bootstrap.getNudge(fixedPlanTrace);
      expect(nudge?.type ?? null).toBe(i === 1 ? 'planning' : null);
    }

    const suppressedLogs = debug.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('replan suppressed'));
    expect(suppressedLogs).toHaveLength(4);
    expect(suppressedLogs[0]).toContain('reason=cooldown');
    expect(suppressedLogs[0]).toContain('iteration=3');
    expect(suppressedLogs[0]).toContain('replanCount=1/2');
    expect(suppressedLogs[0]).toContain('triggers=periodic');
    expect(suppressedLogs[1]).toContain('reason=cooldown');
    expect(suppressedLogs[2]).toContain('reason=replan_cap');
    expect(suppressedLogs[2]).toContain('iteration=6');
    expect(suppressedLogs[3]).toContain('reason=bootstrap_late');
    expect(suppressedLogs[3]).toContain('iteration=13');
    expect(suppressedLogs[3]).toContain('replanCount=0/1');
  });
});

describe('PlanTracker skipped actions are observable (L6-P16 C17)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs failed and non-exploration actions excluded from plan statistics at debug', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    const t = new ExplorationTracker(STRATEGY_ANALYST, { maxIterations: 20 });
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 src/auth.ts\n2. 阅读 src/payment.ts', 1);
    t.tick();
    trace.startRound(1);
    trace.recordToolCall(...recordedFinding, false);
    trace.recordToolCall(...failedPlannedRead, false);
    t.updatePlanProgress(trace);
    const skippedLogs = debug.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('plan progress skipped'));
    expect(skippedLogs).toHaveLength(1);
    expect(skippedLogs[0]).toContain('skipped 1 failed and 1 non-exploration action(s)');
    expect(skippedLogs[0]).toContain('counted=0');
    expect(skippedLogs[0]).toContain('held: no countable action this round');
    expect(t.getPlanProgress().consecutiveOffPlan).toBe(0);
  });
});

describe('PlanTracker trace port (L6-P16 C19)', () => {
  it('drives PlanTracker through the public ExplorationTrace port, honouring failed reads', () => {
    const steps = [{ description: 'Read src/auth.ts', status: 'pending', keywords: [] }];
    let actions: ReturnType<NonNullable<ExplorationTrace['getCurrentRoundActions']>> = [
      {
        tool: 'code',
        params: { action: 'read', params: { path: 'src/auth.ts' } },
        ok: false,
        successfulReadPaths: [],
      },
    ];
    const trace: ExplorationTrace = {
      getPlan: () => ({ createdAtIteration: 1, steps }),
      getPlanStepsMutable: () => steps,
      getCurrentRoundActions: () => actions,
    };
    const plans = new PlanTracker();
    plans.updatePlanProgress(trace);
    expect(steps[0].status).toBe('pending');
    expect(plans.progress.consecutiveOffPlan).toBe(0);
    actions = [
      {
        tool: 'code',
        params: { action: 'read', params: { path: 'src/auth.ts' } },
        ok: true,
        successfulReadPaths: ['src/auth.ts'],
      },
    ];
    plans.updatePlanProgress(trace);
    expect(steps[0].status).toBe('done');
  });

  it('keeps a single trace port without the duplicated ActiveTrace type or casts', () => {
    const planTrackerSource = readFileSync(
      new URL('../src/agent/context/exploration/PlanTracker.ts', import.meta.url),
      'utf8'
    );
    const explorationTrackerSource = readFileSync(
      new URL('../src/agent/context/ExplorationTracker.ts', import.meta.url),
      'utf8'
    );
    expect(planTrackerSource).not.toMatch(/\bActiveTrace\b/);
    expect(explorationTrackerSource).not.toMatch(/\bActiveTrace\b/);
    expect(explorationTrackerSource).not.toMatch(/trace as \w+/);
  });
});
