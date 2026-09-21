import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLLMGateway, LLMGateway, resetLLMGateway } from '../src/ai/gateway/LLMGateway.js';
import { jsonResponse } from './helpers/mockFetch.js';

function stubFetch(response: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(response))
  );
}

describe('LLMGateway horizontal capabilities', () => {
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
