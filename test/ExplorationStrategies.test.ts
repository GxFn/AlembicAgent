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
import { NUDGE_DIRECTIVE_TEXTS } from '../src/agent/context/exploration/NudgeGenerator.js';
import { PlanTracker } from '../src/agent/context/exploration/PlanTracker.js';
import { ExplorationTracker } from '../src/agent/context/index.js';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import { ActiveContext } from '../src/agent/memory/ActiveContext.js';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
import {
  PRODUCER_SUBMIT_FIELD_CONTRACT,
  PRODUCER_SUBMIT_HARD_GATES,
  PRODUCER_SUBMIT_STYLE_ADVISORIES,
} from '../src/agent/prompts/producerRetry.js';
import { SCAN_TASK_CONFIGS } from '../src/agent/prompts/scanPrompts.js';
import type { AgentRuntime, LoopContext } from '../src/agent/runtime/index.js';
import { createToolPipeline, DiagnosticsCollector } from '../src/agent/runtime/index.js';
import type { ToolCallRequest, ToolResultEnvelope } from '../src/tools/kernel/index.js';
import type { ToolContext } from '../src/tools/kernel/registry.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';
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
      // L6-P23（C59）：scan 的字段清单与门禁分级复用 Producer 共享合同，不再手写第二份；
      // 共享合同也不得夹带 insight 的「不补读源码」限制（scan 允许 code.read 补读已定位文件）。
      expect(config.producePrompt).toContain(PRODUCER_SUBMIT_FIELD_CONTRACT);
      expect(config.producePrompt).toContain(PRODUCER_SUBMIT_HARD_GATES);
      expect(config.producePrompt).toContain(PRODUCER_SUBMIT_STYLE_ADVISORIES);
      expect(config.producePrompt).not.toContain('必填: trigger');
      expect(config.producePrompt).not.toContain('不补读源码');
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
 *
 * 默认路由来者不拒，只能证明“门没拦”；要证明“handler 真能接收”，传 hostToolContext 改用
 * 生产形态的真实 ToolRouterAdapter（不带 capability，与宿主 AgentModule 一致），宿主端口由
 * hostToolContext 打桩，dispatched 仍记录通过全部门、交给路由的调用。
 */
