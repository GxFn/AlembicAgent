import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeProvider,
  createProvider,
  GoogleGeminiProvider,
  getAvailableFallbacks,
  getProviderWithFallback,
  isGeoOrProviderError,
} from '../src/ai/AiFactory.js';
import { jsonResponse } from './helpers/mockFetch.js';

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
  'ALEMBIC_AI_MODEL',
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of KEY_ENVS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  it.each([
    { status: 403, providerName: 'openai' },
    { status: 429, providerName: 'google' },
    { status: 503, providerName: 'google' },
  ])('uses the actual SDK probe status $status after its provider error message is sanitized', async ({
    status,
    providerName,
  }) => {
    process.env.ALEMBIC_AI_PROVIDER = 'google';
    process.env.ALEMBIC_GOOGLE_API_KEY = 'fixture-google';
    process.env.ALEMBIC_OPENAI_API_KEY = 'fixture-openai';
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          error: { code: status, message: 'fixture-private-region-detail' },
        },
        status
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const originalProbe = GoogleGeminiProvider.prototype.probe;
    let probeFailure: unknown;
    vi.spyOn(GoogleGeminiProvider.prototype, 'probe').mockImplementation(async function (
      this: GoogleGeminiProvider,
      options
    ) {
      // 只把当前探针的重试预算设为零；真实 Provider/Gateway/SDK 错误路径全部保留。
      this.maxRetries = 0;
      try {
        return await originalProbe.call(this, options);
      } catch (error: unknown) {
        probeFailure = error;
        throw error;
      }
    });

    const provider = await getProviderWithFallback();
    expect(probeFailure).toMatchObject({ status, code: 'LLM_API_ERROR' });
    expect((probeFailure as Error).message).not.toContain('fixture-private-region-detail');
    expect(provider?.name).toBe(providerName);
    expect(provider?._fallbackFrom).toBe(providerName === 'openai' ? 'google' : undefined);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    undefined,
    { message: 42 },
  ])('keeps the selected provider when its probe rejects an unclassified value %s', async (failure) => {
    process.env.ALEMBIC_AI_PROVIDER = 'google';
    process.env.ALEMBIC_GOOGLE_API_KEY = 'fixture-google';
    process.env.ALEMBIC_OPENAI_API_KEY = 'fixture-openai';
    // 外部 JS probe 可以拒绝非 Error 值；分类器不能用新的 TypeError 覆盖该事实。
    const probe = vi.spyOn(GoogleGeminiProvider.prototype, 'probe').mockRejectedValue(failure);
    await expect(getProviderWithFallback()).resolves.toMatchObject({ name: 'google' });
    expect(probe).toHaveBeenCalledOnce();
  });

  it('excludes the actual auto-detected provider after a failed probe', async () => {
    process.env.ALEMBIC_AI_PROVIDER = 'auto';
    process.env.ALEMBIC_GOOGLE_API_KEY = 'synthetic-google';
    process.env.ALEMBIC_OPENAI_API_KEY = 'synthetic-openai';
    vi.spyOn(GoogleGeminiProvider.prototype, 'probe').mockRejectedValue(
      new Error('unsupported region')
    );
    expect((await getProviderWithFallback())?.name).toBe('openai');
  });
  describe('isGeoOrProviderError', () => {
    it.each([
      {
        label: 'known 429 with blocked wording',
        error: { status: 429, message: 'requests blocked' },
        fallback: false,
      },
      {
        label: 'known 503 with forbidden wording',
        error: { status: 503, message: 'forbidden by upstream' },
        fallback: false,
      },
      {
        label: 'known 408 with blocked wording',
        error: { status: 408, message: 'requests blocked' },
        fallback: false,
      },
      {
        label: 'network reset with blocked wording',
        error: { code: 'ECONNRESET', message: 'connection blocked' },
        fallback: false,
      },
      {
        label: 'network timeout cause with forbidden wording',
        error: { cause: { code: 'ETIMEDOUT' }, message: 'forbidden' },
        fallback: false,
      },
      {
        label: 'cancelled request with blocked wording',
        error: { name: 'AbortError', message: 'request blocked' },
        fallback: false,
      },
      {
        label: 'legacy rate-limit wording before blocked',
        error: new Error('rate limit exceeded; requests blocked'),
        fallback: false,
      },
      {
        label: 'legacy 429 quota wording before blocked',
        error: new Error('429 quota exceeded; requests temporarily blocked'),
        fallback: false,
      },
      {
        label: 'known 403 with sanitized message',
        error: { status: 403, message: 'API request failed' },
        fallback: true,
      },
      {
        label: 'known 403 account quota block',
        error: { status: 403, message: 'account quota exhausted; access blocked' },
        fallback: true,
      },
      {
        label: 'legacy permanent account quota block',
        error: new Error('account quota exhausted; access blocked'),
        fallback: true,
      },
      {
        label: 'non-numeric HTTP status',
        error: { status: '403', message: 'API request failed' },
        fallback: false,
      },
      { label: 'missing error', error: null, fallback: false },
      { label: 'non-string message', error: { message: 42 }, fallback: false },
    ])('classifies $label without losing structured error facts', ({ error, fallback }) => {
      expect(isGeoOrProviderError(error)).toBe(fallback);
    });

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
