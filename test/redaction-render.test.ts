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
import { applyAlignmentFloor } from '../src/agent/utils/redaction/legacyFloor.js';
import {
  analyzeSynth,
  expandAtomicMarkers,
  type GapSet,
  markerCores,
  renderByPositions,
} from '../src/agent/utils/redaction/render.js';
import { analyzeStructure } from '../src/agent/utils/redaction/trackedReplay.js';
import { redactDeveloperText as fixtureAtB60a61e } from './fixtures/redaction-baselines/redaction-at-b60a61e.js';
import { assertNoLegacyRegression } from './fixtures/redaction-catalog/legacyRegressionOracle.js';

function newlineSkeleton(text: string): string {
  return text.replace(/[^\r\n]/g, '');
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

  test('a double-quoted value is itself a parsable literal, so its escaped newline is put back', () => {
    // 历史版本也把它当作载体递归处理；按统一口径这个 \n 是结构，只暴露换行个数。
    const input = 'password="SYNTHETICa\\nSYNTHETICb"';
    const output = redactDeveloperText(input);
    expect(output).toBe('password="[redacted]\\n"');
    expect(output).not.toContain('SYNTHETIC');
    expect(redactDeveloperText(output)).toBe(output);
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
