import { describe, expect, it } from 'vitest';

import { AgentEventBus, HookSystem } from '../src/agent/runtime/index.js';

describe('AgentEventBus request/reply', () => {
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

describe('HookSystem diagnostics', () => {
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