function phaseGateFixture(input: {
  allowedToolIds: string[];
  tracker: { pipelineType: string; phase: string };
  hostToolContext?: ToolContext;
}) {
  const diagnostics = new DiagnosticsCollector();
  const dispatched: string[] = [];
  const hostToolContext = input.hostToolContext;
  const realRouter = hostToolContext
    ? new ToolRouterAdapter({ contextFactory: { create: () => hostToolContext } })
    : null;
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
      async execute(request: ToolCallRequest) {
        dispatched.push(`${request.toolId}.${String(request.args?.action ?? '')}`);
        if (realRouter) {
          return realRouter.execute(request);
        }
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
    {
      // router.parseToolCall 只把 args.params 交给 handler，平铺在顶层的 type/entity 会被丢弃，
      // 真实路由对这种调用返回 TOOL_CALL_INVALID；门在调度前就拦下。
      label: 'flat entity',
      args: { action: 'query', type: 'callers', entity: 'Alpha' },
    },
  ])('blocks analyst VERIFY graph.query with $label because it lacks a nested non-blank params.entity', async ({
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
    // 推荐写法必须是 handler 真正读取的嵌套 params.entity，模型照文案重试才不会再被拒。
    expect(error).toContain('with params.entity');
    expect(error).not.toContain('entity/path');
    expect(diagnostics.toJSON().blockedTools).toMatchObject([{ tool: 'graph' }]);
  });

  it('allows a focused analyst VERIFY graph.query with nested params.entity', async () => {
    const { context, dispatched } = phaseGateFixture({
      allowedToolIds: ['code', 'graph', 'memory', 'evidence'],
      tracker: { pipelineType: 'analyst', phase: 'VERIFY' },
    });
    const output = await createToolPipeline().execute(
      {
        id: 'verify-graph',
        name: 'graph',
        args: { action: 'query', params: { type: 'callers', entity: 'Alpha' } },
      },
      context
    );
    expect(output.metadata.blocked).toBe(false);
    expect(dispatched).toEqual(['graph.query']);
  });

  it.each([
    {
      label: 'nested params.entity',
      args: { action: 'query', params: { type: 'callers', entity: 'Alpha' } },
      blocked: false,
      hostCalls: [['Alpha', 20]],
    },
    {
      label: 'flat entity',
      args: { action: 'query', type: 'callers', entity: 'Alpha' },
      blocked: true,
      hostCalls: [],
    },
    {
      // handler 只做非空检查，纯空白 entity 会被发往宿主；门比 handler 更严，调度前就拦下。
      label: 'blank nested entity',
      args: { action: 'query', params: { type: 'callers', entity: '   ' } },
      blocked: true,
      hostCalls: [],
    },
  ])('keeps analyst VERIFY graph.query with $label aligned with the real router and graph handler', async ({
    args,
    blocked,
    hostCalls,
  }) => {
    const getCallers = vi.fn((entity: string, limit: number) => [
      { caller: `${entity}Caller`, limit },
    ]);
    const { context, diagnostics, dispatched } = phaseGateFixture({
      allowedToolIds: ['code', 'graph', 'memory', 'evidence'],
      tracker: { pipelineType: 'analyst', phase: 'VERIFY' },
      hostToolContext: {
        projectRoot: process.cwd(),
        tokenBudget: 8000,
        projectGraph: { getCallers },
      },
    });
    const output = await createToolPipeline().execute(
      { id: 'verify-graph-real-router', name: 'graph', args },
      context
    );
    expect(output.metadata.blocked).toBe(blocked);
    expect(getCallers.mock.calls).toEqual(hostCalls);
    if (blocked) {
      // 门拦截：不进入路由，阻断原因进 diagnostics.blockedTools。
      expect(dispatched).toEqual([]);
      expect(blockedError(output.result)).toContain('Analyst VERIFY is evidence-only');
      expect(diagnostics.toJSON().blockedTools).toMatchObject([{ tool: 'graph' }]);
    } else {
      // 门放行的形态必须真被路由与 handler 接收：宿主端口实际被调用，且路由结果是成功。
      expect(dispatched).toEqual(['graph.query']);
      expect(output.metadata.envelope?.ok).toBe(true);
      expect(diagnostics.toJSON().blockedTools ?? []).toEqual([]);
    }
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

  // L6-P16r3 C016：首字母大写的真实 JS 文件（React 组件 App.js / Header.js）仍是 read 的硬门槛目标。
  it.each([
    'App.js',
    'Header.js',
  ])('keeps a capitalised bare %s file as a hard read target', (fileName) => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan(`1. 阅读 ${fileName} 入口组件\n2. 阅读 src/server.ts`, 1);
    runPlanRound(plans, trace, 2, [offPlanRead]);
    expect(stepStatuses(trace)).toEqual(['pending', 'pending']);
    expect(plans.progress).toMatchObject({ unplannedActions: 1, consecutiveOffPlan: 1 });
    runPlanRound(plans, trace, 3, [
      [
        'code',
        { action: 'read', params: { path: `src/${fileName}` } },
        'export default function Component() {}',
      ],
    ]);
    expect(stepStatuses(trace)).toEqual(['done', 'pending']);
  });

  it.each([
    '1. 阅读 Node.js 相关入口说明\n2. 阅读 src/server.ts',
    '1. 查看 Vue.js 组件结构\n2. 阅读 src/server.ts',
  ])('still excludes technology names from file targets: %s', (plan) => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan(plan, 1);
    runPlanRound(plans, trace, 2, [offPlanRead]);
    expect(stepStatuses(trace)).toEqual(['done', 'pending']);
  });

  // L6-P16r3 C015：续做已完成步骤、或只剩总结步时被迫继续探索，都是按计划执行，不能触发偏差 replan。
  it('does not raise a deviation replan while the elicitation example plan keeps reading files', () => {
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
      ['code', { action: 'structure', params: {} }, { tree: ['src'] }],
      ['code', { action: 'search', params: { pattern: 'request' } }, { total: 0, matches: [] }],
      ['code', { action: 'search', params: { pattern: 'error' } }, { total: 0, matches: [] }],
    ]);
    const read = (file: string): PlanCall => [
      'code',
      { action: 'read', params: { path: `src/${file}` } },
      'export const value = 1;',
    ];
    runPlanRound(plans, trace, 3, [read('a.ts')]);
    expect(stepStatuses(trace)).toEqual(['done', 'done', 'done', 'done', 'pending']);
    for (const [iteration, file] of [
      [4, 'b.ts'],
      [5, 'c.ts'],
      [6, 'd.ts'],
    ] as const) {
      runPlanRound(plans, trace, iteration, [read(file)]);
      expect(plans.checkPlanning(planCheckState(iteration + 1), trace)).toBeNull();
    }
    expect(plans.progress).toMatchObject({
      coveredSteps: 4,
      totalSteps: 5,
      deviationScore: 0,
      unplannedActions: 0,
      consecutiveOffPlan: 0,
    });
    expect(plans.checkPlanning(planCheckState(8), trace)).toBeNull();
    expect(plans.checkPlanning(planCheckState(9), trace)?.text).toContain('📋 计划进度回顾');
  });

  it('does not raise a deviation replan when only the summary step is left', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 搜索 auth 相关代码\n2. 阅读 src/auth.ts\n3. 总结分析发现', 1);
    runPlanRound(plans, trace, 2, [
      ['code', { action: 'search', params: { pattern: 'auth' } }, { total: 1, matches: [] }],
      ['code', { action: 'read', params: { path: 'src/auth.ts' } }, 'export class Auth {}'],
    ]);
    for (const iteration of [3, 4, 5]) {
      runPlanRound(plans, trace, iteration, [
        ['code', { action: 'search', params: { pattern: 'token' } }, { total: 0, matches: [] }],
      ]);
    }
    expect(plans.checkPlanning(planCheckState(6), trace)).toBeNull();
    expect(stepStatuses(trace)).toEqual(['done', 'done', 'pending']);
    expect(plans.progress).toMatchObject({ unplannedActions: 0, consecutiveOffPlan: 0 });
  });

  it('holds the streak for unmatched exploration once only summary steps remain', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 src/auth.ts\n2. 总结分析发现', 1);
    runPlanRound(plans, trace, 2, [
      ['code', { action: 'read', params: { path: 'src/auth.ts' } }, 'export class Auth {}'],
    ]);
    for (const iteration of [3, 4, 5]) {
      // 读另一个文件既不能续做“阅读 src/auth.ts”（read 硬门槛），也没有可由工具完成的剩余步骤。
      runPlanRound(plans, trace, iteration, [offPlanRead]);
    }
    expect(plans.checkPlanning(planCheckState(6), trace)).toBeNull();
    expect(stepStatuses(trace)).toEqual(['done', 'pending']);
    expect(plans.progress).toMatchObject({ unplannedActions: 0, consecutiveOffPlan: 0 });
  });

  it('still fires a deviation replan while tool-completable steps remain pending', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 src/auth.ts\n2. 阅读 src/payment.ts\n3. 总结分析发现', 1);
    runPlanRound(plans, trace, 2, [
      ['code', { action: 'read', params: { path: 'src/auth.ts' } }, 'export class Auth {}'],
    ]);
    for (const iteration of [3, 4, 5]) {
      runPlanRound(plans, trace, iteration, [offPlanRead]);
    }
    expect(plans.progress).toMatchObject({ unplannedActions: 3, consecutiveOffPlan: 3 });
    expect(plans.checkPlanning(planCheckState(6), trace)?.text).toContain('连续 3 轮偏离');
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

  // L6-P16r3 C017：code.outline / terminal.exec 是计入偏离的探索动作，也必须能完成或续做计划步骤。
  const outline = (path: string): PlanCall => [
    'code',
    { action: 'outline', params: { path } },
    { kind: 'outline', definitions: [] },
  ];
  const exec = (command: string): PlanCall => [
    'terminal',
    { action: 'exec', params: { command } },
    { exitCode: 0, stdout: 'ok', stderr: '' },
  ];

  it('lets code.outline of the planned files complete and continue reading steps', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 src/auth.ts\n2. 阅读 src/payment.ts', 1);
    runPlanRound(plans, trace, 2, [outline('src/auth.ts')]);
    runPlanRound(plans, trace, 3, [outline('src/payment.ts')]);
    runPlanRound(plans, trace, 4, [outline('src/auth.ts')]);
    expect(stepStatuses(trace)).toEqual(['done', 'done']);
    expect(plans.progress).toMatchObject({ unplannedActions: 0, consecutiveOffPlan: 0 });
    expect(plans.checkPlanning(planCheckState(5), trace)).toBeNull();
  });

  it('keeps the file target a hard gate for code.outline', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 src/auth.ts\n2. 阅读 src/payment.ts', 1);
    runPlanRound(plans, trace, 2, [outline('src/unrelated.ts')]);
    expect(stepStatuses(trace)).toEqual(['pending', 'pending']);
    expect(plans.progress).toMatchObject({ unplannedActions: 1, consecutiveOffPlan: 1 });
  });

  it('lets terminal.exec complete and continue command steps', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 运行 npm test 确认测试状态\n2. 执行 git log 查看最近提交', 1);
    runPlanRound(plans, trace, 2, [exec('npm test')]);
    expect(stepStatuses(trace)).toEqual(['done', 'pending']);
    runPlanRound(plans, trace, 3, [exec('git log -5')]);
    runPlanRound(plans, trace, 4, [exec('git status')]);
    expect(stepStatuses(trace)).toEqual(['done', 'done']);
    expect(plans.progress).toMatchObject({ unplannedActions: 0, consecutiveOffPlan: 0 });
    expect(plans.checkPlanning(planCheckState(5), trace)).toBeNull();
  });

  it('counts a code.search scoped to a reading step file target as on-plan', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 src/auth.ts\n2. 阅读 src/payment.ts', 1);
    runPlanRound(plans, trace, 2, [
      [
        'code',
        { action: 'search', params: { pattern: 'login', path: 'src/auth.ts' } },
        { total: 0, matches: [] },
      ],
    ]);
    expect(stepStatuses(trace)).toEqual(['done', 'pending']);
    expect(plans.progress).toMatchObject({ unplannedActions: 0, consecutiveOffPlan: 0 });
  });

  it('does not treat a path that merely ends with the target name as naming it', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 auth.ts 认证入口\n2. 阅读 src/payment.ts', 1);
    runPlanRound(plans, trace, 2, [
      [
        'code',
        { action: 'search', params: { pattern: 'login', path: 'src/oauth.ts' } },
        { total: 0, matches: [] },
      ],
    ]);
    expect(stepStatuses(trace)).toEqual(['pending', 'pending']);
  });

  it('never lets code.outline or terminal.exec complete the summary step', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 总结分析发现\n2. 汇总报告结论', 1);
    runPlanRound(plans, trace, 2, [outline('src/auth.ts'), exec('npm test')]);
    expect(stepStatuses(trace)).toEqual(['pending', 'pending']);
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

  it('logs continued, plan-exhausted and technology-name classifications at debug', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 Node.js 相关入口说明\n2. 总结分析发现', 1);
    runPlanRound(plans, trace, 2, [offPlanRead]);
    runPlanRound(plans, trace, 3, [offPlanRead]);
    runPlanRound(plans, trace, 4, [
      ['graph', { action: 'query', params: { type: 'class', entity: 'Auth' } }, { name: 'Auth' }],
    ]);
    const messages = debug.mock.calls.map(([message]) => String(message));
    const techLogs = messages.filter((message) => message.includes('technology name'));
    // 同一步骤只记一次，避免每轮重复刷日志。
    expect(techLogs).toHaveLength(1);
    expect(techLogs[0]).toContain('Node.js');
    const continuedLogs = messages.filter((message) => message.includes('continued=1'));
    expect(continuedLogs).toHaveLength(1);
    const exhaustedLogs = messages.filter((message) => message.includes('exhaustedHeld=1'));
    expect(exhaustedLogs).toHaveLength(1);
    expect(exhaustedLogs[0]).toContain('plan exhausted except summary');
    expect(plans.progress).toMatchObject({ unplannedActions: 0, consecutiveOffPlan: 0 });
  });
});

