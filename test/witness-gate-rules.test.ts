/**
 * 见证闸门 PEM 单行形态补修（RED-P3a2，L7-P11 / C03 第五轮审计确认项）。
 *
 * 审计在 b4ace47 上实测：换行被替换成空格的单行 PEM 私钥，只要正文超过 BEGIN 之后 1024 字符的
 * 固定窗口（RSA-2048/4096 必然超过），闸门就放行，私钥原文写进见证台账。规则表里的单行正例只用了
 * 窗口内的短正文，测不出这个缺口。
 *
 * 本文件钉住：
 * - 真实长度（RSA-2048/4096 的 PKCS#1 与 PKCS#8、EC P-256/P-384、OpenSSH 70 列）的单行形态在常见载体里
 *   都命中 pem-private-key-block，END 缺失或 BEGIN 与正文之间隔着超过窗口的空白也命中；
 * - 多行、转义换行形态照旧命中（规则只扩大拒绝面）；
 * - 反例保持：BEGIN 后接普通文本（含超过 1024 字符的长行、字母不少于 64 且不带标点的英文句子，
 *   同一行带 END 与不带 END）、仅注释里的标记、公钥与证书；
 * - 累计口径只收等宽、混有大小写与数字或 + / 的短段序列（返工：普通英文单词不能凑成正文）；
 * - 已知误拒面如实钉住：BEGIN 后同一行第一个不少于 16 个字符的 base64 字符集单词即命中；
 * - 规则表本身带真实长度的单行正例（不再是窗口内的自证样例）；
 * - 1 MiB 对抗输入在单行判定路径上保持线性。
 *
 * 所有“私钥”都是运行时拼出的合成值（每段以 SYNTHETIC 开头），不是真实密钥；源码里不出现连续的
 * BEGIN 标记，保证本文件被宿主投影捕获时不命中见证闸门。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findWitnessGateHit,
  inspectWitnessContent,
  WITNESS_GATE_POLICY_ID,
  WITNESS_GATE_RULES,
  WITNESS_MAX_CONTENT_BYTES,
} from '../src/agent/evidence/witnessGate.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PEM_HIT = { ruleId: 'pem-private-key-block', kind: 'pem-private-key' } as const;
/** b4ace47 的固定窗口长度；真实长度样例必须超过它，才能证明判定不再依赖窗口。 */
const LEGACY_WINDOW_CHARS = 1024;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const pemBegin = (label: string) => ['-----BEGIN', `${label}PRIVATE KEY-----`].join(' ');
const pemEnd = (label: string) => ['-----END', `${label}PRIVATE KEY-----`].join(' ');
const armorBegin = (label: string) => ['-----BEGIN', `${label}-----`].join(' ');
const armorEnd = (label: string) => ['-----END', `${label}-----`].join(' ');

/**
 * 合成正文：总长 totalChars 的 base64 串（末尾带 padding），按 lineWidth 切段。
 * 每段以 SYNTHETIC 开头，其余字符按确定性序列取自 base64 字母表，不是任何真实密钥。
 */
function syntheticPemSegments(totalChars: number, lineWidth: number, padding = 2): string[] {
  let body = '';
  for (let index = 0; body.length < totalChars - padding; index += 1) {
    const position = body.length % lineWidth;
    body +=
      position < 'SYNTHETIC'.length
        ? 'SYNTHETIC'[position]
        : BASE64_ALPHABET[(index * 37 + 11) % BASE64_ALPHABET.length];
  }
  body += '='.repeat(padding);
  const segments: string[] = [];
  for (let offset = 0; offset < body.length; offset += lineWidth) {
    segments.push(body.slice(offset, offset + lineWidth));
  }
  return segments;
}

interface KeyShape {
  readonly name: string;
  readonly label: string;
  /** 正文 base64 字符数（不含换行），按 DER 长度换算的真实量级。 */
  readonly bodyChars: number;
  readonly lineWidth: number;
  /** 单行形态是否必然超出旧窗口（RSA 与 OpenSSH RSA 必然超出）。 */
  readonly exceedsLegacyWindow: boolean;
}

