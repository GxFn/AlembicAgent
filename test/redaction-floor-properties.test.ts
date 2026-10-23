/**
 * 脱敏阶段 1 底线的性质与精确 oracle（设计第 6 节测试要求 2、3、5）。固定种子，全部可复现。
 *
 * - 语法网格（12 键 × 10 分隔符 × 25 值形态 × 16 上下文 = 48,000 例）：哨兵 oracle 对四个历史版本零回退，
 *   并检查幂等、裸换行序列守恒、渲染不退回整篇骨架（RED-P4a2 第 1 项）、载体上下文的输出仍是合法 JSON（第 3 项：
 *   转义单元不被缺口切开）；抽样检查确定性。
 * - 唯一字符精确 oracle（10,800 例，每例 8 个互不相同的 CJK 字符 × 4 个基线 ≥ 30 万次检查）：某字符被基线
 *   遮住当且仅当它不出现在基线输出里；被遮的字符不得出现在新输出里（0 漏判）。同时逐字符核对对齐器：
 *   早期版本的超集不得漏判，现行规则的子集不得误判。
 * - 词法实现与参照正则逐 token 等价。
 * - 不变量 A（阶段 4b 起，门面层、经过不动点多轮）：T1 检测器只会多遮——任何非结构输入位置，没有检测器时
 *   被遮的，有检测器时仍被遮；检测器在原文上给出的每个区间（非结构、非级联触发前缀的位置）在最终输出里都被遮；
 *   检测器没有多遮任何位置时输出与无检测器时逐字相同。逐字符来源取自渲染器的来源表。输入除目录、规则正例、
 *   对抗模糊与 G 生成器外，另有 12,000 例随机组合（秘密紧贴关键字、头凭据紧贴头名、标记后接短值等级联写法）。
 * 样本全部是合成值。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  redactDeveloperText,
  redactDeveloperTextWithReport,
} from '../src/agent/utils/Redaction.js';
import { detectT1Spans, T1_DETECTOR_RULES } from '../src/agent/utils/redaction/detectors.js';
import {
  hiddenSubset,
  hiddenSuperset,
  lexMarkers,
  lexMarkersByRegex,
} from '../src/agent/utils/redaction/hiddenSpans.js';
import {
  applyRedactionFloorWithProvenance,
  markHiddenByTracked,
} from '../src/agent/utils/redaction/legacyFloor.js';
import { type Tracked, visibleFromTracked } from '../src/agent/utils/redaction/trackedReplay.js';
import { credentialGrammarCases } from './fixtures/redaction-catalog/credentialGrammar.js';
import {
  adversarialInputs,
  GRID_CONTEXTS,
  grammarGridFor,
  seededRandom,
  uniqueCharGrid,
} from './fixtures/redaction-catalog/fuzzCorpus.js';
import {
  checkNoLegacyRegression,
  exemptPositions,
} from './fixtures/redaction-catalog/legacyRegressionOracle.js';
import {
  BASELINE_REVISIONS,
  type BaselineRevision,
  frozenRedact,
} from './fixtures/redaction-catalog/trackedReplay.js';

const SLOW = { timeout: 120_000 };

function newlineSkeleton(text: string): string {
  return text.replace(/[^\r\n]/g, '');
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch (err: unknown) {
    void err;
    return false;
  }
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
      const carrierContext = GRID_CONTEXTS[index]?.name.endsWith('carrier') === true;
      for (const [position, { input, secret }] of grammarGridFor(index).entries()) {
        gridInputs++;
        const { text: output, report } = redactDeveloperTextWithReport(input);
        if (report.renderSkeletons !== 0) {
          violations.push(`render skeleton: ${JSON.stringify(input)}`);
        }
        if (carrierContext && !parsesAsJson(output)) {
          // RED-P4a2 第 3 项：转义单元不被缺口切开，载体输出保持合法 JSON。
          violations.push(`carrier output is not valid JSON: ${JSON.stringify(input)}`);
        }
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
        const { text: output, report } = redactDeveloperTextWithReport(input);
        if (report.renderSkeletons !== 0) {
          violations.push(`render skeleton: ${JSON.stringify(input)}`);
        }
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 输出里有字符取自的输入位置（1 = 可见）。 */
function visiblePositions(length: number, origin: Int32Array): Uint8Array {
  const visible = new Uint8Array(length);
  for (const from of origin) {
    if (from >= 0 && from < length) {
      visible[from] = 1;
    }
  }
  return visible;
}

/**
 * v0/v1 关键字级联的触发前缀（关键字 + 可选引号 + 分隔符，含两侧空白与值的开引号，可带前置引号）。检测器不吞
 * 底线没遮住的触发前缀（否则下一轮 v0 看不到关键字，级联遮蔽会丢失），所以“T1 区间都被遮”的检查豁免这些位置。
 * 测试里独立写一份，不导入被测实现。
 */
