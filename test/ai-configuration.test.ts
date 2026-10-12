import Logger from '@alembic/core/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  autoDetectProvider,
  createEmbedProvider,
  createProvider,
  getAvailableFallbacks,
  getProviderWithFallback,
} from '../src/ai/AiFactory.js';
import type { AiProvider } from '../src/ai/AiProvider.js';
import { normalizeOllamaBaseUrl, resolveConnection } from '../src/ai/configuration.js';
import { LLMGateway } from '../src/ai/gateway/LLMGateway.js';
import { ClaudeProvider } from '../src/ai/providers/ClaudeProvider.js';
import { DeepSeekProvider } from '../src/ai/providers/DeepSeekProvider.js';
import { GoogleGeminiProvider } from '../src/ai/providers/GoogleGeminiProvider.js';
import { OllamaProvider } from '../src/ai/providers/OllamaProvider.js';
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
  it.each([
    { name: 'OpenAI provider', create: () => new OpenAiProvider({ maxConcurrency: 0 }) },
    { name: 'Google provider', create: () => new GoogleGeminiProvider({ maxConcurrency: 0 }) },
    { name: 'gateway', create: () => new LLMGateway({ maxConcurrency: 0 }) },
    {
      name: 'reliability controller',
      create: () => new ReliabilityController({ maxConcurrency: 0 }),
    },
  ])('preserves invalid concurrency classification when $name logging fails', ({ create }) => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => {
      throw new Error('fixture log failure');
    });
    expect(create).toThrow(
      expect.objectContaining({
        code: 'LLM_INVALID_REQUEST',
        message: expect.stringContaining('maxConcurrency'),
      })
    );
  });

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

  // 与上面的并发校验同口径：非法重试上限/熔断阈值由 ReliabilityController 统一拒绝。
  // facade 与 Gateway 的控制器在首个请求时懒构造，因此在任何 HTTP 发出前以同一错误码拒绝；
  // facade 不再把 circuitThreshold=0 静默改成 5（U06-F1 探针 d）。
  it.each([
    { field: 'maxRetries', value: 1.5 },
    { field: 'maxRetries', value: Number.NaN },
    { field: 'circuitThreshold', value: Number.NaN },
    { field: 'circuitThreshold', value: 0 },
  ] as const)('rejects invalid $field=$value before any provider request is dispatched', async ({
    field,
    value,
  }) => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ choices: [{ index: 0, message: { content: 'unexpected' } }] })
    );
    vi.stubGlobal('fetch', fetchMock);
    const option = field === 'maxRetries' ? { maxRetries: value } : { circuitThreshold: value };
    const invalid = {
      code: 'LLM_INVALID_REQUEST',
      message: expect.stringContaining(field),
    };
    expect(() => new ReliabilityController(option)).toThrow(expect.objectContaining(invalid));
    await expect(
      new OpenAiProvider({ apiKey: 'fixture-key', ...option }).chat('ping')
    ).rejects.toMatchObject(invalid);
    await expect(
      new LLMGateway({ providers: { openai: { apiKey: 'fixture-key' } }, ...option }).chat({
        modelRef: 'openai:gpt-4o',
        prompt: 'ping',
      })
    ).rejects.toMatchObject(invalid);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports invalid reliability options by field and source only, even when logging fails', async () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ choices: [{ index: 0, message: { content: 'x' } }] }))
    );
    // 无 onLog 的直接构造落到 Core Logger；Gateway 经自身日志桥落到同一 Logger，标签为 provider。
    expect(() => new ReliabilityController({ circuitThreshold: 0 })).toThrow(/circuitThreshold/);
    await expect(
      new LLMGateway({ providers: { openai: { apiKey: 'fixture-key' } }, maxRetries: -7 }).chat({
        modelRef: 'openai:gpt-4o',
        prompt: 'ping',
      })
    ).rejects.toMatchObject({ code: 'LLM_INVALID_REQUEST' });
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages).toContain(
      '[reliability] llm invalid_option field=circuitThreshold source=config; rejected before dispatch'
    );
    expect(messages).toContain(
      '[reliability] openai invalid_option field=maxRetries source=config; rejected before dispatch'
    );
    expect(messages.some((message) => message.includes('-7'))).toBe(false);

    warn.mockImplementation(() => {
      throw new Error('fixture log failure');
    });
    expect(() => new ReliabilityController({ maxRetries: 1.5 })).toThrow(
      expect.objectContaining({
        code: 'LLM_INVALID_REQUEST',
        message: expect.stringContaining('maxRetries'),
      })
    );
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

  // 直接构造 Gateway 且未显式给 maxConcurrency 时，每个 provider 按自己的默认值与环境变量解析
  // （与 AiProvider facade 同一口径）：Google 默认 2 并尊重 ALEMBIC_GEMINI_MAX_CONCURRENCY，
  // 其他 provider 不受 Gemini 变量影响；显式值对所有 provider 生效；上限在构造时冻结。
  it.each([
    { gemini: undefined, global: undefined, explicit: undefined, google: 2, openai: 4 },
    { gemini: '3', global: undefined, explicit: undefined, google: 3, openai: 4 },
    { gemini: undefined, global: '1', explicit: undefined, google: 1, openai: 1 },
    { gemini: '3', global: '1', explicit: undefined, google: 3, openai: 1 },
    { gemini: '3', global: '1', explicit: 5, google: 5, openai: 5 },
  ])('resolves gateway concurrency per provider (gemini=$gemini global=$global explicit=$explicit)', async ({
    gemini,
    global,
    explicit,
    google,
    openai,
  }) => {
    vi.stubEnv('ALEMBIC_GEMINI_MAX_CONCURRENCY', gemini);
    vi.stubEnv('ALEMBIC_AI_MAX_CONCURRENCY', global);
    const gateway = new LLMGateway({
      providers: { google: { apiKey: 'fixture-key' }, openai: { apiKey: 'fixture-key' } },
      maxRetries: 0,
      ...(explicit === undefined ? {} : { maxConcurrency: explicit }),
    });
    vi.stubEnv('ALEMBIC_GEMINI_MAX_CONCURRENCY', '9');
    vi.stubEnv('ALEMBIC_AI_MAX_CONCURRENCY', '9');
    const active = { google: 0, openai: 0 };
    const peak = { google: 0, openai: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        const provider = String(url).includes('generativelanguage') ? 'google' : 'openai';
        peak[provider] = Math.max(peak[provider], ++active[provider]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active[provider]--;
        return provider === 'google'
          ? jsonResponse({
              candidates: [
                { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' },
              ],
            })
          : jsonResponse({ choices: [{ index: 0, message: { content: 'ok' } }] });
      })
    );
    await Promise.all([
      ...Array.from({ length: 6 }, () =>
        gateway.chat({ modelRef: 'google:gemini-3-flash-preview', prompt: 'ping' })
      ),
      ...Array.from({ length: 6 }, () =>
        gateway.chat({ modelRef: 'openai:gpt-4o', prompt: 'ping' })
      ),
    ]);
    expect(peak).toEqual({ google, openai });
  });

  it('rejects an invalid Gemini concurrency variable at gateway construction unless a limit is explicit', () => {
    vi.stubEnv('ALEMBIC_GEMINI_MAX_CONCURRENCY', 'invalid');
    expect(() => new LLMGateway()).toThrow(
      expect.objectContaining({
        code: 'LLM_INVALID_REQUEST',
        message: expect.stringContaining('maxConcurrency'),
      })
    );
    // 显式上限不读取环境变量，因此不受该环境值影响（facade 路径即如此）。
    expect(() => new LLMGateway({ maxConcurrency: 2 })).not.toThrow();
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

  // Gateway 构造时仍冻结全部 provider 的连接，但只对显式配置的 provider 立即输出配置告警；
  // 未配置的 provider 的告警延后到它真正创建 Transport 时输出一次，不丢失也不刷屏。
  it('reports an OpenAI style warning only for gateways that actually use OpenAI', async () => {
    vi.stubEnv('ALEMBIC_OPENAI_API_STYLE', 'bad-style');
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const styleWarnings = () =>
      warn.mock.calls
        .map((call) => String(call[0]))
        .filter((msg) => msg.includes('invalid_api_style provider=openai'));

    await new DeepSeekProvider({ apiKey: 'fixture-key' })._getGateway();
    expect(styleWarnings()).toEqual([]);

    await new OpenAiProvider({ apiKey: 'fixture-key' })._getGateway();
    expect(styleWarnings()).toHaveLength(1);
  });

  it('defers configuration warnings for an unconfigured provider until its first request', async () => {
    vi.stubEnv('ALEMBIC_OPENAI_API_KEY', 'fixture-key');
    vi.stubEnv('ALEMBIC_OPENAI_API_STYLE', 'bad-style');
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const styleWarnings = () =>
      warn.mock.calls
        .map((call) => String(call[0]))
        .filter((msg) => msg.includes('invalid_api_style provider=openai'));
    const gateway = new LLMGateway({
      providers: { deepseek: { apiKey: 'fixture-key' } },
      maxRetries: 0,
    });
    expect(styleWarnings()).toEqual([]);
    // 构造后再改环境不能影响已冻结的连接（仍按 chat 协议发出）。
    vi.stubEnv('ALEMBIC_OPENAI_API_STYLE', 'responses');
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        urls.push(String(url));
        return jsonResponse({ choices: [{ index: 0, message: { content: 'ok' } }] });
      })
    );
    await gateway.chat({ modelRef: 'openai:gpt-5.5', prompt: 'ping' });
    await gateway.chat({ modelRef: 'openai:gpt-5.5', prompt: 'ping' });
    expect(urls.every((url) => url.endsWith('/chat/completions'))).toBe(true);
    expect(styleWarnings()).toHaveLength(1);
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

// provider 身份解析边界：'auto' 在发现/投影中表示“未指定”，构造入口必须与之一致；
// 未知身份要带稳定 code 并留下 [ai-config] 诊断，宿主才能定位拼写错误等启动失败。
describe('provider identity resolution boundary', () => {
  const messages = (spy: { mock: { calls: unknown[][] } }, marker: string) =>
    spy.mock.calls.map((call) => String(call[0])).filter((msg) => msg.includes(marker));

  it('lets createProvider() discover the provider when ALEMBIC_AI_PROVIDER=auto instead of rejecting the identity', () => {
    vi.stubEnv('ALEMBIC_AI_PROVIDER', 'auto');
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);

    // 无任何凭据：抛宿主可识别的未配置错误，而不是把 'auto' 当成未知 provider。
    let missing: unknown;
    try {
      createProvider();
    } catch (err: unknown) {
      missing = err;
    }
    expect(missing).toBeInstanceOf(Error);
    expect(missing).toMatchObject({
      code: 'API_KEY_MISSING',
      provider: 'auto',
      hostAction: 'configure-provider-credential',
    });
    expect((missing as Error).message).not.toMatch(/Unknown AI provider/);
    expect(messages(warn, 'auto_provider_unconfigured')).toHaveLength(1);
    expect(messages(warn, 'unknown_provider')).toEqual([]);

    // 有凭据：与 autoDetectProvider 得出同一身份；显式 model / provider 仍优先。
    vi.stubEnv('ALEMBIC_OPENAI_API_KEY', 'fixture-openai-key');
    const discovered = createProvider();
    expect(discovered).toBeInstanceOf(OpenAiProvider);
    expect(discovered.model).toBe(autoDetectProvider()?.model);
    expect(createProvider({ model: 'explicit-model' }).model).toBe('explicit-model');
    expect(createProvider({ provider: 'deepseek' })).toBeInstanceOf(DeepSeekProvider);
  });

  it('treats ALEMBIC_EMBED_PROVIDER=auto as no dedicated embedding provider', () => {
    vi.stubEnv('ALEMBIC_EMBED_PROVIDER', 'auto');
    vi.stubEnv('ALEMBIC_OPENAI_API_KEY', 'fixture-openai-key');
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);

    expect(createEmbedProvider()).toBeNull();
    expect(messages(debug, '[ai-config] embed_provider_auto_ignored')).toHaveLength(1);
    expect(messages(warn, 'unknown_provider')).toEqual([]);
  });

  it('rejects an unknown provider identity with a stable code after a truncated unknown_provider diagnostic', async () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const rejected = (message: string) =>
      expect.objectContaining({ code: 'LLM_INVALID_REQUEST', message });

    // 环境拼写错误：工厂与自动发现两条宿主入口都带 code，并记录来源 env。
    vi.stubEnv('ALEMBIC_AI_PROVIDER', 'openia');
    expect(() => createProvider()).toThrow(rejected('Unknown AI provider: openia'));
    expect(() => autoDetectProvider()).toThrow(rejected('Unknown AI provider: openia'));
    expect(messages(warn, '[ai-config] unknown_provider source=env value=openia')).toHaveLength(2);
    vi.stubEnv('ALEMBIC_AI_PROVIDER', undefined);

    // 独立 embedding 身份同样来自环境。
    vi.stubEnv('ALEMBIC_EMBED_PROVIDER', 'openia');
    expect(() => createEmbedProvider()).toThrow(rejected('Unknown AI provider: openia'));
    expect(
      messages(warn, 'unknown_provider source=env value=openia var=ALEMBIC_EMBED_PROVIDER')
    ).toHaveLength(1);
    vi.stubEnv('ALEMBIC_EMBED_PROVIDER', undefined);

    // 调用方显式身份：来源为 config；Gateway 的 provider 前缀解析共用同一边界。
    expect(() => createProvider({ provider: 'constructor' })).toThrow(
      rejected('Unknown AI provider: constructor')
    );
    expect(() => createProvider({ provider: 42 })).toThrow(
      rejected('Unknown AI provider: (invalid type)')
    );
    await expect(
      new LLMGateway({ maxRetries: 0 }).chat({ modelRef: 'unknown:model', prompt: 'ping' })
    ).rejects.toMatchObject({ code: 'LLM_INVALID_REQUEST' });
    expect(messages(warn, 'unknown_provider source=config value=constructor')).toHaveLength(1);
    expect(messages(warn, 'unknown_provider source=config value=(invalid type)')).toHaveLength(1);
    expect(messages(warn, 'unknown_provider source=config value=unknown')).toHaveLength(1);

    // 误填的长值只写截断后的前缀，避免把整段可能的凭据写进日志；错误消息文本保持既有合同。
    const misplaced = 'fixture-misplaced-credential-value';
    expect(() => createProvider({ provider: misplaced })).toThrow(
      rejected(`Unknown AI provider: ${misplaced}`)
    );
    const truncated = messages(warn, 'unknown_provider source=config value=fixture-misplace');
    expect(truncated).toHaveLength(1);
    expect(truncated[0]).not.toContain('credential');

    // 诊断通道失败不能改变错误归类。
    warn.mockImplementation(() => {
      throw new Error('fixture log failure');
    });
    expect(() => createProvider({ provider: 'openia' })).toThrow(
      rejected('Unknown AI provider: openia')
    );
  });
});

