import { describe, expect, it } from 'vitest';

import { classifyLlmError } from '../src/ai/shared/error-classify.js';
import { extractJSON, repairTruncatedArray } from '../src/ai/shared/structured-output.js';
import { normalizeRawUsage } from '../src/ai/shared/usage.js';

describe('shared/structured-output extractJSON', () => {
  it('parses a clean JSON object', () => {
    expect(extractJSON('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips markdown code fences before parsing', () => {
    expect(extractJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('tolerates surrounding prose and trailing commas', () => {
    const text = 'Here is the result: {"a":1, "b":[1,2,],}\nDone.';
    expect(extractJSON(text)).toEqual({ a: 1, b: [1, 2] });
  });

  it('returns null when no opening char is present', () => {
    expect(extractJSON('no json here')).toBeNull();
  });

  it('parses arrays when openChar/closeChar are brackets', () => {
    expect(extractJSON('[{"a":1},{"a":2}]', '[', ']')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('repairs a truncated JSON array by recovering completed objects', () => {
    const truncated = '[{"a":1},{"a":2},{"a":3'; // 第三个对象被截断
    const result = extractJSON(truncated, '[', ']');
    expect(result).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('forwards a log message when repairing truncated arrays', () => {
    const logs: Array<{ level: string; message: string }> = [];
    const truncated = '[{"a":1},{"a":2},{"a":3';
    repairTruncatedArray(truncated, (level, message) => logs.push({ level, message }));
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('Repaired'))).toBe(true);
  });
});

describe('shared/error-classify classifyLlmError', () => {
  it('flags AbortError as abort and non-retryable', () => {
    const c = classifyLlmError(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect(c.isAbort).toBe(true);
    expect(c.isRetryable).toBe(false);
  });

  it('flags AbortError surfaced via cause', () => {
    const c = classifyLlmError({ message: 'x', cause: { name: 'AbortError' } });
    expect(c.isAbort).toBe(true);
  });

  it('treats network error codes as retryable network errors', () => {
    const c = classifyLlmError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    expect(c.isNetworkError).toBe(true);
    expect(c.isRetryable).toBe(true);
    expect(c.isServerError).toBe(true);
  });

  it('treats 429 and 5xx as retryable server errors', () => {
    expect(classifyLlmError({ status: 429 }).isRetryable).toBe(true);
    expect(classifyLlmError({ status: 503 }).isRetryable).toBe(true);
    expect(classifyLlmError({ status: 503 }).isServerError).toBe(true);
  });

  it('does not treat 4xx client errors (non-429) as retryable or server errors', () => {
    const c = classifyLlmError({ status: 400 });
    expect(c.isRetryable).toBe(false);
    expect(c.isServerError).toBe(false);
  });

  it('reads cause.code for network classification', () => {
    const c = classifyLlmError({ message: 'fetch failed', cause: { code: 'ECONNRESET' } });
    expect(c.isNetworkError).toBe(true);
  });
});

describe('shared/usage normalizeRawUsage', () => {
  it('returns null for missing usage', () => {
    expect(normalizeRawUsage(null)).toBeNull();
    expect(normalizeRawUsage(undefined)).toBeNull();
  });

  it('maps OpenAI Chat Completions / DeepSeek field names', () => {
    expect(
      normalizeRawUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
    ).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it('maps OpenAI Responses / Anthropic field names', () => {
    expect(normalizeRawUsage({ input_tokens: 7, output_tokens: 3 })).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    });
  });

  it('maps Google Gemini field names', () => {
    expect(
      normalizeRawUsage({ promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 10 })
    ).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 });
  });

  it('carries reasoning and cache-hit tokens when present', () => {
    const usage = normalizeRawUsage({
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
      reasoning_tokens: 1,
      prompt_cache_hit_tokens: 1,
    });
    expect(usage).toMatchObject({ reasoningTokens: 1, cacheHitTokens: 1 });
  });
});
