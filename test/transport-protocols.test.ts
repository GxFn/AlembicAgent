import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeTransport } from '../src/ai/transport/ClaudeTransport.js';
import { DeepSeekTransport } from '../src/ai/transport/DeepSeekTransport.js';
import { GoogleTransport } from '../src/ai/transport/GoogleTransport.js';
import { OpenAiTransport } from '../src/ai/transport/OpenAiTransport.js';
import { mockJsonFetch as mockFetch, responsesText } from './helpers/mockFetch.js';

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
  return mockFetch(capture, {
    id: 'msg-fixture',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    ...response,
  });
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

    expect(capture.body?.system).toEqual([{ type: 'text', text: 'You are precise.' }]);
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

/**
 * GoogleTransport carries the Gemini REST contract, which diverges sharply from
 * the OpenAI/Anthropic shapes and had no dedicated test: contents use role
 * user/model, tool results ride as functionResponse parts, tool_choice maps to
 * functionCallingConfig.mode, native JSON Schemas and header authentication,
 * and thoughtSignature must round-trip.
 */

function mockGeminiFetch(
  capture: { url?: string; body?: Record<string, unknown> },
  response: Record<string, unknown> = {
    candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  }
) {
  return mockFetch(capture, response);
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
      id: 'c1',
      name: 'code',
      response: { name: 'code', content: 'file body' },
    });
  });

  it('maps tool_choice required->ANY and preserves the native JSON Schema', async () => {
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
      functionDeclarations: Array<{ parametersJsonSchema: Record<string, unknown> }>;
    }>;
    const params = tools[0].functionDeclarations[0].parametersJsonSchema;
    expect(params.default).toEqual({});
    expect(params.examples).toEqual([]);
    expect((params.properties as Record<string, Record<string, unknown>>).path.default).toBe('x');
  });

  it('uses native key headers without putting credentials in the URL', async () => {
    const capture: {
      url?: string;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {};
    mockGeminiFetch(capture);
    const transport = new GoogleTransport({ apiKey: 'gem-key' });

    const text = await transport.chat({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64,
    });

    expect(text).toBe('ok');
    expect(capture.url).toContain('models/gemini-2.5-flash:generateContent');
    expect(capture.url).not.toContain('gem-key');
    expect(capture.headers?.['x-goog-api-key']).toBe('gem-key');
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
    expect(result.functionCalls?.[0].id).toEqual(expect.any(String));
    expect(result.functionCalls?.[0].id).not.toBe('');
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 8, totalTokens: 28 });
  });
});

function mockDeepSeekFetch(
  capture: { body?: Record<string, unknown> },
  response: Record<string, unknown> = {
    choices: [{ index: 0, message: { content: 'ok' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
) {
  return mockFetch(capture, response);
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

  it('rejects malformed provider bodies without fabricating tool calls or empty success', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const transport = new DeepSeekTransport({ apiKey: 'test-key' });
    mockDeepSeekFetch(capture, {
      choices: [{ not_a_message: true }],
      usage: { prompt_tokens: 2, completion_tokens: 0, total_tokens: 2 },
    });

    await expect(
      transport.chatWithTools({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'call a tool only if valid' }],
        tools: [{ name: 'code', parameters: { type: 'object', properties: {} } }],
        toolChoice: 'auto',
        maxTokens: 1024,
      })
    ).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
  });

  it('surfaces mid-stream JSON body drops instead of returning a false success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('provider body stream terminated'));
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    );
    const transport = new DeepSeekTransport({ apiKey: 'test-key' });

    await expect(
      transport.chat({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 64,
      })
    ).rejects.toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

interface Capture {
  url?: string;
  body?: Record<string, unknown>;
}

describe('OpenAiTransport apiStyle=chat (default)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not fetch when the caller signal is already aborted', async () => {
    const fetch = mockFetch(
      {},
      { choices: [{ index: 0, message: { content: 'should not run' } }] }
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      new OpenAiTransport({ apiKey: 'test-key' }).chat({
        model: 'gpt-4o',
        messages: [],
        abortSignal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('classifies a transport deadline separately from caller cancellation', async () => {
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
    await expect(
      new OpenAiTransport({ apiKey: 'test-key', timeout: 5 }).chat({
        model: 'gpt-4o',
        messages: [],
      })
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });

  it('posts to /chat/completions and parses content', async () => {
    const capture: Capture = {};
    mockFetch(capture, {
      choices: [{ index: 0, message: { content: 'hello' } }],
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
      output: [responsesText('mined')],
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
      output: [
        {
          type: 'function_call',
          id: 'function-fixture',
          call_id: 'c1',
          name: 'lookup',
          arguments: '{"q":"x"}',
        },
      ],
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
    mockFetch(capture, { output: [responsesText('{"ok":true}')], status: 'completed' });
    const transport = new OpenAiTransport({ apiKey: 'k', apiStyle: 'responses' });
    await transport.chat({
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: 'json please' }],
      responseFormat: 'json',
      maxTokens: 64,
    });
    expect(capture.body?.text).toEqual({ format: { type: 'json_object' } });
  });

  it('propagates cancellation to an in-flight HTTP request', async () => {
    const abortController = new AbortController();
    let requestSignal: AbortSignal | null = null;
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            requestSignal = init?.signal ?? null;
            started();
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

    await fetching;
    abortController.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal?.aborted).toBe(true);
  });
});
