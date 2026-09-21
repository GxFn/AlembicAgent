import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiProviderManager, type ManagedAiProvider, type SwitchResult } from '../src/ai/index.js';
import { OpenAiProvider } from '../src/ai/providers/OpenAiProvider.js';
import { jsonResponse } from './helpers/mockFetch.js';

function provider(name: string): ManagedAiProvider {
  return { name, model: `${name}-model`, supportsEmbedding: () => true };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('AiProviderManager usage ownership', () => {
  it('keeps the ownership marker when a host decorates a candidate hook before a failed switch', () => {
    const manager = new AiProviderManager(provider('initial'));
    const next = provider('next');
    const record = vi.fn();
    manager.setTokenRecorder({ record });
    let fail = true;
    manager._bindDiSync((p) => {
      if (p === next && fail) {
        const managedHook = p._onTokenUsage;
        p._onTokenUsage = (usage) => managedHook?.(usage);
        throw new Error('fixture host failure after decorating');
      }
    });
    expect(() => manager.switchProvider(next)).toThrow();
    fail = false;
    manager.switchProvider(next);
    next._onTokenUsage?.({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    expect(record).toHaveBeenCalledOnce();
  });

  it('respects a host decorator after binding without double-counting or deduplicating later events', () => {
    const initial = provider('initial');
    const manager = new AiProviderManager(initial);
    const record = vi.fn();
    manager.setTokenRecorder({ record });
    const managedHook = initial._onTokenUsage;
    const hostObserver = vi.fn();
    const decorated: NonNullable<ManagedAiProvider['_onTokenUsage']> = (usage) => {
      hostObserver(usage);
      managedHook?.(usage);
    };
    initial._onTokenUsage = decorated;
    manager.setEmbedProvider(initial);
    manager.switchProvider(initial);
    const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };
    initial._onTokenUsage?.(usage);
    initial._onTokenUsage?.(usage);
    expect(initial._onTokenUsage).toBe(decorated);
    expect(hostObserver).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('keeps the original observer and records an old in-flight SDK response under its request model', async () => {
    const initial = new OpenAiProvider({
      apiKey: 'fixture-key',
      model: 'initial-model',
      maxRetries: 0,
    });
    const next = new OpenAiProvider({ apiKey: 'fixture-key', model: 'next-model', maxRetries: 0 });
    const original = vi.fn();
    initial._onTokenUsage = original;
    const manager = new AiProviderManager(initial);
    const record = vi.fn();
    manager.setTokenRecorder({ record });
    let finish!: (response: Response) => void;
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const request = JSON.parse(init.body);
        if (request.model === 'initial-model') {
          start();
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        }
        return jsonResponse({
          choices: [{ index: 0, message: { content: 'new' } }],
          usage: { prompt_tokens: 7, completion_tokens: 11 },
        });
      })
    );
    const pending = initial.chat('old request');
    await started;
    manager.switchProvider(next);
    initial.model = 'mutated-after-request';
    expect(await next.chat('new request')).toBe('new');
    finish(
      jsonResponse({
        choices: [{ index: 0, message: { content: 'old' } }],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      })
    );
    expect(await pending).toBe('old');
    expect(original).toHaveBeenCalledOnce();
    expect(record.mock.calls.map(([event]) => event)).toEqual([
      { provider: 'openai', model: 'next-model', source: 'chat', inputTokens: 7, outputTokens: 11 },
      {
        provider: 'openai',
        model: 'initial-model',
        source: 'chat',
        inputTokens: 2,
        outputTokens: 3,
      },
    ]);
  });

  it('tracks emitted embedding usage and does not stack hooks when providers are reused', () => {
    const initial = provider('initial');
    const embedding = provider('embedding');
    const original = vi.fn();
    initial._onTokenUsage = original;
    const manager = new AiProviderManager(initial);
    const record = vi.fn();
    manager.setTokenRecorder({ record });
    manager.setEmbedProvider(embedding);
    const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };
    initial._onTokenUsage?.(usage);
    embedding._onTokenUsage?.({ ...usage, source: 'embed', model: 'actual-embedding' });
    manager.switchProvider(provider('next'));
    manager.switchProvider(initial);
    manager.setTokenRecorder({ record });
    initial._onTokenUsage?.(usage);
    embedding._onTokenUsage?.({ ...usage, source: 'embed', model: 'actual-embedding' });
    expect(original).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(4);
    expect(record.mock.calls[1][0]).toMatchObject({
      provider: 'embedding',
      model: 'actual-embedding',
      source: 'embed',
    });
  });

  it('isolates recorder failure from the existing observer without retrying a possible write', () => {
    const initial = provider('initial');
    const original = vi.fn();
    initial._onTokenUsage = original;
    const manager = new AiProviderManager(initial);
    const record = vi.fn(() => {
      throw new Error('fixture store failed after write');
    });
    manager.setTokenRecorder({ record });
    const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };
    expect(() => initial._onTokenUsage?.(usage)).not.toThrow();
    expect(record).toHaveBeenCalledOnce();
    expect(original).toHaveBeenCalledOnce();
  });

  it.each([
    -1,
    NaN,
    Infinity,
    1.5,
  ])('rejects invalid token counts %s at the recorder boundary', (inputTokens) => {
    const initial = provider('initial');
    const manager = new AiProviderManager(initial);
    const record = vi.fn();
    manager.setTokenRecorder({ record });
    initial._onTokenUsage?.({ inputTokens, outputTokens: 3, totalTokens: 5 });
    expect(record).not.toHaveBeenCalled();
  });
});

