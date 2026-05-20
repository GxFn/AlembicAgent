import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { DiagnosticsCollector } from '../src/agent/runtime/index.js';

function createRuntimeForReactLoop() {
  const chatWithTools = vi.fn(async () => ({
    text: 'forced summary should not be called',
    functionCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const runtime = new AgentRuntime({
    aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute: vi.fn() } as never,
    capabilities: [],
    strategy: { name: 'unused', execute: vi.fn() } as never,
  });
  return { runtime, chatWithTools };
}

function createExitingTracker() {
  return {
    phase: 'SUMMARIZE',
    pipelineType: 'analyst',
    isGracefulExit: false,
    isHardExit: true,
    iteration: 1,
    totalSubmits: 0,
    tick: vi.fn(),
    shouldExit: vi.fn(() => true),
  };
}

describe('agent runtime forced summary suppression', () => {
  it('does not force summary after abort exits', async () => {
    const { runtime, chatWithTools } = createRuntimeForReactLoop();
    const abortController = new AbortController();
    abortController.abort();

    const result = await runtime.reactLoop('analyze', {
      source: 'system',
      abortSignal: abortController.signal,
      budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
    });

    expect(chatWithTools).not.toHaveBeenCalled();
    expect(result.reply).toContain('abort_signal');
    expect(result.diagnostics?.efficiency?.forcedSummary).toBe(false);
    expect(result.diagnostics?.efficiency?.cancelReason).toBe('abort_signal');
  });

  it('does not force summary after stage timeout exits', async () => {
    const { runtime, chatWithTools } = createRuntimeForReactLoop();
    const diagnostics = new DiagnosticsCollector();
    diagnostics.recordTimedOutStage('analyze');
    diagnostics.recordCancelReason('stage_timeout');

    const result = await runtime.reactLoop('analyze', {
      source: 'system',
      tracker: createExitingTracker() as never,
      diagnostics,
      budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
    });

    expect(chatWithTools).not.toHaveBeenCalled();
    expect(result.reply).toContain('stage_timeout');
    expect(result.diagnostics?.efficiency?.forcedSummary).toBe(false);
    expect(result.diagnostics?.efficiency?.cancelReason).toBe('stage_timeout');
  });

  it('does not promote degraded_no_findings into a normal summary completion', async () => {
    const { runtime, chatWithTools } = createRuntimeForReactLoop();
    const diagnostics = new DiagnosticsCollector();
    diagnostics.recordGateFailure(
      'quality_gate',
      'degraded_no_findings',
      'Record repair did not produce enough validated note_finding records'
    );

    const result = await runtime.reactLoop('analyze', {
      source: 'system',
      tracker: createExitingTracker() as never,
      diagnostics,
      budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
    });

    expect(chatWithTools).not.toHaveBeenCalled();
    expect(result.reply).toContain('degraded_no_findings');
    expect(result.diagnostics?.degraded).toBe(true);
    expect(result.diagnostics?.efficiency?.forcedSummary).toBe(false);
  });
});
