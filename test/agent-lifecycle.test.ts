import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExplorationTracker } from '../src/agent/context/ExplorationTracker.js';
import { AgentRunCoordinator } from '../src/agent/coordination/AgentRunCoordinator.js';
import { producerRejectionGateEvaluator } from '../src/agent/evaluation/gateEvaluators.js';
import { buildScanPipelineStages } from '../src/agent/evaluation/stageBuilders.js';
import { ActiveContext } from '../src/agent/memory/ActiveContext.js';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
import { BudgetPolicy, Policy, PolicyEngine, SafetyPolicy } from '../src/agent/policies/index.js';
import { INSIGHT_PRESET } from '../src/agent/profiles/presets/insightPreset.js';
import { buildProducerRetryPrompt } from '../src/agent/prompts/producerRetry.js';
import { AgentEventBus, AgentEvents } from '../src/agent/runtime/AgentEventBus.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import type { RuntimeConfig } from '../src/agent/runtime/AgentRuntimeTypes.js';
import { DiagnosticsCollector } from '../src/agent/runtime/DiagnosticsCollector.js';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentRuntimeLike,
  CompiledAgentProfile,
} from '../src/agent/service/AgentRunContracts.js';
import { AgentRuntimeBuilder } from '../src/agent/service/AgentRuntimeBuilder.js';
import { AgentService } from '../src/agent/service/AgentService.js';
import { FanOutStrategy } from '../src/agent/strategies/FanOutStrategy.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';
import type { StrategyRuntime } from '../src/agent/strategies/Strategy.js';
import { isPersistedSubmission } from '../src/agent/utils/toolOutcomes.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';

function harness(
  chatWithTools: ReturnType<typeof vi.fn>,
  maxIterations = 2,
  overrides: Partial<RuntimeConfig> = {}
) {
  const runtime = new AgentRuntime({
    aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute: vi.fn() } as never,
    strategy: new SingleStrategy(),
    policies: new PolicyEngine([new BudgetPolicy({ maxIterations, timeoutMs: 100 })]),
    capabilities: [],
    ...overrides,
  });
  const service = new AgentService({ runtimeBuilder: { build: () => runtime } });
  const input = {
    profile: { preset: 'chat' },
    message: { content: 'hello' },
    context: { source: 'http-chat' as const },
  };
  return { runtime, service, input };
}

function stageOutput(reply = 'done') {
  return {
    reply,
    toolCalls: [] as Array<Record<string, unknown>>,
    iterations: 1,
    tokenUsage: { input: 1, output: 1 },
  };
}

async function flushPipelineTasks() {
  for (let index = 0; index < 30; index++) {
    await Promise.resolve();
  }
}