/**
 * L6-P16r4：对 0ed0a4c（L6-P16r3）的第四轮审计补修，两处相对父提交的回归：
 *   - terminal.exec 语义规则的中文“运行/执行”没有词边界，“运行时”“执行流程”也命中。terminal 不是单文件
 *     取证动作，文件目标只是软信号，所以任意无关终端命令（git status / ls）都能把带明确文件目标的阅读步骤
 *     标成完成；若它是最后一个可由工具完成的步骤，之后的真实偏离会被“计划耗尽”保持吞掉，周期回顾还会把
 *     从没读过的文件列为“✅ 已完成”。
 *   - “计划耗尽”判定 openSteps.every(isSummaryStep) 对空集恒真，把“只剩总结步”悄悄扩大成“计划全部完成”：
 *     计划做完后偏差 replan 永远不再触发（bootstrap 紧凑计划没有总结步，收不到“不要重新搜索”的纠偏），
 *     诊断日志还打印 “summary step(s) []”。
 */
describe('PlanTracker terminal rule boundary and completed plans (L6-P16r4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const exec = (command: string): PlanCall => [
    'terminal',
    { action: 'exec', params: { command } },
    { exitCode: 0, stdout: 'ok', stderr: '' },
  ];
  const read = (path: string): PlanCall => [
    'code',
    { action: 'read', params: { path } },
    'export const value = 1;',
  ];

  it('does not let an unrelated terminal command complete a reading step that mentions 执行流程', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 src/scheduler.ts 理解任务执行流程\n2. 阅读 src/server.ts', 1);
    runPlanRound(plans, trace, 2, [exec('git status')]);
    expect(stepStatuses(trace)).toEqual(['pending', 'pending']);
    expect(plans.progress).toMatchObject({ unplannedActions: 1, consecutiveOffPlan: 1 });
  });

  it.each([
    ['深入阅读运行时上下文装配逻辑', 'ls'],
    ['阅读 src/runtime/AgentRuntime.ts 了解运行时入口', 'pwd'],
    ['深入阅读 3-5 个典型实现文件，确认执行细节', 'git status'],
    ['查看可执行脚本的加载方式', 'git status'],
  ])('keeps the reading step "%s" pending after terminal.exec %s', (step, command) => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan(`1. ${step}\n2. 阅读 src/server.ts`, 1);
    runPlanRound(plans, trace, 2, [exec(command)]);
    expect(stepStatuses(trace)).toEqual(['pending', 'pending']);
    expect(plans.progress).toMatchObject({ unplannedActions: 1, consecutiveOffPlan: 1 });
  });

  it('keeps the production flat terminal parameter shape out of reading steps too', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 src/scheduler.ts 理解任务执行流程\n2. 阅读 src/server.ts', 1);
    runPlanRound(plans, trace, 2, [
      [
        'terminal',
        { action: 'exec', command: 'git status' },
        { exitCode: 0, stdout: '', stderr: '' },
      ],
    ]);
    expect(stepStatuses(trace)).toEqual(['pending', 'pending']);
  });

  it('completes the command step, not the 运行时 search step, when the plan has both', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 搜索运行时配置加载逻辑\n2. 运行 npm test 确认测试状态', 1);
    runPlanRound(plans, trace, 2, [exec('npm test')]);
    expect(stepStatuses(trace)).toEqual(['pending', 'done']);
    expect(plans.progress).toMatchObject({ unplannedActions: 0, consecutiveOffPlan: 0 });
  });

  it.each([
    '运行测试套件验证当前行为',
    '执行构建命令检查产物',
    '运行 `npm run lint` 检查代码规范',
    '运行单元测试确认修复',
    '执行类型检查',
    '运行 ./scripts/check.sh 校验输出',
    '用命令行查看 git 状态',
    'Run the test suite to confirm the baseline',
  ])('still lets terminal.exec complete the command step "%s"', (step) => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan(`1. ${step}\n2. 阅读 src/server.ts`, 1);
    runPlanRound(plans, trace, 2, [exec('npm test')]);
    expect(stepStatuses(trace)).toEqual(['done', 'pending']);
    expect(plans.progress).toMatchObject({ unplannedActions: 0, consecutiveOffPlan: 0 });
  });

  it('reports the deviation instead of listing an unread file as done after git log and off-plan reads', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan(
      [
        '1. 获取项目概览和目录结构',
        '2. 阅读 src/runtime/AgentRuntime.ts 理解主循环执行流程',
        '3. 搜索错误处理和重试模式',
        '4. 总结分析发现',
      ].join('\n'),
      1
    );
    runPlanRound(plans, trace, 2, [
      ['code', { action: 'structure', params: {} }, { tree: ['src'] }],
    ]);
    runPlanRound(plans, trace, 3, [exec('git log -5 --oneline')]);
    // 无关的 git log 从没读过 AgentRuntime.ts，不能把第 2 步标成完成。
    expect(stepStatuses(trace)).toEqual(['done', 'pending', 'pending', 'pending']);
    expect(plans.progress).toMatchObject({ unplannedActions: 1, consecutiveOffPlan: 1 });
    runPlanRound(plans, trace, 4, [
      ['code', { action: 'search', params: { pattern: 'retry' } }, { total: 0, matches: [] }],
    ]);
    expect(stepStatuses(trace)).toEqual(['done', 'pending', 'done', 'pending']);
    for (const [iteration, file] of [
      [5, 'src/a.ts'],
      [6, 'src/b.ts'],
    ] as const) {
      runPlanRound(plans, trace, iteration, [read(file)]);
      expect(plans.checkPlanning(planCheckState(iteration + 1), trace)).toBeNull();
    }
    runPlanRound(plans, trace, 7, [read('src/c.ts')]);
    // 第 2 步仍可由工具完成：连续 3 轮读无关文件是真实偏离，不能被“计划耗尽”保持吞掉。
    expect(plans.progress).toMatchObject({ unplannedActions: 4, consecutiveOffPlan: 3 });
    const nudge = plans.checkPlanning(planCheckState(8), trace)?.text ?? '';
    expect(nudge).toContain('📋 计划偏差检查');
    expect(nudge).toContain('连续 3 轮偏离');
    expect(nudge).toContain('⏳ 未完成 (2/4)');
    expect(nudge.indexOf('阅读 src/runtime/AgentRuntime.ts')).toBeGreaterThan(
      nudge.indexOf('⏳ 未完成')
    );
  });

  it('counts exploration after every plan step is done as off-plan, not as a vacuous plan exhaustion', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 src/a.ts 入口实现\n2. 阅读 src/b.ts 服务实现', 1);
    runPlanRound(plans, trace, 2, [read('src/a.ts')]);
    runPlanRound(plans, trace, 3, [read('src/b.ts')]);
    expect(stepStatuses(trace)).toEqual(['done', 'done']);
    for (const [iteration, file] of [
      [4, 'src/x4.ts'],
      [5, 'src/x5.ts'],
      [6, 'src/x6.ts'],
    ] as const) {
      trace.startRound(iteration);
      trace.recordToolCall(...read(file), true);
      // 计划全部完成后读无关文件既不能完成、也不能续做任何步骤：是计划外动作，不是“只剩总结步”的耗尽保持。
      expect(plans.updatePlanProgress(trace)).toMatchObject({
        countedActions: 1,
        unplannedActions: 1,
        streakHeld: false,
        consecutiveOffPlan: iteration - 3,
      });
    }
    expect(plans.progress).toMatchObject({
      coveredSteps: 2,
      totalSteps: 2,
      unplannedActions: 3,
      consecutiveOffPlan: 3,
      deviationScore: 0.6,
    });
    expect(plans.checkPlanning(planCheckState(7), trace)?.text).toContain('连续 3 轮偏离');
  });

  it('still sends the bootstrap deviation nudge once a compact plan without a summary step is finished', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 src/a.ts 入口实现\n2. 阅读 src/b.ts 服务实现', 1);
    runPlanRound(plans, trace, 2, [read('src/a.ts')]);
    runPlanRound(plans, trace, 3, [read('src/b.ts')]);
    for (const [iteration, file] of [
      [4, 'src/x4.ts'],
      [5, 'src/x5.ts'],
      [6, 'src/x6.ts'],
    ] as const) {
      runPlanRound(plans, trace, iteration, [read(file)]);
    }
    const nudge = plans.checkPlanning(
      planCheckState(7, { pipelineType: 'bootstrap', maxIterations: 30 }),
      trace
    );
    expect(nudge?.text).toContain('📋 计划偏差检查：剩余 23 轮');
    expect(nudge?.text).toContain('已进入提交/总结方向时不要重新搜索');
  });

  it('logs off-plan exploration after plan completion without the empty summary-step list', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 src/a.ts 入口实现\n2. 阅读 src/b.ts 服务实现', 1);
    runPlanRound(plans, trace, 2, [read('src/a.ts'), read('src/b.ts')]);
    runPlanRound(plans, trace, 3, [read('src/x.ts')]);
    const messages = debug.mock.calls.map(([message]) => String(message));
    expect(messages.filter((message) => message.includes('summary step(s) []'))).toEqual([]);
    const completedLogs = messages.filter((message) =>
      message.includes('off-plan exploration after plan completion')
    );
    expect(completedLogs).toHaveLength(1);
    expect(completedLogs[0]).toContain('all 2 step(s) done');
    expect(completedLogs[0]).toContain('consecutiveOffPlan=1');
  });

  it('keeps holding the streak while a summary step is the only open step', () => {
    const plans = new PlanTracker();
    const trace = new ActiveContext();
    trace.setPlan('1. 阅读 src/a.ts 入口实现\n2. 总结分析发现', 1);
    runPlanRound(plans, trace, 2, [read('src/a.ts')]);
    for (const iteration of [3, 4, 5]) {
      trace.startRound(iteration);
      trace.recordToolCall(...read(`src/x${iteration}.ts`), true);
      expect(plans.updatePlanProgress(trace)).toMatchObject({
        countedActions: 0,
        streakHeld: true,
        consecutiveOffPlan: 0,
      });
    }
    expect(plans.checkPlanning(planCheckState(6), trace)).toBeNull();
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

/**
 * L6-P17（C12/C11）：analyst RECORD 配额不可达出口与终结 nudge 单源。
 *
 * - C12：VERIFY→RECORD 按原始发现数放行，RECORD→SUMMARIZE 按已核实配额收口；证据台账没有任何文件条目时
 *   新发现永远是 unverified，已核实配额不可达。出口条件（用户决定）：ledgerDistinctFiles===0 且原始发现数
 *   达到目标时收口，并由 Tracker 记 warn（target/effective/memoryFindingCount）。
 * - C11：文本轮触发的终结转换必须拿到 NudgeGenerator 的同一份终结指令（严格版），而不是 Tracker 内联副本。
 */
function p17RecordMetrics(overrides: Record<string, number> = {}) {
  return {
    consecutiveIdleRounds: 0,
    evidenceToolCallCount: 6,
    iteration: 12,
    memoryFindingCount: 3,
    verifiedFindingCount: 0,
    depthSlottedFindingCount: 0,
    verifiedDepthSlottedFindingCount: 0,
    phaseRounds: 1,
    roundsSinceNewInfo: 0,
    roundsSinceSubmit: 0,
    searchRoundsInPhase: 0,
    submitCount: 0,
    totalToolCalls: 9,
    ledgerDistinctFiles: 0,
    ...overrides,
  };
}

function p17RecordFinding(
  t: ExplorationTracker,
  index: number,
  options: { verified?: boolean; depthSlot?: boolean } = {}
) {
  t.recordToolCall(
    'note_finding',
    {
      finding: `finding ${index}`,
      evidenceRefs: [`E-${index}`],
      importance: options.depthSlot ? 8 : 5,
      ...(options.depthSlot ? { designIntent: `why ${index}` } : {}),
    },
    {
      recorded: true,
      target: 'activeContext',
      ...(options.verified === undefined ? {} : { verified: options.verified }),
    }
  );
}

/** SCAN→EXPLORE，记录两次证据调用后靠空闲轮推进到 VERIFY。 */
function p17DriveToVerify(t: ExplorationTracker, evidenceTool: 'code' | 'graph') {
  t.tick();
  t.endRound({});
  expect(t.phase).toBe('EXPLORE');
  t.tick();
  for (const target of ['src/a.ts', 'src/b.ts']) {
    if (evidenceTool === 'code') {
      t.recordToolCall('code', { action: 'read', params: { path: target } }, `body of ${target}`);
    } else {
      t.recordToolCall('graph', { action: 'query', params: { entity: target } }, `graph ${target}`);
    }
  }
  t.endRound({ hasNewInfo: true, toolNames: [evidenceTool] });
  for (let i = 0; i < 4 && t.phase === 'EXPLORE'; i++) {
    t.tick();
    t.endRound({});
  }
  expect(t.phase).toBe('VERIFY');
}

describe('L6-P17 analyst RECORD quota exit (C12)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits RECORD when the ledger has no file entries and raw findings reach the target', () => {
    const rule = STRATEGY_ANALYST.transitions['RECORD→SUMMARIZE'];
    const degraded = p17RecordMetrics();
    expect(targetMemoryFindingCount(degraded)).toBe(3);
    expect(effectiveMemoryFindingCount(degraded)).toBe(0);
    expect(rule.onMetrics(degraded)).toBe(true);
    expect(rule.onTextResponse(degraded)).toBe(true);
    // 原始发现数未达目标：不提前收口。
    expect(rule.onMetrics(p17RecordMetrics({ memoryFindingCount: 2 }))).toBe(false);
    // 台账有文件条目：已核实配额可达，仍按已核实口径收口（下限 3 不变）。
    expect(rule.onMetrics(p17RecordMetrics({ ledgerDistinctFiles: 2 }))).toBe(false);
    // 无台账运行（字段缺席）不走该出口。
    const { ledgerDistinctFiles: _absent, ...withoutLedger } = p17RecordMetrics();
    expect(rule.onMetrics(withoutLedger)).toBe(false);
  });

  it('moves a degraded-ledger analyst tracker from RECORD to SUMMARIZE and warns with the quota numbers', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const t = new ExplorationTracker(STRATEGY_ANALYST, { maxIterations: 20 });
    t.noteLedgerStats({ distinctFiles: 0 });
    p17DriveToVerify(t, 'graph');

    // VERIFY：3 条 handler 判为未核实的发现，VERIFY→RECORD 按原始发现数放行。
    t.tick();
    for (let i = 1; i <= 3; i++) {
      p17RecordFinding(t, i, { verified: false });
    }
    t.endRound({ hasNewInfo: true, toolNames: ['note_finding'] });
    expect(t.phase).toBe('RECORD');
    // RECORD hint 同时显示已核实数，模型能看出未核实发现不计配额。
    expect(t.getPhaseContext()).toContain('已核实 0 条');

    // RECORD：台账无文件条目，新发现仍未核实；修复前 effective=0<3，RECORD 空转到 maxIterations。
    t.tick();
    p17RecordFinding(t, 4, { verified: false });
    const transition = t.endRound({ hasNewInfo: true, toolNames: ['note_finding'] });
    expect(t.phase).toBe('SUMMARIZE');
    expect(transition?.text).toContain(NUDGE_DIRECTIVE_TEXTS.analystSummarizeLead);

    const quotaWarnings = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('quota unreachable'));
    expect(quotaWarnings).toHaveLength(1);
    expect(quotaWarnings[0]).toContain('target=3');
    expect(quotaWarnings[0]).toContain('effective=0');
    expect(quotaWarnings[0]).toContain('memoryFindingCount=4');
    expect(quotaWarnings[0]).toContain('ledgerDistinctFiles=0');
  });

  it('does not warn when RECORD reaches its verified quota normally', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const t = new ExplorationTracker(STRATEGY_ANALYST, { maxIterations: 20 });
    t.noteLedgerStats({ distinctFiles: 2 });
    p17DriveToVerify(t, 'code');
    t.tick();
    for (let i = 1; i <= 3; i++) {
      p17RecordFinding(t, i, { verified: true });
    }
    t.endRound({ hasNewInfo: true, toolNames: ['note_finding'] });
    expect(t.phase).toBe('RECORD');
    t.tick();
    p17RecordFinding(t, 4, { verified: true });
    t.endRound({ hasNewInfo: true, toolNames: ['note_finding'] });
    expect(t.phase).toBe('SUMMARIZE');
    expect(
      warn.mock.calls.map(([message]) => String(message)).filter((m) => m.includes('quota'))
    ).toEqual([]);
  });
});

