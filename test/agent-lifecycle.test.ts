import { describe, expect, it, vi } from 'vitest';
import { BudgetPolicy, PolicyEngine, SafetyPolicy } from '../src/agent/policies/index.js';
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