describe('Runtime operation boundary', () => {
  it.each([
    'normal',
    'postprocessing',
  ] as const)('does not retry trace closure or replace the original %s error', async (mode) => {
    vi.useFakeTimers();
    const trace = new ActiveContext();
    const memory = new MemoryCoordinator();
    const primaryFailure = new Error('Postprocessing failed');
    const closeFailure = new Error('Trace closure failed');
    const close = vi.spyOn(trace, 'endRound').mockImplementation(() => {
      throw closeFailure;
    });
    vi.spyOn(memory, 'recordObservation').mockImplementation(() => {
      throw primaryFailure;
    });
    const chat = vi
      .fn()
      .mockResolvedValue(mode === 'normal' ? { text: 'done', functionCalls: [] } : toolReply);
    const { runtime, execute } = toolHarness(chat);
    const finalized = vi.fn();
    runtime.hookSystem.on('agent:finalize', finalized);
    runtime.logger = {
      info: () => undefined,
      warn: () => {
        throw new Error('Cleanup diagnostic failed');
      },
    };
    try {
      await expect(
        runtime.reactLoop('close round', { trace, memoryCoordinator: memory })
      ).rejects.toBe(mode === 'normal' ? closeFailure : primaryFailure);
      expect(close).toHaveBeenCalledOnce();
      expect(chat).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledTimes(mode === 'normal' ? 0 : 1);
      expect(runtime.toolCallHistory).toHaveLength(mode === 'normal' ? 0 : 1);
      expect(finalized).not.toHaveBeenCalled();
    } finally {
      memory.dispose();
    }
  });

  it('closes a pre-exit trace round before finalization observers run', async () => {
    vi.useFakeTimers();
    const trace = new ActiveContext();
    const chat = vi.fn();
    const { runtime } = harness(chat);
    const controller = new AbortController();
    controller.abort();
    let observed: number | null | undefined;
    runtime.hookSystem.on('agent:finalize', () => {
      observed = trace.getCurrentIteration();
    });
    await runtime.reactLoop('stop', { source: 'system', trace, abortSignal: controller.signal });
    expect(chat).not.toHaveBeenCalled();
    expect(observed).toBeNull();
    expect(trace.getCurrentIteration()).toBeNull();
    expect(trace.toJSON().rounds).toHaveLength(1);
  });

  it('closes every empty-response retry round before forced summary', async () => {
    vi.useFakeTimers();
    const trace = new ActiveContext();
    let observed: number | null | undefined;
    const chat = vi
      .fn()
      .mockResolvedValueOnce({ text: '', functionCalls: [] })
      .mockResolvedValueOnce({ text: '', functionCalls: [] })
      .mockResolvedValueOnce({ text: '', functionCalls: [] })
      .mockImplementationOnce(async () => {
        observed = trace.getCurrentIteration();
        return { text: 'summary retained', functionCalls: [] };
      });
    const { runtime } = harness(chat, 8);
    const pending = runtime.reactLoop('empty retry', {
      source: 'system',
      trace,
      budgetOverride: { maxIterations: 8, timeoutMs: 10_000 },
    });
    await vi.runAllTimersAsync();
    expect((await pending).reply).toBe('summary retained');
    expect(chat).toHaveBeenCalledTimes(4);
    expect(observed).toBeNull();
    expect(trace.getCurrentIteration()).toBeNull();
    expect(trace.toJSON().rounds).toHaveLength(3);
  });

  it.each([
    'abort',
    'timeout',
    'complete',
  ] as const)('reports a scan %s with its real terminal flags and confirmed receipts', async (mode) => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const trace = new ActiveContext();
    const chat = vi.fn().mockResolvedValue(toolReply);
    const { runtime, execute } = toolHarness(chat);
    const originalExecute = execute.getMockImplementation();
    if (!originalExecute) {
      throw new Error('Tool receipt fixture must resolve');
    }
    execute.mockImplementation(async () => {
      const receipt = await originalExecute();
      if (mode === 'timeout') {
        vi.setSystemTime(startedAt + 11);
      }
      return receipt;
    });
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'producer' },
      {
        pipelineType: 'scan',
        maxIterations: mode === 'complete' ? 2 : 8,
        maxSubmits: 10,
        softSubmitLimit: 10,
      }
    );
    if (!tracker) {
      throw new Error('Scan tracker fixture must resolve');
    }
    const controller = new AbortController();
    if (mode === 'abort') {
      controller.abort();
    }
    const result = await runtime.reactLoop('scan', {
      source: 'system',
      trace,
      tracker,
      toolChoiceOverride: 'auto',
      abortSignal: controller.signal,
      budgetOverride: { maxIterations: 8, timeoutMs: 10 },
    });
    expect(chat).toHaveBeenCalledTimes(mode === 'abort' ? 0 : mode === 'complete' ? 2 : 1);
    expect(execute).toHaveBeenCalledTimes(mode === 'abort' ? 0 : 1);
    expect(result.toolCalls).toHaveLength(mode === 'abort' ? 0 : 1);
    expect(trace.getCurrentIteration()).toBeNull();
    if (mode === 'complete') {
      expect(result.reply).toBe('[scan complete: 0 recipes collected]');
      expect(result).not.toHaveProperty('timedOut');
      expect(result).not.toHaveProperty('aborted');
    } else {
      const reason = mode === 'abort' ? 'abort_signal' : 'stage_timeout';
      expect(result.reply).toContain(`[run stopped: ${reason}]`);
      expect(result).toHaveProperty(mode === 'abort' ? 'aborted' : 'timedOut', true);
      expect(result.diagnostics?.efficiency?.cancelReason).toBe(reason);
    }
  });

  it('propagates an inner scan deadline through Pipeline and Service without recovered success', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const chat = vi.fn().mockResolvedValue(toolReply);
    const { runtime, service, input, execute } = toolHarness(chat);
    const originalExecute = execute.getMockImplementation();
    if (!originalExecute) {
      throw new Error('Tool receipt fixture must resolve');
    }
    execute.mockImplementation(async () => {
      const receipt = await originalExecute();
      vi.setSystemTime(startedAt + 11);
      return receipt;
    });
    runtime.strategy = new PipelineStrategy({
      stages: [
        {
          name: 'produce',
          pipelineType: 'scan',
          toolChoiceOverride: 'auto',
          additionalTools: ['meta'],
          budget: { maxIterations: 8, timeoutMs: 10 },
        },
      ],
    });
    const result = await service.run({
      ...input,
      context: {
        ...input.context,
        trace: new ActiveContext(),
        strategyContext: {
          pipelineType: 'scan',
          tracker: ExplorationTracker.resolve(
            { source: 'system', strategy: 'producer' },
            { pipelineType: 'scan', maxIterations: 8 }
          ),
        },
      },
      execution: { timeoutMs: 10_000 },
    });
    expect(result.status).toBe('timeout');
    expect(result.reply).not.toContain('[scan complete:');
    expect(result.toolCalls).toHaveLength(1);
    expect(chat).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    'memory',
    'tracker',
    'trace',
  ] as const)('retains the returned host receipt when default %s postprocessing fails', async (port) => {
    vi.useFakeTimers();
    const failure = new Error(`Synthetic ${port} observer failure`);
    const memory = new MemoryCoordinator();
    const trace = new ActiveContext();
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'analyst' },
      { maxIterations: 8, searchBudget: 8 }
    );
    if (!tracker) {
      throw new Error('Tracker fixture must resolve');
    }
    const after =
      port === 'memory'
        ? vi.spyOn(memory, 'recordObservation')
        : port === 'trace'
          ? vi.spyOn(trace, 'recordToolCall')
          : vi.spyOn(tracker, 'recordToolCall');
    after.mockImplementation(() => {
      throw failure;
    });
    const chat = vi
      .fn()
      .mockResolvedValueOnce({ ...toolReply, usage: { inputTokens: 4, outputTokens: 3 } })
      .mockResolvedValue({ text: 'must not continue after observer failure', functionCalls: [] });
    const { runtime, service, input, execute } = toolHarness(chat);
    class InjectedSingleStrategy extends SingleStrategy {
      override execute(
        owner: StrategyRuntime,
        message: AgentMessage,
        options: Record<string, unknown> = {}
      ) {
        return super.execute(owner, message, {
          ...options,
          ...(port === 'tracker' ? { tracker, toolChoiceOverride: 'auto' } : {}),
        });
      }
    }
    runtime.strategy = new InjectedSingleStrategy();
    try {
      const result = await service.run({
        ...input,
        context: { ...input.context, memoryCoordinator: memory, trace },
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(after).toHaveBeenCalledOnce();
      expect(chat).toHaveBeenCalledOnce();
      expect(result.status).toBe('error');
      expect(result.reply).toBe(failure.message);
      expect(result.usage).toMatchObject({ inputTokens: 4, outputTokens: 3 });
      expect(result.toolCalls).toMatchObject([
        { tool: 'meta', result: { observed: true }, envelope: { ok: true } },
      ]);
      expect(trace.getCurrentIteration()).toBeNull();
      expect(trace.toJSON().rounds).toHaveLength(1);
      expect(runtime.toolCallHistory).toHaveLength(1);
      expect(runtime.toolCallHistory[0].envelope).toBe(await execute.mock.results[0].value);
    } finally {
      after.mockRestore();
      memory.dispose();
      vi.useRealTimers();
    }
  });

  function toolHarness(chat: ReturnType<typeof vi.fn>, onToolCall?: RuntimeConfig['onToolCall']) {
    const execute = vi.fn(async () => ({
      ok: true,
      status: 'success',
      toolId: 'meta',
      callId: 'fixture',
      startedAt: new Date().toISOString(),
      durationMs: 1,
      text: 'confirmed tool result',
      structuredContent: { observed: true },
    }));
    return {
      ...harness(chat, 3, {
        additionalTools: ['meta'],
        toolRouter: { execute } as never,
        container: { get: () => new RuntimeCapabilityCatalog() },
        onToolCall,
      }),
      execute,
    };
  }

  const toolReply = {
    text: null,
    functionCalls: [{ id: 'fixture', name: 'meta', args: { action: 'tools', params: {} } }],
  };

  it('keeps confirmed tool receipts when cancellation interrupts a later model request', async () => {
    // 此例验证显式取消；并行全检的机器负载不应先触发夹具的100ms期限。
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const lateReply = Promise.withResolvers<{ text: string; functionCalls: never[] }>();
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolReply)
      .mockImplementationOnce(() => {
        entered.resolve();
        return lateReply.promise;
      });
    const { runtime, service, input, execute } = toolHarness(chat);
    const pending = service.run(input);
    try {
      await entered.promise;
      runtime.abort('cancel after a confirmed tool result');
      const result = await pending;
      expect(result).toMatchObject({
        status: 'aborted',
        toolCalls: [{ tool: 'meta', result: { observed: true }, envelope: { ok: true } }],
      });
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      lateReply.resolve({ text: 'too late', functionCalls: [] });
      await pending;
      await flushPipelineTasks();
      vi.useRealTimers();
    }
  });

  it('keeps confirmed tool receipts and usage when a later model request reaches the hard timeout', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const entered = Promise.withResolvers<void>();
    const lateReply = Promise.withResolvers<{ text: string; functionCalls: never[] }>();
    const chat = vi
      .fn()
      .mockResolvedValueOnce({ ...toolReply, usage: { inputTokens: 12, outputTokens: 7 } })
      .mockImplementationOnce(() => {
        entered.resolve();
        return lateReply.promise;
      });
    const { service, input, execute } = toolHarness(chat);
    const pending = service.run({ ...input, execution: { timeoutMs: 1000 } });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toMatchObject({
        status: 'timeout',
        toolCalls: [{ tool: 'meta', result: { observed: true }, envelope: { ok: true } }],
        usage: { inputTokens: 12, outputTokens: 7 },
      });
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      lateReply.resolve({ text: 'too late', functionCalls: [] });
      await pending;
      await flushPipelineTasks();
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps a confirmed result when resource cleanup and its diagnostic observer both fail', async () => {
    // 本例验证已确认结果的清理语义；保留100ms预算，但不让并行负载先触发无关的阶段超时。
    vi.useFakeTimers();
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolReply)
      .mockResolvedValue({ text: 'done', functionCalls: [] });
    const { runtime, service, input, execute } = toolHarness(chat);
    runtime.toolRouter.releaseScope = vi.fn(async () => {
      throw new Error('cleanup failed');
    });
    const warn = vi.spyOn(runtime.logger, 'warn').mockImplementation(() => {
      throw new Error('diagnostic failed');
    });
    try {
      expect(await service.run(input)).toMatchObject({
        status: 'success',
        reply: 'done',
        toolCalls: [{ result: { observed: true } }],
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(runtime.toolRouter.releaseScope).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    'sync',
    'async',
  ])('isolates a %s tool observer failure without replaying the tool', async (mode) => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const chat = vi
      .fn()
      .mockResolvedValueOnce(toolReply)
      .mockResolvedValue({ text: 'done', functionCalls: [] });
    const { service, input, execute } = toolHarness(chat, () => {
      if (mode === 'async') {
        return Promise.reject(new Error('observer private tool payload'));
      }
      throw new Error('observer private tool payload');
    });
    try {
      expect(await service.run(input)).toMatchObject({
        status: 'success',
        toolCalls: [{ result: { observed: true } }],
      });
      await flushPipelineTasks();
      expect(execute).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('tool observer failed'),
        expect.objectContaining({ tool: 'meta' })
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('observer private tool payload');
    } finally {
      warn.mockRestore();
    }
  });

  it('settles cancellation without waiting for an uncooperative provider and preserves the reason', async () => {
    vi.useFakeTimers();
    const pendingReply = Promise.withResolvers<{ text: string; functionCalls: never[] }>();
    const entered = Promise.withResolvers<AbortSignal>();
    const chat = vi.fn((_prompt, options) => {
      entered.resolve(options.abortSignal);
      return pendingReply.promise;
    });
    const { runtime, service, input } = harness(chat);
    const parent = new AbortController();
    const aborted = vi.fn();
    runtime.bus.on(AgentEvents.AGENT_ABORTED, aborted);
    const releaseScope = vi.fn();
    runtime.toolRouter.releaseScope = releaseScope;
    const reason = new Error('caller stopped this run');
    let result: Awaited<ReturnType<AgentService['run']>> | undefined;
    const pending = service
      .run({ ...input, execution: { abortSignal: parent.signal } })
      .then((value) => {
        result = value;
        return value;
      });
    try {
      const signal = await entered.promise;
      parent.abort(reason);
      await flushPipelineTasks();
      expect(result?.status).toBe('aborted');
      expect(signal.reason).toBe(reason);
      expect(result?.diagnostics?.efficiency?.cancelReason).toBe('abort_signal');
      expect(releaseScope).toHaveBeenCalledWith({ runId: expect.any(String) });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      runtime.abort('already stopped');
      expect(aborted).toHaveBeenCalledOnce();
    } finally {
      pendingReply.resolve({ text: 'late result', functionCalls: [] });
      await pending;
      await flushPipelineTasks();
      runtime.bus.off(AgentEvents.AGENT_ABORTED, aborted);
      vi.useRealTimers();
    }
  });

  it('does not start the strategy after a pre-cancelled parent signal', async () => {
    const execute = vi.fn(async () => stageOutput());
    const { service, input } = harness(vi.fn(), 2, { strategy: { execute } as never });
    const parent = new AbortController();
    parent.abort('pre-cancelled');
    expect(
      await service.run({ ...input, execution: { abortSignal: parent.signal } })
    ).toMatchObject({ status: 'aborted' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves the execution failure when a state-transition observer throws', async () => {
    const failure = new Error('original strategy failure');
    const { runtime } = harness(vi.fn(), 2, {
      strategy: {
        execute: async () => {
          throw failure;
        },
      } as never,
    });
    runtime.state.on('transition', () => {
      throw new Error('state observer failed');
    });
    await expect(runtime.execute(new AgentMessage({ content: 'task' }))).rejects.toBe(failure);
  });

  it('keeps a hard timeout authoritative when strategy resolves synchronously on abort', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const execute = vi.fn(
      (_runtime, _message, options) =>
        new Promise((resolve) => {
          options.abortSignal.addEventListener(
            'abort',
            () => resolve(stageOutput('cooperative late reply')),
            { once: true }
          );
        })
    );
    const { service, input } = harness(vi.fn(), 2, { strategy: { execute } as never });
    try {
      const pending = service.run({ ...input, execution: { timeoutMs: 10 } });
      await vi.advanceTimersByTimeAsync(10);
      expect(await pending).toMatchObject({ status: 'timeout' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    'sync',
    'async',
  ])('isolates a %s progress observer failure from the real run and event bus', async (mode) => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const chat = vi.fn(async () => ({ text: 'done', functionCalls: [] }));
    const observed = vi.fn();
    const { runtime, service, input } = harness(chat, 2, {
      onProgress: () => {
        if (mode === 'async') {
          return Promise.reject(new Error('observer private request body'));
        }
        throw new Error('observer private request body');
      },
    });
    runtime.bus.on(AgentEvents.PROGRESS, observed);
    try {
      expect(await service.run(input)).toMatchObject({ status: 'success', reply: 'done' });
      await flushPipelineTasks();
      expect(chat).toHaveBeenCalledOnce();
      expect(observed).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('progress observer failed'),
        expect.objectContaining({ eventType: expect.any(String) })
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('observer private request body');
    } finally {
      runtime.bus.off(AgentEvents.PROGRESS, observed);
      warn.mockRestore();
    }
  });
});

describe('Pipeline attempt lifecycle', () => {
  it.each([
    {
      label: 'readback required',
      partial: { startedToolCalls: 0, completedToolCalls: 0, requiresReadback: true },
      retry: false,
      aborted: false,
    },
    {
      label: 'started tool',
      partial: { startedToolCalls: 1, completedToolCalls: 0, requiresReadback: false },
      retry: false,
      aborted: false,
    },
    {
      label: 'completed tool without its result',
      partial: { startedToolCalls: 0, completedToolCalls: 1, requiresReadback: false },
      retry: false,
      aborted: false,
    },
    {
      label: 'unknown started count',
      partial: { startedToolCalls: null, completedToolCalls: 0, requiresReadback: false },
      retry: false,
      aborted: false,
    },
    {
      label: 'unknown started count with native observation',
      partial: { startedToolCalls: null, completedToolCalls: 0, requiresReadback: false },
      retry: false,
      aborted: false,
      native: true,
    },
    {
      label: 'aborted with partial evidence',
      partial: { startedToolCalls: 1, completedToolCalls: 0, requiresReadback: true },
      retry: false,
      aborted: true,
    },
    {
      label: 'confirmed zero tools',
      partial: { startedToolCalls: 0, completedToolCalls: 0, requiresReadback: false },
      retry: true,
      aborted: false,
    },
  ])('consumes host-reported partial evidence: $label', async ({
    partial,
    retry,
    aborted,
    native,
  }) => {
    const reactLoop = vi
      .fn()
      .mockResolvedValueOnce({ ...stageOutput(''), timedOut: true, aborted, partial })
      .mockResolvedValue(stageOutput('recovered'));
    const output = await new PipelineStrategy({
      stages: [{ name: 'analyze', retryBudget: { maxIterations: 1 } }],
    }).execute(
      {
        id: 'reported-partial',
        reactLoop,
        ...(native ? { bus: new AgentEventBus(), toolCallHistory: [] } : {}),
      },
      new AgentMessage({ content: 'task' })
    );
    expect(reactLoop).toHaveBeenCalledTimes(retry ? 2 : 1);
    if (retry) {
      expect(output.reply).toBe('recovered');
    } else {
      expect(output.phases.analyze).toMatchObject({ timedOut: true, partial });
      expect(output.toolCalls).toEqual([]); // 只有计数的回执不得捏造工具内容或标识。
    }
  });

  it.each([
    false,
    true,
  ])('stops on host-reported cancellation even with timedOut=%s', async (timedOut) => {
    const parent = new AbortController();
    const gate = vi.fn(() => ({ action: 'pass', pass: true }));
    const reactLoop = vi
      .fn()
      .mockResolvedValueOnce({ ...stageOutput('host stopped'), aborted: true, timedOut })
      .mockResolvedValue(stageOutput('must not execute'));
    const output = await new PipelineStrategy({
      stages: [
        { name: 'analyze', retryBudget: { maxIterations: 1 } },
        { name: 'quality_gate', gate: { evaluator: gate } },
        { name: 'produce' },
      ],
    }).execute({ id: 'host-aborted', reactLoop }, new AgentMessage({ content: 'task' }), {
      abortSignal: parent.signal,
    });
    expect(parent.signal.aborted).toBe(false);
    expect(reactLoop).toHaveBeenCalledOnce();
    expect(gate).not.toHaveBeenCalled();
    expect(output.outcome).toBe('aborted');
    expect(output.phases._pipelineOutcome).toMatchObject({ outcome: 'aborted' });
    expect(output.phases).not.toHaveProperty('produce');
    expect(output.tokenUsage).toEqual({ input: 1, output: 1 });
    expect(output.diagnostics.efficiency?.cancelReason).toBe('stage_aborted');
  });

  it.each([
    'record_repair',
    'summary_rewrite',
  ])('stops host-reported cancellation during %s without reevaluating its gate', async (action) => {
    const parent = new AbortController();
    const gate = vi
      .fn()
      .mockReturnValueOnce({ action, pass: false, artifact: { findings: [], referencedFiles: [] } })
      .mockReturnValue({ action: 'pass', pass: true });
    const reactLoop = vi
      .fn()
      .mockResolvedValueOnce(stageOutput('analysis'))
      .mockResolvedValueOnce({ ...stageOutput('cancelled repair'), aborted: true })
      .mockResolvedValue(stageOutput('must not execute'));
    const output = await new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        { name: 'quality_gate', gate: { evaluator: gate } },
        { name: 'produce' },
      ],
    }).execute({ id: 'repair-aborted', reactLoop }, new AgentMessage({ content: 'task' }), {
      abortSignal: parent.signal,
    });
    expect(parent.signal.aborted).toBe(false);
    expect(reactLoop).toHaveBeenCalledTimes(2);
    expect(gate).toHaveBeenCalledOnce();
    expect(output.outcome).toBe('aborted');
    expect(output.phases.quality_gate).toMatchObject({ action });
    expect(output.phases.analyze).toMatchObject({ reply: 'analysis' });
    expect(output.phases[`quality_gate_${action}`]).toMatchObject({ aborted: true });
    expect(output.phases).not.toHaveProperty('produce');
    expect(output.degraded).toBe(false);
  });

  it('retains distinct completed call identities even when arguments and outputs are identical', async () => {
    const args = { action: 'read' };
    const result = { content: 'same content' };
    const toolCallHistory: Array<Record<string, unknown>> = [];
    const runtime = {
      id: 'distinct-observations',
      toolCallHistory,
      reactLoop: async (_prompt: string, options?: Record<string, unknown>) => {
        toolCallHistory.push({ tool: 'code', args, result, envelope: { callId: 'first' } });
        (options?.onToolCall as (...args: unknown[]) => void)?.('code', args, result, 1);
        return {
          ...stageOutput(),
          toolCalls: [{ tool: 'code', args, result, envelope: { callId: 'second' } }],
        };
      },
    };
    const output = await new PipelineStrategy({ stages: [{ name: 'analyze' }] }).execute(
      runtime,
      new AgentMessage({ content: 'task' })
    );
    expect(
      output.toolCalls.map((call) => (call.envelope as { callId: string }).callId).sort()
    ).toEqual(['first', 'second']);
  });
  it('does not double-count callback observations copied into the returned stage result', async () => {
    const args = { action: 'read', params: { path: 'src/a.ts' } };
    const result = { content: 'observed' };
    const runtime = {
      id: 'copied-observation',
      reactLoop: async (_prompt: string, options?: Record<string, unknown>) => {
        (options?.onToolCall as (...args: unknown[]) => void)?.('code', args, result, 1);
        return { ...stageOutput(), toolCalls: structuredClone([{ tool: 'code', args, result }]) };
      },
    };
    const output = await new PipelineStrategy({ stages: [{ name: 'analyze' }] }).execute(
      runtime,
      new AgentMessage({ content: 'task' })
    );
    expect(output.toolCalls).toEqual([{ tool: 'code', args, result }]);
  });
  it.each([
    'prepare',
    'execute',
  ])('settles parent cancellation during %s and ignores late work', async (phase) => {
    const controller = new AbortController();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reactLoop = vi.fn(async () => {
      if (phase === 'execute') {
        await waiting;
      }
      return stageOutput('late');
    });
    const gate = vi.fn(() => ({ action: 'pass', pass: true }));
    const strategy = new PipelineStrategy({
      stages: [
        {
          name: 'analyze',
          promptBuilder: async () => {
            if (phase === 'prepare') {
              await waiting;
            }
            return 'prepared';
          },
        },
        { name: 'quality_gate', gate: { evaluator: gate } },
        { name: 'produce' },
      ],
    });
    let settled = false;
    const pending = strategy
      .execute({ id: 'parent-cancel', reactLoop }, new AgentMessage({ content: 'task' }), {
        abortSignal: controller.signal,
      })
      .then((result) => {
        settled = true;
        return result;
      });
    try {
      await flushPipelineTasks();
      controller.abort();
      await flushPipelineTasks();
      expect(settled).toBe(true);
      expect(await pending).toMatchObject({ outcome: 'aborted' });
      release();
      await flushPipelineTasks();
      expect(reactLoop).toHaveBeenCalledTimes(phase === 'prepare' ? 0 : 1);
      expect(gate).not.toHaveBeenCalled();
    } finally {
      release();
      await flushPipelineTasks();
    }
  });

  it('shares the hard deadline across asynchronous preparation and execution', async () => {
    // Winston Console 的 logged setImmediate 与阶段期限无关；保留日志调用断言与真实 timer 断言。
    const loggerInfo = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const reactLoop = vi.fn(() => new Promise<ReturnType<typeof stageOutput>>(() => {}));
      const strategy = new PipelineStrategy({
        stages: [
          {
            name: 'analyze',
            budget: { timeoutMs: 10 },
            promptBuilder: async () => {
              await new Promise((resolve) => setTimeout(resolve, 30_000));
              return 'prepared';
            },
          },
        ],
      });
      let settled = false;
      const pending = strategy
        .execute({ id: 'preparation-deadline', reactLoop }, new AgentMessage({ content: 'task' }))
        .then((result) => {
          settled = true;
          return result;
        });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reactLoop).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30_010);
      expect(settled).toBe(true);
      expect((await pending).phases.analyze).toMatchObject({ timedOut: true });
      expect(loggerInfo).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      loggerInfo.mockRestore();
      vi.useRealTimers();
    }
  });

  it('classifies cooperative resolve-on-abort as a hard timeout', async () => {
    vi.useFakeTimers();
    try {
      const strategy = new PipelineStrategy({
        stages: [{ name: 'analyze', budget: { timeoutMs: 1 } }],
      });
      const runtime = {
        id: 'cooperative-timeout',
        reactLoop: (_prompt: string, opts?: Record<string, unknown>) =>
          new Promise<ReturnType<typeof stageOutput>>((resolve) => {
            (opts?.abortSignal as AbortSignal).addEventListener(
              'abort',
              () => resolve(stageOutput('late partial')),
              { once: true }
            );
          }),
      };
      const pending = strategy.execute(runtime, new AgentMessage({ content: 'task' }));
      await vi.advanceTimersByTimeAsync(60_001);
      const result = await pending;
      expect(result.phases.analyze).toMatchObject({ timedOut: true });
      expect(result.diagnostics.timedOutStages).toEqual(['analyze']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains completed native tool envelopes and observed cost without replaying side effects', async () => {
    vi.useFakeTimers();
    const bus = new AgentEventBus();
    const stageHook = vi.fn();
    const runtimeHook = vi.fn();
    const args = { action: 'submit', params: { title: 'Created before timeout' } };
    const data = { status: 'created', id: 'candidate-1' };
    const envelope = { ok: true, status: 'success', text: 'created', structuredContent: data };
    const entry = { tool: 'knowledge', args, result: data, envelope, durationMs: 1 };
    const toolCallHistory: Array<Record<string, unknown>> = [];
    const runtime = {
      id: 'partial-native',
      bus,
      toolCallHistory,
      onToolCall: runtimeHook,
      reactLoop: vi.fn((_prompt: string, opts?: Record<string, unknown>) => {
        bus.publish(AgentEvents.TOOL_CALL_START, { agentId: 'partial-native', tool: 'knowledge' });
        toolCallHistory.push(entry);
        (opts?.diagnostics as DiagnosticsCollector).recordTokenUsage({
          inputTokens: 50,
          outputTokens: 10,
        });
        (opts?.onToolCall as (...args: unknown[]) => void)?.('knowledge', args, data, 2);
        return new Promise<ReturnType<typeof stageOutput>>(() => {});
      }),
    };
    try {
      const strategy = new PipelineStrategy({
        stages: [
          {
            name: 'produce',
            budget: { timeoutMs: 1 },
            retryBudget: { timeoutMs: 1 },
            onToolCall: stageHook,
          },
        ],
      });
      let settled = false;
      const pending = strategy
        .execute(runtime, new AgentMessage({ content: 'task' }))
        .then((value) => {
          settled = true;
          return value;
        });
      await vi.advanceTimersByTimeAsync(60_001);
      expect(runtime.reactLoop).toHaveBeenCalledOnce();
      expect(settled).toBe(true);
      const result = await pending;
      expect(result.toolCalls).toEqual([entry]);
      expect(result.toolCalls[0].envelope).toBe(envelope);
      expect(result.tokenUsage).toEqual({ input: 50, output: 10 });
      expect(result.iterations).toBe(2);
      expect(stageHook).toHaveBeenCalledOnce();
      expect(runtimeHook).not.toHaveBeenCalled();
      expect(bus.listenerCount(AgentEvents.TOOL_CALL_START)).toBe(0);
    } finally {
      bus.removeAllListeners();
      vi.useRealTimers();
    }
  });

  it.each([
    'unknown host',
    'native started tool',
  ])('does not infer zero side effects from an interrupted %s', async (mode) => {
    vi.useFakeTimers();
    const bus = new AgentEventBus();
    let attempts = 0;
    const runtime = {
      id: 'uncertain-interruption',
      ...(mode === 'native started tool' ? { bus, toolCallHistory: [] } : {}),
      reactLoop: () => {
        attempts++;
        if (mode === 'native started tool') {
          bus.publish(AgentEvents.TOOL_CALL_START, {
            agentId: 'uncertain-interruption',
            tool: 'terminal',
          });
        }
        return new Promise<ReturnType<typeof stageOutput>>(() => {});
      },
    };
    try {
      let settled = false;
      const pending = new PipelineStrategy({
        stages: [{ name: 'analyze', budget: { timeoutMs: 1 }, retryBudget: { timeoutMs: 1 } }],
      })
        .execute(runtime, new AgentMessage({ content: 'task' }))
        .then((result) => {
          settled = true;
          return result;
        });
      await vi.advanceTimersByTimeAsync(60_001);
      expect(attempts).toBe(1);
      expect(settled).toBe(true);
      expect((await pending).phases.analyze).toMatchObject({ timedOut: true });
    } finally {
      bus.removeAllListeners();
      vi.useRealTimers();
    }
  });

  it('isolates late diagnostics and tool callbacks from the parent attempt ledger', async () => {
    const parent = new AbortController();
    const diagnostics = new DiagnosticsCollector();
    const hostHook = vi.fn();
    let options!: Record<string, unknown>;
    const runtime = {
      id: 'late-observer',
      onToolCall: hostHook,
      reactLoop: (_prompt: string, opts?: Record<string, unknown>) => {
        options = opts || {};
        (options.diagnostics as DiagnosticsCollector).recordTokenUsage({ inputTokens: 4 });
        return new Promise<ReturnType<typeof stageOutput>>(() => {});
      },
    };
    let settled = false;
    const pending = new PipelineStrategy({ stages: [{ name: 'analyze' }] })
      .execute(runtime, new AgentMessage({ content: 'task' }), {
        abortSignal: parent.signal,
        diagnostics,
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await flushPipelineTasks();
    (options.onToolCall as (...args: unknown[]) => void)?.(
      'code',
      { action: 'read' },
      { value: 'observed' },
      1
    );
    expect(hostHook).toHaveBeenCalledOnce();
    parent.abort();
    await flushPipelineTasks();
    expect(settled).toBe(true);
    const result = await pending;
    const before = diagnostics.toJSON();
    (options.diagnostics as DiagnosticsCollector).recordTokenUsage({ inputTokens: 100 });
    (options.onToolCall as (...args: unknown[]) => void)?.(
      'knowledge',
      { action: 'submit' },
      { status: 'created', id: 'late' },
      2
    );
    expect(diagnostics.toJSON()).toEqual(before);
    expect(result.tokenUsage.input).toBe(4);
    expect(result.toolCalls).toHaveLength(1);
    expect(hostHook).toHaveBeenCalledOnce();
  });

  it('cancels a pending gate without publishing its late verdict or starting repair/producer', async () => {
    const parent = new AbortController();
    let release!: (value: { action: string; pass: boolean }) => void;
    const gate = vi.fn(
      () =>
        new Promise<{ action: string; pass: boolean }>((resolve) => {
          release = resolve;
        })
    );
    const reactLoop = vi.fn(async () => stageOutput('analysis'));
    let settled = false;
    const pending = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        { name: 'quality_gate', gate: { evaluator: gate } },
        { name: 'produce' },
      ],
    })
      .execute({ id: 'gate-cancel', reactLoop }, new AgentMessage({ content: 'task' }), {
        abortSignal: parent.signal,
      })
      .then((result) => {
        settled = true;
        return result;
      });
    try {
      await flushPipelineTasks();
      expect(gate).toHaveBeenCalledOnce();
      parent.abort();
      await flushPipelineTasks();
      expect(settled).toBe(true);
      const result = await pending;
      release({ action: 'pass', pass: true });
      await flushPipelineTasks();
      expect(result.outcome).toBe('aborted');
      expect(result.phases).not.toHaveProperty('quality_gate');
      expect(result.phases).not.toHaveProperty('_strictGateReturns');
      expect(reactLoop).toHaveBeenCalledOnce();
    } finally {
      release?.({ action: 'pass', pass: true });
      await flushPipelineTasks();
    }
  });
});

