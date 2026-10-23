/**
 * 脱敏零回退底线（设计 redaction-design-2026-10-19 第 6 节“测试要求”1、4 与门禁口径；阶段 4 起运行时底线是
 * 追踪重放，本文件的对齐路径用例以 applyAlignmentFloor 覆盖回退实现）。
 *
 * - 回归语料：失败模式目录 151 例与 3.2 节新发现，各跑裸文本与 {"stdout":…} 载体两种形态，全部交给攻击夹具
 *   assertNoLegacyRegression 按精确 oracle 判定（对四个历史版本零回退、幂等、裸换行守恒、标记词表封闭）。
 * - 证明义务：四个冻结副本（含阶段 4 冻结的 v3）与 git blob 逐字节、逐输出一致（黄金摘要）；标记词表锁定；
 *   对齐器变异体全部被精确 oracle 杀死；追踪重放作为独立位置 oracle（超集必须包含重放得到的被遮位置）。
 * - 失败即关路径：对齐路径的骨架兜底与不动点触顶、报告只含计数与种类。
 * - 防回退（RED-P4a2 第 5 项）：d0462bf 上载体内转义引号值的换行露出（HEAD 按 D3 放回）保持关闭。
 * 样本全部是合成值（SYNTHETIC / Synthetic），不是真实凭据。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  redactDeveloperText,
  redactDeveloperTextWithReport,
} from '../src/agent/utils/Redaction.js';
import {
  redactAt1b394ce,
  redactAt246055e,
  redactAtB60a61e,
  redactAtD113986,
} from '../src/agent/utils/redaction/frozenBaselines.js';
import {
  type AlignerMutation,
  hiddenSubset,
  hiddenSuperset,
  lexMarkers,
  REDACTION_MARKERS,
} from '../src/agent/utils/redaction/hiddenSpans.js';
import { applyAlignmentFloor, MAX_FLOOR_ROUNDS } from '../src/agent/utils/redaction/legacyFloor.js';
import { redactDeveloperText as fixtureAt1b394ce } from './fixtures/redaction-baselines/redaction-at-1b394ce.js';
import { redactDeveloperText as fixtureAt246055e } from './fixtures/redaction-baselines/redaction-at-246055e.js';
import { redactDeveloperText as fixtureAtB60a61e } from './fixtures/redaction-baselines/redaction-at-b60a61e.js';
import { redactDeveloperText as fixtureAtD113986 } from './fixtures/redaction-baselines/redaction-at-d113986.js';
import {
  assertNoLegacyRegression,
  checkNoLegacyRegression,
  exemptPositions,
} from './fixtures/redaction-catalog/legacyRegressionOracle.js';
import {
  type BaselineRevision,
  exactHidden,
  hiddenFromTracked,
  originTracked,
  replayTracked,
} from './fixtures/redaction-catalog/trackedReplay.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface CatalogEntry {
  id: string;
  expect: 'mask' | 'keep';
  input: string;
}

const catalog = JSON.parse(
  readFileSync(path.join(repoRoot, 'test/fixtures/redaction-catalog/catalog.json'), 'utf8')
) as { catalog: CatalogEntry[]; newFindings: CatalogEntry[] };

function inCarrier(input: string): string {
  return JSON.stringify({ stdout: input });
}

const corpusRows = [...catalog.catalog, ...catalog.newFindings].flatMap((entry) => [
  { id: entry.id, form: 'raw', input: entry.input },
  { id: entry.id, form: 'carrier', input: inCarrier(entry.input) },
]);

const PEM_BODY = `MIIEowIBAAKCAQEA${'SYNTHETIC'.repeat(5)}aaaa`;

describe('phase-1 legacy floor closes known regressions', () => {
  test.each([
    ['L-01 audited .env leak', 'JWT_SECRET=!SYNTHETICpw', ['SYNTHETICpw']],
    ['L-13 bracket split', 'password=Pa(ss)word1SYNTHETIC', ['word1SYNTHETIC']],
    ['L-13 semicolon split', 'DB_PASSWORD=abcSYNTHETIC;xyz123SYNTHETIC', ['xyz123SYNTHETIC']],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell 默认值写法，不是模板串。
    ['L-13 shell default', 'PASSWORD=${DB_PASS:-SYNTHETICdefault}', ['SYNTHETICdefault']],
    [
      'L-14 DSN tail',
      'password=postgres://admin:SYNTHETICpw@db.example.com/SYNTHETICdb',
      ['SYNTHETICdb', 'SYNTHETICpw'],
    ],
    [
      'L-15 PEM swallows next key',
      `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\npassword: SYNTHETICleak`,
      ['SYNTHETICleak'],
    ],
    [
      'V5-1 logfmt quote shift',
      'level=warn msg="retry with token: " token="SYNTHETICtok"',
      ['SYNTHETICtok'],
    ],
  ])('%s', (_name, input, secrets) => {
    const output = redactDeveloperText(input);
    for (const secret of secrets) {
      expect(output).not.toContain(secret);
    }
    expect(redactDeveloperText(output)).toBe(output);
    assertNoLegacyRegression(input);
  });

  test('keeps the current-rules rendering where no historical version masked more', () => {
    // 底线只补遮残差：现行规则已遮住、或历史版本也不遮的地方，输出与现行规则逐字相同。
    for (const input of [
      'Authorization: Bearer abcdefghijkl',
      '{\n  "password": 123456789,\n  "normal": 7\n}',
      'https://user:SYNTHETICpass@host.example/x',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpSYNTHETICbodyLINEone+/=\n-----END RSA PRIVATE KEY-----',
      'ordinary prose without credentials',
    ]) {
      expect(redactDeveloperText(input)).toBe(fixtureAtB60a61e(input));
    }
  });
});

describe('regression corpus: failure catalog and new findings (raw and carrier forms)', () => {
  test('the corpus has the 151 catalog entries and every new finding', () => {
    expect(catalog.catalog).toHaveLength(151);
    const ids = catalog.newFindings.map((entry) => entry.id);
    for (const required of [
      'N-L13a',
      'N-L14a',
      'N-L15a',
      'N-SAS2',
      'N-RENDER1',
      'N-RENDER2',
      'N-SERIAL1',
      'N-SERIAL2',
    ]) {
      expect(ids).toContain(required);
    }
    expect(corpusRows).toHaveLength((151 + catalog.newFindings.length) * 2);
  });

  test.each(corpusRows)('$id ($form) has zero regression against all four baselines', ({
    input,
  }) => {
    const report = assertNoLegacyRegression(input);
    expect(report.rounds).toBeLessThanOrEqual(MAX_FLOOR_ROUNDS);
  });

  test('the oracle is not vacuous: the current rules alone regress on the audited inputs', () => {
    // 只用现行规则（b60a61e）时，追踪重放必须报出相对 d113986 / 246055e 的露出；否则 oracle 是空转。
    const regressed: string[] = [];
    for (const entry of catalog.newFindings) {
      const current = hiddenFromTracked(
        replayTracked('b60a61e', originTracked(entry.input)),
        entry.input.length
      );
      for (const revision of ['246055e', '1b394ce', 'd113986'] as const) {
        const legacy = exactHidden(revision, entry.input);
        const exempt = exemptPositions(entry.input, legacy);
        if (
          legacy.some(
            (hidden, index) => hidden === 1 && current[index] === 0 && exempt[index] === 0
          )
        ) {
          regressed.push(`${entry.id}:${revision}`);
        }
      }
    }
    for (const required of [
      'N-L01:d113986',
      'N-L13a:246055e',
      'N-L14a:d113986',
      'N-L15a:246055e',
    ]) {
      expect(regressed).toContain(required);
    }
  });
});

const BLOB_IDS: Record<BaselineRevision, string> = {
  '246055e': 'f0a6f21a523807ec4cd129d94b40899c63520124',
  '1b394ce': 'feaa1229ca6eb2d6ce3019f13e74a287777a5551',
  d113986: 'c3e65b20e96c4f86d8ab22ad1bb35cefa1a88f20',
  b60a61e: '2a8dad0b5fbc6a585e9949d0c71536f96ff36bdb',
};

/**
 * 黄金摘要：git blob 原版（fixture，blob id 逐字节校验）在固定语料（目录与新发现的裸文本、载体两种形态）上的
 * 输出 sha256。语料变化时用 fixture 重新计算；冻结副本必须给出相同摘要。
 */
