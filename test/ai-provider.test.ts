import Logger from '@alembic/core/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMGateway } from '../src/ai/gateway/LLMGateway.js';
import {
  isDeepSeekV4Family,
  isTextCompatToolCallId,
  resolveModelQuirks,
} from '../src/ai/registry/ModelQuirks.js';
import { CLAUDE_MODELS } from '../src/ai/registry/models/claude.js';
import { DEEPSEEK_MODELS } from '../src/ai/registry/models/deepseek.js';
import { GOOGLE_MODELS } from '../src/ai/registry/models/google.js';
import { OLLAMA_MODELS } from '../src/ai/registry/models/ollama.js';
import { OPENAI_MODELS } from '../src/ai/registry/models/openai.js';
import { OpenAiTransport } from '../src/ai/transport/OpenAiTransport.js';
import {
  autoDetectProvider,
  ClaudeProvider,
  createProvider,
  DeepSeekProvider,
  GoogleGeminiProvider,
  getProviderConfig,
  type ModelDef,
  ModelRegistry,
  OpenAiProvider,
  ParameterGuard,
  PROVIDER_CONFIGS,
} from '../src/index.js';
import { jsonResponse, mockJsonFetch } from './helpers/mockFetch.js';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function createThinkingModel(): ModelDef {
  return {
    id: 'openai:test-thinking',
    displayName: 'Test Thinking Model',
    provider: 'openai',
    apiModelId: 'test-thinking',
    contextWindow: 4096,
    maxOutputTokens: 1024,
    capabilities: {
      toolCalling: true,
      vision: false,
      embedding: true,
      jsonMode: true,
      streaming: false,
    },
    reasoning: {
      supported: true,
      mode: 'thinking',
      defaultEffort: 'medium',
      effortLevels: ['low', 'medium', 'high'],
    },
    parameterConstraints: {
      temperature: { allowed: true, min: 0, max: 1 },
      topP: { allowed: false },
      topK: { allowed: true, min: 1, max: 100 },
      toolChoice: { allowed: true, disabledWhen: 'thinking' },
      reasoningEffort: { allowed: true, allowedValues: ['low', 'medium', 'high'] },
    },
  };
}

describe('AI provider public entrypoint', () => {
  it('reports Claude embedding as unsupported so the host can choose a fallback', () => {
    expect(new ClaudeProvider({ apiKey: 'test-key' }).supportsEmbedding()).toBe(false);
  });
  it('exports provider configuration and model routing helpers', () => {
    expect(PROVIDER_CONFIGS.length).toBeGreaterThan(0);
    expect(getProviderConfig('openai')).toMatchObject({
      defaultModelId: 'openai:gpt-5.5',
      keyEnvVar: 'ALEMBIC_OPENAI_API_KEY',
    });
    expect(new ModelRegistry().resolveOrCreate('openai', 'dynamic-test')).toMatchObject({
      id: 'openai:dynamic-test',
      provider: 'openai',
      apiModelId: 'dynamic-test',
    });
  });

  it('does not expose a product test provider or fallback when credentials are absent', () => {
    const saved = {
      provider: process.env.ALEMBIC_AI_PROVIDER,
      google: process.env.ALEMBIC_GOOGLE_API_KEY,
      openai: process.env.ALEMBIC_OPENAI_API_KEY,
      claude: process.env.ALEMBIC_CLAUDE_API_KEY,
      deepseek: process.env.ALEMBIC_DEEPSEEK_API_KEY,
    };
    delete process.env.ALEMBIC_AI_PROVIDER;
    delete process.env.ALEMBIC_GOOGLE_API_KEY;
    delete process.env.ALEMBIC_OPENAI_API_KEY;
    delete process.env.ALEMBIC_CLAUDE_API_KEY;
    delete process.env.ALEMBIC_DEEPSEEK_API_KEY;

    try {
      expect(autoDetectProvider()).toBeNull();
      expect(() => createProvider({ provider: `${'mo'}${'ck'}` })).toThrow(/Unknown AI provider/);
    } finally {
      restoreEnv('ALEMBIC_AI_PROVIDER', saved.provider);
      restoreEnv('ALEMBIC_GOOGLE_API_KEY', saved.google);
      restoreEnv('ALEMBIC_OPENAI_API_KEY', saved.openai);
      restoreEnv('ALEMBIC_CLAUDE_API_KEY', saved.claude);
      restoreEnv('ALEMBIC_DEEPSEEK_API_KEY', saved.deepseek);
    }
  });
});