describe('Agent service lifecycle', () => {
  it.each([true, false])('reports the final pipeline timeout attempt (retry=%s)', async (retry) => {
    vi.useFakeTimers();
    try {
      const strategy = new PipelineStrategy({
        stages: [
          {
            name: 'produce',
            budget: { timeoutMs: 1 },
            ...(retry ? { retryBudget: { timeoutMs: 1 } } : {}),
          },
        ],
      });
      let attempts = 0;
      const runtime = {
        id: 'retry-test',
        // 显式提供 native 可观测合同：无 TOOL_CALL_START 证明此次没有启动工具。
        bus: new AgentEventBus(),
        toolCallHistory: [] as Array<Record<string, unknown>>,
        reactLoop: async (_prompt: string, opts?: Record<string, unknown>) => {
          attempts++;
          if (attempts === 1) {
            (opts?.abortSignal as AbortSignal).addEventListener(
              'abort',
              () => (opts?.diagnostics as DiagnosticsCollector).recordCancelReason('abort_signal'),
              { once: true }
            );
            return new Promise<never>(() => {});
          }
          return {
            reply: 'recovered',
            iterations: 1,
            toolCalls: [],
            tokenUsage: { input: 1, output: 1 },
          };
        },
        execute: () => strategy.execute(runtime, new AgentMessage({ content: 'produce' }), {}),
      };
      const service = new AgentService({ runtimeBuilder: { build: () => runtime } });
      const pending = service.run({
        profile: { preset: 'chat' },
        message: { content: 'produce' },
        context: { source: 'internal' },
      });
      await vi.advanceTimersByTimeAsync(60_001);
      const result = await pending;
      expect(attempts).toBe(retry ? 2 : 1);
      expect(result.status).toBe(retry ? 'success' : 'timeout');
      expect(result.diagnostics?.timedOutStages).toEqual(['produce']);
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not accept a late provider reply after cancellation or emit duplicate abort events', async () => {
    let entered!: () => void;
    let respond!: (result: { text: string; functionCalls: never[] }) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const chat = vi.fn(
      () =>
        new Promise((resolve) => {
          respond = resolve;
          entered();
        })
    );
    const { runtime, service, input } = harness(chat);
    const events: unknown[] = [];
    const onAbort = (event: { payload?: { agentId?: string } }) => {
      if (event.payload?.agentId === runtime.id) {
        events.push(event);
      }
    };
    runtime.bus.on('agent:aborted', onAbort);
    try {
      const pending = service.run(input);
      await started;
      runtime.abort('cancel');
      respond({ text: 'late success', functionCalls: [] });
      expect(await pending).toMatchObject({ status: 'aborted' });
      expect(events).toHaveLength(1);
    } finally {
      runtime.bus.off('agent:aborted', onAbort);
    }
  });

  it.each([
    undefined,
    'aborted',
  ])('distinguishes stage-timeout propagation from explicit pipeline cancellation: %s', async (outcome) => {
    const { input } = harness(vi.fn());
    const timeoutService = new AgentService({
      runtimeBuilder: {
        build: () => ({
          id: 'timeout',
          execute: async () => ({
            reply: 'stopped',
            phases: outcome ? { _pipelineOutcome: { outcome } } : undefined,
            diagnostics: {
              ...new DiagnosticsCollector().toJSON(),
              timedOutStages: ['analyze'],
              efficiency: { cancelReason: 'abort_signal' },
            } as never,
          }),
        }),
      },
    });
    expect(await timeoutService.run(input)).toMatchObject({
      status: outcome ? 'aborted' : 'timeout',
    });
  });
  it('honors an asynchronous tool blocking hook before the router', async () => {
    const execute = vi.fn();
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        text: null,
        functionCalls: [{ id: 'call', name: 'meta', args: { action: 'tools', params: {} } }],
      })
      .mockResolvedValue({ text: 'done', functionCalls: [] });
    const { runtime, service, input } = harness(chat, 3, {
      additionalTools: ['meta'],
      toolRouter: { execute } as never,
      container: { get: () => new RuntimeCapabilityCatalog() },
    });
    runtime.hookSystem.on('tool:execute:before', async () => false);
    const result = await service.run(input);
    expect(execute).not.toHaveBeenCalled();
    expect(result.diagnostics?.blockedTools).toContainEqual(
      expect.objectContaining({ tool: 'meta' })
    );
  });
  it('permits the first model call when the iteration budget is one', async () => {
    const chat = vi.fn(async () => ({ text: 'done', functionCalls: [] }));
    const { service, input } = harness(chat, 1);
    expect(await service.run(input)).toMatchObject({ status: 'success', reply: 'done' });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('reports policy rejection as blocked without calling the provider', async () => {
    const chat = vi.fn();
    const { runtime, service, input } = harness(chat);
    runtime.policies = new PolicyEngine([new SafetyPolicy({ allowedSenders: ['authorized'] })]);
    expect(await service.run(input)).toMatchObject({ status: 'blocked' });
    expect(chat).not.toHaveBeenCalled();
  });

  it('aborts the in-flight provider and reports cancellation through the service', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const chat = vi.fn(
      (_prompt, options) =>
        new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
          entered();
        })
    );
    const { runtime, service, input } = harness(chat);
    const pending = service.run(input);
    await started;
    runtime.abort('test cancellation');
    expect(await pending).toMatchObject({ status: 'aborted' });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][1].abortSignal.aborted).toBe(true);
  });

  it('forwards the explicit per-run timeout to the runtime boundary', async () => {
    const execute = vi.fn(async () => ({ reply: 'done' }));
    const service = new AgentService({
      runtimeBuilder: { build: () => ({ id: 'fake', execute }) },
    });
    await service.run({
      profile: { preset: 'chat' },
      message: { content: 'hello' },
      context: { source: 'internal' },
      execution: { timeoutMs: 7 },
    });
    expect(execute.mock.calls[0][1]).toMatchObject({ timeoutMs: 7 });
  });
});

