import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAiTransport } from '../src/ai/transport/OpenAiTransport.js';

interface Capture {
  url?: string;
  body?: Record<string, unknown>;
}

function mockFetch(capture: Capture, response: Record<string, unknown>) {
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

describe('OpenAiTransport apiStyle=chat (default)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts to /chat/completions and parses content', async () => {
    const capture: Capture = {};
    mockFetch(capture, {
      choices: [{ message: { content: 'hello' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    const transport = new OpenAiTransport({ apiKey: 'k' });
    const text = await transport.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64,
    });
    expect(capture.url).toContain('/chat/completions');
    expect(text).toBe('hello');
  });
});

describe('OpenAiTransport apiStyle=responses', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts to /responses with input + max_output_tokens and parses output_text', async () => {
    const capture: Capture = {};
    mockFetch(capture, {
      output_text: 'mined',
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      status: 'completed',
    });
    const transport = new OpenAiTransport({ apiKey: 'k', apiStyle: 'responses' });
    const text = await transport.chat({
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: 'mine this' }],
      systemPrompt: 'be precise',
      maxTokens: 128,
    });
    expect(capture.url).toContain('/responses');
    expect(capture.body?.input).toBeDefined();
    expect(capture.body?.max_output_tokens).toBe(128);
    expect(capture.body?.instructions).toBe('be precise');
    expect(text).toBe('mined');
  });

  it('emits flat tool schema and parses function_call output', async () => {
    const capture: Capture = {};
    mockFetch(capture, {
      output: [{ type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{"q":"x"}' }],
      usage: { input_tokens: 5, output_tokens: 4 },
      status: 'completed',
    });
    const transport = new OpenAiTransport({ apiKey: 'k', apiStyle: 'responses' });
    const res = await transport.chatWithTools({
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: 'use the tool' }],
      tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } }],
      toolChoice: 'auto',
      maxTokens: 256,
    });
    expect(capture.url).toContain('/responses');
    const tools = capture.body?.tools as Array<Record<string, unknown>>;
    // 扁平结构：name 直接在 function 项上，而非嵌套在 function:{}
    expect(tools[0]).toMatchObject({ type: 'function', name: 'lookup' });
    expect(capture.body?.tool_choice).toBe('auto');
    expect(res.functionCalls).toEqual([{ id: 'c1', name: 'lookup', args: { q: 'x' } }]);
    expect(res.usage).toMatchObject({ inputTokens: 5, outputTokens: 4, totalTokens: 9 });
  });

  it('declares JSON output via text.format when responseFormat=json', async () => {
    const capture: Capture = {};
    mockFetch(capture, { output_text: '{"ok":true}', status: 'completed' });
    const transport = new OpenAiTransport({ apiKey: 'k', apiStyle: 'responses' });
    await transport.chat({
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: 'json please' }],
      responseFormat: 'json',
      maxTokens: 64,
    });
    expect(capture.body?.text).toEqual({ format: { type: 'json_object' } });
  });

  it('propagates streaming abort signals through the provider fetch path', async () => {
    const abortController = new AbortController();
    let requestSignal: AbortSignal | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            requestSignal = init?.signal ?? null;
            requestSignal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted by caller'), { name: 'AbortError' }));
            });
          })
      )
    );
    const transport = new OpenAiTransport({ apiKey: 'k', apiStyle: 'responses' });
    const pending = transport.chat({
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: 'cancel this' }],
      maxTokens: 64,
      abortSignal: abortController.signal,
    });

    abortController.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal?.aborted).toBe(true);
  });
});
