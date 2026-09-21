import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __testingProxyDispatcherCache } from '../src/ai/transport/LLMTransport.js';
import { OpenAiTransport } from '../src/ai/transport/OpenAiTransport.js';
import { jsonResponse } from './helpers/mockFetch.js';

// 薄壳化后代理感知从 AiProvider 下沉到 LLMTransport。
// 这里直接验证 resolveProxyUrl 的优先级与映射，确保依赖 HTTPS_PROXY 等
// 环境变量访问境外 API 的部署不会因为收口而回归。

const PROXY_ENV_KEYS = [
  'ALEMBIC_OPENAI_PROXY_HTTPS',
  'ALEMBIC_OPENAI_PROXY_HTTP',
  'ALEMBIC_GOOGLE_PROXY_HTTPS',
  'ALEMBIC_AI_PROXY',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
];

// 访问 protected 方法用于单测。
function resolveProxy(transport: OpenAiTransport): string {
  return (transport as unknown as { resolveProxyUrl(): string }).resolveProxyUrl();
}

describe('LLMTransport.resolveProxyUrl', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it('returns empty string when no proxy env is set', () => {
    const transport = new OpenAiTransport({ apiKey: 'k' });
    expect(resolveProxy(transport)).toBe('');
  });

  it('prefers provider-specific ALEMBIC_<PROVIDER>_PROXY_HTTPS over generic vars', () => {
    process.env.HTTPS_PROXY = 'http://generic:8080';
    process.env.ALEMBIC_AI_PROXY = 'http://ai:8080';
    process.env.ALEMBIC_OPENAI_PROXY_HTTPS = 'http://openai-specific:8080';
    const transport = new OpenAiTransport({ apiKey: 'k' });
    expect(resolveProxy(transport)).toBe('http://openai-specific:8080');
  });

  it('falls back to ALEMBIC_AI_PROXY when no provider-specific var', () => {
    process.env.HTTPS_PROXY = 'http://generic:8080';
    process.env.ALEMBIC_AI_PROXY = 'http://ai:8080';
    const transport = new OpenAiTransport({ apiKey: 'k' });
    expect(resolveProxy(transport)).toBe('http://ai:8080');
  });

  it('falls back to standard HTTPS_PROXY when no Alembic-specific var', () => {
    process.env.HTTPS_PROXY = 'http://generic:8080';
    const transport = new OpenAiTransport({ apiKey: 'k' });
    expect(resolveProxy(transport)).toBe('http://generic:8080');
  });

  it('does not match a different provider tag', () => {
    process.env.ALEMBIC_GOOGLE_PROXY_HTTPS = 'http://google-only:8080';
    const transport = new OpenAiTransport({ apiKey: 'k' });
    // openai transport 不应命中 google 专属变量
    expect(resolveProxy(transport)).toBe('');
  });
});

