import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from '../src/ai/providers/ClaudeProvider.js';
import { DeepSeekProvider } from '../src/ai/providers/DeepSeekProvider.js';
import { GoogleGeminiProvider } from '../src/ai/providers/GoogleGeminiProvider.js';
import { OllamaProvider } from '../src/ai/providers/OllamaProvider.js';
import { OpenAiProvider } from '../src/ai/providers/OpenAiProvider.js';
import { jsonResponse, mockJsonFetch as mockFetch, responsesText } from './helpers/mockFetch.js';

describe('AI provider facade lifecycle and configuration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    'synchronous',
    'asynchronous',
  ])('isolates a direct %s usage observer failure without losing the response or replaying HTTP', async (mode) => {
    const fetchMock = mockFetch(
      {},
      {
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'known response' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }
    );
    const provider = new OpenAiProvider({ apiKey: 'fixture-key', model: 'gpt-4o', maxRetries: 0 });
    const warn = vi.fn();
    provider.logger = { warn };
    const observer = vi.fn(() => {
      const error = new Error('fixture-private-observer-detail');
      if (mode === 'asynchronous') {
        return Promise.reject(error);
      }
      throw error;
    });
    provider._onTokenUsage = observer;

    const result = await provider.chatWithTools('fixture prompt');
    await new Promise((resolve) => setImmediate(resolve));
    expect(result).toMatchObject({
      text: 'known response',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledExactlyOnceWith({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      provider: 'openai',
      model: 'gpt-4o',
      source: 'tools',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('usage_observer_failed'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-private-observer-detail');
  });

  it.each(
    [OpenAiProvider, GoogleGeminiProvider, DeepSeekProvider, ClaudeProvider, OllamaProvider].map(
      (Provider) => ({ name: Provider.name, Provider })
    )
  )('$name rejects cancelled structured calls before any HTTP request', async ({ Provider }) => {
    const fetchMock = mockFetch({}, { choices: [{ index: 0, message: { content: '{}' } }] });
    const controller = new AbortController();
    controller.abort(new Error('run ended'));
    const provider = new Provider({ apiKey: 'test-key', maxRetries: 0 });

    await expect(
      provider.chatWithStructuredOutput('json', { abortSignal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(
    [OpenAiProvider, GoogleGeminiProvider, DeepSeekProvider, ClaudeProvider, OllamaProvider].map(
      (Provider) => ({ name: Provider.name, Provider })
    )
  )('$name propagates embedding cancellation instead of returning an empty vector', async ({
    Provider,
  }) => {
    const fetchMock = mockFetch({}, { data: [{ index: 0, embedding: [1, 2] }] });
    const controller = new AbortController();
    controller.abort(new Error('embedding no longer needed'));
    const provider = new Provider({ apiKey: 'test-key', maxRetries: 0 });

    await expect(provider.embed('text', { abortSignal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honors an explicit zero retry limit', () => {
    expect(new OpenAiProvider({ apiKey: 'test-key', maxRetries: 0 }).maxRetries).toBe(0);
  });

  it.each([
    'probe',
    'summarize',
  ] as const)('forwards cancellation through %s', async (operation) => {
    const fetchMock = mockFetch({}, { choices: [{ index: 0, message: { content: '{}' } }] });
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    const provider = new OpenAiProvider({ apiKey: 'test-key', maxRetries: 0 });
    const options = { abortSignal: controller.signal };
    await expect(
      operation === 'probe' ? provider.probe(options) : provider.summarize('code', options)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards chat cancellation to the actual transport signal', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: (response: Response) => void;
    let transportSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init: RequestInit) => {
        transportSignal = init.signal ?? undefined;
        started();
        return new Promise<Response>((resolve, reject) => {
          finish = resolve;
          transportSignal?.addEventListener('abort', () => reject(new Error('fetch aborted')), {
            once: true,
          });
        });
      })
    );
    const provider = new OpenAiProvider({ apiKey: 'test-key', maxRetries: 0 });
    const result = provider.chat('bounded repair', { abortSignal: controller.signal }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    );
    await fetching;
    controller.abort();
    const transportWasAborted = transportSignal?.aborted;
    finish(jsonResponse({ choices: [{ index: 0, message: { content: 'late' } }] }));
    const settled = await result;
    expect(transportWasAborted).toBe(true);
    expect(settled.error).toBeInstanceOf(Error);
    expect(settled.value).toBeUndefined();
  });

  it.each([
    'structured',
    'embed',
  ] as const)('cancels the %s HTTP request and rejects a late body', async (operation) => {
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: (response: Response) => void;
    let transportSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init: RequestInit) => {
        transportSignal = init.signal;
        started();
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      })
    );
    const controller = new AbortController();
    const provider = new OpenAiProvider({ apiKey: 'test-key', maxRetries: 0 });
    const options = { abortSignal: controller.signal };
    const result = (
      operation === 'embed'
        ? provider.embed('text', options)
        : provider.chatWithStructuredOutput('json', options)
    ).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error })
    );
    await fetching;
    controller.abort(new Error('run cancelled'));
    // 模拟不合作的宿主 fetch：已取消但仍返回 HTTP/body，不能复活已取消的调用。
    finish(
      new Response(
        JSON.stringify({
          choices: [{ index: 0, message: { content: '{"ok":true}' } }],
          data: [{ index: 0, embedding: [1, 2] }],
        }),
        { status: 200 }
      )
    );
    const settled = await result;
    expect(transportSignal?.aborted).toBe(true);
    expect(settled.error).toMatchObject({ name: 'AbortError' });
    expect(settled.value).toBeUndefined();
  });

  it('shares the concurrency gate across simultaneous first requests', async () => {
    let active = 0;
    let peak = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return jsonResponse({ choices: [{ index: 0, message: { content: 'ok' } }] });
      })
    );
    const provider = new OpenAiProvider({ apiKey: 'test-key', maxConcurrency: 1, maxRetries: 0 });
    expect(await Promise.all([provider.chat('first'), provider.chat('second')])).toEqual([
      'ok',
      'ok',
    ]);
    expect(peak).toBe(1);
  });

  it('uses ALEMBIC_OPENAI_BASE_URL / config.baseUrl for chat/completions endpoint', async () => {
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    mockFetch(capture, {
      choices: [{ index: 0, message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const provider = new OpenAiProvider({
      apiKey: 'test-key',
      model: 'gpt-5.5',
      baseUrl: 'https://relay.example.ai/v1',
    });

    const reply = await provider.chat('hello');

    expect(reply).toBe('ok');
    expect(capture.url).toBe('https://relay.example.ai/v1/chat/completions');
  });
});

describe('OpenAiProvider Responses API style', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function responsesProvider() {
    return new OpenAiProvider({
      apiKey: 'test-key',
      model: 'gpt-5.4',
      baseUrl: 'https://relay.example.ai/v1',
      apiStyle: 'responses',
    });
  }

  it('routes chat() to /responses with input + max_output_tokens and parses output_text', async () => {
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    mockFetch(capture, {
      status: 'completed',
      output: [responsesText('我是 GPT')],
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
    });

    const reply = await responsesProvider().chat('你好');

    expect(reply).toBe('我是 GPT');
    expect(capture.url).toBe('https://relay.example.ai/v1/responses');
    expect(capture.body?.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '你好' }] },
    ]);
    expect(capture.body?.max_output_tokens).toBeDefined();
    // 经典 Chat Completions 字段不应出现
    expect(capture.body?.messages).toBeUndefined();
    expect(capture.body?.max_tokens).toBeUndefined();
  });

  it('aggregates output_text from message content parts when top-level output_text is absent', async () => {
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    mockFetch(capture, {
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'reasoning-fixture', summary: [] },
        {
          type: 'message',
          id: 'message-fixture',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'part-1 ', annotations: [] },
            { type: 'output_text', text: 'part-2', annotations: [] },
          ],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    });

    const reply = await responsesProvider().chat('hi');
    expect(reply).toBe('part-1 part-2');
  });

  it('routes chatWithTools() to /responses with flat tool schema and parses function_call', async () => {
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    mockFetch(capture, {
      status: 'completed',
      output: [
        {
          type: 'function_call',
          id: 'function-fixture',
          call_id: 'call_abc',
          name: 'get_weather',
          arguments: '{"city":"杭州"}',
        },
      ],
      usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
    });

    const result = await responsesProvider().chatWithTools('查询天气', {
      messages: [{ role: 'user', content: '查询天气' }],
      toolSchemas: [
        {
          name: 'get_weather',
          description: '查询天气',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
      toolChoice: 'auto',
      maxTokens: 256,
    });

    // 工具为扁平结构（name 直接挂在 function 项上，无 function 嵌套）
    const tools = capture.body?.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ type: 'function', name: 'get_weather' });
    expect(tools[0].function).toBeUndefined();
    expect(capture.body?.tool_choice).toBe('auto');

    expect(result.functionCalls).toEqual([
      { id: 'call_abc', name: 'get_weather', args: { city: '杭州' } },
    ]);
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 6, totalTokens: 11 });
  });

  it('maps assistant tool calls and tool results into Responses function_call / function_call_output', async () => {
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    mockFetch(capture, {
      status: 'completed',
      output: [responsesText('done')],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });

    await responsesProvider().chatWithTools('continue', {
      messages: [
        { role: 'user', content: '查询天气' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'call_abc', name: 'get_weather', args: { city: '杭州' } }],
        },
        { role: 'tool', toolCallId: 'call_abc', content: '晴 26°C' },
      ],
      toolSchemas: [{ name: 'get_weather', parameters: { type: 'object', properties: {} } }],
    });

    const input = capture.body?.input as Array<Record<string, unknown>>;
    expect(input).toContainEqual({
      type: 'function_call',
      call_id: 'call_abc',
      name: 'get_weather',
      arguments: '{"city":"杭州"}',
    });
    expect(input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_abc',
      output: '晴 26°C',
    });
  });

  it('routes chatWithStructuredOutput() to /responses with text.format json and parses JSON', async () => {
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    mockFetch(capture, {
      status: 'completed',
      output: [responsesText('{"title":"T","description":"D"}')],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    });

    const result = (await responsesProvider().chatWithStructuredOutput('extract')) as {
      title: string;
      description: string;
    };

    expect(capture.body?.text).toEqual({ format: { type: 'json_object' } });
    expect(result).toEqual({ title: 'T', description: 'D' });
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