// 凭据口径边界：detectProvider/availableFallbacks/aiConfigInfo 用 trim 后的值判断 key 是否存在，
// 请求路径（resolveConnection）必须同口径，否则纯空白 key 会绕过 API_KEY_MISSING 变成上游 401。
describe('API key whitespace normalization', () => {
  const trimLogs = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls
      .map((call) => String(call[0]))
      .filter((msg) => msg.includes('[ai-config] api_key_whitespace_trimmed'));

  it('treats a whitespace-only environment key as missing and rejects with API_KEY_MISSING before any request', async () => {
    vi.stubEnv('ALEMBIC_OPENAI_API_KEY', ' \t  ');
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ choices: [{ index: 0, message: { content: 'unexpected' } }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    // 与发现路径同口径：纯空白等于未配置。
    expect(resolveConnection('openai').apiKey).toBe('');
    await expect(
      createProvider({ provider: 'openai', maxRetries: 0 }).chat('ping')
    ).rejects.toMatchObject({ code: 'API_KEY_MISSING' });
    await expect(
      new LLMGateway({ providers: { openai: {} }, maxRetries: 0 }).chat({
        modelRef: 'openai:gpt-4o',
        prompt: 'ping',
      })
    ).rejects.toMatchObject({ code: 'API_KEY_MISSING' });
    expect(fetchMock).not.toHaveBeenCalled();
    const logs = trimLogs(debug);
    expect(logs.length).toBeGreaterThan(0);
    expect(
      logs.every((msg) =>
        msg.includes(
          'api_key_whitespace_trimmed provider=openai source=env var=ALEMBIC_OPENAI_API_KEY result=missing'
        )
      )
    ).toBe(true);
  });

  it('trims surrounding whitespace from environment and explicit keys before the request and logs without the value', async () => {
    vi.stubEnv('ALEMBIC_OPENAI_API_KEY', '  fixture-padded-env-key\t');
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ choices: [{ index: 0, message: { content: 'ok' } }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(resolveConnection('openai').apiKey).toBe('fixture-padded-env-key');
    await expect(createProvider({ provider: 'openai', maxRetries: 0 }).chat('ping')).resolves.toBe(
      'ok'
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer fixture-padded-env-key'
    );

    expect(resolveConnection('openai', { apiKey: ' fixture-padded-explicit-key ' }).apiKey).toBe(
      'fixture-padded-explicit-key'
    );
    await expect(
      createProvider({
        provider: 'openai',
        apiKey: ' fixture-padded-explicit-key ',
        maxRetries: 0,
      }).chat('ping')
    ).resolves.toBe('ok');
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
      'Bearer fixture-padded-explicit-key'
    );

    const logs = trimLogs(debug);
    expect(logs.some((msg) => msg.includes('provider=openai source=env'))).toBe(true);
    expect(logs.some((msg) => msg.includes('provider=openai source=config'))).toBe(true);
    expect(logs.every((msg) => msg.includes('result=trimmed'))).toBe(true);
    // 诊断只写 provider/来源/结果，不能写出 key 值。
    expect(logs.join('\n')).not.toContain('fixture-padded');
  });

  it('keeps an explicit empty or whitespace-only key as explicitly disabled instead of inheriting the environment key', async () => {
    vi.stubEnv('ALEMBIC_OPENAI_API_KEY', 'fixture-ambient-key');
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ choices: [{ index: 0, message: { content: 'unexpected' } }] })
    );
    vi.stubGlobal('fetch', fetchMock);

    for (const apiKey of ['', '   ']) {
      expect(resolveConnection('openai', { apiKey }).apiKey).toBe('');
      await expect(
        createProvider({ provider: 'openai', apiKey, maxRetries: 0 }).chat('ping')
      ).rejects.toMatchObject({ code: 'API_KEY_MISSING' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    // 显式空串本身不触发 trim 诊断；显式纯空白记录为显式禁用。
    const logs = trimLogs(debug);
    expect(logs.length).toBeGreaterThan(0);
    expect(
      logs.every((msg) =>
        msg.includes(
          'api_key_whitespace_trimmed provider=openai source=config result=explicit_disabled'
        )
      )
    ).toBe(true);
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
