/**
 * 脱敏阶段 4a：追踪重放底线（设计 redaction-design-2026-10-19 第 4.3 节、第 6 节阶段 4 测试要求 6）。
 *
 * - 等价：运行时的分段重放（src/agent/utils/redaction/trackedReplay.ts）与测试目录里逐字符来源的独立实现
 *   （test/fixtures/redaction-catalog/trackedReplay.ts）在全部语料与矩阵上给出相同的被遮位置，自检失配为 0。
 * - 自检失败即关：重放文本与冻结原版输出不同、或重放内部不一致时，受影响的行整行替换为 [redacted-unaligned]
 *   并计入 FloorReport；换行数对不上时退回每个非空行。
 * - 结构位置（D3 阶段 4 子项）：裸换行、可解析 JSON 字面量内解码后是换行的转义序列（按载体递归）；裸文本里的
 *   字面 \n 两个字符不是结构。该口径同时约束测试期的对齐 oracle，复查记录里的 GITHUB_TOKEN 载体家族不再报
 *   superset misses。
 * - 缺口：每个版本的合成文本与它遮住的输入区间；分段来源表的解码/编码往返。
 * 样本全部是合成值。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { redactDeveloperTextWithReport } from '../src/agent/utils/Redaction.js';
import { hiddenSuperset } from '../src/agent/utils/redaction/hiddenSpans.js';
import {
  applyRedactionFloor,
  type FloorDetector,
  UNALIGNED_MARKER,
} from '../src/agent/utils/redaction/legacyFloor.js';
import {
  BASELINE_REVISIONS,
  type BaselineRevision,
  decodeLiteral,
  encodeLiteral,
  exactHidden,
  frozenRedact,
  gapsFromTracked,
  originTracked,
  type ReplayResult,
  replayTracked,
  structurePositions,
  type Tracked,
} from '../src/agent/utils/redaction/trackedReplay.js';
import {
  adversarialInputs,
  carrierSandwiches,
  GRID_CONTEXTS,
  grammarGridFor,
  uniqueCharGrid,
} from './fixtures/redaction-catalog/fuzzCorpus.js';
import {
  assertNoLegacyRegression,
  checkNoLegacyRegression,
  exemptPositions,
} from './fixtures/redaction-catalog/legacyRegressionOracle.js';
import { exactHidden as fixtureExactHidden } from './fixtures/redaction-catalog/trackedReplay.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface CatalogEntry {
  id: string;
  input: string;
}

const catalog = JSON.parse(
  readFileSync(path.join(repoRoot, 'test/fixtures/redaction-catalog/catalog.json'), 'utf8')
) as { catalog: CatalogEntry[]; newFindings: CatalogEntry[] };

function inCarrier(input: string): string {
  return JSON.stringify({ stdout: input });
}

const catalogInputs = [...catalog.catalog, ...catalog.newFindings].flatMap((entry) => [
  entry.input,
  inCarrier(entry.input),
]);

function sameMarks(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/** 对一批输入检查四个版本：自检必须通过，分段重放与逐字符重放的被遮位置必须相同。返回失配描述。 */
function replayMismatches(inputs: readonly string[]): string[] {
  const problems: string[] = [];
  for (const input of inputs) {
    for (const revision of BASELINE_REVISIONS) {
      const result = replayTracked(revision, originTracked(input));
      if (!result.verified || result.tracked === null) {
        problems.push(`${revision} self-check ${result.failure} on ${JSON.stringify(input)}`);
        continue;
      }
      const runtime = exactHidden(revision, input);
      if (runtime === null || !sameMarks(runtime, fixtureExactHidden(revision, input))) {
        problems.push(`${revision} hidden set differs on ${JSON.stringify(input)}`);
      }
    }
  }
  return problems;
}

let equivalenceChecks = 0;