const CASCADE_TRIGGER =
  /["']?(?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?/gi;

function cascadeTriggerPositions(input: string): Uint8Array {
  const marks = new Uint8Array(input.length);
  for (const match of input.matchAll(CASCADE_TRIGGER)) {
    marks.fill(1, match.index, match.index + match[0].length);
  }
  return marks;
}

/**
 * 门面层（经过不动点多轮）的不变量 A：有检测器时输出遮住的非结构位置 ⊇ 没有检测器时遮住的；检测器在原文上
 * 给出的每个区间（非结构、非级联触发前缀的位置）在最终输出里都被遮；检测器没有多遮任何位置时输出逐字相同。
 * 返回违规描述与检查过的区间数。
 */
function invariantAViolations(input: string): { violations: string[]; spans: number } {
  const violations: string[] = [];
  const without = applyRedactionFloorWithProvenance(input, { detectors: [] });
  const withT1 = applyRedactionFloorWithProvenance(input);
  if (withT1.text !== redactDeveloperText(input)) {
    violations.push(`facade and default floor disagree: ${JSON.stringify(input)}`);
  }
  if (withT1.report.detectorChars === 0 && withT1.text !== without.text) {
    // 检测器没有多遮任何位置（区间都被底线覆盖或已是标记）时，不得改变输出：缺口集合与遮蔽位置都和无检测器时相同。
    violations.push(`T1 changed the output without adding positions: ${JSON.stringify(input)}`);
  }
  const visibleWithout = visiblePositions(input.length, without.origin);
  const visibleWith = visiblePositions(input.length, withT1.origin);
  const exempt = exemptPositions(input);
  for (let index = 0; index < input.length; index++) {
    if (exempt[index] !== 1 && visibleWith[index] === 1 && visibleWithout[index] !== 1) {
      violations.push(
        `T1 exposed position ${index} of ${JSON.stringify(input)}: ${JSON.stringify(withT1.text)} vs ${JSON.stringify(without.text)}`
      );
      break;
    }
  }
  const triggers = cascadeTriggerPositions(input);
  let spans = 0;
  for (const span of detectT1Spans(input)) {
    spans++;
    for (let index = span.start; index < span.end; index++) {
      if (exempt[index] !== 1 && triggers[index] !== 1 && visibleWith[index] === 1) {
        violations.push(`${span.ruleId} span not hidden at ${index} of ${JSON.stringify(input)}`);
        break;
      }
    }
  }
  return { violations, spans };
}

const joinParts = (...parts: string[]): string => parts.join('');

function randomRun(random: () => number, length: number, alphabet: string): string {
  let out = '';
  for (let index = 0; index < length; index++) {
    out += alphabet[Math.floor(random() * alphabet.length)];
  }
  return out;
}

const COMBO_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 随机组合里的 T1 秘密（运行时按片段拼接）。 */
const COMBO_SECRETS: ReadonlyArray<(random: () => number) => string> = [
  (random) => joinParts('gh', 'p_', randomRun(random, 36, COMBO_ALNUM)),
  (random) =>
    joinParts(
      'github',
      '_pat_',
      randomRun(random, 22, COMBO_ALNUM),
      '_',
      randomRun(random, 59, COMBO_ALNUM)
    ),
  (random) => joinParts('glpat', '-', randomRun(random, 20, COMBO_ALNUM)),
  (random) =>
    joinParts('xox', 'b-', '1234567890-1234567890123-', randomRun(random, 24, COMBO_ALNUM)),
  (random) => joinParts('sk', '_live_', randomRun(random, 24, COMBO_ALNUM)),
  (random) => joinParts('npm', '_', randomRun(random, 36, COMBO_ALNUM)),
  (random) => joinParts('sk', '-ant-', 'api03-', randomRun(random, 40, COMBO_ALNUM)),
  (random) => joinParts('AI', 'za', randomRun(random, 35, COMBO_ALNUM)),
  (random) => joinParts('AK', 'IA', randomRun(random, 16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')),
  (random) =>
    [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(
        JSON.stringify({ sub: `SYNTHETIC${randomRun(random, 4, COMBO_ALNUM)}` })
      ).toString('base64url'),
      randomRun(random, 20, `${COMBO_ALNUM}_-`),
    ].join('.'),
];
const COMBO_KEYWORDS = [
  'token',
  'password',
  'secret',
  'api_key',
  'apiKey',
  'authorization',
  'Authorization',
  'TOKEN',
  'Password',
  'x-access-token',
  'client_secret',
  'AUTH_TOKEN',
  'Bearer ',
];
const COMBO_DELIMITERS = [
  ':',
  '=',
  ': ',
  ' = ',
  '="',
  "='",
  '":"',
  '": "',
  '::',
  '=>',
  ':=',
  '\\":\\"',
];
const COMBO_VALUES = [
  'a',
  'ab',
  'abc',
  'a{SYNTH}',
  '{SYNTH}',
  'x(SYNTH)',
  'Data[1]',
  'SYNTHETICvalue',
  joinParts('$', '{X:-SYNTH}'),
  '[redacted]',
  '***',
  'SYN',
  'p@ss',
  'SYNTH;x',
];
const COMBO_HEADERS = [
  'Authorization: Bearer ',
  'Authorization: Token ',
  'Authorization: Basic ',
  'Proxy-Authorization: Basic ',
  'Cookie: sid=',
  'Set-Cookie: a=',
  'Authorization: Digest nonce="',
];
const COMBO_URLS = [
  'https://',
  'postgres://app:',
  'u:',
  '@h/x',
  '?sv=2020-01-01&sig=',
  '&sig=',
  'redis://:',
];
const COMBO_GLUE = ['', '', '', ' ', '\n', '"', ',', ';', '\\n', '\t', '}', ')', ']', ':'];

/**
 * 随机组合（固定种子）：T1 秘密、关键字、分隔符、短值、认证头、URL 片段与粘连字符随机拼接，故意制造
 * “秘密紧贴关键字”“头凭据紧贴下一个头名”“标记后接短值”这类会触发不动点级联的写法；部分样本再包一层或两层
 * JSON 载体。
 */
function invariantACombos(count: number, seed: number): string[] {
  const random = seededRandom(seed);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(random() * items.length)];
    if (item === undefined) {
      throw new Error('empty combo pool');
    }
    return item;
  };
  const inputs: string[] = [];
  for (let index = 0; index < count; index++) {
    const parts: string[] = [];
    const pieces = 2 + Math.floor(random() * 6);
    for (let piece = 0; piece < pieces; piece++) {
      const roll = random();
      if (roll < 0.25) {
        parts.push(pick(COMBO_SECRETS)(random));
      } else if (roll < 0.45) {
        parts.push(pick(COMBO_KEYWORDS), pick(COMBO_DELIMITERS));
      } else if (roll < 0.6) {
        parts.push(pick(COMBO_VALUES));
      } else if (roll < 0.72) {
        parts.push(pick(COMBO_HEADERS));
      } else if (roll < 0.82) {
        parts.push(pick(COMBO_URLS));
      } else {
        parts.push(pick(COMBO_GLUE));
      }
    }
    let input = parts.join('');
    const carrier = random();
    if (carrier < 0.2) {
      input = JSON.stringify({ stdout: input });
    } else if (carrier < 0.25) {
      input = JSON.stringify({ message: JSON.stringify({ stdout: input }) });
    }
    inputs.push(input);
  }
  return inputs;
}

describe('T1 detectors only add (invariant A)', () => {
  const catalog = JSON.parse(
    readFileSync(path.join(repoRoot, 'test/fixtures/redaction-catalog/catalog.json'), 'utf8')
  ) as { catalog: Array<{ input: string }>; newFindings: Array<{ input: string }> };
  const inputs = [
    ...[...catalog.catalog, ...catalog.newFindings].flatMap((entry) => [
      entry.input,
      JSON.stringify({ stdout: entry.input }),
    ]),
    ...T1_DETECTOR_RULES.flatMap((rule) => rule.examples.map((example) => example.text)),
    ...adversarialInputs(1_500, 11),
    ...credentialGrammarCases(1_500, 5).map((entry) => entry.input),
  ];

  test('no non-structural position hidden by the floor becomes visible, and every T1 span is hidden', () => {
    const violations: string[] = [];
    let spanChecks = 0;
    for (const input of inputs) {
      const result = invariantAViolations(input);
      violations.push(...result.violations);
      spanChecks += result.spans;
    }
    expect(violations.slice(0, 10)).toEqual([]);
    // 防止空转：样本里确实有大量 T1 区间。
    expect(spanChecks).toBeGreaterThan(1_000);
  }, 120_000);

  test('a secret glued to a keyword keeps the keyword, so the fixpoint cascade still masks what follows', () => {
    // 复查反例：前缀 token 正文贪婪吸收紧贴的 token 关键字时，第二轮 v0 级联看不到关键字，{SYNTH 露出。挂点保留
    // 底线没遮住的触发前缀（关键字 + 分隔符），第二轮 v0 照常把 [redacted]{SYNTH 凑成 ≥8 字符的值遮住。
    const token = joinParts('gh', 'p_', 'SYNTHETIC0123456789abcdefghijkmnpqrs');
    const cases: Array<[string, string]> = [
      [`${token}token:a{SYNTH}`, '[redacted-api-key]token:[redacted]}'],
      [`${token}password=a{SYNTH}`, '[redacted-api-key]password=[redacted]}'],
      [
        JSON.stringify({ stdout: `${token}secret: a{SYNTH}` }),
        '{"stdout":"[redacted-api-key]secret: [redacted]}"}',
      ],
      // Cookie 值里紧贴的 token= 同样保留，底线的级联与检测器的遮蔽取并集（cookie 列表整段一个标记，从第一个
      // cookie 名起；保留的触发前缀把它切成两段）。
      [
        joinParts('Cookie: sid=abc', 'token', '=a{SYNTH}'),
        'Cookie: [redacted-token]token=[redacted-token]',
      ],
    ];
    for (const [input, expected] of cases) {
      const { text, report } = redactDeveloperTextWithReport(input);
      expect(text, input).toBe(expected);
      expect(report.detectorEvents['trigger-kept'], input).toBeGreaterThan(0);
      expect(report.kinds).toContain('detector-trigger-kept');
      expect(invariantAViolations(input).violations).toEqual([]);
    }
    // 认证头凭据串在紧贴的下一个头名处截断：第二个头的凭据仍由它自己的候选遮住（底线在这里漏掉了它）。
    const glued = joinParts(
      'Authorization',
      ': Token abc',
      'Authorization',
      ': Token SYNTHETICsecond'
    );
    const { text, report } = redactDeveloperTextWithReport(glued);
    expect(text).toBe(
      'Authorization: [redacted] [redacted-token]Authorization: [redacted] [redacted-token]'
    );
    expect(report.detectorEvents['glued-header']).toBe(1);
    expect(report.kinds).toContain('detector-glued-header');
    expect(invariantAViolations(glued).violations).toEqual([]);
  });

  test('random combinations of secrets, keywords, delimiters and values (fixed seed)', () => {
    const violations: string[] = [];
    let spanChecks = 0;
    const combos = invariantACombos(12_000, 20261022);
    let oracleChecks = 0;
    for (const [index, input] of combos.entries()) {
      const result = invariantAViolations(input);
      violations.push(...result.violations);
      spanChecks += result.spans;
      if (index % 8 === 0) {
        // 同一批输入另交给攻击夹具按精确 oracle 判定不变量 S（保留的触发前缀只限底线没遮住的位置）。
        oracleChecks++;
        const report = checkNoLegacyRegression(input);
        if (
          report.exposures.length > 0 ||
          report.alignerViolations.length > 0 ||
          report.structuralViolations.length > 0
        ) {
          violations.push(
            `S violated for ${JSON.stringify(input)} -> ${JSON.stringify(report.output)}`
          );
        }
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
    expect(spanChecks).toBeGreaterThan(3_000);
    expect(oracleChecks).toBe(1_500);
  }, 180_000);
});

describe('hidden positions from tracked segments', () => {
  test('the interval sweep equals the complement of visibleFromTracked, sorted or not', () => {
    // 渲染底线按分段来源区间求补集，不再分配整篇的可见数组；随机分段（含无序、越界、合成分段、空区间）上必须与
    // visibleFromTracked 逐位取反完全相同。
    const random = seededRandom(20261021);
    let unsorted = 0;
    for (let trial = 0; trial < 3_000; trial++) {
      const length = 1 + Math.floor(random() * 60);
      const segments = Array.from({ length: Math.floor(random() * 12) }, () => {
        const src = Math.floor(random() * (length + 6)) - 3;
        return {
          out: 0,
          len: Math.floor(random() * 8),
          src: random() < 0.15 ? -1 : src,
          srcEnd: src + Math.floor(random() * 10),
          range: random() < 0.3,
        };
      });
      const starts = segments.filter((segment) => segment.src >= 0).map((segment) => segment.src);
      if (starts.some((start, index) => index > 0 && start < (starts[index - 1] ?? 0))) {
        unsorted++;
      }
      const tracked: Tracked = { text: '', segments };
      const visible = visibleFromTracked(tracked, length);
      const bits = new Uint8Array(length).fill(1);
      const any = markHiddenByTracked(tracked, length, bits, 4);
      for (let index = 0; index < length; index++) {
        expect((bits[index] ?? 0) & 4, `${trial}:${index}`).toBe(visible[index] === 0 ? 4 : 0);
        expect((bits[index] ?? 0) & 1).toBe(1);
      }
      expect(any).toBe(visible.some((value) => value === 0));
    }
    expect(unsorted).toBeGreaterThan(500);
  });
});
