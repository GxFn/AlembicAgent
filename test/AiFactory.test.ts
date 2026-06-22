import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeProvider,
  createProvider,
  getAvailableFallbacks,
  isGeoOrProviderError,
} from '../src/ai/AiFactory.js';

/**
 * AiFactory owns provider selection + the geo/provider-error fallback gate, with
 * no prior test. The highest-risk rule: a rate-limit / quota / 429 must NOT be
 * mistaken for a provider-level failure, or the agent would pointlessly switch
 * providers on transient throttling.
 */

const KEY_ENVS = [
  'ALEMBIC_GOOGLE_API_KEY',
  'ALEMBIC_OPENAI_API_KEY',
  'ALEMBIC_CLAUDE_API_KEY',
  'ALEMBIC_DEEPSEEK_API_KEY',
  'ALEMBIC_AI_PROVIDER',
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of KEY_ENVS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEY_ENVS) {
    const v = saved.get(k);
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});

describe('AiFactory fallback selection', () => {
  describe('isGeoOrProviderError', () => {
    it('flags geo-restriction and failed_precondition errors', () => {
      expect(
        isGeoOrProviderError(new Error('User location is not supported for the API use'))
      ).toBe(true);
      expect(isGeoOrProviderError(new Error('FAILED_PRECONDITION: region'))).toBe(true);
      expect(isGeoOrProviderError(new Error('Service blocked in your country'))).toBe(true);
    });

    it('flags permission-denied / forbidden but NOT rate-limit / quota / 429', () => {
      expect(isGeoOrProviderError(new Error('Permission denied'))).toBe(true);
      expect(isGeoOrProviderError(new Error('403 Forbidden'))).toBe(true);
      // Transient throttling must never trigger a provider switch.
      expect(isGeoOrProviderError(new Error('permission denied: rate limit exceeded'))).toBe(false);
      expect(isGeoOrProviderError(new Error('429 quota exceeded'))).toBe(false);
    });

    it('ignores ordinary transient errors', () => {
      expect(isGeoOrProviderError(new Error('socket hang up'))).toBe(false);
      expect(isGeoOrProviderError(new Error('500 internal server error'))).toBe(false);
    });
  });

  describe('getAvailableFallbacks', () => {
    it('lists key-configured providers excluding the current one', () => {
      process.env.ALEMBIC_OPENAI_API_KEY = 'o';
      process.env.ALEMBIC_CLAUDE_API_KEY = 'c';
      process.env.ALEMBIC_DEEPSEEK_API_KEY = 'd';
      // google has no key; current is openai → deepseek + claude remain (map order).
      expect(getAvailableFallbacks('openai')).toEqual(['deepseek', 'claude']);
    });

    it('returns empty when only the current provider has a key', () => {
      process.env.ALEMBIC_GOOGLE_API_KEY = 'g';
      expect(getAvailableFallbacks('google')).toEqual([]);
    });
  });

  describe('createProvider', () => {
    it('instantiates a known provider by name', () => {
      expect(createProvider({ provider: 'claude', apiKey: 'k' })).toBeInstanceOf(ClaudeProvider);
    });

    it('throws on an unknown provider', () => {
      expect(() => createProvider({ provider: 'nonesuch' })).toThrow(/Unknown AI provider/u);
    });
  });
});
