import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareRecipeProductionItem } from '../src/tools/runtime/handlers/recipeProductionAdapter.js';
import { createTempProject } from './helpers/tempProject.js';

/**
 * AUD-sweep-c（审计 L4-P2）：distinctSorted 固定 en 排序规则后，“中文环境下与历史顺序一致”只对
 * 不含汉字的引用成立。evidenceRefs 是项目相对路径、sourceFieldRefs 是字段名，二者都可能含汉字；
 * zh 区域把汉字排在拉丁字母之前，en 排在之后。所以中文默认区域进程里撰写过、且引用含汉字的
 * 配方，重新撰写后 provenance 顺序变化，Core 的 profileHash / documentSetHash 随之改变。
 * 这里把这个影响面钉成事实（不改排序：事项⑥已答复（2026-10-20），本轮只收敛副本、不改排序），
 * 并要求注释如实写出它。
 */

/** 模拟默认区域不同的进程：未显式指定 locale 的比较改用给定区域的排序规则。 */
function simulateDefaultLocale(locale: string) {
  const original = String.prototype.localeCompare;
  vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (
    this: string,
    that: string,
    locales?: Intl.LocalesArgument,
    options?: Intl.CollatorOptions
  ) {
    return original.call(this, that, locales ?? locale, options);
  });
}

/** 固定 en 之前 distinctSorted 的写法：去重后按进程默认区域排序。 */
function historicalOrder(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function makeProject(): string {
  const root = createTempProject('agent-recipe-han-');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', '设计.ts'), 'export const design = 1;\n');
  writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n');
  writeFileSync(path.join(root, 'src', 'cz.ts'), 'export const cz = 3;\n');
  writeFileSync(path.join(root, 'src', 'aa.ts'), 'export const aa = 4;\n');
  writeFileSync(path.join(root, 'src', '中文.ts'), 'export const zhongwen = 5;\n');
  writeFileSync(path.join(root, 'src', '安装.ts'), 'export const anzhuang = 6;\n');
  return root;
}

function provenance(root: string, sources: string[], sourceFieldRefs: string[]) {
  const prepared = prepareRecipeProductionItem(
    {
      title: 'Han collation provenance',
      reasoning: { sources },
      retrievalProfile: {
        primaryLanguage: 'zh',
        summary: { primary: 'p', technicalEnglish: 't' },
        provenance: { sourceFieldRefs },
      },
    },
    root
  );
  expect(prepared.profileEvidence.rejected).toEqual([]);
  const result = prepared.item.retrievalProfile?.provenance;
  return { evidenceRefs: result?.evidenceRefs, sourceFieldRefs: result?.sourceFieldRefs };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recipe provenance order under a Chinese default locale (L4-P2)', () => {
  it('keeps the historical zh order for ASCII refs but not for refs containing Han characters', () => {
    const root = makeProject();
    const asciiSources = ['src/cz.ts:1', 'src/b.ts:1', 'src/aa.ts:1'];
    const hanSources = ['src/设计.ts:1', 'src/b.ts:1'];
    const hanFields = ['field:设计', 'field:b'];

    simulateDefaultLocale('zh-CN');

    // 不含汉字：固定 en 的顺序就是中文默认区域下的历史顺序，哈希不变。
    expect(provenance(root, asciiSources, []).evidenceRefs).toEqual(historicalOrder(asciiSources));
    // 含汉字：历史 zh 顺序把汉字排在前，固定 en 后排在后，持久化哈希会变。
    const han = provenance(root, hanSources, hanFields);
    expect(han.evidenceRefs).toEqual(['src/b.ts:1', 'src/设计.ts:1']);
    expect(historicalOrder(hanSources)).toEqual(['src/设计.ts:1', 'src/b.ts:1']);
    expect(han.sourceFieldRefs).toEqual(['field:b', 'field:设计']);
    expect(historicalOrder(hanFields)).toEqual(['field:设计', 'field:b']);
    // 汉字之间：zh 按拼音（an < she < zhong），en 不按拼音。
    const hanOnly = ['src/设计.ts:1', 'src/中文.ts:1', 'src/安装.ts:1'];
    expect(provenance(root, hanOnly, []).evidenceRefs).toEqual([
      'src/中文.ts:1',
      'src/安装.ts:1',
      'src/设计.ts:1',
    ]);
    expect(historicalOrder(hanOnly)).toEqual(['src/安装.ts:1', 'src/设计.ts:1', 'src/中文.ts:1']);
  });

  it('documents that only refs without Han characters keep the historical zh order', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/tools/runtime/handlers/recipeProductionAdapter.ts'),
      'utf8'
    );
    const index = source.indexOf('function distinctSorted(');
    expect(index).toBeGreaterThanOrEqual(0);
    const head = source.slice(0, index).trimEnd();
    const doc = head.slice(head.lastIndexOf('/**'));
    expect(doc).not.toContain('英文、中文环境下与历史顺序一致，');
    // 事项⑥已答复（2026-10-20）：注释不得再把它写成待决。
    expect(doc).not.toContain('待决事项⑥');
    for (const fact of ['汉字', 'profileHash', 'documentSetHash', '事项⑥已答复']) {
      expect(doc).toContain(fact);
    }
  });
});