const KEY_SHAPES: readonly KeyShape[] = [
  {
    name: 'RSA-2048 PKCS#1',
    label: 'RSA ',
    bodyChars: 1592,
    lineWidth: 64,
    exceedsLegacyWindow: true,
  },
  { name: 'RSA-2048 PKCS#8', label: '', bodyChars: 1624, lineWidth: 64, exceedsLegacyWindow: true },
  {
    name: 'RSA-4096 PKCS#1',
    label: 'RSA ',
    bodyChars: 3132,
    lineWidth: 64,
    exceedsLegacyWindow: true,
  },
  { name: 'RSA-4096 PKCS#8', label: '', bodyChars: 3168, lineWidth: 64, exceedsLegacyWindow: true },
  {
    name: 'encrypted RSA-2048 PKCS#8',
    label: 'ENCRYPTED ',
    bodyChars: 1752,
    lineWidth: 64,
    exceedsLegacyWindow: true,
  },
  {
    name: 'EC P-256 SEC1',
    label: 'EC ',
    bodyChars: 164,
    lineWidth: 64,
    exceedsLegacyWindow: false,
  },
  {
    name: 'EC P-384 SEC1',
    label: 'EC ',
    bodyChars: 224,
    lineWidth: 64,
    exceedsLegacyWindow: false,
  },
  {
    name: 'OpenSSH RSA-3072',
    label: 'OPENSSH ',
    bodyChars: 2600,
    lineWidth: 70,
    exceedsLegacyWindow: true,
  },
];

function shapeParts(shape: KeyShape) {
  return {
    begin: pemBegin(shape.label),
    segments: syntheticPemSegments(shape.bodyChars, shape.lineWidth),
    end: pemEnd(shape.label),
  };
}

/** 换行被替换成空白之后的单行形态，放进常见载体。 */
function singleLineForms(shape: KeyShape): ReadonlyArray<readonly [string, string]> {
  const { begin, segments, end } = shapeParts(shape);
  const spaced = [begin, ...segments, end].join(' ');
  return [
    ['bare space-joined line', spaced],
    ['env assignment in double quotes', `PRIVATE_KEY="${spaced}"\n`],
    ['JSON string value', JSON.stringify({ privateKey: spaced })],
    ['YAML plain scalar', `tls:\n  private_key: ${spaced}\n`],
    [
      'TS string literal among code',
      `export const a = 1;\nconst key = '${spaced}';\nexport const b = 2;\n`,
    ],
    ['several spaces between segments', [begin, ...segments, end].join('   ')],
    ['tab-joined line', [begin, ...segments, end].join('\t')],
    ['END marker dropped (truncated value)', `KEY=${[begin, ...segments].join(' ')}\n`],
    ['body glued to the BEGIN marker', `${begin}${segments.join(' ')} ${end}`],
  ];
}

