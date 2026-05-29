import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekProvider } from '../src/ai/providers/DeepSeekProvider.js';

function mockDeepSeekFetch(
  capture: { body?: Record<string, unknown> },
  response: Record<string, unknown> = {
    choices: [{ message: { content: 'ok' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    capture.body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    return {
      ok: true,
      json: async () => response,
      text: async () => '',
    } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('DeepSeekProvider V4 tool calls', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('omits tool_choice for V4 tool requests even when required is requested', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    mockDeepSeekFetch(capture);
    const provider = new DeepSeekProvider({ apiKey: 'test-key', model: 'deepseek-v4-pro' });

    await provider.chatWithTools('inspect code', {
      messages: [{ role: 'user', content: 'inspect code' }],
      toolSchemas: [{ name: 'code', parameters: { type: 'object', properties: {} } }],
      toolChoice: 'required',
      maxTokens: 1024,
    });

    expect(capture.body?.thinking).toEqual({ type: 'enabled' });
    expect(capture.body?.tool_choice).toBeUndefined();
  });

  it('keeps text function-call parsing as compatibility, independent from required tool_choice', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    mockDeepSeekFetch(capture, {
      choices: [
        {
          finish_reason: 'length',
          message: {
            content:
              '<function_calls><invoke name="code"><parameter name="action">read</parameter><parameter name="path">Sources/App.swift</parameter></invoke></function_calls>',
            reasoning_content: 'need file evidence',
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const provider = new DeepSeekProvider({ apiKey: 'test-key', model: 'deepseek-v4-pro' });

    const result = await provider.chatWithTools('inspect code', {
      messages: [{ role: 'user', content: 'inspect code' }],
      toolSchemas: [{ name: 'code', parameters: { type: 'object', properties: {} } }],
      toolChoice: 'auto',
      maxTokens: 1024,
    });

    expect(result.text).toBeNull();
    expect(result.finishReason).toBe('length');
    expect(result.functionCalls).toEqual([
      {
        id: 'call_deepseek_compat_1',
        name: 'code',
        args: { action: 'read', path: 'Sources/App.swift' },
      },
    ]);
  });
});