const items = [
  { id: 'a', label: 'a', prompt: 'item-a' },
  { id: 'b', label: 'b', prompt: 'item-b' },
];
const stageResult = {
  reply: 'done',
  toolCalls: [],
  tokenUsage: { input: 1, output: 1 },
  iterations: 1,
};
function fanoutRuntime(strategy: FanOutStrategy) {
  const chatWithTools = vi.fn(async (prompt: string) => ({
    text: `done:${prompt}`,
    functionCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  return {
    chatWithTools,
    runtime: new AgentRuntime({
      aiProvider: { name: 'probe', model: 'probe', chatWithTools } as never,
      toolRegistry: { getManifest: () => null } as never,
      toolRouter: { execute: vi.fn() } as never,
      capabilities: [],
      strategy,
    }),
  };
}
describe('fanout option and accounting isolation', () => {
  it('counts real loop iterations once when itemStrategy is a pipeline', async () => {
    const fixture = fanoutRuntime(
      new FanOutStrategy({
        itemStrategy: new PipelineStrategy({ stages: [{ name: 'analyze', capabilities: [] }] }),
      })
    );
    const result = await fixture.runtime.execute(
      new AgentMessage({ content: 'controlled fanout' }),
      { items }
    );
    expect(fixture.chatWithTools).toHaveBeenCalledTimes(2);
    expect(result.iterations).toBe(2);
  });
  it('retains explicitly supplied policy-independent execution options for SingleStrategy items', async () => {
    const options: Record<string, unknown>[] = [];
    const diagnostics = new DiagnosticsCollector();
    const sharedState = { fixture: true };
    const budgetOverride = { maxIterations: 2 };
    await new FanOutStrategy().execute(
      {
        id: 'probe',
        reactLoop: async (_prompt, opts) => {
          options.push(opts || {});
          return stageResult;
        },
      },
      new AgentMessage({ content: 'controlled options' }),
      { items: [items[0]], source: 'system', sharedState, budgetOverride, diagnostics }
    );
    expect(options[0]).toMatchObject({
      source: 'system',
      sharedState,
      budgetOverride,
      diagnostics,
    });
  });
  it('makes upstream strategy context available to nested pipeline prompt builders', async () => {
    const seen: unknown[] = [];
    const strategy = new FanOutStrategy({
      itemStrategy: new PipelineStrategy({
        stages: [
          {
            name: 'analyze',
            promptBuilder: (ctx) => {
              seen.push(ctx.projectInfo);
              return 'done';
            },
          },
        ],
      }),
    });
    await strategy.execute(
      { id: 'probe', reactLoop: async () => stageResult },
      new AgentMessage({ content: 'controlled nested options' }),
      { items: [items[0]], strategyContext: { projectInfo: { name: 'known-project' } } }
    );
    expect(seen).toEqual([{ name: 'known-project' }]);
  });
});
it('does not start pre-cancelled fanout items', async () => {
  const controller = new AbortController();
  controller.abort();
  const reactLoop = vi.fn(async () => stageResult);
  await new FanOutStrategy().execute(
    { id: 'fanout', reactLoop },
    new AgentMessage({ content: 'cancelled' }),
    { items, abortSignal: controller.signal }
  );
  expect(reactLoop).not.toHaveBeenCalled();
});

function deferred() {
  return Promise.withResolvers<void>();
}

const profile: CompiledAgentProfile = {
  kind: 'compiled-agent-profile',
  id: 'parent',
  title: 'probe',
  serviceKind: 'system-analysis',
  lifecycle: 'active',
  basePreset: 'chat',
  actionSpace: { mode: 'listed', toolIds: [] },
  additionalTools: [],
  params: {},
  runtimeOverrides: {},
  concurrency: {
    mode: 'tiered',
    concurrency: 2,
    partitioner: 'generateSessionDimensions',
    merge: 'generateSessionResults',
    childProfile: 'child',
  },
};
const childResult = (child: AgentRunInput): AgentRunResult => ({
  runId: String(child.params?.dimId),
  profileId: 'child',
  reply: `confirmed:${child.params?.dimId}`,
  status: 'success',
  toolCalls: [{ name: 'knowledge', result: { id: child.params?.dimId } }],
  usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
  diagnostics: null,
});
describe('R05 independent strategy rework cross review', () => {
  it('serializes top-level SystemRunContext mutable resources', async () => {
    const sharedWindow = { resetForNewStage: vi.fn(), tokenCount: 0 };
    const systemRunContext = {
      scopeId: 'probe',
      sharedState: { _dimensionScopeId: 'probe' },
      memoryCoordinator: {},
      contextWindow: sharedWindow,
      trace: {},
      activeContext: {},
      source: 'system',
    };
    let active = 0;
    let peak = 0;
    const observed: unknown[] = [];
    const runtime = {
      id: 'probe',
      reactLoop: async (_prompt: string, opts?: Record<string, unknown>) => {
        observed.push(opts?.contextWindow);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return stageResult;
      },
    };
    await new FanOutStrategy({
      itemStrategy: new PipelineStrategy({ stages: [{ name: 'analyze' }] }),
    }).execute(runtime, new AgentMessage({ content: 'controlled shared context' }), {
      items,
      systemRunContext,
    });
    expect(observed).toEqual([sharedWindow, sharedWindow]);
    expect(peak).toBe(1);
  });
  it('does not announce completion of tiers that cancellation prevented from starting', async () => {
    const controller = new AbortController();
    controller.abort();
    const onTierComplete = vi.fn();
    const onChildResult = vi.fn();
    const runChild = vi.fn(async (child: AgentRunInput) => childResult(child));
    const input: AgentRunInput = {
      profile: { id: 'parent' },
      message: { content: 'cancelled' },
      params: {
        dimensions: [
          { id: 'a', tier: 0 },
          { id: 'b', tier: 1 },
        ],
      },
      context: { source: 'internal', coordination: { onChildResult, onTierComplete } },
      execution: { abortSignal: controller.signal },
    };
    const result = await new AgentRunCoordinator().run(input, profile, runChild);
    expect(runChild).not.toHaveBeenCalled();
    expect(result?.status).toBe('aborted');
    expect(onChildResult).toHaveBeenCalledTimes(2);
    expect(onTierComplete).not.toHaveBeenCalled();
  });
  it('keeps the real runtime configured tool observer through nested pipeline items', async () => {
    const onToolCall = vi.fn();
    const execute = vi.fn(async () => ({
      ok: true,
      status: 'success',
      toolId: 'meta',
      callId: 'observed',
      startedAt: new Date().toISOString(),
      durationMs: 1,
      text: 'confirmed',
      structuredContent: { observed: true },
    }));
    const chatWithTools = vi
      .fn()
      .mockResolvedValueOnce({
        text: null,
        functionCalls: [{ id: 'observed', name: 'meta', args: { action: 'tools', params: {} } }],
      })
      .mockResolvedValue({
        text: 'done',
        functionCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      });
    const runtime = new AgentRuntime({
      aiProvider: { name: 'probe', model: 'probe', chatWithTools } as never,
      toolRegistry: { getManifest: () => null } as never,
      toolRouter: { execute } as never,
      container: { get: () => new RuntimeCapabilityCatalog() },
      capabilities: [],
      additionalTools: ['meta'],
      onToolCall,
      strategy: new FanOutStrategy({
        itemStrategy: new PipelineStrategy({
          stages: [{ name: 'analyze', capabilities: [], additionalTools: ['meta'] }],
        }),
      }),
    });
    const result = await runtime.execute(new AgentMessage({ content: 'observe tool' }), {
      items: [items[0]],
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(result.toolCalls).toHaveLength(1);
    expect(onToolCall).toHaveBeenCalledOnce();
  });
  it('isolates each child diagnostic collector and merges additive usage once', async () => {
    const parent = new DiagnosticsCollector();
    parent.warn({ code: 'parent', message: 'parent seed' });
    const collectors: DiagnosticsCollector[] = [];
    const result = await new FanOutStrategy().execute(
      {
        id: 'probe',
        reactLoop: async (_prompt, options) => {
          const diagnostics = options?.diagnostics as DiagnosticsCollector;
          collectors.push(diagnostics);
          diagnostics.recordTokenUsage({ inputTokens: 3, outputTokens: 2 });
          diagnostics.warn({ code: 'child', message: 'child observation' });
          return {
            ...stageResult,
            tokenUsage: { input: 3, output: 2 },
            diagnostics: diagnostics.toJSON(),
          };
        },
      },
      new AgentMessage({ content: 'diagnostics' }),
      { items, diagnostics: parent }
    );
    expect(collectors[0]).not.toBe(parent);
    expect(collectors[1]).not.toBe(parent);
    expect(collectors[0]).not.toBe(collectors[1]);
    expect(result.diagnostics.efficiency?.tokenUsage).toMatchObject({ input: 6, output: 4 });
    expect(result.diagnostics.warnings.map((w) => w.code)).toEqual(['parent', 'child', 'child']);
  });
  it('waits for started children, preserves their facts, and never starts queued children after consumer failure', async () => {
    const bStarted = deferred();
    const releaseB = deferred();
    const failed = deferred();
    const ran: string[] = [];
    const consumed: string[] = [];
    const input: AgentRunInput = {
      profile: { id: 'parent' },
      message: { content: 'controlled consumer failure' },
      params: { dimensions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      context: {
        source: 'internal',
        coordination: {
          onChildResult: ({ childInput }) => {
            const id = String(childInput.params?.dimId);
            consumed.push(id);
            if (id === 'a') {
              failed.resolve();
              throw new Error('checkpoint write failed');
            }
          },
        },
      },
    };
    let settled = false;
    const pending = new AgentRunCoordinator()
      .run(
        input,
        {
          ...profile,
          concurrency: {
            mode: 'parallel',
            concurrency: 2,
            partitioner: 'generateSessionDimensions',
            merge: 'generateSessionResults',
            childProfile: 'child',
          },
        },
        async (child) => {
          const id = String(child.params?.dimId);
          ran.push(id);
          if (id === 'b') {
            bStarted.resolve();
            await releaseB.promise;
          }
          return childResult(child);
        }
      )
      .then(
        (value) => {
          settled = true;
          return { value };
        },
        (error) => {
          settled = true;
          return { error };
        }
      );
    await Promise.all([bStarted.promise, failed.promise]);
    await new Promise((resolve) => setImmediate(resolve));
    const wasSettled = settled;
    releaseB.resolve();
    const outcome = await pending;
    expect(wasSettled).toBe(false);
    expect(ran).toEqual(['a', 'b']);
    expect(consumed).toEqual(['a', 'b']);
    expect(outcome).toMatchObject({
      error: {
        partialResult: {
          status: 'error',
          phases: {
            childResults: [
              { status: 'success', runId: 'a' },
              { status: 'success', runId: 'b' },
              { status: 'aborted' },
            ],
          },
          toolCalls: [{ result: { id: 'a' } }, { result: { id: 'b' } }],
        },
        coordinationFailures: [{ hook: 'onChildResult', childId: 'a' }],
      },
    });
  });
});
describe('R05 result-control compatibility edges', () => {
  it.each([
    'retry',
    'reject',
  ])('preserves explicit skipOnFail=false continuation for %s while keeping abandoned outcome', async (action) => {
    const reactLoop = vi.fn(async () => stageResult);
    const result = await new PipelineStrategy({
      maxRetries: 0,
      stages: [
        { name: 'analyze' },
        {
          name: 'gate',
          skipOnFail: false,
          gate: { evaluator: () => ({ action, pass: false, reason: 'negative fixture' }) },
        },
        { name: 'cleanup' },
      ],
    }).execute({ id: 'probe', reactLoop }, new AgentMessage({ content: 'explicit continuation' }));
    expect(result.outcome).toBe('abandoned');
    expect(reactLoop).toHaveBeenCalledTimes(2);
  });
  it.each([
    false,
    true,
  ])('distinguishes terminal timeout from recovered timeout in fanout item summary: recovered=%s', async (recovered) => {
    const reactLoop = vi
      .fn()
      .mockResolvedValueOnce({ ...stageResult, timedOut: true })
      .mockResolvedValue(stageResult);
    const result = await new FanOutStrategy({
      itemStrategy: new PipelineStrategy({
        stages: [{ name: 'analyze', ...(recovered ? { retryBudget: { maxIterations: 1 } } : {}) }],
      }),
    }).execute({ id: 'probe', reactLoop }, new AgentMessage({ content: 'timeout accounting' }), {
      items: [items[0]],
    });
    const results = result.itemResults as Array<{ status: string }>;
    expect(results[0].status).toBe(recovered ? 'completed' : 'failed');
  });
});

// ─── I05(L5-P33)：阶段最终回执超时即终态(方案 A) ───
// 背景：insight 管线 analyze 的软超时是 480s(insightPreset budget.timeoutMs)。AgentRuntime 在
// stage_timeout 时返回带非空停止文案 + timedOut:true 的回执；此前 quality_gate 判 summary_rewrite
// 或直接 pass 后 produce 照跑并经 knowledge.submit 持久化候选，但 execute 末尾只看最终回执
// (timedOut → outcome='failed')，AgentService 判 timeout、宿主计 0 有效候选——候选入库却计为 0。
// 方案 A 把语义收敛为：源阶段最终回执超时时，pass/summary_rewrite/record_repair 都不是恢复，
// 只有 analysis_retry 整段重跑(覆盖最终回执)能恢复；额度用尽/被压制/非通过动作/没有门裁决时
// 终止并写 pipeline_timeout_terminal。mock runtime 直接给出超时回执(非零工具调用，避免走
// fast-retry 分支)，不依赖真实计时。
describe('PipelineStrategy — 超时阶段救回语义统一(I05)', () => {
  type Warning = { code: string; stage?: string; message: string };
  const warningsOf = (diagnostics: { warnings?: unknown[] } | undefined) =>
    (diagnostics?.warnings ?? []) as Warning[];
  const timeoutTerminalWarnings = (diagnostics: { warnings?: unknown[] } | undefined) =>
    warningsOf(diagnostics).filter((warning) => warning.code === 'pipeline_timeout_terminal');
  const timedOutAnalyze = {
    reply: 'partial analysis text written before the 480s soft timeout',
    toolCalls: [{ tool: 'read', args: { path: 'src/a.ts' }, result: 'contents' }],
    tokenUsage: { input: 10, output: 5 },
    iterations: 3,
    timedOut: true,
  };

  /** 按 pipelinePhase 回放：首轮 analyze 超时；recoverOnRetry 时重跑成功，否则每次都超时。 */
  function timeoutRuntime(options: { recoverOnRetry?: boolean; analyzeInputTokens?: number } = {}) {
    const phases: string[] = [];
    let analyzeRuns = 0;
    const runtime = {
      id: 'timeout-terminal-runtime',
      reactLoop: vi.fn(async (_prompt: string, opts?: Record<string, unknown>) => {
        const phase = String((opts?.context as Record<string, unknown> | undefined)?.pipelinePhase);
        phases.push(phase);
        if (phase === 'analyze') {
          analyzeRuns += 1;
          if (analyzeRuns === 1 || !options.recoverOnRetry) {
            return {
              ...timedOutAnalyze,
              tokenUsage: { input: options.analyzeInputTokens ?? 10, output: 5 },
            };
          }
          return {
            ...stageOutput('complete analysis after a full re-run'),
            toolCalls: [{ tool: 'read', args: { path: 'src/b.ts' }, result: 'contents' }],
          };
        }
        return stageOutput(`${phase} output`);
      }),
    };
    return { runtime, phases };
  }

  function insightLikeStages(
    evaluator: (...args: unknown[]) => unknown,
    options: {
      maxRetries?: number;
      skipOnFail?: boolean;
      analyzeBudget?: Record<string, unknown>;
      onRetryReason?: (reason: string | undefined) => void;
    } = {}
  ) {
    return [
      {
        name: 'analyze',
        budget: { timeoutMs: 480_000, ...(options.analyzeBudget || {}) },
        ...(options.onRetryReason
          ? {
              retryPromptBuilder: (retryCtx: { reason?: string }, content: string) => {
                options.onRetryReason?.(retryCtx.reason);
                return `${content} (retry)`;
              },
            }
          : {}),
      },
      {
        name: 'quality_gate',
        gate: { evaluator, maxRetries: options.maxRetries ?? 1 },
        ...(options.skipOnFail === undefined ? {} : { skipOnFail: options.skipOnFail }),
      },
      { name: 'produce' },
    ];
  }

  function serviceFor(strategy: PipelineStrategy, runtime: { reactLoop: unknown }) {
    return new AgentService({
      runtimeBuilder: {
        build: () => ({
          id: 'timeout-terminal-service-runtime',
          execute: async (message: AgentMessage) => {
            const result = await strategy.execute(runtime as never, message);
            return { ...result, durationMs: 1 };
          },
        }),
      },
    });
  }

  it('480s 软超时 + summary_rewrite 且无重试额度 → 不跑重写微阶段与 produce，outcome=failed，诊断含 pipeline_timeout_terminal，服务状态仍为 timeout', async () => {
    const warnLog = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const { runtime, phases } = timeoutRuntime();
    const evaluator = vi
      .fn()
      .mockReturnValueOnce({
        action: 'summary_rewrite',
        pass: false,
        reason: 'Coherence-only gap with adequate evidence',
        artifact: { findings: [{ finding: 'f1' }, { finding: 'f2' }] },
      })
      .mockReturnValue({ action: 'pass', pass: true });
    const strategy = new PipelineStrategy({
      stages: insightLikeStages(evaluator, { maxRetries: 0 }),
    });

    const result = await serviceFor(strategy, runtime).run({
      profile: { id: 'timeout-terminal' },
      message: { content: 'mine' },
      context: { source: 'internal' },
    });

    // 超时回执不被 rewrite 救回：既不跑 quality_gate_summary_rewrite 微阶段，也不跑 produce。
    expect(phases).toEqual(['analyze']);
    expect(evaluator).toHaveBeenCalledTimes(1);
    const resultPhases = result.phases as Record<string, Record<string, unknown>>;
    expect(resultPhases.produce).toBeUndefined();
    expect(resultPhases.quality_gate_summary_rewrite).toBeUndefined();
    expect(resultPhases.analyze).toMatchObject({ timedOut: true });
    // 门回执只记有效裁决一次：summary_rewrite 被改写为 analysis_retry，原始动作留在 reason 里；
    // gateFailures 同样只有这一条(宿主与 l4MemoryPackage 按条读取)。
    expect(resultPhases.quality_gate).toMatchObject({ pass: false, action: 'analysis_retry' });
    expect(String(resultPhases.quality_gate.reason)).toContain('summary_rewrite');
    expect(result.diagnostics?.gateFailures).toEqual([
      expect.objectContaining({ stage: 'quality_gate', action: 'analysis_retry' }),
    ]);
    expect(resultPhases._pipelineOutcome).toMatchObject({
      outcome: 'failed',
      stage: 'quality_gate',
      action: 'timeout_terminal',
    });
    // AgentService 不改：最终回执超时且未恢复 → timeout(与宿主 AgentRunProjections 判定一致)。
    expect(result.status).toBe('timeout');
    expect(result.diagnostics?.timedOutStages).toEqual(['analyze']);
    const terminal = timeoutTerminalWarnings(result.diagnostics);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].stage).toBe('quality_gate');
    expect(terminal[0].message).toContain('analyze');
    expect(terminal[0].message).toContain('summary_rewrite');
    expect(terminal[0].message).toContain('maxRetries=0');
    expect(
      warnLog.mock.calls.some(
        (call) =>
          String(call[0]).includes('pipeline_timeout_terminal') &&
          String(call[0]).includes('quality_gate')
      )
    ).toBe(true);
  });

  it.each([
    'pass',
    'summary_rewrite',
    'record_repair',
  ])('有重试额度时门动作 %s 不算恢复：走 analysis_retry 整段重跑，重跑成功后 outcome=completed、服务状态 success', async (action) => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const { runtime, phases } = timeoutRuntime({ recoverOnRetry: true });
    const retryReasons: Array<string | undefined> = [];
    const evaluator = vi
      .fn()
      .mockReturnValueOnce({
        action,
        pass: action === 'pass',
        reason: action === 'pass' ? undefined : 'gate wants a cheap repair',
        artifact: { findings: [{ finding: 'f1' }] },
      })
      .mockReturnValue({ action: 'pass', pass: true });
    const strategy = new PipelineStrategy({
      stages: insightLikeStages(evaluator, {
        maxRetries: 1,
        onRetryReason: (reason) => retryReasons.push(reason),
      }),
    });

    const result = await serviceFor(strategy, runtime).run({
      profile: { id: 'timeout-recovered' },
      message: { content: 'mine' },
      context: { source: 'internal' },
    });

    // 只有整段重跑：没有 rewrite/repair 微阶段；重跑覆盖最终回执后门重评通过，produce 正常执行。
    expect(phases).toEqual(['analyze', 'analyze', 'produce']);
    expect(evaluator).toHaveBeenCalledTimes(2);
    const resultPhases = result.phases as Record<string, Record<string, unknown>>;
    expect(resultPhases.analyze).toMatchObject({ reply: 'complete analysis after a full re-run' });
    expect(resultPhases.analyze.timedOut).toBeUndefined();
    expect(resultPhases.produce).toMatchObject({ reply: 'produce output' });
    expect(resultPhases.quality_gate).toMatchObject({ pass: true, action: 'pass' });
    expect(resultPhases._retries_quality_gate).toBe(1);
    expect(resultPhases._pipelineOutcome).toEqual({ outcome: 'completed' });
    // 与普通 analysis_retry 同构：首轮门回执按改写后的有效裁决记 1 条 gateFailures(reason 带原始动作)。
    expect(result.diagnostics?.gateFailures).toHaveLength(1);
    expect(result.diagnostics?.gateFailures?.[0]).toMatchObject({
      stage: 'quality_gate',
      action: 'analysis_retry',
    });
    expect(String(result.diagnostics?.gateFailures?.[0]?.reason)).toContain(action);
    // 重试 prompt 能看出是超时触发的整段重跑，而不是门的原始动作。
    expect(retryReasons).toHaveLength(1);
    expect(retryReasons[0]).toMatch(/timed out/i);
    expect(retryReasons[0]).toContain(action);
    // 历史超时保留在 timedOutStages；最终回执已覆盖 → AgentService 判已恢复。
    expect(result.diagnostics?.timedOutStages).toEqual(['analyze']);
    expect(timeoutTerminalWarnings(result.diagnostics)).toHaveLength(0);
    expect(result.status).toBe('success');
    expect(result.reply).toBe('produce output');
  });

  it('重跑仍超时且额度用尽 → 终止(attempts/maxRetries 可定位)，produce 不跑', async () => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const { runtime, phases } = timeoutRuntime({ recoverOnRetry: false });
    const evaluator = vi.fn(() => ({ action: 'pass', pass: true }));
    const result = await new PipelineStrategy({
      stages: insightLikeStages(evaluator, { maxRetries: 1 }),
    }).execute(runtime, new AgentMessage({ content: 'mine' }));

    expect(phases).toEqual(['analyze', 'analyze']);
    expect(result.outcome).toBe('failed');
    expect(result.timedOut).toBe(true);
    expect(result.phases.produce).toBeUndefined();
    const terminal = timeoutTerminalWarnings(result.diagnostics);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].message).toContain('attempts=2');
    expect(terminal[0].message).toContain('maxRetries=1');
    expect(result.phases._pipelineOutcome).toMatchObject({
      outcome: 'failed',
      action: 'timeout_terminal',
      stage: 'quality_gate',
    });
  });

  it('非通过动作 reject 落在超时源阶段上：即使 skipOnFail=false 也终止，不继续 produce', async () => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const { runtime, phases } = timeoutRuntime();
    const evaluator = vi.fn(() => ({ action: 'reject', pass: false, reason: 'rejected' }));
    const result = await new PipelineStrategy({
      stages: insightLikeStages(evaluator, { maxRetries: 1, skipOnFail: false }),
    }).execute(runtime, new AgentMessage({ content: 'mine' }));

    expect(phases).toEqual(['analyze']);
    expect(result.outcome).toBe('failed');
    expect(result.phases.produce).toBeUndefined();
    expect(result.phases.quality_gate).toMatchObject({ action: 'reject' });
    const terminal = timeoutTerminalWarnings(result.diagnostics);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].message).toContain('reject');
    expect(terminal[0].message).toContain('skipOnFail=false');
  });

  it('重跑被会话输入预算压制 → degraded_budget_exhausted 终态，同时写 pipeline_timeout_terminal', async () => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const { runtime, phases } = timeoutRuntime({ recoverOnRetry: true, analyzeInputTokens: 95 });
    const evaluator = vi.fn(() => ({ action: 'pass', pass: true }));
    const result = await new PipelineStrategy({
      stages: insightLikeStages(evaluator, {
        maxRetries: 1,
        analyzeBudget: { maxSessionInputTokens: 100 },
      }),
    }).execute(runtime, new AgentMessage({ content: 'mine' }));

    expect(phases).toEqual(['analyze']);
    expect(result.outcome).toBe('failed');
    expect(result.degraded).toBe(true);
    expect(result.phases.produce).toBeUndefined();
    expect(result.phases.quality_gate).toMatchObject({ action: 'degraded_budget_exhausted' });
    const terminal = timeoutTerminalWarnings(result.diagnostics);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].message).toMatch(/suppressed/i);
  });

  it('超时阶段后面没有门裁决(analyze → produce) → 直接终止，produce 不跑', async () => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const { runtime, phases } = timeoutRuntime();
    const result = await new PipelineStrategy({
      stages: [{ name: 'analyze', budget: { timeoutMs: 480_000 } }, { name: 'produce' }],
    }).execute(runtime, new AgentMessage({ content: 'mine' }));

    expect(phases).toEqual(['analyze']);
    expect(result.outcome).toBe('failed');
    expect(result.phases.produce).toBeUndefined();
    expect(result.reply).toBe(timedOutAnalyze.reply);
    const terminal = timeoutTerminalWarnings(result.diagnostics);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].stage).toBe('analyze');
    expect(terminal[0].message).toContain('produce');
    expect(result.phases._pipelineOutcome).toMatchObject({
      outcome: 'failed',
      stage: 'analyze',
      action: 'timeout_terminal',
    });
  });

  it('最后一个阶段超时(没有下游) → 保持原语义：outcome=failed 但不写 pipeline_timeout_terminal', async () => {
    const { runtime, phases } = timeoutRuntime();
    const result = await new PipelineStrategy({
      stages: [{ name: 'analyze', budget: { timeoutMs: 480_000 } }],
    }).execute(runtime, new AgentMessage({ content: 'mine' }));

    expect(phases).toEqual(['analyze']);
    expect(result.outcome).toBe('failed');
    expect(timeoutTerminalWarnings(result.diagnostics)).toHaveLength(0);
    expect(result.phases._pipelineOutcome).toEqual({ outcome: 'failed' });
  });

  it('未超时的源阶段不受影响：summary_rewrite 仍走重写微阶段后通过，produce 正常执行', async () => {
    const phases: string[] = [];
    const runtime = {
      id: 'no-timeout-runtime',
      reactLoop: vi.fn(async (_prompt: string, opts?: Record<string, unknown>) => {
        const phase = String((opts?.context as Record<string, unknown> | undefined)?.pipelinePhase);
        phases.push(phase);
        return stageOutput(`${phase} output`);
      }),
    };
    const evaluator = vi
      .fn()
      .mockReturnValueOnce({ action: 'summary_rewrite', pass: false, reason: 'coherence' })
      .mockReturnValue({ action: 'pass', pass: true });
    const result = await new PipelineStrategy({
      stages: insightLikeStages(evaluator, { maxRetries: 1 }),
    }).execute(runtime, new AgentMessage({ content: 'mine' }));

    expect(phases).toEqual(['analyze', 'quality_gate_summary_rewrite', 'produce']);
    expect(result.outcome).toBe('completed');
    expect(result.phases.analyze).toMatchObject({
      reply: 'quality_gate_summary_rewrite output',
    });
    expect(timeoutTerminalWarnings(result.diagnostics)).toHaveLength(0);
  });

  // ── 规则边界：producer 阶段的超时回执不在规则内(改动前语义，可救回由宿主判定) ──
  // 宿主 AgentRunProjections.isRecoverableProducerTimeoutIssue：status=timeout + timedOutStages 含
  // 'produce' + 按 phases.produce.toolCalls 数出的持久化提交数 > 0 ⇒ 维度可救回，候选按首轮回执计数。
  // 若裁决 produce 的 rejection_gate 的 pass 也被改写成 analysis_retry，会用「N 个提交被拒绝」的
  // 拒绝重试 prompt 白跑第二轮，并以第二轮回执覆盖 phases.produce——宿主计 0 候选而库里已有候选。
  // 这是返工审查指出的回归；下面三例锁定 producer 路径(门裁决、拒绝重试、主循环)保持改动前语义。
  const persistedSubmit = (id: string) => ({
    tool: 'knowledge',
    args: { action: 'submit', title: `candidate ${id}` },
    result: { status: 'created', id, lifecycle: 'pending' },
  });
  const rejectedSubmit = (reason: string) => ({
    tool: 'knowledge',
    args: { action: 'submit', title: `rejected: ${reason}` },
    result: { status: 'rejected', reason },
  });

  /** analyze/finalize 正常(带一条工具调用)；produce 第 n 次调用回放 produceAttempts[n](超出则复用末项)。 */
  function producerRuntime(produceAttempts: Array<Record<string, unknown>>) {
    const phases: string[] = [];
    let produceRuns = 0;
    const runtime = {
      id: 'producer-timeout-runtime',
      reactLoop: vi.fn(async (_prompt: string, opts?: Record<string, unknown>) => {
        const phase = String((opts?.context as Record<string, unknown> | undefined)?.pipelinePhase);
        phases.push(phase);
        if (phase === 'produce') {
          const attempt = produceAttempts[Math.min(produceRuns, produceAttempts.length - 1)];
          produceRuns += 1;
          return { ...stageOutput('producer summary'), ...attempt };
        }
        return {
          ...stageOutput(`${phase} output`),
          toolCalls: [{ tool: 'read', args: { path: 'src/a.ts' }, result: 'contents' }],
        };
      }),
    };
    return { runtime, phases };
  }

  /** 与 insightPreset / stageBuilders 同形：真实 producerRejectionGateEvaluator + buildProducerRetryPrompt。 */
  function producerStages(retryPrompt: (prompt: string) => string) {
    return [
      { name: 'analyze', budget: { timeoutMs: 480_000 } },
      {
        name: 'quality_gate',
        gate: {
          evaluator: () => ({
            action: 'pass',
            pass: true,
            artifact: { findings: [{ finding: 'f1' }, { finding: 'f2' }] },
          }),
          maxRetries: 1,
        },
      },
      {
        name: 'produce',
        budget: { maxIterations: 24, temperature: 0.3, timeoutMs: 900_000, maxSubmits: 10 },
        retryBudget: { maxIterations: 5, temperature: 0.3, timeoutMs: 300_000 },
        retryPromptBuilder: (
          _retryCtx: { reason?: string },
          _origPrompt: string,
          prev: Record<string, unknown>
        ) =>
          retryPrompt(
            buildProducerRetryPrompt(prev.produce as { toolCalls?: readonly unknown[] } | undefined)
          ),
      },
      {
        name: 'rejection_gate',
        gate: {
          evaluator: (
            source: unknown,
            phaseResults: Record<string, unknown>,
            ctx: Record<string, unknown>
          ) =>
            producerRejectionGateEvaluator(
              source as Parameters<typeof producerRejectionGateEvaluator>[0],
              phaseResults,
              ctx
            ),
          maxRetries: 1,
        },
      },
    ];
  }

  it('produce 超时但已持久化提交 + rejection_gate pass → 不重跑 produce、首轮回执保留、status=timeout、timedOutStages=[produce](宿主可救回路径不变)', async () => {
    const infoLog = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const retryPrompt = vi.fn((prompt: string) => prompt);
    const firstAttempt = {
      reply: '[run stopped: stage_timeout] partial producer output',
      toolCalls: [
        persistedSubmit('cand-1'),
        persistedSubmit('cand-2'),
        rejectedSubmit('too short'),
      ],
      timedOut: true,
    };
    const { runtime, phases } = producerRuntime([
      firstAttempt,
      stageOutput('second produce must not run'),
    ]);

    const result = await serviceFor(
      new PipelineStrategy({ stages: producerStages(retryPrompt) }),
      runtime
    ).run({
      profile: { id: 'producer-timeout-recoverable' },
      message: { content: 'mine' },
      context: { source: 'internal' },
    });

    // 只有首轮 produce：rejection_gate 的 pass 不被改写成 analysis_retry，拒绝重试 prompt 不生成。
    expect(phases).toEqual(['analyze', 'produce']);
    expect(retryPrompt).not.toHaveBeenCalled();
    const resultPhases = result.phases as Record<string, Record<string, unknown>>;
    expect(resultPhases.produce).toMatchObject({ timedOut: true, reply: firstAttempt.reply });
    // 宿主按 phases.produce.toolCalls 数持久化提交：首轮的 2 条必须原样保留。
    const produceToolCalls = resultPhases.produce.toolCalls as unknown[];
    expect(produceToolCalls).toHaveLength(3);
    expect(produceToolCalls.filter(isPersistedSubmission)).toHaveLength(2);
    expect(resultPhases.rejection_gate).toMatchObject({ pass: true, action: 'pass' });
    expect(resultPhases._pipelineOutcome).toMatchObject({ outcome: 'failed' });
    expect(resultPhases._pipelineOutcome.action).toBeUndefined();
    expect(result.diagnostics?.gateFailures ?? []).toEqual([]);
    expect(timeoutTerminalWarnings(result.diagnostics)).toHaveLength(0);
    // AgentService 不改：最终回执超时 → timeout；宿主据 timedOutStages=['produce'] + 2 条持久化提交判可救回。
    expect(result.status).toBe('timeout');
    expect(result.diagnostics?.timedOutStages).toEqual(['produce']);
    // 分叉留痕：日志能看出是 producer 超时、规则未套用、以及回执里的持久化提交数。
    expect(
      infoLog.mock.calls.some((call) => {
        const text = String(call[0]);
        return (
          text.includes('producer stage') &&
          text.includes('"rejection_gate"') &&
          text.includes('persistedKnowledgeSubmits=2')
        );
      })
    ).toBe(true);
  });

  it('produce 超时且拒绝占优 + rejection_gate 判 retry → 仍走既有拒绝重试(prompt 来自 buildProducerRetryPrompt)，重跑成功后 status=success', async () => {
    vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const retryPrompt = vi.fn((prompt: string) => prompt);
    const { runtime, phases } = producerRuntime([
      {
        reply: '[run stopped: stage_timeout] partial producer output',
        toolCalls: [rejectedSubmit('a'), rejectedSubmit('b'), rejectedSubmit('c')],
        timedOut: true,
      },
      {
        ...stageOutput('repaired producer output'),
        toolCalls: [persistedSubmit('cand-1'), persistedSubmit('cand-2')],
      },
    ]);

    const result = await serviceFor(
      new PipelineStrategy({ stages: producerStages(retryPrompt) }),
      runtime
    ).run({
      profile: { id: 'producer-timeout-rejection-retry' },
      message: { content: 'mine' },
      context: { source: 'internal' },
    });

    // 拒绝重试是 rejection_gate 的既有路径，与超时无关：prompt 说的是首轮被拒绝的 3 条。
    expect(phases).toEqual(['analyze', 'produce', 'produce']);
    expect(retryPrompt).toHaveBeenCalledTimes(1);
    expect(retryPrompt.mock.calls[0][0]).toContain('你的 3 个提交被拒绝了');
    const resultPhases = result.phases as Record<string, Record<string, unknown>>;
    expect(resultPhases.produce.timedOut).toBeUndefined();
    expect(
      (resultPhases.produce.toolCalls as unknown[]).filter(isPersistedSubmission)
    ).toHaveLength(2);
    expect(resultPhases.rejection_gate).toMatchObject({ pass: true, action: 'pass' });
    expect(resultPhases._retries_rejection_gate).toBe(1);
    expect(result.diagnostics?.gateFailures).toEqual([
      expect.objectContaining({ stage: 'rejection_gate', action: 'retry' }),
    ]);
    expect(timeoutTerminalWarnings(result.diagnostics)).toHaveLength(0);
    expect(resultPhases._pipelineOutcome).toMatchObject({ outcome: 'completed' });
    // 历史超时保留在 timedOutStages；最终回执已被成功重跑覆盖 → AgentService 判已恢复。
    expect(result.diagnostics?.timedOutStages).toEqual(['produce']);
    expect(result.status).toBe('success');
  });

  it('producer 超时且下游不是门(produce → finalize) → 不触发主循环直接终止：finalize 照跑(改动前语义)，不写 pipeline_timeout_terminal', async () => {
    const infoLog = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const { runtime, phases } = producerRuntime([
      { reply: 'partial producer output', toolCalls: [persistedSubmit('cand-1')], timedOut: true },
    ]);
    const result = await new PipelineStrategy({
      stages: [{ name: 'analyze' }, { name: 'produce' }, { name: 'finalize' }],
    }).execute(runtime, new AgentMessage({ content: 'mine' }));

    expect(phases).toEqual(['analyze', 'produce', 'finalize']);
    expect(result.outcome).toBe('failed');
    expect(result.timedOut).toBe(true);
    const produce = result.phases.produce as { timedOut?: boolean; toolCalls: unknown[] };
    expect(produce.timedOut).toBe(true);
    expect(produce.toolCalls.filter(isPersistedSubmission)).toHaveLength(1);
    expect(result.phases.finalize).toMatchObject({ reply: 'finalize output' });
    expect(timeoutTerminalWarnings(result.diagnostics)).toHaveLength(0);
    expect(result.phases._pipelineOutcome).toEqual({ outcome: 'failed' });
    expect(
      infoLog.mock.calls.some((call) => {
        const text = String(call[0]);
        return text.includes('producer stage') && text.includes('finalize');
      })
    ).toBe(true);
  });
});

