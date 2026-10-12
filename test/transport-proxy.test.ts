import Logger from '@alembic/core/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __testingProxyDispatcherCache } from '../src/ai/transport/LLMTransport.js';
import { OpenAiTransport } from '../src/ai/transport/OpenAiTransport.js';
import { jsonResponse } from './helpers/mockFetch.js';

// 薄壳化后代理感知从 AiProvider 下沉到 LLMTransport。
// 这里直接验证 resolveProxyUrl 的优先级与映射，确保依赖 HTTPS_PROXY 等
// 环境变量访问境外 API 的部署不会因为收口而回归。

// 开发机常带 NO_PROXY 等变量；测试前统一清空，避免宿主环境改变代理路由断言。
const PROXY_ENV_KEYS = [
  'ALEMBIC_OPENAI_PROXY_HTTPS',
  'ALEMBIC_OPENAI_PROXY_HTTP',
  'ALEMBIC_GOOGLE_PROXY_HTTPS',
  'ALEMBIC_OLLAMA_PROXY_HTTPS',
  'ALEMBIC_OLLAMA_PROXY_HTTP',
  'ALEMBIC_OLLAMA_BASE_URL',
  'ALEMBIC_AI_PROXY',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
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

describe('LLMTransport NO_PROXY and provider-level direct routing', () => {
  const saved: Record<string, string | undefined> = {};
  let debugMessages: string[] = [];

  beforeEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    debugMessages = [];
    vi.spyOn(Logger.getInstance(), 'debug').mockImplementation((message: unknown) => {
      debugMessages.push(String(message));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  interface CapturedCall {
    url: string;
    dispatcher: unknown;
  }

  // 走真实 SDK→fetchWithProxy 链路，只截获最终 fetch 的目标与 dispatcher。
  function stubFetch(): CapturedCall[] {
    const calls: CapturedCall[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: url instanceof Request ? url.url : String(url),
          dispatcher: (init as (RequestInit & { dispatcher?: unknown }) | undefined)?.dispatcher,
        });
        return jsonResponse({ choices: [{ index: 0, message: { content: 'ok' } }] });
      })
    );
    return calls;
  }

  async function chatOnce(transport: OpenAiTransport): Promise<string> {
    return transport.chat({ model: 'fixture-model', messages: [{ role: 'user', content: 'hi' }] });
  }

  function fetchDirect(transport: OpenAiTransport, url: string | URL | Request): Promise<Response> {
    return (
      transport as unknown as {
        fetchWithProxy(url: string | URL | Request, options?: RequestInit): Promise<Response>;
      }
    ).fetchWithProxy(url, { method: 'POST' });
  }

  it('connects the default local Ollama endpoint directly when NO_PROXY lists localhost', async () => {
    process.env.HTTPS_PROXY = 'http://proxy:8080';
    process.env.NO_PROXY = 'localhost,127.0.0.1';
    const calls = stubFetch();

    expect(await chatOnce(new OpenAiTransport({}, 'ollama'))).toBe('ok');
    expect(
      await chatOnce(new OpenAiTransport({ baseUrl: 'http://localhost:11434/v1' }, 'ollama'))
    ).toBe('ok');

    expect(calls.map((call) => new URL(call.url).hostname)).toEqual(['127.0.0.1', 'localhost']);
    expect(calls.every((call) => call.dispatcher === undefined)).toBe(true);
    // 命中 NO_PROXY 的请求不借用、不创建 ProxyAgent。
    expect(__testingProxyDispatcherCache.size()).toBe(0);
    expect(debugMessages).toContainEqual(
      expect.stringContaining('proxy_bypassed provider=ollama host=127.0.0.1 reason=no_proxy')
    );
    expect(debugMessages).toContainEqual(
      expect.stringContaining('proxy_bypassed provider=ollama host=localhost reason=no_proxy')
    );
  });

  it('matches NO_PROXY domain suffixes with a leading dot and keeps other hosts on the proxy', async () => {
    process.env.HTTPS_PROXY = 'http://proxy:8080';
    process.env.NO_PROXY = '.example.com';
    const calls = stubFetch();

    await chatOnce(new OpenAiTransport({ apiKey: 'k', baseUrl: 'https://api.example.com/v1' }));
    await chatOnce(new OpenAiTransport({ apiKey: 'k', baseUrl: 'https://example.com/v1' }));
    await chatOnce(new OpenAiTransport({ apiKey: 'k', baseUrl: 'https://example.org/v1' }));
    await chatOnce(new OpenAiTransport({ apiKey: 'k', baseUrl: 'https://notexample.com/v1' }));

    expect(
      calls.map((call) => [new URL(call.url).hostname, call.dispatcher !== undefined])
    ).toEqual([
      ['api.example.com', false],
      ['example.com', false],
      ['example.org', true],
      ['notexample.com', true],
    ]);
    expect(debugMessages).toContainEqual(
      expect.stringContaining('proxy_bypassed provider=openai host=api.example.com reason=no_proxy')
    );
  });

  it('bypasses every target when NO_PROXY is the * wildcard', async () => {
    process.env.HTTPS_PROXY = 'http://proxy:8080';
    process.env.NO_PROXY = '*';
    const calls = stubFetch();

    await chatOnce(new OpenAiTransport({ apiKey: 'k' }));
    await chatOnce(new OpenAiTransport({ apiKey: 'k', baseUrl: 'https://gateway.internal/v1' }));

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.dispatcher === undefined)).toBe(true);
    expect(__testingProxyDispatcherCache.size()).toBe(0);
    expect(debugMessages).toContainEqual(
      expect.stringContaining('proxy_bypassed provider=openai host=api.openai.com reason=no_proxy')
    );
  });

  it('connects directly when the provider-specific proxy variable is direct (case-insensitive)', async () => {
    process.env.HTTPS_PROXY = 'http://proxy:8080';
    process.env.ALEMBIC_AI_PROXY = 'http://ai-proxy:8080';
    const calls = stubFetch();
    const remoteOllama = { baseUrl: 'http://ollama.internal:11434/v1' };

    process.env.ALEMBIC_OLLAMA_PROXY_HTTPS = 'direct';
    await chatOnce(new OpenAiTransport(remoteOllama, 'ollama'));
    process.env.ALEMBIC_OLLAMA_PROXY_HTTPS = ' DIRECT ';
    await chatOnce(new OpenAiTransport(remoteOllama, 'ollama'));
    delete process.env.ALEMBIC_OLLAMA_PROXY_HTTPS;
    process.env.ALEMBIC_OLLAMA_PROXY_HTTP = 'Direct';
    await chatOnce(new OpenAiTransport(remoteOllama, 'ollama'));
    // 其他 provider 不受 Ollama 专属直连值影响，仍走通用代理。
    await chatOnce(new OpenAiTransport({ apiKey: 'k' }));

    expect(calls.map((call) => call.dispatcher !== undefined)).toEqual([false, false, false, true]);
    expect(__testingProxyDispatcherCache.keys()).toEqual(['http://ai-proxy:8080']);
    expect(debugMessages).toContainEqual(
      expect.stringContaining(
        'proxy_bypassed provider=ollama reason=provider_direct source=ALEMBIC_OLLAMA_PROXY_HTTPS'
      )
    );
    expect(debugMessages).toContainEqual(
      expect.stringContaining(
        'proxy_bypassed provider=ollama reason=provider_direct source=ALEMBIC_OLLAMA_PROXY_HTTP'
      )
    );
    const transport = new OpenAiTransport({}, 'ollama');
    expect(resolveProxy(transport)).toBe('');
  });

  it('honours NO_PROXY host:port entries and implicit scheme default ports', async () => {
    process.env.HTTPS_PROXY = 'http://proxy:8080';
    const calls = stubFetch();
    const local = { baseUrl: 'http://localhost:11434/v1' };

    process.env.NO_PROXY = 'localhost:9999';
    await chatOnce(new OpenAiTransport(local, 'ollama'));
    process.env.NO_PROXY = 'localhost:11434';
    await chatOnce(new OpenAiTransport(local, 'ollama'));
    process.env.NO_PROXY = 'api.example.com:443';
    await chatOnce(new OpenAiTransport({ apiKey: 'k', baseUrl: 'https://api.example.com/v1' }));
    process.env.NO_PROXY = 'api.example.com:80';
    await chatOnce(new OpenAiTransport({ apiKey: 'k', baseUrl: 'https://api.example.com/v1' }));

    expect(calls.map((call) => call.dispatcher !== undefined)).toEqual([true, false, false, true]);
  });

  it('matches hosts case-insensitively, reads lowercase no_proxy, and accepts IP literals', async () => {
    process.env.HTTPS_PROXY = 'http://proxy:8080';
    const calls = stubFetch();

    process.env.no_proxy = 'LOCALHOST';
    await chatOnce(new OpenAiTransport({ baseUrl: 'http://LocalHost:11434/v1' }, 'ollama'));
    delete process.env.no_proxy;
    process.env.NO_PROXY = '10.0.0.5, [::1]';
    await chatOnce(new OpenAiTransport({ baseUrl: 'http://10.0.0.5:11434/v1' }, 'ollama'));
    await chatOnce(new OpenAiTransport({ baseUrl: 'http://[::1]:11434/v1' }, 'ollama'));
    // 裸 IPv6 字面量与括号形式等价；*.domain 与 .domain 等价。
    process.env.NO_PROXY = '::1,*.corp.example';
    await chatOnce(new OpenAiTransport({ baseUrl: 'http://[::1]:11434/v1' }, 'ollama'));
    await chatOnce(new OpenAiTransport({ apiKey: 'k', baseUrl: 'https://llm.corp.example/v1' }));
    await chatOnce(new OpenAiTransport({ apiKey: 'k', baseUrl: 'https://10.0.0.6/v1' }));

    expect(calls.map((call) => call.dispatcher !== undefined)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it('applies NO_PROXY to every proxy source, including provider-specific proxies', async () => {
    process.env.ALEMBIC_OLLAMA_PROXY_HTTPS = 'http://ollama-proxy:8080';
    process.env.ALEMBIC_AI_PROXY = 'http://ai-proxy:8080';
    process.env.NO_PROXY = 'localhost';
    const calls = stubFetch();

    await chatOnce(new OpenAiTransport({ baseUrl: 'http://localhost:11434/v1' }, 'ollama'));
    await chatOnce(new OpenAiTransport({ apiKey: 'k', baseUrl: 'http://localhost:8000/v1' }));
    await chatOnce(new OpenAiTransport({ baseUrl: 'http://gpu-box:11434/v1' }, 'ollama'));

    expect(calls.map((call) => call.dispatcher !== undefined)).toEqual([false, false, true]);
    expect(__testingProxyDispatcherCache.keys()).toEqual(['http://ollama-proxy:8080']);
  });

  it('keeps the proxy and records a miss when NO_PROXY does not match or the target is unparseable', async () => {
    process.env.HTTPS_PROXY = 'http://user:secret@proxy:8080';
    process.env.NO_PROXY = 'localhost';
    const calls = stubFetch();
    const transport = new OpenAiTransport({ apiKey: 'k' });

    await chatOnce(transport);
    await fetchDirect(transport, '/relative/path');

    expect(calls.map((call) => call.dispatcher !== undefined)).toEqual([true, true]);
    expect(debugMessages).toContainEqual(
      expect.stringContaining(
        'proxy_not_bypassed provider=openai host=api.openai.com reason=no_proxy_miss'
      )
    );
    expect(debugMessages).toContainEqual(
      expect.stringContaining('proxy_not_bypassed provider=openai reason=unparsed_target')
    );
    // 诊断只记录 host，不回显代理凭据或请求路径。
    expect(debugMessages.some((message) => message.includes('secret'))).toBe(false);
    expect(debugMessages.some((message) => message.includes('/relative/path'))).toBe(false);
  });

  it('routes Request inputs by their own URL and still honours cancellation on the direct path', async () => {
    process.env.HTTPS_PROXY = 'http://proxy:8080';
    process.env.NO_PROXY = 'localhost';
    const calls = stubFetch();
    const transport = new OpenAiTransport({}, 'ollama');

    await fetchDirect(transport, new Request('http://localhost:11434/v1/models'));
    await fetchDirect(transport, new URL('http://localhost:11434/v1/models'));
    expect(calls.map((call) => call.dispatcher)).toEqual([undefined, undefined]);

    const aborted = new AbortController();
    aborted.abort(new Error('fixture cancel'));
    await expect(
      (
        transport as unknown as {
          fetchWithProxy(url: string, options?: RequestInit): Promise<Response>;
        }
      ).fetchWithProxy('http://localhost:11434/v1/models', { signal: aborted.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toHaveLength(2);
  });
});
