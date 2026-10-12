/**
 * MemoryStore.computeSimilarity 纯函数用例（L6-P3 / C30）。
 *
 * 本文件刻意不构造 better-sqlite3 Database：只覆盖相似度打分本身，
 * 这样在 better-sqlite3 原生模块 ABI 与当前 Node 不匹配的环境里也能运行。
 * 依赖数据库的固化 / append 去重用例放在 test/memory-context.test.ts。
 */
import Logger from '@alembic/core/logging';
import { tokenizeForSimilarity } from '@alembic/core/search';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/agent/memory/MemoryStore.js';

function similarity(a: string, b: string): number {
  const lowerA = a.toLowerCase();
  return MemoryStore.computeSimilarity(tokenizeForSimilarity(lowerA), lowerA, b);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MemoryStore.computeSimilarity without comparable tokens', () => {
  it('scores two unrelated Cyrillic memories as different instead of identical', () => {
    // Core 分词只保留拉丁与 CJK 字符，西里尔文两侧都没有 token；旧实现会返回 1.0。
    expect(tokenizeForSimilarity('используй табы вместо пробелов').size).toBe(0);
    expect(similarity('используй табы вместо пробелов', 'пиши тесты на русском')).toBe(0);
  });

  it('scores two unrelated Korean or kana memories as different', () => {
    expect(similarity('탭 대신 공백을 사용하세요', '테스트는 한국어로 작성하세요')).toBe(0);
    expect(similarity('ひらがなのメモ', 'カタカナのメモ')).toBe(0);
  });

  it('still treats a normalized identical restatement as a duplicate', () => {
    expect(similarity('используй табы вместо пробелов', 'используй табы вместо пробелов')).toBe(1);
    // 大小写、首尾空白与连续空白差异在精确比较前归一化。
    expect(
      similarity('  Используй табы   вместо пробелов ', 'используй ТАБЫ вместо пробелов')
    ).toBe(1);
    expect(similarity('탭 대신 공백을 사용하세요', '탭 대신 공백을 사용하세요')).toBe(1);
  });

  it('logs the exact-match fallback at debug level without memory content', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    similarity('используй табы вместо пробелов', 'пиши тесты на русском');
    const messages = debug.mock.calls.map((call) => String(call[0]));
    const fallback = messages.find((message) => message.includes('exact-match fallback'));
    expect(fallback).toBeDefined();
    expect(fallback).toContain('[MemoryStore]');
    expect(fallback).not.toContain('используй');
  });

  it('keeps token-based scoring for Latin and CJK text unchanged', () => {
    expect(similarity('Use tabs instead of spaces', 'use tabs instead of spaces')).toBe(1);
    expect(
      similarity('Use tabs instead of spaces', 'Quartz geometry defines a blue triangle')
    ).toBeLessThan(0.1);
    expect(similarity('项目使用 Zustand 管理全局状态', '项目使用 Zustand 管理全局状态')).toBe(1);
    // 只有一侧有 token 时仍判为不相似。
    expect(similarity('Use tabs instead of spaces', 'используй табы вместо пробелов')).toBe(0);
  });
});
