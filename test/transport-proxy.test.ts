import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenAiTransport } from '../src/ai/transport/OpenAiTransport.js';

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
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'via-proxy' } }] }),
        text: async () => '',
      } as Response;
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
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'direct' } }] }),
        text: async () => '',
      } as Response;
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
});