// ─── I36(L5-P30，与 L8-P04 同一问题)：fast retry 复用阶段提示 ───
// fast retry 是「首次尝试硬超时且确认零工具调用」后的同阶段重跑，不是门拒绝重试。此前阶段只要带
// retryPromptBuilder(insight/scan 的 produce 都带，面向 rejection_gate 的「N 个提交被拒绝」修复清单)，
// fast retry 就用它的输出整体替换已构建的阶段提示，且随后清空 ContextWindow——模型只看到「你的 0 个
// 提交被拒绝了」，拿不到 quality_gate 的 findings、维度配置与证据入口。修复后 fast retry 始终复用首次
// 尝试缓存的阶段提示并追加一段超时提示；缓存为空时重新构建；retryPromptBuilder 只留给门重试。
describe('PipelineStrategy — fast retry 复用阶段提示(I36)', () => {
  type Warning = { code: string; stage?: string; message: string };
  const FINDINGS_TEXT = 'UserRepository 统一经 BaseRepository.withTransaction 写库';
  const TIMEOUT_NOTICE = '上一次尝试超时且未调用任何工具';

  /**
   * produce 首次尝试硬超时且零工具(满足 canFastRetry)；recoverOnRetry=false 时重跑也零工具超时，
   * 否则重跑正常返回。记录每次 reactLoop 的阶段与 prompt。
   */
  function fastRetryRuntime(options: { recoverOnRetry?: boolean } = {}) {
    const recoverOnRetry = options.recoverOnRetry ?? true;
    const calls: Array<{ phase: string; prompt: string }> = [];
    let produceRuns = 0;
    const runtime = {
      id: 'fast-retry-prompt-runtime',
      reactLoop: vi.fn(async (prompt: string, opts?: Record<string, unknown>) => {
        const phase = String((opts?.context as Record<string, unknown> | undefined)?.pipelinePhase);
        calls.push({ phase, prompt });
        if (phase === 'produce') {
          produceRuns += 1;
          return produceRuns === 1 || !recoverOnRetry
            ? { ...stageOutput(''), timedOut: true }
            : stageOutput('produce output after fast retry');
        }
        return {
          ...stageOutput(`${phase} output`),
          toolCalls: [{ tool: 'read', args: { path: 'src/a.ts' }, result: 'contents' }],
        };
      }),
    };
    const producePrompts = () =>
      calls.filter((call) => call.phase === 'produce').map((call) => call.prompt);
    return { runtime, producePrompts };
  }

  /** 与 insightPreset 同形的 analyze → quality_gate(带 AnalysisArtifact) → produce；produce 的提示来自门产物。 */
  function stagesWithProduce(produceExtras: Record<string, unknown>) {
    return [
      { name: 'analyze', budget: { timeoutMs: 480_000 } },
      {
        name: 'quality_gate',
        gate: {
          evaluator: () => ({
            action: 'pass',
            pass: true,
            artifact: { findings: [{ finding: FINDINGS_TEXT }] },
          }),
          maxRetries: 1,
        },
      },
      {
        name: 'produce',
        budget: { maxIterations: 24, temperature: 0.3, timeoutMs: 900_000, maxSubmits: 10 },
        ...produceExtras,
      },
    ];
  }

  const producePromptFromArtifact = (ctx: Record<string, unknown>) => {
    const findings =
      (ctx.gateArtifact as { findings?: Array<{ finding: string }> } | null)?.findings || [];
    return `【阶段任务】把下列发现提交为知识候选:\n${findings.map((item) => `- ${item.finding}`).join('\n')}`;
  };

  const fastRetryWarnings = (diagnostics: { warnings?: unknown[] } | undefined) =>
    ((diagnostics?.warnings ?? []) as Warning[]).filter(
      (warning) => warning.code === 'pipeline_stage_fast_retry'
    );

  // 真实生产配置里的 produce retryPromptBuilder / retryBudget：insight 预设与 scan-extract 管线。
  const insightProduce = (INSIGHT_PRESET.strategy.stages as Array<Record<string, unknown>>).find(
    (stage) => stage.name === 'produce'
  ) as Record<string, unknown>;
  const scanProduce = buildScanPipelineStages({
    task: 'extract',
    producePrompt: 'scan producer system prompt',
    analyzeCaps: [],
    produceCaps: [],
  }).find((stage) => stage.name === 'produce') as Record<string, unknown>;

  it.each([
    { label: 'insight preset produce', produce: insightProduce },
    { label: 'scan-extract produce', produce: scanProduce },
  ])('$label：首次硬超时零工具 → 重跑提示=原阶段提示+超时追加段，不调用面向拒绝的 retryPromptBuilder', async ({
    produce,
  }) => {
    const infoLog = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    expect(typeof produce.retryPromptBuilder).toBe('function');
    expect(produce.retryBudget).toBeTruthy();
    const retryPromptBuilder = vi.fn(produce.retryPromptBuilder as (...args: unknown[]) => string);
    const promptBuilder = vi.fn(producePromptFromArtifact);
    const resetForNewStage = vi.fn();
    const { runtime, producePrompts } = fastRetryRuntime();

    const output = await new PipelineStrategy({
      stages: stagesWithProduce({
        promptBuilder,
        retryBudget: produce.retryBudget,
        retryPromptBuilder,
      }),
    }).execute(runtime, new AgentMessage({ content: 'mine' }), {
      contextWindow: { resetForNewStage, tokenCount: 0 },
    });

    const prompts = producePrompts();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(FINDINGS_TEXT);
    // ContextWindow 在重跑前被清空，完整阶段提示必须原样承载全部上下文，再追加超时提示。
    expect(prompts[1].startsWith(prompts[0])).toBe(true);
    expect(prompts[1]).toContain(FINDINGS_TEXT);
    expect(prompts[1]).toContain(TIMEOUT_NOTICE);
    expect(prompts[1]).not.toContain('个提交被拒绝了');
    expect(retryPromptBuilder).not.toHaveBeenCalled();
    // 复用缓存，不重复调用(可能有副作用或较慢的)promptBuilder。
    expect(promptBuilder).toHaveBeenCalledTimes(1);
    expect(resetForNewStage).toHaveBeenCalled();
    expect(output.reply).toBe('produce output after fast retry');
    expect((output.phases.produce as { timedOut?: boolean }).timedOut).toBeUndefined();
    // 分叉留痕：诊断与日志都能看出触发原因、提示来源，以及 retryPromptBuilder 被绕过。
    const warnings = fastRetryWarnings(output.diagnostics);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ stage: 'produce' });
    expect(warnings[0].message).toContain('reason=stage_hard_timeout_zero_tools');
    expect(warnings[0].message).toContain('promptSource=stage_cached');
    expect(warnings[0].message).toContain('retryPromptBuilder=bypassed');
    expect(
      infoLog.mock.calls.some((call) => {
        const text = String(call[0]);
        return (
          text.includes('fast-retrying') &&
          text.includes('promptSource=stage_cached') &&
          text.includes('retryPromptBuilder=bypassed')
        );
      })
    ).toBe(true);
  });

  it('没有 retryPromptBuilder 的阶段：重跑提示同样是缓存阶段提示+超时追加段', async () => {
    vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const { runtime, producePrompts } = fastRetryRuntime();
    const output = await new PipelineStrategy({
      stages: stagesWithProduce({
        promptBuilder: producePromptFromArtifact,
        retryBudget: { maxIterations: 5, temperature: 0.3, timeoutMs: 300_000 },
      }),
    }).execute(runtime, new AgentMessage({ content: 'mine' }));

    const prompts = producePrompts();
    expect(prompts).toHaveLength(2);
    expect(prompts[1].startsWith(prompts[0])).toBe(true);
    expect(prompts[1]).toContain(FINDINGS_TEXT);
    expect(prompts[1]).toContain(TIMEOUT_NOTICE);
    const warnings = fastRetryWarnings(output.diagnostics);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('promptSource=stage_cached');
    expect(warnings[0].message).toContain('retryPromptBuilder=absent');
  });

  it('首次尝试的阶段提示为空 → 重新构建阶段提示再追加超时段，不发送只有超时提示的空任务', async () => {
    vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const retryPromptBuilder = vi.fn(() => buildProducerRetryPrompt(undefined));
    // 首次构建得到空提示(例如宿主上下文尚未就绪)，重建时拿到完整阶段提示。
    const promptBuilder = vi
      .fn()
      .mockReturnValueOnce('')
      .mockImplementation(producePromptFromArtifact);
    const { runtime, producePrompts } = fastRetryRuntime();
    const output = await new PipelineStrategy({
      stages: stagesWithProduce({
        promptBuilder,
        retryBudget: { maxIterations: 5, temperature: 0.3, timeoutMs: 300_000 },
        retryPromptBuilder,
      }),
    }).execute(runtime, new AgentMessage({ content: 'mine' }));

    const prompts = producePrompts();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe('');
    expect(promptBuilder).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toContain(FINDINGS_TEXT);
    expect(prompts[1]).toContain(TIMEOUT_NOTICE);
    expect(prompts[1]).not.toContain('个提交被拒绝了');
    expect(retryPromptBuilder).not.toHaveBeenCalled();
    const warnings = fastRetryWarnings(output.diagnostics);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('promptSource=stage_rebuilt');
    expect(warnings[0].message).toContain('retryPromptBuilder=bypassed');
  });

  it('重跑仍零工具超时 → 只 fast retry 一次，最终回执保持 timedOut，诊断只记一次', async () => {
    vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const { runtime, producePrompts } = fastRetryRuntime({ recoverOnRetry: false });
    const output = await new PipelineStrategy({
      stages: stagesWithProduce({
        promptBuilder: producePromptFromArtifact,
        retryBudget: { maxIterations: 5, temperature: 0.3, timeoutMs: 300_000 },
        retryPromptBuilder: () => buildProducerRetryPrompt(undefined),
      }),
    }).execute(runtime, new AgentMessage({ content: 'mine' }));

    const prompts = producePrompts();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(FINDINGS_TEXT);
    expect(prompts[1]).toContain(TIMEOUT_NOTICE);
    expect((output.phases.produce as { timedOut?: boolean }).timedOut).toBe(true);
    expect(output.outcome).toBe('failed');
    expect(fastRetryWarnings(output.diagnostics)).toHaveLength(1);
  });

  it('门判 retry 的拒绝重试仍走 retryPromptBuilder，不追加超时提示也不写 fast retry 诊断', async () => {
    vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const calls: Array<{ phase: string; prompt: string }> = [];
    const runtime = {
      id: 'gate-retry-prompt-runtime',
      reactLoop: vi.fn(async (prompt: string, opts?: Record<string, unknown>) => {
        const phase = String((opts?.context as Record<string, unknown> | undefined)?.pipelinePhase);
        calls.push({ phase, prompt });
        return {
          ...stageOutput(`${phase} output`),
          toolCalls: [{ tool: 'read', args: { path: 'src/a.ts' }, result: 'contents' }],
        };
      }),
    };
    const rejectionGate = vi
      .fn()
      .mockReturnValueOnce({ action: 'retry', pass: false, reason: 'rejected too many' })
      .mockReturnValue({ action: 'pass', pass: true });
    const output = await new PipelineStrategy({
      stages: [
        ...stagesWithProduce({
          promptBuilder: producePromptFromArtifact,
          retryBudget: { maxIterations: 5, temperature: 0.3, timeoutMs: 300_000 },
          retryPromptBuilder: (retryCtx: { reason?: string }) =>
            `GATE_RETRY_PROMPT: ${retryCtx.reason}`,
        }),
        { name: 'rejection_gate', gate: { evaluator: rejectionGate, maxRetries: 1 } },
      ],
    }).execute(runtime, new AgentMessage({ content: 'mine' }));

    const prompts = calls.filter((call) => call.phase === 'produce').map((call) => call.prompt);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(FINDINGS_TEXT);
    expect(prompts[1]).toBe('GATE_RETRY_PROMPT: rejected too many');
    expect(prompts[1]).not.toContain(TIMEOUT_NOTICE);
    expect(fastRetryWarnings(output.diagnostics)).toHaveLength(0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('service compilation and confirmed runtime receipts', () => {
  const input: AgentRunInput = {
    profile: { preset: 'chat' },
    message: { content: 'test' },
    context: { source: 'internal' },
  };
  function builder() {
    return new AgentRuntimeBuilder({
      container: {},
      toolRegistry: { getRouter: () => ({ execute: vi.fn() }) as never },
      aiProvider: { name: 'fixture', model: 'fixture', chatWithTools: vi.fn() },
    });
  }
  it('service completion logging cannot erase a confirmed execution result', async () => {
    const output = {
      reply: 'confirmed result',
      toolCalls: [
        { tool: 'knowledge', args: { action: 'submit' }, result: { id: 'r1', status: 'created' } },
      ],
      tokenUsage: { input: 4, output: 2 },
      iterations: 1,
      durationMs: 10,
    };
    const runtime = {
      id: 'fixture',
      execute: vi.fn(async () => output),
    } as unknown as AgentRuntimeLike;
    const log = vi.spyOn(Logger.getInstance(), 'info').mockImplementation((message: string) => {
      if (message.includes('runtime execute complete')) {
        throw new Error('logger unavailable');
      }
    });
    const result = await new AgentService({ runtimeBuilder: { build: () => runtime } }).run(input);
    expect(runtime.execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'success',
      reply: 'confirmed result',
      toolCalls: output.toolCalls,
      usage: { inputTokens: 4, outputTokens: 2 },
    });
    expect(log).toHaveBeenCalled();
  });
  it('service forwards legacy metadata context through the actual SingleStrategy merge', async () => {
    const reactLoop = vi.fn(async () => ({
      reply: 'done',
      toolCalls: [],
      tokenUsage: { input: 1, output: 1 },
      iterations: 1,
    }));
    const runtime = {
      id: 'fixture',
      execute: (
        message: Parameters<SingleStrategy['execute']>[1],
        opts?: Record<string, unknown>
      ) => new SingleStrategy().execute({ reactLoop } as never, message, opts),
    };
    await new AgentService({ runtimeBuilder: { build: () => runtime } }).run({
      ...input,
      message: { content: 'test', metadata: { context: { legacyOnly: 'keep', shared: 'legacy' } } },
      context: { source: 'internal', promptContext: { shared: 'explicit', newOnly: 'keep too' } },
    });
    expect(reactLoop.mock.calls[0]?.[1]).toMatchObject({
      context: { legacyOnly: 'keep', shared: 'explicit', newOnly: 'keep too' },
    });
  });
  it('direct runtime builder preserves preset parameter overrides', () => {
    const runtime = builder().build({
      preset: 'chat',
      params: { maxIterations: 2, maxTokens: 333, temperature: 0.1, timeoutMs: 4567 },
    });
    expect(runtime.policies.getBudget()).toMatchObject({
      maxIterations: 2,
      maxTokens: 333,
      temperature: 0.1,
      timeoutMs: 4567,
    });
  });
  it('service compilation preserves explicit preset params at the real builder seam', async () => {
    const real = builder();
    let budget: unknown;
    const service = new AgentService({
      runtimeBuilder: {
        build: (profile, opts) => {
          const runtime = real.build(profile, opts);
          budget = runtime.policies.getBudget();
          vi.spyOn(runtime, 'execute').mockResolvedValue({
            reply: 'done',
            toolCalls: [],
            tokenUsage: { input: 0, output: 0 },
            iterations: 0,
            diagnostics: new DiagnosticsCollector().toJSON(),
          } as never);
          return runtime;
        },
      },
    });
    await service.run({
      ...input,
      profile: { preset: 'chat', params: { maxIterations: 2, maxTokens: 333 } },
    });
    expect(budget).toMatchObject({ maxIterations: 2, maxTokens: 333 });
  });
  it('raw override policy declarations are executable at the public builder entry', () => {
    const runtime = builder().build({
      basePreset: 'chat',
      policies: [{ type: 'budget', maxIterations: 2, maxTokens: 333 }],
    });
    expect(() => runtime.policies.validateBefore({})).not.toThrow();
    expect(runtime.policies.getBudget()).toMatchObject({ maxIterations: 2, maxTokens: 333 });
  });
  it('a true standalone shouldAbort check prevents starting runtime work', async () => {
    const execute = vi.fn(async () => ({ reply: 'ran anyway' }));
    const build = vi.fn(() => ({ id: 'fixture', execute }));
    const result = await new AgentService({ runtimeBuilder: { build } }).run({
      ...input,
      execution: { shouldAbort: async () => true },
    });
    expect(result.status).toBe('aborted');
    expect(execute).not.toHaveBeenCalled();
  });
  it('a real post-execution failure preserves already confirmed tool receipts in the service result', async () => {
    const { AgentRuntime } = await import('../src/agent/runtime/AgentRuntime.js');
    const { Policy, PolicyEngine, BudgetPolicy } = await import('../src/agent/policies/index.js');
    const { RuntimeCapabilityCatalog } = await import(
      '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js'
    );
    class FailAfterPolicy extends Policy {
      override validateAfter() {
        throw new Error('post-execution validation failed');
      }
    }
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        text: null,
        functionCalls: [{ id: 'c1', name: 'meta', args: { action: 'tools', params: {} } }],
        usage: { inputTokens: 2, outputTokens: 1 },
      })
      .mockResolvedValueOnce({
        text: 'confirmed outcome',
        functionCalls: [],
        usage: { inputTokens: 2, outputTokens: 1 },
      });
    const execute = vi.fn(async () => ({
      ok: true,
      status: 'success',
      toolId: 'meta',
      callId: 'c1',
      startedAt: new Date().toISOString(),
      durationMs: 1,
      text: 'confirmed receipt',
      structuredContent: { observed: true },
    }));
    const runtime = new AgentRuntime({
      aiProvider: { name: 'fixture', model: 'fixture', chatWithTools: chat } as never,
      toolRegistry: { getManifest: () => null } as never,
      toolRouter: { execute } as never,
      strategy: new SingleStrategy(),
      policies: new PolicyEngine([
        new BudgetPolicy({ maxIterations: 3, timeoutMs: 2000 }),
        new FailAfterPolicy(),
      ]),
      capabilities: [],
      additionalTools: ['meta'],
      container: { get: () => new RuntimeCapabilityCatalog() },
    });
    const result = await new AgentService({ runtimeBuilder: { build: () => runtime } }).run(input);
    expect(execute).toHaveBeenCalledOnce();
    expect(result.status).toBe('error');
    expect(result.toolCalls).toContainEqual(
      expect.objectContaining({ tool: 'meta', result: { observed: true } })
    );
    expect(result.usage.inputTokens).toBe(4);
  });
  it('factory contexts retain scoped mutable resources but isolate separate runs', async () => {
    const { SystemRunContextFactory } = await import(
      '../src/agent/service/SystemRunContextFactory.js'
    );
    const { MemoryCoordinator } = await import('../src/agent/memory/MemoryCoordinator.js');
    const factory = new SystemRunContextFactory();
    const first = factory.createSystemContext({
      label: 'same',
      budget: { maxIterations: 2 },
      lang: 'ts',
    });
    const second = factory.createSystemContext({
      label: 'same',
      budget: { maxIterations: 2 },
      lang: 'ts',
    });
    try {
      expect(first.trace).toBe(first.activeContext);
      expect(first.memoryCoordinator).not.toBe(second.memoryCoordinator);
      expect(first.contextWindow).not.toBe(second.contextWindow);
      const left = first.sharedState as { submittedTitles: Set<string> };
      const right = second.sharedState as { submittedTitles: Set<string> };
      left.submittedTitles.add('first-only');
      expect(right.submittedTitles.has('first-only')).toBe(false);
      expect(first.systemRunContext).toMatchObject({ scopeId: 'scan:same', projectLanguage: 'ts' });
    } finally {
      (first.memoryCoordinator as InstanceType<typeof MemoryCoordinator>).dispose();
      (second.memoryCoordinator as InstanceType<typeof MemoryCoordinator>).dispose();
    }
  });
});

