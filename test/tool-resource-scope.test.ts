import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/ContextWindow.js';
import { BudgetPolicy, PolicyEngine } from '../src/agent/policies/index.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import type { RuntimeConfig } from '../src/agent/runtime/AgentRuntimeTypes.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';
import type { ToolCallRequest } from '../src/tools/kernel/index.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';
import { DeltaCache } from '../src/tools/runtime/cache/DeltaCache.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-read-view-'));
  await writeFile(join(root, 'small.ts'), 'one\ntwo\nthree');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function readRequest(params: Record<string, unknown>): ToolCallRequest {
  return {
    toolId: 'code',
    args: { action: 'read', params },
    surface: 'runtime',
    actor: { user: 'test' },
    source: { kind: 'runtime' },
  };
}

describe('code read observation', () => {
  it('does not reuse full visibility after the router truncates an oversized single read', async () => {
    await writeFile(join(root, 'wide.ts'), 'x'.repeat(25000));
    const deltaCache = new DeltaCache();
    const router = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ projectRoot: root, tokenBudget: 8000, deltaCache }),
      },
    });
    const first = await router.execute(readRequest({ path: 'wide.ts' }));
    expect(first.text).toContain('chars truncated');
    const again = await router.execute(readRequest({ path: 'wide.ts' }));
    expect(again.text).not.toContain('unchanged');
    expect(again.text).toContain('chars truncated');
  });
  it('does not present a ranged or outline read as a previously visible full file', async () => {
    const deltaCache = new DeltaCache();
    const router = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ projectRoot: root, tokenBudget: 1000, deltaCache }),
      },
    });
    await router.execute(readRequest({ path: 'small.ts', startLine: 1, endLine: 1 }));
    expect((await router.execute(readRequest({ path: 'small.ts' }))).text).toContain('3|three');
    expect((await router.execute(readRequest({ path: 'small.ts' }))).text).toContain('unchanged');
    await writeFile(
      join(root, 'large.ts'),
      Array.from({ length: 510 }, (_, i) => `line ${i}`).join('\n')
    );
    await router.execute(readRequest({ path: 'large.ts' }));
    const outline = await router.execute(readRequest({ path: 'large.ts' }));
    expect(outline.text).not.toContain('unchanged');
    expect(outline.text).toContain('510');
  });

  it('does not treat a truncated batch result as full visibility', async () => {
    const content = 'a'.repeat(5000);
    await writeFile(join(root, 'wide.ts'), content);
    const router = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ projectRoot: root, tokenBudget: 1000, deltaCache }),
      },
    });
    const deltaCache = new DeltaCache();
    const batch = await router.execute(readRequest({ filePaths: ['wide.ts'] }));
    expect(batch.structuredContent).toMatchObject({ files: [{ truncated: true }] });
    expect((await router.execute(readRequest({ path: 'wide.ts' }))).text).toContain(content);
  });
});

function runtimeHarness(
  responses: Array<Record<string, unknown>>,
  strategy: RuntimeConfig['strategy'] = new SingleStrategy()
) {
  const requests: ToolCallRequest[] = [];
  const releaseScope = vi.fn();
  const router = new ToolRouterAdapter({
    contextFactory: {
      create: (request) => {
        requests.push(request);
        return { projectRoot: root, tokenBudget: 8000 };
      },
      releaseScope,
    },
  });
  const runtime = new AgentRuntime({
    aiProvider: {
      name: 'mock',
      chatWithTools: vi.fn(async () => responses.shift() ?? { text: 'done' }),
    } as never,
    toolRegistry: new RuntimeCapabilityCatalog(),
    container: { get: () => new RuntimeCapabilityCatalog() },
    toolRouter: router,
    projectRoot: root,
    additionalTools: ['code'],
    strategy,
    policies: new PolicyEngine([new BudgetPolicy({ maxIterations: 6, timeoutMs: 1000 })]),
  });
  return { runtime, requests, releaseScope };
}

function readCall(id: string) {
  return {
    functionCalls: [{ id, name: 'code', args: { action: 'read', params: { path: 'small.ts' } } }],
  };
}

