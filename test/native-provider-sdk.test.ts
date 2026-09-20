import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/ContextWindow.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { SimpleArrayAdapter } from '../src/agent/runtime/MessageAdapter.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';
import type { AiProvider, LlmContinuation, UnifiedMessage } from '../src/ai/AiProvider.js';
import { LLMGateway } from '../src/ai/gateway/LLMGateway.js';
import { ClaudeProvider } from '../src/ai/providers/ClaudeProvider.js';
import { DeepSeekProvider } from '../src/ai/providers/DeepSeekProvider.js';
import { GoogleGeminiProvider } from '../src/ai/providers/GoogleGeminiProvider.js';
import { OpenAiProvider } from '../src/ai/providers/OpenAiProvider.js';
import { GoogleTransport } from '../src/ai/transport/GoogleTransport.js';
import { OpenAiTransport } from '../src/ai/transport/OpenAiTransport.js';
import { CapabilityCatalog } from '../src/tools/catalog/CapabilityCatalog.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';
import { Capability } from '../src/tools/runtime/toolsets/Capability.js';
import { jsonResponse } from './helpers/mockFetch.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const providers = [
  {
    name: 'google',
    Provider: GoogleGeminiProvider,
    model: 'gemini-2.5-flash',
    text: () => ({
      candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
    }),
    call: () => ({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                thought: true,
                text: 'sdk_hidden_reasoning',
                thoughtSignature: 'sdk_hidden_signature',
              },
              {
                functionCall: { name: 'lookup', args: { q: 'x' } },
                thoughtSignature: 'sdk_hidden_signature',
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    }),
    error: (status: number) => ({
      error: { code: status, message: 'fixture failure', status: 'UNAVAILABLE' },
    }),
  },
  {
    name: 'claude',
    Provider: ClaudeProvider,
    model: 'claude-sonnet-4-6',
    text: () => ({
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    call: () => ({
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: 'sdk_hidden_reasoning', signature: 'sdk_hidden_signature' },
        { type: 'tool_use', id: 'c1', name: 'lookup', input: { q: 'x' } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    error: (_status: number) => ({
      type: 'error',
      error: { type: 'api_error', message: 'fixture failure' },
    }),
  },
  {
    name: 'deepseek',
    Provider: DeepSeekProvider,
    model: 'deepseek-v4-pro',
    text: () => ({
      choices: [
        { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } },
      ],
    }),
    call: () => ({
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: 'sdk_hidden_reasoning',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
            ],
          },
        },
      ],
    }),
    error: (_status: number) => ({ error: { message: 'fixture failure' } }),
  },
] as const;

