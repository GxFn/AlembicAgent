import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  autoDetectProvider,
  createEmbedProvider,
  createProvider,
  getAvailableFallbacks,
  getProviderWithFallback,
} from '../src/ai/AiFactory.js';
import type { AiProvider } from '../src/ai/AiProvider.js';
import { LLMGateway } from '../src/ai/gateway/LLMGateway.js';
import { ClaudeProvider } from '../src/ai/providers/ClaudeProvider.js';
import { DeepSeekProvider } from '../src/ai/providers/DeepSeekProvider.js';
import { GoogleGeminiProvider } from '../src/ai/providers/GoogleGeminiProvider.js';
import { normalizeOllamaBaseUrl, OllamaProvider } from '../src/ai/providers/OllamaProvider.js';
import { OpenAiProvider } from '../src/ai/providers/OpenAiProvider.js';
import { ReliabilityController } from '../src/ai/shared/reliability.js';
import { GoogleTransport } from '../src/ai/transport/GoogleTransport.js';
import { OpenAiTransport } from '../src/ai/transport/OpenAiTransport.js';
import { jsonResponse } from './helpers/mockFetch.js';

beforeEach(() => {
  // 只隔离配置，不读取/打印本机凭据；所有 HTTP 都由受控 fixture 接管。
  for (const key of Object.keys(process.env)) {
    if (/^ALEMBIC_(AI_|EMBED_|OPENAI_|GOOGLE_|GEMINI_|CLAUDE_|DEEPSEEK_|OLLAMA_)/.test(key)) {
      vi.stubEnv(key, undefined);
    }
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('effective AI connection configuration', () => {
  it('does not invent reasoning metadata for providers that do not use the DeepSeek adapter option', () => {
    for (const Provider of [OpenAiProvider, GoogleGeminiProvider, ClaudeProvider, OllamaProvider]) {
      expect(new Provider()._transportExtras).not.toHaveProperty('reasoningEffort');
    }
    expect(new DeepSeekProvider({ reasoningEffort: 'max' })._transportExtras).toMatchObject({
      reasoningEffort: 'max',
    });
  });

  it.each([
    'apiKey',
    'baseUrl',
    'model',
    'embedModel',
    'apiStyle',
    'reasoningEffort',
  ])('rejects malformed %s input without exposing its contents', (field) => {
    const input = { confidential: 'fixture-private-value' };
    let error: unknown;
    try {
      createProvider({ provider: 'openai', [field]: input });
    } catch (err: unknown) {
      error = err;
    }
    expect(error).toMatchObject({ code: 'LLM_INVALID_REQUEST' });
    expect((error as Error).message).toContain(field);
    expect((error as Error).message).not.toContain('fixture-private-value');
  });

  it('preserves facade reliability and local-host defaults', () => {
    expect(new OllamaProvider().baseUrl).toBe('http://localhost:11434/v1');
    for (const Provider of [
      OpenAiProvider,
      GoogleGeminiProvider,
      DeepSeekProvider,
      OllamaProvider,
    ]) {
      const provider = new Provider();
      expect(provider.timeout).toBe(300_000);
      expect(provider.maxRetries).toBe(3);
    }
    expect(new ClaudeProvider().maxRetries).toBe(0);
    expect(new ClaudeProvider({ maxRetries: 2 }).maxRetries).toBe(2);
  });

  it('preserves the DeepSeek public endpoint receipt while joining the embedding path once', async () => {
    const endpoint = 'https://relay.example.invalid/v1/';
    vi.stubEnv('ALEMBIC_DEEPSEEK_BASE_URL', endpoint);
    const provider = new DeepSeekProvider({ apiKey: 'fixture-key', maxRetries: 0 });
    // Main 的严格配置回执按原字符串比较这个公开字段，不能改变其语义。
    expect(provider.baseUrl).toBe(endpoint);
    let requestedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        requestedUrl = String(url);
        return jsonResponse({ data: [{ index: 0, embedding: [1, 2] }] });
      })
    );
    await expect(provider.embed('text')).resolves.toEqual([1, 2]);
    expect(requestedUrl).toBe('https://relay.example.invalid/v1/embeddings');
  });

  it('resolves a known provider alias at the gateway and rejects unknown explicit identities', async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        requested.push(String(url));
        return jsonResponse({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' },
          ],
        });
      })
    );
    const gateway = new LLMGateway({
      providers: { google: { apiKey: 'fixture-key' } },
      maxRetries: 0,
    });
    await expect(
      gateway.chat({ modelRef: 'gemini:gemini-2.5-flash', prompt: 'ping' })
    ).resolves.toBe('ok');
    expect(requested[0]).toContain('/v1beta/models/gemini-2.5-flash:generateContent');
    requested.length = 0;
    await expect(gateway.chat({ modelRef: 'unknown:model', prompt: 'ping' })).rejects.toThrow(
      /Unknown AI provider/
    );
    expect(requested).toEqual([]);
  });

  it.each([
    'not-a-number',
    'Infinity',
    '1.5',
    0,
  ] as const)('rejects invalid concurrency %s before a request can enter an unserviceable queue', (maxConcurrency) => {
    for (const create of [
      () => new OpenAiProvider({ maxConcurrency }),
      () => new GoogleGeminiProvider({ maxConcurrency }),
      () => new LLMGateway({ maxConcurrency }),
      () => new ReliabilityController({ maxConcurrency }),
    ]) {
      expect(create).toThrow(/maxConcurrency/);
    }
  });

  it('validates environment concurrency and freezes a valid gateway limit at construction', async () => {
    vi.stubEnv('ALEMBIC_AI_MAX_CONCURRENCY', 'invalid');
    expect(() => new OpenAiProvider()).toThrow(/maxConcurrency/);
    expect(() => new LLMGateway()).toThrow(/maxConcurrency/);
    vi.stubEnv('ALEMBIC_AI_MAX_CONCURRENCY', '1');
    const gateway = new LLMGateway({
      providers: { openai: { apiKey: 'fixture-key' } },
      maxRetries: 0,
    });
    vi.stubEnv('ALEMBIC_AI_MAX_CONCURRENCY', '9');
    let active = 0;
    let peak = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return jsonResponse({ choices: [{ index: 0, message: { content: 'ok' } }] });
      })
    );
    await Promise.all(
      [1, 2, 3].map(() => gateway.chat({ modelRef: 'openai:gpt-4o', prompt: 'ping' }))
    );
    expect(peak).toBe(1);
  });

  it.each([
    'provider',
    'gateway',
    'transport',
  ] as const)('normalizes the Ollama API root consistently at the %s entrypoint', async (entry) => {
    let requestedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        requestedUrl = String(url);
        return jsonResponse({ choices: [{ index: 0, message: { content: 'ok' } }] });
      })
    );
    const config = { baseUrl: 'http://localhost:11434', apiKey: 'fixture-key' };
    if (entry === 'provider') {
      await new OllamaProvider(config).chat('ping');
    } else if (entry === 'gateway') {
      await new LLMGateway({ providers: { ollama: config }, maxRetries: 0 }).chat({
        modelRef: 'ollama:llama3',
        prompt: 'ping',
      });
    } else {
      await new OpenAiTransport(config, 'ollama').chat({
        model: 'llama3',
        messages: [{ role: 'user', content: 'ping' }],
      });
    }
    expect(requestedUrl).toBe('http://localhost:11434/v1/chat/completions');
  });

  it.each([
    'provider',
    'gateway',
    'transport',
  ] as const)('normalizes the Google API root consistently at the %s entrypoint', async (entry) => {
    let requestedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        requestedUrl = String(url);
        return jsonResponse({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' },
          ],
        });
      })
    );
    const config = {
      baseUrl: 'https://google.example.invalid',
      apiKey: 'fixture-key',
      model: 'gemini-2.5-flash',
    };
    if (entry === 'provider') {
      await new GoogleGeminiProvider(config).chat('ping');
    } else if (entry === 'gateway') {
      await new LLMGateway({ providers: { google: config }, maxRetries: 0 }).chat({
        modelRef: 'google:gemini-2.5-flash',
        prompt: 'ping',
      });
    } else {
      await new GoogleTransport(config).chat({
        model: config.model,
        messages: [{ role: 'user', content: 'ping' }],
      });
    }
    expect(requestedUrl).toBe(
      'https://google.example.invalid/v1beta/models/gemini-2.5-flash:generateContent'
    );
  });

  it('applies a selected Google model to both direct and factory construction', () => {
    vi.stubEnv('ALEMBIC_AI_PROVIDER', 'gemini');
    vi.stubEnv('ALEMBIC_AI_MODEL', 'configured-gemini-model');
    vi.stubEnv('ALEMBIC_GOOGLE_API_KEY', 'fixture-key');
    expect(new GoogleGeminiProvider().model).toBe('configured-gemini-model');
    expect(autoDetectProvider()?.model).toBe('configured-gemini-model');
    expect(createProvider({ provider: 'google', model: 'explicit-model' }).model).toBe(
      'explicit-model'
    );
  });

  it.each([
    'missing-key',
    'failed-probe',
  ] as const)('uses the fallback provider model after %s instead of the primary model', async (reason) => {
    vi.stubEnv('ALEMBIC_AI_PROVIDER', 'google');
    vi.stubEnv('ALEMBIC_AI_MODEL', 'primary-google-model');
    vi.stubEnv('ALEMBIC_OPENAI_API_KEY', 'fixture-openai-key');
    if (reason === 'failed-probe') {
      vi.stubEnv('ALEMBIC_GOOGLE_API_KEY', 'fixture-google-key');
      vi.spyOn(GoogleGeminiProvider.prototype, 'probe').mockRejectedValue(
        new Error('unsupported region')
      );
    }
    const provider =
      reason === 'missing-key' ? autoDetectProvider() : await getProviderWithFallback();
    expect(provider?.name).toBe('openai');
    expect(provider?.model).toBe('gpt-5.5');
  });

  it('excludes alias identities when listing fallback providers', () => {
    vi.stubEnv('ALEMBIC_GOOGLE_API_KEY', 'fixture-key');
    expect(getAvailableFallbacks('gemini')).toEqual([]);
    expect(() => createProvider({ provider: 'constructor' })).toThrow(/Unknown AI provider/);
  });

  it('uses the embedding model for both the wire request and the host receipt', async () => {
    vi.stubEnv('ALEMBIC_AI_MODEL', 'generation-model');
    vi.stubEnv('ALEMBIC_EMBED_PROVIDER', 'deepseek');
    vi.stubEnv('ALEMBIC_EMBED_MODEL', 'custom-embedding');
    vi.stubEnv('ALEMBIC_EMBED_BASE_URL', 'https://embedding.example.invalid/v1');
    vi.stubEnv('ALEMBIC_EMBED_API_KEY', 'fixture-embedding-key');
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        body = JSON.parse(init.body);
        return jsonResponse({ data: [{ index: 0, embedding: [1, 2] }] });
      })
    );
    const provider = createEmbedProvider();
    expect(provider?.model).toBe('custom-embedding');
    expect(await provider?.embed('text')).toEqual([1, 2]);
    expect(body.model).toBe('custom-embedding');
  });

  it('captures gateway connection and protocol settings before the first lazy request', async () => {
    vi.stubEnv('ALEMBIC_OPENAI_API_KEY', 'fixture-first-key');
    vi.stubEnv('ALEMBIC_OPENAI_BASE_URL', 'https://first.example.invalid/v1');
    vi.stubEnv('ALEMBIC_OPENAI_API_STYLE', 'chat');
    const gateway = new LLMGateway({ maxRetries: 0 });
    vi.stubEnv('ALEMBIC_OPENAI_API_KEY', 'fixture-later-key');
    vi.stubEnv('ALEMBIC_OPENAI_BASE_URL', 'https://later.example.invalid/v1');
    vi.stubEnv('ALEMBIC_OPENAI_API_STYLE', 'responses');
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ choices: [{ index: 0, message: { content: 'ok' } }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(gateway.chat({ modelRef: 'openai:gpt-4o', prompt: 'ping' })).resolves.toBe('ok');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://first.example.invalid/v1/chat/completions'
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer fixture-first-key'
    );
  });

  it.each([
    'provider',
    'gateway',
  ] as const)('keeps an explicitly empty key empty at the %s entrypoint', async (entry) => {
    vi.stubEnv('ALEMBIC_OPENAI_API_KEY', 'fixture-ambient-key');
    const client =
      entry === 'provider'
        ? new OpenAiProvider({ apiKey: '', maxRetries: 0 })
        : new LLMGateway({ providers: { openai: { apiKey: '' } }, maxRetries: 0 });
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ choices: [{ index: 0, message: { content: 'unexpected' } }] })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      client instanceof OpenAiProvider
        ? client.chat('ping')
        : client.chat({ modelRef: 'openai:gpt-4o', prompt: 'ping' })
    ).rejects.toMatchObject({ code: 'API_KEY_MISSING' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses an explicit endpoint with an inherited key instead of the environment endpoint', async () => {
    vi.stubEnv('ALEMBIC_OPENAI_API_KEY', 'fixture-environment-key');
    vi.stubEnv('ALEMBIC_OPENAI_BASE_URL', 'https://environment.example.invalid/v1');
    const calls: { url: string; headers: Headers }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers) });
        return jsonResponse({ choices: [{ index: 0, message: { content: 'ok' } }] });
      })
    );
    const gateway = new LLMGateway({
      providers: { openai: { baseUrl: 'https://explicit.example.invalid/v1' } },
      maxRetries: 0,
    });

    expect(await gateway.chat({ modelRef: 'openai:gpt-4o', prompt: 'ping' })).toBe('ok');
    expect(calls[0]?.url).toBe('https://explicit.example.invalid/v1/chat/completions');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer fixture-environment-key');
  });
});

