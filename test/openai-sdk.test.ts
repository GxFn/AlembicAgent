import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/ContextWindow.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { ContextWindowAdapter, SimpleArrayAdapter } from '../src/agent/runtime/MessageAdapter.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';
import type { UnifiedMessage } from '../src/ai/contracts.js';
import { LLMGateway } from '../src/ai/gateway/LLMGateway.js';
import { OllamaProvider } from '../src/ai/providers/OllamaProvider.js';
import { OpenAiProvider } from '../src/ai/providers/OpenAiProvider.js';
import { OpenAiTransport } from '../src/ai/transport/OpenAiTransport.js';
import { CapabilityCatalog } from '../src/tools/catalog/CapabilityCatalog.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';
import { Capability } from '../src/tools/runtime/toolsets/Capability.js';
import { responsesText } from './helpers/mockFetch.js';

function reply(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function chatReply(content: string | null = 'done', toolCalls?: unknown[]) {
  return {
    id: 'chat-fixture',
    created: 1,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
        message: { role: 'assistant', content, tool_calls: toolCalls },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('OpenAI SDK transport contract', () => {
  it('does not replay stored reasoning across different provider connections', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return reply({
          status: 'completed',
          output:
            bodies.length === 1
              ? [{ type: 'reasoning', id: 'rs_connection', summary: [] }, responsesText('first')]
              : [responsesText('second')],
        });
      })
    );
    const config = { apiKey: 'test-key', apiStyle: 'responses', model: 'gpt-4o', maxRetries: 0 };
    const first = await new OpenAiProvider({
      ...config,
      baseUrl: 'https://first.example.invalid/v1',
    }).chatWithTools('first');
    await new OpenAiProvider({
      ...config,
      baseUrl: 'https://second.example.invalid/v1',
    }).chatWithTools('', {
      messages: [
        { role: 'assistant', content: first.text, continuation: first.continuation },
        { role: 'user', content: 'continue' },
      ],
    });
    expect(bodies[1].input).not.toContainEqual({ type: 'item_reference', id: 'rs_connection' });
  });
  it.each([
    200, 401,
  ])('does not copy HTTP %s raw SDK payloads into propagated errors', async (status) => {
    const privateMarker = 'fixture-private-response';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply(
          status === 401 ? { error: { message: privateMarker } } : { unexpected: privateMarker },
          status
        )
      )
    );
    const error = await new OpenAiTransport({ apiKey: 'test-key' })
      .chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(privateMarker);
    expect(String((error as Error).cause)).not.toContain(privateMarker);
  });
  it('keeps Ollama identity and protocol separate from OpenAI global defaults', async () => {
    vi.stubEnv('ALEMBIC_OPENAI_API_STYLE', 'responses');
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        requests.push(String(url));
        return reply({ error: { message: 'denied' } }, 401);
      })
    );
    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434/v1', maxRetries: 0 });
    await expect(provider.chat('hello')).rejects.toThrow('ollama API request failed (HTTP 401)');
    expect(requests).toEqual(['http://localhost:11434/v1/chat/completions']);
  });

  it.each([401, 429, 503])('normalizes HTTP %s without adding SDK retries', async (status) => {
    const fetchMock = vi.fn(async () =>
      reply({ error: { message: 'fixture failure' } }, status, { 'retry-after': '7' })
    );
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new LLMGateway({
      providers: { openai: { apiKey: 'test-key' } },
      maxRetries: 0,
    });
    await expect(
      gateway.chat({ modelRef: 'openai:gpt-4o', prompt: 'hello' })
    ).rejects.toMatchObject({ status, retryAfterMs: 7000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lets the gateway retry one failed attempt without SDK retry multiplication', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply({ error: { message: 'unavailable' } }, 503))
      .mockImplementation(async () => reply(chatReply()));
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new LLMGateway({
      providers: { openai: { apiKey: 'test-key' } },
      maxRetries: 1,
    });
    await expect(gateway.chat({ modelRef: 'openai:gpt-4o', prompt: 'hello' })).resolves.toBe(
      'done'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('restores embedding input order from validated native response indexes', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return reply({
          data: [
            { index: 1, embedding: [3, 4] },
            { index: 0, embedding: [1, 2] },
          ],
        });
      })
    );
    const provider = new OpenAiProvider({
      apiKey: 'test-key',
      embedModel: 'text-embedding-3-small',
      maxRetries: 0,
    });
    await expect(provider.embed(['first', 'second'])).resolves.toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(bodies[0]).toMatchObject({
      model: 'text-embedding-3-small',
      input: ['first', 'second'],
    });
  });

  it('rejects a partial embedding response at the transport boundary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply({ data: [{ index: 0, embedding: [1, 2] }] }))
    );
    await expect(
      new OpenAiTransport({ apiKey: 'test-key' }).embed(['first', 'second'])
    ).rejects.toThrow('count');
  });
  it('records known usage when a completed model response contains an invalid tool call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply(
          chatReply(null, [
            {
              id: 'call-invalid',
              type: 'function',
              function: { name: 'edit', arguments: '{' },
            },
          ])
        )
      )
    );
    const onUsage = vi.fn();
    const gateway = new LLMGateway({
      providers: { openai: { apiKey: 'test-key' } },
      maxRetries: 0,
      onUsage,
    });
    await expect(
      gateway.chatWithTools({
        modelRef: 'openai:gpt-4o',
        messages: [{ role: 'user', content: 'edit' }],
        tools: [{ name: 'edit', parameters: { type: 'object' } }],
      })
    ).rejects.toMatchObject({ code: 'LLM_INVALID_TOOL_CALL' });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ totalTokens: 15 }));
  });

  it('runs a native SDK tool round through the actual AgentRuntime exactly once', async () => {
    class FlatCapability extends Capability {
      get name() {
        return 'fixture';
      }
      get promptFragment() {
        return '';
      }
      get tools() {
        return ['flat'];
      }
      get allowedTools(): unknown {
        return { flat: ['invoke'] };
      }
    }
    const catalog = new CapabilityCatalog([
      {
        id: 'flat',
        title: 'Flat',
        description: 'fixture',
        lifecycle: 'active',
        inputSchema: {
          type: 'object',
          required: ['input'],
          properties: { input: { type: 'string' } },
        },
      } as never,
    ]);
    const execute = vi.fn(async () => ({
      ok: true,
      status: 'success',
      toolId: 'flat',
      callId: 'call_fixture',
      startedAt: new Date().toISOString(),
      durationMs: 0,
      text: 'found',
      structuredContent: { observed: true },
    }));
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return reply({
          status: 'completed',
          output:
            bodies.length === 1
              ? [
                  { type: 'reasoning', id: 'rs_runtime', summary: [] },
                  {
                    type: 'function_call',
                    id: 'fc_runtime',
                    call_id: 'call_fixture',
                    name: 'flat',
                    arguments: '{"input":"value"}',
                  },
                ]
              : [responsesText('done')],
        });
      })
    );
    const runtime = new AgentRuntime({
      aiProvider: new OpenAiProvider({
        apiKey: 'test-key',
        model: 'gpt-4o',
        apiStyle: 'responses',
        maxRetries: 0,
      }),
      container: { get: () => catalog },
      toolRegistry: new RuntimeCapabilityCatalog() as never,
      toolRouter: { execute } as never,
      strategy: new SingleStrategy(),
      capabilities: [new FlatCapability()],
    });
    await runtime.reactLoop('call flat');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].input).toContainEqual({ type: 'item_reference', id: 'rs_runtime' });
  });
  it('returns the provider finish reason and detailed usage to the real gateway', async () => {
    const fetchMock = vi.fn(async () => reply(chatReply()));
    vi.stubGlobal('fetch', fetchMock);
    const gateway = new LLMGateway({
      providers: { openai: { apiKey: 'test-key' } },
      maxRetries: 0,
    });
    await expect(
      gateway.chatWithTools({
        modelRef: 'openai:gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      })
    ).resolves.toMatchObject({
      text: 'done',
      finishReason: 'stop',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheHitTokens: 3,
        reasoningTokens: 2,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed tool arguments instead of inventing an executable empty object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply(
          chatReply(null, [
            {
              id: 'call-invalid',
              type: 'function',
              function: { name: 'edit', arguments: '{' },
            },
          ])
        )
      )
    );
    const transport = new OpenAiTransport({ apiKey: 'test-key' });
    await expect(
      transport.chatWithTools({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'edit' }],
        tools: [{ name: 'edit', parameters: { type: 'object' } }],
      })
    ).rejects.toMatchObject({ code: 'LLM_INVALID_TOOL_CALL' });
  });

  it.each([
    'simple',
    'context-window',
  ] as const)('preserves Responses reasoning references across the %s tool round', async (mode) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return reply({
          id: `response-${bodies.length}`,
          status: 'completed',
          output:
            bodies.length === 1
              ? [
                  { type: 'reasoning', id: 'rs_fixture', summary: [] },
                  {
                    type: 'function_call',
                    id: 'fc_fixture',
                    call_id: 'call_fixture',
                    name: 'lookup',
                    arguments: '{"q":"x"}',
                  },
                ]
              : [responsesText('done')],
        });
      })
    );
    const provider = new OpenAiProvider({
      apiKey: 'test-key',
      model: 'gpt-4o',
      apiStyle: 'responses',
      maxRetries: 0,
    });
    const messages =
      mode === 'simple' ? new SimpleArrayAdapter() : new ContextWindowAdapter(new ContextWindow());
    const tools = [
      { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
    ];
    messages.appendUserMessage('look up x');
    const first = await provider.chatWithTools('', {
      messages: messages.toProjectedMessages() as UnifiedMessage[],
      toolSchemas: tools,
    });
    messages.appendAssistantWithToolCalls(
      first.text,
      first.functionCalls || [],
      first.reasoningContent,
      first.continuation
    );
    messages.appendToolResult('call_fixture', 'lookup', 'found');
    const second = await provider.chatWithTools('', {
      messages: messages.toProjectedMessages() as UnifiedMessage[],
      toolSchemas: tools,
    });
    expect(second.text).toBe('done');
    expect(bodies[1].input).toContainEqual({ type: 'item_reference', id: 'rs_fixture' });
    expect(bodies[1].input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_fixture',
      output: 'found',
    });
  });
});