describe('AI provider credential guidance', () => {
  beforeEach(() => {
    for (const name of ['OPENAI', 'CLAUDE', 'DEEPSEEK', 'GOOGLE']) {
      vi.stubEnv(`ALEMBIC_${name}_API_KEY`, '');
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Credential tests must not access the network');
      })
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  async function captureMissingKeyError(run: () => Promise<unknown>) {
    try {
      await run();
    } catch (err) {
      return err as Error & {
        code?: string;
        provider?: string;
        envVar?: string;
        hostAction?: string;
      };
    }
    throw new Error('Expected provider call to fail before network when API key is missing');
  }

  it('reports missing API keys with host-neutral metadata', async () => {
    const cases = [
      {
        provider: 'openai',
        envVar: 'ALEMBIC_OPENAI_API_KEY',
        run: () => new OpenAiProvider({ apiKey: '' }).chat('hello'),
      },
      {
        provider: 'claude',
        envVar: 'ALEMBIC_CLAUDE_API_KEY',
        run: () => new ClaudeProvider({ apiKey: '' }).chat('hello'),
      },
      {
        provider: 'deepseek',
        envVar: 'ALEMBIC_DEEPSEEK_API_KEY',
        run: () => new DeepSeekProvider({ apiKey: '' }).chat('hello'),
      },
      {
        provider: 'google',
        envVar: 'ALEMBIC_GOOGLE_API_KEY',
        run: () => new GoogleGeminiProvider({ apiKey: '' }).chat('hello'),
      },
    ];

    for (const c of cases) {
      const err = await captureMissingKeyError(c.run);
      expect(err).toMatchObject({
        code: 'API_KEY_MISSING',
        provider: c.provider,
        envVar: c.envVar,
        hostAction: 'configure-provider-credential',
      });
      expect(err.message).toContain(c.envVar);
      expect(err.message).not.toContain('Dashboard');
      expect(err.message).not.toContain('AI Settings');
      expect(fetch).not.toHaveBeenCalled();
    }
  });
});

describe('ParameterGuard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    { field: 'temperature', value: NaN },
    { field: 'temperature', value: Infinity },
    { field: 'maxTokens', value: NaN },
    { field: 'maxTokens', value: Infinity },
    { field: 'maxTokens', value: 0 },
    { field: 'maxTokens', value: -1 },
    { field: 'maxTokens', value: 1.5 },
    { field: 'maxTokens', value: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid supported $field=$value at the gateway before transport or retry', async ({
    field,
    value,
  }) => {
    const fetch = mockJsonFetch(
      {},
      {
        id: 'fixture',
        created: 1,
        model: 'gpt-5.5',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' },
        ],
      }
    );
    const transport = vi.spyOn(OpenAiTransport.prototype, 'chatWithTools');
    const gateway = new LLMGateway({
      providers: { openai: { apiKey: 'fixture-key' } },
      maxRetries: 2,
    });
    await expect(
      gateway.chatWithTools({
        modelRef: 'openai:gpt-5.5',
        messages: [{ role: 'user', content: 'fixture' }],
        [field]: value,
      })
    ).rejects.toMatchObject({
      code: 'LLM_INVALID_REQUEST',
      message: expect.stringContaining(field),
    });
    expect(transport).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  // 字符串参数与数值参数同一校验口径：模型允许并将透传给 transport 时，非字符串或空白值
  // 必须在发请求前以 LLM_INVALID_REQUEST 失败，不能以 as string 透传成厂商请求错误再进重试/熔断。
  it.each([
    { field: 'toolChoice', value: { type: 'tool', name: 'x' } },
    { field: 'toolChoice', value: 42 },
    { field: 'toolChoice', value: '   ' },
    { field: 'reasoningEffort', value: { effort: 'high' } },
    { field: 'reasoningEffort', value: '' },
  ])('rejects non-string or blank $field=$value at the gateway before transport or retry', async ({
    field,
    value,
  }) => {
    const fetch = mockJsonFetch(
      {},
      {
        id: 'fixture',
        created: 1,
        model: 'gpt-5.5',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' },
        ],
      }
    );
    const transport = vi.spyOn(OpenAiTransport.prototype, 'chatWithTools');
    const gateway = new LLMGateway({
      providers: { openai: { apiKey: 'fixture-key' } },
      maxRetries: 2,
    });
    const rejection = gateway.chatWithTools({
      modelRef: 'openai:gpt-5.5',
      messages: [{ role: 'user', content: 'fixture' }],
      [field]: value,
    });
    await expect(rejection).rejects.toMatchObject({
      code: 'LLM_INVALID_REQUEST',
      message: `${field} must be a non-empty string`,
    });
    expect(transport).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps an unsupported toolChoice filtered even if its value is not a string', () => {
    const deepseekV4 = new ModelRegistry().resolve('deepseek', 'deepseek-v4-pro');
    if (!deepseekV4) {
      throw new Error('DeepSeek V4 Pro model definition is missing');
    }
    const guarded = ParameterGuard.guard(deepseekV4, { toolChoice: { type: 'tool', name: 'x' } });
    expect(guarded.toolChoice).toBeUndefined();
    expect(guarded.filtered.map((item) => item.param)).toEqual(['toolChoice']);
  });

  it.each([
    'topP',
    'topK',
  ] as const)('rejects non-finite numeric %s when its model rule allows it', (field) => {
    const model = createThinkingModel();
    model.parameterConstraints[field] = { allowed: true, min: 0, max: 1 };
    expect(() => ParameterGuard.guard(model, { [field]: NaN })).toThrow(
      expect.objectContaining({ code: 'LLM_INVALID_REQUEST' })
    );
  });

  it('keeps unsupported numeric options filtered even if their values are invalid', () => {
    const model = new ModelRegistry().resolve('claude', 'claude-opus-4-7');
    if (!model) {
      throw new Error('Fixture model missing');
    }
    expect(ParameterGuard.guard(model, { temperature: NaN, topP: NaN, topK: NaN })).toEqual({
      filtered: [
        expect.objectContaining({ param: 'temperature' }),
        expect.objectContaining({ param: 'topP' }),
        expect.objectContaining({ param: 'topK' }),
      ],
    });
  });

  it('clamps allowed params and filters unsupported model params', () => {
    const guarded = ParameterGuard.guard(createThinkingModel(), {
      temperature: 5,
      topP: 0.5,
      topK: 200,
      toolChoice: 'auto',
      reasoningEffort: 'extreme',
      maxTokens: 5000,
    });

    expect(guarded).toMatchObject({
      temperature: 1,
      topK: 100,
      reasoningEffort: 'medium',
      maxTokens: 1024,
    });
    expect(guarded.filtered.map((item) => item.param)).toEqual([
      'topP',
      'toolChoice',
      'reasoningEffort',
    ]);
  });

  it('filters DeepSeek V4 required tool_choice with an explicit protocol reason', () => {
    const deepseekV4 = new ModelRegistry().resolve('deepseek', 'deepseek-v4-pro');
    if (!deepseekV4) {
      throw new Error('DeepSeek V4 Pro model definition is missing');
    }

    const guarded = ParameterGuard.guard(deepseekV4, {
      toolChoice: 'required',
      maxTokens: 4096,
    });

    expect(guarded.toolChoice).toBeUndefined();
    expect(guarded.filtered.map((item) => item.param)).toContain('toolChoice');
    expect(guarded.filtered.find((item) => item.param === 'toolChoice')?.reason).toContain(
      'reasoning_content'
    );
  });

  // 注册表规则声明了 reason 时，filtered 审计必须写出该原因，而不是笼统的默认文案。
  // 内置注册表当前没有任何 temperature/topP 规则带 reason，这里用合成规则锁定回读语义。
  it('writes the registry rule reason into filtered temperature and topP audits', () => {
    const model = createThinkingModel();
    model.parameterConstraints.temperature = {
      allowed: false,
      reason: 'fixture temperature reason',
    };
    model.parameterConstraints.topP = { allowed: false, reason: 'fixture topP reason' };
    const guarded = ParameterGuard.guard(model, { temperature: 0.7, topP: 0.9 });
    expect(guarded.temperature).toBeUndefined();
    expect(guarded.topP).toBeUndefined();
    expect(guarded.filtered).toEqual([
      { param: 'temperature', reason: 'fixture temperature reason', originalValue: 0.7 },
      { param: 'topP', reason: 'fixture topP reason', originalValue: 0.9 },
    ]);
  });

  it('keeps the display-name fallback reason when a disallowed temperature rule has no reason', () => {
    const model = createThinkingModel();
    model.parameterConstraints.temperature = { allowed: false };
    model.parameterConstraints.topP = { allowed: false };
    expect(ParameterGuard.guard(model, { temperature: 0.5, topP: 0.5 }).filtered).toEqual([
      {
        param: 'temperature',
        reason: 'Test Thinking Model 禁止设置 temperature',
        originalValue: 0.5,
      },
      { param: 'topP', reason: '该模型不支持 topP', originalValue: 0.5 },
    ]);
  });
});

