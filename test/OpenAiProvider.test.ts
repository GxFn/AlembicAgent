import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiProvider } from '../src/external/ai/providers/OpenAiProvider.js';

/**
 * Mock 全局 fetch，捕获请求 url + body，返回指定响应。
 * 用于在无真实 API key 的前提下验证 OpenAiProvider 的请求构造与响应解析。
 */
function mockFetch(
  capture: { url?: string; body?: Record<string, unknown> },
  response: Record<string, unknown>
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

describe('OpenAiProvider baseUrl override', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses ALEMBIC_OPENAI_BASE_URL / config.baseUrl for chat/completions endpoint', async () => {
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    mockFetch(capture, {
      choices: [{ message: { content: 'ok' } }],
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
      output_text: '我是 GPT',
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
        { type: 'reasoning', summary: [] },
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'part-1 ' },
            { type: 'output_text', text: 'part-2' },
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
      output_text: 'done',
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
      output_text: '{"title":"T","description":"D"}',
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
