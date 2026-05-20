import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekTransport } from '../src/external/ai/transport/DeepSeekTransport.js';

function mockDeepSeekFetch(capture: { body?: Record<string, unknown> }) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    capture.body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      text: async () => '',
    } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentMessages(capture: { body?: Record<string, unknown> }) {
  return (capture.body?.messages || []) as Array<Record<string, unknown>>;
}

describe('DeepSeekTransport tool transcript preflight', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes isolated tool messages before sending Chat Completions requests', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    mockDeepSeekFetch(capture);
    const transport = new DeepSeekTransport({ apiKey: 'test-key' });

    await transport.chatWithTools({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'tool', toolCallId: 'orphan-call', name: 'code', content: 'orphan result' },
        { role: 'user', content: 'continue' },
      ],
      maxTokens: 1024,
    });

    const messages = sentMessages(capture);
    expect(messages[0]).toMatchObject({ role: 'user' });
    expect(messages[0].content).toContain('tool result converted to text');
    expect(messages.some((message) => message.role === 'tool')).toBe(false);
  });

  it('strips incomplete assistant tool calls when the matching tool result is absent', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    mockDeepSeekFetch(capture);
    const transport = new DeepSeekTransport({ apiKey: 'test-key' });

    await transport.chatWithTools({
      model: 'deepseek-v4-flash',
      messages: [
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'missing-result', name: 'graph', args: { type: 'callers' } }],
        },
        { role: 'user', content: 'summarize' },
      ],
      tools: [{ name: 'graph', parameters: { type: 'object', properties: {} } }],
      maxTokens: 1024,
    });

    const assistant = sentMessages(capture).find((message) => message.role === 'assistant');
    expect(assistant?.tool_calls).toBeUndefined();
    expect(String(assistant?.content)).toContain('tool calls converted to text');
  });
});
