/**
 * 脱敏阶段 4b：T1 高置信格式层检测器（设计 redaction-design-2026-10-19 第 4.4 节 T1、第 4.6 节、决定 D10）。
 *
 * - 规则表是数据：每条规则的正反例在 CI 里强制校验（validateDetectorTable）；正例经完整门面后，秘密的任何不短于
 *   4 字符的片段都不在输出里，反例逐字保留；每个正例另交给攻击夹具 assertNoLegacyRegression（不变量 S）。
 * - 标记沿用封闭词表：前缀 token 用 [redacted-api-key]，JWT、认证头、Cookie 值、SAS 签名用 [redacted-token]，
 *   URL userinfo 口令段用 [redacted]；历史版本也遮住的区间沿用历史版本的合成文本，输出与上一包逐字相同。
 * - 区间在原文上计算、与 Floor 取并集（不串接）；左右边界、载体转义、diff 前缀、截断形态、花括号配平。
 * - 阶段 1 复查列出的四版共漏 URL 写法逐条定夺：无 userinfo 的 Azure SAS sig= 尾段（纳入 T1）、
 *   mongodb+srv://u:pw@host/db（v3 底线已遮，T1 同样覆盖）、x-access-token 各形态（见对应用例）。
 * - FloorReport 记录检测器命中与否决、引用跳过、花括号失配回退、截断命中、窗口触顶、载体引号、未闭合组、紧贴
 *   头名截断、保留级联触发前缀、已遮跳过的计数，不含正文。
 * - 线性：跨候选共享的花括号配平、URL 授权段读法、截断位置、SAS 版本参数与逐候选的朴素参照实现逐位等价（随机
 *   输入、任意查询顺序），复查列出的密集候选形态（单段长 eyJ 串、base64 编码的 JSON 数组、密集未闭合 “:// {”、
 *   JSON stdout 里的未闭合 URL 花括号、密集 sig=、大量未闭合 ${ 的认证头、共享尾段的嵌套组）检测开销随输入线性。
 * - 第三轮复查：JWT 段的 JSON 对象判定改为不抛异常的字节级判定器，与“解码 + JSON.parse”在随机对象、变异、JSON
 *   风格随机字节与截断的 base64url 上逐例相同；带引号的值找闭引号改走全文索引，与逐候选有界扫描逐例相同（含换行、
 *   窗口触顶、文本末尾）；Cookie 载体引号的分隔字符判定走位置表；空白判定与 /\s/ 在全部码元上等价；auth-param 与
 *   Cookie 列表整段一个标记（密集短值不再让输出膨胀）。链式 'eyJ4eH0.'、尾逗号 JSON、开引号带不同个数反斜杠的
 *   Digest 参数与 Cookie 值、单头大量短值、40 对 Cookie 的日志行都进了线性用例。
 * - 第四轮复查：URL 授权段读法改为按接续位置下标的类型数组记忆、短组走快路径，与逐字符的朴素读法在随机输入、任意
 *   起点与任意查询顺序上逐例相同；连续的已闭合组（有无口令、口令由大量 ${A} 组成、每行一个含四个组的 URL）进了
 *   线性用例。
 * 所有秘密都是运行时按片段拼接的合成值，源码里不出现连续的 token 形态。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { findWitnessGateHit } from '../src/agent/evidence/witnessGate.js';
import {
  redactDeveloperText,
  redactDeveloperTextWithReport,
} from '../src/agent/utils/Redaction.js';
import {
  ALL_DETECTOR_SOURCES,
  type DetectorRule,
  DetectorScratch,
  decodesToJsonObject,
  detectT1Spans,
  detectWithRule,
  isJsonObjectBytes,
  isRegexSpaceCode,
  leftBoundaryAt,
  simpleGroupEnd,
  startsGluedHeaderName,
  T1_DETECTOR_RULES,
  TRUNCATED_TOKEN_MIN_BODY,
  truncationFollows,
  validateDetectorTable,
} from '../src/agent/utils/redaction/detectors.js';
import { REDACTION_MARKERS } from '../src/agent/utils/redaction/hiddenSpans.js';
import {
  applyRedactionFloor,
  DEFAULT_FLOOR_DETECTORS,
} from '../src/agent/utils/redaction/legacyFloor.js';
import { credentialGrammarCases } from './fixtures/redaction-catalog/credentialGrammar.js';
import { adversarialInputs, seededRandom } from './fixtures/redaction-catalog/fuzzCorpus.js';
import { assertNoLegacyRegression } from './fixtures/redaction-catalog/legacyRegressionOracle.js';
import { BASELINE_REVISIONS, frozenRedact } from './fixtures/redaction-catalog/trackedReplay.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const join = (...parts: string[]): string => parts.join('');

function body(length: number, alphabet = 'SYNTHETICabcdefghjkmnpqrstuvwxyz0123456789'): string {
  let out = '';
  for (let index = 0; out.length < length; index++) {
    out += alphabet[index % alphabet.length];
  }
  return out;
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** 任意文本（不必是合法 JSON）的 base64url。 */
function b64Text(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

const GH = join('gh', 'p_', body(36));
const SLACK = join('xox', 'b-', '1234567890-1234567890123-', body(24));
const AWS = join('AK', 'IA', 'IOSFODNN7EXAMPL2');
const JWT = [b64({ alg: 'HS256', typ: 'JWT' }), b64({ sub: 'SYNTHETIC' }), body(43)].join('.');
const SECRET = body(28, 'SYNTHETICsecret0123456789');

function newlineSkeleton(text: string): string {
  return text.replace(/[^\r\n]/g, '');
}

/** 秘密的 4 字符片段出现在输出里（排除输入里秘密之外也有的片段与标记词表自身的片段）。 */
function leakedGrams(input: string, secret: string, output: string): string[] {
  const elsewhere = input.split(secret).join('\u0000');
  const leaks: string[] = [];
  for (let index = 0; index + 4 <= secret.length; index++) {
    const gram = secret.slice(index, index + 4);
    if (elsewhere.includes(gram) || REDACTION_MARKERS.some((marker) => marker.includes(gram))) {
      continue;
    }
    if (output.includes(gram)) {
      leaks.push(gram);
    }
  }
  return leaks;
}

const ruleById = (id: string): DetectorRule => {
  const rule = T1_DETECTOR_RULES.find((entry) => entry.id === id);
  if (rule === undefined) {
    throw new Error(`no rule ${id}`);
  }
  return rule;
};

describe('T1 rule table is data, validated at build time (CI)', () => {
  test('every rule passes its own positive and negative examples', () => {
    expect(validateDetectorTable()).toEqual([]);
  });

  test('rules are T1, apply to every source, use only closed-vocabulary markers', () => {
    const ids = new Set<string>();
    for (const rule of T1_DETECTOR_RULES) {
      expect(ids.has(rule.id), rule.id).toBe(false);
      ids.add(rule.id);
      expect(rule.tier).toBe('T1');
      expect([...rule.sources].sort()).toEqual([...ALL_DETECTOR_SOURCES].sort());
      expect(REDACTION_MARKERS).toContain(rule.marker);
      expect(rule.examples.length).toBeGreaterThan(0);
      expect(rule.negativeExamples.length).toBeGreaterThan(0);
      expect(rule.pattern.flags).toContain('g');
      expect(rule.prefilter.flags).toBe('');
    }
    // 设计 4.4 T1 + D10 列出的形态都在表里。
    expect([...ids].sort()).toEqual(
      [
        'anthropic-api-key',
        'authorization-header',
        'aws-access-key-id',
        'azure-sas-signature',
        'cookie-header',
        'github-fine-grained-pat',
        'github-token',
        'gitlab-pat',
        'google-api-key',
        'jwt',
        'npm-token',
        'slack-token',
        'stripe-secret-key',
        'url-userinfo',
      ].sort()
    );
    // 标记按设计 4.6 分配。
    for (const rule of T1_DETECTOR_RULES) {
      const expected =
        rule.kind === 'prefixed-token'
          ? '[redacted-api-key]'
          : rule.kind === 'url-userinfo'
            ? '[redacted]'
            : '[redacted-token]';
      expect(rule.marker, rule.id).toBe(expected);
    }
  });

  test('prefilter short-circuits are exact: detection without any prefilter yields the same spans', () => {
    // 参照实现：不跑合并预过滤与逐条预过滤，每条规则直接扫候选；与 detectT1Spans 一样跳过恰好是一个已有标记
    // 的区间。两者在规则正反例、G 生成器用例、对抗模糊输入与本仓库源码上必须给出完全相同的区间。
    const unfiltered = (text: string): string[] =>
      T1_DETECTOR_RULES.flatMap((rule) =>
        detectWithRule({ ...rule, prefilter: /(?:)/ }, text)
          .filter(([start, end]) => !REDACTION_MARKERS.includes(text.slice(start, end)))
          .map(([start, end]) => `${rule.id}:${start}:${end}`)
      ).sort();
    const filtered = (text: string): string[] =>
      detectT1Spans(text)
        .map((span) => `${span.ruleId}:${span.start}:${span.end}`)
        .sort();
    const inputs = [
      ...T1_DETECTOR_RULES.flatMap((rule) => [
        ...rule.examples.map((example) => example.text),
        ...rule.negativeExamples,
      ]),
      ...credentialGrammarCases(3_000, 4_242).map((entry) => entry.input),
      ...adversarialInputs(500, 4_243),
      readFileSync(path.join(repoRoot, 'src/agent/utils/redaction/detectors.ts'), 'utf8'),
      readFileSync(path.join(repoRoot, 'src/agent/utils/redaction/legacyFloor.ts'), 'utf8'),
    ];
    let withSpans = 0;
    for (const text of inputs) {
      const expected = unfiltered(text);
      expect(filtered(text)).toEqual(expected);
      if (expected.length > 0) {
        withSpans++;
      }
    }
    expect(withSpans).toBeGreaterThan(1_000);
  });

  test('a broken example is reported by the validator (the gate can fail)', () => {
    const rule = ruleById('github-token');
    const broken: DetectorRule = {
      ...rule,
      examples: [{ text: 'no token in here', secrets: ['no token'] }],
      negativeExamples: [`see ${GH}`],
    };
    const problems = validateDetectorTable([broken]);
    expect(problems.some((problem) => problem.includes('not fully covered'))).toBe(true);
    expect(problems.some((problem) => problem.includes('negative 0'))).toBe(true);
  });

  test('the detector table and the witness gate stay independent (no cross imports)', () => {
    const detectorSource = readFileSync(
      path.join(repoRoot, 'src/agent/utils/redaction/detectors.ts'),
      'utf8'
    );
    const gateSource = readFileSync(
      path.join(repoRoot, 'src/agent/evidence/witnessGate.ts'),
      'utf8'
    );
    expect(detectorSource).not.toMatch(/from\s+['"][^'"]*witnessGate/);
    expect(gateSource).not.toMatch(/from\s+['"][^'"]*detectors/);
    // 本文件与 G 生成器被宿主投影捕获时不能命中见证闸门：源码里没有连续的前缀 token、JWT 或私钥块形态。
    expect(findWitnessGateHit(detectorSource)).toBeNull();
    const grammarSource = readFileSync(
      path.join(repoRoot, 'test/fixtures/redaction-catalog/credentialGrammar.ts'),
      'utf8'
    );
    expect(findWitnessGateHit(grammarSource)).toBeNull();
  });
});

describe('positive examples through the full facade', () => {
  const rows = T1_DETECTOR_RULES.flatMap((rule) =>
    rule.examples.map((example, index) => ({ id: `${rule.id}#${index}`, ...example }))
  );

  test.each(rows)('$id: no fragment of the secret survives, S holds, idempotent', ({
    text,
    secrets,
  }) => {
    const output = redactDeveloperText(text);
    for (const secret of secrets) {
      expect(leakedGrams(text, secret, output), output).toEqual([]);
    }
    expect(redactDeveloperText(output)).toBe(output);
    expect(newlineSkeleton(output)).toBe(newlineSkeleton(text));
    assertNoLegacyRegression(text);
  });
});

describe('negative examples are kept verbatim', () => {
  const rows = T1_DETECTOR_RULES.flatMap((rule) =>
    rule.negativeExamples.map((text, index) => ({ id: `${rule.id}!${index}`, text }))
  );

  test.each(rows)('$id', ({ text }) => {
    expect(detectT1Spans(text)).toEqual([]);
    expect(redactDeveloperText(text)).toBe(text);
  });
});

describe('markers come from the closed vocabulary; baseline gaps win where they exist', () => {
  test.each([
    ['bare GitHub token', `see ${GH} here`, 'see [redacted-api-key] here'],
    ['bare Slack token', `notify ${SLACK} now`, 'notify [redacted-api-key] now'],
    ['bare AWS access key id', `id ${AWS} ok`, 'id [redacted-api-key] ok'],
    ['bare JWT', `jwt ${JWT}`, 'jwt [redacted-token]'],
    [
      'a Cookie list is one marker',
      join('Cookie', `: theme=dark; session=${SECRET}`),
      'Cookie: [redacted-token]',
    ],
    [
      // v2/v3 的键值规则已把方案名当作 Proxy-Authorization 的值遮住（底线），参数列表整段由 T1 遮住。
      'an auth-param list is one marker after the scheme',
      join('Proxy-Authorization', `: Digest username="svc", response="${SECRET}"`),
      'Proxy-Authorization: [redacted] [redacted-token]',
    ],
    [
      'Set-Cookie keeps attributes',
      join('Set-Cookie', `: sid=${SECRET}; Path=/; HttpOnly`),
      'Set-Cookie: sid=[redacted-token]; Path=/; HttpOnly',
    ],
    [
      'Token scheme: v2/v3 already mask the scheme word, T1 masks the credential',
      join('Authorization', `: Token ${SECRET}`),
      'Authorization: [redacted] [redacted-token]',
    ],
    [
      'URL default value with path characters',
      join('postgres://app:$', `{DB_PASS:-${SECRET}/x?y}@db/app`),
      'postgres://app:[redacted]@db/app',
    ],
    [
      'Azure SAS signature without userinfo',
      `https://acct.blob.core.windows.net/c/f?sv=2022-11-02&sp=r&sig=${SECRET}%2B`,
      'https://acct.blob.core.windows.net/c/f?sv=2022-11-02&sp=r&sig=[redacted-token]',
    ],
    // 历史版本也遮住的区间沿用历史版本的合成文本（与上一包逐字相同）。
    ['keyword value keeps the v3 marker', `token=${GH}`, 'token=[redacted]'],
    [
      'Bearer keeps the historical marker',
      join('Authorization', `: Bearer ${SECRET}`),
      'Authorization: Bearer [redacted-token]',
    ],
    [
      'URL password keeps the v3 marker',
      `https://bot:${GH}@github.com/o/r.git`,
      'https://bot:[redacted]@github.com/o/r.git',
    ],
  ])('%s', (_name, input, expected) => {
    const output = redactDeveloperText(input);
    expect(output).toBe(expected);
    expect(redactDeveloperText(output)).toBe(output);
    assertNoLegacyRegression(input);
  });

  test('where a baseline already masks the span, the output equals the floor without detectors', () => {
    for (const input of [
      `token=${GH}`,
      `https://bot:${GH}@github.com/o/r.git`,
      join('Authorization', `: Bearer ${SECRET}`),
      `password: ${JWT}`,
      join('Authorization', ': Basic ', Buffer.from('svc:x').toString('base64')),
    ]) {
      expect(redactDeveloperText(input)).toBe(applyRedactionFloor(input, { detectors: [] }).text);
    }
  });

  test('the default detector table is the T1 table', () => {
    expect(DEFAULT_FLOOR_DETECTORS).toHaveLength(1);
    const input = `see ${GH}`;
    expect(applyRedactionFloor(input).text).toBe(redactDeveloperText(input));
    expect(applyRedactionFloor(input, { detectors: [] }).text).toBe(input);
  });
});

describe('spans are computed on the original text and unioned with the floor (never chained)', () => {
  test('a T1 span inside a floor-masked value still lands on original positions', () => {
    const input = `password=Pa(ss)${GH}`;
    const floorOnly = applyRedactionFloor(input, { detectors: [] }).text;
    const output = redactDeveloperText(input);
    // 底线（v0/v1 的宽字符类）遮住整个值；T1 区间在原文上，与之并集，不在底线输出上重新匹配。
    expect(floorOnly).not.toContain(GH.slice(4, 12));
    expect(output).not.toContain(GH.slice(4, 12));
    for (const revision of BASELINE_REVISIONS) {
      const baseline = frozenRedact(revision, input);
      if (!baseline.includes('Pa(ss)')) {
        expect(output).not.toContain('Pa(ss)');
      }
    }
    assertNoLegacyRegression(input);
  });

  test('two detectors that cover the same span render one marker', () => {
    const input = `https://deploy:${GH}@git.example.com/o/r.git`;
    const spans = detectT1Spans(input);
    expect(new Set(spans.map((span) => span.ruleId))).toEqual(
      new Set(['github-token', 'url-userinfo'])
    );
    expect(redactDeveloperText(input)).toBe('https://deploy:[redacted]@git.example.com/o/r.git');
  });
});

describe('gitleaks-style boundaries, carriers and prefixes', () => {
  test.each([
    ['inside a longer identifier', `x${GH}`, false],
    ['followed by an identifier character', `${GH}_suffix`, false],
    ['after a dash inside an identifier', `x-${GH}`, false],
    ['after an escaped newline in a carrier', `"line\\n${GH}"`, true],
    ['after an escaped tab', `"a\\t${GH}"`, true],
    ['after a unicode escape', `"\\u0020${GH}"`, true],
    ['diff removal at line start', `-${GH}`, true],
    ['diff removal after an escaped newline', `"x\\n-${GH}"`, true],
    ['lone dash after a quote', `"-${GH}"`, true],
    ['CSV cell', `svc,${GH},2026`, true],
  ])('%s', (_name, input, masked) => {
    const output = redactDeveloperText(input);
    if (masked) {
      expect(output).not.toContain(GH.slice(4, 16));
    } else {
      expect(detectWithRule(ruleById('github-token'), input)).toEqual([]);
    }
  });

  test('left boundary helper', () => {
    expect(leftBoundaryAt('ghp', 0)).toBe(true);
    expect(leftBoundaryAt(' ghp', 1)).toBe(true);
    expect(leftBoundaryAt('aghp', 1)).toBe(false);
    expect(leftBoundaryAt('\\nghp', 2)).toBe(true);
    expect(leftBoundaryAt('a-ghp', 2)).toBe(false);
    expect(leftBoundaryAt('\n-ghp', 2)).toBe(true);
  });

  test('tokens keep working in every G carrier', () => {
    for (const wrap of [
      (line: string) => line,
      (line: string) => JSON.stringify({ stdout: line }),
      (line: string) => JSON.stringify({ message: JSON.stringify({ stdout: line }) }),
      (line: string) => `${line}\r\n`,
    ]) {
      for (const secret of [GH, SLACK, AWS, JWT]) {
        const input = wrap(`12| deploy ${secret} rotated`);
        const output = redactDeveloperText(input);
        expect(leakedGrams(input, secret, output), `${input} -> ${output}`).toEqual([]);
      }
    }
  });
});

describe('truncated tokens (line cut in the middle, followed by a truncation marker)', () => {
  test.each([
    ['dots', `${GH.slice(0, 4 + TRUNCATED_TOKEN_MIN_BODY + 6)}...`],
    ['ellipsis', `${GH.slice(0, 20)}…`],
    ['[truncated]', `${GH.slice(0, 12)} [truncated]`],
    ['omitted lines', `${GH.slice(0, 12)}... [42 lines omitted] ...`],
    ['Slack cut inside its structure', `${SLACK.slice(0, 18)}...`],
    ['AWS key id', `${AWS.slice(0, 10)}…`],
    ['JWT cut inside the signature', `${JWT.slice(0, JWT.length - 20)}...`],
  ])('%s', (_name, input) => {
    const { text, report } = redactDeveloperTextWithReport(input);
    const visible = input.replace(
      /(?:\.{3}|…| \[truncated\]| ?\.\.\. \[42 lines omitted\] \.\.\.)+$/,
      ''
    );
    expect(leakedGrams(input, visible, text), text).toEqual([]);
    if (!input.startsWith('eyJ')) {
      expect(report.detectorEvents.truncated).toBeGreaterThan(0);
      expect(report.kinds).toContain('detector-truncated');
    }
  });

  test('too short, or not followed by a truncation marker, is not a token', () => {
    const rule = ruleById('github-token');
    expect(detectWithRule(rule, `${GH.slice(0, 4 + TRUNCATED_TOKEN_MIN_BODY - 1)}...`)).toEqual([]);
    expect(detectWithRule(rule, `${GH.slice(0, 20)} more words`)).toEqual([]);
    expect(truncationFollows('abc [truncated]', 3)).toBe(true);
    expect(truncationFollows('abc [12 lines omitted]', 3)).toBe(true);
    expect(truncationFollows('abc next', 3)).toBe(false);
  });
});

describe('URL userinfo password segment', () => {
  test('balanced braces absorb shell defaults, Actions expressions and user defaults', () => {
    const cases: Array<[string, string]> = [
      [join('postgres://app:$', `{DB_PASS:-${SECRET}/a?b#c@d}@db/app`), SECRET],
      [join('postgres://$', '{DB_USER:-admin}:$', `{DB_PASS:-${SECRET}}@db/app`), SECRET],
      [
        join('git clone https://x-access-token:$', '{{ secrets.GITHUB_TOKEN }}@github.com/o/r.git'),
        'secrets.GITHUB_TOKEN',
      ],
      [join('const url = `postgres://app:$', `{pw ?? '${SECRET}'}@db/app\`;`), SECRET],
    ];
    for (const [input, secret] of cases) {
      const output = redactDeveloperText(input);
      expect(leakedGrams(input, secret, output), output).toEqual([]);
      assertNoLegacyRegression(input);
    }
  });

  test('an unclosed brace group falls back to the unbalanced reading and is reported', () => {
    const input = join('postgres://app:$', `{DB_PASS:-${SECRET}@db/app`);
    const { text, report } = redactDeveloperTextWithReport(input);
    expect(leakedGrams(input, SECRET, text)).toEqual([]);
    expect(report.detectorEvents['unbalanced-fallback']).toBeGreaterThan(0);
    expect(report.kinds).toContain('detector-unbalanced-fallback');
    // 截断在行尾、没有截断标记的未闭合组：冒号之后整段遮住。
    const cut = join('postgres://app:$', `{DB_PASS:-${SECRET}/rest`);
    expect(leakedGrams(cut, SECRET, redactDeveloperText(cut))).toEqual([]);
  });

  test('truncated passwords, escaped slashes and mongodb+srv', () => {
    for (const [input, secret] of [
      [`redis://:${SECRET.slice(0, 12)}... [truncated]`, SECRET.slice(0, 12)],
      [`https://deploy:${SECRET.slice(0, 12)}…`, SECRET.slice(0, 12)],
      [join('postgres://app:$', `{DB_PASS:-${SECRET.slice(0, 12)}...`), SECRET.slice(0, 12)],
      [`{"stdout":"clone https:\\/\\/deploy:${SECRET}@git.example.com\\/x`, SECRET],
      [`mongodb+srv://svc:${SECRET}@cluster0.example.net/db`, SECRET],
    ] as const) {
      const output = redactDeveloperText(input);
      expect(leakedGrams(input, secret, output), output).toEqual([]);
      assertNoLegacyRegression(input);
    }
  });

  test('ports, plain hosts and URLs without a password are untouched', () => {
    for (const input of [
      'https://example.com:8080/path',
      'http://localhost:3000...',
      'see https://user@example.com/x',
      'jdbc:postgresql://db.internal:5432/app',
    ]) {
      expect(detectWithRule(ruleById('url-userinfo'), input)).toEqual([]);
    }
  });
});

describe('stage-1 reviewer URL items (all four baselines miss them, or were believed to)', () => {
  test('Azure SAS sig= without userinfo: adopted into T1', () => {
    const input = `copy https://acct.blob.core.windows.net/c/f.txt?sv=2022-11-02&sp=r&sig=${SECRET}%3D`;
    for (const revision of BASELINE_REVISIONS) {
      expect(frozenRedact(revision, input)).toBe(input);
    }
    const output = redactDeveloperText(input);
    expect(output).toContain('&sig=[redacted-token]');
    expect(leakedGrams(input, SECRET, output)).toEqual([]);
    // 反例：没有 sv= 的普通 sig 参数不是 SAS。
    const plain = `https://example.com/api?sig=${SECRET}`;
    expect(redactDeveloperText(plain)).toBe(plain);
    expect(redactDeveloperTextWithReport(plain).report.detectorEvents.rejected).toBeGreaterThan(0);
  });

  test('mongodb+srv://u:pw@host/db: already masked by the v3 floor, T1 covers it as well', () => {
    const input = 'mongodb+srv://u:pw@host/db';
    expect(frozenRedact('b60a61e', input)).toBe('mongodb+srv://u:[redacted]@host/db');
    expect(detectWithRule(ruleById('url-userinfo'), input)).toEqual([[16, 18]]);
    expect(redactDeveloperText(input)).toBe('mongodb+srv://u:[redacted]@host/db');
  });

  test('x-access-token forms', () => {
    // URL 形态的字面 token：v3 与 T1（URL 口令段 + 前缀 token）都遮。
    const literal = `git clone https://x-access-token:${join('gh', 's_', body(36))}@github.com/o/r.git`;
    expect(redactDeveloperText(literal)).toBe('git clone https://x-access-token:[redacted]');
    // 带空格的 Actions 表达式：四个版本最多只遮住 $，T1 花括号配平后整段吸收。
    const actions = join(
      'git clone https://x-access-token:$',
      '{{ secrets.GITHUB_TOKEN }}@github.com/o/r.git'
    );
    expect(frozenRedact('b60a61e', actions)).toContain('{{ secrets.GITHUB_TOKEN }}');
    // 第一轮 T1 把整个表达式遮成 [redacted]；不动点轮里 v0 的关键字规则（token: 后 ≥8 个非空白字符）再把
    // [redacted]@github.com/… 整段遮住，与字面 token 的输出相同。
    expect(redactDeveloperText(actions)).toBe('git clone https://x-access-token:[redacted]');
    // 无 scheme 的 x-access-token:<opaque> 与同名 HTTP 头：键名以 token 结尾，v0–v2 的关键字规则已遮（底线）。
    for (const input of [`x-access-token:${SECRET}`, `x-access-token: ${SECRET}`]) {
      expect(redactDeveloperText(input)).not.toContain(SECRET.slice(0, 8));
    }
  });
});

describe('Authorization and Cookie headers', () => {
  test('auth-param schemes mask the whole parameter list as one marker', () => {
    const input = join(
      'Authorization',
      `: Digest username="svc", realm="api", nonce="${SECRET}", response="${body(32)}"`
    );
    const output = redactDeveloperText(input);
    expect(leakedGrams(input, SECRET, output)).toEqual([]);
    // 底线（v2/v3）已遮住方案名；参数列表从第一个参数名到最后一个凭据值（含闭引号）整段一个标记。
    expect(output).toBe('Authorization: [redacted] [redacted-token]');
    expect(redactDeveloperText(output)).toBe(output);
    assertNoLegacyRegression(input);
  });

  test('the list cover starts at the first credential pair and ends at the last credential value', () => {
    // 纯引用与只有符号的值不是凭据：列表前后的它们保留，夹在凭据之间的一并遮住。
    const params = join('Authorization: Digest a=$', '{X}, b="v1", c=***, d=v2, e=$', '{Y}');
    const paramStart = params.indexOf('b="v1"');
    expect(detectWithRule(ruleById('authorization-header'), params)).toEqual([
      [paramStart, params.indexOf(', e=')],
    ]);
    const cookies = join('Cookie: a=$', 'X; b=v1; c=***; d="v2"; e=$', '{Y}');
    expect(detectWithRule(ruleById('cookie-header'), cookies)).toEqual([
      [cookies.indexOf('b=v1'), cookies.indexOf('; e=')],
    ]);
    // Set-Cookie 只遮第一对的值，属性保留。
    const setCookie = join('Set-Cookie: sid=', SECRET, '; Path=/; HttpOnly');
    expect(detectWithRule(ruleById('cookie-header'), setCookie)).toEqual([
      [setCookie.indexOf(SECRET), setCookie.indexOf(SECRET) + SECRET.length],
    ]);
  });

  test('dense short values render one marker per header: the output does not grow', () => {
    for (const input of [
      join('Cookie', ': ', 'a=b; '.repeat(2_000)),
      join('Authorization', ': Digest ', 'a=b,'.repeat(2_000)),
      Array.from({ length: 50 }, (_, line) =>
        join(
          'Cookie',
          ': ',
          Array.from({ length: 40 }, (_, pair) => `c${pair}=v${line}`).join('; ')
        )
      ).join('\n'),
    ]) {
      const { text, report } = redactDeveloperTextWithReport(input);
      expect(text.length).toBeLessThan(input.length);
      expect(report.rounds).toBeLessThanOrEqual(2);
      expect(newlineSkeleton(text)).toBe(newlineSkeleton(input));
      expect(redactDeveloperText(text)).toBe(text);
    }
  });

  test('the JSON-escaped form inside a carrier is masked too', () => {
    const input = JSON.stringify({
      stdout: join('> Authorization', `: Digest username="svc", response="${SECRET}"\r\n`),
    });
    expect(leakedGrams(input, SECRET, redactDeveloperText(input))).toEqual([]);
    const cookie = JSON.stringify({ stdout: join('> Cookie', `: sid="${SECRET}"; x=1`) });
    expect(leakedGrams(cookie, SECRET, redactDeveloperText(cookie))).toEqual([]);
  });

  test('pure references are skipped and reported; defaults inside them are masked', () => {
    const skipped = join('curl -H "Authorization: Bearer $', '{API_TOKEN}" https://api.example');
    const { text, report } = redactDeveloperTextWithReport(skipped);
    expect(text).toBe(skipped);
    expect(report.detectorEvents['reference-skip']).toBe(1);
    expect(report.kinds).toContain('detector-reference-skip');
    const withDefault = join('Authorization', ': Bearer $', `{API_TOKEN:-${SECRET}}`);
    expect(leakedGrams(withDefault, SECRET, redactDeveloperText(withDefault))).toEqual([]);
  });

  test('a glued header name ends the credential only in header syntax (colon followed by a blank)', () => {
    const rule = ruleById('authorization-header');
    // HTTP 头写法（冒号后有空白）：截断，第二个头的凭据由它自己的候选遮住。
    const glued = join('Authorization', ': Token abc', 'Cookie', ': sid=', SECRET);
    expect(redactDeveloperText(glued)).not.toContain(SECRET.slice(0, 8));
    // user:pass 形态里的冒号属于凭据：不截断，整段仍在本区间里。
    const userPass = join('Authorization', ': Basic svc', 'cookie', `:${SECRET}`);
    expect(detectWithRule(rule, userPass)).toEqual([[21, userPass.length]]);
    // 更长头名的后半段（Set-Cookie 里的 Cookie）不单独截断；值缺失、紧跟下一个头时凭据串为空，下一个头照常处理。
    const missing = join('Authorization', ': ', 'Authorization', `: Token ${SECRET}`);
    expect(redactDeveloperText(missing)).not.toContain(SECRET.slice(0, 8));
    const setCookie = join('Authorization', ': Token abc', 'Set-Cookie', `: sid=${SECRET}`);
    expect(redactDeveloperText(setCookie)).not.toContain(SECRET.slice(0, 8));
  });

  test('a scheme word alone, or a value with no letters or digits, is not a credential', () => {
    expect(
      detectWithRule(ruleById('authorization-header'), "'Authorization': 'Bearer ' + token")
    ).toEqual([]);
    expect(detectWithRule(ruleById('authorization-header'), 'Authorization: Bearer ***')).toEqual(
      []
    );
    expect(detectWithRule(ruleById('cookie-header'), 'Cookie: session=$')).toEqual([]);
    // 不跟在 $ 后面的 { 是对象字面量，不是凭据。
    expect(
      detectWithRule(ruleById('authorization-header'), "{ Authorization: { scheme: 'bearer' } }")
    ).toEqual([]);
  });
});

describe('FloorReport carries detector counts and kinds, never text', () => {
  test('hits by rule id, rejections and the already-masked skip of the fixpoint round', () => {
    const input = [
      `see ${GH}`,
      `jwt ${JWT}`,
      join('Cookie', `: sid=${SECRET}`),
      `https://deploy:${SECRET}@git.example.com/x`,
      join('gh', 'p_', 'short'),
      [b64({ alg: 'HS256' }), Buffer.from('not json').toString('base64url'), body(20)].join('.'),
    ].join('\n');
    const { text, report } = redactDeveloperTextWithReport(input);
    expect(report.detectorHits['github-token']).toBe(1);
    expect(report.detectorHits.jwt).toBe(1);
    expect(report.detectorHits['cookie-header']).toBe(1);
    expect(report.detectorHits['url-userinfo']).toBe(1);
    expect(report.detectorSpans).toBe(4);
    expect(report.detectorEvents.rejected).toBeGreaterThanOrEqual(2);
    // 第二轮（不动点确认）里 URL 口令段已是 [redacted]：精确跳过并计数，不再触发渲染。
    expect(report.detectorEvents['already-masked']).toBeGreaterThan(0);
    // URL 口令段 v3 底线已遮住：检测区间不增加遮蔽位置，跳过（不并入缺口）并计数。
    expect(report.detectorEvents['floor-covered']).toBeGreaterThan(0);
    expect(report.kinds).toEqual(
      expect.arrayContaining([
        'detector-span',
        'detector-rejected',
        'detector-already-masked',
        'detector-floor-covered',
      ])
    );
    // 本输入不含 SAS、npm 等触发字面量：这些规则被预过滤短路，计数可见。
    expect(report.detectorEvents['prefilter-skip']).toBeGreaterThan(0);
    const clean = redactDeveloperTextWithReport('const total = items.length;').report;
    expect(clean.detectorEvents['prefilter-skip']).toBe(T1_DETECTOR_RULES.length);
    expect(clean.detectorSpans).toBe(0);
    // 预过滤短路是常规快路径，只计数，不进 kinds：干净文本的 kinds 仍为空。
    expect(clean.kinds).toEqual([]);
    expect(report.fixpointReached).toBe(true);
    const serialized = JSON.stringify(report);
    for (const secret of [GH, JWT, SECRET]) {
      expect(serialized).not.toContain(secret.slice(4, 12));
    }
    expect(leakedGrams(input, SECRET, text)).toEqual([]);
  });

  test('characters only a detector hides count as detector chars, not as floor or residual chars', () => {
    const { text, report } = redactDeveloperTextWithReport(`see ${GH} here`);
    expect(text).toBe('see [redacted-api-key] here');
    expect(report.detectorChars).toBe(GH.length);
    expect(report.floorChars).toBe(0);
    expect(report.residualChars).toBe(0);
    expect(report.kinds).not.toContain('residual-patched');
    // 底线已遮住的区间：检测器字符为 0，输出与无检测器时逐字相同。
    const covered = redactDeveloperTextWithReport(`https://bot:${SECRET}@git.example.com/x`);
    expect(covered.report.detectorChars).toBe(0);
    expect(covered.report.detectorEvents['floor-covered']).toBe(1);
    expect(covered.text).toBe(
      applyRedactionFloor(`https://bot:${SECRET}@git.example.com/x`, { detectors: [] }).text
    );
  });

  test('deterministic and free of module state: interleaved calls give identical spans and reports', () => {
    const first = `see ${GH} and ${join('Cookie', `: a=${SECRET}`)}`;
    const second = `jwt ${JWT}`;
    const a1 = detectT1Spans(first);
    const b1 = detectT1Spans(second);
    const a2 = detectT1Spans(first);
    expect(a2).toEqual(a1);
    expect(detectT1Spans(second)).toEqual(b1);
    expect(redactDeveloperTextWithReport(first)).toEqual(redactDeveloperTextWithReport(first));
  });
});

/** 本包新增代码路径的攻击输入（紧贴关键字、保留触发前缀、花括号配平与记忆化、JWT 手工扫描、SAS 片段缓存、紧贴头名）。 */
const ATTACK_INPUTS: readonly string[] = [
  `${GH}token:a{SYNTH}`,
  `${GH}token=a{SYNTH}`,
  `${GH}Password: a{SYNTH}rest`,
  `${GH}api_key='a(SYNTH)'`,
  `${JWT}secret:x{SYNTH}`,
  `${JWT}.${GH}`,
  `x${JWT}token:a{SYNTH}`,
  join('eyJ', 'abcd.', JWT),
  join('Cookie', ': sid=abc', 'token', '=a{SYNTH}'),
  join('Cookie', ': sid="abc', 'password', '=SYNTH"; x=1'),
  join('Set-Cookie', ': a=xsecret:a{SYNTH}; Path=/'),
  join('Authorization', ': Bearer abc', 'Authorization', ':a{SYNTH}'),
  join('Authorization', ': Token abc', 'Authorization', ': Token SYNTHETICsecond'),
  join('Authorization', ': Token abc', 'Cookie', ': sid=SYNTHETICcookie'),
  join('Authorization', ': Basic abc', 'Proxy-Authorization', ': Basic SYNTHETICproxy'),
  join('Authorization', ': Bearer x$', '{TOKEN:-SYNTHETICdefault}tail'),
  join('Authorization', ': Bearer x$', '{TOKEN:-SYNTHETICopen'),
  join('Authorization', ': Token ', 'token', '=SYNTH{x}'),
  join('postgres://app:$', '{DB_PASS:-SYNTH', 'token', '=a{b}}@db/app'),
  join('postgres://app:$', '{A:-$', '{B:-SYNTHETICnested}}@db/app'),
  join('x://{a://{b://{', '}}}', ':SYNTHETICtail@h'),
  join('x://a:{y://b:{z://c:{', '}}}', 'SYNTHETICpw@h'),
  join('redis://:SYNTH', 'password', '=a{SYNTH}...'),
  join('https://u:SYNTHETICpw', '\\n', 'token:a{SYNTH}'),
  JSON.stringify({
    stdout: join('clone https://deploy:', SECRET, '@git.example.com/x\ntoken: a{SYNTH}'),
  }),
  JSON.stringify({ message: JSON.stringify({ stdout: `${GH}secret: a{SYNTH}` }) }),
  `https://acct.blob.core.windows.net/c/f?sv=2022-11-02&sig=${SECRET}&token=a{SYNTH}`,
  `?sig=${SECRET} https://h/x?sv=2022-11-02&sig=${SECRET}`,
  `&sv=2020&sig=${SECRET}password=a{SYNTH}`,
  `${'a://{'.repeat(30)}password=a{SYNTH}`,
  `${join('ey', 'J').repeat(40)}.${join('ey', 'J').repeat(5)}.x token=a{SYNTH}`,
  `${SLACK}token:a{SYNTH}`,
  `${AWS}secret=a{SYNTH}`,
  `-${GH}\n+${GH}token: a{SYNTH}`,
  `12| ${GH}token:a{SYNTH}\r\n13| password: a{SYNTH}`,
  `"${GH}":"token":"a{SYNTH}"`,
  `{"token":"${GH}","password":"a{SYNTH}"}`,
  join('Authorization', ': Digest nonce="', SECRET, '", token=a{SYNTH}'),
  `${GH}token:[redacted]{SYNTH}`,
  `token:${GH}{SYNTH}`,
  // 第三轮：cookie / auth-param 列表整段遮住、JWT 字节级判定、闭引号索引上的攻击输入。
  join('Cookie', ': a=b; token=a{SYNTH}; c=d; password: a{SYNTH}'),
  join('Cookie', ': a=$', '{X}; token=SYNTH; b=***; secret=a{SYNTH}'),
  join('Authorization', ': Digest a=b, token="a{SYNTH}", c=\\"d\\", password=a{SYNTH}'),
  join(
    'Authorization',
    ': AWS4-HMAC-SHA256 Credential=',
    AWS,
    '/x, Signature=',
    SECRET,
    ', token=a{SYNTH}'
  ),
  JSON.stringify({ stdout: join('> Cookie', ': sid=\\"', SECRET, '\\"; token=a{SYNTH}') }),
  join('Cookie', `:a=${'\\'.repeat(7)}"`, SECRET, `${'\\'.repeat(7)}"; token=a{SYNTH}`),
  join('Authorization', `:Digest a=${'\\'.repeat(3)}'`, SECRET, `\\'`, ` password=a{SYNTH}`),
  `${b64Text('{"xx}')}.${b64Text('{"a":1,}')}.${JWT} token=a{SYNTH}`,
  `${b64Text('{"a":"\u00e9\ud800"}')}.${b64Text('{"b":[1,{"c":null}]}')}.sig secret=a{SYNTH}`,
  // \u7b2c\u56db\u8f6e\uff1aURL \u6388\u6743\u6bb5\u7684\u77ed\u7ec4\u5feb\u8def\u5f84\u3001\u4e0d\u542b / \u7684\u77ed\u7ec4\u4e0d\u8bb0\u5fc6\u3001\u8bb0\u5fc6\u5728 } \u4e4b\u540e\u6c47\u5408\u3001\u5feb\u8def\u5f84\u9000\u56de\u914d\u5e73\u5668\u3002
  `x://${'{}'.repeat(50)}:SYNTHETICpw@h token=a{SYNTH}`,
  `x://u:${join('$', '{A}').repeat(20)}SYNTHETICpw@h password=a{SYNTH}`,
  `${'x://{}{}{}{}:SYNTHETICpw@h\n'.repeat(3)}secret: a{SYNTH}`,
  'x://{a://u:SYNTHETICin@h}:SYNTHETICout@h token:a{SYNTH}',
  'x://{/}{a://b}{/}:SYNTHETICpw@h',
  'x://{a.b}{c}:SYNTHETICpw@h api_key=a{SYNTH}',
  `x://{${'y'.repeat(70)}}:SYNTHETICpw@h`,
  'x://{}{}:SYNTHETICpw{x... token=a{SYNTH}',
];

describe('attack inputs on the new code paths (mechanical S and structural checks)', () => {
  test.each(ATTACK_INPUTS.map((input, index) => ({ index, input })))('attack $index', ({
    input,
  }) => {
    const report = assertNoLegacyRegression(input);
    expect(redactDeveloperText(report.output)).toBe(report.output);
    expect(newlineSkeleton(report.output)).toBe(newlineSkeleton(input));
    // 新写出的标记都在封闭词表内（输入里本来就有的标记除外）。
    for (const found of report.output.match(/\[redacted[^\]]*\]/g) ?? []) {
      expect(REDACTION_MARKERS).toContain(found);
    }
  });

  test('the attack set is at least 30 inputs', () => {
    expect(ATTACK_INPUTS.length).toBeGreaterThanOrEqual(30);
  });
});

describe('bounded windows and reinterpretation paths are reported (counts only)', () => {
  test('a quoted value with no closing quote inside the window is read unquoted and reported', () => {
    // 降级读法（第一轮复查已接受的口径）：按不带引号的值读，开引号本身结束这个值，值为空、不产生区间；窗口触顶
    // 必须进报告，供有日志通道的调用方看到这条降级路径。
    const input = join('Authorization', ': Digest nonce="', body(5_000, 'SYNTHETICopen0123456789'));
    expect(detectWithRule(ruleById('authorization-header'), input)).toEqual([]);
    const { report } = redactDeveloperTextWithReport(input);
    expect(report.detectorEvents['window-exceeded']).toBeGreaterThan(0);
    expect(report.kinds).toContain('detector-window-exceeded');
    // 闭引号在窗口内时照常遮住。
    const closed = join(
      'Authorization',
      ': Digest nonce="',
      body(4_000, 'SYNTHETICclosed0123456789'),
      '"'
    );
    expect(redactDeveloperText(closed)).not.toContain('SYNTHETICclosed');
  });

  test('an over-long URL brace group falls back to the unbalanced reading and is reported', () => {
    const input = join(
      'postgres://app:$',
      `{DB_PASS:-${body(5_000, 'SYNTHETICgrp0123456789')}}@db/app`
    );
    const { text, report } = redactDeveloperTextWithReport(input);
    expect(report.detectorEvents['window-exceeded']).toBeGreaterThan(0);
    expect(report.detectorEvents['unbalanced-fallback']).toBeGreaterThan(0);
    expect(text).not.toContain('SYNTHETICgrp');
    assertNoLegacyRegression(input);
  });

  test('an over-long scheme is not a URL candidate and is reported', () => {
    const input = `${'a'.repeat(50)}://u:${SECRET}@host/x`;
    expect(detectWithRule(ruleById('url-userinfo'), input)).toEqual([]);
    const { report } = redactDeveloperTextWithReport(input);
    expect(report.detectorEvents['window-exceeded']).toBeGreaterThan(0);
  });

  test('a Cookie quote that holds separators is a carrier quote and is reported', () => {
    const input = join('Cookie', ': sid="a b; c"');
    const { report } = redactDeveloperTextWithReport(input);
    expect(report.detectorEvents['carrier-quote']).toBe(1);
    expect(report.kinds).toContain('detector-carrier-quote');
  });

  test('an Authorization value that is only a scheme word is a rejected candidate and is reported', () => {
    // 头值只有方案名（后面没有凭据，例如截断在方案名处）时候选被否决：不产生区间，但否决必须进报告。
    for (const input of [
      join('Authorization', ': Bearer'),
      join('Proxy-Authorization', ': Basic'),
      join('{"authorization":"', 'token"}'),
    ]) {
      const events: string[] = [];
      expect(
        detectT1Spans(input, { event: (kind, ruleId) => events.push(`${ruleId}:${kind}`) }),
        input
      ).toEqual([]);
      expect(events, input).toContain('authorization-header:rejected');
      const { report } = redactDeveloperTextWithReport(input);
      expect(report.detectorEvents.rejected, input).toBeGreaterThan(0);
      expect(report.kinds).toContain('detector-rejected');
    }
  });

  test('an unterminated quote is read unquoted and reported', () => {
    for (const input of [
      join('Authorization', ': Digest nonce="', SECRET),
      join('Authorization', ': Digest nonce="', SECRET, '\nnext line'),
      join('Cookie', ': sid="', SECRET),
    ]) {
      const { report } = redactDeveloperTextWithReport(input);
      expect(report.detectorEvents['unclosed-quote'], input).toBeGreaterThan(0);
      expect(report.kinds).toContain('detector-unclosed-quote');
    }
  });

  test('long cookie names and parameter names do not stop the pair loop (no fixed name window)', () => {
    const longName = 'n'.repeat(300);
    const cookie = join('Cookie', `: ${longName}=x; sid=${SECRET}`);
    expect(redactDeveloperText(cookie)).not.toContain(SECRET.slice(0, 8));
    const digest = join('Authorization', `: Digest ${longName}="a", response="${SECRET}"`);
    expect(redactDeveloperText(digest)).not.toContain(SECRET.slice(0, 8));
  });

  test('an unclosed dollar-brace group in an Authorization credential is dropped and reported', () => {
    const input = join('Authorization', ': Bearer abc$', '{TOKEN:-', SECRET);
    const { report } = redactDeveloperTextWithReport(input);
    expect(report.detectorEvents['unclosed-group']).toBe(1);
    expect(report.kinds).toContain('detector-unclosed-group');
    expect(detectWithRule(ruleById('authorization-header'), input)).toEqual([[22, 26]]);
  });
});

/** 参照实现：截断标记判定（与 detectors.ts 的正则同源，逐窗口切片）。 */
const TRUNCATION_REFERENCE = String.raw`(?:\.{3}|\u2026|\[\s*truncated\b[^\]\r\n]{0,40}\]|\[\s*\d+\s+(?:more\s+)?(?:lines?|chars?|characters?|bytes?)\s+(?:omitted|truncated|elided)[^\]\r\n]{0,20}\]|\(truncated\))`;
const TRUNCATION_HERE_REFERENCE = new RegExp(`^${TRUNCATION_REFERENCE}`, 'i');
const TRUNCATION_AFTER_REFERENCE = new RegExp(String.raw`^[ \t]*${TRUNCATION_REFERENCE}`, 'i');
const WINDOW = 4096;

type Stop = 'closed' | 'line' | 'truncation' | 'window' | 'end';

/** 参照实现：从开括号起逐字符的有界配平扫描（每组单独扫，不共享）。 */
function naiveGroup(text: string, open: number, url: boolean): { stop: Stop; end: number } {
  let depth = 1;
  for (let at = open + 1; at < text.length; at++) {
    if (at - open >= WINDOW) {
      return { stop: 'window', end: open + WINDOW };
    }
    const code = text.charCodeAt(at);
    if (code === 10 || code === 13) {
      return { stop: 'line', end: at };
    }
    if (url && code === 92 && /[nr]/.test(text[at + 1] ?? '')) {
      return { stop: 'line', end: at };
    }
    if (url && TRUNCATION_HERE_REFERENCE.test(text.slice(at, at + 96))) {
      return { stop: 'truncation', end: at };
    }
    if (code === 123) {
      depth++;
    } else if (code === 125) {
      depth--;
      if (depth === 0) {
        return { stop: 'closed', end: at };
      }
    }
  }
  return text.length - open < WINDOW
    ? { stop: 'end', end: text.length }
    : { stop: 'window', end: open + WINDOW };
}

function isStop(code: number): boolean {
  return code <= 32 || [47, 63, 35, 34, 39, 60, 62, 96, 92].includes(code);
}

/** 参照实现：URL 授权段逐候选扫描（配平读法遇到组时逐组扫描）。 */
function naiveAuthority(text: string, from: number, balanced: boolean) {
  let colon = -1;
  let at = -1;
  let index = from;
  let open = false;
  let truncatedInGroup = false;
  let windowExceeded = false;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (balanced && code === 123) {
      const group = naiveGroup(text, index, true);
      if (group.stop !== 'closed') {
        open = true;
        truncatedInGroup = group.stop === 'truncation';
        windowExceeded = group.stop === 'window';
        index = group.end;
        break;
      }
      index = group.end + 1;
      continue;
    }
    if (isStop(code)) {
      break;
    }
    if (code === 58 && colon < 0) {
      colon = index;
    } else if (code === 64) {
      at = index;
    }
    index++;
  }
  return { colon, at, end: index, open, truncatedInGroup, windowExceeded };
}

function naiveUserinfo(
  text: string,
  scan: ReturnType<typeof naiveAuthority>
): Array<[number, number]> {
  if (scan.colon < 0) {
    return [];
  }
  if (scan.at > scan.colon) {
    return scan.at > scan.colon + 1 ? [[scan.colon + 1, scan.at]] : [];
  }
  if (scan.at >= 0) {
    return [];
  }
  let visibleEnd = -1;
  if (scan.truncatedInGroup) {
    visibleEnd = scan.end;
  } else {
    for (let index = scan.colon + 1; index < scan.end; index++) {
      if (TRUNCATION_HERE_REFERENCE.test(text.slice(index, index + 96))) {
        visibleEnd = index;
        break;
      }
    }
    if (visibleEnd < 0 && TRUNCATION_AFTER_REFERENCE.test(text.slice(scan.end, scan.end + 96))) {
      visibleEnd = scan.end;
    }
  }
  if (visibleEnd <= scan.colon + 1 || /^\d+$/.test(text.slice(scan.colon + 1, visibleEnd))) {
    return [];
  }
  return [[scan.colon + 1, visibleEnd]];
}

/** 参照实现：URL userinfo 规则（逐候选现算，候选推进口径与 detectWithRule 相同）。 */
function naiveUrlSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const scanner = /:(?:\\*\/){2}/g;
  for (let match = scanner.exec(text); match !== null; match = scanner.exec(text)) {
    let furthest = scanner.lastIndex;
    let start = match.index;
    while (start > 0 && /[A-Za-z0-9+.-]/.test(text[start - 1] ?? '') && match.index - start <= 40) {
      start--;
    }
    const scheme = text.slice(start, match.index);
    if (match.index - start > 40 || scheme === '' || !/^[A-Za-z]/.test(scheme)) {
      continue;
    }
    const from = match.index + match[0].length;
    const balanced = naiveAuthority(text, from, true);
    const found = naiveUserinfo(text, balanced);
    if (balanced.open && !balanced.truncatedInGroup) {
      const plain = naiveUserinfo(text, naiveAuthority(text, from, false));
      found.push(...plain);
      if (plain.length === 0 && balanced.colon >= 0 && balanced.at < 0) {
        found.push([balanced.colon + 1, balanced.end]);
      }
    }
    for (const [spanStart, spanEnd] of found) {
      if (spanEnd > spanStart) {
        spans.push([spanStart, spanEnd]);
        furthest = Math.max(furthest, spanEnd);
      }
    }
    scanner.lastIndex = furthest;
  }
  return spans;
}

const PIECES = [
  'a://',
  'http://',
  'postgres://app:',
  ':\\/\\/',
  '{',
  '}',
  '$' + '{',
  '{{ ',
  ' }}',
  ':',
  '@',
  'u',
  'pw',
  '8080',
  '/',
  ' ',
  '\n',
  '\\n',
  '...',
  '\u2026',
  ' [truncated]',
  '[12 lines omitted]',
  '(truncated)',
  '"',
  "'",
  '?',
  '#',
  'x',
  'SYNTH',
];

function randomPieces(random: () => number, count: number): string {
  let out = '';
  for (let index = 0; index < count; index++) {
    if (random() < 0.01) {
      out += 'y'.repeat(4_000 + Math.floor(random() * 300));
      continue;
    }
    out += PIECES[Math.floor(random() * PIECES.length)] ?? '';
  }
  return out;
}

/** 参照实现：逐字符有界扫描找闭引号（第三轮之前 quotedValue 的写法）。 */
function naiveQuoteClose(
  text: string,
  innerStart: number,
  quote: string,
  slashes: number
): { stop: string; at: number } {
  const limit = Math.min(text.length, innerStart + 4_096);
  for (let index = innerStart; index < limit; index++) {
    if (text[index] === '\n' || text[index] === '\r') {
      return { stop: 'line', at: index };
    }
    if (text[index] !== quote) {
      continue;
    }
    let run = 0;
    while (index - run - 1 >= innerStart && text[index - run - 1] === '\\') {
      run++;
    }
    if (run === slashes) {
      return { stop: 'closed', at: index };
    }
  }
  return limit < text.length ? { stop: 'window', at: limit } : { stop: 'end', at: text.length };
}

/** 参照实现：base64url 段解码后以 { 开头且 JSON.parse 成功（第三轮之前 decodesToJsonObject 的写法）。 */
function referenceJsonObject(segment: string): boolean {
  const decoded = Buffer.from(segment, 'base64url').toString('utf8');
  if (!decoded.startsWith('{') || !decoded.trimEnd().endsWith('}')) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(decoded);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch (err: unknown) {
    // 参照实现里解析失败就是“不是 JSON 对象”。
    void err;
    return false;
  }
}

function randomJsonValue(random: () => number, depth: number): unknown {
  const pick = random();
  if (depth <= 0 || pick < 0.35) {
    const scalars: unknown[] = [
      0,
      -1,
      1.5e-7,
      123456789,
      -0.25,
      true,
      false,
      null,
      '',
      'SYNTH',
      'quote " and \\ backslash',
      'line\nbreak\ttab\u0001ctl',
      'é中\u{1f600} ',
      '\ud800',
    ];
    return scalars[Math.floor(random() * scalars.length)];
  }
  if (pick < 0.65) {
    return Array.from({ length: Math.floor(random() * 4) }, () =>
      randomJsonValue(random, depth - 1)
    );
  }
  const object: Record<string, unknown> = {};
  for (let index = Math.floor(random() * 4); index > 0; index--) {
    object[`k${Math.floor(random() * 100)}ü`] = randomJsonValue(random, depth - 1);
  }
  return object;
}

/** JSON 风格的随机字节串（以 { 开头），覆盖结构字符、转义、数字、字面量、空白、控制字符与非 ASCII / 非法 UTF-8。 */
const JSONISH_BYTES = [
  '{',
  '}',
  '[',
  ']',
  ',',
  ':',
  '"',
  '\\',
  'u',
  '0',
  '1',
  '9',
  '-',
  '.',
  'e',
  'E',
  '+',
  'true',
  'false',
  'null',
  'tru',
  ' ',
  '\n',
  '\t',
  '\r',
  '\u0000',
  '\u001f',
  'a',
  'x',
  '/',
  'b',
  '"a"',
  '"k":1',
  '\\u00e9',
  '\\uD800',
  '\\x',
].map((piece) => [...Buffer.from(piece, 'utf8')]);
const RAW_BYTES = [
  [0x80],
  [0xc3, 0xa9],
  [0xff],
  [0xe2, 0x80],
  [0xe2, 0x80, 0xa8],
  [0xc2, 0xa0],
  [0xef, 0xbb, 0xbf],
  [0x7f],
];

function randomJsonishBytes(random: () => number): number[] {
  const bytes = [0x7b];
  const count = Math.floor(random() * 14);
  for (let index = 0; index < count; index++) {
    const pool = random() < 0.15 ? RAW_BYTES : JSONISH_BYTES;
    bytes.push(...(pool[Math.floor(random() * pool.length)] ?? []));
  }
  return bytes;
}

function mutateBytes(random: () => number, bytes: number[]): number[] {
  const out = [...bytes];
  const edits = 1 + Math.floor(random() * 3);
  for (let edit = 0; edit < edits; edit++) {
    const at = Math.floor(random() * (out.length + 1));
    const kind = random();
    const fresh =
      random() < 0.3
        ? (RAW_BYTES[Math.floor(random() * RAW_BYTES.length)] ?? [])
        : (JSONISH_BYTES[Math.floor(random() * JSONISH_BYTES.length)] ?? []);
    if (kind < 0.4) {
      out.splice(at, 0, ...fresh);
    } else if (kind < 0.7) {
      out.splice(at, 1);
    } else {
      out.splice(at, 1, ...fresh);
    }
  }
  return out;
}

describe('the JWT JSON-object judgment is linear and exception-free, and equals decoding plus JSON.parse', () => {
  function judge(segment: string): boolean {
    return decodesToJsonObject(segment, 0, segment.length, new DetectorScratch(segment));
  }

  test('random objects, mutations, JSON-ish bytes and truncated base64url agree with the reference', () => {
    const random = seededRandom(20261022);
    let accepted = 0;
    let rejected = 0;
    for (let trial = 0; trial < 12_000; trial++) {
      let bytes: number[];
      const mode = trial % 3;
      if (mode === 0) {
        bytes = [...Buffer.from(JSON.stringify(randomJsonValue(random, 4)) ?? 'null', 'utf8')];
        if (bytes[0] !== 0x7b) {
          bytes = [...Buffer.from(JSON.stringify({ wrapped: randomJsonValue(random, 3) }), 'utf8')];
        }
        if (random() < 0.3) {
          bytes.push(...(random() < 0.5 ? [0x20, 0x0a] : [0xc2, 0xa0]));
        }
      } else if (mode === 1) {
        bytes = mutateBytes(random, [
          ...Buffer.from(JSON.stringify({ a: randomJsonValue(random, 3), b: 'SYNTH' }), 'utf8'),
        ]);
      } else {
        bytes = randomJsonishBytes(random);
      }
      const encoded = Buffer.from(bytes).toString('base64url');
      for (const segment of [
        encoded,
        encoded.slice(0, -1),
        encoded.slice(0, -2),
        encoded.slice(0, -3),
      ]) {
        if (segment.length === 0) {
          continue;
        }
        const expected = referenceJsonObject(segment);
        expect(judge(segment), JSON.stringify(segment)).toBe(expected);
        if (expected) {
          accepted++;
        } else {
          rejected++;
        }
      }
    }
    expect(accepted).toBeGreaterThan(3_000);
    expect(rejected).toBeGreaterThan(10_000);
  });

  test('hand-picked edge cases agree with the reference', () => {
    const cases = [
      '{"xx}',
      '{"a":1,}',
      '{,}',
      '{}',
      '{} ',
      '{} ',
      ' {}',
      '{"a":01}',
      '{"a":-}',
      '{"a":1.}',
      '{"a":1e}',
      '{"a":1e+5}',
      '{"a":-0.5E-3}',
      '{"a":"\\u12"}',
      '{"a":"\\uD800"}',
      '{"a":"\\q"}',
      '{"a":tru}',
      '{"a":true}',
      '{"a":[1,]}',
      '{"a":[]}',
      '{"a":{}}',
      '{"a" : [ 1 , { "b" : null } ] }',
      '{"a":1}}',
      '{"a":1}{',
      `{"a":${'['.repeat(5_000)}${']'.repeat(5_000)}}`,
      `{"a":${'['.repeat(5_000)}${']'.repeat(4_999)}}`,
      '{"a":"\u0001"}',
      '{"a":" "}',
    ];
    for (const raw of cases) {
      const segment = Buffer.from(raw, 'utf8').toString('base64url');
      expect(judge(segment), raw.slice(0, 40)).toBe(referenceJsonObject(segment));
    }
    // 非 base64url 字符（调用方不会传）按“不是 JSON 对象”处理，不抛异常。
    expect(decodesToJsonObject('eyJ.e30', 0, 7, new DetectorScratch('eyJ.e30'))).toBe(false);
  });

  test('the byte recognizer never throws and keeps an explicit stack', () => {
    const deep = Buffer.from(`{"a":${'['.repeat(50_000)}${']'.repeat(50_000)}}`, 'utf8');
    expect(isJsonObjectBytes(deep, deep.length, new Uint8Array(deep.length))).toBe(true);
    expect(isJsonObjectBytes(deep, deep.length - 1, new Uint8Array(deep.length))).toBe(false);
  });
});

describe('shared scanning equals per-candidate scanning (linear bookkeeping is exact)', () => {
  test('the closing-quote index equals per-candidate bounded scanning (quote, backslash run, line, window)', () => {
    const random = seededRandom(31_337);
    const pieces = [
      '"',
      "'",
      '\\',
      '\\\\',
      '\\"',
      "\\'",
      '\\\\"',
      'a',
      'SYNTH',
      ' ',
      '\n',
      '\r',
      ';',
      ',',
    ];
    let checks = 0;
    const seen = new Set<string>();
    for (let trial = 0; trial < 800; trial++) {
      let text = '';
      const count = 5 + Math.floor(random() * 80);
      for (let index = 0; index < count; index++) {
        text +=
          random() < 0.01
            ? 'z'.repeat(4_090 + Math.floor(random() * 20))
            : (pieces[Math.floor(random() * pieces.length)] ?? '');
      }
      const scratch = new DetectorScratch(text);
      for (let at = 0; at < text.length; at++) {
        let cursor = at;
        while (text[cursor] === '\\') {
          cursor++;
        }
        const quote = text[cursor];
        if (quote !== '"' && quote !== "'") {
          continue;
        }
        const expected = naiveQuoteClose(text, cursor + 1, quote, cursor - at);
        expect(
          scratch.quoteClose(cursor + 1, quote.charCodeAt(0), cursor - at),
          JSON.stringify([trial, at])
        ).toEqual(expected);
        seen.add(expected.stop);
        checks++;
      }
    }
    expect(checks).toBeGreaterThan(10_000);
    expect([...seen].sort()).toEqual(['closed', 'end', 'line', 'window']);
  });

  test('the space check equals /\\s/ on every UTF-16 code unit', () => {
    const reference = /\s/;
    for (let code = 0; code <= 0xffff; code++) {
      if (isRegexSpaceCode(code) !== reference.test(String.fromCharCode(code))) {
        throw new Error(`space check differs at U+${code.toString(16)}`);
      }
    }
  });

  test('the Cookie separator index equals the reference character class', () => {
    const random = seededRandom(99);
    const pieces = ['a', 'b=c', ';', ',', ' ', '\t', ' ', ' ', '﻿', '　', '\n', 'SYNTH', '"'];
    for (let trial = 0; trial < 2_000; trial++) {
      let text = '';
      const count = 1 + Math.floor(random() * 30);
      for (let index = 0; index < count; index++) {
        text += pieces[Math.floor(random() * pieces.length)] ?? '';
      }
      const scratch = new DetectorScratch(text);
      for (let probe = 0; probe < 10; probe++) {
        const from = Math.floor(random() * (text.length + 1));
        const to = from + Math.floor(random() * (text.length - from + 1));
        expect(scratch.hasCookieSeparator(from, to)).toBe(/[\s;,]/.test(text.slice(from, to)));
      }
    }
  });

  test('the brace resolvers equal per-group bounded scanning, in increasing and random query order', () => {
    const random = seededRandom(20261022);
    let checks = 0;
    for (let trial = 0; trial < 1_500; trial++) {
      const text = randomPieces(random, 5 + Math.floor(random() * 60));
      const opens: number[] = [];
      for (let index = 0; index < text.length; index++) {
        if (text[index] === '{') {
          opens.push(index);
        }
      }
      const shuffled = [...opens].sort(() => random() - 0.5);
      for (const order of [opens, shuffled]) {
        const scratch = new DetectorScratch(text);
        for (const open of order) {
          checks++;
          expect(scratch.headerBraces().resolve(open), `${trial}:${open}`).toEqual(
            naiveGroup(text, open, false)
          );
        }
      }
    }
    expect(checks).toBeGreaterThan(10_000);
  });

  test('URL authority readings equal per-start scanning in any order; simple groups equal the resolver', () => {
    // 第四轮复查：授权段读法改为按接续位置下标的类型数组记忆（不分配对象、不查 Map），简单组走快路径不进配平器，
    // 不含 / 的简单组不记忆。读法是位置的纯函数，所以无论按候选顺序还是任意顺序、从任意位置起读，结论都必须与逐
    // 字符的朴素读法相同（含组内截断、换行、转义换行、窗口触顶、嵌套组里的候选汇入外层接续）。
    const random = seededRandom(202_610_224);
    const pieces = [
      'x://',
      ':\\/\\/',
      '{',
      '}',
      '{}',
      join('$', '{A}'),
      '{/}',
      '{a://b}',
      ':',
      '@',
      'pw',
      '/',
      ' ',
      '\n',
      '\\n',
      '...',
      '[',
      ' [truncated]',
      '(',
      '.',
      'u',
      '\u2026',
      'y'.repeat(70),
    ];
    let checks = 0;
    let fastGroups = 0;
    for (let trial = 0; trial < 2_000; trial++) {
      let text = '';
      const count = 3 + Math.floor(random() * 60);
      for (let index = 0; index < count; index++) {
        text +=
          random() < 0.004
            ? 'z'.repeat(4_100)
            : (pieces[Math.floor(random() * pieces.length)] ?? '');
      }
      for (let open = text.indexOf('{'); open >= 0; open = text.indexOf('{', open + 1)) {
        const fast = simpleGroupEnd(text, open);
        if (fast >= 0) {
          fastGroups++;
          expect(naiveGroup(text, open, true), JSON.stringify([text.slice(0, 200), open])).toEqual({
            stop: 'closed',
            end: fast,
          });
        }
      }
      const starts = [...text.matchAll(/:(?:\\*\/){2}/g)].map(
        (match) => match.index + match[0].length
      );
      const randomStarts = Array.from({ length: 12 }, () =>
        Math.floor(random() * (text.length + 1))
      );
      const shuffled = [...starts, ...randomStarts].sort(() => random() - 0.5);
      for (const order of [starts, shuffled]) {
        const scratch = new DetectorScratch(text);
        for (const from of order) {
          checks++;
          expect(scratch.authorityChain(from), JSON.stringify([text.slice(0, 200), from])).toEqual(
            naiveAuthority(text, from, true)
          );
        }
      }
    }
    expect(checks).toBeGreaterThan(20_000);
    expect(fastGroups).toBeGreaterThan(5_000);
  });

  test('URL userinfo spans equal a per-candidate reference on random inputs', () => {
    const random = seededRandom(4_242_4242);
    const rule = ruleById('url-userinfo');
    let withSpans = 0;
    for (let trial = 0; trial < 3_000; trial++) {
      const text = randomPieces(random, 5 + Math.floor(random() * 50));
      const expected = naiveUrlSpans(text);
      expect(detectWithRule(rule, text), JSON.stringify(text.slice(0, 300))).toEqual(expected);
      if (expected.length > 0) {
        withSpans++;
      }
    }
    expect(withSpans).toBeGreaterThan(500);
  });

  test('the glued header-name check equals its reference regex', () => {
    const reference = /^(?:(?:proxy-)?authorization|(?:set-)?cookie)(?:\\*["'])?[ \t]*:[ \t]/i;
    const random = seededRandom(11);
    const pieces = [
      'Authorization',
      'AUTHORIZATION',
      'proxy-',
      'Proxy-',
      'Set-',
      'set_',
      'Cookie',
      'cookie',
      'COOKIE',
      '\\',
      '"',
      "'",
      ' ',
      '\t',
      ':',
      '\r',
      '\n',
      'x',
      'Authorizatio',
      'cooki',
    ];
    for (let trial = 0; trial < 20_000; trial++) {
      let text = '';
      const count = 1 + Math.floor(random() * 8);
      for (let index = 0; index < count; index++) {
        text += pieces[Math.floor(random() * pieces.length)] ?? '';
      }
      for (let at = 0; at < text.length; at++) {
        expect(startsGluedHeaderName(text, at), JSON.stringify([text, at])).toBe(
          reference.test(text.slice(at))
        );
      }
    }
  });

  test('the truncation fast path equals the reference regex', () => {
    const random = seededRandom(7);
    const pieces = [
      '.',
      '..',
      '...',
      '\u2026',
      '[',
      ']',
      ' ',
      '\t',
      'truncated',
      'TRUNCATED',
      '12',
      ' lines',
      ' omitted',
      '(',
      ')',
      '(truncated)',
      'x',
      '\u00a0',
      '\n',
    ];
    for (let trial = 0; trial < 20_000; trial++) {
      let text = '';
      const count = 1 + Math.floor(random() * 12);
      for (let index = 0; index < count; index++) {
        text += pieces[Math.floor(random() * pieces.length)] ?? '';
      }
      if (random() < 0.05) {
        text = `${' '.repeat(80 + Math.floor(random() * 20))}${text}`;
      }
      for (let at = 0; at <= text.length; at++) {
        expect(truncationFollows(text, at), JSON.stringify([text, at])).toBe(
          TRUNCATION_AFTER_REFERENCE.test(text.slice(at, at + 96))
        );
      }
    }
  });
});

describe('long values are masked entirely and detection cost stays linear', () => {
  test('a credential, cookie list or parameter list longer than the scan window is masked to its end', () => {
    const long = body(6_000, 'SYNTHETIClong0123456789');
    for (const input of [
      join('Authorization', `: Token ${long}`),
      join(
        'Cookie',
        ': ',
        Array.from({ length: 600 }, (_, index) => `k${index}=v${index}SYNTH`).join('; ')
      ),
      join(
        'Authorization',
        ': Digest ',
        Array.from({ length: 600 }, (_, index) => `p${index}="SYNTH${index}"`).join(', ')
      ),
    ]) {
      const output = redactDeveloperText(input);
      expect(output).not.toMatch(/SYNTH/);
    }
  });
});

describe('detection cost stays linear on adversarial inputs', () => {
  const builders: Array<[string, (count: number) => string]> = [
    ['repeated prefixes', (count) => `${join('gh', 'p_')}abcd `.repeat(count)],
    ['long scheme-like word before ://', (count) => `${'a-'.repeat(count)}://u:p@h`],
    ['many URLs', (count) => 'https://u:p@h/x '.repeat(count)],
    ['unclosed braces', (count) => join('https://u:$', '{x'.repeat(count))],
    ['many JWT candidates', (count) => `${join('ey', 'J')}abcdefgh.abcdefgh.x `.repeat(count)],
    ['many cookies', (count) => join('Cookie', ': ', 'a=b; '.repeat(count))],
    ['many sig= params', (count) => '?sig=abcdefghijkl&'.repeat(count)],
    ['header names glued without spaces', (count) => join('Authorization', ':').repeat(count)],
    [
      'many unclosed ${ in one header',
      (count) => join('Authorization: Bearer ', '$', '{a'.repeat(count)),
    ],
    [
      'many unclosed quotes in one cookie header',
      (count) => join('Cookie', ': ', 'a="b; '.repeat(count)),
    ],
    [
      'many Digest parameters',
      (count) => join('Authorization', ': Digest ', 'a="b", '.repeat(count)),
    ],
    // 复查阻塞形态：单段长 eyJ 串与 base64 编码的 JSON 数组（大量 eyJ 起点落在同一个长串里）。
    ['single long eyJ run', (count) => join('ey', 'J').repeat(count)],
    [
      'base64 JSON array',
      (count) =>
        Buffer.from(
          JSON.stringify(Array.from({ length: count / 8 }, (_, index) => ({ id: index, ok: true })))
        ).toString('base64'),
    ],
    // 密集未闭合的 “:// {”、JSON stdout 里的未闭合 URL 花括号、共享尾段的嵌套组。
    ['dense unclosed :// {', (count) => 'a://{'.repeat(count)],
    [
      'JSON stdout with unclosed URL braces',
      (count) =>
        JSON.stringify({
          stdout: Array.from(
            { length: count / 4 },
            (_, index) => `u${index}=http://{h${index}`
          ).join(', '),
        }),
    ],
    [
      'nested URL brace groups sharing one tail',
      (count) =>
        `${'x://{'.repeat(count / 2)}${'}'.repeat(count / 2)}:${'SYNTH'.repeat(count / 4)}`,
    ],
    // 第四轮复查阻塞形态：URL 授权段里连续的已闭合花括号组（有无口令、口令由大量 ${A} 引用组成、每行一个只含
    // 少量组的 URL）。每个组的开销必须是常数（按位置下标的类型数组，不分配对象、不查 Map）。
    ['closed brace groups before a URL password', (count) => `x://${'{}'.repeat(count)}:pw@h`],
    ['closed brace groups in a URL without a password', (count) => `x://${'{}'.repeat(count * 2)}`],
    [
      'URL password made of many dollar-brace references',
      (count) => `x://u:${join('$', '{A}').repeat(count)}@h`,
    ],
    [
      'one URL with four closed brace groups per line',
      (count) => 'x://{}{}{}{}:pw@h\n'.repeat(count / 4),
    ],
    // 密集 sig= 候选（有无 sv= 版本参数）与大量未闭合 ${ 的认证头。
    ['dense sig= without sv=', (count) => '?sig=abcdefgh'.repeat(count)],
    ['dense sig= with sv=', (count) => '&sv=2020&sig=abcdefgh'.repeat(count)],
    [
      'many unclosed dollar-brace groups in Authorization headers',
      (count) => join('Authorization: Bearer x$', '{').repeat(count / 2),
    ],
    // 第三轮复查阻塞形态：解码后形似 JSON 对象却不合法的 JWT 段（链式、尾逗号），以及开引号带不同个数反斜杠的
    // Digest 参数与 Cookie 值（闭引号要找同样个数的反斜杠）。
    [
      'chained JWT-like segments that are not JSON',
      (count) => `${b64Text('{"xx}')}.`.repeat(count),
    ],
    [
      'JWT-like segments with trailing-comma JSON',
      (count) => `${b64Text('{"a":1,}')}.${b64Text('{"b":2,}')}.sig `.repeat(count / 2),
    ],
    [
      'Digest values opened by varying backslash-quote runs',
      (count) =>
        Array.from({ length: count / 4 }, (_, index) =>
          join('Authorization', `:Digest a=${'\\'.repeat(index % 80)}" `)
        ).join(''),
    ],
    [
      'Cookie values opened by varying backslash-quote runs',
      (count) =>
        Array.from({ length: count / 4 }, (_, index) =>
          join('Cookie', `:a=${'\\'.repeat(index % 80)}" `)
        ).join(''),
    ],
    [
      'one Digest header with many short parameters',
      (count) => join('Authorization: Digest ', 'a=b,'.repeat(count)),
    ],
    [
      'log lines with 40-pair Cookie headers',
      (count) =>
        Array.from({ length: count / 40 }, (_, line) =>
          join(
            'Cookie',
            ': ',
            Array.from({ length: 40 }, (_, pair) => `c${pair}=v${line}`).join('; ')
          )
        ).join('\n'),
    ],
  ];

  test.each(builders)(
    '%s',
    (_name, build) => {
      const small = build(8_000);
      const large = build(32_000);
      detectT1Spans(small);
      let smallBest = Number.POSITIVE_INFINITY;
      let largeBest = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 5; round++) {
        let started = performance.now();
        detectT1Spans(small);
        smallBest = Math.min(smallBest, performance.now() - started);
        started = performance.now();
        detectT1Spans(large);
        largeBest = Math.min(largeBest, performance.now() - started);
      }
      // 输入放大 4 倍，耗时应近似放大 4 倍；并行测试的负载噪声留足余量，仍远低于平方级的 16 倍。
      expect(largeBest).toBeLessThan(Math.max(smallBest, 2) * 10);
      expect(largeBest).toBeLessThan(3_000);
    },
    60_000
  );
});
