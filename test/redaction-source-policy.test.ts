/**
 * 脱敏阶段 4e：T3 按来源追加（设计 redaction-design-2026-10-19 第 4.4 节 T3、第 4.5 节通道表、不变量 A）。
 *
 * - 规则表：每条 T3 规则是数据 {id, tier:'T3', sources, pattern, examples[], negativeExamples[]}；正例中秘密的
 *   任何不短于 4 字符的片段都不得出现在输出里，且至少一个正例在未知来源底线下确实露出（证明规则补的是真缺口，
 *   新增改写可归到本规则）；反例在规则列出的每个来源下逐字保留。
 * - 来源矩阵：同一段文本在 source / config / terminal / secret-bearing（含 code.search 代理前缀）与未知来源下的输出。
 * - 不变量 A（性质测试）：任何来源上下文下被遮的非结构字符 ⊇ 未知来源下被遮的；另对四个历史版本直接核对 S。
 * - 结构：幂等、裸换行守恒、标记词表封闭、确定性；没有 T3 规则的来源与开发者事件通道逐字等于 redactDeveloperText。
 * 所有秘密都是合成值（SYNTHETIC 标记）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  redactDeveloperText,
  redactDeveloperTextInContext,
  redactDeveloperTextInContextWithProvenance,
  redactDeveloperTextInContextWithReport,
} from '../src/agent/utils/Redaction.js';
import { REDACTION_MARKERS } from '../src/agent/utils/redaction/hiddenSpans.js';
import {
  applyRedactionFloor,
  applyRedactionFloorWithProvenance,
  createFloorReplayShare,
  type FloorDetector,
} from '../src/agent/utils/redaction/legacyFloor.js';
import {
  classifyRedactionSource,
  detectSourcePolicySpans,
  nextEnvAssignment,
  type RedactionSourceContext,
  SOURCE_POLICY_RULES,
  type SourcePolicySource,
  sourcePolicyRulesFor,
  verboseHeaderMatches,
} from '../src/agent/utils/redaction/sourcePolicy.js';
import { adversarialInputs, seededRandom } from './fixtures/redaction-catalog/fuzzCorpus.js';
import {
  assertNoLegacyRegression,
  exemptPositions,
} from './fixtures/redaction-catalog/legacyRegressionOracle.js';
import { BASELINE_REVISIONS, exactHidden } from './fixtures/redaction-catalog/trackedReplay.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const catalog = JSON.parse(
  readFileSync(path.join(repoRoot, 'test/fixtures/redaction-catalog/catalog.json'), 'utf8')
) as {
  catalog: Array<{ id: string; input: string }>;
  newFindings: Array<{ id: string; input: string }>;
};

/** 每类来源的一个代表上下文（terminal 的 file 来自命令 token，不可信，分类表一律按终端处理）。 */
const CONTEXTS: Readonly<Record<string, RedactionSourceContext | undefined>> = {
  unknown: undefined,
  'no-file': { tool: 'graph.query' },
  source: { tool: 'code.read', file: 'src/app/settings.ts' },
  config: { tool: 'code.read', file: 'config/app.yaml' },
  terminal: { tool: 'terminal.exec', file: 'deploy/.env' },
  'secret-bearing': { tool: 'code.read', file: 'deploy/.env' },
  'secret-bearing-search': { tool: 'code.search', file: 'deploy/.env' },
};

const CONTEXT_FOR_SOURCE: Readonly<Record<SourcePolicySource, RedactionSourceContext>> = {
  terminal: { tool: 'terminal.exec' },
  'secret-bearing': { tool: 'code.read', file: '.netrc' },
};

const NON_T3_CONTEXTS = ['unknown', 'no-file', 'source', 'config'] as const;

function windows(secret: string): string[] {
  const out: string[] = [];
  for (let index = 0; index + 4 <= secret.length; index++) {
    out.push(secret.slice(index, index + 4));
  }
  return out;
}

function leakedFragments(output: string, secrets: readonly string[]): string[] {
  const leaked: string[] = [];
  for (const secret of secrets) {
    for (const fragment of windows(secret)) {
      if (output.includes(fragment)) {
        leaked.push(fragment);
      }
    }
  }
  return leaked;
}

function newlineSkeleton(text: string): string {
  return text.replace(/[^\r\n]/g, '');
}

/** 输入位置是否出现在输出里（按逐字符来源表）。 */
function visibleMask(length: number, origin: Int32Array): Uint8Array {
  const visible = new Uint8Array(length);
  for (const from of origin) {
    if (from >= 0 && from < length) {
      visible[from] = 1;
    }
  }
  return visible;
}

/** 不变量 A 与 S 的逐字符核对；返回违例描述（空数组为通过）。 */
function invariantViolations(input: string, context: RedactionSourceContext | undefined): string[] {
  const problems: string[] = [];
  const unknown = redactDeveloperTextInContextWithProvenance(input, undefined);
  const scoped = redactDeveloperTextInContextWithProvenance(input, context);
  if (unknown.text !== redactDeveloperText(input)) {
    problems.push('unknown-source comparator differs from redactDeveloperText');
  }
  for (const result of [unknown, scoped]) {
    for (let index = 0; index < result.text.length; index++) {
      const from = result.origin[index] ?? -1;
      if (from >= 0 && input[from] !== result.text[index]) {
        problems.push('provenance does not match the output');
        break;
      }
    }
  }
  const exempt = exemptPositions(input);
  const visibleUnknown = visibleMask(input.length, unknown.origin);
  const visibleScoped = visibleMask(input.length, scoped.origin);
  for (let index = 0; index < input.length; index++) {
    if (exempt[index] !== 1 && visibleScoped[index] === 1 && visibleUnknown[index] !== 1) {
      problems.push(`A: position ${index} hidden without source context but visible with it`);
      break;
    }
  }
  for (const revision of BASELINE_REVISIONS) {
    const hidden = exactHidden(revision, input);
    for (let index = 0; index < input.length; index++) {
      if (hidden[index] === 1 && visibleScoped[index] === 1 && exempt[index] !== 1) {
        problems.push(`S: ${revision} hides ${index} but the scoped output shows it`);
        break;
      }
    }
  }
  if (redactDeveloperTextInContext(scoped.text, context) !== scoped.text) {
    problems.push('scoped output is not idempotent');
  }
  if (newlineSkeleton(scoped.text) !== newlineSkeleton(input)) {
    problems.push('bare newline sequence changed');
  }
  for (const match of scoped.text.matchAll(/\[redacted[^\]\s]*\]/g)) {
    const synthetic = (scoped.origin[match.index] ?? -1) < 0;
    if (synthetic && !REDACTION_MARKERS.includes(match[0])) {
      problems.push(`marker outside the closed vocabulary: ${match[0]}`);
    }
  }
  if (scoped.text !== redactDeveloperTextInContext(input, context)) {
    problems.push('provenance entry and production entry disagree');
  }
  return problems;
}

