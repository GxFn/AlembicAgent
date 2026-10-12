/**
 * L3-C02 回归：D23 秘密/私有字段（apiKey、hostCredential、threadId、reasoningContent、
 * thoughtSignature、hiddenReasoning、rawProvider*、legacyCompatibility）必须在模型能看到的
 * 真实出口上被清理。
 *
 * 模型拿到的工具结果来自 runtimeBridge 写入的 metadata.envelope（projectToolReceipt 读
 * envelope.text），以及 executeRuntimeToolCall 的返回值（记忆、证据、观察者读取）。此前带
 * structuredContent 的信封在这两处都原样透传；只有纯文本信封走默认投影，又在任意深度误删
 * error.message 这类业务字段。
 *
 * 夹具优先经真实 ToolRouterAdapter 与真实 handler 产出；只有“宿主路由自己转发 JSON 文本”
 * 和“非 adapter 路由返回非 JSON 形态”两种场景使用假路由，因为 adapter 本身不会产出它们。
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { DiagnosticsCollector } from '../src/agent/runtime/DiagnosticsCollector.js';
import type {
  ToolMetadata,
  ToolPipelineContext,
} from '../src/agent/runtime/toolPipeline/contracts.js';
import { executeRuntimeToolCall } from '../src/agent/runtime/toolPipeline/runtimeBridge.js';
import type { ToolCallRequest, ToolResultEnvelope } from '../src/tools/kernel/index.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';
import { type ToolContext, ToolRouterAdapter } from '../src/tools/runtime/index.js';

const SECRET_VALUES = [
  'fixture-api-key-value',
  'fixture-thread-id-value',
  'fixture-reasoning-value',
  'fixture-host-credential-value',
  'fixture-raw-provider-value',
  'fixture-thought-signature-value',
] as const;

type Router = (request: ToolCallRequest) => Promise<ToolResultEnvelope>;

function freshMetadata(): ToolMetadata {
  return { cacheHit: false, blocked: false, isNew: false, durationMs: 0 };
}

function bridgeContext(
  execute: Router,
  diagnostics: DiagnosticsCollector | null,
  allowedToolIds: string[],
  logger: { warn: (...args: unknown[]) => unknown } | null = null
): ToolPipelineContext {
  return {
    runtime: {
      id: 'private-fields-runtime',
      presetName: 'private-fields-preset',
      policies: {},
      toolRouter: { execute },
      logger,
    },
    loopCtx: {
      allowedToolIds,
      allowedToolActions: {},
      iteration: 1,
      source: 'private-fields-source',
      diagnostics,
    },
    iteration: 1,
  } as unknown as ToolPipelineContext;
}

/** 真实 adapter：只注入宿主端口，信封形状完全由 ToolRouterAdapter 与 handler 决定。 */
function adapterRouter(ports: Partial<ToolContext>): Router {
  const adapter = new ToolRouterAdapter({
    contextFactory: {
      create: () => ({ projectRoot: process.cwd(), tokenBudget: 4000, ...ports }),
    },
  });
  return (request) => adapter.execute(request);
}

function knowledgeDetailCall() {
  return {
    id: 'model-call',
    name: 'knowledge',
    args: { action: 'detail', params: { id: 'receipt-fixture' } },
  };
}

function hostEnvelope(
  overrides: Partial<ToolResultEnvelope> & Pick<ToolResultEnvelope, 'text'>
): ToolResultEnvelope {
  return {
    ok: true,
    toolId: 'host.tool',
    callId: 'host-call',
    startedAt: '2026-10-11T00:00:00.000Z',
    durationMs: 1,
    status: 'success',
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [],
      timedOutStages: [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [],
    },
    trust: {
      source: 'internal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
    ...overrides,
  };
}

/** 收集任意深度的键名，用于断言私有键已不在模型可见结构里。 */
function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectKeys);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => [key, ...collectKeys(child)]);
}

/** 模型与下游消费者能读到的全部载体：返回值、信封 structuredContent 与信封 text。 */
function modelVisibleCarriers(result: unknown, metadata: ToolMetadata): string {
  return JSON.stringify([
    result,
    metadata.envelope?.structuredContent ?? null,
    metadata.envelope?.text ?? null,
  ]);
}

function expectNoSecretValues(serialized: string) {
  for (const secret of SECRET_VALUES) {
    expect(serialized).not.toContain(secret);
  }
}

