/**
 * L6-P3r4：非拉丁文本去重在真实调用链（MemoryConsolidator.consolidate、MemoryRetriever.append）上的行为。
 *
 * 纯函数分值用例在 test/memory-store-similarity.test.ts；这里只覆盖"分值落到哪个门槛区间后，记忆库里剩下什么"。
 * 需要 better-sqlite3 原生模块能在当前 Node 下加载。
 */
import Logger from '@alembic/core/logging';
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

  it('replaces the affirmative localStorage statement with its 안-negation instead of merging them', () => {
    // 第五轮审计：L6-P3r4 只把这组从 UPDATE 改成了 MERGE，库里剩下一行“…저장; …안 저장”。
    // 现在韩文否定词进入矛盾判定，与英文 store / do not store 同路：后到的一句就地取代前一句。
    const first = '토큰은 localStorage 에 저장';
    const second = '토큰은 localStorage 에 안 저장';
    const { consolidated, appended } = runBothPaths(first, second);
    expect(consolidated.stats).toMatchObject({ added: 1, updated: 0, merged: 0, replaced: 1 });
    expect(consolidated.contents).toEqual([second]);
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

/** 两条同 type 记忆按给定顺序固化，返回统计与库里剩下的正文。 */
function consolidatePair(first: string, second: string, type = 'preference') {
  return withStore((store) => {
    const stats = new MemoryConsolidator(store).consolidate([
      { type, content: first, importance: 6 },
      { type, content: second, importance: 6 },
    ]);
    return { stats, contents: activeContents(store) };
  });
}

/** 两条同 type 记忆按给定顺序 append，返回库里剩下的正文。 */
function appendPair(first: string, second: string, type = 'preference') {
  return withStore((store) => {
    const retriever = new MemoryRetriever(store);
    retriever.append({ type, content: first, importance: 5 });
    retriever.append({ type, content: second, importance: 5 });
    return activeContents(store);
  });
}

describe('Korean negation polarity in consolidate and append (L6-P3r5)', () => {
  // 用户决定（2026-10-21）第 2 条：否定词 안 的正反两句不得判为同一条。
  // L6-P3r4 只压了相似度：正反两句只差一个词时整词 Jaccard 是 n/(n+1)，共享词 ≥ 6 个时仍 ≥ 0.85；
  // 句尾“… 안 함”时肯定句是否定句的子串，containsBonus 又把分值抬回 ≥ 0.85。结果否定句被 UPDATE 丢弃，
  // 或被 MERGE 与肯定句拼成一行。现在韩文否定标记进入 MemoryConsolidator 的极性判定，正反两句与英文
  // “store … / do not store …” 走同一条矛盾替换路径（后到的一句取代前一句）；append 的去重也看极性。
  it.each([
    [
      'Redis 캐시 (안 before the verb)',
      '테스트 실행 전에 Redis 캐시를 비운다',
      '테스트 실행 전에 Redis 캐시를 안 비운다',
    ],
    [
      'localStorage 저장한다 (7 shared words)',
      '로그인 토큰은 보안 때문에 브라우저 localStorage에 저장한다',
      '로그인 토큰은 보안 때문에 브라우저 localStorage에 안 저장한다',
    ],
    [
      'Yarn 대신 pnpm (7 shared words)',
      '이 프로젝트에서는 빌드할 때 Yarn 대신 pnpm을 사용한다',
      '이 프로젝트에서는 빌드할 때 Yarn 대신 pnpm을 안 사용한다',
    ],
    [
      'Docker 빌드',
      '배포 전에 항상 Docker 이미지를 새로 빌드한다',
      '배포 전에 항상 Docker 이미지를 새로 안 빌드한다',
    ],
    [
      'ESLint 실행 (6 shared words)',
      '커밋 전에 항상 ESLint 검사를 실행한다',
      '커밋 전에 항상 ESLint 검사를 안 실행한다',
    ],
    [
      'sentence-final 안 함 after 저장',
      '토큰을 localStorage에 저장',
      '토큰을 localStorage에 저장 안 함',
    ],
    ['sentence-final 안 함 after 사용', '빌드할 때 pnpm 사용', '빌드할 때 pnpm 사용 안 함'],
    [
      'the decision-named 토큰은 localStorage 에 (안) 저장',
      '토큰은 localStorage 에 저장',
      '토큰은 localStorage 에 안 저장',
    ],
    ['pnpm 씀 / pnpm 안 씀', 'pnpm 씀', 'pnpm 안 씀'],
    [
      'a natural sentence with sentence-final 안 해',
      'CI 파이프라인에서는 매번 Playwright 브라우저 캐시를 새로 설치해',
      'CI 파이프라인에서는 매번 Playwright 브라우저 캐시를 새로 설치 안 해',
    ],
    [
      'the long form -지 않는다',
      '로그인 토큰은 보안 때문에 브라우저 localStorage에 저장한다',
      '로그인 토큰은 보안 때문에 브라우저 localStorage에 저장하지 않는다',
    ],
    [
      'the short form 못',
      '오프라인 환경의 빌드 서버에서는 사내 npm 레지스트리를 쓴다',
      '오프라인 환경의 빌드 서버에서는 사내 npm 레지스트리를 못 쓴다',
    ],
  ])('keeps the negated Korean statement for %s', (_label, affirmative, negated) => {
    const forward = consolidatePair(affirmative, negated);
    expect(forward.stats).toMatchObject({ added: 1, updated: 0, merged: 0, replaced: 1 });
    expect(forward.contents).toEqual([negated]);

    // 逆序：后到的肯定句同样取代否定句，而不是被当作重复吞掉。
    const reverse = consolidatePair(negated, affirmative);
    expect(reverse.stats).toMatchObject({ added: 1, updated: 0, merged: 0, replaced: 1 });
    expect(reverse.contents).toEqual([affirmative]);

    // append 没有替换语义：极性相反时不按 UPDATE 跳过，两句都写入。
    expect(appendPair(affirmative, negated)).toEqual([affirmative, negated].sort());
    expect(appendPair(negated, affirmative)).toEqual([affirmative, negated].sort());
  });

  it('does not read the noun 안 (inside) as a negation', () => {
    // 'Docker 컨테이너 안 설정 파일' 里的 안 是名词“里面”：它不是否定，所以第二句的 안 수정한다 才构成相反极性。
    const affirmative = 'Docker 컨테이너 안 설정 파일을 배포 때마다 수정한다';
    const negated = 'Docker 컨테이너 안 설정 파일을 배포 때마다 안 수정한다';
    const forward = consolidatePair(affirmative, negated);
    expect(forward.stats).toMatchObject({ added: 1, updated: 0, merged: 0, replaced: 1 });
    expect(forward.contents).toEqual([negated]);
    expect(appendPair(affirmative, negated)).toEqual([affirmative, negated].sort());

    // 名词 안（含 안에 / 안에서）的同义复述仍按 UPDATE 去重，不因“像否定”被拆成两行。
    const restated = 'Docker 컨테이너 안에 설정 파일을 둔다';
    const sameAgain = consolidatePair(restated, `  ${restated} `);
    expect(sameAgain.stats).toMatchObject({ added: 1, updated: 1, merged: 0 });
    expect(sameAgain.contents).toEqual([restated]);
    expect(appendPair(restated, restated)).toEqual([restated]);
  });

  it('still deduplicates an identical restatement of a negated Korean statement', () => {
    const negated = '빌드할 때 pnpm 사용 안 함';
    const consolidated = consolidatePair(negated, ` ${negated}  `);
    expect(consolidated.stats).toMatchObject({ added: 1, updated: 1, merged: 0 });
    expect(consolidated.stats).not.toHaveProperty('replaced');
    expect(consolidated.contents).toEqual([negated]);
    expect(appendPair(negated, negated)).toEqual([negated]);
  });

  it('dedupes an append against a same-polarity row even when an opposite-polarity row ranks first', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    withStore((store) => {
      const affirmative = '로그인 토큰은 보안 때문에 브라우저 localStorage에 저장';
      // 否定句以肯定句为前缀（句尾 안 함），containsBonus 让它排第一（≈1.0）；
      // 同极性的复述多了一个词，分值较低但仍 ≥ 0.85。只能与后者去重，不能吞进否定句，也不能再写一行。
      const negated = `${affirmative} 안 함`;
      const restated = '로그인 토큰은 보안 때문에 항상 브라우저 localStorage에 저장';
      const negatedRow = store.add({ type: 'preference', content: negated, importance: 5 });
      const restatedRow = store.add({ type: 'preference', content: restated, importance: 5 });
      const ranked = store.findSimilar(affirmative, 'preference', 3);
      expect(ranked[0]?.id).toBe(negatedRow.id);
      expect(ranked[1]?.id).toBe(restatedRow.id);
      expect(ranked[1]?.similarity ?? 0).toBeGreaterThanOrEqual(0.85);

      new MemoryRetriever(store).append({
        type: 'preference',
        content: affirmative,
        importance: 9,
      });
      expect(activeContents(store)).toEqual([negated, restated].sort());
      expect(store.get(restatedRow.id)?.importance).toBe(9);
      expect(store.get(negatedRow.id)?.importance).toBe(5);
    });
    const diagnostic = debug.mock.calls
      .map((call) => String(call[0]))
      .find((message) => message.includes('Korean negation polarity is opposite'));
    expect(diagnostic).toContain('[MemoryRetriever]');
    expect(diagnostic).toContain('outcome=deduped-against-same-polarity-row');
    expect(diagnostic).not.toContain('토큰');
  });

  it('logs the opposite-polarity append that is written as a new row without memory content', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    expect(
      appendPair('토큰을 localStorage에 저장', '토큰을 localStorage에 저장 안 함')
    ).toHaveLength(2);
    const diagnostic = debug.mock.calls
      .map((call) => String(call[0]))
      .find((message) => message.includes('Korean negation polarity is opposite'));
    expect(diagnostic).toContain('outcome=written-as-new-row');
    expect(diagnostic).toContain('type=preference');
    expect(diagnostic).not.toContain('localstorage');
    expect(diagnostic).not.toContain('토큰');
  });

  it('keeps the English and Chinese contradiction controls unchanged', () => {
    const english = consolidatePair(
      'store the token in localStorage',
      'do not store the token in localStorage',
      'fact'
    );
    expect(english.stats).toMatchObject({ added: 1, updated: 0, merged: 0, replaced: 1 });
    expect(english.contents).toEqual(['do not store the token in localStorage']);

    const chinese = consolidatePair(
      '项目使用 localStorage 存储登录令牌',
      '项目不再使用 localStorage 存储登录令牌',
      'fact'
    );
    expect(chinese.stats).toMatchObject({ added: 1, updated: 0, merged: 0, replaced: 1 });
    expect(chinese.contents).toEqual(['项目不再使用 localStorage 存储登录令牌']);
  });
});

describe('Identical NFD text after the Core-word cap (L6-P3r5)', () => {
  // L6-P3r4 把 Core 词从 NFC 正文切出，NFD 'für' 的 Core token 'fu' 在 NFC 下消失，相同文本被封顶到 0.5，
  // consolidate 与 append 都多写一行。Core 词改为与 Core token 同源（原串）后恢复去重。
  it.each([
    ['für ок', 'für ок'.normalize('NFD')],
    ['tôi là gì đó', 'tôi là gì đó'.normalize('NFD')],
  ])('dedupes %s written twice in NFD', (_label, nfd) => {
    const consolidated = consolidatePair(nfd, nfd);
    expect(consolidated.stats).toMatchObject({ added: 1, updated: 1, merged: 0 });
    expect(consolidated.contents).toEqual([nfd]);
    expect(appendPair(nfd, nfd)).toEqual([nfd]);
  });
});
