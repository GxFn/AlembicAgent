/**
 * 脱敏阶段 4a：按位置渲染（设计 redaction-design-2026-10-19 第 4.6 节、D3 阶段 4 子项、要求 9）。
 *
 * - 原子标记：输入里原有的完整标记视为原子，被遮区间触到就扩到整个标记；只由标记（与结构、引号）组成的区间
 *   原样输出。
 * - 换行：被遮区间内的裸换行按原顺序重新输出，行数守恒；可解析 JSON 字面量内被遮区间里的转义换行放回
 *   （M-12 的行数漂移），只暴露换行个数。
 * - 历史替换文本只有完全由标记、引号、换行组成时才沿用（JSON 数值位置的 "[redacted]"、PEM 的
 *   [redacted-private-key]、Bearer 的 [redacted-token]）；其他情况写新标记 [redacted]，保留区间首尾的分隔引号。
 * - 不做等长占位；标记文字不变；幂等、确定性。
 * - 要求 9：lib/secret_key.rb:10-14 一类标注与 code.search 的 NN: 前缀，本包不劣化（与阶段 1 相同）。
 * 样本全部是合成值。
 */
import { describe, expect, test } from 'vitest';
import {
  redactDeveloperText,
  redactDeveloperTextWithReport,
} from '../src/agent/utils/Redaction.js';
import { REDACTION_MARKERS } from '../src/agent/utils/redaction/hiddenSpans.js';
import {
  applyAlignmentFloor,
  applyRedactionFloorWithProvenance,
} from '../src/agent/utils/redaction/legacyFloor.js';
import {
  analyzeSynth,
  expandAtomicMarkers,
  expandEscapedQuotes,
  type GapSet,
  markerCores,
  renderByPositions,
} from '../src/agent/utils/redaction/render.js';
import {
  analyzeStructure,
  structurePositions,
} from '../src/agent/utils/redaction/trackedReplay.js';
import { redactDeveloperText as fixtureAtB60a61e } from './fixtures/redaction-baselines/redaction-at-b60a61e.js';
import {
  assertNoLegacyRegression,
  exemptPositions,
} from './fixtures/redaction-catalog/legacyRegressionOracle.js';
import {
  BASELINE_REVISIONS,
  exactHidden as fixtureExactHidden,
} from './fixtures/redaction-catalog/trackedReplay.js';

function newlineSkeleton(text: string): string {
  return text.replace(/[^\r\n]/g, '');
}

/**
 * 严格口径的露出（RED-P4a2 第 3 项）：只豁免结构位置（裸换行、JSON 载体字面量里的转义换行）与输入原有的
 * 标记，引号与反斜杠一律按内容判定。被某个基线精确遮住、却在新输出里以原样出现的位置都报出来。
 */
function strictExposures(input: string): string[] {
  const { origin } = applyRedactionFloorWithProvenance(input);
  const visible = new Uint8Array(input.length);
  for (const from of origin) {
    if (from >= 0) {
      visible[from] = 1;
    }
  }
  const structure = structurePositions(input);
  const inCore = new Uint8Array(input.length);
  for (const [start, end] of markerCores(input)) {
    inCore.fill(1, start, end);
  }
  const exposures: string[] = [];
  for (const revision of BASELINE_REVISIONS) {
    const hidden = fixtureExactHidden(revision, input);
    for (let index = 0; index < input.length; index++) {
      if (
        hidden[index] === 1 &&
        visible[index] === 1 &&
        structure[index] !== 1 &&
        inCore[index] !== 1
      ) {
        exposures.push(`${revision}@${index}:${JSON.stringify(input[index])}`);
      }
    }
  }
  return exposures;
}

function hiddenFor(x: string, ranges: Array<[number, number]>): Uint8Array {
  const hidden = new Uint8Array(x.length);
  for (const [start, end] of ranges) {
    hidden.fill(1, start, end);
  }
  return hidden;
}