describe('service cancellation and snapshot ownership', () => {
  const input: AgentRunInput = {
    profile: { preset: 'chat' },
    message: { content: 'run' },
    context: { source: 'internal' },
  };
  it('cancellation resolves a pending async shouldAbort check without waiting for its host promise', async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<boolean>();
    const controller = new AbortController();
    const execute = vi.fn(async () => ({ reply: 'must not run' }));
    let result: AgentRunResult | undefined;
    const pending = new AgentService({
      runtimeBuilder: { build: () => ({ id: 'fixture', execute }) },
    })
      .run({
        ...input,
        execution: {
          abortSignal: controller.signal,
          shouldAbort: () => {
            entered.resolve();
            return decision.promise;
          },
        },
      })
      .then((value) => {
        result = value;
        return value;
      });
    try {
      await entered.promise;
      controller.abort();
      await vi.advanceTimersByTimeAsync(1);
      expect(result?.status).toBe('aborted');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      decision.resolve(true);
      await pending;
    }
  });
  it('the explicit execution timeout also bounds an async shouldAbort preflight', async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<boolean>();
    const execute = vi.fn(async () => ({ reply: 'must not run' }));
    let result: AgentRunResult | undefined;
    const pending = new AgentService({
      runtimeBuilder: { build: () => ({ id: 'fixture', execute }) },
    })
      .run({
        ...input,
        execution: {
          timeoutMs: 10,
          shouldAbort: () => {
            entered.resolve();
            return decision.promise;
          },
        },
      })
      .then((value) => {
        result = value;
        return value;
      });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(11);
      expect(result?.status).toBe('timeout');
      expect(execute).not.toHaveBeenCalled();
    } finally {
      decision.resolve(true);
      await pending;
    }
  });
  it('two real runtimes throwing the same Error keep their own confirmed receipts', async () => {
    const shared = new Error('shared post-execution policy error');
    class SharedFailurePolicy extends Policy {
      override validateAfter() {
        throw shared;
      }
    }
    function runtimeFor(owner: string) {
      const chat = vi
        .fn()
        .mockResolvedValueOnce({
          text: null,
          functionCalls: [
            { id: `c-${owner}`, name: 'meta', args: { action: 'tools', params: {} } },
          ],
          usage: { inputTokens: 2, outputTokens: 1 },
        })
        .mockResolvedValueOnce({
          text: `complete-${owner}`,
          functionCalls: [],
          usage: { inputTokens: 2, outputTokens: 1 },
        });
      return new AgentRuntime({
        aiProvider: { name: 'fixture', model: 'fixture', chatWithTools: chat } as never,
        toolRegistry: { getManifest: () => null } as never,
        toolRouter: {
          execute: async () => ({
            ok: true,
            status: 'success',
            toolId: 'meta',
            callId: `c-${owner}`,
            startedAt: new Date().toISOString(),
            durationMs: 1,
            text: `confirmed ${owner}`,
            structuredContent: { owner },
          }),
        } as never,
        strategy: new SingleStrategy(),
        policies: new PolicyEngine([
          new BudgetPolicy({ maxIterations: 3, timeoutMs: 2000 }),
          new SharedFailurePolicy(),
        ]),
        capabilities: [],
        additionalTools: ['meta'],
        container: { get: () => new RuntimeCapabilityCatalog() },
      });
    }
    const a = runtimeFor('A');
    const b = runtimeFor('B');
    const [left, right] = await Promise.all([
      new AgentService({ runtimeBuilder: { build: () => a } }).run(input),
      new AgentService({ runtimeBuilder: { build: () => b } }).run(input),
    ]);
    expect(left.status).toBe('error');
    expect(right.status).toBe('error');
    expect(left.toolCalls).toContainEqual(expect.objectContaining({ result: { owner: 'A' } }));
    expect(right.toolCalls).toContainEqual(expect.objectContaining({ result: { owner: 'B' } }));
  });
  it('untrusted error.partialResult fields do not fabricate confirmed work', async () => {
    const fake = Object.assign(new Error('provider failed'), {
      partialResult: {
        toolCalls: [{ tool: 'meta', result: { forged: true } }],
        tokenUsage: { input: 999, output: 999 },
        iterations: 99,
      },
    });
    const result = await new AgentService({
      runtimeBuilder: {
        build: () => ({
          id: 'untrusted',
          execute: async () => {
            throw fake;
          },
        }),
      },
    }).run(input);
    expect(result).toMatchObject({
      status: 'error',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, iterations: 0 },
    });
  });
});
