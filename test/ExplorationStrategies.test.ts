import { describe, expect, it } from 'vitest';
import {
  STRATEGY_ANALYST,
  targetMemoryFindingCount,
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
});
