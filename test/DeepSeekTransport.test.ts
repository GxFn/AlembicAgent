import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekTransport } from '../src/ai/transport/DeepSeekTransport.js';

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

  it('omits tool_choice for DeepSeek V4 tool requests even when required is requested', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    mockDeepSeekFetch(capture);
    const transport = new DeepSeekTransport({ apiKey: 'test-key' });

    await transport.chatWithTools({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'read code' }],
      tools: [{ name: 'code', parameters: { type: 'object', properties: {} } }],
      toolChoice: 'required',
      maxTokens: 1024,
    });

    expect(capture.body?.thinking).toEqual({ type: 'enabled' });
    expect(capture.body?.tool_choice).toBeUndefined();
    expect(capture.body?.tools).toHaveLength(1);
  });

  it('keeps reasoning_content for every complete V4 assistant tool-call round', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    mockDeepSeekFetch(capture);
    const transport = new DeepSeekTransport({ apiKey: 'test-key' });

    await transport.chatWithTools({
      model: 'deepseek-v4-pro',
      messages: [
        {
          role: 'assistant',
          content: null,
          reasoningContent: 'first reasoning',
          toolCalls: [{ id: 'call-1', name: 'code', args: { action: 'structure' } }],
        },
        { role: 'tool', toolCallId: 'call-1', name: 'code', content: 'first result' },
        {
          role: 'assistant',
          content: null,
          reasoningContent: 'second reasoning',
          toolCalls: [{ id: 'call-2', name: 'graph', args: { action: 'query' } }],
        },
        { role: 'tool', toolCallId: 'call-2', name: 'graph', content: 'second result' },
        { role: 'user', content: 'continue' },
      ],
      tools: [
        { name: 'code', parameters: { type: 'object', properties: {} } },
        { name: 'graph', parameters: { type: 'object', properties: {} } },
      ],
      toolChoice: 'auto',
      maxTokens: 1024,
    });

    const assistantMessages = sentMessages(capture).filter(
      (message) => message.role === 'assistant'
    );
    expect(assistantMessages.map((message) => message.reasoning_content)).toEqual([
      'first reasoning',
      'second reasoning',
    ]);
  });

  it('keeps text function-call parsing as compatibility, independent from required tool_choice', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const transport = new DeepSeekTransport({ apiKey: 'test-key' });
    mockDeepSeekFetch(capture, {
      choices: [
        {
          finish_reason: 'length',
          message: {
            content:
              '<function_calls><invoke name="code"><parameter name="action">structure</parameter><parameter name="path">Sources/App.swift</parameter></invoke></function_calls>',
            reasoning_content: 'need structure',
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const result = await transport.chatWithTools({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'inspect project' }],
      tools: [{ name: 'code', parameters: { type: 'object', properties: {} } }],
      toolChoice: 'auto',
      maxTokens: 1024,
    });

    expect(result.text).toBeNull();
    expect(result.finishReason).toBe('length');
    expect(result.functionCalls).toEqual([
      {
        id: 'call_deepseek_compat_1',
        name: 'code',
        args: { action: 'structure', path: 'Sources/App.swift' },
      },
    ]);
  });
});
