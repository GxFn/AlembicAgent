import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentEventBus,
  AgentEvents,
  AgentRuntime,
  DiagnosticsCollector,
  type HookPayloadMap,
  HookSystem,
  type ProgressEvent,
} from '../src/agent/runtime/index.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';
import { AiProvider } from '../src/ai/AiProvider.js';
import { UnifiedToolCatalog } from '../src/tools/catalog/UnifiedToolCatalog.js';
import type { ToolResultEnvelope } from '../src/tools/kernel/result.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';

afterEach(() => vi.restoreAllMocks());

describe('AgentEventBus subscriptions', () => {
  it('delivers metadata to topic and wildcard listeners and honors unsubscribe', () => {
    const bus = new AgentEventBus();
    const topic = vi.fn();
    const wildcard = vi.fn();
    const unsubscribe = bus.subscribe(AgentEvents.AGENT_CREATED, topic);
    bus.on('*', wildcard);
    bus.publish(AgentEvents.AGENT_CREATED, { agentId: 'fixture' }, { source: 'factory' });
    expect(topic).toHaveBeenCalledOnce();
    expect(topic.mock.calls[0][0]).toMatchObject({
      type: AgentEvents.AGENT_CREATED,
      source: 'factory',
      payload: { agentId: 'fixture' },
      timestamp: expect.any(Number),
    });
    unsubscribe();
    bus.publish(AgentEvents.AGENT_CREATED);
    expect(topic).toHaveBeenCalledOnce();
    expect(wildcard).toHaveBeenCalledTimes(2);
    expect(bus.getStats().totalEvents).toBe(2);
    expect(Object.isFrozen(AgentEvents)).toBe(true);
  });

  it.each([
    { channel: 'topic', mode: 'sync' },
    { channel: 'wildcard', mode: 'sync' },
    { channel: 'subscription', mode: 'sync' },
    { channel: 'topic', mode: 'async' },
    { channel: 'wildcard', mode: 'async' },
    { channel: 'subscription', mode: 'async' },
  ])('isolates a $mode $channel observer and still delivers to later subscribers', async ({
    channel,
    mode,
  }) => {
    const bus = new AgentEventBus();
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => {});
    const later = vi.fn();
    const failure = new Error('fixture observer failure');
    // 测试持有拒绝 promise，RED 也不会污染进程；断言 bus 必须独立报告该拒绝。
    const rejection = Promise.reject(failure);
    void rejection.catch(() => undefined);
    const observer = () => {
      if (mode === 'sync') {
        throw failure;
      }
      return rejection;
    };
    if (channel === 'subscription') {
      bus.subscribe('fixture', observer);
    } else {
      bus.on(channel === 'wildcard' ? '*' : 'fixture', observer);
    }
    bus.subscribe('fixture', later);
    expect(() => bus.publish('fixture')).not.toThrow();
    await Promise.resolve();
    expect(later).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fixture observer failure'));
  });

  it('preserves generic listener order, once and EventEmitter this binding', () => {
    const bus = new AgentEventBus();
    const calls: string[] = [];
    bus.on('fixture', function (this: AgentEventBus) {
      expect(this).toBe(bus);
      calls.push('topic');
    });
    bus.prependOnceListener('fixture', function (this: AgentEventBus) {
      expect(this).toBe(bus);
      calls.push('once');
    });
    bus.on('*', () => calls.push('wildcard'));
    bus.subscribe('fixture', () => calls.push('subscription'));
    bus.publish('fixture');
    bus.publish('fixture');
    expect(calls).toEqual([
      'once',
      'topic',
      'wildcard',
      'subscription',
      'topic',
      'wildcard',
      'subscription',
    ]);
  });

  it('uses one listener snapshot when observers subscribe or unsubscribe during publish', () => {
    const bus = new AgentEventBus();
    const calls: string[] = [];
    bus.once('fixture', () => {
      bus.on('*', () => calls.push('new-wildcard'));
      bus.subscribe('fixture', () => calls.push('new-subscription'));
    });
    let unsubscribe = () => {};
    unsubscribe = bus.subscribe('fixture', () => {
      calls.push('self-unsubscribe');
      unsubscribe();
    });
    bus.subscribe('fixture', () => calls.push('later'));
    bus.publish('fixture');
    expect(calls).toEqual(['self-unsubscribe', 'later']);
    calls.length = 0;
    bus.publish('fixture');
    expect(calls).toEqual(['new-wildcard', 'later', 'new-subscription']);
  });

  it('resets singleton subscriptions and generic listeners without reusing the old instance', () => {
    AgentEventBus.resetInstance();
    try {
      const previous = AgentEventBus.getInstance();
      const listener = vi.fn();
      previous.subscribe('fixture', listener);
      previous.on('*', listener);
      expect(AgentEventBus.getInstance()).toBe(previous);
      expect(previous.getStats().subscriptionTopics).toBe(1);
      AgentEventBus.resetInstance();
      previous.publish('fixture');
      expect(listener).not.toHaveBeenCalled();
      expect(AgentEventBus.getInstance()).not.toBe(previous);
      expect(AgentEventBus.getInstance().getStats().subscriptionTopics).toBe(0);
    } finally {
      AgentEventBus.resetInstance();
    }
  });
});