describe('tracked replay equivalence (requirement 6): zero mismatch on every corpus', () => {
  test('failure catalog and new findings, raw and carrier forms', () => {
    equivalenceChecks += catalogInputs.length * 4;
    expect(replayMismatches(catalogInputs).slice(0, 10)).toEqual([]);
  });

  test.each(
    GRID_CONTEXTS.map((context, index) => ({ name: context.name, index }))
  )('grammar grid context $name', ({ index }) => {
    const inputs = grammarGridFor(index).map((entry) => entry.input);
    equivalenceChecks += inputs.length * 4;
    expect(replayMismatches(inputs).slice(0, 10)).toEqual([]);
  }, 120_000);

  test('adversarial fuzz (fixed seed) and the unique-character grid', () => {
    const inputs = [
      ...adversarialInputs(6_000, 20261019),
      ...uniqueCharGrid()
        .filter((_, index) => index % 4 === 0)
        .map((entry) => entry.input),
    ];
    equivalenceChecks += inputs.length * 4;
    expect(replayMismatches(inputs).slice(0, 10)).toEqual([]);
  }, 120_000);

  test('carrier sandwiches', () => {
    const inputs = carrierSandwiches().map((entry) => entry.input);
    equivalenceChecks += inputs.length * 4;
    expect(replayMismatches(inputs).slice(0, 10)).toEqual([]);
  }, 120_000);

  test('the rendered outputs replay without mismatch too (fixed point inputs)', () => {
    const inputs = [...catalogInputs, ...adversarialInputs(1_000, 7)].map(
      (input) => redactDeveloperTextWithReport(input).text
    );
    equivalenceChecks += inputs.length * 4;
    expect(replayMismatches(inputs).slice(0, 10)).toEqual([]);
  }, 120_000);

  test('covered well over 100,000 version checks', () => {
    expect(equivalenceChecks).toBeGreaterThan(100_000);
  });

  test('every production call reports zero self-check failures on the corpus', () => {
    for (const input of catalogInputs) {
      const { report } = redactDeveloperTextWithReport(input);
      expect(report.replayMismatches).toBe(0);
      expect(report.replayMismatchLines).toBe(0);
      expect(report.impureSynths).toBe(0);
    }
  });
});