describe('AiProviderManager routing lifecycle', () => {
  it('keeps an explicitly configured embedding instance across LLM switches', () => {
    const embedding = provider('fixed-qwen-embedding');
    const manager = new AiProviderManager(provider('first-llm'));
    manager.setEmbedProvider(embedding);
    const sync = vi.fn();
    manager._bindDiSync(sync);
    manager.switchProvider(provider('second-llm'));
    expect(manager.embedProvider).toBe(embedding);
    expect(manager.rawEmbedProvider).toBe(embedding);
    expect(sync).toHaveBeenCalledWith(manager.provider, embedding);
  });

  it('leaves embedding unavailable when only an LLM provider is configured', () => {
    const manager = new AiProviderManager(provider('llm-only'));
    expect(manager.embedProvider).toBeNull();
    manager.switchProvider(provider('another-llm'));
    expect(manager.embedProvider).toBeNull();
  });

  it('observes an asynchronous capability rejection and requires repair of the synchronous contract', async () => {
    const initial = provider('initial');
    const manager = new AiProviderManager(initial);
    let reject!: (reason: Error) => void;
    const pending = new Promise<boolean>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const next = provider('next');
    // 模拟 JS 宿主违反同步类型合同；不可留下无人接收的 rejection。
    next.supportsEmbedding = () => pending as unknown as boolean;
    let failure: unknown;
    try {
      manager.switchProvider(next);
    } catch (err: unknown) {
      failure = err;
    }
    expect(failure).toMatchObject({ phase: 'prepare', recovery: 'required' });
    expect(manager.provider).toBe(initial);
    expect(manager.isReady).toBe(false);
    reject(new Error('fixture capability unavailable'));
    await expect(pending).rejects.toThrow('fixture capability unavailable');
    await Promise.resolve();
    next.supportsEmbedding = () => true;
    expect(manager.switchProvider(next).current.name).toBe('next');
  });

  it('rejects asynchronous DI hooks and blocks another switch until the invalid hook settles', async () => {
    const initial = provider('initial');
    const next = provider('next');
    const manager = new AiProviderManager(initial);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    manager._bindDiSync(() => pending);
    let failure: unknown;
    try {
      manager.switchProvider(next);
    } catch (err: unknown) {
      failure = err;
    }
    expect(failure).toMatchObject({
      code: 'AI_PROVIDER_SWITCH_FAILED',
      phase: 'sync',
      recovery: 'required',
    });
    expect(manager.provider).toBe(initial);
    expect(manager.isReady).toBe(false);
    manager._bindDiSync(() => {});
    expect(() => manager.switchProvider(next)).toThrow(/in progress/);
    finish();
    await pending;
    await Promise.resolve();
    expect(manager.switchProvider(next).current.name).toBe('next');
    expect(manager.isReady).toBe(true);
  });

  it('isolates asynchronous observer failures and reports them without copying error payloads', async () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => {});
    const next = provider('next');
    next._onTokenUsage = async () => {
      throw new Error('fixture-private-observer-payload');
    };
    const manager = new AiProviderManager(provider('initial'));
    manager.setTokenRecorder({
      record: async () => {
        throw new Error('fixture-private-recorder-payload');
      },
    });
    manager.onSwitch(async () => {
      throw new Error('fixture-private-listener-payload');
    });
    expect(manager.switchProvider(next).current.name).toBe('next');
    next._onTokenUsage?.({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(manager.isReady).toBe(true);
    const diagnostics = JSON.stringify(warn.mock.calls);
    expect(diagnostics).toContain('listener_failed');
    expect(diagnostics).toContain('recorder_failed');
    expect(diagnostics).toContain('usage_observer_failed');
    expect(diagnostics).not.toContain('fixture-private');
  });

  it('uses a stable listener snapshot and isolates result mutation during notification', () => {
    const manager = new AiProviderManager(provider('initial'));
    const observed: string[] = [];
    const late = vi.fn();
    let removeSecond = () => {};
    manager.onSwitch((result) => {
      manager.onSwitch(late);
      removeSecond();
      result.current.name = 'listener-mutated';
      result.clearedSingletons.push('listener-mutated');
    });
    removeSecond = manager.onSwitch((result) => {
      observed.push(result.current.name);
    });
    manager._bindDependentClearer(() => ['search']);

    const result = manager.switchProvider(provider('next'));
    expect(result.current.name).toBe('next');
    expect(result.clearedSingletons).toEqual(['search']);
    expect(observed).toEqual(['next']);
    expect(late).not.toHaveBeenCalled();
    manager.switchProvider(provider('last'));
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('rejects routing mutation during a switch and releases the guard after completion', () => {
    const initial = provider('initial');
    const next = provider('next');
    const manager = new AiProviderManager(initial);
    const failures: string[] = [];
    manager.onSwitch(() => {
      for (const change of [
        () => manager.switchProvider(provider('nested')),
        () => manager.setEmbedProvider(provider('nested-embedding')),
      ]) {
        try {
          change();
        } catch (err: unknown) {
          failures.push((err as { code: string }).code);
        }
      }
    });
    expect(manager.switchProvider(next).current.name).toBe('next');
    expect(manager.provider).toBe(next);
    expect(manager.rawEmbedProvider).toBeNull();
    expect(failures).toEqual(['AI_PROVIDER_SWITCH_IN_PROGRESS', 'AI_PROVIDER_SWITCH_IN_PROGRESS']);
    manager.setEmbedProvider(provider('standalone-embedding'));
    expect(manager.embedProvider?.name).toBe('standalone-embedding');
  });

  it.each([
    'sync',
    'invalidate',
  ] as const)('restores routing after %s fails without publishing a success event', (phase) => {
    const initial = provider('initial');
    const embedding = provider('embedding');
    const next = provider('next');
    const originalUsage = vi.fn();
    next._onTokenUsage = originalUsage;
    const manager = new AiProviderManager(initial);
    manager.setEmbedProvider(embedding);
    let hostProvider = initial;
    let hostEmbedding: ManagedAiProvider | null = embedding;
    let cached: object | null = { provider: initial };
    const events = vi.fn();
    manager.onSwitch(events);
    manager._bindDiSync((p, e) => {
      hostProvider = p;
      hostEmbedding = e;
      if (phase === 'sync' && p === next) {
        throw new Error('fixture sync failure');
      }
    });
    manager._bindDependentClearer(() => {
      expect(manager.provider).toBe(next);
      expect(hostProvider).toBe(next);
      cached = null;
      throw new Error('fixture invalidation failure');
    });

    expect(() => manager.switchProvider(next)).toThrow();
    expect(manager.provider).toBe(initial);
    expect(manager.rawEmbedProvider).toBe(embedding);
    expect(hostProvider).toBe(initial);
    expect(hostEmbedding).toBe(embedding);
    expect(next._onTokenUsage).toBe(originalUsage);
    expect(events).not.toHaveBeenCalled();
    expect(manager.isReady).toBe(true);
    // 缓存失效不是可逆事务；恢复引用后由宿主按旧路由重新惰性构建。
    expect(cached === null).toBe(phase === 'invalidate');
  });

  it('marks a failed compensation as recovery-required and allows a later successful switch', () => {
    const initial = provider('initial');
    const next = provider('next');
    const manager = new AiProviderManager(initial);
    manager._bindDiSync(() => {
      throw new Error('fixture host unavailable');
    });
    let failure: unknown;
    try {
      manager.switchProvider(next);
    } catch (err: unknown) {
      failure = err;
    }
    expect(failure).toMatchObject({ code: 'AI_PROVIDER_SWITCH_FAILED', recovery: 'required' });
    expect(manager.provider).toBe(initial);
    expect(manager.isReady).toBe(false);
    let hostProvider = initial;
    manager._bindDiSync((p) => {
      hostProvider = p;
    });
    expect(manager.switchProvider(next).current.name).toBe('next');
    expect(hostProvider).toBe(next);
    expect(manager.isReady).toBe(true);
  });

  it('keeps the old provider and embedding when candidate preparation fails', () => {
    const initial = provider('initial');
    const embedding = provider('embedding');
    const next = provider('next');
    const originalUsage = vi.fn();
    next._onTokenUsage = originalUsage;
    const manager = new AiProviderManager(initial);
    manager.setEmbedProvider(embedding);
    const sync = vi.fn();
    const clear = vi.fn(() => ['search']);
    const listener = vi.fn();
    manager._bindDiSync(sync);
    manager._bindDependentClearer(clear);
    manager.onSwitch(listener);
    next.supportsEmbedding = () => {
      throw new Error('fixture initialization failure');
    };

    expect(() => manager.switchProvider(next)).toThrow();
    expect(manager.provider).toBe(initial);
    expect(manager.rawEmbedProvider).toBe(embedding);
    expect(next._onTokenUsage).toBe(originalUsage);
    expect(sync).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('AiProviderManager', () => {
  it('rewires token tracking and emits switch events when routing providers', () => {
    const initialProvider: ManagedAiProvider = {
      name: 'test-local-fake',
      model: 'test-local-model',
      supportsEmbedding: () => true,
    };
    const nextProvider: ManagedAiProvider = {
      name: 'openai',
      model: 'gpt-test',
      supportsEmbedding: () => false,
    };
    const tokenRecords: Array<{
      source: string;
      provider?: string;
      model?: string;
      inputTokens: number;
      outputTokens: number;
    }> = [];
    const switches: SwitchResult[] = [];
    const manager = new AiProviderManager(initialProvider);

    manager.setTokenRecorder({
      record: (entry) => {
        tokenRecords.push(entry);
      },
    });
    manager.onSwitch((result) => {
      switches.push(result);
    });

    initialProvider._onTokenUsage?.({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      source: 'chat',
    });

    const result = manager.switchProvider(nextProvider);
    nextProvider._onTokenUsage?.({
      inputTokens: 7,
      outputTokens: 11,
      totalTokens: 18,
      source: 'tools',
    });

    expect(result.previous).toMatchObject({ name: 'test-local-fake', isMock: false });
    expect(result.current).toMatchObject({ name: 'openai', model: 'gpt-test', isMock: false });
    expect(manager.isMock).toBe(false);
    expect(switches).toHaveLength(1);
    expect(tokenRecords).toEqual([
      {
        source: 'chat',
        provider: 'test-local-fake',
        model: 'test-local-model',
        inputTokens: 2,
        outputTokens: 3,
      },
      {
        source: 'tools',
        provider: 'openai',
        model: 'gpt-test',
        inputTokens: 7,
        outputTokens: 11,
      },
    ]);
  });
});
