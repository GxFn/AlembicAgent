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

describe('MemoryStore.computeSimilarity after the fourth-round audit (L6-P3r4)', () => {
  // MemoryConsolidator：≥ 0.85 走 UPDATE（新记忆被丢弃），0.6–0.85 走 MERGE（两句拼成一行）。
  const SIMILARITY_UPDATE = 0.85;
  const SIMILARITY_MERGE = 0.6;

  // 用户决定（2026-10-21）：核心标识符不同就不算重复。两句只在拉丁标识符或数字上不同的俄文，
  // 第三轮修复后补充 token 让俄文部分完全重合，相似度升到 0.78–0.91，第二条被 UPDATE 丢弃或被 MERGE 拼接。
  // Core 词（拉丁标识符、数字）集合不相交时，补充 token 带来的相似度必须低于 MERGE 门槛，两条都保留。
  it.each([
    [
      'a library name',
      'в этом проекте всегда используй библиотеку Zustand для управления глобальным состоянием приложения',
      'в этом проекте всегда используй библиотеку Redux для управления глобальным состоянием приложения',
    ],
    [
      'a port number',
      'локальный сервер разработки всегда слушает порт 8080',
      'локальный сервер разработки всегда слушает порт 3000',
    ],
    ['a test runner name', 'тесты пишем на Vitest локально', 'тесты пишем на Jest локально'],
  ])('keeps Cyrillic statements that differ only in %s below the MERGE threshold', (_label, a, b) => {
    const score = similarity(a, b);
    expect(score).toBeLessThan(SIMILARITY_MERGE);
    // 仍是相关候选（高于 findSimilar 的 0.1 过滤线），只是不能被判为重复或合并。
    expect(score).toBeGreaterThan(0.1);
    expect(similarity(b, a)).toBeCloseTo(score, 10);
  });

  it('does not cap mixed-script restatements that share their Core identifier', () => {
    // Core 词有交集（zustand）时不封顶：加长一句仍判为重复，NFD 形式仍判为重复。
    expect(
      similarity(
        'используй Zustand для глобального состояния',
        'используй Zustand для глобального состояния приложения'
      )
    ).toBeGreaterThanOrEqual(SIMILARITY_UPDATE);
    const sentence = 'используй Zustand для глобального состояния';
    expect(similarity(sentence.normalize('NFD'), sentence)).toBe(1);
  });

  it('does not cap statements that differ in one identifier but still share another', () => {
    // 决策的例外：Core token 有交集（两句都含 public）就不封顶，这类句对与英文同构句走同一条路
    // （按分值进入 MERGE 或 UPDATE 区间），只差端口号不足以把它们强行分开。
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    const score = similarity(
      'локальный сервер разработки всегда слушает порт 8080 и отдаёт статику из папки public',
      'локальный сервер разработки всегда слушает порт 3000 и отдаёт статику из папки public'
    );
    expect(score).toBeGreaterThanOrEqual(SIMILARITY_MERGE);
    expect(debug.mock.calls.some((call) => String(call[0]).includes('no Core word'))).toBe(false);
  });

  it('keeps Latin and CJK statements that differ only in an identifier unchanged', () => {
    // 英文同构句本来就走 UPDATE / MERGE（Core 字符 bigram 对单个 token 不敏感），封顶只对补充 token 路径生效。
    const controls: Array<[string, string]> = [
      [
        'in this project always use the Zustand library for global application state management',
        'in this project always use the Redux library for global application state management',
      ],
      [
        'the local dev server always listens on port 8080 and serves static files from public',
        'the local dev server always listens on port 3000 and serves static files from public',
      ],
      ['we write tests with Vitest locally', 'we write tests with Jest locally'],
      ['项目使用 Zustand 管理全局状态', '项目使用 Redux 管理全局状态'],
      ['本地开发服务器监听 8080 端口', '本地开发服务器监听 3000 端口'],
    ];
    for (const [a, b] of controls) {
      const lowerA = a.toLowerCase();
      const lowerB = b.toLowerCase();
      const bonus = lowerA.includes(lowerB) || lowerB.includes(lowerA) ? 0.3 : 0;
      const expected = Math.min(
        1,
        jaccardSimilarity(tokenizeForSimilarity(lowerA), tokenizeForSimilarity(lowerB)) + bonus
      );
      expect(similarity(a, b)).toBe(expected);
    }
    expect(
      similarity(
        'in this project always use the Zustand library for global application state management',
        'in this project always use the Redux library for global application state management'
      )
    ).toBeGreaterThanOrEqual(SIMILARITY_UPDATE);
  });

  // 韩文单音节词（NFC 下单码点：안、못、꼭、씀、써、다 …）在第三轮修复里不产生任何 token，
  // 两条只共享一个拉丁标识符、其余都是单音节词的韩文记忆相似度仍为 1.0。
  // 注意：分值本身拉不开只差一个否定词的长句（整词 Jaccard 为 n/(n+1)，句尾“… 안 함”再加 containsBonus），
  // 所以“正反两句不得判为同一条”由 MemoryConsolidator / MemoryRetriever.append 的极性判定保证（L6-P3r5），
  // 端到端用例在 test/memory-store-script-dedup.test.ts；这里只锁定短句的分值不再是 1.0。
  it.each([
    ['pnpm', 'pnpm 꼭 씀', 'pnpm 안 씀'],
    ['Zustand', 'Zustand 꼭 써', 'Zustand 안 써'],
    ['localStorage', '토큰은 localStorage 에 저장', '토큰은 localStorage 에 안 저장'],
  ])('scores short Korean statements negated by the single syllable 안 around %s below the UPDATE threshold', (_label, a, b) => {
    const score = similarity(a, b);
    expect(score).toBeLessThan(SIMILARITY_UPDATE);
    expect(similarity(b, a)).toBeCloseTo(score, 10);
  });

  it('gives single-syllable Korean words a token without breaking identical restatements', () => {
    expect(similarity('pnpm 꼭', 'pnpm 안')).toBeLessThan(1);
    expect(similarity('pnpm 꼭 씀', 'pnpm 꼭 씀')).toBe(1);
    expect(similarity('pnpm 꼭 씀'.normalize('NFD'), 'pnpm 꼭 씀')).toBe(1);
    expect(similarity('  PNPM 꼭   씀 ', 'pnpm 꼭 씀')).toBe(1);
  });

  it('logs the identifier cap and the whole-word bound at debug level without memory content', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    similarity('тесты пишем на Vitest локально', 'тесты пишем на Jest локально');
    let messages = debug.mock.calls.map((call) => String(call[0]));
    const capped = messages.find((message) => message.includes('no Core word'));
    expect(capped).toBeDefined();
    expect(capped).toContain('[MemoryStore]');
    expect(capped).not.toContain('тесты');
    expect(capped).not.toContain('vitest');

    debug.mockClear();
    similarity('토큰은 localStorage 에 저장', '토큰은 localStorage 에 안 저장');
    messages = debug.mock.calls.map((call) => String(call[0]));
    const bounded = messages.find((message) => message.includes('whole-word Jaccard'));
    expect(bounded).toBeDefined();
    expect(bounded).toContain('[MemoryStore]');
    expect(bounded).not.toContain('토큰은');
    expect(bounded).not.toContain('localstorage');
    expect(messages.some((message) => message.includes('no Core word'))).toBe(false);

    // 纯 ASCII 文本不进入补充 token 路径，两条诊断都不出现。
    debug.mockClear();
    similarity('we write tests with Vitest locally', 'we write tests with Jest locally');
    messages = debug.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes('no Core word'))).toBe(false);
    expect(messages.some((message) => message.includes('whole-word Jaccard'))).toBe(false);
  });
});