describe.each(providers)('$name SDK lifecycle', ({ Provider, model, text, call, error }) => {
  it('executes one actual Runtime tool round and keeps native reasoning out of progress events', async () => {
    class LookupCapability extends Capability {
      get name() {
        return 'fixture';
      }
      get promptFragment() {
        return '';
      }
      get tools() {
        return ['lookup'];
      }
      get allowedTools(): unknown {
        return { lookup: ['invoke'] };
      }
    }
    const catalog = new CapabilityCatalog([
      {
        id: 'lookup',
        title: 'Lookup',
        description: 'fixture',
        lifecycle: 'active',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      } as never,
    ]);
    const execute = vi.fn(async () => ({
      ok: true,
      status: 'success',
      toolId: 'lookup',
      callId: 'host_fixture',
      startedAt: new Date().toISOString(),
      durationMs: 0,
      text: 'found',
      structuredContent: { observed: true },
    }));
    const progress: unknown[] = [];
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(calls++ === 0 ? call() : text()))
    );
    const runtime = new AgentRuntime({
      aiProvider: new Provider({ apiKey: 'test-key', model, maxRetries: 0 }),
      container: { get: () => catalog },
      toolRegistry: new RuntimeCapabilityCatalog() as never,
      toolRouter: { execute } as never,
      strategy: new SingleStrategy(),
      capabilities: [new LookupCapability()],
      onProgress: (event) => progress.push(event),
    });
    await runtime.reactLoop('look up x');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
    expect(JSON.stringify(progress)).not.toContain('sdk_hidden_reasoning');
    expect(JSON.stringify(progress)).not.toContain('sdk_hidden_signature');
  });
  it.each([401, 429, 503])('maps HTTP %s and leaves retries with the Gateway', async (status) => {
    const fetchMock = vi.fn(async () => jsonResponse(error(status), status));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new Provider({ apiKey: 'test-key', model, maxRetries: 0 }).chat('hello')
    ).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('propagates in-flight cancellation and rejects a late response', async () => {
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: (response: Response) => void;
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init: RequestInit) => {
        signal = init.signal;
        started();
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      })
    );
    const controller = new AbortController();
    const pending = new Provider({ apiKey: 'test-key', model, maxRetries: 0 })
      .chat('hello', { abortSignal: controller.signal })
      .catch((err: unknown) => err);
    await fetching;
    controller.abort(new Error('caller stopped'));
    finish(jsonResponse(text()));
    expect(await pending).toMatchObject({ name: 'AbortError' });
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('enforces the actual transport deadline', async () => {
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url, init: RequestInit) => {
        signal = init.signal;
        return new Promise<Response>(() => {});
      })
    );
    await expect(
      new Provider({ apiKey: 'test-key', model, maxRetries: 0, timeout: 20 }).chat('hello')
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(signal?.aborted).toBe(true);
  });
  it('rejects an unsolicited tool when the caller explicitly selected none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(call()))
    );
    await expect(
      new Provider({ apiKey: 'test-key', model, maxRetries: 0 }).chatWithTools('text only', {
        toolSchemas: [
          { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
        ],
        toolChoice: 'none',
      })
    ).rejects.toMatchObject({ code: 'LLM_INVALID_TOOL_CALL' });
  });
});

