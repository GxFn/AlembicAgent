/**
 * 脱敏底线的对抗模糊、载体三明治（设计第 6 节阶段 1 测试要求 3）与凭据语法生成器 G（阶段 4 测试要求 2、4），
 * 固定种子，失败可复现。
 *
 * - 对抗模糊 40,000 例：同一 JSON 载体内的多键值三明治、\u 与 \/ 重编码、字面 [redacted]、双层载体、
 *   带行前缀与省略标记的 PEM、URL userinfo 与 SAS 签名尾段。每例用哨兵 oracle 对四个历史版本零回退，
 *   并检查幂等、裸换行守恒、新写出的标记都在封闭词表内；全部 40,000 例都交给攻击夹具按精确 oracle 判定
 *   （RED-P4a2 第 4 项：不再抽样；本机 8 块合计约 45–65 s，控制在 90 s 内，每块超时 120 s），包括证明义务 4
 *   （H⁺ ⊇ 追踪重放位置）与渲染不退回骨架。
 * - 链式字面标记与引号交替（第五轮审计第 4 条）：不动点不触顶、两轮内收敛、幂等，并通过攻击夹具。
 * - 同一缺口混合两种换行形态（RED-P4a2 第 1 项）：渲染从不退回整篇骨架；整篇是 JSON 文档时逐层解码后的换行总数
 *   守恒。
 * - 载体三明治 3,300 例：只有现行规则遮住的值与只有早期版本遮住的值放进同一个载体（同一字面量、兄弟字段、
 *   数组、双层载体），全部按精确 oracle 判定（含渲染不退回骨架）。
 * - 凭据语法生成器 G 50,000 例（阶段 4b：T1 的写法维度）：秘密 × 写法 × 载体 × 行前缀 × 截断位置。判据只来自
 *   生成器元数据：秘密的任何不短于 4 字符的片段都不得出现在输出里；四个历史版本遮住的非结构字符必须落在 G 声明的
 *   凭据位置上，否则报“G 缺维度”并判失败（输入里有 G 不知道的凭据写法）。另检查裸换行守恒，每 5 例查幂等，
 *   每 50 例交给攻击夹具按精确 oracle 判定。
 * 样本全部是合成值。
 */
import { describe, expect, test } from 'vitest';
import {
  redactDeveloperText,
  redactDeveloperTextWithReport,
} from '../src/agent/utils/Redaction.js';
import { REDACTION_MARKERS } from '../src/agent/utils/redaction/hiddenSpans.js';
import {
  CARRIERS,
  claimedCombos,
  credentialGrammarCases,
  type GrammarCase,
  LINE_PREFIXES,
  leakedFragments,
  TRUNCATION_MARKERS,
} from './fixtures/redaction-catalog/credentialGrammar.js';
import {
  adversarialInputs,
  carrierSandwiches,
  chainedMarkerInputs,
  HEAD_ONLY_SHAPES,
  mixedNewlineGapInputs,
} from './fixtures/redaction-catalog/fuzzCorpus.js';
import {
  assertNoLegacyRegression,
  checkNoLegacyRegression,
  exemptPositions,
} from './fixtures/redaction-catalog/legacyRegressionOracle.js';
import {
  BASELINE_REVISIONS,
  exactHidden,
  frozenRedact,
} from './fixtures/redaction-catalog/trackedReplay.js';

const SEED = 20261019;
const ADVERSARIAL_TOTAL = 40_000;
const CHUNKS = 8;

function newlineSkeleton(text: string): string {
  return text.replace(/[^\r\n]/g, '');
}

let supersetChecks = 0;

function fullOracleProblems(input: string): string[] {
  const report = checkNoLegacyRegression(input);
  supersetChecks += report.supersetChecks;
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
      // 全量精确 oracle（RED-P4a2 第 4 项）：露出、对齐器自检（证明义务 4）、运行时重放对照、结构与骨架。
      fullOracleCount++;
      problems.push(...fullOracleProblems(input));
    }
    expect(problems.slice(0, 10)).toEqual([]);
  }, 120_000);

  test('ran the full adversarial corpus through the exact oracle', () => {
    expect(adversarialCount).toBe(ADVERSARIAL_TOTAL);
    expect(fullOracleCount).toBe(ADVERSARIAL_TOTAL);
    // 证明义务 4 不空转：超集确实逐位核对过大量被早期版本遮住的位置。
    expect(supersetChecks).toBeGreaterThan(ADVERSARIAL_TOTAL * 10);
    // 语料确实包含载体、重编码与字面标记，避免生成器退化。
    expect(
      inputs.filter((input) => input.startsWith('{') || input.startsWith('[')).length
    ).toBeGreaterThan(ADVERSARIAL_TOTAL / 2);
    expect(inputs.filter((input) => /\\u00|\\\//.test(input)).length).toBeGreaterThan(1_000);
    expect(inputs.filter((input) => input.includes('[redacted')).length).toBeGreaterThan(1_000);
  });
});

