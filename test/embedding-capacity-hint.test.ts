import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiProvider } from '../src/ai/AiProvider.js';
import { ClaudeProvider } from '../src/ai/providers/ClaudeProvider.js';
import { DeepSeekProvider } from '../src/ai/providers/DeepSeekProvider.js';
import { GoogleGeminiProvider } from '../src/ai/providers/GoogleGeminiProvider.js';
import { OllamaProvider } from '../src/ai/providers/OllamaProvider.js';
import { OpenAiProvider } from '../src/ai/providers/OpenAiProvider.js';

const ENV_KEYS = ['ALEMBIC_AI_MAX_CONCURRENCY', 'ALEMBIC_GEMINI_MAX_CONCURRENCY'] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('AD5 embedding capacity hint', () => {
  it('reports the conservative default gate per provider class with no config or env', () => {
    expect(new OpenAiProvider({ apiKey: 'k' }).getEmbeddingCapacityHint()).toEqual({
      provider: 'openai',
      maxInFlightEmbeddings: 4,
      source: 'conservative-default',
    });
    expect(new DeepSeekProvider({ apiKey: 'k' }).getEmbeddingCapacityHint()).toMatchObject({
      maxInFlightEmbeddings: 4,
      source: 'conservative-default',
    });
    expect(new ClaudeProvider({ apiKey: 'k' }).getEmbeddingCapacityHint()).toMatchObject({
      maxInFlightEmbeddings: 4,
      source: 'conservative-default',
    });
    expect(new OllamaProvider({}).getEmbeddingCapacityHint()).toMatchObject({
      maxInFlightEmbeddings: 4,
      source: 'conservative-default',
    });
  });

  it('reports the Gemini provider default of 2 as conservative-default (Google quota guard)', () => {
    expect(new GoogleGeminiProvider({ apiKey: 'k' }).getEmbeddingCapacityHint()).toEqual({
      provider: 'google',
      maxInFlightEmbeddings: 2,
      source: 'conservative-default',
    });
  });

  it('attributes explicit configuration as provider-config', () => {
    expect(
      new OpenAiProvider({ apiKey: 'k', maxConcurrency: 7 }).getEmbeddingCapacityHint()
    ).toEqual({ provider: 'openai', maxInFlightEmbeddings: 7, source: 'provider-config' });
    expect(
      new GoogleGeminiProvider({ apiKey: 'k', maxConcurrency: 5 }).getEmbeddingCapacityHint()
    ).toEqual({ provider: 'google', maxInFlightEmbeddings: 5, source: 'provider-config' });
  });

  it('attributes the global concurrency env var as environment', () => {
    process.env.ALEMBIC_AI_MAX_CONCURRENCY = '3';
    expect(new OpenAiProvider({ apiKey: 'k' }).getEmbeddingCapacityHint()).toEqual({
      provider: 'openai',
      maxInFlightEmbeddings: 3,
      source: 'environment',
    });
    expect(new GoogleGeminiProvider({ apiKey: 'k' }).getEmbeddingCapacityHint()).toEqual({
      provider: 'google',
      maxInFlightEmbeddings: 3,
      source: 'environment',
    });
  });

  it('attributes the Gemini-specific env var as environment and lets it win over the global', () => {
    process.env.ALEMBIC_AI_MAX_CONCURRENCY = '3';
    process.env.ALEMBIC_GEMINI_MAX_CONCURRENCY = '6';
    expect(new GoogleGeminiProvider({ apiKey: 'k' }).getEmbeddingCapacityHint()).toEqual({
      provider: 'google',
      maxInFlightEmbeddings: 6,
      source: 'environment',
    });
  });

  it('is read-only and mirrors the live request gate without changing throttling state', () => {
    const provider = new OpenAiProvider({ apiKey: 'k', maxConcurrency: 2 });
    const hint = provider.getEmbeddingCapacityHint();

    expect(Object.isFrozen(hint)).toBe(true);
    expect(hint.maxInFlightEmbeddings).toBe(provider._maxConcurrency);
    expect(provider._activeRequests).toBe(0);
    expect(provider.getEmbeddingCapacityHint()).toEqual(hint);
  });

  it('stays reachable on the exact object shape Core BatchEmbedder receives', () => {
    // Core's EmbeddingProvider contract is the injected provider object itself;
    // the hint must ride that same object through the existing ./ai surface.
    const provider: { embed(text: string | string[]): Promise<number[] | number[][]> } =
      new OpenAiProvider({ apiKey: 'k' });

    expect(typeof (provider as AiProvider).getEmbeddingCapacityHint).toBe('function');
    expect((provider as AiProvider).getEmbeddingCapacityHint().maxInFlightEmbeddings).toBe(4);
  });
});