describe('LLMTransport proxy fetch wiring', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __testingProxyDispatcherCache.clear();
    for (const key of PROXY_ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  // 关键回归保护：即使环境配置了代理，请求仍走全局 fetch（Node>=22 即 undici，
  // 原生识别 dispatcher），因此 vi.stubGlobal('fetch') 的桩不会被绕过。
  it('still calls global fetch (stub-friendly) and passes a dispatcher when proxy is set', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    let capturedInit: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init as unknown as Record<string, unknown>;
      return jsonResponse({ choices: [{ index: 0, message: { content: 'via-proxy' } }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = new OpenAiTransport({ apiKey: 'k' });
    const text = await transport.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedInit?.dispatcher).toBeDefined();
    expect(text).toBe('via-proxy');
  });

  it('calls global fetch without a dispatcher when no proxy is set', async () => {
    let capturedInit: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init as unknown as Record<string, unknown>;
      return jsonResponse({ choices: [{ index: 0, message: { content: 'direct' } }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = new OpenAiTransport({ apiKey: 'k' });
    const text = await transport.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedInit?.dispatcher).toBeUndefined();
    expect(text).toBe('direct');
  });

  it('shares one live dispatcher across concurrent first requests', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    const dispatchers: unknown[] = [];
    const closedAtFetch: boolean[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        const dispatcher = (init as RequestInit & { dispatcher: { closed: boolean } }).dispatcher;
        dispatchers.push(dispatcher);
        closedAtFetch.push(dispatcher.closed);
        return jsonResponse({ choices: [{ index: 0, message: { content: 'via-proxy' } }] });
      })
    );
    const transport = new OpenAiTransport({ apiKey: 'k' });
    const request = { model: 'gpt-4o', messages: [{ role: 'user' as const, content: 'hi' }] };

    expect(await Promise.all([transport.chat(request), transport.chat(request)])).toEqual([
      'via-proxy',
      'via-proxy',
    ]);
    expect(dispatchers[0]).toBeDefined();
    expect(dispatchers[1]).toBe(dispatchers[0]);
    expect(closedAtFetch).toEqual([false, false]);
    expect(__testingProxyDispatcherCache.size()).toBe(1);
  });

  it.each([
    'close',
    'destroy',
  ] as const)('consumes rejected asynchronous dispatcher %s cleanup', async (method) => {
    const then = vi.fn((_resolve: unknown, reject: (error: Error) => void) => {
      reject(new Error('dispatcher cleanup failed'));
    });
    __testingProxyDispatcherCache.set('http://fixture:8080', { [method]: () => ({ then }) });
    __testingProxyDispatcherCache.clear();
    await Promise.resolve();
    await Promise.resolve();
    expect(then).toHaveBeenCalledOnce();
    expect(__testingProxyDispatcherCache.size()).toBe(0);
  });

  it.each([
    'success',
    'reject',
    'cancel',
  ] as const)('keeps nine cold-start dispatchers live through fetch and releases on %s', async (outcome) => {
    class FixedProxyTransport extends OpenAiTransport {
      constructor(private readonly proxyId: number) {
        super({ apiKey: 'k', baseUrl: `https://fixture-${proxyId}.invalid/v1` });
      }

      protected override resolveProxyUrl(): string {
        return `http://127.0.0.1:${8100 + this.proxyId}`;
      }
    }
    const ready = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const cancelled = new AbortController();
    const dispatchers = new Map<number, { closed: boolean }>();
    const closedAtFetch: boolean[] = [];
    const fetchMock = vi.fn(async (url, init: RequestInit) => {
      const id = Number(new URL(String(url)).hostname.match(/fixture-(\d+)/)?.[1]);
      const dispatcher = (init as RequestInit & { dispatcher: { closed: boolean } }).dispatcher;
      dispatchers.set(id, dispatcher);
      closedAtFetch.push(dispatcher.closed);
      if (dispatchers.size === 9) {
        ready.resolve();
      }
      if (id === 0 && outcome === 'cancel') {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      await resume.promise;
      if (id === 0 && outcome === 'reject') {
        throw new Error('fixture request failed');
      }
      return jsonResponse({ choices: [{ index: 0, message: { content: 'via-proxy' } }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const pending = Array.from({ length: 9 }, (_, index) =>
      new FixedProxyTransport(index).chat({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        ...(index === 0 ? { abortSignal: cancelled.signal } : {}),
      })
    );
    const settled = Promise.allSettled(pending);
    try {
      await ready.promise;
      expect(closedAtFetch).toEqual(Array(9).fill(false));
      expect(__testingProxyDispatcherCache.size()).toBe(8);
      expect(dispatchers.get(0)?.closed).toBe(false);
      if (outcome === 'cancel') {
        cancelled.abort(new Error('fixture cancellation'));
      }
      resume.resolve();
      const results = await settled;
      expect(results[0].status).toBe(outcome === 'success' ? 'fulfilled' : 'rejected');
      expect(results.slice(1).every((result) => result.status === 'fulfilled')).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(9);
      expect(dispatchers.get(0)?.closed).toBe(true);
      expect(__testingProxyDispatcherCache.size()).toBe(8);
      __testingProxyDispatcherCache.clear();
      expect([...dispatchers.values()].every((dispatcher) => dispatcher.closed)).toBe(true);
    } finally {
      cancelled.abort();
      resume.resolve();
      await settled;
    }
  });

  it('does not revive a cleared cache when an older initialization finishes', async () => {
    vi.resetModules();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const createDispatcher = vi.fn(function ProxyAgentFixture() {
      return { close: vi.fn(), closed: false };
    });
    vi.doMock('undici', async () => {
      entered.resolve();
      await resume.promise;
      return { ProxyAgent: createDispatcher };
    });
    const { OpenAiTransport: FreshTransport } = await import(
      '../src/ai/transport/OpenAiTransport.js'
    );
    const { __testingProxyDispatcherCache: freshCache } = await import(
      '../src/ai/transport/LLMTransport.js'
    );
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ index: 0, message: { content: 'fresh request' } }] })
    );
    vi.stubGlobal('fetch', fetchMock);
    const transport = new FreshTransport({ apiKey: 'k' });
    const request = { model: 'gpt-4o', messages: [{ role: 'user' as const, content: 'hi' }] };
    const pending = transport.chat(request).catch((error: unknown) => error);
    try {
      await entered.promise;
      freshCache.clear();
      resume.resolve();
      expect(await pending).toMatchObject({ name: 'AbortError' });
      expect(freshCache.size()).toBe(0);
      expect(createDispatcher).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      expect(await transport.chat(request)).toBe('fresh request');
      expect(createDispatcher).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(freshCache.size()).toBe(1);
    } finally {
      resume.resolve();
      await pending;
      freshCache.clear();
      vi.doUnmock('undici');
      vi.resetModules();
    }
  });

  it('evicts the oldest proxy dispatcher when the cache exceeds its bound', () => {
    const closed: string[] = [];
    for (let index = 0; index < __testingProxyDispatcherCache.maxSize + 1; index++) {
      const key = `http://proxy-${index}:8080`;
      __testingProxyDispatcherCache.set(key, {
        close: () => closed.push(key),
      });
    }

    expect(__testingProxyDispatcherCache.size()).toBe(__testingProxyDispatcherCache.maxSize);
    expect(__testingProxyDispatcherCache.keys()[0]).toBe('http://proxy-1:8080');
    expect(closed).toEqual(['http://proxy-0:8080']);
  });
});