describe('chained literal markers with alternating quotes (fixpoint and idempotence)', () => {
  test('every chain converges within two rounds, is idempotent and passes the attack fixture', () => {
    const problems: string[] = [];
    const inputs = chainedMarkerInputs();
    for (const input of inputs) {
      const { text, report } = redactDeveloperTextWithReport(input);
      if (!report.fixpointReached || report.kinds.includes('fixpoint-cap')) {
        problems.push(`fixpoint not reached (${report.rounds} rounds): ${JSON.stringify(input)}`);
      }
      if (report.rounds > 2) {
        problems.push(`needed ${report.rounds} rounds: ${JSON.stringify(input)}`);
      }
      if (redactDeveloperText(text) !== text) {
        problems.push(`not idempotent: ${JSON.stringify(input)}`);
      }
      problems.push(...fullOracleProblems(input));
    }
    expect(inputs.length).toBeGreaterThan(200);
    expect(problems.slice(0, 10)).toEqual([]);
  }, 120_000);

  test('the audited ten-segment chain is the fixed point after two rounds', () => {
    const input = `Token=${Array.from({ length: 10 }, (_, index) => `[redacted]SYNTHc${index}"'`).join('')}end`;
    const { text, report } = redactDeveloperTextWithReport(input);
    expect(report.fixpointReached).toBe(true);
    expect(report.rounds).toBeLessThanOrEqual(2);
    expect(redactDeveloperText(text)).toBe(text);
    expect(report.kinds).not.toContain('fixpoint-cap');
    assertNoLegacyRegression(input);
  });
});

/**
 * 整篇是 JSON 文档时，逐层解码（字符串值本身也是 JSON 文档时继续解码）后全部字符串值里的换行总数；不是 JSON
 * 文档时返回 null。
 */
function decodedNewlines(text: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err: unknown) {
    void err;
    return null;
  }
  let total = 0;
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      total += (value.match(/[\r\n]/g) ?? []).length;
      if (/^\s*[{[]/.test(value)) {
        try {
          walk(JSON.parse(value));
          // 内层文档的换行已经算在外层字符串里（它们就是外层的转义换行）；内层字符串值里的换行另计。
        } catch (err: unknown) {
          void err;
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) {
        walk(item);
      }
    }
  };
  walk(parsed);
  return total;
}