describe('runtime bridge D23 private fields on the structured path', () => {
  it('removes threadId, reasoningContent and apiKey from the result the model receives', async () => {
    const diagnostics = new DiagnosticsCollector();
    const metadata = freshMetadata();
    const dto = {
      id: 'receipt-fixture',
      threadId: 'fixture-thread-id-value',
      reasoningContent: 'fixture-reasoning-value',
      apiKey: 'fixture-api-key-value',
      items: [{ id: 'item-1', title: 'kept item' }],
    };

    const result = await executeRuntimeToolCall(
      knowledgeDetailCall(),
      bridgeContext(adapterRouter({ knowledgeRead: { getById: async () => dto } }), diagnostics, [
        'knowledge',
      ]),
      metadata
    );

    expect(result).toEqual({
      id: 'receipt-fixture',
      items: [{ id: 'item-1', title: 'kept item' }],
    });
    expect(metadata.envelope?.structuredContent).toEqual(result);
    expect(JSON.parse(metadata.envelope?.text ?? 'null')).toEqual(result);
    expectNoSecretValues(modelVisibleCarriers(result, metadata));
    // 原 DTO 不被改写：清理只作用于交给模型的副本。
    expect(dto.apiKey).toBe('fixture-api-key-value');
    const warning = diagnostics
      .toJSON()
      .warnings.find((entry) => entry.code === 'TOOL_RESULT_PRIVATE_FIELDS_REDACTED');
    expect(warning).toMatchObject({ tool: 'knowledge' });
    expect(warning?.message).toContain('apiKey');
    expect(warning?.message).toContain('threadId');
    expect(warning?.message).toContain('reasoningContent');
    expectNoSecretValues(String(warning?.message));
  });

  it('matches normalized spellings, plurals and prefixed names at any depth and inside wrappers', async () => {
    const metadata = freshMetadata();
    const dto = {
      id: 'receipt-fixture',
      api_key: 'fixture-api-key-value',
      'API-KEY': 'fixture-api-key-value',
      ApiKey: 'fixture-api-key-value',
      'provider.apiKey': 'fixture-api-key-value',
      'api key': 'fixture-api-key-value',
      ａｐｉＫｅｙ: 'fixture-api-key-value',
      headers: { 'x-api-key': 'fixture-api-key-value', accept: 'application/json' },
      openaiApiKey: 'fixture-api-key-value',
      apiKeys: ['fixture-api-key-value'],
      THREAD_ID: 'fixture-thread-id-value',
      thread_ids: ['fixture-thread-id-value'],
      'reasoning-content': 'fixture-reasoning-value',
      REASONING_CONTENT: 'fixture-reasoning-value',
      thought_signature: 'fixture-thought-signature-value',
      hidden_reasoning: 'fixture-reasoning-value',
      'host-credential': 'fixture-host-credential-value',
      raw_provider_response: { body: 'fixture-raw-provider-value' },
      RawProviderRequest: { prompt: 'fixture-raw-provider-value' },
      legacy_compatibility: { note: 'fixture-raw-provider-value' },
      items: [
        { id: 'item-1', meta: { apiKey: 'fixture-api-key-value', label: 'kept label' } },
        [{ threadId: 'fixture-thread-id-value', ok: true }],
      ],
      data: { result: { payload: { wrapper: { threadId: 'fixture-thread-id-value' } } } },
    };

    const result = await executeRuntimeToolCall(
      knowledgeDetailCall(),
      bridgeContext(adapterRouter({ knowledgeRead: { getById: async () => dto } }), null, [
        'knowledge',
      ]),
      metadata
    );

    expectNoSecretValues(modelVisibleCarriers(result, metadata));
    expect(result).toMatchObject({
      id: 'receipt-fixture',
      headers: { accept: 'application/json' },
      items: [{ id: 'item-1', meta: { label: 'kept label' } }, [{ ok: true }]],
      data: { result: { payload: { wrapper: {} } } },
    });
  });

  it('keeps business fields whose names only resemble private fields', async () => {
    const metadata = freshMetadata();
    const dto = {
      id: 'receipt-fixture',
      message: 'root business message',
      success: true,
      reasoning: { sources: ['src/a.ts:1-3'], whyStandard: 'kept rationale' },
      reasoningSources: ['src/b.ts:4-5'],
      reasoningWhyStandard: 'kept why',
      raw: 'src/raw.ts:1',
      rawScore: 0.42,
      rawContent: 'kept raw content',
      thread: 'kept thread label',
      keyword: 'kept keyword',
      violation: { code: 'V1', message: 'kept violation message', nextAction: 'fix it' },
    };

    const result = await executeRuntimeToolCall(
      knowledgeDetailCall(),
      bridgeContext(adapterRouter({ knowledgeRead: { getById: async () => dto } }), null, [
        'knowledge',
      ]),
      metadata
    );

    expect(result).toEqual(dto);
  });

  it('removes a private field spelled as a nested object path', async () => {
    // Codex 风格的宿主回执常写成 {thread:{id}}；它与扁平键 thread.id / threadId 是同一字段。
    const diagnostics = new DiagnosticsCollector();
    const metadata = freshMetadata();
    const dto = {
      id: 'receipt-fixture',
      thread: { id: 'fixture-thread-id-value', title: 'kept thread title' },
      provider: { name: 'kept provider', api: { key: 'fixture-api-key-value' } },
      reasoning: { content: 'fixture-reasoning-value', sources: ['src/a.ts:1-3'] },
      runs: [{ host: { credential: 'fixture-host-credential-value' }, status: 'done' }],
    };

    const result = await executeRuntimeToolCall(
      knowledgeDetailCall(),
      bridgeContext(adapterRouter({ knowledgeRead: { getById: async () => dto } }), diagnostics, [
        'knowledge',
      ]),
      metadata
    );

    expectNoSecretValues(modelVisibleCarriers(result, metadata));
    expect(result).toEqual({
      id: 'receipt-fixture',
      thread: { title: 'kept thread title' },
      provider: { name: 'kept provider', api: {} },
      reasoning: { sources: ['src/a.ts:1-3'] },
      runs: [{ host: {}, status: 'done' }],
    });
    const warning = diagnostics
      .toJSON()
      .warnings.find((entry) => entry.code === 'TOOL_RESULT_PRIVATE_FIELDS_REDACTED');
    expect(warning?.message).toContain('thread.id');
    expect(warning?.message).toContain('provider.api.key');
    expectNoSecretValues(String(warning?.message));
  });

  it('keeps a value folded into a private key name out of the result and the diagnostics', async () => {
    const diagnostics = new DiagnosticsCollector();
    const metadata = freshMetadata();
    const dto = {
      id: 'receipt-fixture',
      'apiKey=fixture-api-key-value': true,
      meta: { 'threadId: fixture-thread-id-value': 1 },
    };

    const result = await executeRuntimeToolCall(
      knowledgeDetailCall(),
      bridgeContext(adapterRouter({ knowledgeRead: { getById: async () => dto } }), diagnostics, [
        'knowledge',
      ]),
      metadata
    );

    expectNoSecretValues(modelVisibleCarriers(result, metadata));
    expect(result).toEqual({ id: 'receipt-fixture', meta: {} });
    const serializedDiagnostics = JSON.stringify(diagnostics.toJSON());
    expect(serializedDiagnostics).toContain('TOOL_RESULT_PRIVATE_FIELDS_REDACTED');
    expectNoSecretValues(serializedDiagnostics);
  });

  it('redacts a top-level JSON string result in both carriers', async () => {
    const metadata = freshMetadata();
    const payload = JSON.stringify({
      id: 'receipt-fixture',
      nested: { apiKey: 'fixture-api-key-value', kept: 'kept value' },
    });

    const result = await executeRuntimeToolCall(
      knowledgeDetailCall(),
      bridgeContext(adapterRouter({ knowledgeRead: { getById: async () => payload } }), null, [
        'knowledge',
      ]),
      metadata
    );

    expectNoSecretValues(modelVisibleCarriers(result, metadata));
    expect(typeof result).toBe('string');
    expect(JSON.parse(String(result))).toEqual({
      id: 'receipt-fixture',
      nested: { kept: 'kept value' },
    });
  });

  it('keeps the root business message of a real memory result', async () => {
    const metadata = freshMetadata();
    const result = await executeRuntimeToolCall(
      {
        id: 'model-call',
        name: 'memory',
        args: { action: 'get_previous_evidence', params: { query: 'fixture topic' } },
      },
      bridgeContext(adapterRouter({}), null, ['memory']),
      metadata
    );

    expect(result).toMatchObject({ count: 0, items: [] });
    expect(String((result as { message?: unknown }).message)).toContain('fixture topic');
    expect(metadata.envelope?.text).toContain('fixture topic');
  });

  it('keeps object identity and writes no diagnostics when nothing is private', async () => {
    const diagnostics = new DiagnosticsCollector();
    const structured = { id: 'plain', items: [1, 2, 3] };
    const envelope = hostEnvelope({
      text: JSON.stringify(structured, null, 2),
      structuredContent: structured,
    });
    const metadata = freshMetadata();

    const result = await executeRuntimeToolCall(
      { id: 'model-call', name: 'meta', args: { action: 'tools' } },
      bridgeContext(async () => envelope, diagnostics, ['meta']),
      metadata
    );

    expect(result).toBe(structured);
    expect(metadata.envelope).toBe(envelope);
    expect(diagnostics.toJSON().warnings).toEqual([]);
  });
});

