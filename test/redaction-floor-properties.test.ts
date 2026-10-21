/**
 * 脱敏阶段 1 底线的性质与精确 oracle（设计第 6 节测试要求 2、3、5）。固定种子，全部可复现。
 *
 * - 语法网格（12 键 × 10 分隔符 × 25 值形态 × 16 上下文 = 48,000 例）：哨兵 oracle 对四个历史版本零回退，
 *   并检查幂等、裸换行序列守恒；抽样检查确定性。
 * - 唯一字符精确 oracle（10,800 例，每例 8 个互不相同的 CJK 字符 × 4 个基线 ≥ 30 万次检查）：某字符被基线
 *   遮住当且仅当它不出现在基线输出里；被遮的字符不得出现在新输出里（0 漏判）。同时逐字符核对对齐器：
 *   早期版本的超集不得漏判，现行规则的子集不得误判。
 * - 词法实现与参照正则逐 token 等价。
 * 样本全部是合成值。
 */
import { describe, expect, test } from 'vitest';
import {
  redactDeveloperText,
  redactDeveloperTextWithReport,
} from '../src/agent/utils/Redaction.js';
import {
  hiddenSubset,
  hiddenSuperset,
  lexMarkers,
  lexMarkersByRegex,
} from '../src/agent/utils/redaction/hiddenSpans.js';
import {
  adversarialInputs,
  GRID_CONTEXTS,
  grammarGridFor,
  seededRandom,
  uniqueCharGrid,
} from './fixtures/redaction-catalog/fuzzCorpus.js';
import {
  BASELINE_REVISIONS,
  type BaselineRevision,
  frozenRedact,
} from './fixtures/redaction-catalog/trackedReplay.js';

const SLOW = { timeout: 120_000 };

function newlineSkeleton(text: string): string {
  return text.replace(/[^\r\n]/g, '');
}

/** 哨兵 oracle：任一基线输出里不含的 SYNTH… 片段，新输出也不得含。返回违规描述。 */
function sentinelViolations(input: string, output: string): string[] {
  const violations: string[] = [];
  const fragments = new Set(input.match(/SYNTH\w*|Synth\w*/g) ?? []);
  if (fragments.size === 0) {
    return violations;
  }
  for (const revision of BASELINE_REVISIONS) {
    const baseline = frozenRedact(revision, input);
    for (const fragment of fragments) {
      if (!baseline.includes(fragment) && output.includes(fragment)) {
        violations.push(`${revision} masked ${fragment} in ${JSON.stringify(input)}`);
      }
    }
  }
  return violations;
}

let gridInputs = 0;
let sentinelChecks = 0;

describe('grammar grid: zero regression, idempotence and newline conservation', () => {
  test.each(GRID_CONTEXTS.map((context, index) => ({ name: context.name, index })))(
    'context $name (3,000 inputs)',
    ({ index }) => {
      const violations: string[] = [];
      for (const [position, { input, secret }] of grammarGridFor(index).entries()) {
        gridInputs++;
        const output = redactDeveloperText(input);
        sentinelChecks += BASELINE_REVISIONS.length;
        violations.push(...sentinelViolations(input, output));
        if (redactDeveloperText(output) !== output) {
          violations.push(`not idempotent: ${JSON.stringify(input)}`);
        }
        if (newlineSkeleton(output) !== newlineSkeleton(input)) {
          violations.push(`newline sequence changed: ${JSON.stringify(input)}`);
        }
        if (position % 97 === 0) {
          const again = redactDeveloperTextWithReport(input);
          if (again.text !== output) {
            violations.push(`not deterministic: ${JSON.stringify(input)}`);
          }
          expect(redactDeveloperTextWithReport(input).report).toEqual(again.report);
        }
        expect(input).toContain(secret);
      }
      expect(violations.slice(0, 10)).toEqual([]);
    },
    SLOW.timeout
  );

  test('covers at least 48,000 grid inputs', () => {
    expect(gridInputs).toBeGreaterThanOrEqual(48_000);
    expect(sentinelChecks).toBeGreaterThanOrEqual(48_000 * 4);
  });
});

let exactChecks = 0;
let exactHiddenChecks = 0;
let alignerChecks = 0;