describe('mixed newline forms in one gap (RED-P4a2 item 1)', () => {
  const inputs = mixedNewlineGapInputs(3_000, SEED);

  test('never falls back to the document skeleton and passes the attack fixture', () => {
    const problems: string[] = [];
    let restored = 0;
    let carriers = 0;
    for (const input of inputs) {
      const { text, report } = redactDeveloperTextWithReport(input);
      restored += report.restoredTokens;
      if (report.renderSkeletons !== 0 || text.includes('[redacted-unaligned]')) {
        problems.push(`render skeleton: ${JSON.stringify(input)} -> ${JSON.stringify(text)}`);
      }
      if (newlineSkeleton(text) !== newlineSkeleton(input)) {
        problems.push(`newline sequence changed: ${JSON.stringify(input)}`);
      }
      if (redactDeveloperText(text) !== text) {
        problems.push(`not idempotent: ${JSON.stringify(input)}`);
      }
      const decodedBefore = decodedNewlines(input);
      if (decodedBefore !== null) {
        carriers++;
        // 整篇是 JSON 文档时：输出仍是合法 JSON，逐层解码后的换行总数守恒（放回的转义换行按层级对上）。
        if (decodedNewlines(text) !== decodedBefore) {
          problems.push(
            `decoded newlines changed: ${JSON.stringify(input)} -> ${JSON.stringify(text)}`
          );
        }
      }
      problems.push(...fullOracleProblems(input));
    }
    expect(problems.slice(0, 10)).toEqual([]);
    // 语料确实覆盖了需要放回转义换行的载体形态，不只是纯文本。
    expect(restored).toBeGreaterThan(100);
    expect(carriers).toBeGreaterThan(500);
  }, 120_000);
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

/**
 * “G 缺维度”：某个历史版本遮住的非结构字符（精确位置取自测试目录下独立的逐字符追踪重放，不是被测实现）
 * 不在 G 声明的凭据位置上。返回描述（空数组表示 G 的维度模型完整）。
 */
function missingDimensions(entry: GrammarCase): string[] {
  const problems: string[] = [];
  for (const revision of BASELINE_REVISIONS) {
    const hidden = exactHidden(revision, entry.input);
    const exempt = exemptPositions(entry.input, hidden);
    for (let index = 0; index < entry.input.length; index++) {
      if (hidden[index] !== 1 || exempt[index] === 1) {
        continue;
      }
      if (!entry.regions.some(([start, end]) => index >= start && index < end)) {
        problems.push(
          `G 缺维度: ${revision} masked ${JSON.stringify(entry.input.slice(Math.max(0, index - 6), index + 6))} outside the credential position (${JSON.stringify(entry.dims)})`
        );
        break;
      }
    }
  }
  return problems;
}

const G_TOTAL = 50_000;
const G_CHUNKS = 10;
let gCount = 0;
let gDimensionChecks = 0;
let gOracleCount = 0;

describe('credential grammar G (T1 writings, fixed seed)', () => {
  const cases = credentialGrammarCases(G_TOTAL, SEED);
  const size = G_TOTAL / G_CHUNKS;

  test.each(
    Array.from({ length: G_CHUNKS }, (_, chunk) => ({ chunk }))
  )('chunk $chunk: no fragment of a G secret survives and baselines mask only G credential positions', ({
    chunk,
  }) => {
    const problems: string[] = [];
    for (let index = chunk * size; index < (chunk + 1) * size; index++) {
      const entry = cases[index];
      if (entry === undefined) {
        continue;
      }
      gCount++;
      const output = redactDeveloperText(entry.input);
      const leaks = leakedFragments(entry, output, REDACTION_MARKERS);
      if (leaks.length > 0) {
        problems.push(
          `leak ${JSON.stringify(leaks.slice(0, 3))} ${JSON.stringify(entry.dims)}: ${JSON.stringify(entry.input)} -> ${JSON.stringify(output)}`
        );
      }
      if (newlineSkeleton(output) !== newlineSkeleton(entry.input)) {
        problems.push(`newline sequence changed: ${JSON.stringify(entry.input)}`);
      }
      gDimensionChecks++;
      problems.push(...missingDimensions(entry));
      if (index % 5 === 0 && redactDeveloperText(output) !== output) {
        problems.push(`not idempotent: ${JSON.stringify(entry.input)}`);
      }
      if (index % 50 === 0) {
        gOracleCount++;
        problems.push(...fullOracleProblems(entry.input));
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
  }, 180_000);

  test('G covers every claimed combination, carrier, line prefix and truncation marker', () => {
    expect(gCount).toBe(G_TOTAL);
    expect(gDimensionChecks).toBe(G_TOTAL);
    expect(gOracleCount).toBe(G_TOTAL / 50);
    const count = (key: keyof GrammarCase['dims'], value: string): number =>
      cases.filter((entry) => entry.dims[key] === value).length;
    for (const { kind, writing } of claimedCombos()) {
      expect(
        cases.filter((entry) => entry.dims.secret === kind.id && entry.dims.writing === writing.id)
          .length,
        `${kind.id} × ${writing.id}`
      ).toBeGreaterThan(100);
    }
    for (const carrier of CARRIERS) {
      expect(count('carrier', carrier.id), carrier.id).toBeGreaterThan(5_000);
    }
    for (const prefix of LINE_PREFIXES) {
      expect(count('prefix', prefix.id), prefix.id).toBeGreaterThan(2_000);
    }
    for (const marker of TRUNCATION_MARKERS) {
      expect(count('truncation', marker), marker).toBeGreaterThan(2_000);
    }
    expect(count('truncation', 'none')).toBeGreaterThan(G_TOTAL / 3);
    // 写法维度包含设计列出的 YAML 块标量、URL basic auth、注释与 CSV。
    const writings = new Set(cases.map((entry) => entry.dims.writing));
    for (const required of ['yaml-block-scalar', 'url-basic-auth', 'comment-hash', 'csv']) {
      expect(writings.has(required), required).toBe(true);
    }
  });

  test('the G-missing-dimension check fires when an input carries a credential G does not know about', () => {
    const [entry] = credentialGrammarCases(1, SEED);
    if (entry === undefined) {
      throw new Error('no G case');
    }
    const extra = 'password=SYNTHETICunknown ';
    const shifted: GrammarCase = {
      ...entry,
      input: `${extra}${entry.input}`,
      secretSpans: entry.secretSpans.map(([start, end]) => [
        start + extra.length,
        end + extra.length,
      ]),
      regions: entry.regions.map(([start, end]) => [start + extra.length, end + extra.length]),
    };
    expect(missingDimensions(shifted).length).toBeGreaterThan(0);
    expect(missingDimensions(entry)).toEqual([]);
  });
});
