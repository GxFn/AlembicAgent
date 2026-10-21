/**
 * L6-P3r4：非拉丁文本去重在真实调用链（MemoryConsolidator.consolidate、MemoryRetriever.append）上的行为。
 *
 * 纯函数分值用例在 test/memory-store-similarity.test.ts；这里只覆盖"分值落到哪个门槛区间后，记忆库里剩下什么"。
 * 需要 better-sqlite3 原生模块能在当前 Node 下加载。
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryConsolidator } from '../src/agent/memory/MemoryConsolidator.js';
import { MemoryRetriever } from '../src/agent/memory/MemoryRetriever.js';
import { MemoryStore } from '../src/agent/memory/MemoryStore.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function withStore<T>(run: (store: MemoryStore) => T): T {
  const db = new Database(':memory:');
  try {
    return run(new MemoryStore(db));
  } finally {
    db.close();
  }
}

function activeContents(store: MemoryStore): string[] {
  return store
    .getAllActive()
    .map((row) => row.content)
    .sort();
}

/** 两条同 type 记忆先后固化，再先后 append，返回两条路径各自留下的正文。 */
function runBothPaths(first: string, second: string, type = 'preference') {
  const consolidated = withStore((store) => {
    const stats = new MemoryConsolidator(store).consolidate([
      { type, content: first, importance: 6 },
      { type, content: second, importance: 6 },
    ]);
    return { stats, contents: activeContents(store) };
  });
  const appended = withStore((store) => {
    const retriever = new MemoryRetriever(store);
    retriever.append({ type, content: first, importance: 5 });
    retriever.append({ type, content: second, importance: 5 });
    return activeContents(store);
  });
  return { consolidated, appended };
}

describe('MemoryStore dedupe of statements that differ only in a Core identifier (L6-P3r4)', () => {
  // 用户决定（2026-10-21）：核心标识符不同就不算重复。第三轮修复后这些句对被 UPDATE 丢弃或 MERGE 拼接。
  it.each([
    [
      'Zustand / Redux',
      'в этом проекте всегда используй библиотеку Zustand для управления глобальным состоянием приложения',
      'в этом проекте всегда используй библиотеку Redux для управления глобальным состоянием приложения',
    ],
    [
      'port 8080 / 3000',
      'локальный сервер разработки всегда слушает порт 8080',
      'локальный сервер разработки всегда слушает порт 3000',
    ],
    ['Vitest / Jest', 'тесты пишем на Vitest локально', 'тесты пишем на Jest локально'],
  ])('keeps both Cyrillic statements that differ only in %s', (_label, first, second) => {
    const { consolidated, appended } = runBothPaths(first, second);
    expect(consolidated.stats).toMatchObject({ added: 2, updated: 0, merged: 0 });
    expect(consolidated.contents).toEqual([first, second].sort());
    expect(appended).toEqual([first, second].sort());
  });

  it('still relates statements that differ in one identifier but share another', () => {
    // 决策的例外：Core token 有交集（两句都含 public）就不封顶，这类句对按分值进入 MERGE 或 UPDATE，
    // 与英文同构句一致；这里只锁定"没有被强行分成两条"。
    const first =
      'локальный сервер разработки всегда слушает порт 8080 и отдаёт статику из папки public';
    const second =
      'локальный сервер разработки всегда слушает порт 3000 и отдаёт статику из папки public';
    const { consolidated } = runBothPaths(first, second);
    expect(consolidated.stats.added).toBe(1);
    expect(consolidated.stats.updated + consolidated.stats.merged).toBe(1);
  });

  it('still absorbs a Cyrillic restatement that keeps its Core identifier', () => {
    const first = 'используй Zustand для глобального состояния';
    const restated = '  Используй ZUSTAND для глобального  состояния';
    const { consolidated, appended } = runBothPaths(first, restated);
    expect(consolidated.stats).toMatchObject({ added: 1, updated: 1, merged: 0 });
    expect(consolidated.contents).toEqual([first]);
    expect(appended).toEqual([first]);
  });

  it('keeps the English behaviour for statements that differ only in an identifier', () => {
    // 英文同构句本来就走 UPDATE，本轮不改；这里锁定"封顶只对补充 token 路径生效"。
    const first =
      'in this project always use the Zustand library for global application state management';
    const second =
      'in this project always use the Redux library for global application state management';
    const { consolidated, appended } = runBothPaths(first, second, 'fact');
    expect(consolidated.stats).toMatchObject({ added: 1, updated: 1, merged: 0 });
    expect(consolidated.contents).toEqual([first]);
    expect(appended).toEqual([first]);
  });
});

describe('MemoryStore dedupe of Korean statements built from single-syllable words (L6-P3r4)', () => {
  // 第三轮修复对单码点词不补 token：'pnpm 꼭 씀'（一定用）与 'pnpm 안 씀'（不用）相似度 1.0，否定句被 UPDATE 丢弃。
  it.each([
    ['pnpm', 'pnpm 꼭 씀', 'pnpm 안 씀'],
    ['Zustand', 'Zustand 꼭 써', 'Zustand 안 써'],
  ])('keeps the affirmative and the negated %s statement as separate rows', (_label, first, second) => {
    const { consolidated, appended } = runBothPaths(first, second);
    expect(consolidated.stats).toMatchObject({ added: 2, updated: 0, merged: 0 });
    expect(consolidated.contents).toEqual([first, second].sort());
    expect(appended).toEqual([first, second].sort());
  });

  it('does not drop the negated localStorage statement as an UPDATE of the affirmative one', () => {
    const first = '토큰은 localStorage 에 저장';
    const second = '토큰은 localStorage 에 안 저장';
    const { consolidated, appended } = runBothPaths(first, second);
    // 韩文否定词不在 MemoryConsolidator 的矛盾模式里（范围外），这里只要求否定句不被静默丢弃：
    // 固化后两句都还在库里（独立两行，或因落在 MERGE 区间而拼在一行），append 后仍是两行。
    expect(consolidated.stats.updated).toBe(0);
    const stored = consolidated.contents.join('\n');
    expect(stored).toContain(first);
    expect(stored).toContain(second);
    expect(appended).toEqual([first, second].sort());
  });

  it('still absorbs an identical single-syllable Korean restatement', () => {
    const first = 'pnpm 꼭 씀';
    const { consolidated, appended } = runBothPaths(first, ' PNPM 꼭  씀 ');
    expect(consolidated.stats).toMatchObject({ added: 1, updated: 1, merged: 0 });
    expect(consolidated.contents).toEqual([first]);
    expect(appended).toEqual([first]);
  });
});
