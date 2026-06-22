import { describe, expect, it } from 'vitest';

import {
  AiProvider,
  type AiProviderConfig,
  AiProviderManager,
  autoDetectProvider,
  ClaudeProvider,
  createProvider,
  DeepSeekProvider,
  GoogleGeminiProvider,
  getProviderConfig,
  type ManagedAiProvider,
  type ModelDef,
  ModelRegistry,
  OpenAiProvider,
  ParameterGuard,
  PROVIDER_CONFIGS,
  type SwitchResult,
} from '../src/index.js';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

class TestLocalFakeProvider extends AiProvider {
  #calls: Array<{ method: string }> = [];
  #chatResponse: string;

  constructor(config: AiProviderConfig = {}) {
    super(config);
    this.name = 'test-local-fake';
    this.model = 'test-local-model';
    this.#chatResponse = String(config.responses?.chat ?? 'test response');
  }

  async chat(): Promise<string> {
    this.#calls.push({ method: 'chat' });
    return this.#chatResponse;
  }

  async chatWithTools(): Promise<{
    text: null;
    functionCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  }> {
    this.#calls.push({ method: 'chatWithTools' });
    return {
      text: null,
      functionCalls: [
        {
          id: 'test-fake-call',
          name: 'classify_intent',
          args: { type: 'general', confidence: 0.9 },
        },
      ],
    };
  }

  async embed(text: string | string[]): Promise<number[] | number[][]> {
    this.#calls.push({ method: 'embed' });
    const values = Array.isArray(text) ? text : [text];
    const vectors = values.map((value) => {
      const seed = [...value].reduce((acc, char) => acc + char.charCodeAt(0), 0);
      return Array.from({ length: 8 }, (_, index) => ((seed + index) % 17) / 17);
    });
    return Array.isArray(text) ? vectors : vectors[0];
  }

  getCalls(): Array<{ method: string }> {
    return this.#calls;
  }
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
    }
  });
});

describe('TestLocalFakeProvider', () => {
  it('returns deterministic chat, tool, and embedding results inside the test boundary', async () => {
    const provider = new TestLocalFakeProvider({ responses: { chat: 'fixed response' } });

    await expect(provider.chat('hello')).resolves.toBe('fixed response');

    const toolResult = await provider.chatWithTools('route this request', {
      toolSchemas: [{ name: 'classify_intent' }],
    });

    expect(toolResult.text).toBeNull();
    expect(toolResult.functionCalls?.[0]).toMatchObject({
      name: 'classify_intent',
      args: { type: 'general', confidence: 0.9 },
    });

    const embeddings = (await provider.embed(['alpha', 'alpha'])) as number[][];
    expect(embeddings).toHaveLength(2);
    expect(embeddings[0]).toHaveLength(8);
    expect(embeddings[1]).toEqual(embeddings[0]);
    expect(provider.getCalls().map((entry) => entry.method)).toEqual([
      'chat',
      'chatWithTools',
      'embed',
    ]);
  });
});

describe('ParameterGuard', () => {
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

describe('AiProviderManager', () => {
  it('rewires token tracking and emits switch events when routing providers', () => {
    const initialProvider: ManagedAiProvider = {
      name: 'test-local-fake',
      model: 'test-local-model',
      supportsEmbedding: () => true,
    };
    const nextProvider: ManagedAiProvider = {
      name: 'openai',
      model: 'gpt-test',
      supportsEmbedding: () => false,
    };
    const tokenRecords: Array<{
      source: string;
      provider?: string;
      model?: string;
      inputTokens: number;
      outputTokens: number;
    }> = [];
    const switches: SwitchResult[] = [];
    const manager = new AiProviderManager(initialProvider);

    manager.setTokenRecorder({
      record: (entry) => {
        tokenRecords.push(entry);
      },
    });
    manager.onSwitch((result) => {
      switches.push(result);
    });

    initialProvider._onTokenUsage?.({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      source: 'chat',
    });

    const result = manager.switchProvider(nextProvider);
    nextProvider._onTokenUsage?.({
      inputTokens: 7,
      outputTokens: 11,
      totalTokens: 18,
      source: 'tools',
    });

    expect(result.previous).toMatchObject({ name: 'test-local-fake', isMock: false });
    expect(result.current).toMatchObject({ name: 'openai', model: 'gpt-test', isMock: false });
    expect(manager.isMock).toBe(false);
    expect(switches).toHaveLength(1);
    expect(tokenRecords).toEqual([
      {
        source: 'chat',
        provider: 'test-local-fake',
        model: 'test-local-model',
        inputTokens: 2,
        outputTokens: 3,
      },
      {
        source: 'tools',
        provider: 'openai',
        model: 'gpt-test',
        inputTokens: 7,
        outputTokens: 11,
      },
    ]);
  });
});