describe('MemoryStore.computeSimilarity Core-word cap under NFD input (L6-P3r5)', () => {
  // 第五轮审计：L6-P3r4 的封顶判断从 NFC 正文切 Core 词，Core token 却来自未归一化的原串。
  // NFD 的 'für' 在原串里切出 Core token 'fu'，在 NFC 正文里却切不出任何 ≥2 字符的片段；
  // 双方 Core 词都为空被当成“没有共同 Core 词”，完全相同的 NFD 文本被封顶到 0.5，两次写入多出一行。
  it.each([
    ['für ок', 'für ок'],
    ['tôi là gì đó', 'tôi là gì đó'],
    ['für', 'für'],
  ])('still treats the identical NFD text %s as a duplicate', (text) => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    const nfd = text.normalize('NFD');
    expect(tokenizeForSimilarity(nfd.toLowerCase()).size).toBeGreaterThan(0);
    expect(similarity(nfd, nfd)).toBe(1);
    expect(debug.mock.calls.some((call) => String(call[0]).includes('no Core word'))).toBe(false);
  });

  it('does not cap the same accented identifier written in NFD on one side and NFC on the other', () => {
    // Core 词同时取原串与 NFC 两种切法：'café' 的 NFD 原串切出 cafe、NFC 切出 caf，
    // 同一标识符的两种写法仍算共享 Core 词，分值与 L6-P3r4 相同，不因本次修复新增封顶。
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    const text = 'café ресторан';
    expect(similarity(text.normalize('NFD'), text)).toBeGreaterThan(0.5);
    expect(debug.mock.calls.some((call) => String(call[0]).includes('no Core word'))).toBe(false);
  });

  it('still caps NFD statements whose Core identifiers differ', () => {
    // 封顶本身不变：NFD 输入里只差拉丁标识符的两句俄文仍低于 MERGE 门槛。
    const score = similarity(
      'тесты пишем на Vitest локально'.normalize('NFD'),
      'тесты пишем на Jest локально'.normalize('NFD')
    );
    expect(score).toBeLessThan(0.6);
  });
});