describe('unique-character exact oracle', () => {
  const cases = uniqueCharGrid();
  const chunks = 6;
  const size = Math.ceil(cases.length / chunks);

  test.each(Array.from({ length: chunks }, (_, chunk) => ({ chunk })))(
    'chunk $chunk: every character a baseline hides stays hidden, and the aligner is exact',
    ({ chunk }) => {
      const violations: string[] = [];
      for (const { input, uniques } of cases.slice(chunk * size, (chunk + 1) * size)) {
        const output = redactDeveloperText(input);
        const outputs = new Map<BaselineRevision, string>(
          BASELINE_REVISIONS.map((revision) => [revision, frozenRedact(revision, input)])
        );
        for (const [revision, baseline] of outputs) {
          const superset =
            revision === 'b60a61e'
              ? null
              : hiddenSuperset(input, baseline, { reencodes: revision === 'd113986' }).marks;
          const subset =
            revision === 'b60a61e'
              ? hiddenSubset(input, baseline, { reencodes: true }).marks
              : null;
          for (const unique of uniques) {
            exactChecks++;
            const position = input.indexOf(unique);
            const hidden = !baseline.includes(unique);
            if (hidden) {
              exactHiddenChecks++;
              if (output.includes(unique)) {
                violations.push(
                  `${revision} hid ${unique} but it leaked: ${JSON.stringify(input)}`
                );
              }
              if (superset !== null) {
                alignerChecks++;
                if (superset[position] !== 1) {
                  violations.push(
                    `superset of ${revision} misses ${unique}: ${JSON.stringify(input)}`
                  );
                }
              }
            } else if (subset !== null) {
              alignerChecks++;
              if (subset[position] === 1) {
                violations.push(
                  `subset of ${revision} claims visible ${unique}: ${JSON.stringify(input)}`
                );
              }
            }
          }
        }
      }
      expect(violations.slice(0, 10)).toEqual([]);
    },
    SLOW.timeout
  );

  test('ran at least 300,000 exact checks with no miss', () => {
    expect(cases).toHaveLength(10_800);
    expect(exactChecks).toBeGreaterThanOrEqual(300_000);
    // 防止 oracle 空转：相当一部分检查确实落在“被某个基线遮住”的字符上。
    expect(exactHiddenChecks).toBeGreaterThan(exactChecks / 4);
    expect(alignerChecks).toBeGreaterThan(100_000);
  });
});

describe('structural properties', () => {
  test('idempotent, newline-conserving and deterministic on adversarial inputs', () => {
    const violations: string[] = [];
    for (const input of adversarialInputs(2_000, 7)) {
      const first = redactDeveloperText(input);
      if (redactDeveloperText(input) !== first) {
        violations.push(`not deterministic: ${JSON.stringify(input)}`);
      }
      if (redactDeveloperText(first) !== first) {
        violations.push(`not idempotent: ${JSON.stringify(input)}`);
      }
      if (newlineSkeleton(first) !== newlineSkeleton(input)) {
        violations.push(`newline sequence changed: ${JSON.stringify(input)}`);
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
  });

  test('CRLF, lone CR and empty lines keep their exact positions', () => {
    for (const input of [
      'a\r\npassword=Pa(ss)SYNTHETICcrlf\r\n\r\nb',
      'x\rJWT_SECRET=!SYNTHETICcr\ry',
      '\n\n"password": "SYNTHETIC first\nSYNTHETIC last"\n\n',
    ]) {
      const output = redactDeveloperText(input);
      expect(newlineSkeleton(output)).toBe(newlineSkeleton(input));
      expect(output).not.toMatch(/SYNTHETIC/);
    }
  });

  test('the indexOf lexer matches the reference T_ABS / T_SUB regexes token for token', () => {
    const random = seededRandom(424242);
    const atoms = [
      '[redacted]',
      '[redacted-api-key]',
      '[redacted-unaligned]',
      '[redacted-private-key]',
      '[redacted kv]',
      '[redactedX]',
      '"',
      "'",
      '\\',
      '\\\\',
      '\\n',
      '\\r',
      '\n',
      '\r',
      'n',
      'a',
      ' ',
      '[',
    ];
    const samples = adversarialInputs(500, 99);
    for (let index = 0; index < 4_000; index++) {
      let text = '';
      const length = 1 + Math.floor(random() * 14);
      for (let part = 0; part < length; part++) {
        text += atoms[Math.floor(random() * atoms.length)];
      }
      samples.push(text);
    }
    for (const sample of samples) {
      for (const lexicon of ['abs', 'sub'] as const) {
        expect(lexMarkers(sample, lexicon), `${lexicon} ${JSON.stringify(sample)}`).toEqual(
          lexMarkersByRegex(sample, lexicon)
        );
      }
    }
  });
});