describe('witness gate PEM single-line form at real key lengths', () => {
  for (const shape of KEY_SHAPES) {
    it(`${shape.name}: newline-to-space single-line forms hit pem-private-key-block`, () => {
      const { begin, segments } = shapeParts(shape);
      const spaced = [begin, ...segments].join(' ');
      if (shape.exceedsLegacyWindow) {
        // 反自证：样例的正文必须落在旧的 1024 字符窗口之外。
        expect(spaced.length - begin.length).toBeGreaterThan(LEGACY_WINDOW_CHARS);
      }
      for (const [form, content] of singleLineForms(shape)) {
        expect(findWitnessGateHit(content), `${shape.name} :: ${form}`).toEqual(PEM_HIT);
      }
    });

    it(`${shape.name}: multi-line and escaped-newline forms still hit`, () => {
      const { begin, segments, end } = shapeParts(shape);
      const multiLine = [begin, ...segments, end].join('\n');
      for (const content of [
        multiLine,
        [begin, ...segments, end].join('\r\n'),
        [begin, ...segments, end].join('\\n'),
        JSON.stringify({ privateKey: multiLine }),
      ]) {
        expect(findWitnessGateHit(content), shape.name).toEqual(PEM_HIT);
      }
    });
  }

  it('rejects the audit probe (RSA, 26 x 64-char segments joined by spaces) before writing', () => {
    const segments = syntheticPemSegments(26 * 64, 64, 0);
    const content = `PRIVATE_KEY="${[pemBegin('RSA '), ...segments, pemEnd('RSA ')].join(' ')}"\n`;
    expect(content.length).toBeGreaterThan(LEGACY_WINDOW_CHARS + 600);
    expect(inspectWitnessContent(content)).toEqual({
      reason: 'SECRET_DETECTED',
      kind: 'pem-private-key',
      ruleId: 'pem-private-key-block',
    });
  });

  it('does not depend on a fixed window: a body after a long blank gap on the BEGIN line still hits', () => {
    const segments = syntheticPemSegments(1624, 64);
    for (const gap of [' '.repeat(LEGACY_WINDOW_CHARS * 4), '\t '.repeat(3000)]) {
      const content = `${pemBegin('')}${gap}${segments.join(' ')} ${pemEnd('')}`;
      expect(findWitnessGateHit(content)).toEqual(PEM_HIT);
    }
  });

  it('skips RFC 1421 headers of a legacy encrypted RSA key joined into one line', () => {
    const segments = syntheticPemSegments(1752, 64);
    const headers = ['Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,SYNTHETIC0123456789ABCDEF'];
    const content = [pemBegin('RSA '), ...headers, '', ...segments, pemEnd('RSA ')].join(' ');
    expect(content.length).toBeGreaterThan(LEGACY_WINDOW_CHARS * 1.5);
    expect(findWitnessGateHit(`PRIVATE_KEY="${content}"`)).toEqual(PEM_HIT);
    // 只有头、没有正文不命中；头后面接普通文本也不命中。
    expect(findWitnessGateHit([pemBegin('RSA '), ...headers].join(' '))).toBeNull();
    expect(
      findWitnessGateHit([pemBegin('RSA '), ...headers, 'see docs/keys.md for rotation'].join(' '))
    ).toBeNull();
  });

  it('counts short base64 segments cumulatively (>= 64 chars) when no single segment reaches 16', () => {
    const short = syntheticPemSegments(96, 12, 0);
    expect(short.every((segment) => segment.length < 16)).toBe(true);
    expect(findWitnessGateHit([pemBegin('EC '), ...short].join(' '))).toEqual(PEM_HIT);
    // 不足 64 的短段累计不构成正文。
    const tooFew = syntheticPemSegments(60, 12, 0);
    expect(findWitnessGateHit([pemBegin('EC '), ...tooFew, pemEnd('EC ')].join(' '))).toBeNull();
  });

  it('keeps negatives: plain text after BEGIN, marker-only comments, public keys and certificates', () => {
    const segments = syntheticPemSegments(1624, 64);
    const negatives = [
      // BEGIN 后接普通文本（第一个非载体段不是 base64）。
      `// ${pemBegin('')} marker: the parser reads lines until the end marker.`,
      `// Detects ${pemBegin('')} markers in pasted logs; the marker alone is not a key.`,
      // 单行代码超过旧窗口，但 BEGIN 后面接的是代码。
      `const banner = '${pemBegin('')}'; ${'export const filler = 1; '.repeat(80)}`,
      `${pemBegin('')} ${'not-base64.word '.repeat(200)}`,
      // 仅注释里的标记，下一行是代码。
      `// ${pemBegin('')}\n${'export const next = 1;\n'.repeat(80)}`,
      ` * 源码里单独出现的 '${pemBegin('')}' 常量不会吞掉后续代码；`,
      // 占位与过短正文。
      [pemBegin(''), ['$', '{KEY_BODY_PLACEHOLDER}'].join(''), pemEnd('')].join(' '),
      [pemBegin(''), 'short', pemEnd('')].join(' '),
      `const sample = '${pemBegin('')} ... ${pemEnd('')}';`,
      // 不是私钥的同长度单行块。
      [armorBegin('PUBLIC KEY'), ...segments, armorEnd('PUBLIC KEY')].join(' '),
      [armorBegin('CERTIFICATE'), ...segments, armorEnd('CERTIFICATE')].join(' '),
    ];
    for (const negative of negatives) {
      expect(findWitnessGateHit(negative), negative.slice(0, 80)).toBeNull();
    }
  });

  it('keeps negatives: an unpunctuated English sentence (>= 64 letters) after BEGIN in a comment, with and without END', () => {
    // 返工 RED：英文单词全由 base64 字符组成，累计口径不能把 BEGIN 后面不带标点的普通句子当成正文。
    // 句子里没有任何标点、没有不少于 16 个字符的单词，字母数不少于 64。
    const comments: ReadonlyArray<readonly [string, string, string]> = [
      [
        '//',
        'RSA ',
        'header is what OpenSSL writes for PKCS1 keys while PKCS8 keys use another header',
      ],
      [
        '//',
        '',
        'blocks are detected by the gate when they contain a body and the body is long enough',
      ],
      [
        '#',
        '',
        'is followed by the key material which we never log or store in plain form anywhere',
      ],
      [
        '#',
        'EC ',
        'Generated By The Deploy Script For Staging Hosts Only Never Commit This File Anywhere Else',
      ],
      [
        ' *',
        'ENCRYPTED ',
        'the key body goes on the next lines and is never written to logs or to the ledger',
      ],
    ];
    for (const [prefix, label, sentence] of comments) {
      expect(sentence, sentence).toMatch(/^[A-Za-z0-9 ]+$/);
      expect(sentence.replace(/[^A-Za-z]/g, '').length, sentence).toBeGreaterThanOrEqual(64);
      expect(
        sentence.split(' ').every((word) => word.length < 16),
        sentence
      ).toBe(true);
      const withoutEnd = `${prefix} ${pemBegin(label)} ${sentence}`;
      const withEnd = `${prefix} ${pemBegin(label)} ${sentence} ${pemEnd(label)}`;
      expect(findWitnessGateHit(withoutEnd), `no END :: ${withoutEnd}`).toBeNull();
      expect(findWitnessGateHit(withEnd), `END :: ${withEnd}`).toBeNull();
      // 同一句子后面接代码行：仍然不命中。
      expect(findWitnessGateHit(`${withoutEnd}\nexport const next = 1;\n`)).toBeNull();
    }
  });

  it('counts short segments cumulatively only for an equal-width, base64-looking run', () => {
    const body = syntheticPemSegments(128, 128, 0).join('');
    const chunk = (text: string, width: number) =>
      text.match(new RegExp(`.{1,${width}}`, 'g')) ?? [];
    // 等宽短段（末段可以更短、可带 = 填充）且混有大小写与数字或 + /：累计不少于 64 即命中。
    for (const width of [4, 8, 12]) {
      const segments = chunk(body.slice(0, 90), width);
      expect(
        findWitnessGateHit([pemBegin(''), ...segments, pemEnd('')].join(' ')),
        `w${width}`
      ).toEqual(PEM_HIT);
      expect(
        findWitnessGateHit([pemBegin(''), ...segments, 'ab=='].join(' ')),
        `w${width}`
      ).toEqual(PEM_HIT);
    }
    // `+` 也是 base64 字符：紧贴 base64 字符的段首 / 段尾 `+` 留在段里，等宽判定不被剥短；
    // 引号外的拼接符 `+` 照旧按载体剥掉。
    const plusEdged = chunk(body.slice(0, 88), 4).map((segment, index) => {
      if (index === 3) {
        return `${segment.slice(0, 3)}+`;
      }
      if (index === 5) {
        return `+${segment.slice(1)}`;
      }
      if (index === 7) {
        return `+/${segment.slice(2)}`;
      }
      if (index === 9) {
        return `${segment.slice(0, 2)}/+`;
      }
      return segment;
    });
    for (const index of [3, 5, 7, 9]) {
      expect(plusEdged[index]?.includes('+'), String(index)).toBe(true);
    }
    expect(findWitnessGateHit([pemBegin(''), ...plusEdged, pemEnd('')].join(' '))).toEqual(PEM_HIT);
    expect(
      findWitnessGateHit(`KEY='${pemBegin('')} ${plusEdged.join(' ')}'+'${pemEnd('')}'`)
    ).toEqual(PEM_HIT);
    const negatives = [
      // 只有拼接用的 `+`：单独的 `+` 是载体，透明跳过；全是 `+` 的段没有字母数字，不是正文。
      `// ${pemBegin('')} ${'+'.repeat(24)}`,
      `// ${pemBegin('')} ${'+ '.repeat(40)}`,
      `// ${pemBegin('')} ${'++ '.repeat(40)}`,
      // 等宽但全是小写单词（没有大写，也没有数字或 + /）。
      `${pemBegin('')} ${'this that with from have been were ward '.repeat(4)}`,
      // 等宽、首字母大写的单词：有大小写，但没有数字或 + /。
      `${pemBegin('')} ${'This That With From Have Been Were Ward '.repeat(4)}`,
      // base64 字符集的段，但宽度不齐：短段后面又跟了段，不是按列切开的正文。
      `${pemBegin('')} ${chunk(body.slice(0, 40), 10).join(' ')} ab ${chunk(body.slice(40, 120), 10).join(' ')}`,
      // 宽度递增的段：后一段比第一段宽。
      `${pemBegin('')} ${['ab1', 'cdE4', 'fgHi5', 'jkLmn6', 'opQrst7', 'uvWxyz80', 'ABcdEFg9h', 'IJklMNop0q', 'RStuVWxy1zA'].join(' ')}`,
    ];
    for (const negative of negatives) {
      expect(findWitnessGateHit(negative), negative.slice(0, 120)).toBeNull();
    }
  });

  it('pins the known residual: the first >= 16-char base64-charset word right after BEGIN on the same line hits', () => {
    // 已知误拒面（如实钉住）：单行判定的第一段与按行判定的“第一条正文行”同一口径（去掉载体后
    // 整段是不少于 16 个字符的 base64 字符集），普通英文单词或驼峰标识符也满足。
    // b4ace47 上，同一行带 END、或下一行只有这个词时已经命中；同一行不带 END 时 b4ace47 返回 null，
    // 本次起命中（可见行为变化）。
    expect(findWitnessGateHit(`// ${pemBegin('')} implementationDetails are below`)).toEqual(
      PEM_HIT
    );
    expect(findWitnessGateHit(`// ${pemBegin('')} implementationDetails ${pemEnd('')}`)).toEqual(
      PEM_HIT
    );
    expect(
      findWitnessGateHit([`// ${pemBegin('')}`, '// implementationDetails'].join('\n'))
    ).toEqual(PEM_HIT);
    // 少于 16 个字符的首词不会单独命中。
    expect(findWitnessGateHit(`// ${pemBegin('')} implementation details are below`)).toBeNull();
  });

  it('carries real-length single-line examples in the rule table (no in-window self-proof)', () => {
    const pemRule = WITNESS_GATE_RULES.find((rule) => rule.id === 'pem-private-key-block');
    expect(pemRule).toBeDefined();
    const realLengthSingleLine = (pemRule?.examples ?? []).filter(
      (example) => !/\r|\n|\\n/.test(example) && example.length > LEGACY_WINDOW_CHARS + 256
    );
    expect(realLengthSingleLine.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the gate policy id: the rule only widens rejections and never rewrites stored content', () => {
    // 闸门只拒绝不改写，已存内容恒为原文；本次只扩大拒绝面，按策略 id 的约定不轮换。
    expect(WITNESS_GATE_POLICY_ID).toBe('evidence-witness-gate-t1-subset-v1');
  });
});

describe('witness gate PEM single-line scan stays linear on 1 MiB adversarial input', () => {
  const begin = pemBegin('');
  const fill = (unit: string, prefix: string, suffix = '') =>
    `${prefix}${unit.repeat(Math.floor((WITNESS_MAX_CONTENT_BYTES - prefix.length - suffix.length) / unit.length))}${suffix}`;
  const cases: ReadonlyArray<readonly [string, string]> = [
    // 一个巨大 token：两端不是载体、中间全是载体（正则式尾部剥离在这里会二次回溯）。
    ['one token of carriers between non-carriers', fill("'", `${begin} x`, 'y')],
    ['one token of leading carriers', fill("'", `${begin} `, 'x.')],
    ['carrier-only tokens to the end of the line', fill(" '", begin)],
    ['horizontal whitespace to the end', fill(' ', begin, '.')],
    ['repeated markers each followed by a short segment', fill(`${begin} ab `, '')],
    ['repeated markers glued to plain text', fill(`${begin}not.base64 `, '')],
    // 累计口径的对抗输入：一个全是 `+` 的巨大 token；等宽但缺字符混合的短段一直排到行尾。
    ['one token of plus signs', fill('+', `${begin} `, 'x.')],
    ['equal-width lowercase segments to the end of the line', fill('abcd ', `${begin} `)],
    [
      'repeated markers each followed by equal-width lowercase segments',
      fill(`${begin} abcd efgh `, ''),
    ],
  ];

  it.each(cases)('%s', (_name, content) => {
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(WITNESS_MAX_CONTENT_BYTES);
    expect(content.length).toBeGreaterThan(WITNESS_MAX_CONTENT_BYTES - 128);
    const startedAt = performance.now();
    const rejection = inspectWitnessContent(content);
    const elapsedMs = performance.now() - startedAt;
    expect(rejection).toBeNull();
    // 线性实现在 1 MiB 上是毫秒级；二次实现在单个 1 MiB token 上要数分钟。
    expect(elapsedMs).toBeLessThan(3000);
  });
});

describe('witness gate self-admission', () => {
  it('admits this test file into a witness ledger', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'test/witness-gate-rules.test.ts'), 'utf8');
    expect(inspectWitnessContent(text)).toBeNull();
  });
});