describe('atomic markers', () => {
  test.each([
    ['token: [redacted]', 'token: [redacted]'],
    ['password=[redacted]', 'password=[redacted]'],
    ['"password":"[redacted]"', '"password":"[redacted]"'],
    ['Authorization: Bearer [redacted-token]', 'Authorization: Bearer [redacted-token]'],
    [
      '-----BEGIN PRIVATE KEY-----\n[redacted-private-key]\n-----END PRIVATE KEY-----',
      '-----BEGIN PRIVATE KEY-----\n[redacted-private-key]\n-----END PRIVATE KEY-----',
    ],
  ])('a run made only of markers is output verbatim: %j', (input, expected) => {
    expect(redactDeveloperText(input)).toBe(expected);
  });

  test.each([
    ['password=[redacted]SYNTHETICtail', 'password=[redacted]'],
    ['password=SYNTHETIChead[redacted]', 'password=[redacted]'],
    ['password=[redacted-private-key]SYNTHETIC', 'password=[redacted]'],
  ])('a run touching a marker absorbs the whole marker and masks the content: %j', (input, expected) => {
    const output = redactDeveloperText(input);
    expect(output).toBe(expected);
    expect(output).not.toContain('SYNTHETIC');
    expect(redactDeveloperText(output)).toBe(output);
    assertNoLegacyRegression(input);
  });

  test('expandAtomicMarkers only grows the hidden set', () => {
    const x = 'ab[redacted]cd';
    const hidden = hiddenFor(x, [[3, 4]]);
    expandAtomicMarkers(hidden, markerCores(x));
    expect([...hidden]).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
    const untouched = hiddenFor(x, [[0, 2]]);
    expandAtomicMarkers(untouched, markerCores(x));
    expect([...untouched]).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('markerCores recognises only the closed vocabulary', () => {
    expect(markerCores('[redacted] [redacted-x] [REDACTED] [redacted-token]x')).toEqual([
      [0, 10],
      [35, 51],
    ]);
  });
});

describe('newlines inside masked spans', () => {
  test('a bare newline inside a quoted value is re-emitted where the current rules put it', () => {
    const input = 'password="SYNTHETIC first\nSYNTHETIC last"\nordinary: kept';
    const output = redactDeveloperText(input);
    expect(output).toBe('password="[redacted]\n"\nordinary: kept');
    expect(newlineSkeleton(output)).toBe(newlineSkeleton(input));
  });

  test('CRLF, lone CR and blank lines keep their exact positions', () => {
    for (const input of [
      'a\r\npassword="SYNTHETIC one\r\nSYNTHETIC two"\r\n\r\nb',
      'x\rJWT_SECRET=!SYNTHETICcr\ry',
      '\n\n"password": "SYNTHETIC first\nSYNTHETIC last"\n\n',
    ]) {
      const output = redactDeveloperText(input);
      expect(newlineSkeleton(output)).toBe(newlineSkeleton(input));
      expect(output).not.toContain('SYNTHETIC');
      expect(redactDeveloperText(output)).toBe(output);
    }
  });

  test('a PEM block in a YAML literal keeps its indentation and line count exactly like HEAD', () => {
    const input = [
      'database:',
      '  private_key: |',
      '    -----BEGIN EC PRIVATE KEY-----',
      '    MHcCAQEEIBSYNTHETIConeLINE',
      '    SYNTHETICtwoLINE',
      '    -----END EC PRIVATE KEY-----',
      '  host: db',
    ].join('\n');
    expect(redactDeveloperText(input)).toBe(fixtureAtB60a61e(input));
    expect(redactDeveloperText(input)).toContain('[redacted-private-key]');
  });

  test('an unterminated value starting with a newline keeps the newline', () => {
    const input = 'password="\nSYNTHETICtail';
    const output = redactDeveloperText(input);
    expect(output).not.toContain('SYNTHETIC');
    expect(newlineSkeleton(output)).toBe('\n');
    expect(redactDeveloperText(output)).toBe(output);
  });
});

describe('D3 stage-4 sub-item: escaped newlines inside parsable JSON literals are put back', () => {
  test('a JSON string value swallowed whole keeps its line count after decoding (M-12)', () => {
    const input = '{"password":"SYNTHETIC line1\\nSYNTHETIC line2\\nSYNTHETIC line3"}';
    const { text, report } = redactDeveloperTextWithReport(input);
    expect(text).toBe('{"password":"[redacted]\\n\\n"}');
    expect((JSON.parse(text) as { password: string }).password.split('\n')).toHaveLength(3);
    expect(report.restoredTokens).toBe(2);
    expect(report.kinds).toContain('newline-restored');
    // HEAD 吞掉了转义换行：解码后的行数从 3 变成 1。
    expect((JSON.parse(fixtureAtB60a61e(input)) as { password: string }).password).toBe(
      '[redacted]'
    );
    assertNoLegacyRegression(input);
  });

  test('a second-level carrier restores the deeper escape sequence', () => {
    const input = JSON.stringify({ m: JSON.stringify({ password: 'SYNTHETIC a\nSYNTHETIC b' }) });
    const text = redactDeveloperText(input);
    const inner = JSON.parse((JSON.parse(text) as { m: string }).m) as { password: string };
    expect(inner.password).toBe('[redacted]\n');
    expect(text).not.toContain('SYNTHETIC');
    assertNoLegacyRegression(input);
  });

  test('a quoted value with a real newline inside a carrier matches HEAD exactly (no token missing)', () => {
    const input = JSON.stringify({
      stdout: 'password="SYNTHETIC first\nSYNTHETIC last"\nordinary: kept',
    });
    expect(redactDeveloperText(input)).toBe(fixtureAtB60a61e(input));
  });

  test('raw backslash-n outside any parsable JSON literal is content and stays masked', () => {
    // 单引号值不是 JSON 字面量，其中的 \n 两个字符按内容处理。
    const input = "password='SYNTHETICa\\nSYNTHETICb'";
    const output = redactDeveloperText(input);
    expect(output).toBe("password='[redacted]'");
    assertNoLegacyRegression(input);
  });

  test('a double-quoted value in plain text is not a JSON carrier, so its escaped newline stays masked', () => {
    // RED-P4a2 第 2 项（总控决定，安全收紧）：纯文本里的双引号串不是 JSON 载体字面量，其中的 \n 两个字符按内容
    // 处理、不放回。dbc078f 起把任何可解析的双引号串都当作载体，输出曾是 password="[redacted]\n"。
    const input = 'password="SYNTHETICa\\nSYNTHETICb"';
    const { text, report } = redactDeveloperTextWithReport(input);
    expect(text).toBe('password="[redacted]"');
    expect(report.restoredTokens).toBe(0);
    expect(redactDeveloperText(text)).toBe(text);
    assertNoLegacyRegression(input);
  });

  test.each([
    ['{"stdout":"password=\\"SYNTHETIC a\\u000aSYNTHETIC b\\""}', '\n'],
    ['{"stdout":"password=\\"SYNTHETIC a\\u000dSYNTHETIC b\\""}', '\r'],
    ['{"stdout":"password=\\"SYNTHETIC a\\u000ASYNTHETIC b\\""}', '\n'],
  ])('a \\u-encoded newline the version re-emitted as \\n is not restored a second time: %j', (input, newline) => {
    // 复查意见 2：记号先归一到解码后的换行字符再做多重集差。历史版本把 \u000a 解码后重新写成 \n，
    // 二者是同一个换行；按文本形态比较会把 \u000a 当作缺失而多放一次。
    const { text, report } = redactDeveloperTextWithReport(input);
    expect(text).toBe(fixtureAtB60a61e(input));
    expect((JSON.parse(text) as { stdout: string }).stdout).toBe(`password="[redacted]${newline}"`);
    expect(report.restoredTokens).toBe(0);
    expect(redactDeveloperText(text)).toBe(text);
    assertNoLegacyRegression(input);
  });

  test('a \\u-encoded newline the version swallowed is put back in its original form', () => {
    const input = '{"password":"SYNTHETIC a\\u000aSYNTHETIC b"}';
    const { text, report } = redactDeveloperTextWithReport(input);
    expect(text).toBe('{"password":"[redacted]\\u000a"}');
    expect((JSON.parse(text) as { password: string }).password).toBe('[redacted]\n');
    expect(report.restoredTokens).toBe(1);
    expect(redactDeveloperText(text)).toBe(text);
    assertNoLegacyRegression(input);
  });
});

describe('tiling prefers the current rules plus information-equivalent characters', () => {
  test.each([
    '{"stdout":"password=SYNTHETIC\\"quoted\\""}',
    '{"stdout":"password=SYNTHETIC\\"quoted\\" rest"}',
    '{"stdout":"x password=SYNTHETICpw\\"q\\" y"}',
    '{"stdout":"api_key=SYNTHETICkey\\\\\\"q\\\\\\""}',
    '{"stdout":"token=SYNTHETICtok\\" and password=SYNTHETICpw\\"z"}',
  ])('an escaped quote after a bare value keeps its backslash and the carrier stays valid JSON: %j', (input) => {
    // 复查意见 3：246055e 的裸值字符类吃下转义引号的反斜杠；用它的缺口铺满整个区间会吞掉这个反斜杠，
    // 载体 JSON 随之失效。同一区间应优先用 v3 的缺口加上原样输出的信息等价字符（引号及其转义反斜杠）。
    const output = redactDeveloperText(input);
    expect(output).toBe(fixtureAtB60a61e(input));
    expect(() => JSON.parse(output)).not.toThrow();
    expect(output).not.toContain('SYNTHETIC');
    expect(redactDeveloperText(output)).toBe(output);
    assertNoLegacyRegression(input);
  });

  test('a gap from a legacy version is still used when it is the only one covering the content', () => {
    // 只有早期版本遮住的值：没有 v3 缺口可用，沿用早期版本的合成文本（与原来一致）。
    expect(redactDeveloperText('JWT_SECRET=!SYNTHETICpw')).toBe('JWT_SECRET=[redacted]');
    expect(redactDeveloperText('{"stdout":"JWT_SECRET=!SYNTHETICpw\\"q\\""}')).toBe(
      '{"stdout":"JWT_SECRET=[redacted]\\"q\\""}'
    );
  });
});

describe('historical replacement text is reused only when it is pure', () => {
  test.each([
    [
      '{\n  "password": 123456789,\n  "normal": 7\n}',
      '{\n  "password": "[redacted]",\n  "normal": 7\n}',
    ],
    ['Authorization: Bearer SYNTHETICtoken', 'Authorization: Bearer [redacted-token]'],
    ['key=sk-SYNTHETICxxxxxxxxxxxx end', 'key=[redacted-api-key] end'],
    ['AIzaSYNTHETICxxxxxxxxxxxxxxxxxxx', '[redacted-google-api-key]'],
    ['https://user:SYNTHETICpass@host.example/x', 'https://user:[redacted]@host.example/x'],
    ['{"password":["SYNTHETIC_A"],"normal":1}', '{"password":"[redacted]","normal":1}'],
    ["    let token = '';", "    let token = '[redacted]';"],
    ['{"password":""}', '{"password":"[redacted]"}'],
  ])('%j renders like HEAD by reusing the frozen synthetic text', (input, expected) => {
    const output = redactDeveloperText(input);
    expect(output).toBe(expected);
    expect(output).toBe(fixtureAtB60a61e(input));
    expect(redactDeveloperText(output)).toBe(output);
  });

  test('a legacy-only gap reuses the legacy marker: the whole value, not the HEAD fragment', () => {
    expect(
      redactDeveloperText('password=postgres://admin:SYNTHETICpw@db.example.com/SYNTHETICdb')
    ).toBe('password=[redacted]');
    expect(redactDeveloperText('JWT_SECRET=!SYNTHETICpw')).toBe('JWT_SECRET=[redacted]');
  });

  test('analyzeSynth accepts only markers, quotes and newlines', () => {
    expect(analyzeSynth('[redacted]').pure).toBe(true);
    expect(analyzeSynth('"[redacted]"\n\n').pure).toBe(true);
    expect(analyzeSynth('\\"[redacted]\\"\\n').pure).toBe(true);
    // 换行记号归一到解码后的换行字符（复查意见 2），\u000a 载体与 \n 载体才能对上同一个换行。
    expect(analyzeSynth('[redacted-private-key]\\r\\n')).toMatchObject({
      pure: true,
      tokens: ['\r', '\n'],
    });
    expect(analyzeSynth('\\\\"[redacted]\\\\n\\\\"').tokens).toEqual(['\n']);
    expect(analyzeSynth('[redacted]abc').pure).toBe(false);
    expect(analyzeSynth('[redacted kv]').pure).toBe(false);
    expect(analyzeSynth('x').pure).toBe(false);
    expect(analyzeSynth('"[redacted]"').firstCoreEnd).toBe(11);
  });

  test('an impure synthetic text is rejected and the run falls back to a new marker', () => {
    const x = 'password=SYNTHETICpw tail';
    const hidden = hiddenFor(x, [[9, 20]]);
    const gapSets: GapSet[] = [
      { revision: 'b60a61e', gaps: [{ start: 9, end: 20, synth: '[redacted]SYNTHETICpw' }] },
    ];
    const result = renderByPositions(x, hidden, analyzeStructure(x), gapSets);
    expect(result.text).toBe('password=[redacted] tail');
    expect(result.stats.impureSynths).toBe(1);
    expect(result.stats.fallbackRuns).toBe(1);
  });
});

describe('fallback rendering for runs no single version produced', () => {
  test('overlapping gaps from two versions cannot tile: a new marker keeps the delimiting quotes', () => {
    const x = 'password="SYNTHETIChead SYNTHETICtail" rest';
    const hidden = hiddenFor(x, [[9, 38]]);
    const gapSets: GapSet[] = [
      { revision: 'b60a61e', gaps: [{ start: 10, end: 25, synth: '[redacted]' }] },
      { revision: '246055e', gaps: [{ start: 20, end: 38, synth: '[redacted]' }] },
    ];
    const result = renderByPositions(x, hidden, analyzeStructure(x), gapSets);
    expect(result.text).toBe('password="[redacted]" rest');
    expect(result.stats.fallbackRuns).toBe(1);
    expect(result.stats.tiledRuns).toBe(0);
  });

  test('adjacent gaps from different versions tile the run in order', () => {
    const x = '{"stdout":"password=abcSYNTHETIC;xyz123SYNTHETIC"}';
    const output = redactDeveloperText(x);
    expect(output).toBe('{"stdout":"password=[redacted]"}');
    expect(JSON.parse(output)).toEqual({ stdout: 'password=[redacted]' });
  });

  test('bare newlines inside a fallback run are re-emitted in order', () => {
    const x = 'a SYNTHETIC1\nSYNTHETIC2\n\nSYNTHETIC3 b';
    const hidden = hiddenFor(x, [[2, 35]]);
    const result = renderByPositions(x, hidden, analyzeStructure(x), []);
    expect(result.text).toBe('a [redacted]\n\n\n b');
    expect(result.stats.restoredTokens).toBe(3);
  });

  test('the provenance table maps kept characters and marks synthetic ones with -1', () => {
    const x = 'key: SYNTHETIC ok';
    const hidden = hiddenFor(x, [[5, 14]]);
    const result = renderByPositions(x, hidden, analyzeStructure(x), [], true);
    expect(result.text).toBe('key: [redacted] ok');
    expect(result.origin).not.toBeNull();
    const origin = result.origin ?? new Int32Array(0);
    expect([...origin.slice(0, 5)]).toEqual([0, 1, 2, 3, 4]);
    expect([...origin.slice(5, 15)].every((value) => value === -1)).toBe(true);
    expect([...origin.slice(15)]).toEqual([14, 15, 16]);
    expect(renderByPositions(x, hidden, analyzeStructure(x), []).origin).toBeNull();
  });

  test('no equal-length placeholders: the marker length does not follow the secret length', () => {
    const short = redactDeveloperText('password=SYNTHETIC1');
    const long = redactDeveloperText(`password=SYNTHETIC${'x'.repeat(200)}`);
    expect(short).toBe(long);
  });
});

describe('structure, vocabulary and determinism', () => {
  const samples = [
    'password="SYNTHETIC head SYNTHETIC_TAIL_NEVER_REAL"',
    '{"stdout":"JWT_SECRET=-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCSYNTHETICPEMONEAAAAAAAAAAAAAAAAA\\n-----END PRIVATE KEY-----\\nDB_PASSWORD=!SYNTHETICpw"}',
    'level=warn msg="retry with token: " token="SYNTHETICtok"',
    'SAS_TOKEN=https://reader:SYNTHETICpw@acct.blob.core.windows.net/c?sv=2022&sig=SYNTHETICsig1%2Bxyz',
    'password=Pa(ss)word1SYNTHETIC',
    'if (token === null) return;',
  ];

  test('every synthesized marker belongs to the closed vocabulary', () => {
    for (const input of samples) {
      const output = redactDeveloperText(input);
      for (const match of output.matchAll(/\[redacted[^\]\s"'\\]*\]/g)) {
        expect(REDACTION_MARKERS).toContain(match[0]);
      }
    }
  });

  test('idempotent and deterministic', () => {
    for (const input of samples) {
      const first = redactDeveloperText(input);
      expect(redactDeveloperText(input)).toBe(first);
      expect(redactDeveloperText(first)).toBe(first);
      assertNoLegacyRegression(input);
    }
  });
});

describe('requirement 9: evidence annotations and code.search prefixes are not degraded', () => {
  test.each([
    'lib/secret_key.rb:10-14',
    '[evidence] E-1=lib/secret_key.rb:10-14; E-2=src/app.ts:3-9',
    'src/config.ts\n  11: const a = 1;\n  12: password=SYNTHETICpw\n  13: const b = 2;',
    '12|password: SYNTHETICpw\n13|next = 1',
    'see https://user@example.com/x and http://localhost:3000/a?b=c',
    '类型导入使用 import type 严格隔离：lib/types/graph-shared.ts:1-3',
  ])('%j renders exactly like the stage-1 floor', (input) => {
    const output = redactDeveloperText(input);
    expect(output).toBe(applyAlignmentFloor(input).text);
    // 行号前缀与结构保持：每一行的行首 NN: / NN| 前缀原样。
    for (const [index, line] of input.split('\n').entries()) {
      const prefix = /^(\s*\d+[:|])/.exec(line)?.[1];
      if (prefix !== undefined) {
        expect(output.split('\n')[index]?.startsWith(prefix)).toBe(true);
      }
    }
  });
});

describe('RED-P4a2 item 1: the newline put-back counts bare and escaped newlines separately', () => {
  // 第五轮审计（high）：缺口里同时有裸换行与可解析字面量里的转义换行、版本的合成文本只重出了裸换行时，按解码后
  // 字符做的多重集差让转义记号先抵掉合成文本里的裸换行，真正的裸换行被当成缺失又放回一次，裸换行多出一个，
  // 整篇退成 [redacted-unaligned] 骨架（无关行、[evidence] 标注与 NN: 前缀一起没了）。
  const cases: Array<[string, string, string]> = [
    [
      'pretty JSON document, sensitive key over an array with an escaped newline',
      '{"password": ["a\\nb",\n"c"]}',
      // 整篇是 JSON 文档：字面量里的转义换行是 D3 结构，按原形态放回第一个标记之后；裸换行仍是版本重出的那一个。
      '{"password": "[redacted]\\n"\n}',
    ],
    [
      '[evidence] annotation with NN: prefixes',
      '[evidence] E-1=config/app.json:12-16\n12: {\n13:   "secret": {\n14:     "note": "a\\nb"\n15:   }\n16: }',
      '[evidence] E-1=config/app.json:12-16\n12: {\n13:   "secret": "[redacted]"\n\n\n16: }',
    ],
    [
      'shell export of a pretty JSON service account across lines',
      'export API_TOKEN=\'{\n  "type": "service_account",\n  "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCSYNTHpemA\\nSYNTHpemB\\n-----END PRIVATE KEY-----\\n",\n  "client_email": "x@y"\n}\'\necho done',
      "export API_TOKEN='[redacted]\n\n\n\n'\necho done",
    ],
    [
      'unrelated lines around the container',
      'line0\n{"password": ["a\\nb",\n"c"]}\nline3 ok',
      'line0\n{"password": "[redacted]"\n}\nline3 ok',
    ],
    [
      'nested object with an escaped newline between unrelated lines',
      'a: 1\n{"token": {"x": "p\\nq",\n "y": 2}}\nz: 3',
      'a: 1\n{"token": "[redacted]"\n}\nz: 3',
    ],
  ];

  test.each(cases)('%s renders without the skeleton fallback', (_name, input, expected) => {
    const { text, report } = redactDeveloperTextWithReport(input);
    expect(text).toBe(expected);
    expect(report.renderSkeletons).toBe(0);
    expect(report.kinds).not.toContain('render-skeleton');
    expect(newlineSkeleton(text)).toBe(newlineSkeleton(input));
    expect(text).not.toContain('[redacted-unaligned]');
    expect(redactDeveloperText(text)).toBe(text);
    assertNoLegacyRegression(input);
  });

  test('the evidence annotation, the NN: prefixes and the unrelated lines are kept verbatim', () => {
    const input = cases[1]?.[1] ?? '';
    const lines = redactDeveloperText(input).split('\n');
    expect(lines[0]).toBe('[evidence] E-1=config/app.json:12-16');
    expect(lines[1]).toBe('12: {');
    expect(lines[2]?.startsWith('13: ')).toBe(true);
    expect(lines[5]).toBe('16: }');
    expect(redactDeveloperText(cases[2]?.[1] ?? '').endsWith('\necho done')).toBe(true);
    const around = redactDeveloperText(cases[3]?.[1] ?? '').split('\n');
    expect(around[0]).toBe('line0');
    expect(around[3]).toBe('line3 ok');
  });

  test('renderByPositions restores the missing escaped token and keeps the bare one matched', () => {
    // 缺口 [13,26) 里先有转义换行 @16、再有裸换行 @21；合成文本只重出一个裸换行。
    const x = '{"password": ["a\\nb",\n"c"]}';
    const hidden = hiddenFor(x, [[13, 26]]);
    const gapSets: GapSet[] = [
      { revision: 'b60a61e', gaps: [{ start: 13, end: 26, synth: '"[redacted]"\n' }] },
    ];
    const result = renderByPositions(x, hidden, analyzeStructure(x), gapSets);
    expect(result.text).toBe('{"password": "[redacted]\\n"\n}');
    expect(result.stats.restoredTokens).toBe(1);
    expect(newlineSkeleton(result.text)).toBe(newlineSkeleton(x));
  });

  test('a synthetic escaped newline is not consumed by a bare one in the gap, and vice versa', () => {
    // 合成文本只有转义换行，缺口里有一个转义、一个裸换行：转义的对上，缺的是裸换行，放回裸换行。
    const x = '{"password": ["a\\nb",\n"c"]}';
    const hidden = hiddenFor(x, [[13, 26]]);
    const escapedOnly: GapSet[] = [
      { revision: 'b60a61e', gaps: [{ start: 13, end: 26, synth: '"[redacted]\\n"' }] },
    ];
    const result = renderByPositions(x, hidden, analyzeStructure(x), escapedOnly);
    expect(result.text).toBe('{"password": "[redacted]\n\\n"}');
    expect(result.stats.restoredTokens).toBe(1);
    expect(newlineSkeleton(result.text)).toBe(newlineSkeleton(x));
    expect(analyzeSynth('"[redacted]"\n').levels).toEqual([0]);
    expect(analyzeSynth('"[redacted]\\n"\\r\r').levels).toEqual([1, 1, 0]);
    expect(analyzeSynth('\\"[redacted]\\"\\\\n').levels).toEqual([2]);
  });

  test('inside a carrier, a deeper escaped newline does not consume a newline the version re-emitted', () => {
    // 载体里同理：版本把容器里的第 1 层换行（载体层 \n）原样重出；第 2 层的转义换行（载体层 \\n）是另一层级，
    // 不能与之相抵，否则解码后的 stdout 多出一行、真正缺的第 2 层换行又没放回。
    const stdout = '{\n  "api_key": [\n    "SYNTHa\\nb",\n    "c"\n  ]\n}';
    const input = JSON.stringify({ stdout });
    const { text, report } = redactDeveloperTextWithReport(input);
    const decoded = (JSON.parse(text) as { stdout: string }).stdout;
    expect(decoded.split('\n')).toHaveLength(stdout.split('\n').length);
    expect((JSON.parse(decoded) as { api_key: string }).api_key).toBe('[redacted]\n');
    expect(report.renderSkeletons).toBe(0);
    expect(redactDeveloperText(text)).toBe(text);
    assertNoLegacyRegression(input);
  });

  test('a pretty-printed JSON document with an escaped newline under a sensitive object keeps both forms', () => {
    const input = '{\n  "secret": {\n    "note": "a\\nb"\n  }\n}';
    const { text, report } = redactDeveloperTextWithReport(input);
    expect(report.renderSkeletons).toBe(0);
    expect(newlineSkeleton(text)).toBe(newlineSkeleton(input));
    expect(redactDeveloperText(text)).toBe(text);
    assertNoLegacyRegression(input);
  });
});

describe('RED-P4a2 item 2: escaped newlines are put back only inside real JSON carrier literals', () => {
  test.each([
    ['export DB_PASSWORD="SYNTHabc\\ndef"', 'export DB_PASSWORD="[redacted]"'],
    ['password = "SYNTH\\nA\\nB"; // source', 'password = "[redacted]"; // source'],
  ])('a plain-text double-quoted string keeps its \\n as content: %j', (input, expected) => {
    const { text, report } = redactDeveloperTextWithReport(input);
    expect(text).toBe(expected);
    expect(report.restoredTokens).toBe(0);
    expect([...structurePositions(input)].every((flag) => flag === 0)).toBe(true);
    // 收紧后 oracle 也把这些位置按内容判定：豁免里不再有 \n 两个字符。
    const exempt = exemptPositions(input);
    const at = input.indexOf('\\n');
    expect([exempt[at], exempt[at + 1]]).toEqual([0, 0]);
    expect(redactDeveloperText(text)).toBe(text);
    assertNoLegacyRegression(input);
  });

  test('the same plain-text lines inside a tool-result carrier still keep the inner \\n masked', () => {
    // 载体字符串值里的文本是纯文本：其中双引号串的 \n（载体层是 \\n 三个字符）不是换行，按内容处理。
    for (const [line, expected] of [
      ['export DB_PASSWORD="SYNTHabc\\ndef"', 'export DB_PASSWORD="[redacted]"'],
      ['password = "SYNTH\\nA\\nB"; // source', 'password = "[redacted]"; // source'],
    ] as const) {
      const input = JSON.stringify({ stdout: line });
      const { text, report } = redactDeveloperTextWithReport(input);
      expect((JSON.parse(text) as { stdout: string }).stdout).toBe(expected);
      expect(report.restoredTokens).toBe(0);
      assertNoLegacyRegression(input);
    }
  });

  test('a compact carrier line followed by an evidence annotation is still a JSON carrier', () => {
    // 整段不是 JSON 文档，但这一行本身是：工具结果载体字符串值里的转义换行仍按 D3 放回。
    const carrier = JSON.stringify({ password: 'SYNTHETIC a\nSYNTHETIC b' });
    const input = `${carrier}\n\n[evidence] E-1=src/a.ts:1-3`;
    const { text, report } = redactDeveloperTextWithReport(input);
    expect(text).toBe('{"password":"[redacted]\\n"}\n\n[evidence] E-1=src/a.ts:1-3');
    expect(report.restoredTokens).toBe(1);
    assertNoLegacyRegression(input);
  });
});

describe('RED-P4a2 item 3: odd backslash runs escape a quote, and only value-boundary quotes are exempt', () => {
  test('an even backslash run before a quote is content and is no longer exposed', () => {
    // 第五轮审计（low）：v0/v1 遮住了值末尾的两个反斜杠，dbc078f 起按“紧贴引号的反斜杠串都是转义”原样写出。
    const input = 'pass_token=sk-proj-SYNTHETIC123456789\\\\" x';
    const output = redactDeveloperText(input);
    expect(output).toBe('pass_token=[redacted]" x');
    expect(output).not.toContain('\\');
    expect(strictExposures(input)).toEqual([]);
    const exempt = exemptPositions(input);
    expect([exempt[37], exempt[38], exempt[39]]).toEqual([0, 0, 1]);
    assertNoLegacyRegression(input);
  });

  test('escaped quotes inside a value are content; the delimiting quotes stay exempt', () => {
    const json = '{"password": "ab\\"cd\\"ef"}';
    const jsonExempt = exemptPositions(json);
    expect([16, 17, 20, 21].map((index) => jsonExempt[index])).toEqual([0, 0, 0, 0]);
    expect([jsonExempt[13], jsonExempt[24]]).toEqual([1, 1]);
    const text = 'password: "ab\\"cd\\"ef" x';
    const textExempt = exemptPositions(text);
    expect([13, 14, 17, 18].map((index) => textExempt[index])).toEqual([0, 0, 0, 0]);
    expect(textExempt[10]).toBe(1);
    // 按基线算的豁免：v3 遮住的值内部转义引号同样不豁免。
    const v3 = fixtureExactHidden('b60a61e', json);
    expect([16, 17].map((index) => exemptPositions(json, v3)[index])).toEqual([0, 0]);
    for (const input of [json, text]) {
      expect(strictExposures(input)).toEqual([]);
      assertNoLegacyRegression(input);
    }
  });

  test('the renderer does not output an interior escaped quote verbatim between two gaps', () => {
    // 构造：v3 只遮 ab 与 cd"ef（两段缺口），v0 遮整个值；中间的 \" 两侧都被 v0 遮住，是值内部的转义引号，
    // 不能用原样步写出，只能退回 v0 的缺口。
    const x = 'password: "ab\\"cd\\"ef" x';
    const hidden = hiddenFor(x, [[11, 22]]);
    const gapSets: GapSet[] = [
      {
        revision: 'b60a61e',
        gaps: [
          { start: 11, end: 13, synth: '[redacted]' },
          { start: 15, end: 22, synth: '[redacted]"' },
        ],
      },
      { revision: '246055e', gaps: [{ start: 11, end: 22, synth: '[redacted]"' }] },
    ];
    const result = renderByPositions(x, hidden, analyzeStructure(x), gapSets, true);
    expect(result.text).toBe('password: "[redacted]" x');
    const origin = [...(result.origin ?? new Int32Array(0))];
    expect(origin).not.toContain(13);
    expect(origin).not.toContain(14);
  });

  test('a boundary escaped quote after a bare value is still output verbatim (the carrier stays valid)', () => {
    const input = '{"stdout":"password=SYNTHETIC\\"quoted\\""}';
    const output = redactDeveloperText(input);
    expect(output).toBe('{"stdout":"password=[redacted]\\"quoted\\""}');
    expect(() => JSON.parse(output)).not.toThrow();
  });

  test('an escaping backslash swallowed by an early version stays with its quote, so the carrier stays valid JSON', () => {
    // 转义单元（奇数长度反斜杠串的最后一个反斜杠加引号）不再被缺口切开：v0 的裸值字符类吃进了内层闭引号 \" 的
    // 反斜杠，dbc078f 只用它的缺口铺排，留下没有转义的引号，双层载体不再是合法 JSON。
    const input = JSON.stringify({
      message: JSON.stringify({ stdout: 'token:SYNTHETIC6q1688Z?' }),
    });
    const output = redactDeveloperText(input);
    expect(output).toBe('{"message":"{\\"stdout\\":\\"token:[redacted]\\"}"}');
    const inner = (JSON.parse(output) as { message: string }).message;
    expect(JSON.parse(inner)).toEqual({ stdout: 'token:[redacted]' });
    expect(redactDeveloperText(output)).toBe(output);
    assertNoLegacyRegression(input);
  });

  test('a C string literal keeps its \\n as content in plain text and inside a carrier, which stays valid JSON', () => {
    const line = 'printf("Password: %s\\n", pw);';
    expect(redactDeveloperText(line)).toBe('printf("Password: [redacted]", pw);');
    const carrier = JSON.stringify({ stdout: line });
    const output = redactDeveloperText(carrier);
    expect((JSON.parse(output) as { stdout: string }).stdout).toBe(
      'printf("Password: [redacted]", pw);'
    );
    expect(redactDeveloperText(output)).toBe(output);
    assertNoLegacyRegression(line);
    assertNoLegacyRegression(carrier);
  });

  test('expandEscapedQuotes grows only a partly hidden escape unit (last backslash plus quote)', () => {
    const grown = (x: string, ranges: Array<[number, number]>): number[] => {
      const hidden = hiddenFor(x, ranges);
      expandEscapedQuotes(x, hidden);
      return [...hidden];
    };
    // 单个反斜杠被遮、引号可见：整个转义单元一起被遮。
    expect(grown('v\\"x', [[0, 2]])).toEqual([1, 1, 1, 0]);
    // 引号被遮、反斜杠可见：同样扩到反斜杠。
    expect(grown('v\\"x', [[2, 3]])).toEqual([0, 1, 1, 0]);
    // 偶数长度的反斜杠串是内容，不是转义单元，不扩展。
    expect(grown('v\\\\"x', [[0, 3]])).toEqual([1, 1, 1, 0, 0]);
    // 奇数长度串里前面成对的反斜杠是完整的转义，缺口在它们之后结束时不扩展。
    expect(grown('v\\\\\\"x', [[0, 3]])).toEqual([1, 1, 1, 0, 0, 0]);
  });

  test('a grid of values with interior escaped quotes never exposes them', () => {
    const keys = ['password', 'api_key', 'token', 'GITHUB_TOKEN'];
    const separators = ['=', ': ', '="', ': "', '":"', '": "'];
    const values = ['ab\\"cd\\"ef', 'SYNTH\\"x', 'p\\\\\\"q\\"r', "a'b\\'c", 'x\\"\\"y'];
    const wraps = [
      (body: string) => body,
      (body: string) => `${body}" tail`,
      (body: string) => JSON.stringify({ stdout: body }),
      (body: string) => JSON.stringify({ message: JSON.stringify({ stdout: body }) }),
      (body: string) => `{"${body}"}`,
    ];
    let checked = 0;
    for (const key of keys) {
      for (const separator of separators) {
        for (const value of values) {
          for (const wrap of wraps) {
            const input = wrap(`${key}${separator}${value}`);
            checked++;
            assertNoLegacyRegression(input);
          }
        }
      }
    }
    expect(checked).toBe(keys.length * separators.length * values.length * wraps.length);
  });
});
