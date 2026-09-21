import Logger from '@alembic/core/logging';
import { describe, expect, it, vi } from 'vitest';
import { BudgetPolicy, PolicyEngine, SafetyPolicy } from '../src/agent/policies/index.js';
import { AgentEventBus, AgentEvents } from '../src/agent/runtime/AgentEventBus.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import type { RuntimeConfig } from '../src/agent/runtime/AgentRuntimeTypes.js';
import { DiagnosticsCollector } from '../src/agent/runtime/DiagnosticsCollector.js';
import { AgentService } from '../src/agent/service/AgentService.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';
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
