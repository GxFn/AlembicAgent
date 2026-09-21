import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLLMGateway, LLMGateway, resetLLMGateway } from '../src/ai/gateway/LLMGateway.js';
import { ClaudeTransport } from '../src/ai/transport/ClaudeTransport.js';
import { LLMTransport, type TransportRequest } from '../src/ai/transport/LLMTransport.js';
import { OpenAiTransport } from '../src/ai/transport/OpenAiTransport.js';
import { jsonResponse } from './helpers/mockFetch.js';

function stubFetch(response: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(response))
  );
}

describe('LLMGateway horizontal capabilities', () => {
  it.each([
    'sync',
    'async',
    'thenable',
  ])('isolates a %s usage observer without losing a completed response or replaying HTTP', async (mode) => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    stubFetch({
      choices: [{ index: 0, message: { content: 'confirmed reply' } }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
    const failure = new Error('private observer payload');
    const onUsage = vi.fn(() => {
      if (mode === 'async') {
        return Promise.reject(failure);
      }
      if (mode === 'thenable') {
        // biome-ignore lint/suspicious/noThenProperty: PromiseLike observer fixture must exercise non-Promise assimilation.
        return { then: (_resolve: unknown, reject: (error: Error) => void) => reject(failure) };
      }
      throw failure;
    });
    const gateway = new LLMGateway({
      providers: { openai: { apiKey: 'test-key' } },
      maxRetries: 1,
      onUsage,
    });
    expect(await gateway.chat({ modelRef: 'openai:gpt-4o', prompt: 'hello' })).toBe(
      'confirmed reply'
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 5, outputTokens: 3 })
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('usage_observer_failed'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private observer payload');
  });

  // Main 不再维护第二套 SDK/transport 单测；保留原有独特合同到其实现仓库。
  it.each([
    ['openai:gpt-5.5', 'openai', 'gpt-5.5'],
    ['claude:claude-sonnet-4-6', 'claude', 'claude-sonnet-4-6'],
    ['deepseek:deepseek-v4-flash', 'deepseek', 'deepseek-v4-flash'],
    ['google:gemini-3-flash-preview', 'google', 'gemini-3-flash-preview'],
    ['gpt-5.5', 'openai', 'gpt-5.5'],
    ['claude-sonnet-4-6', 'claude', 'claude-sonnet-4-6'],
    ['openai:custom-model', 'openai', 'custom-model'],
    ['custom-unregistered', 'openai', 'custom-unregistered'],
  ])('resolves %s without a network request', (modelRef, provider, apiModelId) => {
    expect(new LLMGateway().getModelDef(modelRef)).toMatchObject({ provider, apiModelId });
  });

  it.each([
    'llama3',
    'qwen2',
  ])('uses the registered provider for the bare model %s', async (modelRef) => {
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        requests.push(String(url));
        return jsonResponse({ choices: [{ index: 0, message: { content: 'done' } }] });
      })
    );
    const gateway = new LLMGateway({
      providers: {
        ollama: { apiKey: 'fixture-key', baseUrl: 'http://ollama.example.invalid/v1' },
        openai: { apiKey: 'fixture-key', baseUrl: 'https://wrong-route.example.invalid/v1' },
      },
      maxRetries: 0,
    });
    expect(await gateway.chat({ modelRef, prompt: 'hello' })).toBe('done');
    expect(requests).toEqual(['http://ollama.example.invalid/v1/chat/completions']);
    expect(gateway.getModelDef(modelRef).provider).toBe('ollama');
  });

  it.each([
    { Transport: OpenAiTransport, provider: 'openai', model: 'gpt-5.5' },
    { Transport: ClaudeTransport, provider: 'claude', model: 'claude-sonnet-4-6' },
  ])('rejects explicitly empty $provider credentials before HTTP', async ({
    Transport,
    provider,
    model,
  }) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const transport = new Transport({ apiKey: '' });
    expect(transport.providerId).toBe(provider);
    await expect(
      transport.chat({ model, messages: [{ role: 'user', content: 'ping' }] })
    ).rejects.toThrow('API Key');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('filters model parameters before the native Anthropic request', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return jsonResponse({
          id: 'msg-fixture',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      })
    );
    const gateway = new LLMGateway({
      providers: { claude: { apiKey: 'fixture-key' } },
      maxRetries: 0,
    });
    const result = await gateway.chatWithTools({
      modelRef: 'claude:claude-opus-4-7',
      messages: [{ role: 'user', content: 'ping' }],
      temperature: 0.9,
    });
    expect(body.temperature).toBeUndefined();
    expect(result).toMatchObject({ text: 'done', usage: { inputTokens: 10, outputTokens: 5 } });
  });

  it('forwards the guard replacement for an invalid effort to the real SDK request', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return jsonResponse({ choices: [{ index: 0, message: { content: 'done' } }] });
      })
    );
    const gateway = new LLMGateway({
      providers: { openai: { apiKey: 'fixture-key' } },
      maxRetries: 0,
    });
    const model = gateway.getModelDef('openai:gpt-5.5');
    await gateway.chatWithTools({
      modelRef: model.id,
      messages: [{ role: 'user', content: 'hello' }],
      reasoningEffort: 'invalid-effort',
      temperature: 5,
      maxTokens: model.maxOutputTokens + 1,
    });
    expect(body.reasoning_effort).toBe(model.reasoning.defaultEffort);
    expect(body.max_completion_tokens).toBe(model.maxOutputTokens);
  });

  it('stops provider fallback when the caller cancels the probe chain', async () => {
    stubFetch({ choices: [{ index: 0, message: { content: 'ok' } }] });
    const controller = new AbortController();
    controller.abort(new Error('probe cancelled'));
    const gateway = new LLMGateway({
      providers: { openai: { apiKey: 'test-key' } },
      maxRetries: 0,
    });
    await expect(
      gateway.resolveWithFallback(['openai:gpt-4o', 'openai:gpt-4o-mini'], {
        abortSignal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    'chat',
    'chatStructured',
    'chatWithTools',
  ] as const)('records usage once for %s while retaining JSON mode', async (method) => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        body = JSON.parse(options.body);
        return jsonResponse({
          choices: [{ index: 0, message: { content: '{"value":42}' } }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        });
      })
    );
    const onUsage = vi.fn();
    const gateway = new LLMGateway({ providers: { openai: { apiKey: 'test-key' } }, onUsage });
    const request = { modelRef: 'openai:gpt-4o', prompt: 'json', usageSource: method };
    if (method === 'chatWithTools') {
      await gateway.chatWithTools({ ...request, messages: [{ role: 'user', content: 'json' }] });
    } else {
      await gateway[method](request);
    }
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 5,
        outputTokens: 3,
        source: method,
        provider: 'openai',
        model: 'gpt-4o',
      })
    );
    expect(body.response_format).toEqual(
      method === 'chatStructured' ? { type: 'json_object' } : undefined
    );
  });
  it('applies the global timeout even when provider credentials are explicit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true }
            );
          })
      )
    );
    const gateway = new LLMGateway({
      providers: { openai: { apiKey: 'test-key', timeout: 200 } },
      timeout: 5,
      maxRetries: 0,
    });
    await expect(gateway.chat({ modelRef: 'openai:gpt-4o', prompt: 'hello' })).rejects.toThrow(
      'after 5ms'
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetLLMGateway();
  });

  it('preserves provider-prefixed model ids after the first colon', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
        return jsonResponse({
          choices: [{ index: 0, message: { content: 'done' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      })
    );

    const gateway = new LLMGateway({
      providers: { ollama: { apiKey: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' } },
    });

    await gateway.chatWithTools({
      modelRef: 'ollama:gemma3:4b',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64,
    });

    expect(requestBodies[0]?.model).toBe('gemma3:4b');
  });

  it('chatStructured robustly extracts JSON wrapped in markdown fences', async () => {
    stubFetch({
      choices: [{ index: 0, message: { content: '```json\n{"value": 42}\n```' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const gateway = new LLMGateway({ providers: { openai: { apiKey: 'k' } } });
    const result = await gateway.chatStructured({
      modelRef: 'openai:gpt-4o',
      prompt: 'give json',
      maxTokens: 64,
    });
    expect(result).toEqual({ value: 42 });
  });

  it('rebuilds the singleton when a new config is provided', () => {
    const g1 = getLLMGateway({ providers: { openai: { apiKey: 'a' } } });
    const g2 = getLLMGateway({ providers: { openai: { apiKey: 'b' } } });
    expect(g2).not.toBe(g1);
    expect(getLLMGateway()).toBe(g2);
  });
});

describe('LLMTransport explicit legacy defaults', () => {
  class LocalTransport extends LLMTransport {
    request?: TransportRequest;
    constructor(private readonly reply: string) {
      super('openai', { apiKey: '' });
    }
    async chat(request: TransportRequest) {
      this.request = request;
      return this.reply;
    }
    async chatWithTools() {
      return { text: this.reply, functionCalls: null, usage: null };
    }
  }

  it.each([
    { reply: '{"value":42}', expected: { value: 42 } },
    { reply: 'invalid-json', expected: null },
  ])('retains structured parsing for $reply', async ({ reply, expected }) => {
    const transport = new LocalTransport(reply);
    expect(await transport.chatStructured({ model: 'fixture', messages: [] })).toEqual(expected);
    expect(transport.request?.responseFormat).toBe('json');
  });

  it('retains the base transport explicit unsupported embedding result', async () => {
    expect(await new LocalTransport('').embed(['fixture'])).toEqual([]);
  });
});