describe('runtime bridge D23 on text-only envelopes forwarded by a host router', () => {
  it('keeps nested error.message and removes nested private fields from JSON text', async () => {
    const diagnostics = new DiagnosticsCollector();
    const metadata = freshMetadata();
    const envelope = hostEnvelope({
      ok: false,
      status: 'error',
      text: JSON.stringify({
        error: { code: 403, message: 'permission denied', threadId: 'fixture-thread-id-value' },
      }),
    });

    const result = await executeRuntimeToolCall(
      { id: 'model-call', name: 'meta', args: { action: 'tools' } },
      bridgeContext(async () => envelope, diagnostics, ['meta']),
      metadata
    );

    const projectedText = String((result as { text?: unknown }).text);
    expect(projectedText).toContain('permission denied');
    expect(metadata.envelope?.text).toContain('permission denied');
    expectNoSecretValues(modelVisibleCarriers(result, metadata));
    expect(diagnostics.toJSON().warnings).toContainEqual(
      expect.objectContaining({ code: 'TOOL_RESULT_PRIVATE_FIELDS_REDACTED', tool: 'meta' })
    );
    // 阻断类信封才写 blockedTools；这里只断言模型可见文本已清理。
    expect(collectKeys(JSON.parse(metadata.envelope?.text ?? '{}'))).not.toContain('threadId');
  });

  it('keeps plain, non-JSON text untouched', async () => {
    const envelope = hostEnvelope({ ok: false, status: 'error', text: 'apiKey: not structured' });
    const metadata = freshMetadata();

    await executeRuntimeToolCall(
      { id: 'model-call', name: 'meta', args: { action: 'tools' } },
      bridgeContext(async () => envelope, null, ['meta']),
      metadata
    );

    expect(metadata.envelope).toBe(envelope);
  });

  it.each([
    { label: 'a byte order mark', wrap: (json: string) => `\ufeff${json}` },
    { label: 'non-breaking spaces', wrap: (json: string) => `\u00a0${json}\u00a0` },
    { label: 'surrounding newlines', wrap: (json: string) => `\n\n${json}\n` },
  ])('redacts JSON text wrapped in $label', async ({ wrap }) => {
    const envelope = hostEnvelope({
      ok: false,
      status: 'error',
      text: wrap(
        JSON.stringify({ error: { message: 'kept reason', apiKey: 'fixture-api-key-value' } })
      ),
    });
    const metadata = freshMetadata();

    const result = await executeRuntimeToolCall(
      { id: 'model-call', name: 'meta', args: { action: 'tools' } },
      bridgeContext(async () => envelope, null, ['meta']),
      metadata
    );

    expectNoSecretValues(modelVisibleCarriers(result, metadata));
    expect(metadata.envelope?.text).toContain('kept reason');
  });

  it('rewrites JSON text whose private field sits below the nesting guard', async () => {
    let nested = JSON.stringify({ threadId: 'fixture-thread-id-value' });
    for (let depth = 0; depth < 70; depth++) {
      nested = `{"child":${nested}}`;
    }
    const envelope = hostEnvelope({ ok: false, status: 'error', text: nested });
    const metadata = freshMetadata();

    const result = await executeRuntimeToolCall(
      { id: 'model-call', name: 'meta', args: { action: 'tools' } },
      bridgeContext(async () => envelope, null, ['meta']),
      metadata
    );

    expectNoSecretValues(modelVisibleCarriers(result, metadata));
    expect(metadata.envelope?.text).toContain('[unavailable: display limit]');
  });
});