async function toolRound(provider: AiProvider) {
  const history = new SimpleArrayAdapter();
  const tools = [
    { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
  ];
  history.appendUserMessage('look up x');
  const first = await provider.chatWithTools('', {
    messages: history.toMessages() as UnifiedMessage[],
    toolSchemas: tools,
  });
  history.appendAssistantWithToolCalls(
    first.text,
    first.functionCalls || [],
    first.reasoningContent,
    first.continuation
  );
  for (const call of first.functionCalls || []) {
    history.appendToolResult(call.id, call.name, 'found');
  }
  const second = await provider.chatWithTools('', {
    messages: history.toMessages() as UnifiedMessage[],
    toolSchemas: tools,
  });
  return { first, second };
}

describe('native SDK provider contracts', () => {
  it('keeps local SDK input rejection from poisoning the provider circuit', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        choices: [
          { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'healthy' } },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new LLMGateway({
      providers: { openai: { apiKey: 'test-key' } },
      maxRetries: 0,
      circuitThreshold: 1,
    });
    await expect(
      gateway.embed(
        'openai:gpt-4o',
        Array.from({ length: 2049 }, () => 'text')
      )
    ).rejects.toMatchObject({ code: 'LLM_INVALID_REQUEST' });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(gateway.chat({ modelRef: 'openai:gpt-4o', prompt: 'hello' })).resolves.toBe(
      'healthy'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    'stored-reasoning-v1',
    'content-replay-v1',
  ] as const)('keeps %s messages atomic during public budget compaction', (kind) => {
    const context = new ContextWindow();
    const continuation = (text: string): LlmContinuation => ({
      provider: 'fixture',
      model: 'fixture',
      connection: 'fixture',
      ...(kind === 'stored-reasoning-v1'
        ? { kind, reasoningItemIds: [text] }
        : {
            kind,
            parts: [
              { type: 'reasoning', text: 'private', signature: text },
              { type: 'text', start: 0, end: text.length },
            ],
          }),
    });
    context.appendUserMessage('start');
    context.appendAssistantText('first', '', continuation('first'));
    context.appendAssistantText('second', '', continuation('second'));
    context.appendUserMessage('continue');
    context.appendAssistantText('third', '', continuation('third'));
    const before = structuredClone(context.toMessages());
    context.compactForProviderInputBudget({ maxProjectedMessages: 4, maxProjectedTokens: 100_000 });
    expect(context.toMessages()).toEqual(before);
  });

  it('counts older legacy reasoning that the V4 adapter still replays', () => {
    const estimate = (reasoning: string) => {
      const context = new ContextWindow();
      context.appendUserMessage('start');
      for (let index = 0; index < 3; index++) {
        context.appendAssistantWithToolCalls(
          '',
          [{ id: String(index), name: 'lookup', args: {} }],
          index === 0 ? reasoning : 'recent'
        );
        context.appendToolResult(String(index), 'lookup', 'found');
      }
      return context.estimateTokens();
    };
    expect(estimate('older reasoning '.repeat(500))).toBeGreaterThan(estimate(''));
  });
  it('does not let invalid provider token counts reduce the recorded budget', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'valid answer' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: -1, candidatesTokenCount: 1, totalTokenCount: 0 },
        })
      )
    );
    await expect(
      new GoogleGeminiProvider({ apiKey: 'test-key', maxRetries: 0 }).chatWithTools('hello')
    ).resolves.toMatchObject({ text: 'valid answer', usage: null });
  });
  it('rejects duplicate native call ids before history replay or host execution', async () => {
    const call = {
      id: 'duplicate',
      type: 'function',
      function: { name: 'lookup', arguments: '{"q":"x"}' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: { role: 'assistant', content: '', tool_calls: [call, call] },
            },
          ],
        })
      )
    );
    await expect(
      new DeepSeekProvider({ apiKey: 'test-key', maxRetries: 0 }).chatWithTools('lookup', {
        toolSchemas: [{ name: 'lookup', parameters: { type: 'object' } }],
      })
    ).rejects.toMatchObject({ code: 'LLM_INVALID_TOOL_CALL' });
  });
  it.each([
    {
      name: 'google',
      Transport: GoogleTransport,
      model: 'models/gemini-embedding-001',
      response: { embedding: { values: [1, 2] } },
    },
    {
      name: 'openai',
      Transport: OpenAiTransport,
      model: 'text-embedding-3-small',
      response: { data: [{ index: 0, embedding: [1, 2] }] },
    },
  ])('$name keeps the default embedding model when an optional config field is empty', async ({
    Transport,
    model,
    response,
  }) => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return jsonResponse(response);
      })
    );
    await new Transport({ apiKey: 'test-key', embedModel: '' }).embed(['text']);
    expect(body.model).toBe(model);
  });
  it('cancels Google embedding after a completed batch without starting another retry', async () => {
    const controller = new AbortController();
    let calls = 0;
    let secondSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        calls++;
        if (calls === 1) {
          return jsonResponse({
            embeddings: Array.from({ length: 100 }, (_, index) => ({ values: [index, 1] })),
          });
        }
        secondSignal = init.signal;
        controller.abort(new Error('batch job stopped'));
        return jsonResponse({ embedding: { values: [100, 1] } });
      })
    );
    const gateway = new LLMGateway({
      providers: { google: { apiKey: 'test-key' } },
      maxRetries: 2,
    });
    await expect(
      gateway.embed(
        'google:gemini-2.5-flash',
        Array.from({ length: 101 }, (_, index) => String(index)),
        { abortSignal: controller.signal }
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(secondSignal?.aborted).toBe(true);
    expect(calls).toBe(2);
  });

  it('retains the explicit DeepSeek embedding compatibility endpoint with validated vectors', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return jsonResponse({
          data: [
            { index: 1, embedding: [2, 1] },
            { index: 0, embedding: [1, 1] },
          ],
        });
      })
    );
    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      baseUrl: 'https://compat.example.invalid/v1',
      maxRetries: 0,
    });
    await expect(provider.embed(['a', 'b'])).resolves.toEqual([
      [1, 1],
      [2, 1],
    ]);
    expect(requests).toEqual([
      {
        url: 'https://compat.example.invalid/v1/embeddings',
        body: { model: 'deepseek-embedding', input: ['a', 'b'] },
      },
    ]);
  });
  it('binds DeepSeek reasoning replay to its producing connection', async () => {
    const bodies: Array<{ messages: Array<{ role: string; reasoning_content?: string }> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        const response = providers[2].call();
        if (bodies.length === 1) {
          return jsonResponse({
            ...response,
            choices: [
              {
                ...response.choices[0],
                message: {
                  ...response.choices[0].message,
                  reasoning_content: 'private_v4_reasoning',
                },
              },
            ],
          });
        }
        return jsonResponse(providers[2].text());
      })
    );
    const provider = new DeepSeekProvider({ apiKey: 'first-fixture-key', maxRetries: 0 });
    const { first } = await toolRound(provider);
    expect(first.continuation).toMatchObject({ kind: 'content-replay-v1', provider: 'deepseek' });
    expect(
      bodies[1].messages.find((message) => message.role === 'assistant')?.reasoning_content
    ).toBe('private_v4_reasoning');
    await new DeepSeekProvider({ apiKey: 'second-fixture-key', maxRetries: 0 }).chatWithTools('', {
      messages: [
        {
          role: 'assistant',
          content: first.text,
          reasoningContent: first.reasoningContent,
          continuation: first.continuation,
          toolCalls: first.functionCalls || [],
        },
        { role: 'tool', toolCallId: 'c1', name: 'lookup', content: 'found' },
      ],
      toolSchemas: [{ name: 'lookup', parameters: { type: 'object' } }],
    });
    expect(
      bodies[2].messages.find((message) => message.role === 'assistant')?.reasoning_content
    ).not.toBe('private_v4_reasoning');
  });
  it('applies the same explicit tool-disable contract to the existing OpenAI adapter', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(providers[2].call()))
    );
    await expect(
      new OpenAiProvider({ apiKey: 'test-key', model: 'gpt-4o', maxRetries: 0 }).chatWithTools(
        'text only',
        {
          toolSchemas: [{ name: 'lookup', parameters: { type: 'object' } }],
          toolChoice: 'none',
        }
      )
    ).rejects.toMatchObject({ code: 'LLM_INVALID_TOOL_CALL' });
  });
  it('honors Google endpoint environment configuration at the public facade', async () => {
    vi.stubEnv('ALEMBIC_GOOGLE_BASE_URL', 'https://google-relay.example.invalid/v1beta');
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      jsonResponse(providers[0].text())
    );
    vi.stubGlobal('fetch', fetchMock);
    await new GoogleGeminiProvider({ apiKey: 'test-key', maxRetries: 0 }).chat('hello');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'https://google-relay.example.invalid/v1beta/models/'
    );
  });
  it('honors explicit Claude retry configuration while keeping SDK attempts single', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(providers[1].error(503), 503))
      .mockImplementation(async () => jsonResponse(providers[1].text()));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new ClaudeProvider({ apiKey: 'test-key', maxRetries: 1 }).chat('hello')
    ).resolves.toBe('done');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('rejects malformed DeepSeek native tool arguments without fabricating an empty call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          id: 'ds_fixture',
          object: 'chat.completion',
          created: 1,
          model: 'deepseek-v4-pro',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                reasoning_content: 'think',
                tool_calls: [
                  { id: 'bad', type: 'function', function: { name: 'lookup', arguments: '{' } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      )
    );
    const provider = new DeepSeekProvider({
      apiKey: 'test-key',
      model: 'deepseek-v4-pro',
      maxRetries: 0,
    });
    await expect(
      provider.chatWithTools('lookup', {
        toolSchemas: [{ name: 'lookup', parameters: { type: 'object' } }],
      })
    ).rejects.toMatchObject({ code: 'LLM_INVALID_TOOL_CALL' });
  });
  it('replays Claude thinking, redacted blocks and tool calls in their original order', async () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'sig_empty' },
      { type: 'text', text: 'Before' },
      { type: 'tool_use', id: 'c1', name: 'lookup', input: { q: 'x' } },
      { type: 'redacted_thinking', data: 'opaque_redacted' },
      { type: 'text', text: 'After' },
    ];
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return jsonResponse({
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          stop_reason: bodies.length === 1 ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          content: bodies.length === 1 ? content : [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      })
    );
    const { first, second } = await toolRound(new ClaudeProvider({ apiKey: 'test-key' }));
    expect(first.text).toBe('Before\nAfter');
    expect(second.text).toBe('done');
    expect(bodies[1].messages.find((message) => message.role === 'assistant')?.content).toEqual(
      content
    );
  });

  it('replays Google thinking, text and function-call signatures through message history', async () => {
    const parts = [
      { text: 'private reasoning', thought: true, thoughtSignature: 'sig_thinking' },
      { text: 'Looking', thoughtSignature: 'sig_text' },
      {
        functionCall: { id: 'g1', name: 'lookup', args: { q: 'x' } },
        thoughtSignature: 'sig_call',
      },
    ];
    const bodies: Array<{ contents: Array<{ role: string; parts: unknown[] }> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return jsonResponse({
          candidates: [
            {
              content: { role: 'model', parts: bodies.length === 1 ? parts : [{ text: 'done' }] },
              finishReason: 'STOP',
            },
          ],
        });
      })
    );
    const { first, second } = await toolRound(
      new GoogleGeminiProvider({
        apiKey: 'test-key',
        model: 'gemini-3-flash-preview',
        maxRetries: 0,
      })
    );
    expect(first.text).toBe('Looking');
    expect(second.text).toBe('done');
    expect(bodies[1].contents.find((message) => message.role === 'model')?.parts).toEqual(parts);
  });
  it('preserves Claude stop reason and complete cache accounting without exposing thinking as text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          stop_reason: 'end_turn',
          stop_sequence: null,
          content: [
            { type: 'thinking', thinking: 'private reasoning', signature: 'sig_fixture' },
            { type: 'text', text: 'done' },
          ],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 3,
          },
        })
      )
    );
    const provider = new ClaudeProvider({ apiKey: 'test-key' });
    await expect(provider.chatWithTools('hello')).resolves.toMatchObject({
      text: 'done',
      reasoningContent: 'private reasoning',
      finishReason: 'end_turn',
      usage: {
        inputTokens: 17,
        outputTokens: 5,
        totalTokens: 22,
        cacheHitTokens: 4,
        cacheWriteTokens: 3,
      },
    });
  });

  it('retries only the failed Google embedding batch and preserves completed batch order', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const starts: number[] = [];
    let failedSecond = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const inputs: string[] = body.requests
          ? body.requests.map(
              (entry: { content: { parts: { text: string }[] } }) => entry.content.parts[0].text
            )
          : [body.content.parts[0].text];
        starts.push(Number(inputs[0]));
        if (starts.at(-1) === 100 && !failedSecond) {
          failedSecond = true;
          return jsonResponse(
            { error: { code: 503, message: 'retry second batch', status: 'UNAVAILABLE' } },
            503
          );
        }
        const vectors = inputs.map((input) => ({ values: [Number(input), 1] }));
        return jsonResponse(
          String(url).includes(':embedContent')
            ? { embedding: vectors[0] }
            : { embeddings: vectors }
        );
      })
    );
    const gateway = new LLMGateway({
      providers: { google: { apiKey: 'test-key' } },
      maxRetries: 1,
    });
    const vectors = await gateway.embed(
      'google:gemini-2.5-flash',
      Array.from({ length: 101 }, (_, index) => String(index))
    );
    expect(vectors).toEqual(Array.from({ length: 101 }, (_, index) => [index, 1]));
    expect(starts).toEqual([0, 100, 100]);
  });

  it('keeps Google thinking out of visible text and reports complete usage and finish reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'private reasoning', thought: true }, { text: 'done' }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            thoughtsTokenCount: 3,
            totalTokenCount: 18,
            cachedContentTokenCount: 2,
          },
        })
      )
    );
    const provider = new GoogleGeminiProvider({
      apiKey: 'test-key',
      model: 'gemini-2.5-flash',
      maxRetries: 0,
    });
    await expect(provider.chatWithTools('hello')).resolves.toMatchObject({
      text: 'done',
      reasoningContent: 'private reasoning',
      finishReason: 'STOP',
      usage: {
        inputTokens: 10,
        outputTokens: 8,
        totalTokens: 18,
        reasoningTokens: 3,
        cacheHitTokens: 2,
      },
    });
  });
});