describe('AgentEventBus request/reply', () => {
  it.each([
    2_147_483_648,
    Infinity,
  ])('keeps a %s ms request alive until its reply without timer overflow', async (timeout) => {
    vi.useFakeTimers();
    const bus = new AgentEventBus();
    let correlationId: string | undefined;
    bus.subscribe('request', (event) => {
      correlationId = String(event.correlationId);
    });
    const outcomes: string[] = [];
    const pending = bus.request('request', {}, { timeout }).then(
      (value) => {
        outcomes.push('reply');
        return value;
      },
      (error: unknown) => {
        outcomes.push('failure');
        return Promise.reject(error);
      }
    );
    void pending.catch(() => undefined);
    try {
      // request 的同步发布时序属于现有合同，生命周期 helper 不能把它推迟到下一轮。
      expect(correlationId).toEqual(expect.any(String));
      await vi.advanceTimersByTimeAsync(10);
      expect(outcomes).toEqual([]);
      expect(bus.getStats().pendingReplies).toBe(1);
      bus.publish('response', { value: 'answer' }, { correlationId });
      await expect(pending).resolves.toMatchObject({ payload: { value: 'answer' } });
      expect(bus.getStats().pendingReplies).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('releases request state and its timer when publication itself fails', async () => {
    vi.useFakeTimers();
    const bus = new AgentEventBus();
    vi.spyOn(bus, 'publish').mockImplementation(() => {
      throw new Error('fixture dispatch failure');
    });
    try {
      await expect(bus.request('request', {}, { timeout: 1000 })).rejects.toThrow(
        'fixture dispatch failure'
      );
      expect(bus.getStats().pendingReplies).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('cancels pending singleton requests and clears their timers on reset', async () => {
    AgentEventBus.resetInstance();
    vi.useFakeTimers();
    const bus = AgentEventBus.getInstance();
    const settled = bus.request('request', {}, { timeout: 1000 }).catch((error: unknown) => error);
    try {
      expect(bus.getStats().pendingReplies).toBe(1);
      AgentEventBus.resetInstance();
      expect(bus.getStats().pendingReplies).toBe(0);
      // 允许异步生命周期在同一轮清理，不推进尚未到期的请求期限。
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      await expect(settled).resolves.toMatchObject({ message: expect.stringContaining('reset') });
    } finally {
      AgentEventBus.resetInstance();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('times out when nobody replies instead of accepting its own request', async () => {
    const bus = new AgentEventBus();
    await expect(bus.request('request', {}, { timeout: 5 })).rejects.toThrow(/timeout/);
    expect(bus.getStats().pendingReplies).toBe(0);
  });
  it('resolves only a matching reply event', async () => {
    const bus = new AgentEventBus();
    bus.subscribe('request', (event) => {
      bus.publish('response', { value: 'answer' }, { correlationId: String(event.correlationId) });
    });
    await expect(bus.request('request', {}, { timeout: 100 })).resolves.toMatchObject({
      type: 'response',
      payload: { value: 'answer' },
    });
  });
});

describe('HookSystem dispatch lifecycle', () => {
  it('keeps synchronous hooks inline when callers use async emit', async () => {
    const hooks = new HookSystem();
    const calls: string[] = [];
    hooks.on('agent:finalize', () => {
      calls.push('first');
    });
    hooks.on('agent:finalize', () => {
      calls.push('second');
    });
    const pending = hooks.emit('agent:finalize', {
      reply: 'done',
      iterations: 1,
      toolCallCount: 0,
    });
    expect(calls).toEqual(['first', 'second']);
    await expect(pending).resolves.toBe(true);
  });

  it('keeps a later blocking hook active when an earlier hook unsubscribes in the real runtime', async () => {
    const catalog = new RuntimeCapabilityCatalog();
    const execute = vi.fn(
      async (): Promise<ToolResultEnvelope> => ({
        ok: true,
        status: 'success' as const,
        toolId: 'meta',
        callId: 'fixture',
        startedAt: 'fixture',
        durationMs: 0,
        text: 'fixture',
        diagnostics: new DiagnosticsCollector().toJSON(),
        trust: {
          source: 'internal',
          sanitized: true,
          containsUntrustedText: false,
          containsSecrets: false,
        },
      })
    );
    const provider = new AiProvider({ model: 'fixture' });
    vi.spyOn(provider, 'chatWithTools')
      .mockResolvedValueOnce({
        text: null,
        functionCalls: [{ id: 'call', name: 'meta', args: { action: 'tools', params: {} } }],
      })
      .mockResolvedValue({ text: 'done', functionCalls: [] });
    // 只替代外部 provider/router；真实 runtime、HookSystem 和工具准入链保持接线。
    const runtime = new AgentRuntime({
      aiProvider: provider,
      toolRegistry: new UnifiedToolCatalog(),
      container: { get: () => catalog },
      additionalTools: ['meta'],
      toolRouter: {
        execute,
        executeChildCall: execute,
        explain: async () => ({ allowed: true, stage: 'execute' }),
      },
      strategy: new SingleStrategy(),
    });
    const blocker = vi.fn(() => false);
    let unsubscribe = () => {};
    unsubscribe = runtime.hookSystem.on('tool:execute:before', () => unsubscribe(), {
      priority: 1,
    });
    runtime.hookSystem.on('tool:execute:before', blocker, { priority: 2 });
    const result = await runtime.reactLoop('fixture', {
      budgetOverride: { maxIterations: 2, timeoutMs: 1000 },
    });
    expect(blocker).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(result.diagnostics?.blockedTools).toContainEqual(
      expect.objectContaining({ tool: 'meta' })
    );
  });

  it('awaits a PromiseLike blocking decision', async () => {
    const hooks = new HookSystem();
    hooks.on('tool:execute:before', () => ({
      // biome-ignore lint/suspicious/noThenProperty: 故意覆盖非原生 Promise 的公开 Hook 返回边界。
      then: (resolve: (value: boolean) => void) => resolve(false),
    }));
    await expect(
      hooks.emit('tool:execute:before', { toolId: 'code', args: {}, callId: 'fixture' })
    ).resolves.toBe(false);
  });

  it('claims an async once hook before a concurrent emission can invoke it again', async () => {
    const hooks = new HookSystem();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const once = vi.fn(async () => gate);
    // 两次分发先同时快照到 once，再等待前置 hook，不能仅靠从 live list 移除防重。
    hooks.on('agent:finalize', async () => gate, { priority: 1 });
    hooks.once('agent:finalize', once, 2);
    const payload = { reply: 'done', iterations: 1, toolCallCount: 0 };
    const first = hooks.emit('agent:finalize', payload);
    const second = hooks.emit('agent:finalize', payload);
    release();
    await Promise.all([first, second]);
    expect(once).toHaveBeenCalledOnce();
    expect(hooks.hookCount()).toBe(1);
  });

  it('claims a synchronous once hook before reentrant dispatch', () => {
    const hooks = new HookSystem();
    const payload = { reply: 'done', iterations: 1, toolCallCount: 0 };
    let calls = 0;
    hooks.once('agent:finalize', () => {
      calls++;
      if (calls < 2) {
        hooks.emitSync('agent:finalize', payload);
      }
    });
    hooks.emitSync('agent:finalize', payload);
    expect(calls).toBe(1);
    expect(hooks.hookCount()).toBe(0);
  });

  it('defers new hooks and preserves the current sync snapshot after unsubscribe', () => {
    const hooks = new HookSystem();
    const calls: string[] = [];
    let unsubscribe = () => {};
    unsubscribe = hooks.on('agent:finalize', () => {
      calls.push('first');
      unsubscribe();
      hooks.on('agent:finalize', () => calls.push('new'));
    });
    hooks.on('agent:finalize', () => calls.push('later'));
    const payload = { reply: 'done', iterations: 1, toolCallCount: 0 };
    hooks.emitSync('agent:finalize', payload);
    expect(calls).toEqual(['first', 'later']);
    calls.length = 0;
    hooks.emitSync('agent:finalize', payload);
    expect(calls).toEqual(['later', 'new']);
  });
});

describe('HookSystem diagnostics', () => {
  it('redacts hook failures before the real runtime emits a developer-facing process event', async () => {
    const marker = 'observer-fixture-marker';
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const provider = new AiProvider({ model: 'fixture' });
    vi.spyOn(provider, 'chatWithTools').mockResolvedValue({ text: 'done', functionCalls: [] });
    const events: ProgressEvent[] = [];
    const runtime = new AgentRuntime({
      aiProvider: provider,
      toolRegistry: new UnifiedToolCatalog(),
      toolRouter: new ToolRouterAdapter({
        contextFactory: { create: () => ({ projectRoot: process.cwd(), tokenBudget: 4000 }) },
      }),
      strategy: new SingleStrategy(),
      onProgress: (event) => {
        events.push(event);
      },
    });
    runtime.hookSystem.on('llm:call:before', () => {
      throw new Error(`password=${marker} ordinary fixture detail`);
    });
    const result = await runtime.reactLoop('fixture', {
      budgetOverride: { maxIterations: 1, timeoutMs: 1000 },
    });
    const processEvent = events.find(
      (event) => event.type === 'agent_process_event' && event.processEvent?.kind === 'llm.input'
    )?.processEvent;
    expect(result.reply).toBe('done');
    expect(processEvent).toMatchObject({
      sourceClass: 'developer-facing',
      metadata: { hookErrors: [expect.objectContaining({ code: 'HOOK_HANDLER_FAILED' })] },
    });
    expect(JSON.stringify(processEvent)).not.toContain(marker);
    expect(runtime.hookSystem.getDiagnostics().hookErrors[0].message).toBe(
      'password=[redacted] ordinary fixture detail'
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(marker);
  });

  it('records a PromiseLike rejection from synchronous dispatch', async () => {
    const hooks = new HookSystem();
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    hooks.on('agent:finalize', () => ({
      // biome-ignore lint/suspicious/noThenProperty: 故意覆盖异步观察者返回 PromiseLike 拒绝的输入边界。
      then: (_resolve: unknown, reject: (error: Error) => void) =>
        reject(new Error('thenable failed')),
    }));
    hooks.emitSync('agent:finalize', { reply: 'done', iterations: 1, toolCallCount: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hooks.getDiagnostics().hookErrors).toContainEqual(
      expect.objectContaining({ message: 'thenable failed', mode: 'sync' })
    );
  });

  it.each([
    { mode: 'sync', failure: 'logger' },
    { mode: 'async', failure: 'logger' },
    { mode: 'sync', failure: 'frozen metadata' },
    { mode: 'async', failure: 'frozen metadata' },
  ] as const)('isolates $failure diagnostic failures during $mode dispatch', async ({
    mode,
    failure,
  }) => {
    const hooks = new HookSystem();
    vi.spyOn(Logger, 'warn').mockImplementation(() => {
      if (failure === 'logger') {
        throw new Error('diagnostic channel failed');
      }
    });
    const blocker = vi.fn(() => false);
    hooks.on('tool:execute:before', () => {
      throw new Error('observer failed');
    });
    hooks.on('tool:execute:before', blocker);
    const payload: HookPayloadMap['tool:execute:before'] = {
      toolId: 'code',
      args: {},
      callId: 'fixture',
      ...(failure === 'frozen metadata'
        ? {
            processEvent: {
              createdAt: 'fixture',
              displayPolicy: 'full',
              kind: 'tool',
              metadata: Object.freeze({}),
              retention: 'transient',
              severity: 'info',
              sourceClass: 'developer-facing',
              title: 'fixture',
            },
          }
        : {}),
    };
    if (mode === 'sync') {
      expect(() => hooks.emitSync('tool:execute:before', payload)).not.toThrow();
    } else {
      await expect(hooks.emit('tool:execute:before', payload)).resolves.toBe(false);
    }
    expect(blocker).toHaveBeenCalledOnce();
    expect(hooks.getDiagnostics().hookErrors).toContainEqual(
      expect.objectContaining({ message: 'observer failed' })
    );
  });

  it('captures asynchronous observer rejection from synchronous dispatch', async () => {
    const hooks = new HookSystem();
    hooks.on('agent:iteration:after', async () => {
      throw new Error('async observer failed');
    });
    hooks.emitSync('agent:iteration:after', { iteration: 1, hadToolCalls: false, hadText: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hooks.getDiagnostics().hookErrors).toEqual([
      expect.objectContaining({ message: 'async observer failed' }),
    ]);
  });
  it('surfaces synchronous hook errors as stable diagnostics', () => {
    const hooks = new HookSystem();
    const processEvent = { metadata: {} };

    hooks.on('tool:execute:after', () => {
      throw new Error('observer failed');
    });

    hooks.emitSync('tool:execute:after', {
      toolId: 'code',
      ok: true,
      durationMs: 1,
      callId: 'call-1',
      processEvent: processEvent as never,
    });

    expect(hooks.getDiagnostics().hookErrors).toEqual([
      expect.objectContaining({
        code: 'HOOK_HANDLER_FAILED',
        event: 'tool:execute:after',
        message: 'observer failed',
        mode: 'sync',
      }),
    ]);
    expect(processEvent.metadata).toMatchObject({
      hookErrors: [
        expect.objectContaining({
          code: 'HOOK_HANDLER_FAILED',
          event: 'tool:execute:after',
          message: 'observer failed',
          mode: 'sync',
        }),
      ],
    });
  });

  it('surfaces asynchronous hook errors without blocking later hooks', async () => {
    const hooks = new HookSystem();
    const calls: string[] = [];

    hooks.on('tool:execute:before', async () => {
      calls.push('failing');
      throw new Error('async failed');
    });
    hooks.on('tool:execute:before', () => {
      calls.push('later');
      return true;
    });

    const allowed = await hooks.emit('tool:execute:before', {
      toolId: 'code',
      args: {},
      callId: 'call-1',
    });

    expect(allowed).toBe(true);
    expect(calls).toEqual(['failing', 'later']);
    expect(hooks.getDiagnostics().hookErrors[0]).toMatchObject({
      code: 'HOOK_HANDLER_FAILED',
      event: 'tool:execute:before',
      message: 'async failed',
      mode: 'async',
    });
  });
});