describe('T3 rule table (data with examples, built-time checked)', () => {
  test('every rule is T3 data with explicit sources, a pattern, examples and negative examples', () => {
    expect(SOURCE_POLICY_RULES.length).toBeGreaterThanOrEqual(5);
    const ids = SOURCE_POLICY_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of SOURCE_POLICY_RULES) {
      expect(rule.tier).toBe('T3');
      expect(rule.sources.length, rule.id).toBeGreaterThan(0);
      for (const source of rule.sources) {
        expect(['terminal', 'secret-bearing']).toContain(source);
      }
      expect(rule.pattern).toBeInstanceOf(RegExp);
      expect(rule.pattern.sticky, rule.id).toBe(false);
      expect(rule.examples.length, rule.id).toBeGreaterThan(0);
      expect(rule.negativeExamples.length, rule.id).toBeGreaterThan(0);
      expect(rule.description.length, rule.id).toBeGreaterThan(0);
    }
    // 设计 4.4 T3 的五项，以及 D10：.netrc 只在终端与 secret-bearing 来源中生效。
    const byId = new Map(SOURCE_POLICY_RULES.map((rule) => [rule.id, rule]));
    expect(byId.get('secret-bearing-every-value')?.sources).toEqual(['secret-bearing']);
    expect(byId.get('terminal-env-sensitive-key')?.sources).toEqual(['terminal']);
    expect(byId.get('terminal-curl-verbose-auth-header')?.sources).toEqual(['terminal']);
    expect(byId.get('terminal-kubectl-secret-data')?.sources).toEqual(['terminal']);
    expect([...(byId.get('netrc-password')?.sources ?? [])].sort()).toEqual([
      'secret-bearing',
      'terminal',
    ]);
  });

  test('examples are self-consistent: secret fragments do not occur outside the secrets', () => {
    for (const rule of SOURCE_POLICY_RULES) {
      for (const example of rule.examples) {
        let rest = example.text;
        for (const secret of example.secrets) {
          expect(example.text, `${rule.id}: secret present`).toContain(secret);
          rest = rest.split(secret).join('\u0000');
        }
        expect(leakedFragments(rest, example.secrets), `${rule.id}: ${example.text}`).toEqual([]);
      }
    }
  });

  test('positive examples hide every fragment of at least 4 characters in every listed source', () => {
    for (const rule of SOURCE_POLICY_RULES) {
      for (const source of rule.sources) {
        for (const example of rule.examples) {
          const context = example.tool
            ? { ...CONTEXT_FOR_SOURCE[source], tool: example.tool }
            : CONTEXT_FOR_SOURCE[source];
          const output = redactDeveloperTextInContext(example.text, context);
          expect(
            leakedFragments(output, example.secrets),
            `${rule.id}@${source}: ${JSON.stringify(example.text)} -> ${JSON.stringify(output)}`
          ).toEqual([]);
          const detection = detectSourcePolicySpans(example.text, [rule], context.tool);
          expect(detection.spans.length, `${rule.id} fires on its own example`).toBeGreaterThan(0);
          expect(detection.hits[rule.id]).toBe(detection.spans.length);
        }
      }
    }
  });

  test('every rule closes a real gap: some example leaks under the unknown-source floor', () => {
    for (const rule of SOURCE_POLICY_RULES) {
      const gaps = rule.examples.filter(
        (example) => leakedFragments(redactDeveloperText(example.text), example.secrets).length > 0
      );
      expect(gaps.length, `${rule.id} must cover a shape the four baselines miss`).toBeGreaterThan(
        0
      );
    }
  });

  test('negative examples stay byte-identical in every listed source and the rule adds no span', () => {
    for (const rule of SOURCE_POLICY_RULES) {
      for (const negative of rule.negativeExamples) {
        expect(redactDeveloperText(negative), `${rule.id}: floor keeps the negative`).toBe(
          negative
        );
        expect(detectSourcePolicySpans(negative, [rule]).spans, rule.id).toEqual([]);
        for (const source of rule.sources) {
          expect(
            redactDeveloperTextInContext(negative, CONTEXT_FOR_SOURCE[source]),
            `${rule.id}@${source}: ${JSON.stringify(negative)}`
          ).toBe(negative);
        }
      }
    }
  });

  test('rules only fire in their listed sources; sources without T3 rules equal the unknown floor', () => {
    for (const source of ['source', 'config', 'no-file', 'unknown'] as const) {
      expect(sourcePolicyRulesFor(source)).toEqual([]);
    }
    expect(sourcePolicyRulesFor('terminal').map((rule) => rule.id)).toEqual(
      SOURCE_POLICY_RULES.filter((rule) => rule.sources.includes('terminal')).map((rule) => rule.id)
    );
    for (const rule of SOURCE_POLICY_RULES) {
      for (const example of rule.examples) {
        const floor = redactDeveloperText(example.text);
        for (const name of NON_T3_CONTEXTS) {
          expect(
            redactDeveloperTextInContext(example.text, CONTEXTS[name]),
            `${rule.id}@${name}`
          ).toBe(floor);
        }
      }
    }
  });

  test('marker literals in sourcePolicy.ts belong to the closed vocabulary (it writes none of its own)', () => {
    const text = readFileSync(
      path.join(repoRoot, 'src/agent/utils/redaction/sourcePolicy.ts'),
      'utf8'
    );
    for (const match of text.matchAll(/\[redacted[^\]'"`\s\\]*\]/g)) {
      expect(REDACTION_MARKERS).toContain(match[0]);
    }
  });
});

describe('source classification reuses the evidence file class table', () => {
  test('terminal entries are terminal whatever their file; files follow the name-first table', () => {
    expect(classifyRedactionSource(undefined)).toBe('unknown');
    expect(classifyRedactionSource({ tool: 'terminal.exec', file: 'src/app.ts' })).toBe('terminal');
    expect(classifyRedactionSource({ tool: 'graph.query' })).toBe('no-file');
    expect(classifyRedactionSource({ tool: 'code.read', file: 'src/app.ts' })).toBe('source');
    expect(classifyRedactionSource({ tool: 'code.read', file: 'config/app.yaml' })).toBe('config');
    expect(classifyRedactionSource({ tool: 'code.read', file: 'deploy/.env' })).toBe(
      'secret-bearing'
    );
    expect(classifyRedactionSource({ tool: 'code.search', file: 'src/secrets.ts' })).toBe(
      'secret-bearing'
    );
  });
});

// 第三行原为 `> Authorization: Token …`：RED-P4b2 的 T1 认证头检测器已在未知来源底线里遮住它（与上下文无关），
// 改用 T1 不覆盖、T3 头规则覆盖的 X-Session-Id（名字带 session）。
const MATRIX_TEXT = [
  'PORT=8080',
  'MY_SERVICE_PASS_HINT=SYNTHETIChint42',
  '> X-Session-Id: SYNTHETICsess1on',
  'machine api.example.com login deploy password SYNTHETICnetrc9',
].join('\n');

describe('source matrix: the same text under every source context', () => {
  test('source, config, no-file and unknown contexts keep the unknown-source floor byte for byte', () => {
    const floor = redactDeveloperText(MATRIX_TEXT);
    // 未知来源底线（四个历史版本与 T1）都漏掉的三处（T3 补的就是这些缺口）在这些来源下保持现状：T3 只在终端与
    // secret-bearing 生效。
    expect(floor).toContain('SYNTHETIChint42');
    expect(floor).toContain('SYNTHETICsess1on');
    expect(floor).toContain('SYNTHETICnetrc9');
    for (const name of NON_T3_CONTEXTS) {
      expect(redactDeveloperTextInContext(MATRIX_TEXT, CONTEXTS[name]), name).toBe(floor);
    }
  });

  test('terminal: sensitive env keys, curl -v auth headers and netrc passwords are masked; PORT stays', () => {
    expect(redactDeveloperTextInContext(MATRIX_TEXT, CONTEXTS.terminal)).toBe(
      [
        'PORT=8080',
        'MY_SERVICE_PASS_HINT=[redacted]',
        '> X-Session-Id: [redacted]',
        'machine api.example.com login deploy password [redacted]',
      ].join('\n')
    );
  });

  test('secret-bearing: every value is masked, keys and the netrc keywords stay', () => {
    expect(redactDeveloperTextInContext(MATRIX_TEXT, CONTEXTS['secret-bearing'])).toBe(
      [
        'PORT=[redacted]',
        'MY_SERVICE_PASS_HINT=[redacted]',
        '> X-Session-Id: [redacted]',
        'machine api.example.com login deploy password [redacted]',
      ].join('\n')
    );
  });

  test('secret-bearing code.search groups keep the NN: proxy prefix and the key', () => {
    const grouped = '3: PORT=8080\n7: DB_HOST=db.internal\n12: api_secret: SYNTHETICsearch77';
    expect(redactDeveloperTextInContext(grouped, CONTEXTS['secret-bearing-search'])).toBe(
      '3: PORT=[redacted]\n7: DB_HOST=[redacted]\n12: api_secret: [redacted]'
    );
  });

  test('the four source classes give nested results: unknown ⊆ terminal, unknown ⊆ secret-bearing', () => {
    for (const name of Object.keys(CONTEXTS)) {
      expect(invariantViolations(MATRIX_TEXT, CONTEXTS[name]), name).toEqual([]);
    }
  });
});

describe('secret-bearing: quoted values left open on their line (RED-P4e2)', () => {
  // 复查发现（上一轮范围外项，本包承诺的覆盖）：YAML 里连续几行 `kN: "vN` 的引号都不闭合时，续行逻辑在下一行
  // 的开引号处闭合，“闭引号”之后的 vN 没有被当作取值，每隔一行的值在输出里仍可见。四个历史版本也都漏，不影响 S，
  // 但违背 T3“secret-bearing 文件每个取值都遮”。
  const openLines = (count: number, indent: string) =>
    Array.from({ length: count }, (_, index) => `${indent}k${index}: "SYNTHETICopen${index}x`);

  test.each([
    ['indented mapping', `root:\n${openLines(6, '  ').join('\n')}\ntail: SYNTHETICfin9`],
    ['top-level keys', openLines(5, '').join('\n')],
    ['CRLF', openLines(4, '  ').join('\r\n')],
    [
      'code.search groups',
      openLines(4, '')
        .map((line, index) => `${index + 3}: ${line}`)
        .join('\n'),
    ],
  ])('%s: every value is masked, newlines and invariants hold', (name, input) => {
    const context =
      name === 'code.search groups'
        ? CONTEXTS['secret-bearing-search']
        : CONTEXTS['secret-bearing'];
    const output = redactDeveloperTextInContext(input, context);
    const secrets = [...input.matchAll(/SYNTHETIC\w+/g)].map((match) => match[0]);
    expect(secrets.length).toBeGreaterThan(3);
    expect(leakedFragments(output, secrets), JSON.stringify(output)).toEqual([]);
    expect(newlineSkeleton(output)).toBe(newlineSkeleton(input));
    expect(invariantViolations(input, context)).toEqual([]);
  });

  test('a genuine multi-line value still closes on its continuation line; trailing structure stays', () => {
    const input = 'CERT="SYNTHETICmultiA\nSYNTHETICmultiB",\nPORT=8080';
    const output = redactDeveloperTextInContext(input, CONTEXTS['secret-bearing']);
    expect(leakedFragments(output, ['SYNTHETICmultiA', 'SYNTHETICmultiB', '8080'])).toEqual([]);
    // 闭引号之后只有结构标点（逗号）：不是取值，原样保留；下一行照常按键值行处理。
    expect(output.split('\n')[1]?.endsWith('",')).toBe(true);
    expect(output.split('\n')[2]).toBe('PORT=[redacted]');
  });

  test('a value that itself holds a keyword and separator is masked whole (T3 spans keep no cascade trigger)', () => {
    // 合并 RED-P4b2 后的口径：T1 检测器不吞底线没遮住的 v0/v1 级联触发前缀（关键字 + 分隔符），T3 区间与 A 的种子
    // 走 sourceDetectors，不按触发前缀切开——secret-bearing 的取值整段遮住，不留 `token:` 一类关键字。
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['GREETING=token: SYNTHETICgreet', 'GREETING=[redacted]'],
      ['NOTE="password: SYNTHETICnote"', 'NOTE="[redacted]"'],
      ['a: secret= SYNTHETICsec', 'a: [redacted]'],
    ];
    for (const [input, expected] of cases) {
      expect(redactDeveloperTextInContext(input, CONTEXTS['secret-bearing']), input).toBe(expected);
      // 未知来源（门面）保留触发前缀、只遮取值：差别只在 T3 多遮的关键字上。
      expect(redactDeveloperText(input)).toMatch(/(?:token|password|secret)[:=] \[redacted\]/);
      expect(invariantViolations(input, CONTEXTS['secret-bearing'])).toEqual([]);
    }
  });

  test('text after the closing quote on a continuation line is a value (masked, re-opens when unclosed)', () => {
    const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['A="SYNTHETICa1\nend" SYNTHETICafter2', ['SYNTHETICa1', 'SYNTHETICafter2']],
      [
        'A="SYNTHETICb1\nend" "SYNTHETICb2\nSYNTHETICb3"\nB=1',
        ['SYNTHETICb1', 'SYNTHETICb2', 'SYNTHETICb3'],
      ],
    ];
    for (const [input, secrets] of cases) {
      const output = redactDeveloperTextInContext(input, CONTEXTS['secret-bearing']);
      expect(leakedFragments(output, secrets), JSON.stringify(output)).toEqual([]);
      expect(invariantViolations(input, CONTEXTS['secret-bearing'])).toEqual([]);
    }
  });
});

