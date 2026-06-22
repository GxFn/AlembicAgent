import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeTransport } from '../src/ai/transport/ClaudeTransport.js';

/**
 * ClaudeTransport is the protocol-translation layer for the *primary* provider,
 * yet had no dedicated test. These guard the Anthropic-specific contract:
 * tool results ride in a user turn, the system prompt is a top-level field,
 * tool_choice maps to {type:'auto'|'any'} (no 'none'), and the content-block
 * response shape parses into text + functionCalls.
 */

function mockClaudeFetch(
  capture: { body?: Record<string, unknown>; headers?: Record<string, string> },
  response: Record<string, unknown> = {
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }
) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    capture.body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    capture.headers = (init?.headers || {}) as Record<string, string>;
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

describe('ClaudeTransport Anthropic protocol translation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges consecutive tool messages into a single user turn of tool_result blocks', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    mockClaudeFetch(capture);
    const transport = new ClaudeTransport({ apiKey: 'k' });

    await transport.chatWithTools({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'analyze' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'call-1', name: 'code', args: { action: 'read' } },
            { id: 'call-2', name: 'graph', args: { action: 'query' } },
          ],
        },
        { role: 'tool', toolCallId: 'call-1', name: 'code', content: 'file contents' },
        { role: 'tool', toolCallId: 'call-2', name: 'graph', content: 'graph result' },
      ],
      tools: [{ name: 'code', parameters: { type: 'object', properties: {} } }],
      maxTokens: 1024,
    });

    // Expect strict alternation: [user, assistant(tool_use x2), user(tool_result x2)].
    const messages = sentMessages(capture);
    expect(messages).toHaveLength(3);

    const assistantContent = messages[1].content as Array<Record<string, unknown>>;
    expect(messages[1].role).toBe('assistant');
    expect(assistantContent.filter((b) => b.type === 'tool_use')).toHaveLength(2);

    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'call-1', content: 'file contents' },
      { type: 'tool_result', tool_use_id: 'call-2', content: 'graph result' },
    ]);
  });

  it('lifts the system prompt to a top-level field and maps tool_choice required->any', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    mockClaudeFetch(capture);
    const transport = new ClaudeTransport({ apiKey: 'k' });

    await transport.chatWithTools({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'go' }],
      systemPrompt: 'You are precise.',
      tools: [
        { name: 'code', description: 'read', parameters: { type: 'object', properties: {} } },
      ],
      toolChoice: 'required',
      maxTokens: 512,
    });

    expect(capture.body?.system).toBe('You are precise.');
    // system is a top-level field, NOT a message.
    expect(sentMessages(capture)).toHaveLength(1);
    expect(capture.body?.tool_choice).toEqual({ type: 'any' });
    expect(capture.body?.tools).toEqual([
      { name: 'code', description: 'read', input_schema: { type: 'object', properties: {} } },
    ]);
  });

  it('omits tools entirely when tool_choice is none', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    mockClaudeFetch(capture);
    const transport = new ClaudeTransport({ apiKey: 'k' });

    await transport.chatWithTools({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'just text' }],
      tools: [{ name: 'code', parameters: { type: 'object', properties: {} } }],
      toolChoice: 'none',
      maxTokens: 256,
    });

    expect(capture.body?.tools).toBeUndefined();
    expect(capture.body?.tool_choice).toBeUndefined();
  });

  it('parses tool_use + text blocks and maps Anthropic usage', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    mockClaudeFetch(capture, {
      content: [
        { type: 'text', text: 'Reading the file.' },
        { type: 'tool_use', id: 'tu_9', name: 'code', input: { action: 'read', path: 'a.ts' } },
      ],
      usage: { input_tokens: 12, output_tokens: 7 },
    });
    const transport = new ClaudeTransport({ apiKey: 'k' });

    const result = await transport.chatWithTools({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'read a.ts' }],
      tools: [{ name: 'code', parameters: { type: 'object', properties: {} } }],
      maxTokens: 1024,
    });

    expect(result.text).toBe('Reading the file.');
    expect(result.functionCalls).toEqual([
      { id: 'tu_9', name: 'code', args: { action: 'read', path: 'a.ts' } },
    ]);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7, totalTokens: 19 });
  });

  it('sends Anthropic auth + version headers and extracts the text block on chat', async () => {
    const capture: { body?: Record<string, unknown>; headers?: Record<string, string> } = {};
    mockClaudeFetch(capture);
    const transport = new ClaudeTransport({ apiKey: 'secret-key' });

    const text = await transport.chat({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64,
    });

    expect(text).toBe('ok');
    expect(capture.headers?.['x-api-key']).toBe('secret-key');
    expect(capture.headers?.['anthropic-version']).toBe('2023-06-01');
  });
});