describe('L6-P17 terminal nudge single source (C11)', () => {
  it('gives the strict analyst terminal directive when VERIFY text rounds move through RECORD to SUMMARIZE', () => {
    const t = new ExplorationTracker(STRATEGY_ANALYST, { maxIterations: 20 });
    p17DriveToVerify(t, 'code');

    // VERIFY 工具轮：2 条带深度槽的已核实发现（计 1.5 条），原始数 2<3，本轮不转换。
    t.tick();
    p17RecordFinding(t, 1, { depthSlot: true });
    p17RecordFinding(t, 2, { depthSlot: true });
    t.endRound({ hasNewInfo: true, toolNames: ['note_finding'] });
    expect(t.phase).toBe('VERIFY');

    // 文本轮：endRound 的 metrics 规则 VERIFY→RECORD。L6-P18（C10）后同一轮的 onTextResponse
    // 不再按文本规则继续 RECORD→SUMMARIZE（一轮最多转换一次，RECORD 不会零轮被跳过）。
    t.tick();
    t.endRound({});
    expect(t.phase).toBe('RECORD');
    const sameRound = t.onTextResponse('阶段性结论：模块 A 负责鉴权。');
    expect(t.phase).toBe('RECORD');
    expect(sameRound.needsDigestNudge).toBe(false);

    // 下一轮文本规则 RECORD→SUMMARIZE 触发：终结指令来自 NudgeGenerator 的同一份严格版。
    t.tick();
    const result = t.onTextResponse('阶段性结论：模块 A 负责鉴权。');
    expect(t.phase).toBe('SUMMARIZE');
    expect(result.needsDigestNudge).toBe(true);
    expect(result.nudge).toContain(NUDGE_DIRECTIVE_TEXTS.analystSummarizeLead);
    expect(result.nudge).toContain('核心「已确认」章节只能来自已记录的 note_finding');
    expect(result.nudge).toContain(NUDGE_DIRECTIVE_TEXTS.startReportStopTools);
    expect(result.nudge).not.toContain('至少涵盖 3 个核心发现');
  });

  it('gives the producer text-triggered terminal transition the same Markdown production summary contract', () => {
    const t = new ExplorationTracker(STRATEGY_PRODUCER, {
      maxIterations: 12,
      softSubmitLimit: 1,
      targetSubmits: 0,
    });
    t.tick();
    t.recordToolCall(
      'knowledge',
      { action: 'submit', params: {} },
      { status: 'created', id: 'candidate-1', lifecycle: 'pending' }
    );
    t.endRound({ hasNewInfo: true, submitCount: 1, toolNames: ['knowledge'] });
    expect(t.phase).toBe('PRODUCE');
    t.tick();
    t.endRound({});
    const result = t.onTextResponse('先说明一下进展');
    expect(t.phase).toBe('SUMMARIZE');
    expect(result.nudge).toContain(NUDGE_DIRECTIVE_TEXTS.producerSummarizeLead);
    expect(result.nudge).toContain(NUDGE_DIRECTIVE_TEXTS.producerSummaryNoNewTopics);
  });
});