const GOLDEN_DIGESTS: Record<BaselineRevision, string> = {
  // 2026-10-21 阶段 4a 把 d0462bf 复查记录的载体家族（N-RQ1..3）与 M-12（N-M12a）加入 newFindings 后重算。
  '246055e': 'cb43b636a4b6ffaaea175f1c7299161b386a048525aafd8b098dfbe6ad4d42e7',
  '1b394ce': '424ee316b207cb540986c17f14393afdbab6f0a48c7b728985f2425d4c10e841',
  d113986: '8b12bb7623519716da7629e51a587faf6188480942b43658dc2e0115dd7e863a',
  b60a61e: '145b58113a19c7dc1904be31c2ad386375f8344b158f43fa63b63c02b234d10e',
};

function fixtureSource(revision: BaselineRevision): Buffer {
  return readFileSync(
    path.join(repoRoot, `test/fixtures/redaction-baselines/redaction-at-${revision}.ts`)
  );
}

function outputDigest(redact: (text: string) => string): string {
  const hash = createHash('sha256');
  for (const entry of [...catalog.catalog, ...catalog.newFindings]) {
    for (const input of [entry.input, inCarrier(entry.input)]) {
      hash.update(redact(input));
      hash.update('\u0000');
    }
  }
  return hash.digest('hex');
}