describe('report: counts and kinds only, no content', () => {
  test('path distinguishes unknown source, no rules, no span, covered and merged', () => {
    expect(redactDeveloperTextInContextWithReport('PORT=1', undefined).source.path).toBe(
      'unknown-source'
    );
    expect(redactDeveloperTextInContextWithReport('PORT=1', CONTEXTS.source).source.path).toBe(
      'no-source-rules'
    );
    // T3 规则运行了但没有命中：与未知来源逐字相同，不跑第二遍底线。
    const noSpan = redactDeveloperTextInContextWithReport('PORT=1\nok', CONTEXTS.terminal);
    expect(noSpan.source).toMatchObject({ path: 'no-span', ruleHits: {}, sourceChars: 0 });
    expect(noSpan.text).toBe(redactDeveloperText('PORT=1\nok'));
    // 现行底线已遮住值：T3 命中但没有新增遮蔽，输出与未知来源相同。
    const covered = redactDeveloperTextInContextWithReport(
      'GITHUB_TOKEN=SYNTHETICcovered0123',
      CONTEXTS.terminal
    );
    expect(covered.source.path).toBe('covered');
    expect(covered.text).toBe(redactDeveloperText('GITHUB_TOKEN=SYNTHETICcovered0123'));
    expect(covered.source.ruleHits['terminal-env-sensitive-key']).toBe(1);
    const merged = redactDeveloperTextInContextWithReport(
      'MY_SERVICE_PASS_HINT=SYNTHETIChint42',
      CONTEXTS.terminal
    );
    expect(merged.source).toMatchObject({
      sourceClass: 'terminal',
      path: 'merged',
      ruleHits: { 'terminal-env-sensitive-key': 1 },
      sourceChars: 'SYNTHETIChint42'.length,
    });
    expect(merged.report.kinds).toContain('detector-span');
    expect(JSON.stringify(merged.source)).not.toContain('SYNTHETIC');
    expect(JSON.stringify(merged.report)).not.toContain('SYNTHETIC');
  });

  test('re-redacting stored content (seed, freshness recompute) is a no-op on the fast path', () => {
    for (const [name, input] of [
      ['terminal', MATRIX_TEXT],
      ['secret-bearing', MATRIX_TEXT],
      ['secret-bearing', 'CERT="SYNTHETICmultiA\nSYNTHETICmultiB"\n{"a":"b","n":1}'],
    ] as const) {
      const once = redactDeveloperTextInContextWithReport(input, CONTEXTS[name]);
      expect(once.source.path, name).toBe('merged');
      const twice = redactDeveloperTextInContextWithReport(once.text, CONTEXTS[name]);
      expect(twice.text, name).toBe(once.text);
      expect(['covered', 'no-span'], name).toContain(twice.source.path);
      expect(twice.source.sourceChars, name).toBe(0);
    }
  });

  test('no T3 hit on the input but merged later: the production entry agrees with the provenance entry', () => {
    // 性能返工（RED-P4e 第二轮）：T3 在原文上没有命中时，未知来源底线按门面原样跑（不带来源表）；快路径不成立
    // （未知来源没有一轮收敛，或 T3 在它的输出上落到标记之外）时再带来源补跑一遍取种子。生产入口走这条补跑，
    // 带来源入口一开始就带来源表，两者的输出与报告必须逐位相同，A、S、幂等照常成立。
    let reruns = 0;
    for (const input of adversarialInputs(400, 0x5e7a)) {
      const production = redactDeveloperTextInContextWithReport(input, CONTEXTS.terminal);
      if (
        production.source.path !== 'merged' ||
        Object.keys(production.source.ruleHits).length > 0
      ) {
        continue;
      }
      reruns++;
      const traced = redactDeveloperTextInContextWithProvenance(input, CONTEXTS.terminal);
      expect(production.text, input).toBe(traced.text);
      expect(production.report, input).toEqual(traced.report);
      expect(production.source, input).toEqual(traced.source);
      expect(invariantViolations(input, CONTEXTS.terminal), input).toEqual([]);
    }
    expect(reruns).toBeGreaterThan(5);
  });

  test('bounded heuristics report their skips by kind and count only', () => {
    // 未闭合引号在上限行数内找不到闭引号：只遮首行，计入 quote-continuation-limit。
    const stray = `MY_SECRET="SYNTHETICstray\n${'plain line\n'.repeat(70)}tail`;
    const strayResult = redactDeveloperTextInContextWithReport(stray, CONTEXTS.terminal);
    expect(strayResult.source.skips).toEqual({ 'quote-continuation-limit': 1 });
    expect(strayResult.text).not.toContain('SYNTHETICstray');
    // 输出在闭引号之前结束（被截断）：遮到文末，不算跳过。
    const truncated = redactDeveloperTextInContextWithReport(
      'MY_SECRET="SYNTHETICcut1\nSYNTHETICcut2',
      CONTEXTS.terminal
    );
    expect(truncated.source.skips).toEqual({});
    expect(truncated.text).not.toContain('SYNTHETICcut');
    expect(newlineSkeleton(truncated.text)).toBe('\n');
    // 行首前缀超过上限：按行内形态遮到空白（少追加，不放行底线）。
    const longPrefix = `${' '.repeat(300)}MY_TOKEN=SYNTHETIClong tail`;
    const longResult = redactDeveloperTextInContextWithReport(longPrefix, CONTEXTS.terminal);
    expect(longResult.source.skips).toEqual({ 'env-line-prefix-over-limit': 1 });
    expect(longResult.text).toBe(`${' '.repeat(300)}MY_TOKEN=[redacted] tail`);
    // JSON 风格的一行里引号不闭合：该行 JSON 扫描停止，键值形态照常遮。
    const unclosed = redactDeveloperTextInContextWithReport(
      '"region": "eu-west-1", "note": "SYNTHETICopen',
      CONTEXTS['secret-bearing']
    );
    expect(unclosed.source.skips).toEqual({ 'json-line-unclosed-quote': 1 });
    expect(unclosed.text).not.toContain('eu-west-1');
    for (const result of [strayResult, truncated, longResult, unclosed]) {
      expect(JSON.stringify(result.source)).not.toContain('SYNTHETIC');
    }
  });

  test('rule ids in force are listed per source class', () => {
    const report = redactDeveloperTextInContextWithReport('x', CONTEXTS['secret-bearing']).source;
    expect([...report.ruleIds].sort()).toEqual(['netrc-password', 'secret-bearing-every-value']);
  });
});