/**
 * L6-P18（C10/C14/C15/C63）：文本轮阶段转换、rollbackTick、skipped 轮与未知策略名。
 *
 * - C10：AgentRuntime 文本轮先 endRound 再 onTextResponse；同一轮（同一 tick）最多转换一次，
 *   不能 endRound 刚进 VERIFY 又被文本规则推到 RECORD；文本触发的非终结转换要带转换 nudge。
 * - C14：同一 tick 内发生过阶段转换（maxIterations 强制终结 / forceTerminal）时，rollbackTick
 *   不能把已归零的 phaseRounds 再减成 -1。
 * - C15：endRound({ skipped: true }) 早返回前也要清掉本轮搜索标记，否则泄漏到下一轮。
 * - C63（本地部分）：resolve 收到未知 strategy 名回退 bootstrap 生成策略时记 warn。
 */
function p18LogMessages(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.map(([message]) => String(message));
}

/** analyst：SCAN→EXPLORE 后每轮一次带新信息的 code read，推进到指定轮次且保持 EXPLORE。 */
function p18ExploreWithEvidenceUntil(t: ExplorationTracker, iteration: number) {
  t.tick();
  t.endRound({});
  expect(t.phase).toBe('EXPLORE');
  while (t.iteration < iteration) {
    t.tick();
    t.recordToolCall(
      'code',
      { action: 'read', params: { path: `src/f${t.iteration}.ts` } },
      `body of src/f${t.iteration}.ts`
    );
    t.endRound({ hasNewInfo: true, toolNames: ['code'] });
    expect(t.phase).toBe('EXPLORE');
  }
}

