import { describe, expect, it } from 'vitest';
import {
  STRATEGY_ANALYST,
  STRATEGY_PRODUCER,
  targetMemoryFindingCount,
  targetProducerSubmitCount,
} from '../src/agent/context/exploration/ExplorationStrategies.js';
import { ExplorationTracker } from '../src/agent/context/index.js';
import type { AgentRuntime, LoopContext } from '../src/agent/runtime/index.js';
import { createToolPipeline, DiagnosticsCollector } from '../src/agent/runtime/index.js';

describe('analyst exploration strategy boundaries', () => {
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

  it('requires broader structured findings when the evidence surface is broad', () => {
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

    expect(targetMemoryFindingCount(metrics)).toBe(5);
    expect(STRATEGY_ANALYST.transitions['RECORD→SUMMARIZE'].onMetrics(metrics, budget)).toBe(false);
    expect(
      STRATEGY_ANALYST.transitions['RECORD→SUMMARIZE'].onMetrics(
        { ...metrics, memoryFindingCount: 5 },
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
        { ...metrics, submitCount: 6 },
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
      { id: 'candidate-1', status: 'accepted' }
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
        { id: `candidate-${i}`, status: 'accepted' }
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

  it('lets producer final completion text stop after successful submissions', () => {
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'producer' },
      { maxIterations: 10, pipelineType: 'producer' }
    );

    expect(tracker).not.toBeNull();
    tracker?.tick();
    tracker?.recordToolCall(
      'knowledge',
      { action: 'submit' },
      { id: 'candidate-1', status: 'accepted' }
    );
    tracker?.endRound({ hasNewInfo: true, submitCount: 1, toolNames: ['knowledge'] });

    tracker?.tick();
    tracker?.endRound({ hasNewInfo: false, submitCount: 0, toolNames: [] });
    const textResult = tracker?.onTextResponse(
      '## 候选生产总结\n已完成 1 个候选提交。无未提交发现，不需要 Analyst 补证。'
    );

    expect(textResult?.isFinalAnswer).toBe(true);
    expect(textResult?.shouldContinue).toBe(false);
    expect(textResult?.nudge).toBeNull();
  });

  it('recognizes Package K producer completion wording as terminal', () => {
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'producer' },
      { maxIterations: 10, pipelineType: 'producer' }
    );

    expect(tracker).not.toBeNull();
    tracker?.tick();
    tracker?.recordToolCall(
      'knowledge',
      { action: 'submit' },
      { id: 'candidate-1', status: 'accepted' }
    );
    tracker?.endRound({ hasNewInfo: true, submitCount: 1, toolNames: ['knowledge'] });

    tracker?.tick();
    tracker?.endRound({ hasNewInfo: false, submitCount: 0, toolNames: [] });
    const textResult = tracker?.onTextResponse(
      '所有 6 个知识候选已成功提交，覆盖了 Analyst 分析中的全部 6 项发现。无未提交发现，无阻断。'
    );

    expect(textResult?.isFinalAnswer).toBe(true);
    expect(textResult?.shouldContinue).toBe(false);
    expect(textResult?.nudge).toBeNull();
  });

  it('recognizes Package M submitted/unsubmitted table as terminal', () => {
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'producer' },
      { maxIterations: 10, pipelineType: 'producer' }
    );

    expect(tracker).not.toBeNull();
    tracker?.tick();
    tracker?.recordToolCall(
      'knowledge',
      { action: 'submit' },
      { id: 'candidate-1', status: 'accepted' }
    );
    tracker?.endRound({ hasNewInfo: true, submitCount: 1, toolNames: ['knowledge'] });

    tracker?.tick();
    tracker?.endRound({ hasNewInfo: false, submitCount: 0, toolNames: [] });
    const textResult = tracker?.onTextResponse(
      '## 提交完成报告\n\n**已提交候选**: 5\n**未提交**: 0\n\n覆盖情况：结构化发现已完成候选提交。'
    );

    expect(textResult?.isFinalAnswer).toBe(true);
    expect(textResult?.shouldContinue).toBe(false);
    expect(textResult?.nudge).toBeNull();
  });

  it('recognizes Package O mixed English completion summary as terminal', () => {
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'producer' },
      { maxIterations: 10, pipelineType: 'producer' }
    );

    expect(tracker).not.toBeNull();
    tracker?.tick();
    tracker?.recordToolCall(
      'knowledge',
      { action: 'submit' },
      { id: 'candidate-1', status: 'accepted' }
    );
    tracker?.endRound({ hasNewInfo: true, submitCount: 1, toolNames: ['knowledge'] });

    tracker?.tick();
    tracker?.endRound({ hasNewInfo: false, submitCount: 0, toolNames: [] });
    const textResult = tracker?.onTextResponse(
      [
        'All 7 structured Analyst findings have been successfully submitted.',
        '',
        '## 提交总结',
        '- **提交候选数**: 7/7',
        '- **覆盖率**: 100%',
        '- **阻塞项**: 无',
      ].join('\n')
    );

    expect(textResult?.isFinalAnswer).toBe(true);
    expect(textResult?.shouldContinue).toBe(false);
    expect(textResult?.nudge).toBeNull();
  });

  it('keeps VERIFY focused on evidence checks instead of broad exploration', async () => {
    const diagnostics = new DiagnosticsCollector();
    let executeCount = 0;
    const runtime = {
      id: 'analyst-verify-boundary-runtime',
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
            structuredContent: { ok: true },
            durationMs: 1,
            startedAt: new Date().toISOString(),
            toolId: request.toolId,
            callId: `verify-boundary-call-${executeCount}`,
          };
        },
      },
    } as unknown as AgentRuntime;
    const loopCtx = {
      allowedToolIds: ['code', 'graph', 'terminal', 'memory'],
      abortSignal: null,
      context: { pipelinePhase: 'analyze' },
      diagnostics,
      iteration: 1,
      memoryCoordinator: null,
      sharedState: {},
      source: 'system',
      toolCalls: [],
      tracker: {
        pipelineType: 'analyst',
        phase: 'VERIFY',
        recordToolCall: () => ({ isNew: false }),
      },
      trace: null,
    } as unknown as LoopContext;
    const pipeline = createToolPipeline();

    const blockedSearch = await pipeline.execute(
      { id: 'code-search', name: 'code', args: { action: 'search', params: { pattern: 'Agent' } } },
      { runtime, loopCtx, iteration: 1 }
    );
    const blockedGraphSearch = await pipeline.execute(
      {
        id: 'graph-search',
        name: 'graph',
        args: { action: 'query', params: { type: 'search', entity: 'Agent' } },
      },
      { runtime, loopCtx, iteration: 1 }
    );
    const blockedTerminal = await pipeline.execute(
      {
        id: 'terminal-run',
        name: 'terminal',
        args: { action: 'exec', params: { cmd: 'rg Agent' } },
      },
      { runtime, loopCtx, iteration: 1 }
    );
    const allowedRead = await pipeline.execute(
      { id: 'code-read', name: 'code', args: { action: 'read', params: { path: 'src/foo.ts' } } },
      { runtime, loopCtx, iteration: 1 }
    );
    const allowedGraph = await pipeline.execute(
      {
        id: 'graph-callers',
        name: 'graph',
        args: { action: 'query', params: { type: 'callers', entity: 'Foo.run' } },
      },
      { runtime, loopCtx, iteration: 1 }
    );

    expect(blockedSearch.metadata.blocked).toBe(true);
    expect(blockedGraphSearch.metadata.blocked).toBe(true);
    expect(blockedTerminal.metadata.blocked).toBe(true);
    expect(allowedRead.metadata.blocked).toBe(false);
    expect(allowedGraph.metadata.blocked).toBe(false);
    expect(executeCount).toBe(2);
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
            structuredContent: { ok: true },
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
      sharedState: {},
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
        args: { action: 'submit', params: { title: 'FeatureCoordinator' } },
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
    expect(executeCount).toBe(2);
  });
});
