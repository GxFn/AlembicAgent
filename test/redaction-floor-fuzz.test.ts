/**
 * 脱敏阶段 1 底线的对抗模糊与载体三明治（设计第 6 节测试要求 3，固定种子，失败可复现）。
 *
 * - 对抗模糊 40,000 例：同一 JSON 载体内的多键值三明治、\u 与 \/ 重编码、字面 [redacted]、双层载体、
 *   带行前缀与省略标记的 PEM、URL userinfo 与 SAS 签名尾段。每例用哨兵 oracle 对四个历史版本零回退，
 *   并检查幂等、裸换行守恒、新写出的标记都在封闭词表内；每 20 例另交给攻击夹具按精确 oracle 判定。
 * - 载体三明治 3,300 例：只有现行规则遮住的值与只有早期版本遮住的值放进同一个载体（同一字面量、兄弟字段、
 *   数组、双层载体），全部按精确 oracle 判定。
 * 样本全部是合成值。
 */
import { describe, expect, test } from 'vitest';
import { redactDeveloperText } from '../src/agent/utils/Redaction.js';
import { REDACTION_MARKERS } from '../src/agent/utils/redaction/hiddenSpans.js';
import {
  adversarialInputs,
  carrierSandwiches,
  HEAD_ONLY_SHAPES,
} from './fixtures/redaction-catalog/fuzzCorpus.js';
import { checkNoLegacyRegression } from './fixtures/redaction-catalog/legacyRegressionOracle.js';
import { BASELINE_REVISIONS, frozenRedact } from './fixtures/redaction-catalog/trackedReplay.js';

const SEED = 20261019;
const ADVERSARIAL_TOTAL = 40_000;
const CHUNKS = 8;

function newlineSkeleton(text: string): string {
  return text.replace(/[^\r\n]/g, '');
}

function fullOracleProblems(input: string): string[] {
  const report = checkNoLegacyRegression(input);
  return [
    ...report.exposures.map(
      (exposure) =>
        `${exposure.oracle} vs ${exposure.baseline} ${JSON.stringify(exposure.fragment)} in ${JSON.stringify(input)}`
    ),
    ...report.alignerViolations.map((violation) => `${violation} in ${JSON.stringify(input)}`),
    ...report.structuralViolations.map((violation) => `${violation} in ${JSON.stringify(input)}`),
  ];
}

let adversarialCount = 0;
let fullOracleCount = 0;

describe('adversarial fuzz (fixed seed)', () => {
  const inputs = adversarialInputs(ADVERSARIAL_TOTAL, SEED);
  const size = ADVERSARIAL_TOTAL / CHUNKS;

  test.each(
    Array.from({ length: CHUNKS }, (_, chunk) => ({ chunk }))
  )('chunk $chunk keeps every baseline-masked secret hidden', ({ chunk }) => {
    const problems: string[] = [];
    for (let index = chunk * size; index < (chunk + 1) * size; index++) {
      const input = inputs[index] ?? '';
      adversarialCount++;
      const output = redactDeveloperText(input);
      for (const fragment of new Set(input.match(/SYNTH\w*|Synth\w*/g) ?? [])) {
        for (const revision of BASELINE_REVISIONS) {
          if (!frozenRedact(revision, input).includes(fragment) && output.includes(fragment)) {
            problems.push(`sentinel vs ${revision} ${fragment} in ${JSON.stringify(input)}`);
          }
        }
      }
      if (redactDeveloperText(output) !== output) {
        problems.push(`not idempotent: ${JSON.stringify(input)}`);
      }
      if (newlineSkeleton(output) !== newlineSkeleton(input)) {
        problems.push(`newline sequence changed: ${JSON.stringify(input)}`);
      }
      for (const match of output.matchAll(/\[redacted[^\]\s"'\\]*\]/g)) {
        if (!REDACTION_MARKERS.includes(match[0]) && !input.includes(match[0])) {
          problems.push(`marker outside the vocabulary ${match[0]}`);
        }
      }
      if (index % 20 === 0) {
        fullOracleCount++;
        problems.push(...fullOracleProblems(input));
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
  }, 120_000);

  test('ran the full adversarial corpus', () => {
    expect(adversarialCount).toBe(ADVERSARIAL_TOTAL);
    expect(fullOracleCount).toBe(ADVERSARIAL_TOTAL / 20);
    // 语料确实包含载体、重编码与字面标记，避免生成器退化。
    expect(
      inputs.filter((input) => input.startsWith('{') || input.startsWith('[')).length
    ).toBeGreaterThan(ADVERSARIAL_TOTAL / 2);
    expect(inputs.filter((input) => /\\u00|\\\//.test(input)).length).toBeGreaterThan(1_000);
    expect(inputs.filter((input) => input.includes('[redacted')).length).toBeGreaterThan(1_000);
  });
});

describe('carrier sandwiches: current-rules-only and legacy-only values in one carrier', () => {
  const cases = carrierSandwiches();

  test.each(
    HEAD_ONLY_SHAPES.map((_, head) => ({ head }))
  )('head shape $head against every legacy-only shape and layout', ({ head }) => {
    const problems: string[] = [];
    for (const { name, input } of cases.filter((entry) => entry.name.startsWith(`h${head}/`))) {
      const found = fullOracleProblems(input);
      if (found.length > 0) {
        problems.push(`${name}: ${found[0]}`);
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
  }, 120_000);

  test('covers about 3,300 sandwiches', () => {
    expect(cases).toHaveLength(3_300);
  });
});