describe('runtime-owned tool resource lifecycle', () => {
  it('shares the run across stages, assigns distinct views, then releases both views and the run', async () => {
    const strategy: RuntimeConfig['strategy'] = {
      name: 'scope-fixture',
      execute: async (runtime, _message, opts) => {
        await runtime.reactLoop('first stage', opts);
        return runtime.reactLoop('second stage', opts);
      },
    };
    const { runtime, requests, releaseScope } = runtimeHarness(
      [readCall('a'), { text: 'first done' }, readCall('b'), { text: 'second done' }],
      strategy
    );
    await runtime.execute(new AgentMessage({ content: 'task' }));
    expect(requests).toHaveLength(2);
    const scopes = requests.map((request) => request.runtime?.resourceScope);
    expect(scopes[0]?.runId).toEqual(expect.any(String));
    expect(scopes[1]?.runId).toBe(scopes[0]?.runId);
    expect(scopes[1]?.viewId).not.toBe(scopes[0]?.viewId);
    expect(releaseScope.mock.calls.map(([scope]) => scope)).toEqual([
      { runId: scopes[0]?.runId, viewId: scopes[0]?.viewId },
      { runId: scopes[1]?.runId, viewId: scopes[1]?.viewId },
      { runId: scopes[0]?.runId },
    ]);
  });

  it('uses a new run when the same runtime is called directly again', async () => {
    const { runtime, requests, releaseScope } = runtimeHarness([
      readCall('a'),
      { text: 'done' },
      readCall('b'),
      { text: 'done' },
    ]);
    await runtime.reactLoop('first');
    await runtime.reactLoop('second');
    expect(requests[0]?.runtime?.resourceScope?.runId).toEqual(expect.any(String));
    expect(requests[0]?.runtime?.resourceScope?.runId).not.toBe(
      requests[1]?.runtime?.resourceScope?.runId
    );
    expect(releaseScope).toHaveBeenCalledTimes(4);
  });

  it('invalidates the next read view when the model history quota truncates a read result', async () => {
    await writeFile(join(root, 'small.ts'), 'wide source '.repeat(3000));
    const { runtime, requests } = runtimeHarness([readCall('a'), readCall('b'), { text: 'done' }]);
    const result = await runtime.reactLoop('read twice');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.runtime?.resourceScope?.revision).toBeGreaterThan(
      requests[0]?.runtime?.resourceScope?.revision ?? -1
    );
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.objectContaining({
        code: 'tool_read_view_invalidated',
      })
    );
  });

  it.each([
    'failure',
    'cancel',
    'timeout',
  ] as const)('releases run resources after %s', async (mode) => {
    const abort = new AbortController();
    const strategy: RuntimeConfig['strategy'] = {
      name: 'cleanup-fixture',
      execute: async (runtime, _message, opts) => {
        const result = await runtime.reactLoop('stage', opts);
        if (mode === 'failure') {
          throw new Error('fixture failure');
        }
        if (mode === 'timeout') {
          return new Promise(() => {});
        }
        abort.abort();
        return result;
      },
    };
    const { runtime, requests, releaseScope } = runtimeHarness(
      [readCall('a'), { text: 'done' }],
      strategy
    );
    const pending = runtime.execute(new AgentMessage({ content: 'task' }), {
      abortSignal: abort.signal,
      timeoutMs: 150,
    });
    if (mode === 'cancel') {
      expect((await pending).diagnostics?.efficiency?.cancelReason).toBe('abort_signal');
    } else {
      await expect(pending).rejects.toThrow(
        mode === 'failure' ? 'fixture failure' : 'Agent timeout'
      );
    }
    const scope = requests[0]?.runtime?.resourceScope;
    expect(scope?.runId).toEqual(expect.any(String));
    expect(releaseScope).toHaveBeenCalledWith({ runId: scope?.runId });
    expect(releaseScope).toHaveBeenCalledWith({ runId: scope?.runId, viewId: scope?.viewId });
  });

  it('reports cleanup errors without replacing the completed result', async () => {
    const { runtime, releaseScope } = runtimeHarness([readCall('a'), { text: 'done' }]);
    const warn = vi.spyOn(runtime.logger, 'warn').mockImplementation(() => {});
    releaseScope.mockImplementation(() => {
      throw new Error('fixture cleanup failed');
    });
    try {
      expect((await runtime.reactLoop('task')).reply).toBe('done');
      expect(warn).toHaveBeenCalledWith(
        '[AgentRuntime] tool scope cleanup failed',
        expect.objectContaining({ error: 'fixture cleanup failed' })
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('does not resurrect a timed-out run when a legacy strategy starts a late loop without its signal', async () => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let completed!: (error: unknown) => void;
    const lateResult = new Promise<unknown>((resolve) => {
      completed = resolve;
    });
    const strategy: RuntimeConfig['strategy'] = {
      name: 'late-loop-fixture',
      execute: async (runtime) => {
        await gate;
        try {
          const result = await runtime.reactLoop('late');
          completed(null);
          return result;
        } catch (err: unknown) {
          completed(err);
          throw err;
        }
      },
    };
    const { runtime, requests, releaseScope } = runtimeHarness([readCall('late')], strategy);
    await expect(
      runtime.execute(new AgentMessage({ content: 'task' }), { timeoutMs: 10 })
    ).rejects.toThrow('Agent timeout');
    resume();
    expect(await lateResult).toMatchObject({
      message: 'Cannot start a loop after its tool resource run has closed',
    });
    expect(requests).toHaveLength(0);
    expect(releaseScope).toHaveBeenCalledTimes(1);
  });

  it('advances the view when context compression loses tool content', async () => {
    const contextWindow = new ContextWindow(2000);
    const { runtime, requests } = runtimeHarness([readCall('a'), { text: 'done' }]);
    const initial = contextWindow.readViewRevision;
    contextWindow.appendUserMessage('task');
    for (let i = 0; i < 3; i++) {
      contextWindow.appendAssistantWithToolCalls('', [{ id: `old-${i}`, name: 'code', args: {} }]);
      contextWindow.appendToolResult(`old-${i}`, 'code', 'x'.repeat(5000));
    }
    contextWindow.compactIfNeeded();
    expect(contextWindow.readViewRevision).toBeGreaterThan(initial);
    let revisionAtRead = -1;
    runtime.hookSystem.on('tool:execute:before', () => {
      revisionAtRead = contextWindow.readViewRevision;
    });
    await runtime.reactLoop('new tool', { contextWindow });
    expect(requests[0]?.runtime?.resourceScope?.revision).toBe(revisionAtRead);
  });

  it('keeps collapsed tool rounds paired when replacing an earlier nudge', () => {
    const window = new ContextWindow();
    window.appendUserMessage('task');
    window.appendUserNudge('old');
    for (let i = 0; i < 3; i++) {
      window.appendAssistantWithToolCalls('', [{ id: `call-${i}`, name: 'code', args: {} }]);
      window.appendToolResult(`call-${i}`, 'code', `read ${i}`);
    }
    window.compactForProviderInputBudget({ maxProjectedMessages: 1 });
    const callsBefore = window.toProjectedMessages().flatMap((message) => message.toolCalls ?? []);
    window.appendUserNudge('new');
    expect(window.toProjectedMessages().flatMap((message) => message.toolCalls ?? [])).toEqual(
      callsBefore
    );
    expect(callsBefore).toHaveLength(2);
  });

  it('keeps old context windows usable while disabling unsafe delta reuse', async () => {
    const window = new ContextWindow();
    const legacyWindow = new Proxy(window, {
      get: (target, name) => {
        if (name === 'readViewRevision') {
          return undefined;
        }
        const value = Reflect.get(target, name, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const { runtime, requests } = runtimeHarness([readCall('a'), readCall('b'), { text: 'done' }]);
    await runtime.reactLoop('legacy', { contextWindow: legacyWindow });
    const scopes = requests.map((request) => request.runtime?.resourceScope);
    expect(scopes).toHaveLength(2);
    expect(Number.isSafeInteger(scopes[0]?.revision)).toBe(true);
    expect(scopes[1]?.revision).toBeGreaterThan(scopes[0]?.revision ?? -1);
  });
});