const P18_VERIFY_NUDGE_MARK = '现在进入证据验证阶段';

describe('L6-P18 text-round phase transitions (C10)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stays in VERIFY when a ≥40% no-new-info tool round is followed by a text round', () => {
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const t = new ExplorationTracker(STRATEGY_ANALYST, { maxIterations: 20 });
    // 40% 轮次线 = floor(20*0.4) = 8。
    p18ExploreWithEvidenceUntil(t, 8);

    // 第 9 轮：工具轮但没有新信息（roundsSinceNewInfo=1），尚不满足 EXPLORE→VERIFY。
    t.tick();
    t.recordToolCall('code', { action: 'read', params: { path: 'src/f2.ts' } }, 'body again');
    t.endRound({ hasNewInfo: false, toolNames: ['code'] });
    expect(t.phase).toBe('EXPLORE');

    // 第 10 轮文本轮：endRound 的 metrics 规则（≥40% 且 2 轮无新信息）EXPLORE→VERIFY，并返回 VERIFY 转换提示。
    t.tick();
    const transition = t.endRound({ hasNewInfo: false, submitCount: 0, toolNames: [] });
    expect(t.phase).toBe('VERIFY');
    expect(transition?.type).toBe('phase_transition');
    expect(transition?.text).toContain(P18_VERIFY_NUDGE_MARK);

    // 同轮 onTextResponse 不得再按 VERIFY→RECORD 文本规则（证据≥2）跳过 VERIFY。
    const result = t.onTextResponse('阶段性分析：模块 A 负责鉴权。');
    expect(t.phase).toBe('VERIFY');
    expect(result.isFinalAnswer).toBe(false);
    expect(result.shouldContinue).toBe(true);
    // VERIFY 证据已足时阶段分支没有专属 nudge；AgentRuntime 文本路径补发上面 endRound 的转换提示。
    expect(result.nudge).toBeNull();

    const skipped = p18LogMessages(info).filter((m) => m.includes('already transitioned'));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('EXPLORE → VERIFY');
  });

  it('does not skip VERIFY across two consecutive text rounds', () => {
    const t = new ExplorationTracker(STRATEGY_ANALYST, { maxIterations: 20 });
    t.tick();
    t.endRound({});
    t.tick();
    for (const path of ['src/a.ts', 'src/b.ts']) {
      t.recordToolCall('code', { action: 'read', params: { path } }, `body of ${path}`);
    }
    t.endRound({ hasNewInfo: true, toolNames: ['code'] });
    expect(t.phase).toBe('EXPLORE');

    const phases: string[] = [];
    for (let i = 0; i < 3; i++) {
      t.tick();
      t.endRound({});
      t.onTextResponse('阶段性分析：模块 A 负责鉴权。');
      phases.push(t.phase);
    }
    // 第 1 个文本轮仍在 EXPLORE；第 2 个文本轮 consecutiveIdleRounds=2 进入 VERIFY 并停留；第 3 个才进 RECORD。
    expect(phases).toEqual(['EXPLORE', 'VERIFY', 'RECORD']);
  });

  it('gives an EXPLORE→VERIFY text-triggered transition the VERIFY transition nudge', () => {
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const t = new ExplorationTracker(STRATEGY_ANALYST, { maxIterations: 10 });
    // 40% 轮次线 = 4；第 5 轮文本轮 endRound 不转换（只有 1 轮无新信息），由文本规则推进到 VERIFY。
    p18ExploreWithEvidenceUntil(t, 4);
    t.tick();
    expect(t.endRound({})).toBeNull();
    expect(t.phase).toBe('EXPLORE');

    const result = t.onTextResponse('阶段性分析：模块 A 负责鉴权。');
    expect(t.phase).toBe('VERIFY');
    expect(result.isFinalAnswer).toBe(false);
    expect(result.shouldContinue).toBe(true);
    expect(result.nudge).toContain(P18_VERIFY_NUDGE_MARK);
    expect(result.nudge).toContain('note_finding');

    const fallback = p18LogMessages(info).filter((m) => m.includes('text-triggered transition'));
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toContain('EXPLORE → VERIFY');
  });
});