describe('runtime bridge D23 against non-JSON shapes from a non-adapter router', () => {
  it.each([
    {
      label: 'own toJSON that re-injects a private field',
      create: () => ({
        id: 'host-dto',
        toJSON: () => ({ id: 'host-dto', apiKey: 'fixture-api-key-value' }),
      }),
    },
    {
      label: 'class with a prototype toJSON',
      create: () =>
        new (class {
          id = 'host-dto';
          toJSON() {
            return { id: 'host-dto', threadId: 'fixture-thread-id-value' };
          }
        })(),
    },
    {
      label: 'array with an own toJSON',
      create: () => ({
        id: 'host-dto',
        list: Object.assign([1, 2], {
          toJSON: () => ({ apiKey: 'fixture-api-key-value' }),
        }),
      }),
    },
    {
      label: 'accessor named like a private field',
      create: () =>
        Object.defineProperty({ id: 'host-dto' }, 'apiKey', {
          enumerable: true,
          get: () => 'fixture-api-key-value',
        }),
    },
    {
      label: 'private field below the nesting guard',
      create: () => {
        const root: Record<string, unknown> = { id: 'host-dto' };
        let cursor = root;
        for (let depth = 0; depth < 70; depth++) {
          const next: Record<string, unknown> = {};
          cursor.child = next;
          cursor = next;
        }
        cursor.threadId = 'fixture-thread-id-value';
        return root;
      },
    },
  ])('does not hand a private field to the model through $label', async ({ create }) => {
    const structured = create();
    const metadata = freshMetadata();
    const warn = vi.fn();
    const envelope = hostEnvelope({ text: 'host summary', structuredContent: structured });

    const result = await executeRuntimeToolCall(
      { id: 'model-call', name: 'meta', args: { action: 'tools' } },
      bridgeContext(async () => envelope, null, ['meta'], { warn }),
      metadata
    );

    expectNoSecretValues(modelVisibleCarriers(result, metadata));
    expect(JSON.stringify(result)).toContain('host-dto');
    // 没有诊断收集器时降级为 runtime.logger 告警，清理/规范化路径仍可定位。
    expect(warn).toHaveBeenCalled();
    expectNoSecretValues(JSON.stringify(warn.mock.calls));
  });
});