describe('runtime self-check: fail closed when the replay diverges from the frozen output', () => {
  const input = 'line one\npassword=SYNTHETICpw\nordinary: kept\ntoken=SYNTHETICtok';

  test('a replay whose text differs on one line masks that line and every line the frozen version changed', () => {
    const replayOverride = (
      revision: BaselineRevision,
      source: Parameters<typeof replayTracked>[1],
      frozen: string
    ): ReplayResult | null => {
      if (revision !== 'd113986') {
        return null;
      }
      // 伪造的重放：第二行原样保留（与冻结输出不同），其余行与冻结输出相同。
      const lines = frozen.split('\n');
      lines[1] = source.text.split('\n')[1] ?? '';
      const lying = originTracked(lines.join('\n'));
      return { revision, frozen, tracked: lying, verified: false, failure: 'divergence' };
    };
    const { text, report } = applyRedactionFloor(input, { replayOverride });
    const lines = text.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('line one');
    expect(lines[1]).toBe(UNALIGNED_MARKER);
    expect(lines[2]).toBe('ordinary: kept');
    // 第四行的重放文本与冻结输出相同，但冻结的 d113986 改动过这一行；重放一旦失配，它的位置整体不可信，
    // 这一行同样失败即关（复查意见 4），而不是只信任其他版本的位置正常渲染。
    expect(lines[3]).toBe(UNALIGNED_MARKER);
    expect(report.replayMismatches).toBe(1);
    expect(report.replayMismatchLines).toBe(2);
    expect(report.kinds).toContain('replay-mismatch');
    expect(text).not.toContain('SYNTHETIC');
  });

  test('a diverging replay also masks every line the frozen version changed (its positions are untrusted)', () => {
    // 伪造的重放：文本只在第四行与冻结输出不同，但来源表声称全部可见。重放一旦失配，它给出的位置整体不可信，
    // 所以除了文本不同的行，冻结版本改动过（输入 vs 冻结输出不同）的第二行也必须失败即关。
    const replayOverride = (
      revision: BaselineRevision,
      source: Parameters<typeof replayTracked>[1],
      frozen: string
    ): ReplayResult | null => {
      if (revision !== 'd113986') {
        return null;
      }
      const lines = frozen.split('\n');
      lines[3] = source.text.split('\n')[3] ?? '';
      const lying = originTracked(lines.join('\n'));
      return { revision, frozen, tracked: lying, verified: false, failure: 'divergence' };
    };
    const { text, report } = applyRedactionFloor(input, { replayOverride });
    const lines = text.split('\n');
    expect(lines).toEqual(['line one', UNALIGNED_MARKER, 'ordinary: kept', UNALIGNED_MARKER]);
    expect(report.replayMismatches).toBe(1);
    expect(report.replayMismatchLines).toBe(2);
    expect(text).not.toContain('SYNTHETIC');
  });

  test('a verified replay whose rendering breaks newline conservation falls back to the input skeleton', () => {
    // 构造一个“通过自检”却在合成文本里多写一个裸换行的重放：渲染结果的换行数与输入不同，无法按行定位，
    // 整篇退回输入的换行骨架（每个非空行 [redacted-unaligned]），并计入 FloorReport。
    const source = 'password=SYNTHETICpw\nkept: yes';
    const replayOverride = (revision: BaselineRevision): ReplayResult | null => {
      if (revision !== 'b60a61e') {
        return null;
      }
      const text = 'password=[redacted]\n\nkept: yes';
      const tracked: Tracked = {
        text,
        segments: [
          { out: 0, len: 9, src: 0, srcEnd: 9, range: false },
          { out: 9, len: 11, src: -1, srcEnd: -1, range: false },
          { out: 20, len: 10, src: 20, srcEnd: 30, range: false },
        ],
      };
      return { revision, frozen: text, tracked, verified: true, failure: null };
    };
    const { text, report } = applyRedactionFloor(source, { replayOverride });
    expect(text).toBe(`${UNALIGNED_MARKER}\n${UNALIGNED_MARKER}`);
    expect(report.renderSkeletons).toBe(1);
    expect(report.kinds).toContain('render-skeleton');
    expect(text).not.toContain('SYNTHETIC');
  });

  test('an internal replay failure masks every line the frozen version changed', () => {
    const replayOverride = (
      revision: BaselineRevision,
      _source: Parameters<typeof replayTracked>[1],
      frozen: string
    ): ReplayResult | null =>
      revision === 'b60a61e'
        ? { revision, frozen, tracked: null, verified: false, failure: 'internal' }
        : null;
    const { text, report } = applyRedactionFloor(input, { replayOverride });
    const lines = text.split('\n');
    expect(lines[1]).toBe(UNALIGNED_MARKER);
    expect(lines[3]).toBe(UNALIGNED_MARKER);
    expect(lines[0]).toBe('line one');
    expect(lines[2]).toBe('ordinary: kept');
    expect(report.replayMismatches).toBe(1);
    expect(report.replayMismatchLines).toBe(2);
  });

  test('a replay that breaks newline conservation falls back to masking every non-empty line', () => {
    const replayOverride = (
      revision: BaselineRevision,
      source: Parameters<typeof replayTracked>[1],
      frozen: string
    ): ReplayResult | null => {
      if (revision !== '246055e') {
        return null;
      }
      const lying = originTracked(`${source.text}\n`);
      return { revision, frozen, tracked: lying, verified: false, failure: 'divergence' };
    };
    const { text, report } = applyRedactionFloor('a\n\npassword=SYNTHETICpw', { replayOverride });
    expect(text).toBe(`${UNALIGNED_MARKER}\n\n${UNALIGNED_MARKER}`);
    expect(report.kinds).toContain('replay-skeleton');
  });

  test('replayTracked itself reports divergence instead of throwing', () => {
    const result = replayTracked(
      'b60a61e',
      originTracked('password=SYNTHETICpw'),
      'not the frozen output'
    );
    expect(result.verified).toBe(false);
    expect(result.failure).toBe('divergence');
    expect(result.tracked?.text).toBe('password=[redacted]');
    expect(exactHidden('b60a61e', 'password=SYNTHETICpw')).not.toBeNull();
  });

  test('the report never carries text', () => {
    const { report } = redactDeveloperTextWithReport(input);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/SYNTHETIC|password|token|ordinary/);
    for (const value of Object.values(report)) {
      expect(['number', 'boolean', 'object']).toContain(typeof value);
    }
  });
});

