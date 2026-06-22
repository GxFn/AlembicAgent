import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleTransport } from '../src/ai/transport/GoogleTransport.js';

/**
 * GoogleTransport carries the Gemini REST contract, which diverges sharply from
 * the OpenAI/Anthropic shapes and had no dedicated test: contents use role
 * user/model, tool results ride as functionResponse parts, tool_choice maps to
 * functionCallingConfig.mode, schemas must be sanitized (no default/examples),
 * the API key travels in the URL query, and thoughtSignature must round-trip.
 */

function mockGeminiFetch(
  capture: { url?: string; body?: Record<string, unknown> },
  response: Record<string, unknown> = {
    candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  }
) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    capture.url = String(url);
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

describe('GoogleTransport Gemini protocol translation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renames assistant->model and routes tool results to functionResponse user parts', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    mockGeminiFetch(capture);
    const transport = new GoogleTransport({ apiKey: 'k' });

    await transport.chatWithTools({
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'user', content: 'analyze' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'c1', name: 'code', args: { action: 'read' } }],
        },
        { role: 'tool', toolCallId: 'c1', name: 'code', content: 'file body' },
      ],
      tools: [{ name: 'code', parameters: { type: 'object', properties: {} } }],
      maxTokens: 1024,
    });

    const contents = (capture.body?.contents || []) as Array<Record<string, unknown>>;
    expect(contents).toHaveLength(3);

    expect(contents[1].role).toBe('model');
    const modelParts = contents[1].parts as Array<Record<string, unknown>>;
    expect(modelParts[0].functionCall).toMatchObject({ name: 'code', args: { action: 'read' } });

    expect(contents[2].role).toBe('user');
    const toolParts = contents[2].parts as Array<Record<string, unknown>>;
    expect(toolParts[0].functionResponse).toEqual({
      name: 'code',
      response: { result: 'file body' },
    });
  });

  it('maps tool_choice required->ANY and sanitizes schemas (strips default/examples)', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    mockGeminiFetch(capture);
    const transport = new GoogleTransport({ apiKey: 'k' });

    await transport.chatWithTools({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'go' }],
      tools: [
        {
          name: 'code',
          description: 'read',
          parameters: {
            type: 'object',
            default: {},
            examples: [],
            properties: { path: { type: 'string', default: 'x' } },
          },
        },
      ],
      toolChoice: 'required',
      maxTokens: 512,
    });

    const toolConfig = capture.body?.toolConfig as Record<string, Record<string, unknown>>;
    expect(toolConfig.functionCallingConfig.mode).toBe('ANY');

    const tools = capture.body?.tools as Array<{
      functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
    }>;
    const params = tools[0].functionDeclarations[0].parameters;
    expect(params.default).toBeUndefined();
    expect(params.examples).toBeUndefined();
    expect(
      (params.properties as Record<string, Record<string, unknown>>).path.default
    ).toBeUndefined();
  });

  it('passes the API key as a URL query param, not a header', async () => {
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    mockGeminiFetch(capture);
    const transport = new GoogleTransport({ apiKey: 'gem-key' });

    const text = await transport.chat({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64,
    });

    expect(text).toBe('ok');
    expect(capture.url).toContain('models/gemini-2.5-flash:generateContent');
    expect(capture.url).toContain('key=gem-key');
  });

  it('parses functionCall + text parts, maps usageMetadata, and preserves thoughtSignature', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    mockGeminiFetch(capture, {
      candidates: [
        {
          content: {
            parts: [
              { text: 'Looking.' },
              { functionCall: { name: 'graph', args: { q: 1 } }, thoughtSignature: 'sig-abc' },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28 },
    });
    const transport = new GoogleTransport({ apiKey: 'k' });

    const result = await transport.chatWithTools({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'inspect' }],
      tools: [{ name: 'graph', parameters: { type: 'object', properties: {} } }],
      maxTokens: 1024,
    });

    expect(result.text).toBe('Looking.');
    expect(result.functionCalls).toHaveLength(1);
    expect(result.functionCalls?.[0]).toMatchObject({
      name: 'graph',
      args: { q: 1 },
      thoughtSignature: 'sig-abc',
    });
    expect(result.functionCalls?.[0].id).toMatch(/^gemini_fc_\d+_0$/u);
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 8, totalTokens: 28 });
  });
});