describe('L6-P18 rollbackTick after a same-tick phase transition (C14)', () => {
  it('keeps phaseRounds at 0 when maxIterations forced the terminal phase in the rolled-back tick', () => {
    const t = new ExplorationTracker(STRATEGY_ANALYST, { maxIterations: 2 });
    t.tick();
    t.endRound({});
    expect(t.phase).toBe('EXPLORE');

    // 第 2 轮：shouldExit 因 maxIterations 强制转入 SUMMARIZE（phaseRounds 归零），随后 AI 调用失败回退。
    t.tick();
    expect(t.shouldExit()).toBe(false);
    expect(t.phase).toBe('SUMMARIZE');
    t.rollbackTick();
    expect(t.getMetrics()).toMatchObject({ phase: 'SUMMARIZE', phaseRounds: 0, iteration: 1 });

    // 下一轮重新计数，终结阶段 grace 从 1 开始而不是 0。
    t.tick();
    expect(t.getMetrics().phaseRounds).toBe(1);
  });

  it('keeps phaseRounds at 0 when forceTerminal ran in the rolled-back tick', () => {
    const t = new ExplorationTracker(STRATEGY_ANALYST, { maxIterations: 20 });
    t.tick();
    t.endRound({});
    t.tick();
    t.forceTerminal('session token budget nearly exhausted');
    expect(t.phase).toBe('SUMMARIZE');
    t.rollbackTick();
    expect(t.getMetrics()).toMatchObject({ phase: 'SUMMARIZE', phaseRounds: 0, iteration: 1 });
  });

  it('still undoes the phase round when the rolled-back tick did not transition', () => {
    const t = new ExplorationTracker(STRATEGY_ANALYST, { maxIterations: 20 });
    t.tick();
    t.endRound({});
    expect(t.phase).toBe('EXPLORE');
    t.tick();
    expect(t.getMetrics()).toMatchObject({ phaseRounds: 1, iteration: 2 });
    t.rollbackTick();
    expect(t.getMetrics()).toMatchObject({ phase: 'EXPLORE', phaseRounds: 0, iteration: 1 });
  });
});