describe('model history through AgentRuntime', () => {
  it('never puts private host fields into the next model request', async () => {
    const dto = {
      id: 'receipt-fixture',
      title: 'business-marker-title',
      threadId: 'fixture-thread-id-value',
      reasoningContent: 'fixture-reasoning-value',
      apiKey: 'fixture-api-key-value',
      nested: { raw_provider_response: { body: 'fixture-raw-provider-value' } },
    };
    const router = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({
          projectRoot: process.cwd(),
          tokenBudget: 4000,
          knowledgeRead: { getById: async () => dto },
        }),
      },
    });
    const responses: Array<Record<string, unknown>> = [
      {
        functionCalls: [
          {
            id: 'detail-call',
            name: 'knowledge',
            args: { action: 'detail', params: { id: 'receipt-fixture' } },
          },
        ],
      },
      { text: 'done' },
    ];
    const chatWithTools = vi.fn(async () => responses.shift() ?? { text: 'done' });
    const runtime = new AgentRuntime({
      aiProvider: { name: 'mock', chatWithTools } as never,
      toolRegistry: new RuntimeCapabilityCatalog(),
      container: { get: () => new RuntimeCapabilityCatalog() },
      toolRouter: router,
      projectRoot: process.cwd(),
      additionalTools: ['knowledge'],
    });

    const result = await runtime.reactLoop('inspect the receipt', {
      budgetOverride: { maxIterations: 3 },
    });

    expect(chatWithTools.mock.calls.length).toBeGreaterThanOrEqual(2);
    const secondCall = JSON.stringify(chatWithTools.mock.calls[1] ?? []);
    expect(secondCall).toContain('business-marker-title');
    expectNoSecretValues(secondCall);
    expectNoSecretValues(JSON.stringify(result.toolCalls));
    expect(result.diagnostics?.warnings).toContainEqual(
      expect.objectContaining({ code: 'TOOL_RESULT_PRIVATE_FIELDS_REDACTED', tool: 'knowledge' })
    );
  });
});
