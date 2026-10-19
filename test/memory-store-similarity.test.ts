/**
 * MemoryStore.computeSimilarity 纯函数用例（L6-P3 / C30，含第三轮审计 C008 的混合文字补充）。
 *
 * 本文件刻意不构造 better-sqlite3 Database：只覆盖相似度打分本身，
 * 这样在 better-sqlite3 原生模块 ABI 与当前 Node 不匹配的环境里也能运行。
 * 依赖数据库的固化 / append 去重用例放在 test/memory-context.test.ts。
 */
import Logger from '@alembic/core/logging';
import { jaccardSimilarity, tokenizeForSimilarity } from '@alembic/core/search';
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

describe('MemoryStore.computeSimilarity with scripts outside Core tokenizer coverage', () => {
  // MemoryConsolidator 与 MemoryRetriever.append 在相似度 ≥ 0.85 时走 UPDATE，新记忆被静默丢弃。
  const SIMILARITY_UPDATE = 0.85;

  // Core 分词把西里尔文、韩文整体当作分隔符丢掉，只剩共同的拉丁标识符或数字；
  // 旧实现因此对这些无关记忆给出 1.0（C30 第三轮审计 C008）。
  it.each([
    [
      'Cyrillic memories sharing a Latin identifier',
      'используй Zustand для глобального состояния',
      'никогда не храни токены в Zustand',
    ],
    [
      'Korean memories sharing a Latin identifier',
      '상태 관리는 Zustand 사용',
      'Zustand 스토어에 토큰 저장 금지',
    ],
    [
      'Cyrillic memories sharing a tool name',
      'тесты пишем на Vitest',
      'Vitest запускать только локально',
    ],
    ['Cyrillic memories sharing a two-digit number', 'порт сервера 80', 'максимум 80 соединений'],
  ])('scores unrelated %s well below the UPDATE threshold', (_label, a, b) => {
    const score = similarity(a, b);
    expect(score).toBeLessThan(SIMILARITY_UPDATE);
    expect(score).toBeLessThan(0.5);
    // 补充 token 不能破坏相似度的对称性。
    expect(similarity(b, a)).toBeCloseTo(score, 10);
  });

  it('still treats identical or trivially restated mixed-script memories as duplicates', () => {
    const sentence = 'используй Zustand для глобального состояния';
    expect(similarity(sentence, sentence)).toBe(1);
    expect(
      similarity(
        'Используй Zustand для глобального состояния',
        'используй ZUSTAND для глобального состояния'
      )
    ).toBe(1);
    // 只差空白。
    expect(
      similarity('используй Zustand для  глобального   состояния ', sentence)
    ).toBeGreaterThanOrEqual(SIMILARITY_UPDATE);
    // 只差 Unicode 规范化形式：西里尔文 й 与韩文音节在 NFD 下拆成组合序列。
    expect(similarity(sentence.normalize('NFD'), sentence)).toBeGreaterThanOrEqual(
      SIMILARITY_UPDATE
    );
    const korean = '상태 관리는 Zustand 사용';
    expect(similarity(korean.normalize('NFD'), korean)).toBeGreaterThanOrEqual(SIMILARITY_UPDATE);
  });

  it('keeps scores of text fully covered by the Core tokenizer unchanged', () => {
    // 英文对照值与修复前一致（8/35）。
    expect(similarity('use Zustand for global state', 'never store tokens in Zustand')).toBeCloseTo(
      8 / 35,
      10
    );
    // 纯 ASCII / CJK 文本仍严格等于 Core Jaccard（加子串加分）的结果。
    const pairs: Array<[string, string]> = [
      ['项目使用 Zustand 管理全局状态', '组件使用 Zustand 存储令牌'],
      ['tests run on Vitest 4', 'Vitest only runs locally on port 80'],
    ];
    for (const [a, b] of pairs) {
      const lowerA = a.toLowerCase();
      const lowerB = b.toLowerCase();
      const bonus = lowerA.includes(lowerB) || lowerB.includes(lowerA) ? 0.3 : 0;
      const expected = Math.min(
        1,
        jaccardSimilarity(tokenizeForSimilarity(lowerA), tokenizeForSimilarity(lowerB)) + bonus
      );
      expect(similarity(a, b)).toBe(expected);
    }
  });

  it('logs the script-supplement path at debug level without memory content', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    similarity('используй Zustand для глобального состояния', 'никогда не храни токены в Zustand');
    const messages = debug.mock.calls.map((call) => String(call[0]));
    const supplement = messages.find((message) => message.includes('script-supplement tokens'));
    expect(supplement).toBeDefined();
    expect(supplement).toContain('[MemoryStore]');
    expect(supplement).not.toContain('используй');
    expect(supplement).not.toContain('zustand');

    debug.mockClear();
    similarity('use Zustand for global state', 'never store tokens in Zustand');
    expect(
      debug.mock.calls.some((call) => String(call[0]).includes('script-supplement tokens'))
    ).toBe(false);
  });
});