/** T3 形态的生成器：把各规则的写法与无关行、载体、前缀随机组合（固定种子）。 */
function sourceShapedInputs(count: number, seed: number): string[] {
  const random = seededRandom(seed);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(random() * items.length)];
    if (item === undefined) {
      throw new Error('empty pick');
    }
    return item;
  };
  const secret = () => `SYNTHETIC${Math.floor(random() * 1e6).toString(36)}x`;
  const lines: ReadonlyArray<() => string> = [
    () =>
      `${pick(['', 'export ', '+ export ', 'declare -x '])}${pick(['MY_PASS_HINT', 'SVC_TOKEN_2', 'API_KEY_PRIMARY', 'SESSION_ID', 'PORT', 'HOME', 'DB_PASSWORD'])}=${pick(['', '"', "'"])}${secret()}${pick(['', '"', "'"])}`,
    () =>
      `${pick(['> ', '< '])}${pick(['Authorization', 'Cookie', 'Set-Cookie', 'X-Api-Key', 'Accept'])}: ${pick(['Token ', 'Basic ', 'Bearer ', ''])}${secret()}`,
    () => `machine h${Math.floor(random() * 9)}.example.com login u password ${secret()}`,
    () => `  password ${secret()}`,
    () =>
      `${pick(['data:', 'stringData:', '  data:'])}\n    ${pick(['tls.key', 'password', 'ca.crt'])}: ${secret()}\nkind: Secret`,
    () =>
      `${pick(['key', 'name', '"k"', '- item', '# note', 'region'])}${pick([': ', '=', ' = ', ':='])}${pick(['', '"', "'"])}${secret()}${pick(['', '"', ',', '}'])}`,
    () =>
      `${pick(['password: |', 'cert: >-', 'nested:'])}\n  ${secret()}\n  ${pick(['sub', '- x'])}: ${secret()}`,
    () => `${Math.floor(random() * 99) + 1}: ${pick(['PORT', 'token', 'user'])}=${secret()}`,
    () => `KEY="${secret()}\n${secret()}"`,
    () => `{"a":"${secret()}","port":${Math.floor(random() * 9000)},"list":["${secret()}"]}`,
    () =>
      pick([
        'plain text line',
        'if (token === null) return;',
        'password is required',
        '[redacted] tail',
        '',
      ]),
  ];
  const inputs: string[] = [];
  for (let index = 0; index < count; index++) {
    const parts: string[] = [];
    const lineCount = 1 + Math.floor(random() * 4);
    for (let line = 0; line < lineCount; line++) {
      parts.push(pick(lines)());
    }
    const doc = parts.join(random() < 0.15 ? '\r\n' : '\n');
    const layout = random();
    inputs.push(
      layout < 0.7
        ? doc
        : layout < 0.85
          ? JSON.stringify({ stdout: doc })
          : `${doc}\n\n[evidence] E-1=src/a.ts:1-3`
    );
  }
  return inputs;
}

