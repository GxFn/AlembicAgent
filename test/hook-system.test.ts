import { describe, expect, it } from 'vitest';

import { HookSystem } from '../src/agent/runtime/index.js';

describe('HookSystem diagnostics', () => {
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
