import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashCanonical } from '../src/agent/production/strict/primitives.js';

/**
 * 仓内自用规范哈希的区域无关性钉子。
 *
 * 背景：epoch / lineage / expression 等回执哈希在序列化前用 localeCompare 排键。不带
 * locale 参数时它取进程默认区域：英文、中文环境顺序一致，但匈牙利语、丹麦语、立陶宛语等
 * 环境对 ASCII 标识符的排序不同（`cs` 排在 `cz` 之后、`aa` 排在 `z` 之后），同一份内容会
 * 算出不同的哈希。现在五份键排序都固定为 en 排序规则：英文、中文环境下的结果与历史哈希
 * 完全相同，其他区域下也得到同一个值。改成码元序会改变已持久化的哈希，不在本次范围内。
 */

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : target.endsWith('.ts') ? [target] : [];
  });
}

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

describe('agent-internal canonical hashes do not depend on the process locale', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    'hu',
    'da',
    'lt',
  ])('keeps the hash when the process default collation is %s', (locale) => {
    const payload = {
      cs: 1,
      ct: 2,
      cz: 3,
      nested: { aa: 1, ab: 2, z: 3, iz: 4, y: 5, j: 6 },
      rows: [{ ty: 1, tz: 2 }],
    };
    const baseline = hashCanonical(payload);

    simulateDefaultLocale(locale);

    expect(hashCanonical(payload)).toBe(baseline);
  });

  it('keeps the legacy key order, so hashes produced before the pin still verify', () => {
    // 历史顺序把 `clusters` 排在 `clusterSetHash` 之前；码元序相反（大写 S 在前）。
    expect(hashCanonical({ clusterSetHash: 'h', clusters: [], schemaVersion: 1 })).toBe(
      sha256('{"clusters":[],"clusterSetHash":"h","schemaVersion":1}')
    );
  });

  it('pins the collation in every canonical key sorter', () => {
    // 五份 sortCanonical 各属一份回执编码合同，彼此不能互换，因此逐份检查而不是合并实现。
    const sorters = sourceFiles(SRC_ROOT)
      .map((file) => ({ file: path.relative(SRC_ROOT, file), source: readFileSync(file, 'utf8') }))
      .filter(({ source }) => /function sortCanonical\(/u.test(source));

    expect(sorters.map(({ file }) => file).sort()).toEqual([
      'agent/evaluation/IndependentValueReviewer.ts',
      'agent/evaluation/MiningJudge.ts',
      'agent/evaluation/StrictProductionFixtureEvaluation.ts',
      'agent/production/strict/primitives.ts',
      'agent/runs/plan/PlanAgentRun.ts',
    ]);
    for (const { file, source } of sorters) {
      const body = source.slice(source.indexOf('function sortCanonical('));
      const sorter = body.slice(0, body.indexOf('\n}\n'));
      expect(sorter, file).toContain("left.localeCompare(right, 'en')");
      expect(sorter, file).not.toMatch(/localeCompare\(right\)/u);
    }
  });
});