describe('structure positions (D3 and its stage-4 sub-item)', () => {
  test('bare newlines are structure; raw backslash-n in plain text is content', () => {
    const marks = structurePositions('a\nb\r\nc\\nd');
    expect([...marks]).toEqual([0, 1, 0, 1, 1, 0, 0, 0, 0]);
  });

  test('escaped newlines inside a parsable JSON literal are structure, including \\u000a', () => {
    const input = '{"s":"a\\nb\\u000ac\\rd"}';
    const marks = structurePositions(input);
    const marked = [...marks].map((flag, index) => (flag === 1 ? input[index] : null)).join('');
    expect(marked).toBe('\\n\\u000a\\r');
  });

  test('deeper carriers are followed recursively, unparsable literals are not', () => {
    const nested = JSON.stringify({ m: JSON.stringify({ stdout: 'a\nb' }) });
    const marks = structurePositions(nested);
    const inner = nested.indexOf('\\\\n');
    expect(inner).toBeGreaterThan(0);
    expect([...marks.slice(inner, inner + 3)]).toEqual([1, 1, 1]);
    // 未闭合的字面量不可解析：其中的 \n 不是结构。
    expect([...structurePositions('"a\\nb')]).toEqual([0, 0, 0, 0, 0]);
  });

  test('the runtime structure criterion matches an independent reference on every corpus', () => {
    // 独立参照（不复用运行时的分段来源表）：按“可解析 JSON 字面量内解码后是换行的转义序列”逐层展开。
    // 复查意见 5：原来的用例（结构位置 ⊆ 豁免位置）在 exemptPositions 以 structurePositions 起步后恒真。
    let structurePositionsSeen = 0;
    for (const input of [...catalogInputs, ...adversarialInputs(500, 3)]) {
      const structure = structurePositions(input);
      const reference = referenceStructure(input);
      expect([...structure], JSON.stringify(input)).toEqual([...reference]);
      for (let index = 0; index < input.length; index++) {
        if (structure[index] === 1) {
          structurePositionsSeen++;
          // 结构位置只会落在换行、反斜杠、转义字母与 \u 的十六进制上，从不落在值字符上。
          expect(/[\n\r\\nru0-9a-fA-F]/.test(input[index] ?? ''), `${index}`).toBe(true);
        }
      }
    }
    expect(structurePositionsSeen).toBeGreaterThan(1_000);
  });
});

/** 每个字符在顶层输入里的来源区间 [start, end)。 */
type SourceMap = Array<[number, number]>;

const REFERENCE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/**
 * 结构位置的独立参照实现：裸换行，以及可解析 JSON 字符串字面量（按载体递归，最多 8 层）内解码后是换行的
 * 转义序列在顶层输入里占据的位置。逐字符维护来源区间，不使用运行时的 Tracked 分段表。
 */