/**
 * 复查口径的攻击输入（≥ 30 个）：历史回退写法、T3 形态与底线形态同处一行或同一载体、引号与转义、CRLF、代理前缀、
 * 串联与多行值。每个输入在全部上下文下按逐字符 oracle 核对 A 与 S，未知来源另交给 assertNoLegacyRegression。
 */
const ATTACK_INPUTS: readonly string[] = [
  'JWT_SECRET=!SYNTHETICpw',
  'password=Pa(ss)word1SYNTHETIC',
  'DB_PASSWORD=abcSYNTHETIC;xyz123SYNTHETIC',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell 默认值写法本身就是攻击输入，不是模板串。
  'PASSWORD=${DB_PASS:-SYNTHETICdefault}',
  'password=postgres://admin:SYNTHETICpw@db.example.com/SYNTHETICdb',
  `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA${'SYNTHETIC'.repeat(5)}aaaa\npassword: SYNTHETICleak`,
  '{"stdout":"MY_PASS_HINT=SYNTHETICa\\nDB_PASSWORD=!SYNTHETICb"}',
  '> Authorization: Bearer SYNTHETICbearer0123456789',
  '> Cookie: token=SYNTHETICc00kie; a=b',
  'machine h.example.com login u password SYNTHETICnp\npassword=SYNTHETICkv',
  'apiVersion: v1\ndata:\n  password: SYNTHETICk8s==\n  token: "SYNTHETICq"\nkind: Secret',
  'export AWS_SECRET_ACCESS_KEY="SYNTHETICaws/+=="',
  'KEY="SYNTHETICmulti\nline" password: SYNTHETICafter',
  '"Env":["A_TOKEN=SYNTHETICenv1","B=2"]',
  '{"password":"SYNTHETIC\\"q","n":1}',
  'password: |\n  SYNTHETICblock\nkey: v',
  'api_key: [redacted] SYNTHETICtail',
  'SESSION=SYNTHETICs1 && TOKEN=SYNTHETICs2 || PASS=SYNTHETICs3',
  'line1\r\nMY_TOKEN=SYNTHETICcrlf\r\nline3',
  '[evidence] E-1=src/a.ts:1-3\nMY_PWD=SYNTHETICpwd',
  '12: DB_PASSWORD=SYNTHETICsearch\n13: plain',
  '- password: SYNTHETICseq\n- token: SYNTHETICseq2',
  'token := SYNTHETICcolon',
  'x=TOKEN_A=SYNTHETICchain',
  'curl -u user:SYNTHETICcurlpw https://x.example.com',
  '{"a":"\\u0070assword=SYNTHETICescaped"}',
  '{"a":"password=SYNTHETICnested","b":"MY_KEY=SYNTHETICnk"}',
  '> Proxy-Authorization: Basic U1lOVEhFVElDcHJveHk=',
  JSON.stringify({ stdout: 'password="SYNTHETIC head SYNTHETIC_TAIL"', normal: 7 }, null, 2),
  'secret: -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----',
  'ghp_SYNTHETIC0123456789abcdefABCDEF012345 TOKEN=SYNTHETICx',
  'password: Welcome\ntoken: Token',
  'if (token === null) return; PASS_HINT=SYNTHETICif',
  '"MY_TOKEN=SYNTHETIC with space"',
  'aws_session_token = SYNTHETICini',
  'MY_SECRET="[redacted]SYNTHETICglued"',
  // RED-P4e2：引号不闭合的 YAML 行、续行闭引号之后的取值、取值里嵌着关键字与分隔符、T1 不覆盖的认证类头名，
  // 以及它们与 T1 形态（Bearer、前缀 token）同处一段。
  '  k0: "SYNTHETICopen0\n  k1: "SYNTHETICopen1\n  k2: "SYNTHETICopen2\n  k3: "SYNTHETICopen3',
  'A="SYNTHETICa1\nend" SYNTHETICafter2\nB="SYNTHETICb1\nx" "SYNTHETICb2\nSYNTHETICb3"',
  'GREETING=token: SYNTHETICgreet\nNOTE="password: SYNTHETICnote"',
  '> X-Session-Id: SYNTHETICsess1on\n> Authorization: Bearer SYNTHETICbearer0123456789',
  '< Set-Cookie: sid=SYNTHETICsid1; Path=/, lang=SYNTHETICsecond2',
  'k: "ghp_SYNTHETIC0123456789abcdefABCDEF012345\nnext: "SYNTHETICafterghp',
];