describe('proof obligations: frozen copies, golden digests and the marker vocabulary', () => {
  test.each(Object.entries(BLOB_IDS))('fixture %s is the exact git blob %s', (revision, blobId) => {
    const content = fixtureSource(revision as BaselineRevision);
    const sha1 = createHash('sha1')
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest('hex');
    expect(sha1).toBe(blobId);
  });

  test.each([
    ['246055e', 'redactAt246055e'],
    ['1b394ce', 'redactAt1b394ce'],
    ['d113986', 'redactAtD113986'],
    // v3 整段放在 namespace B60a61e 内（与 v2 的模块级标识符同名），块内文本仍与 blob 逐字节相同。
    ['b60a61e', 'redactAtB60a61e'],
  ] as const)('frozenBaselines.ts embeds blob %s verbatim, renaming only the export', (revision, name) => {
    const frozen = readFileSync(
      path.join(repoRoot, 'src/agent/utils/redaction/frozenBaselines.ts'),
      'utf8'
    );
    const blob = fixtureSource(revision).toString('utf8');
    const renamed = blob.replace(
      'export function redactDeveloperText(',
      `export function ${name}(`
    );
    expect(renamed).not.toBe(blob);
    expect(frozen.includes(renamed)).toBe(true);
  });

  test.each([
    ['246055e', redactAt246055e, fixtureAt246055e],
    ['1b394ce', redactAt1b394ce, fixtureAt1b394ce],
    ['d113986', redactAtD113986, fixtureAtD113986],
    ['b60a61e', redactAtB60a61e, fixtureAtB60a61e],
  ] as const)('golden digest of %s matches the git blob behaviour', (revision, frozen, fixture) => {
    expect(outputDigest(fixture)).toBe(GOLDEN_DIGESTS[revision]);
    expect(outputDigest(frozen)).toBe(GOLDEN_DIGESTS[revision]);
  });

  test('the frozen v3 is byte-identical in behaviour to the HEAD blob on every corpus row', () => {
    for (const { input } of corpusRows) {
      expect(redactAtB60a61e(input)).toBe(fixtureAtB60a61e(input));
    }
  });

  test('every marker literal in the redaction sources belongs to the closed vocabulary', () => {
    expect([...REDACTION_MARKERS].sort()).toEqual(
      [
        '[redacted]',
        '[redacted-api-key]',
        '[redacted-google-api-key]',
        '[redacted-nested-value]',
        '[redacted-private-key]',
        '[redacted-token]',
        '[redacted-unaligned]',
      ].sort()
    );
    const sources = [
      'src/agent/utils/Redaction.ts',
      'src/agent/utils/redaction/frozenBaselines.ts',
      'src/agent/utils/redaction/hiddenSpans.ts',
      'src/agent/utils/redaction/legacyFloor.ts',
      'src/agent/utils/redaction/trackedReplay.ts',
      'src/agent/utils/redaction/render.ts',
      ...Object.keys(BLOB_IDS).map(
        (revision) => `test/fixtures/redaction-baselines/redaction-at-${revision}.ts`
      ),
    ];
    const found = new Set<string>();
    for (const file of sources) {
      const text = readFileSync(path.join(repoRoot, file), 'utf8');
      for (const match of text.matchAll(/\[redacted[^\]'"`\s\\]*\]/g)) {
        found.add(match[0]);
      }
    }
    for (const marker of found) {
      expect(REDACTION_MARKERS, `${marker} must be in the closed vocabulary`).toContain(marker);
    }
    // 词法必须把每个标记识别为完整的核心标记，T_ABS 才能覆盖全部合成输出（证明义务 O1）。
    for (const marker of REDACTION_MARKERS) {
      for (const lexicon of ['abs', 'sub'] as const) {
        const tokens = lexMarkers(`a${marker}b`, lexicon);
        expect(tokens.map((token) => token.core)).toEqual([marker]);
      }
    }
    expect(lexMarkers('[redacted kv] [redacted-x] [REDACTED]', 'abs')).toEqual([]);
  });
});

interface BatteryItem {
  name: string;
  x: string;
  y: string;
  reencodes: boolean;
  /** 精确被遮位置（来自追踪重放或构造）。 */
  truth: Uint8Array;
  /** 健全对齐器在该项上对非豁免位置精确（超集 = 子集 = 真值）。 */
  exact: boolean;
}

function replayItem(
  name: string,
  revision: BaselineRevision,
  x: string,
  exact: boolean
): BatteryItem {
  return {
    name,
    x,
    y: fixtureFor(revision)(x),
    reencodes: revision === 'd113986' || revision === 'b60a61e',
    truth: exactHidden(revision, x),
    exact,
  };
}

function fixtureFor(revision: BaselineRevision): (text: string) => string {
  return {
    '246055e': fixtureAt246055e,
    '1b394ce': fixtureAt1b394ce,
    d113986: fixtureAtD113986,
    b60a61e: fixtureAtB60a61e,
  }[revision];
}

function constructedItem(
  name: string,
  x: string,
  y: string,
  hidden: Array<[number, number]>
): BatteryItem {
  const truth = new Uint8Array(x.length);
  for (const [start, end] of hidden) {
    truth.fill(1, start, end);
  }
  return { name, x, y, reencodes: false, truth, exact: false };
}

/** 变异测试电池：每一项都能区分至少一种错误实现；健全实现在全部项上无违规。 */
const BATTERY: BatteryItem[] = [
  // 放置有歧义：保留段 " x token=" 在被遮的引号值里也出现一次（对调最早/最晚位置会漏掉它）。
  replayItem('ambiguous piece', '1b394ce', '"token": "z x token=" x token=BBBBBBBB x', false),
  // 首段文本在被遮值里重复：去掉锚定会让子集变小（精度回归）。
  replayItem('repeated anchored prefix', '246055e', 'token=token=AAAAAAAA', true),
  // 合成段吸收的转义换行是原文保留的：不修剪就会把它算成“一定被遮”。这里的 \n 是裸文本里的两个字符
  // （不在可解析的 JSON 字面量内），所以它不是结构位置，仍按内容判定。
  replayItem('absorbed escape newline', 'b60a61e', 'password="abcdefgh"\\nfoo', false),
  // 载体内的转义换行按 D3 阶段 4 子项视为结构（信息等价），健全对齐器在它上面也不得违规。
  replayItem('carrier escape newline', 'b60a61e', '{"stdout":"password=abcdefgh\\nfoo"}', false),
  // 复查意见 1：被遮值的末字符是 n，后面是版本重出的转义换行记号 \n。按字符做最长公共后缀会把记号的 n
  // 与值的 n 当成同一位置，超集漏掉这个 n；修剪必须按整个记号进行。
  replayItem(
    'value ending in n before a re-emitted escape newline',
    'd113986',
    '{"stdout":"password=\\"abcdefgh\\nxn\\" rest"}',
    false
  ),
  replayItem(
    'value ending in a literal backslash-n before a re-emitted escape newline',
    'd113986',
    '{"stdout":"password=\\"abcdefgh\\\\n\\nxn\\" rest"}',
    false
  ),
  replayItem('json number value', 'b60a61e', '{"password": 123456789, "normal": 7}', true),
  // 构造项：保留段字节被改写（模拟不在守卫内的重编码），放不回去时必须整行算作可能被遮。
  constructedItem(
    'foreign piece',
    'PREFIX token=SECRETVALUE tail',
    'prefix token=[redacted] tail',
    [
      [0, 6],
      [13, 24],
    ]
  ),
  // 构造项：两个标记之间夹着原文保留的转义换行，位置无法确定，子集不得断言它。
  constructedItem('inner absorbed escape', 'SECRET1\\nSECRET2', '[redacted]\\n[redacted]', [
    [0, 7],
    [9, 16],
  ]),
];

function batteryViolations(item: BatteryItem, mutation?: AlignerMutation): string[] {
  const exempt = exemptPositions(item.x, item.truth);
  const superset = hiddenSuperset(item.x, item.y, { reencodes: item.reencodes, mutation }).marks;
  const subset = hiddenSubset(item.x, item.y, { reencodes: item.reencodes, mutation }).marks;
  const violations: string[] = [];
  for (let index = 0; index < item.x.length; index++) {
    if (exempt[index] === 1) {
      continue;
    }
    if (item.truth[index] === 1 && superset[index] !== 1) {
      violations.push(`${item.name}: superset misses ${index}`);
    }
    if (item.truth[index] !== 1 && subset[index] === 1) {
      violations.push(`${item.name}: subset over-claims ${index}`);
    }
    if (
      item.exact &&
      (superset[index] !== item.truth[index] || subset[index] !== item.truth[index])
    ) {
      violations.push(`${item.name}: imprecise at ${index}`);
    }
  }
  return violations;
}

describe('aligner mutation testing against the exact oracle', () => {
  test('the sound aligner has no violation on the battery', () => {
    expect(BATTERY.flatMap((item) => batteryViolations(item))).toEqual([]);
  });

  test.each([
    'swap-earliest-latest',
    'drop-anchors',
    'ignore-wild',
    'skip-inner-absorbed',
    'no-subset-trim',
  ] as const)('mutant %s is killed', (mutation) => {
    expect(BATTERY.flatMap((item) => batteryViolations(item, mutation)).length).toBeGreaterThan(0);
  });
});

describe('R-Q boundary trimming is token-based (review item 1)', () => {
  // 载体内多行引号值：末字符为 n、末尾为字面 \n、或两者与裸换行组合。历史版本在值后重出的转义换行记号 \n
  // 以 n 结尾，按字符修剪会把它与值的末字符 n 对到同一位置，测试期对齐自检报 superset misses；按记号修剪后归零。
  const keys = ['GITHUB_TOKEN', 'token', 'password', 'api_key'];
  const separators = [':', '=', ': ', ':\n'];
  const bodies = [
    'SYNTHETICabc\nxn',
    'SYNTHETICabc\nqn\n',
    'SYNTHETICabn',
    'SYNTHETICabc\\n',
    'SYNTHETICabc\\n\n',
    'SYNTHETICabc\\n\nxn',
    'SYNTHETICabc\n\\n',
    'SYNTHETICabr\n',
  ];
  const suffixes = [' rest', '\nnext', '"other"'];
  const wraps = [
    (text: string) => JSON.stringify({ stdout: text }),
    (text: string) => JSON.stringify([text]),
    (text: string) => JSON.stringify({ message: JSON.stringify({ stdout: text }) }),
    (text: string) => text,
  ];
  const family: string[] = [];
  for (const key of keys) {
    for (const separator of separators) {
      for (const body of bodies) {
        for (const suffix of suffixes) {
          for (const wrap of wraps) {
            family.push(wrap(`${key}${separator}"${body}"${suffix}`));
          }
        }
      }
    }
  }

  test('the family has zero aligner violations, exposures and structural violations', () => {
    const problems: string[] = [];
    for (const input of family) {
      const report = checkNoLegacyRegression(input);
      problems.push(
        ...report.exposures.map(
          (exposure) => `${exposure.oracle} ${exposure.baseline}@${exposure.position}`
        ),
        ...report.alignerViolations,
        ...report.structuralViolations
      );
    }
    expect(family.length).toBeGreaterThan(1_000);
    expect(problems.slice(0, 10)).toEqual([]);
  });

  test('the superset of each early version keeps the trailing n of the masked value', () => {
    let checked = 0;
    for (const input of family) {
      for (const revision of ['246055e', '1b394ce', 'd113986'] as const) {
        const truth = exactHidden(revision, input);
        const exempt = exemptPositions(input, truth);
        const superset = hiddenSuperset(input, fixtureFor(revision)(input), {
          reencodes: revision === 'd113986',
        }).marks;
        for (let index = 0; index < input.length; index++) {
          if (truth[index] === 1 && exempt[index] === 0) {
            checked++;
            expect(superset[index], `${revision} ${JSON.stringify(input)} @${index}`).toBe(1);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  test('the alignment fallback path still masks the family and conserves newlines', () => {
    for (const input of family.filter((_, index) => index % 7 === 0)) {
      const { text } = applyAlignmentFloor(input);
      expect(text).not.toMatch(/SYNTHETIC/);
      expect(text.replace(/[^\r\n]/g, '')).toBe(input.replace(/[^\r\n]/g, ''));
    }
  });
});

describe('tracked replay as an independent position oracle', () => {
  test('the superset of each early version contains every replayed hidden position', () => {
    let checked = 0;
    for (const { input } of corpusRows) {
      for (const revision of ['246055e', '1b394ce', 'd113986'] as const) {
        const truth = exactHidden(revision, input);
        const exempt = exemptPositions(input, truth);
        const superset = hiddenSuperset(input, fixtureFor(revision)(input), {
          reencodes: revision === 'd113986',
        }).marks;
        for (let index = 0; index < input.length; index++) {
          if (truth[index] === 1 && exempt[index] === 0) {
            checked++;
            expect(superset[index], `${revision} ${JSON.stringify(input)} @${index}`).toBe(1);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  test('the subset of the current rules never claims a replayed visible position', () => {
    for (const { input } of corpusRows) {
      const truth = exactHidden('b60a61e', input);
      const exempt = exemptPositions(input, truth);
      const subset = hiddenSubset(input, fixtureAtB60a61e(input), { reencodes: true }).marks;
      for (let index = 0; index < input.length; index++) {
        if (subset[index] === 1 && exempt[index] === 0) {
          expect(truth[index], `${JSON.stringify(input)} @${index}`).toBe(1);
        }
      }
    }
  });
});

describe('RED-P4a2 item 5: the d0462bf carrier newline exposure stays closed', () => {
  // 第五轮审计第 3 条：d0462bf 的 R-Q 修剪把载体里引号值末尾的转义换行（与 d113986 重出的 \n 逐字相同）扣出
  // 超集，补遮漏掉它，replay 相对 d113986 报出 @128、@129；多行值以 n 结尾时还会露出秘密的末字母。HEAD 起该
  // 转义换行在 JSON 载体里是 D3 结构（按原形态放回），修剪按整个记号进行，这些输入必须一直零露出、零对齐违规。
  const body = `MIIEowIBAAKCAQEA${'SYNTHAQ'.repeat(6)}abcd`;
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n`;
  test.each([
    [
      'password value ending in an escaped newline',
      JSON.stringify({ stdout: `${pem}password: "SYNTHrq1\n"` }),
    ],
    [
      'api_key value with two escaped newlines',
      JSON.stringify({ stdout: `${pem}api_key: "SYNTHrq1\n\n"` }),
    ],
    [
      'double carrier',
      JSON.stringify({ message: JSON.stringify({ stdout: `${pem}password: "SYNTHrq1\n"` }) }),
    ],
    [
      'multi-line value whose last letter is n',
      JSON.stringify({ stdout: `${pem}password: "SYNTH\nxqzn"` }),
    ],
    ['single-quoted value with CRLF', JSON.stringify({ stdout: `${pem}password: 'SYNTHrq1\r\n'` })],
  ])('%s: no exposure and no aligner violation', (_name, input) => {
    const report = assertNoLegacyRegression(input);
    expect(report.exposures).toEqual([]);
    expect(report.alignerViolations).toEqual([]);
    expect(report.output).not.toMatch(/SYNTH/);
  });

  test('the exact audited input renders like HEAD and keeps the escaped newline as structure', () => {
    const input = JSON.stringify({ stdout: `${pem}password: "SYNTHrq1\n"` });
    const { text, report } = redactDeveloperTextWithReport(input);
    expect(text).toBe(
      '{"stdout":"-----BEGIN RSA PRIVATE KEY-----\\n[redacted-private-key]\\n: \\"[redacted]\\n\\""}'
    );
    expect(report.renderSkeletons).toBe(0);
    expect((JSON.parse(text) as { stdout: string }).stdout.endsWith('[redacted]\n"')).toBe(true);
  });
});

describe('fail-closed paths and the diagnostic report', () => {
  test('the report carries counts and kinds only, never text', () => {
    const input = 'JWT_SECRET=!SYNTHETICpw and password=Pa(ss)word1SYNTHETIC';
    const { text, report } = redactDeveloperTextWithReport(input);
    expect(text).toBe(redactDeveloperText(input));
    expect(report.fixpointReached).toBe(true);
    expect(report.residualChars).toBeGreaterThan(0);
    expect(report.kinds).toContain('residual-patched');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/SYNTHETIC|JWT_SECRET|password/);
    for (const value of Object.values(report)) {
      expect(['number', 'boolean', 'object']).toContain(typeof value);
    }
  });

  test('clean text short-circuits after one round with an empty report', () => {
    const { text, report } = redactDeveloperTextWithReport('const total = items.length;');
    expect(text).toBe('const total = items.length;');
    expect(report).toMatchObject({ rounds: 1, fixpointReached: true, residualChars: 0, kinds: [] });
  });

  test('alignment path: a current-rules output that breaks newline conservation falls back to the line skeleton', () => {
    const input = 'line one\nJWT_SECRET=!SYNTHETICpw\n\nlast';
    // 构造的“现行规则”只在含合成秘密时多吐一个换行（不守恒），骨架兜底之后即收敛。
    const { text, report } = applyAlignmentFloor(input, (value) =>
      value.includes('SYNTHETIC') ? `${value}\n` : value
    );
    expect(text).toBe('[redacted-unaligned]\n[redacted-unaligned]\n\n[redacted-unaligned]');
    expect(report.skeletonFallbacks).toBeGreaterThan(0);
    expect(report.kinds).toContain('skeleton-fallback');
    expect(report.kinds).toContain('alignment-fallback');
  });

  test('alignment path: a never-settling current-rules output stops at the round cap and says so', () => {
    const { report } = applyAlignmentFloor('plain', (value) => `${value}.`);
    expect(report.rounds).toBe(MAX_FLOOR_ROUNDS);
    expect(report.fixpointReached).toBe(false);
    expect(report.kinds).toContain('fixpoint-cap');
  });

  test('alignment path: a line the current rules re-encoded from a non-canonical carrier is masked whole', () => {
    const input = JSON.stringify({ stdout: 'x' }).replace(
      '"x"',
      '"\\u0041 JWT_SECRET=!SYNTHETICpw password=Pa(ss)word1SYNTHETIC"'
    );
    const { text, report } = applyAlignmentFloor(input);
    expect(text).not.toContain('SYNTHETIC');
    expect(report.kinds).toEqual(expect.arrayContaining(['guarded-line']));
  });

  test('tracked replay keeps a non-canonical carrier byte-exact outside the masked spans', () => {
    // 阶段 1 的对齐路径只能把这一行整行补遮；追踪重放知道 \u0041 解码后仍是可见字符，只遮住历史版本遮住的值。
    const input = JSON.stringify({ stdout: 'x' }).replace(
      '"x"',
      '"\\u0041 JWT_SECRET=!SYNTHETICpw password=Pa(ss)word1SYNTHETIC"'
    );
    const { text, report } = redactDeveloperTextWithReport(input);
    expect(text).toBe('{"stdout":"\\u0041 JWT_SECRET=[redacted] password=[redacted]"}');
    expect(report.kinds).not.toContain('guarded-line');
    expect(report.replayMismatches).toBe(0);
    assertNoLegacyRegression(input);
  });
});