function referenceStructure(x: string): Uint8Array {
  const marks = new Uint8Array(x.length);
  const walk = (text: string, map: SourceMap, depth: number): void => {
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char === '\n' || char === '\r') {
        const [start, end] = map[index] ?? [0, 0];
        marks.fill(1, start, end);
      }
    }
    if (depth >= 8) {
      return;
    }
    const literal = /"(?:\\[\s\S]|[^"\\])*"/g;
    for (let match = literal.exec(text); match !== null; match = literal.exec(text)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(match[0]);
      } catch (err: unknown) {
        void err;
        continue;
      }
      if (typeof parsed !== 'string') {
        continue;
      }
      const inner: string[] = [];
      const innerMap: SourceMap = [];
      const end = match.index + match[0].length - 1;
      let cursor = match.index + 1;
      while (cursor < end) {
        if (text[cursor] !== '\\') {
          inner.push(text[cursor] ?? '');
          innerMap.push(map[cursor] ?? [0, 0]);
          cursor++;
          continue;
        }
        const escapeChar = text[cursor + 1] ?? '';
        const length = escapeChar === 'u' ? 6 : 2;
        inner.push(
          escapeChar === 'u'
            ? String.fromCharCode(Number.parseInt(text.slice(cursor + 2, cursor + 6), 16))
            : (REFERENCE_ESCAPES[escapeChar] ?? escapeChar)
        );
        const ranges = map.slice(cursor, cursor + length);
        innerMap.push([
          Math.min(...ranges.map((range) => range[0])),
          Math.max(...ranges.map((range) => range[1])),
        ]);
        cursor += length;
      }
      expect(inner.join('')).toBe(parsed);
      walk(inner.join(''), innerMap, depth + 1);
    }
  };
  walk(
    x,
    Array.from({ length: x.length }, (_, index): [number, number] => [index, index + 1]),
    0
  );
  return marks;
}