describe('L6-P18 skipped rounds and unknown strategy names (C15/C63)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 探针策略：一轮搜索即转换，用来观察 searchRoundsInPhase 是否被跨轮多计。 */
  const searchProbeStrategy: ExplorationStrategy = {
    name: 'p18-search-probe',
    phases: ['EXPLORE', 'SUMMARIZE'],
    transitions: { 'EXPLORE→SUMMARIZE': { onMetrics: (m) => m.searchRoundsInPhase >= 1 } },
    getToolChoice: () => 'auto',
    enableReflection: false,
    reflectionInterval: 0,
    enablePlanning: false,
    replanInterval: 0,
  };

  it('does not leak the search flag of a skipped round into the next round', () => {
    const t = new ExplorationTracker(searchProbeStrategy, { maxIterations: 10 });
    t.tick();
    t.recordToolCall(
      'code',
      { action: 'search', params: { pattern: 'Repository' } },
      'src/a.ts:1: class Repository'
    );
    expect(t.endRound({ skipped: true })).toBeNull();

    // 下一轮没有搜索：修复前上一轮残留的搜索标记让 searchRoundsInPhase=1 并触发转换。
    t.tick();
    t.recordToolCall('code', { action: 'read', params: { path: 'src/a.ts' } }, 'body of src/a.ts');
    t.endRound({ hasNewInfo: true, toolNames: ['code'] });
    expect(t.phase).toBe('EXPLORE');

    // 对照：真实的搜索轮仍按轮计数。
    t.tick();
    t.recordToolCall(
      'code',
      { action: 'search', params: { pattern: 'Manager' } },
      'src/b.ts:3: class Manager'
    );
    t.endRound({ hasNewInfo: true, toolNames: ['code'] });
    expect(t.phase).toBe('SUMMARIZE');
  });

  it('warns when resolve falls back to the bootstrap strategy for an unknown strategy name', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'analyze' },
      { maxIterations: 6 }
    );
    expect(tracker?.strategyName).toBe('bootstrap');
    const fallbacks = p18LogMessages(warn).filter((m) => m.includes('unknown strategy'));
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toContain('"analyze"');
    expect(fallbacks[0]).toContain('bootstrap');

    warn.mockClear();
    for (const strategy of ['analyst', 'producer', 'bootstrap', undefined]) {
      ExplorationTracker.resolve({ source: 'system', strategy }, { maxIterations: 6 });
    }
    expect(p18LogMessages(warn).filter((m) => m.includes('unknown strategy'))).toEqual([]);
  });
});
