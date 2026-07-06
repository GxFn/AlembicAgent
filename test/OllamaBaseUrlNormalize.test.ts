import { describe, expect, test, vi } from 'vitest';
import { normalizeOllamaBaseUrl, OllamaProvider } from '../src/ai/providers/OllamaProvider.js';

describe('normalizeOllamaBaseUrl', () => {
  test('bare host:port gets /v1 appended with an info trace', () => {
    const logger = { info: vi.fn() };
    expect(normalizeOllamaBaseUrl('http://127.0.0.1:11434', logger as never)).toBe(
      'http://127.0.0.1:11434/v1'
    );
    expect(logger.info).toHaveBeenCalledOnce();
  });

  test('bare root with trailing slash also normalizes', () => {
    expect(normalizeOllamaBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434/v1');
  });

  test('explicit /v1 is preserved (only trailing slash stripped)', () => {
    expect(normalizeOllamaBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(normalizeOllamaBaseUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1');
  });

  test('custom reverse-proxy path is left untouched', () => {
    expect(normalizeOllamaBaseUrl('https://gw.example.com/ollama/v1')).toBe(
      'https://gw.example.com/ollama/v1'
    );
    expect(normalizeOllamaBaseUrl('https://gw.example.com/custom-openai')).toBe(
      'https://gw.example.com/custom-openai'
    );
  });

  test('invalid url passes through for the transport to surface the real error', () => {
    expect(normalizeOllamaBaseUrl('not-a-url')).toBe('not-a-url');
  });

  test('OllamaProvider constructor applies normalization to configured baseUrl', () => {
    // 2026-07-06 真机根因回归钉：settings 面板写入的裸 host:port 必须能直接工作。
    const provider = new OllamaProvider({ baseUrl: 'http://127.0.0.1:11434' });
    expect(provider.baseUrl).toBe('http://127.0.0.1:11434/v1');
  });
});