describe('alignment oracle agrees with the replay under the unified newline criterion', () => {
  // d0462bf 复查记录的复现家族：含 GITHUB_TOKEN:\n\" 的 JSON 载体，阶段 1 的超集会漏掉转义换行（R-Q 修剪与
  // D3 严格口径互斥）。阶段 4 把可解析字面量里的转义换行统一视为结构，对齐 oracle 不再报 superset misses。
  const keys = ['GITHUB_TOKEN', 'token', 'password', 'api_key'];
  const separators = [':', ':\n', ': ', '=\n', '=', ': \n'];
  const values = [
    '"SYNTHETICabc\n"other"',
    '"SYNTHETICabc\n',
    '"SYN\nTHETIC"',
    '"\nSYNTHETIC"',
    '"SYNTHETICabc\\n"',
    "'SYNTHETICabc'\nnext",
  ];
  const wraps = [
    (body: string) => JSON.stringify({ stdout: body }),
    (body: string) => JSON.stringify([body]),
    (body: string) => JSON.stringify({ message: JSON.stringify({ stdout: body }) }),
    (body: string) => body,
  ];
  const family: string[] = [];
  for (const key of keys) {
    for (const separator of separators) {
      for (const value of values) {
        for (const wrap of wraps) {
          family.push(wrap(`${key}${separator}${value}`));
        }
      }
    }
  }

  test('the review-record family passes the attack fixture with zero aligner violations', () => {
    const problems: string[] = [];
    for (const input of family) {
      const report = checkNoLegacyRegression(input);
      problems.push(
        ...report.exposures.map((exposure) => `${exposure.oracle} ${exposure.baseline}`),
        ...report.alignerViolations,
        ...report.structuralViolations
      );
    }
    expect(family.length).toBeGreaterThan(500);
    expect(problems.slice(0, 10)).toEqual([]);
  });

  test('the exact review-record input renders without a mismatch and keeps its line structure', () => {
    const input = '{"stdout":"GITHUB_TOKEN:\\"SYNTHETICabc\\n\\"other\\""}';
    const { text, report } = redactDeveloperTextWithReport(input);
    expect(text).toBe('{"stdout":"GITHUB_TOKEN:\\"[redacted]\\n\\"other\\""}');
    expect(report.replayMismatches).toBe(0);
    expect(JSON.parse(text)).toEqual({ stdout: 'GITHUB_TOKEN:"[redacted]\n"other"' });
    assertNoLegacyRegression(input);
  });

  test('the superset of each early version still contains every non-structure hidden position', () => {
    let checked = 0;
    for (const input of family) {
      const structure = structurePositions(input);
      for (const revision of ['246055e', '1b394ce', 'd113986'] as const) {
        const truth = exactHidden(revision, input);
        expect(truth).not.toBeNull();
        if (truth === null) {
          continue;
        }
        const superset = hiddenSuperset(input, frozenRedact(revision, input), {
          reencodes: revision === 'd113986',
        }).marks;
        const exempt = exemptPositions(input);
        for (let index = 0; index < input.length; index++) {
          if (truth[index] === 1 && exempt[index] === 0 && structure[index] === 0) {
            checked++;
            expect(superset[index], `${revision} @${index}`).toBe(1);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1_000);
  });
});

describe('gaps and the segment-based provenance', () => {
  test('a quoted assignment yields one gap carrying the historical synthetic text', () => {
    const input = 'password="SYNTHETICpw"';
    const result = replayTracked('b60a61e', originTracked(input));
    expect(result.verified).toBe(true);
    const gaps = gapsFromTracked(result.tracked ?? originTracked(''), input.length);
    expect(gaps).toEqual([{ start: 10, end: input.length, synth: '[redacted]"' }]);
  });

  test('a JSON number value yields a gap whose synthetic text synthesises the quotes', () => {
    const input = '{"password": 123456789, "normal": 7}';
    const result = replayTracked('d113986', originTracked(input));
    const gaps = gapsFromTracked(result.tracked ?? originTracked(''), input.length);
    expect(gaps).toEqual([{ start: 13, end: 22, synth: '"[redacted]"' }]);
  });

  test('decode and encode round-trip a literal while keeping provenance per escape sequence', () => {
    const literal = '"a\\u0041\\/\\n\\"\\\\z"';
    const decoded = decodeLiteral(originTracked(literal), 0, literal.length);
    expect(decoded.text).toBe(JSON.parse(literal));
    const encoded = encodeLiteral(decoded);
    expect(encoded.text).toBe(JSON.stringify(decoded.text));
    // 解码出的 A 来自 A 六个字符；重新编码后 A 仍指向同一段来源，所以这些输入位置都算可见。
    const visible = new Uint8Array(literal.length);
    for (const segment of encoded.segments) {
      if (segment.src >= 0) {
        visible.fill(1, segment.src, segment.range ? segment.srcEnd : segment.src + segment.len);
      }
    }
    for (let index = 1; index < literal.length - 1; index++) {
      expect(visible[index], `position ${index}`).toBe(1);
    }
  });

  test('a lone surrogate and control characters encode like JSON.stringify', () => {
    const value = 'x\ud800y\u0001\b\f\t';
    const encoded = encodeLiteral(originTracked(value));
    expect(encoded.text).toBe(JSON.stringify(value));
  });

  test('exactHidden is deterministic and marks only what the frozen output removed', () => {
    const input = 'export API_TOKEN=|SYNTHETICpipe9 and nothing else';
    const first = exactHidden('d113986', input);
    const second = exactHidden('d113986', input);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (first === null || second === null) {
      return;
    }
    expect(sameMarks(first, second)).toBe(true);
    const hiddenText = [...first].map((flag, index) => (flag === 1 ? input[index] : '')).join('');
    expect(hiddenText).toBe('|SYNTHETICpipe9');
  });
});

describe('detector hook (reserved for 4b–4e): spans are unioned on the original text, never chained', () => {
  test('a detector span is masked together with the floor and reported as detector chars', () => {
    const detector: FloorDetector = (text) => {
      const at = text.indexOf('SYNTHETIChigh');
      return at < 0 ? [] : [[at, at + 'SYNTHETIChigh'.length]];
    };
    const input = 'note SYNTHETIChigh and password=SYNTHETICpw';
    const { text, report } = applyRedactionFloor(input, { detectors: [detector] });
    expect(text).toBe('note [redacted] and password=[redacted]');
    expect(report.detectorChars).toBe('SYNTHETIChigh'.length);
    expect(report.kinds).toContain('detector-span');
    // 检测器只会多遮：没有检测器时的输出里被遮的字符，有检测器时仍被遮。
    const plain = applyRedactionFloor(input).text;
    expect(plain).toBe('note SYNTHETIChigh and password=[redacted]');
  });

  test('without detectors the default facade and the floor agree', () => {
    for (const input of catalogInputs.slice(0, 50)) {
      expect(applyRedactionFloor(input).text).toBe(redactDeveloperTextWithReport(input).text);
    }
  });
});