describe('attack battery: A and S under every context, facade oracle unchanged', () => {
  test('at least 30 attack inputs', () => {
    expect(ATTACK_INPUTS.length).toBeGreaterThanOrEqual(30);
  });

  test.each(Object.keys(CONTEXTS))('%s', (name) => {
    const failures: string[] = [];
    for (const input of ATTACK_INPUTS) {
      const problems = invariantViolations(input, CONTEXTS[name]);
      if (problems.length > 0) {
        failures.push(`${JSON.stringify(input)}: ${problems.join('; ')}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test('the developer-channel facade still passes the legacy regression oracle', () => {
    for (const input of ATTACK_INPUTS) {
      assertNoLegacyRegression(input);
    }
  });
});

describe('env assignment matcher equals the declared ENV_ASSIGNMENT pattern', () => {
  // 性能返工（RED-P4e 第二轮）：终端 env 规则不再用带后行断言的正则逐位置试探，改由 nextEnvAssignment 逐个 =
  // 向回扫键字符段。两者必须逐个匹配相同（起点、键、继续位置），规则的声明形态仍是 pattern。
  const rule = SOURCE_POLICY_RULES.find((item) => item.id === 'terminal-env-sensitive-key');

  function viaPattern(text: string): Array<[number, string]> {
    if (rule === undefined) {
      throw new Error('missing env rule');
    }
    return [...text.matchAll(rule.pattern)].map((match) => [match.index, match[1] ?? '']);
  }

  function viaScanner(text: string): Array<[number, string]> {
    const out: Array<[number, string]> = [];
    let from = 0;
    for (let match = nextEnvAssignment(text, from); match !== null; ) {
      out.push([match.keyStart, text.slice(match.keyStart, match.equals)]);
      from = match.equals + 1;
      match = nextEnvAssignment(text, from);
    }
    return out;
  }

  test('same matches on attack, shaped, catalog and random inputs', () => {
    const random = seededRandom(0x3e1);
    const alphabet = [
      'a',
      'Z',
      '_',
      '9',
      '.',
      '-',
      '=',
      ' ',
      '\n',
      '\r',
      '\t',
      ';',
      '&',
      '|',
      '(',
      '`',
      "'",
      '"',
      ',',
      '?',
      ':',
      '\\',
      'x',
      '\u2028',
      '\u00a0',
      'TOKEN',
      'é',
    ];
    const randomInputs = Array.from({ length: 4000 }, () =>
      Array.from(
        { length: 1 + Math.floor(random() * 40) },
        () => alphabet[Math.floor(random() * alphabet.length)] ?? ''
      ).join('')
    );
    const inputs = [
      ...ATTACK_INPUTS,
      ...sourceShapedInputs(400, 0x2a),
      ...catalog.catalog.map((item) => item.input),
      ...adversarialInputs(200, 0x77a),
      ...randomInputs,
    ];
    for (const input of inputs) {
      expect(viaScanner(input), JSON.stringify(input)).toEqual(viaPattern(input));
    }
  });

  test('verbose header matcher equals the declared VERBOSE_HTTP_HEADER pattern', () => {
    const header = SOURCE_POLICY_RULES.find(
      (item) => item.id === 'terminal-curl-verbose-auth-header'
    );
    if (header === undefined) {
      throw new Error('missing header rule');
    }
    const random = seededRandom(0x4d2);
    const alphabet = [
      '> ',
      '<',
      '>',
      ' ',
      '\t',
      'Auth',
      'X-Api-Key',
      '_',
      '-',
      ':',
      ': ',
      'v',
      '\n',
      '\r',
      '\r\n',
      '\u2028',
      '\u2029',
      ';',
      '=',
      '9',
    ];
    const randomInputs = Array.from({ length: 4000 }, () =>
      Array.from(
        { length: 1 + Math.floor(random() * 30) },
        () => alphabet[Math.floor(random() * alphabet.length)] ?? ''
      ).join('')
    );
    const inputs = [
      ...ATTACK_INPUTS,
      ...sourceShapedInputs(400, 0x2b),
      ...catalog.catalog.map((item) => item.input),
      ...adversarialInputs(200, 0x77b),
      ...randomInputs,
    ];
    for (const input of inputs) {
      const expected = [...input.matchAll(header.pattern)].map((match) => {
        const end = match.index + match[0].length;
        return [match.index, match[1] ?? '', end - (match[2] ?? '').length, end];
      });
      const actual = verboseHeaderMatches(input).map((match) => [
        match.index,
        match.name,
        match.valueStart,
        match.valueEnd,
      ]);
      expect(actual, JSON.stringify(input)).toEqual(expected);
    }
  });

  test('a start offset inside a key run finds no match for that run (lastIndex semantics)', () => {
    const text = 'ab=1 cd=2';
    expect(nextEnvAssignment(text, 1)).toEqual({ keyStart: 5, equals: 7 });
    expect(nextEnvAssignment(text, 0)).toEqual({ keyStart: 0, equals: 2 });
    expect(nextEnvAssignment('x:k=1', 0)).toBeNull();
    expect(nextEnvAssignment('9k=1', 0)).toBeNull();
  });
});

describe('scanners stay linear on adversarial long inputs', () => {
  // 每条都是平方级回溯或逐匹配回扫会爆炸的形态（约 200K 字符）；线性实现在毫秒级完成，上限给得很宽以容忍负载，
  // 平方级实现在这个规模上要数秒。增长率（4 倍输入）与相对 HEAD 的倍数在 redaction-source-policy-performance
  // 里单线程断言。
  const huge = 200_000;
  const adversarial: ReadonlyArray<readonly [string, string]> = [
    ['spaces without separator', `a${' '.repeat(huge)}b`],
    ['many machine tokens without login', `${'machine h '.repeat(huge / 10)}password`],
    ['many sensitive env pairs on one line', 'X '.concat('TOKEN=v '.repeat(huge / 8))],
    [
      'kubernetes data block with a huge child line',
      `kind: Secret\ndata:\n  k${' '.repeat(huge)}x`,
    ],
    ['long verbose header', `> Authorization:${' '.repeat(huge)}x`],
    ['json line with many strings', `{${'"k":"v",'.repeat(huge / 9)}}`],
    // 复查意见：ENV_ASSIGNMENT 允许 `=`、`,`、`?`、`(` 作键的前导字符，而行内取值不在这些字符处停止；同一行上
    // 首尾相接的敏感 KEY= 曾让每个匹配都扫到行尾、并各产出一个延伸到行尾的重叠区间。
    ['chained sensitive keys', 'A_TOKEN='.repeat(huge / 8)],
    ['comma separated sensitive pairs', 'a_token=x,'.repeat(huge / 10)],
    ['minified member assignments', 'e.key=t,'.repeat(huge / 8)],
    ['query string pairs', '?'.concat('a_token=x&b?c_token=y('.repeat(huge / 22))],
    // 前导引号被反斜杠转义：每个键的“引号内”取值都要越过后面所有转义引号找闭引号。
    ['escaped quote leads', '\\"a_token=x'.repeat(huge / 11)],
    [
      'netrc quoted passwords on one line',
      'machine h login u '.concat('password "x '.repeat(huge / 12)),
    ],
  ];
  test.each(adversarial)('%s', (_name, input) => {
    for (const source of ['terminal', 'secret-bearing'] as const) {
      const started = performance.now();
      const detection = detectSourcePolicySpans(input, sourcePolicyRulesFor(source));
      expect(performance.now() - started, `${source}`).toBeLessThan(1_000);
      // 区间按起点排序、互不相交：下游逐字符消费（底线挂点、标记过滤、新增字符计数）每个位置至多一次。
      let previousEnd = 0;
      let total = 0;
      for (const [start, end] of detection.spans) {
        expect(start, `${source}: sorted and disjoint`).toBeGreaterThanOrEqual(previousEnd);
        expect(end, `${source}: non-empty`).toBeGreaterThan(start);
        previousEnd = end;
        total += end - start;
      }
      expect(total, source).toBeLessThanOrEqual(input.length);
    }
  });

  test('every scanner returns sorted, disjoint spans and per-rule hits count merged spans', () => {
    for (const input of [...ATTACK_INPUTS, ...sourceShapedInputs(300, 0x51)]) {
      for (const source of ['terminal', 'secret-bearing'] as const) {
        const rules = sourcePolicyRulesFor(source);
        const all = detectSourcePolicySpans(input, rules);
        let previousEnd = 0;
        for (const [start, end] of all.spans) {
          expect(start).toBeGreaterThanOrEqual(previousEnd);
          expect(end).toBeGreaterThan(start);
          previousEnd = end;
        }
        // 合并前后遮住的位置集合相同：总体区间是各规则区间的并集。
        const union = new Uint8Array(input.length);
        for (const rule of rules) {
          const single = detectSourcePolicySpans(input, [rule]);
          expect(single.hits[rule.id] ?? 0).toBe(single.spans.length);
          for (const [start, end] of single.spans) {
            union.fill(1, start, end);
          }
        }
        const covered = new Uint8Array(input.length);
        for (const [start, end] of all.spans) {
          covered.fill(1, start, end);
        }
        expect(covered).toEqual(union);
      }
    }
  });
});

describe('first-round replay share (legacyFloor, used by the merged path)', () => {
  const inputs = [
    ...ATTACK_INPUTS,
    ...sourceShapedInputs(150, 0x99),
    ...catalog.catalog.slice(0, 60).map((item) => item.input),
  ];

  test('a shared first round gives byte-identical text, provenance and report', () => {
    for (const input of inputs) {
      const share = createFloorReplayShare(input);
      const reference = applyRedactionFloorWithProvenance(input);
      const unknown = applyRedactionFloorWithProvenance(input, { replayShare: share });
      expect(unknown.text, input).toBe(reference.text);
      expect(unknown.report, input).toEqual(reference.report);
      expect([...unknown.origin], input).toEqual([...reference.origin]);
      // 合并路径的第二遍：同一原文、多了检测器区间，第一轮的版本重放取自共享。
      const detector: FloorDetector = (current) =>
        current === input && input.length > 2 ? [[1, Math.min(input.length, 6)]] : [];
      const second = applyRedactionFloorWithProvenance(input, { detectors: [detector] });
      const reused = share.replays.get('b60a61e');
      // 第二轮复查：第一轮的版本部分（位掩码、缺口、失配行、标记核心、结构分析）整体复用，不再逐版本重新合并。
      const base = share.base;
      expect(base, 'the first pass records the round base').toBeDefined();
      const shared = applyRedactionFloorWithProvenance(input, {
        detectors: [detector],
        replayShare: share,
      });
      expect(share.replays.get('b60a61e'), 'entries are reused, not recomputed').toBe(reused);
      expect(share.base, 'the round base is reused, not recomputed').toBe(base);
      // 检测器区间并入的是复制出的位掩码：再跑一遍没有检测器的共享底线，仍与未知来源参照逐位相同。
      const again = applyRedactionFloorWithProvenance(input, { replayShare: share });
      expect(again.text, input).toBe(reference.text);
      expect(again.report, input).toEqual(reference.report);
      expect(shared.text, input).toBe(second.text);
      expect(shared.report, input).toEqual(second.report);
      expect([...shared.origin], input).toEqual([...second.origin]);
    }
  });

  test('sourceDetectors merge whole spans; default-style detectors keep an unhidden cascade trigger visible', () => {
    // 合并 RED-P4b2：detectors 里的区间不吞底线没遮住的 v0/v1 级联触发前缀（门面层 A 靠下一轮级联）；按来源路径的
    // sourceDetectors（T3 与种子）整段并入（A 靠第一轮直接并入的种子构造性保证）。两者都与底线同轮并入、不串接。
    // 底线（四个版本，不带默认检测器）不改写这段文本：`(` 不是任何版本认的取值。
    const input = 'aa token: (';
    const span: FloorDetector = (current) => (current === input ? [[3, input.length]] : []);
    const viaDetectors = applyRedactionFloor(input, { detectors: [span] });
    const viaSource = applyRedactionFloor(input, { detectors: [], sourceDetectors: [span] });
    expect(applyRedactionFloor(input, { detectors: [] }).text).toBe(input);
    expect(viaDetectors.text).toBe('aa token: [redacted]');
    expect(viaDetectors.report.kinds).toContain('detector-trigger-kept');
    expect(viaSource.text).toBe('aa [redacted]');
    expect(viaSource.report.kinds).not.toContain('detector-trigger-kept');
    expect(viaSource.report.detectorSpans).toBe(1);
    // 只剩底线已遮住的位置时两者都跳过（不增加遮蔽位置），输出与没有检测器时逐字相同。
    const covered = 'password=SYNTHETICcoveredvalue';
    const full: FloorDetector = (current) =>
      current === covered ? [[covered.indexOf('SYNTH'), covered.length]] : [];
    expect(applyRedactionFloor(covered, { detectors: [], sourceDetectors: [full] }).text).toBe(
      applyRedactionFloor(covered, { detectors: [] }).text
    );
  });

  test('the share applies only to its own text and never mixes with a replay override', () => {
    const text = 'password=SYNTHETICshare1';
    const share = createFloorReplayShare(text);
    applyRedactionFloor(text, { replayShare: share });
    // 四个版本各记一条（没有改动文本的版本记为不重放）。
    expect(share.replays.size).toBe(4);
    const other = 'token: SYNTHETICshare2\nsecret=SYNTHETICshare3';
    expect(applyRedactionFloor(other, { replayShare: share })).toEqual(applyRedactionFloor(other));
    // 测试替换重放时既不读也不写共享：替换结果不会混进缓存，缓存也不会遮住替换。
    const fresh = createFloorReplayShare(text);
    const replayOverride = () => null;
    expect(applyRedactionFloor(text, { replayShare: fresh, replayOverride })).toEqual(
      applyRedactionFloor(text, { replayOverride })
    );
    expect(fresh.replays.size).toBe(0);
  });
});

describe('invariant A and S (property, fixed seeds)', () => {
  const corpus = [
    ...catalog.catalog.map((item) => item.input),
    ...catalog.newFindings.map((item) => item.input),
    ...adversarialInputs(400, 0x5e7a),
    ...sourceShapedInputs(1200, 0x4e3),
    MATRIX_TEXT,
  ];

  test.each(
    Object.keys(CONTEXTS)
  )('%s: every non-structural character hidden without context stays hidden; S holds; idempotent', (name) => {
    const failures: string[] = [];
    const paths = new Map<string, number>();
    for (const input of corpus) {
      const problems = invariantViolations(input, CONTEXTS[name]);
      if (problems.length > 0) {
        failures.push(`${JSON.stringify(input)}: ${problems.join('; ')}`);
      }
      const path = redactDeveloperTextInContextWithReport(input, CONTEXTS[name]).source.path;
      paths.set(path, (paths.get(path) ?? 0) + 1);
    }
    expect(failures.slice(0, 10)).toEqual([]);
    if (name === 'terminal' || name.startsWith('secret-bearing')) {
      // 性质不能是空转：带 T3 规则的来源必须大量走到合并路径（种子 + T3 区间重新渲染）与快路径。
      expect(paths.get('merged') ?? 0, JSON.stringify([...paths])).toBeGreaterThan(200);
      expect(
        (paths.get('covered') ?? 0) + (paths.get('no-span') ?? 0),
        JSON.stringify([...paths])
      ).toBeGreaterThan(50);
    }
  }, 120_000);

  test('deterministic: repeated calls with fresh context objects give identical output', () => {
    for (const input of sourceShapedInputs(60, 0x77)) {
      for (const name of Object.keys(CONTEXTS)) {
        const context = CONTEXTS[name];
        const first = redactDeveloperTextInContext(input, context ? { ...context } : undefined);
        const second = redactDeveloperTextInContext(input, context ? { ...context } : undefined);
        expect(second).toBe(first);
      }
    }
  });
});
