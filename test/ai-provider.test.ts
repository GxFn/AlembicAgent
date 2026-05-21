import { describe, expect, it } from 'vitest';

import {
  AiProvider,
  type AiProviderConfig,
  AiProviderManager,
  getProviderConfig,
  type ManagedAiProvider,
  MockProvider,
  type ModelDef,
  ModelRegistry,
  ParameterGuard,
  PROVIDER_CONFIGS,
  type SwitchResult,
} from '../src/index.js';

class RetryHarnessProvider extends AiProvider {
  constructor(config: AiProviderConfig = {}) {
    super({ maxConcurrency: 1, maxRetries: 0, ...config });
    this.name = 'retry-harness';
    this.model = 'retry-test';
  }

  runWithRetry<T>(fn: () => Promise<T>, retries = 0, baseDelay = 1): Promise<T> {
    return this._withRetry(fn, retries, baseDelay);
  }
}

function createThinkingModel(): ModelDef {
  return {
    id: 'mock:test-thinking',
    displayName: 'Mock Thinking Model',
    provider: 'mock',
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
    expect(new ModelRegistry().resolveOrCreate('mock', 'dynamic-test')).toMatchObject({
      id: 'mock:dynamic-test',
      provider: 'mock',
      apiModelId: 'dynamic-test',
    });
  });
});

describe('MockProvider', () => {
  it('returns deterministic mock chat, tool, and embedding results', async () => {
    const provider = new MockProvider({ responses: { chat: 'fixed response' } });

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
    expect(embeddings[0]).toHaveLength(768);
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

  it('filters DeepSeek V4 thinking toolChoice while preserving tools', () => {
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
  });
});

describe('AiProvider retry and error classification', () => {
  it('does not trip the circuit breaker for non-retryable client errors', async () => {
    const provider = new RetryHarnessProvider({ circuitThreshold: 1 });
    const clientError = Object.assign(new Error('bad request'), { status: 400 });

    await expect(provider.runWithRetry(() => Promise.reject(clientError))).rejects.toMatchObject({
      status: 400,
    });
    expect(provider._circuitFailures).toBe(0);
    expect(provider._circuitState).toBe('CLOSED');
  });

  it('classifies timeout failures as retryable and opens the circuit', async () => {
    const provider = new RetryHarnessProvider({ circuitThreshold: 1 });
    const timeoutError = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });

    await expect(provider.runWithRetry(() => Promise.reject(timeoutError))).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    });
    expect(provider._circuitFailures).toBe(1);
    expect(provider._circuitState).toBe('OPEN');

    await expect(provider.runWithRetry(() => Promise.resolve('ok'))).rejects.toMatchObject({
      code: 'CIRCUIT_OPEN',
    });
  });

  it('treats AbortError cancellation as non-retryable without circuit state changes', async () => {
    const provider = new RetryHarnessProvider({ circuitThreshold: 1 });
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    let attempts = 0;

    await expect(
      provider.runWithRetry(() => {
        attempts += 1;
        return Promise.reject(abortError);
      }, 2)
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(attempts).toBe(1);
    expect(provider._circuitFailures).toBe(0);
    expect(provider._circuitState).toBe('CLOSED');
  });
});

describe('AiProviderManager', () => {
  it('rewires token tracking and emits switch events when routing providers', () => {
    const initialProvider: ManagedAiProvider = {
      name: 'mock',
      model: 'mock-smart',
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

    expect(result.previous).toMatchObject({ name: 'mock', isMock: true });
    expect(result.current).toMatchObject({ name: 'openai', model: 'gpt-test', isMock: false });
    expect(manager.isMock).toBe(false);
    expect(switches).toHaveLength(1);
    expect(tokenRecords).toEqual([
      {
        source: 'chat',
        provider: 'mock',
        model: 'mock-smart',
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
