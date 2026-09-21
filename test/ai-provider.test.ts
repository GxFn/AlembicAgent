import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLMGateway } from '../src/ai/gateway/LLMGateway.js';
import { isTextCompatToolCallId, resolveModelQuirks } from '../src/ai/registry/ModelQuirks.js';
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
import { mockJsonFetch } from './helpers/mockFetch.js';

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
});

describe('resolveModelQuirks', () => {
  it('V4(注册表 toolChoice.allowed=false)→ forced+guard+dropSchemas+note', () => {
    const q = resolveModelQuirks('deepseek-v4-flash');
    expect(q.forcedToolChoiceUnsupported).toBe(true);
    expect(q.analyzeGroundingGuardEligible).toBe(true);
    expect(q.dropToolSchemasWhenToolChoiceNone).toBe(true);
    expect(q.groundingPolicyProviderNote).toContain('DeepSeek V4');
    expect(q.usesTextToolCallCompat).toBe(true);
  });

  it('deepseek-chat(allowed=true)→ 全非特化(除文本兼容桥)', () => {
    const q = resolveModelQuirks('deepseek-chat');
    expect(q.forcedToolChoiceUnsupported).toBe(false);
    expect(q.analyzeGroundingGuardEligible).toBe(false);
    expect(q.groundingPolicyProviderNote).toBeNull();
    expect(q.usesTextToolCallCompat).toBe(true);
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

  it('isTextCompatToolCallId 前缀判定', () => {
    expect(isTextCompatToolCallId('call_deepseek_compat_1')).toBe(true);
    expect(isTextCompatToolCallId('call_x')).toBe(false);
    expect(isTextCompatToolCallId(null)).toBe(false);
  });
});
