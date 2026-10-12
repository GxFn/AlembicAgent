import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiProvider } from '../src/ai/AiProvider.js';
import type { ChatContext } from '../src/ai/contracts.js';
import type { LLMGateway } from '../src/ai/gateway/LLMGateway.js';
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

describe('AiProvider.probe deadline, retry budget and usage source', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * vitest fake timers 不接管 Node 内置的 AbortSignal.timeout（其计时器走内部 timers 模块）。
   * 这里把它替换为同语义（reason 为 TimeoutError 的 DOMException）、由可推进的 setTimeout 驱动的信号，
   * 让 30 秒期限在测试里不必真实等待；spy 同时记录 probe 实际武装的期限毫秒数。
   */
  function driveTimeoutSignalsWithFakeTimers() {
    return vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(
        () =>
          controller.abort(
            new DOMException('The operation was aborted due to timeout', 'TimeoutError')
          ),
        ms
      );
      return controller.signal;
    });
  }

  function captureLogger() {
    return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  type Settled = { done: boolean; value?: boolean; error?: unknown };

  function track(promise: Promise<boolean>): Settled {
    const state: Settled = { done: false };
    promise.then(
      (value) => {
        state.done = true;
        state.value = value;
      },
      (error: unknown) => {
        state.done = true;
        state.error = error;
      }
    );
    return state;
  }

  it('fails a never-responding probe at the 30s deadline after exactly one attempt', async () => {
    vi.useFakeTimers();
    const timeoutSpy = driveTimeoutSignalsWithFakeTimers();
    // 黑洞代理：请求发出后永不应答，也不响应 abort。
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    // 默认配置：timeout=300s、maxRetries=3；探测不得继承这两项。
    const provider = new OpenAiProvider({ apiKey: 'test-key', model: 'gpt-4o' });
    const logger = captureLogger();
    provider.logger = logger;

    const state = track(provider.probe());
    await vi.advanceTimersByTimeAsync(29_999);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(state.done).toBe(true);
    expect(state.error).toBeInstanceOf(Error);
    expect(state.error).toMatchObject({ code: 'PROBE_DEADLINE_EXCEEDED' });
    expect((state.error as Error).name).not.toBe('AbortError');
    expect((state.error as Error).message).toContain('30000ms');
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[openai] probe_deadline_exceeded deadlineMs=30000')
    );
    // 期限之后再推进到旧路径的约 20 分钟：没有任何后台重试。
    await vi.advanceTimersByTimeAsync(1_300_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not retry a retryable probe failure even when the provider allows retries', async () => {
    vi.useFakeTimers();
    driveTimeoutSignalsWithFakeTimers();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { message: 'fixture overloaded' } }, 503)
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAiProvider({ apiKey: 'test-key', model: 'gpt-4o', maxRetries: 3 });
    provider.logger = captureLogger();

    const state = track(provider.probe());
    // 足够覆盖旧路径 3 次指数退避（2s/4s/8s + 抖动），但不触达 30s 期限。
    await vi.advanceTimersByTimeAsync(20_000);

    expect(state.done).toBe(true);
    expect(state.error).toMatchObject({ status: 503 });
    expect(state.error).not.toMatchObject({ code: 'PROBE_DEADLINE_EXCEEDED' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(provider.maxRetries).toBe(3);
  });

  it('keeps caller cancellation as AbortError while the probe deadline is armed', async () => {
    vi.useFakeTimers();
    const timeoutSpy = driveTimeoutSignalsWithFakeTimers();
    let transportSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      transportSignal = init?.signal;
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAiProvider({ apiKey: 'test-key', model: 'gpt-4o' });
    const logger = captureLogger();
    provider.logger = logger;
    const controller = new AbortController();

    const state = track(provider.probe({ abortSignal: controller.signal }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.done).toBe(false);
    controller.abort(new Error('host cancelled the connection test'));
    await vi.advanceTimersByTimeAsync(0);

    expect(state.done).toBe(true);
    expect(state.error).toMatchObject({
      name: 'AbortError',
      message: 'host cancelled the connection test',
    });
    expect(state.error).not.toMatchObject({ code: 'PROBE_DEADLINE_EXCEEDED' });
    expect(transportSignal?.aborted).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('probe_deadline_exceeded');
  });

  it('reports a successful probe usage with source probe', async () => {
    const fetchMock = mockFetch(
      {},
      {
        choices: [
          { index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      }
    );
    const provider = new OpenAiProvider({ apiKey: 'test-key', model: 'gpt-4o' });
    const observer = vi.fn();
    provider._onTokenUsage = observer;

    await expect(provider.probe()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledExactlyOnceWith({
      inputTokens: 4,
      outputTokens: 1,
      totalTokens: 5,
      provider: 'openai',
      model: 'gpt-4o',
      source: 'probe',
    });
  });

  it('keeps a direct subclass probe on its own chat() and still bounds it by the deadline', async () => {
    vi.useFakeTimers();
    driveTimeoutSignalsWithFakeTimers();
    const provider = new HangingTextProvider();
    const logger = captureLogger();
    provider.logger = logger;

    const state = track(provider.probe());
    await vi.advanceTimersByTimeAsync(30_000);

    expect(provider.chatCalls).toHaveLength(1);
    expect(provider.chatCalls[0]).toMatchObject({
      prompt: 'ping',
      context: { maxTokens: 16, temperature: 0 },
    });
    expect(state.error).toMatchObject({ code: 'PROBE_DEADLINE_EXCEEDED' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[custom-hanging] probe_deadline_exceeded deadlineMs=30000')
    );
  });
});

// 直接继承 AiProvider 的自定义 provider：chat() 只在收到取消信号时结束，模拟黑洞端点。
class HangingTextProvider extends AiProvider {
  readonly chatCalls: Array<{ prompt: string; context: ChatContext }> = [];

  constructor() {
    super({});
    this.name = 'custom-hanging';
  }

  async chat(prompt: string, context: ChatContext = {}): Promise<string> {
    this.chatCalls.push({ prompt, context });
    const signal = context.abortSignal;
    return new Promise<string>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
}

// 直接继承 AiProvider 的自定义 provider：不设置 logger，也不覆写 chatWithTools。
class TextOnlyProvider extends AiProvider {
  readonly chatCalls: Array<{ prompt: string; context: ChatContext }> = [];

  constructor() {
    super({});
    this.name = 'custom-text';
  }

  async chat(prompt: string, context: ChatContext = {}): Promise<string> {
    this.chatCalls.push({ prompt, context });
    return 'text-only answer';
  }
}

describe('provider degrade diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes base-class warnings to the Core logger when a direct subclass sets no logger', async () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const provider = new TextOnlyProvider();
    const failingGateway = {
      embed: () => Promise.reject(new Error('fixture embed outage')),
    } as unknown as LLMGateway;
    vi.spyOn(provider, '_getGateway').mockResolvedValue(failingGateway);

    expect(provider.logger).toBeNull();
    await expect(provider._gatewayEmbed('fixture text')).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[custom-text] embed failed'));
  });

  it('keeps an explicitly injected logger ahead of the Core logger fallback', () => {
    const coreWarn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const provider = new TextOnlyProvider();
    const warn = vi.fn();
    provider.logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };

    provider._log('warn', 'fixture injected warning');

    expect(warn).toHaveBeenCalledWith('fixture injected warning');
    expect(coreWarn).not.toHaveBeenCalled();
  });

  it('warns once per Claude instance that embedding is unsupported while keeping the [] result', async () => {
    const provider = new ClaudeProvider({ apiKey: 'fixture-key', model: 'claude-sonnet-4-5' });
    const warn = vi.fn();
    provider.logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };

    await expect(provider.embed(['a'])).resolves.toEqual([]);
    await expect(provider.embed('b')).resolves.toEqual([]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[claude] embedding_unsupported; returning empty result for upper-layer degrade'
    );
  });

  it('still rejects a pre-cancelled Claude embed before logging the unsupported diagnostic', async () => {
    const provider = new ClaudeProvider({ apiKey: 'fixture-key', model: 'claude-sonnet-4-5' });
    const warn = vi.fn();
    provider.logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const controller = new AbortController();
    controller.abort();

    await expect(provider.embed(['a'], { abortSignal: controller.signal })).rejects.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once when the default chatWithTools degrades to text-only chat', async () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const provider = new TextOnlyProvider();
    const opts = {
      messages: [
        { role: 'user' as const, content: 'inspect' },
        {
          role: 'assistant' as const,
          content: null,
          toolCalls: [{ id: 'call-1', name: 'code', args: {} }],
        },
        { role: 'tool' as const, toolCallId: 'call-1', name: 'code', content: 'fixture result' },
      ],
      toolSchemas: [
        { name: 'code', description: 'read code', parameters: { type: 'object' } },
        { name: 'search', description: 'search code', parameters: { type: 'object' } },
      ],
    };

    const first = await provider.chatWithTools('inspect', opts);
    const second = await provider.chatWithTools('inspect', opts);

    // 降级结果语义不变（语义修正属于待决事项②），这里只锁定诊断。
    expect(first).toEqual({ text: 'text-only answer', functionCalls: null });
    expect(second).toEqual({ text: 'text-only answer', functionCalls: null });
    const degradeWarnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('chatWithTools_text_degrade')
    );
    expect(degradeWarnings).toEqual([
      ['[custom-text] chatWithTools_text_degrade tools=2 dropped_tool_messages=1'],
    ]);
  });
});
