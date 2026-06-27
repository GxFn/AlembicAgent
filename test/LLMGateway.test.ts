import { afterEach, describe, expect, it, vi } from 'vitest';

import { getLLMGateway, LLMGateway, resetLLMGateway } from '../src/ai/gateway/LLMGateway.js';

function stubFetch(response: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => response, text: async () => '' }) as Response)
  );
}

describe('LLMGateway horizontal capabilities', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetLLMGateway();
  });

  it('fires onUsage callback with provider/model/source after chatWithTools', async () => {
    stubFetch({
      choices: [{ message: { content: 'done' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const usageEvents: Array<Record<string, unknown>> = [];
    const gateway = new LLMGateway({
      providers: { openai: { apiKey: 'k' } },
      onUsage: (u) => usageEvents.push(u),
    });
    await gateway.chatWithTools({
      modelRef: 'openai:gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64,
      usageSource: 'unit-test',
    });
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      provider: 'openai',
      model: 'gpt-4o',
      source: 'unit-test',
    });
  });

  it('preserves provider-prefixed model ids after the first colon', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'done' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          text: async () => '',
        } as Response;
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
      choices: [{ message: { content: '```json\n{"value": 42}\n```' } }],
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