// I13：Runtime 在 toolChoice=none 时不再把 schema 交给 provider（chatWithTools 收到 toolSchemas/toolChoice 均为空，
// facade 默认补 'auto'）。旧路径是“带 schema + toolChoice='none'”，由 Gateway/Transport 丢弃 tools。
// 这里锁定两种调用形状在厂商 HTTP 请求上完全一致，证明对齐只改变 Runtime 诊断，不改变 provider 实际收到的内容。
describe('toolChoice=none wire parity between retained and hidden tool schemas', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const chatCompletionsText = (model: string) => ({
    id: 'chatcmpl-fixture',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [
      { index: 0, message: { role: 'assistant', content: 'summary' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const cases = [
    {
      name: 'openai',
      create: () => new OpenAiProvider({ apiKey: 'test-key', model: 'gpt-4o', maxRetries: 0 }),
      response: () => chatCompletionsText('gpt-4o'),
    },
    {
      name: 'deepseek-chat',
      create: () =>
        new DeepSeekProvider({ apiKey: 'test-key', model: 'deepseek-chat', maxRetries: 0 }),
      response: () => chatCompletionsText('deepseek-chat'),
    },
    {
      name: 'claude',
      create: () =>
        new ClaudeProvider({ apiKey: 'test-key', model: 'claude-sonnet-4-6', maxRetries: 0 }),
      response: () => ({
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        stop_sequence: null,
        content: [{ type: 'text', text: 'summary' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    },
  ];

  it.each(cases)('$name sends the same request whether or not hidden schemas were passed', async ({
    create,
    response,
  }) => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
        return jsonResponse(response());
      })
    );
    const provider = create();
    const messages = [{ role: 'user' as const, content: 'Summarize the recorded findings.' }];
    const common = { messages, systemPrompt: 'Summary identity', maxTokens: 64, temperature: 0.3 };

    // 旧 Runtime 形状：schema 随调用传入，toolChoice='none'。
    await provider.chatWithTools('', {
      ...common,
      toolSchemas: [
        { name: 'knowledge', description: 'Submit knowledge', parameters: { type: 'object' } },
      ],
      toolChoice: 'none',
    });
    // 新 Runtime 形状：none 下 selectLlmInputTools 不选 schema，Runtime 也不传 toolChoice。
    await provider.chatWithTools('', common);

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toHaveProperty('tools');
    expect(bodies[0]).not.toHaveProperty('tool_choice');
    expect(bodies[1]).toEqual(bodies[0]);
  });
});

describe('ModelRegistry data invariants', () => {
  const builtins: ModelDef[] = [
    ...OPENAI_MODELS,
    ...CLAUDE_MODELS,
    ...DEEPSEEK_MODELS,
    ...GOOGLE_MODELS,
    ...OLLAMA_MODELS,
  ];

  it('uses unique ids shaped as provider:apiModelId', () => {
    const ids = builtins.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of builtins) {
      expect(m.id).toBe(`${m.provider}:${m.apiModelId}`);
    }
  });

  it('keeps apiModelId globally unique so bare-ref lookups cannot hit the wrong provider', () => {
    const apiIds = builtins.map((m) => m.apiModelId);
    expect(new Set(apiIds).size).toBe(apiIds.length);
  });

  it('resolves every provider default model and deprecation target', () => {
    const registry = new ModelRegistry();
    for (const config of PROVIDER_CONFIGS) {
      expect(registry.get(config.defaultModelId), config.defaultModelId).toBeDefined();
    }
    for (const m of builtins) {
      if (m.deprecated) {
        expect(registry.get(m.deprecated.migrateToId), m.id).toBeDefined();
      }
    }
  });

  // 未登记模型走保守默认定义（maxOutputTokens=8192）属于降级路径：必须按模型 id 去重告警一次，
  // 否则宿主请求的 maxTokens 被静默截断后只能看到下游 JSON 解析失败。
  it('warns once per id when resolveOrCreate falls back to a dynamic definition', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    try {
      const registry = new ModelRegistry();
      const first = registry.resolveOrCreate('claude', 'claude-registry-dynamic-fixture');
      registry.resolveOrCreate('claude', 'claude-registry-dynamic-fixture');
      registry.resolveOrCreate('openai', 'gpt-5.5');
      expect(first).toMatchObject({ maxOutputTokens: 8_192, contextWindow: 128_000 });
      const messages = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes('dynamic_model_def'));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('model=claude:claude-registry-dynamic-fixture');
      expect(messages[0]).toContain('maxOutputTokens=8192');
      expect(messages[0]).toContain('contextWindow=128000');
      registry.resolveOrCreate('claude', 'claude-registry-dynamic-other');
      expect(
        warn.mock.calls.filter((call) => String(call[0]).includes('dynamic_model_def'))
      ).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  // provider 入口归一：resolve/resolveOrCreate 与 AiFactory、Gateway 共用 canonicalProvider 口径，
  // 别名与大小写差异命中同一注册定义；未知 provider 不再经 as 强转拼出畸形 ProviderId。
  it('normalizes provider aliases at resolve/resolveOrCreate entrypoints', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    try {
      const registry = new ModelRegistry();
      const gemini = registry.get('google:gemini-3-flash-preview');
      const opus = registry.get('claude:claude-opus-4-7');
      expect(gemini).toBeDefined();
      expect(opus).toBeDefined();
      expect(registry.resolve('gemini', 'gemini-3-flash-preview')).toBe(gemini);
      expect(registry.resolve(' Google ', 'gemini-3-flash-preview')).toBe(gemini);
      expect(registry.getContextWindow('google-gemini', 'gemini-3-flash-preview')).toBe(
        gemini?.contextWindow
      );
      expect(registry.resolveOrCreate('anthropic', 'claude-opus-4-7')).toBe(opus);
      // 别名走动态兜底时，定义里的 provider 与 id 都是归一后的 ProviderId，而不是原始别名。
      expect(registry.resolveOrCreate('Anthropic', 'claude-alias-dynamic-fixture')).toMatchObject({
        id: 'claude:claude-alias-dynamic-fixture',
        provider: 'claude',
        apiModelId: 'claude-alias-dynamic-fixture',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('returns undefined from resolve and rejects resolveOrCreate for unknown providers with a diagnostic', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    try {
      const registry = new ModelRegistry();
      // 'auto' 只是部署选择，不是 ProviderId：查询 API 返回 undefined，由调用方改走 apiModelId 查询或回退。
      expect(registry.resolve('auto', 'gemini-3-flash-preview')).toBeUndefined();
      expect(registry.getContextWindow('bogus', 'gemini-3-flash-preview')).toBeUndefined();
      const shortCircuits = debug.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes('unknown_provider op=resolve '));
      expect(shortCircuits.length).toBeGreaterThan(0);
      expect(shortCircuits[0]).toContain('value=auto');

      const sizeBefore = registry.size;
      expect(() => registry.resolveOrCreate('bogus', 'any-model')).toThrow(
        expect.objectContaining({
          code: 'LLM_INVALID_REQUEST',
          message: expect.stringContaining('Unknown AI provider'),
        })
      );
      // 拒绝路径不造动态定义、不写注册表，也不输出 dynamic_model_def 告警。
      expect(registry.size).toBe(sizeBefore);
      const warnings = warn.mock.calls.map((call) => String(call[0]));
      expect(warnings.some((message) => message.includes('dynamic_model_def'))).toBe(false);
      expect(
        warnings.some((message) =>
          message.includes('unknown_provider op=resolveOrCreate value=bogus')
        )
      ).toBe(true);
      // 诊断值经截断与去控制字符处理，不能借换行伪造日志行。
      expect(() => registry.resolveOrCreate('evil\nprovider-name-way-too-long', 'm')).toThrow(
        /Unknown AI provider/
      );
      const sanitized = warn.mock.calls.map((call) => String(call[0])).at(-1) ?? '';
      expect(sanitized).not.toContain('\n');
      expect(sanitized).toContain('len=');
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }
  });

  it('keeps defaultEffort inside the reasoningEffort allowlist when one is declared', () => {
    for (const m of builtins) {
      const allowed = m.parameterConstraints.reasoningEffort?.allowedValues;
      if (allowed && m.reasoning.defaultEffort !== undefined) {
        expect(allowed, m.id).toContain(m.reasoning.defaultEffort);
      }
    }
  });
});

describe('resolveModelQuirks', () => {
  it('V4(注册表 toolChoice.allowed=false)→ forced+guard+dropSchemas+note', () => {
    const q = resolveModelQuirks('deepseek-v4-flash');
    expect(q.forcedToolChoiceUnsupported).toBe(true);
    expect(q.analyzeGroundingGuardEligible).toBe(true);
    expect(q.dropToolSchemasWhenToolChoiceNone).toBe(true);
    expect(q.groundingPolicyProviderNote).toContain('DeepSeek V4');
  });

  it('deepseek-chat(allowed=true)→ 全非特化', () => {
    const q = resolveModelQuirks('deepseek-chat');
    expect(q.forcedToolChoiceUnsupported).toBe(false);
    expect(q.analyzeGroundingGuardEligible).toBe(false);
    expect(q.dropToolSchemasWhenToolChoiceNone).toBe(false);
    expect(q.groundingPolicyProviderNote).toBeNull();
  });

  it('deepseek-reasoner：按注册表声明 forced=true(旧 V4 正则漏掉的已声明修正),但 guard 不适格', () => {
    const q = resolveModelQuirks('deepseek-reasoner');
    expect(q.forcedToolChoiceUnsupported).toBe(true);
    expect(q.analyzeGroundingGuardEligible).toBe(false);
  });

  it('gemini → dropSchemas;未注册的裸 ref 走名字回退(旧内核行为不变)', () => {
    expect(resolveModelQuirks('gemini-2.5-pro').dropToolSchemasWhenToolChoiceNone).toBe(true);
    const raw = resolveModelQuirks('custom-deepseek-v4-build');
    expect(raw.forcedToolChoiceUnsupported).toBe(true);
    expect(raw.analyzeGroundingGuardEligible).toBe(true);
    expect(resolveModelQuirks('claude-sonnet-5').forcedToolChoiceUnsupported).toBe(false);
    expect(resolveModelQuirks(null).analyzeGroundingGuardEligible).toBe(false);
  });

  it('生产形态 provider:apiModelId 前缀 ref 与裸 ref 判定一致', () => {
    const v4 = resolveModelQuirks('deepseek:deepseek-v4-flash');
    expect(v4).toEqual(resolveModelQuirks('deepseek-v4-flash'));
    expect(v4.forcedToolChoiceUnsupported).toBe(true);
    expect(v4.analyzeGroundingGuardEligible).toBe(true);
    const gemini = resolveModelQuirks('google:gemini-2.5-pro');
    expect(gemini).toEqual(resolveModelQuirks('gemini-2.5-pro'));
    expect(gemini.dropToolSchemasWhenToolChoiceNone).toBe(true);
    expect(gemini.forcedToolChoiceUnsupported).toBe(false);
  });

  it('档案不再携带无消费者的 usesTextToolCallCompat 旗标(兼容桥只由 DeepSeekTransport 决定)', () => {
    for (const ref of ['deepseek-v4-flash', 'openai:deepseek-v4-flash', 'gemini-2.5-pro']) {
      expect(Object.keys(resolveModelQuirks(ref))).not.toContain('usesTextToolCallCompat');
    }
  });

  it('isDeepSeekV4Family：已登记模型读注册表声明，判定与改造前一致', () => {
    expect(isDeepSeekV4Family('deepseek-v4-flash')).toBe(true);
    expect(isDeepSeekV4Family('deepseek-v4-pro')).toBe(true);
    expect(isDeepSeekV4Family('deepseek:deepseek-v4-pro')).toBe(true);
    // deepseek-reasoner 虽声明 toolChoice.allowed=false，但不支持工具调用，不属于 V4 thinking+tools 家族。
    expect(isDeepSeekV4Family('deepseek-reasoner')).toBe(false);
    expect(isDeepSeekV4Family('deepseek-chat')).toBe(false);
    expect(isDeepSeekV4Family('gpt-5.5-pro')).toBe(false);
    expect(isDeepSeekV4Family('gemini-2.5-pro')).toBe(false);
    expect(isDeepSeekV4Family(null)).toBe(false);
  });

  it('未登记的 deepseek-pro/flash 变体:ModelQuirks 与 transport 共用同一 V4 判定', () => {
    for (const ref of ['deepseek-pro-0901', 'deepseek-flash', 'custom-deepseek-v4-build']) {
      expect(isDeepSeekV4Family(ref), ref).toBe(true);
      const q = resolveModelQuirks(ref);
      expect(q.forcedToolChoiceUnsupported, ref).toBe(true);
      expect(q.analyzeGroundingGuardEligible, ref).toBe(true);
      expect(q.dropToolSchemasWhenToolChoiceNone, ref).toBe(true);
    }
    expect(isDeepSeekV4Family('deepseek-coder')).toBe(false);
    expect(resolveModelQuirks('deepseek-coder').forcedToolChoiceUnsupported).toBe(false);
  });

  it('isTextCompatToolCallId 前缀判定', () => {
    expect(isTextCompatToolCallId('call_deepseek_compat_1')).toBe(true);
    expect(isTextCompatToolCallId('call_x')).toBe(false);
    expect(isTextCompatToolCallId(null)).toBe(false);
  });
});