describe('embedding capacity configuration and public hints', () => {
  it.each([
    ['openai', OpenAiProvider, 4],
    ['google', GoogleGeminiProvider, 2],
    ['deepseek', DeepSeekProvider, 4],
    ['claude', ClaudeProvider, 4],
    ['ollama', OllamaProvider, 4],
  ] as const)('%s preserves defaults, precedence, source and the live gate value', (provider, Provider, defaultLimit) => {
    for (const [config, global, google, expected, source] of [
      [undefined, undefined, undefined, defaultLimit, 'conservative-default'],
      [undefined, '3', undefined, 3, 'environment'],
      [undefined, '3', '6', provider === 'google' ? 6 : 3, 'environment'],
      ['7', '3', '6', 7, 'provider-config'],
    ] as const) {
      vi.stubEnv('ALEMBIC_AI_MAX_CONCURRENCY', global);
      vi.stubEnv('ALEMBIC_GEMINI_MAX_CONCURRENCY', google);
      const instance = new Provider({ apiKey: 'fixture-key', maxConcurrency: config });
      const hint = instance.getEmbeddingCapacityHint();
      expect(hint).toEqual({ provider, maxInFlightEmbeddings: expected, source });
      expect(hint.maxInFlightEmbeddings).toBe(instance._maxConcurrency);
      expect(Object.isFrozen(hint)).toBe(true);
      expect(instance.getEmbeddingCapacityHint()).toEqual(hint);
    }
  });

  it('stays reachable on the exact object shape Core BatchEmbedder receives', () => {
    const provider: { embed(text: string | string[]): Promise<number[] | number[][]> } =
      new OpenAiProvider({ apiKey: 'fixture-key' });
    expect(typeof (provider as AiProvider).getEmbeddingCapacityHint).toBe('function');
    expect((provider as AiProvider).getEmbeddingCapacityHint().maxInFlightEmbeddings).toBe(4);
  });
});

describe('public Ollama root compatibility helper', () => {
  it.each([
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434/v1', true],
    ['http://localhost:11434/', 'http://localhost:11434/v1', true],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1', false],
    ['http://localhost:11434/v1/', 'http://localhost:11434/v1', false],
    ['https://gw.example.invalid/ollama/v1', 'https://gw.example.invalid/ollama/v1', false],
    ['https://gw.example.invalid/custom-openai', 'https://gw.example.invalid/custom-openai', false],
    ['not-a-url', 'not-a-url', false],
  ])('preserves the established rule for %s', (raw, normalized, logs) => {
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    expect(normalizeOllamaBaseUrl(String(raw), logger)).toBe(normalized);
    expect(logger.info).toHaveBeenCalledTimes(logs ? 1 : 0);
  });
});
