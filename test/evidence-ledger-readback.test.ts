/**
 * 脱敏阶段 2（方案 C，D4）：循环台账落盘仍脱敏，evidence.get 对带 range 的 code.read 条目在 fresh 时
 * 回读文件原文；进程内 HMAC 原文摘要判 freshness。对应设计第 6 节阶段 2 的测试要求 1–4、6、7：
 *
 * 1. 证据保真探针 P5 反例转正例：`apiKey: this.apiKey,` 经入账、`E-1@2-5`、prepareRecipeProductionItem
 *    得到 bounded-match；照抄脱敏内容时记 copied-redacted-evidence 诊断。
 * 2. 探针 P3 的 4 个假 fresh 样本在同一进程内判 stale；没有摘要的条目（seed、跨进程）退回脱敏哈希，
 *    行为与现状相同；规则变化不再让同一进程内的条目误判 stale。
 * 3. stale 或文件不可读时返回存储内容并附 redaction 标注；secret-bearing 文件不回读并丢弃 range。
 * 4. 只读一次缓冲区，判定与返回是同一份字节（并发改写）；路径越出项目根时拒绝。
 * 6. 宿主 capture facet 行为不变（不丢 range、内容同旧管线、storeConfigHash 公式不变）。
 * 7. I26 意图在消费者层重新断言：`password: string;`、`if (token === null)` 等源码经 evidence.get
 *    回读后与文件逐字节一致；回读原文不写回台账，开发者事件仍经 processEvents 脱敏。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { captureEvidenceFromEnvelope } from '../src/agent/evidence/EvidenceCapture.js';
import {
  EvidenceLedgerStore,
  seedLedgerFromJobSiblings,
} from '../src/agent/evidence/EvidenceLedgerStore.js';
import {
  createProductionEvidenceLedgerAuthority,
  resolveProductionEvidenceLedgerStore,
} from '../src/agent/evidence/ProductionEvidenceLedgerAuthority.js';
import { projectToolEndEvent } from '../src/agent/runtime/processEvents.js';
import { redactDeveloperText } from '../src/agent/utils/Redaction.js';
import { handle as handleEvidence } from '../src/tools/runtime/handlers/evidence.js';
import { prepareRecipeProductionItem } from '../src/tools/runtime/handlers/recipeProductionAdapter.js';
import { createTempProject } from './helpers/tempProject.js';

type EvidenceHandlerCtx = Parameters<typeof handleEvidence>[2];

interface ReadbackData {
  id: string;
  file?: string;
  range?: { start: number; end: number };
  lineCount: number;
  capped: boolean;
  content: string;
  verbatim?: boolean;
  redaction?: { markers: number; lines: number[] };
  hint?: string;
}

const COORDINATES = {
  jobId: 'job_readback',
  sessionId: 'sess_readback',
  dimensionId: 'ts-js-module',
} as const;

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

function writeProjectFile(root: string, relative: string, content: string): string {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
  return absolute;
}

/** 生产同款循环台账：public factory 打开 authority，再取回同一私有 store（与 openLoopEvidence 一致）。 */
function openLoopLedger(dataRoot: string): EvidenceLedgerStore {
  const authority = createProductionEvidenceLedgerAuthority({ dataRoot, ...COORDINATES });
  return resolveProductionEvidenceLedgerStore(authority);
}

/** 跨进程续跑视角：同一台账的新实例，只有磁盘内容，没有进程内原文摘要。 */
function reopenLedger(dataRoot: string): EvidenceLedgerStore {
  return new EvidenceLedgerStore({ dataRoot, ...COORDINATES, redactor: redactDeveloperText });
}

function sourceLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && text.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

/**
 * 没有原文摘要时的独立 oracle：整文件条目按“同区间重切 + 同脱敏”比哈希（样本都远小于单条上限，
 * 不涉及截断）。用于断言 seed / 跨进程条目的结论与阶段 2 之前一致。
 */
function redactedHashVerdict(before: string, after: string): 'fresh' | 'stale' {
  const slice = (text: string) => sourceLines(text).join('\n');
  const digest = (text: string) =>
    createHash('sha256')
      .update(redactDeveloperText(slice(text)))
      .digest('hex');
  return digest(before) === digest(after) ? 'fresh' : 'stale';
}

/** 按 code.read 的 range 展示形态（`N|` 前缀）构造信封，经循环采集路径入账。 */
function captureRead(
  ledger: EvidenceLedgerStore,
  relative: string,
  fileText: string,
  range?: { start: number; end: number },
  callId = `read-${relative}`
) {
  const lines = sourceLines(fileText);
  const start = range?.start ?? 1;
  const end = range?.end ?? lines.length;
  const display = lines
    .slice(start - 1, end)
    .map((line, index) => `${start + index}|${line}`)
    .join('\n');
  return captureEvidenceFromEnvelope(
    ledger,
    {
      id: callId,
      name: 'code',
      args: { action: 'read', params: { filePaths: [relative], startLine: start, endLine: end } },
    },
    {
      ok: true,
      text: 'batch read',
      structuredContent: {
        mode: 'batch',
        files: [
          {
            ok: true,
            path: relative,
            content: display,
            lineCount: lines.length,
            mode: range ? 'range' : 'full',
            ...(range ? { startLine: start, endLine: end } : {}),
          },
        ],
      },
    }
  );
}

function evidenceCtx(ledger: unknown, projectRoot?: string): EvidenceHandlerCtx {
  // handler 只消费 projectRoot 与 runtime.evidenceLedger——最小运行时形态经 unknown 收窄
  return {
    ...(projectRoot ? { projectRoot } : {}),
    runtime: { evidenceLedger: ledger },
  } as unknown as EvidenceHandlerCtx;
}

async function evidenceGet(ledger: unknown, ref: string, projectRoot?: string) {
  const result = await handleEvidence('get', { ref }, evidenceCtx(ledger, projectRoot));
  expect(result.ok, String(result.error)).toBe(true);
  return result.data as ReadbackData;
}

/** 统计某个文件被 readFileSync 读取的次数；可选在读取前/后模拟并发改写。 */
function spyFileReads(
  matches: (file: string) => boolean,
  options: { beforeRead?: () => void; afterRead?: () => void } = {}
): { count: () => number; paths: string[] } {
  const original = fs.readFileSync;
  const paths: string[] = [];
  let count = 0;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest) => {
    const target = String(file);
    paths.push(target);
    if (matches(target)) {
      count += 1;
      options.beforeRead?.();
      const value = Reflect.apply(original, fs, [file, ...rest]);
      options.afterRead?.();
      return value;
    }
    return Reflect.apply(original, fs, [file, ...rest]);
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();
  return { count: () => count, paths };
}

const CLIENT_SOURCE = [
  'export function buildHeaders(this: Client) {',
  '  return {',
  '    apiKey: this.apiKey,',
  "    accept: 'application/json',",
  '  };',
  '}',
  'export const VERSION = 1;',
  "export const NAME = 'client';",
  'export const READY = true;',
  '',
].join('\n');

describe('测试要求 1：P5 反例转正例（coreCode 不再被剥除）', () => {
  test('apiKey: this.apiKey 经入账与 E-1@2-5 回读后作为 coreCode 得到 bounded-match', async () => {
    const root = createTempProject('readback-p5-');
    writeProjectFile(root, 'src/client.ts', CLIENT_SOURCE);
    const ledger = openLoopLedger(root);
    const [entry] = captureRead(ledger, 'src/client.ts', CLIENT_SOURCE, { start: 1, end: 7 });
    expect(entry?.range).toEqual({ start: 1, end: 7 });
    // 落盘仍脱敏（方案 C 不新增原文副本）
    expect(entry?.content).not.toContain('this.apiKey');

    const data = await evidenceGet(ledger, 'E-1@2-5', root);
    expect(data.verbatim).toBe(true);
    expect(data.content).toBe(sourceLines(CLIENT_SOURCE).slice(1, 5).join('\n'));
    expect(data.redaction).toBeUndefined();

    const prepared = prepareRecipeProductionItem(
      { title: 'Client headers', sourceRefs: ['src/client.ts:1-7'], coreCode: data.content },
      root
    );
    expect(prepared.codeEvidence).toEqual({
      accepted: true,
      reason: 'bounded-match',
      provenanceRef: 'src/client.ts:1-7',
    });
  });

  test('照抄脱敏后的台账内容仍被拒，并记 copied-redacted-evidence 诊断与重试提示（枚举不扩充）', () => {
    const root = createTempProject('readback-p5-copied-');
    writeProjectFile(root, 'src/client.ts', CLIENT_SOURCE);
    const ledger = openLoopLedger(root);
    captureRead(ledger, 'src/client.ts', CLIENT_SOURCE, { start: 1, end: 7 });
    const stored = ledger.get('E-1@2-5')?.content ?? '';
    expect(stored).toContain('[redacted');
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);

    const prepared = prepareRecipeProductionItem(
      { title: 'Client headers', sourceRefs: ['src/client.ts:1-7'], coreCode: stored },
      root
    );
    expect(prepared.codeEvidence).toEqual({ accepted: false, reason: 'unbounded-or-unrelated' });
    const messages = warn.mock.calls.map((call) => String(call[0]));
    const diagnostic = messages.find((message) => message.includes('copied-redacted-evidence'));
    expect(diagnostic).toBeDefined();
    expect(diagnostic).toContain('evidence.get');
    expect(diagnostic).toContain('code.read');
    // 诊断不含片段正文
    expect(diagnostic).not.toContain('accept:');
  });

  test('coreCode 只是文件里本来就有的 [redacted] 字面量且与证据匹配时不记该诊断', () => {
    const root = createTempProject('readback-literal-marker-');
    const source = [
      "export const MARKER = '[redacted]';",
      'export function mask(value: string): string {',
      '  return value.length > 0 ? MARKER : value;',
      '}',
      'export const A = 1;',
      'export const B = 2;',
      '',
    ].join('\n');
    writeProjectFile(root, 'src/mask.ts', source);
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const prepared = prepareRecipeProductionItem(
      {
        title: 'Mask marker',
        sourceRefs: ['src/mask.ts:1-4'],
        coreCode: "export const MARKER = '[redacted]';",
      },
      root
    );
    expect(prepared.codeEvidence.accepted).toBe(true);
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes('copied-redacted-evidence'))
    ).toBe(false);
  });
});

const FALSE_FRESH_SAMPLES = [
  {
    name: 'PEM 注释吞掉后续代码',
    file: 'tools/pem.py',
    before: '# Strip the -----BEGIN PRIVATE KEY----- header\ndef strip(pem):\n    return pem\n',
    mutate: (text: string) => text.replace('def strip', 'def strap'),
  },
  {
    name: 'URL 模板占位被改写',
    file: 'src/db.ts',
    before: `const url = \`postgres://\${user}:\${password}@\${host}/db\`;\nexport default url;\n`,
    mutate: (text: string) => text.replace(`\${password}`, `\${passwd}`),
  },
  {
    name: 'suffix 键吞掉值',
    file: 'src/token.ts',
    before: "const token = typeof value === 'string' ? value : '';\nexport { token };\n",
    mutate: (text: string) => text.replace('typeof', 'String'),
  },
  {
    name: '容器未闭合吞到文末',
    file: 'src/cfg.js',
    before: 'const cfg = { password: "abc\nconst after = 1;\nconsole.log(after);\n',
    mutate: (text: string) =>
      text.replace('const after = 1;', 'const after = 2;').replace('console.log', 'process.exit'),
  },
] as const;

describe('测试要求 2：进程内原文摘要消除假 fresh', () => {
  test.each(
    FALSE_FRESH_SAMPLES
  )('$name：同一进程内判 stale，跨进程（无摘要）退回脱敏哈希与现状一致', ({
    file,
    before,
    mutate,
  }) => {
    const root = createTempProject('readback-p3-');
    writeProjectFile(root, file, before);
    const ledger = openLoopLedger(root);
    const [entry] = captureRead(ledger, file, before);
    expect(entry?.range).toBeDefined();
    // 样本本身确实被脱敏改写过，变化落在被遮区间里（这正是假 fresh 的来源）
    expect(entry?.content).not.toBe(sourceLines(before).join('\n'));
    const after = mutate(before);
    expect(after).not.toBe(before);

    expect(ledger.checkFreshness(entry?.id ?? '', before)).toBe('fresh');
    expect(ledger.checkFreshness(entry?.id ?? '', after)).toBe('stale');

    // 跨进程续跑：新实例没有原文摘要，退回现有脱敏哈希比对（与现状相同，含已知盲区）。
    // 期望值按当前 redactor 现算而不写死：在 b3dbe90 的规则下这 4 个样本都是假 fresh（设计 2.3 节
    // P3），阶段 1 并行改动规则后结论仍应等于“同尺脱敏哈希”的结论。
    const reopened = reopenLedger(root);
    expect(reopened.checkFreshness(entry?.id ?? '', before)).toBe('fresh');
    expect(reopened.checkFreshness(entry?.id ?? '', after)).toBe(
      redactedHashVerdict(before, after)
    );
  });

  test('对照组：改动落在脱敏范围之外，两条路径都判 stale', () => {
    const root = createTempProject('readback-p3-control-');
    const before = 'a = 1\nb = 2\n';
    writeProjectFile(root, 'src/plain.py', before);
    const ledger = openLoopLedger(root);
    const [entry] = captureRead(ledger, 'src/plain.py', before);
    expect(ledger.checkFreshness(entry?.id ?? '', 'a = 9\nb = 2\n')).toBe('stale');
    expect(reopenLedger(root).checkFreshness(entry?.id ?? '', 'a = 9\nb = 2\n')).toBe('stale');
  });

  test('seed 进来的条目没有原文摘要，退回脱敏哈希，行为与现状相同', () => {
    const root = createTempProject('readback-seed-');
    const sibling = openLoopLedger(root);
    for (const sample of FALSE_FRESH_SAMPLES) {
      writeProjectFile(root, sample.file, sample.before);
      captureRead(sibling, sample.file, sample.before);
    }
    writeProjectFile(root, 'src/plain.py', 'a = 1\nb = 2\n');
    captureRead(sibling, 'src/plain.py', 'a = 1\nb = 2\n');

    const synthesis = new EvidenceLedgerStore({
      dataRoot: root,
      jobId: COORDINATES.jobId,
      sessionId: 'sess_synthesis',
      dimensionId: 'agent-guidelines',
      redactor: redactDeveloperText,
    });
    expect(
      seedLedgerFromJobSiblings(synthesis, {
        dataRoot: root,
        jobId: COORDINATES.jobId,
        selfDimensionId: 'agent-guidelines',
      })
    ).toBe(FALSE_FRESH_SAMPLES.length + 1);

    FALSE_FRESH_SAMPLES.forEach((sample, index) => {
      const id = `E-${index + 1}`;
      // 若误把已脱敏的 seed 内容记成原文摘要，未改动的文件会被永久判 stale
      expect(synthesis.checkFreshness(id, sample.before), sample.name).toBe('fresh');
      const after = sample.mutate(sample.before);
      expect(synthesis.checkFreshness(id, after), sample.name).toBe(
        redactedHashVerdict(sample.before, after)
      );
    });
    const controlId = `E-${FALSE_FRESH_SAMPLES.length + 1}`;
    expect(synthesis.checkFreshness(controlId, 'a = 1\nb = 2\n')).toBe('fresh');
    expect(synthesis.checkFreshness(controlId, 'a = 9\nb = 2\n')).toBe('stale');
  });

  test('脱敏规则在同一进程内变化不再让条目误判 stale（摘要按原文比对）', () => {
    const root = createTempProject('readback-rule-change-');
    let ruleVersion = 1;
    const evolvingRedactor = (text: string) =>
      text.replace(/SYNTHETIC\w+/g, ruleVersion === 1 ? '[redacted]' : '[redacted-token]');
    const ledger = new EvidenceLedgerStore({
      dataRoot: root,
      ...COORDINATES,
      redactor: evolvingRedactor,
    });
    const source = 'const a = 1;\nconst key = SYNTHETICvalue;\n';
    const entry = ledger.append({
      tool: 'code.read',
      callId: 'c1',
      file: 'src/a.ts',
      range: { start: 1, end: 2 },
      content: sourceLines(source).join('\n'),
    });
    ruleVersion = 2;
    expect(ledger.checkFreshness(entry.id, source)).toBe('fresh');
    const reopened = new EvidenceLedgerStore({
      dataRoot: root,
      ...COORDINATES,
      redactor: evolvingRedactor,
    });
    // 没有摘要的实例仍按旧尺比对，规则一变就判 stale（现状，阶段 1 已接受的一次性代价）
    expect(reopened.checkFreshness(entry.id, source)).toBe('stale');
  });

  test('freshness 诊断说明走了哪条路径，且不含正文', () => {
    const root = createTempProject('readback-freshness-log-');
    writeProjectFile(root, 'src/client.ts', CLIENT_SOURCE);
    const ledger = openLoopLedger(root);
    captureRead(ledger, 'src/client.ts', CLIENT_SOURCE, { start: 1, end: 7 });
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    ledger.checkFreshness('E-1', CLIENT_SOURCE);
    reopenLedger(root).checkFreshness('E-1', CLIENT_SOURCE);
    const logged = debug.mock.calls.map((call) => JSON.stringify(call));
    const viaDigest = logged.find((line) => line.includes('source-digest'));
    const viaRedacted = logged.find((line) => line.includes('redacted-hash'));
    expect(viaDigest).toBeDefined();
    expect(viaRedacted).toBeDefined();
    expect(viaRedacted).toContain('no-source-digest');
    for (const line of [viaDigest, viaRedacted]) {
      expect(line).not.toContain('this.apiKey');
      expect(line).not.toContain('application/json');
    }
  });
});

describe('测试要求 3：stale / 不可读返回存储内容并附标注；secret-bearing 不回读', () => {
  test('stale：返回存储内容，附 redaction 标注与 code.read 提示', async () => {
    const root = createTempProject('readback-stale-');
    const absolute = writeProjectFile(root, 'src/client.ts', CLIENT_SOURCE);
    const ledger = openLoopLedger(root);
    captureRead(ledger, 'src/client.ts', CLIENT_SOURCE, { start: 1, end: 7 });
    fs.writeFileSync(absolute, CLIENT_SOURCE.replace('application/json', 'text/plain'), 'utf8');
    const stored = ledger.get('E-1@2-5')?.content ?? '';

    const data = await evidenceGet(ledger, 'E-1@2-5', root);
    expect(data.verbatim).toBe(false);
    expect(data.content).toBe(stored);
    expect(data.redaction?.markers).toBeGreaterThanOrEqual(1);
    // 标注行号用文件行号：`apiKey: [redacted]` 在第 3 行
    expect(data.redaction?.lines).toContain(3);
    expect(data.hint).toContain('code.read');
    expect(data.hint).toContain('src/client.ts:2-5');
  });

  test('文件不可读（已删除）：返回存储内容与标注，不抛错', async () => {
    const root = createTempProject('readback-missing-');
    const absolute = writeProjectFile(root, 'src/client.ts', CLIENT_SOURCE);
    const ledger = openLoopLedger(root);
    captureRead(ledger, 'src/client.ts', CLIENT_SOURCE, { start: 1, end: 7 });
    fs.rmSync(absolute);
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);

    const data = await evidenceGet(ledger, 'E-1', root);
    expect(data.verbatim).toBe(false);
    expect(data.content).toBe(ledger.get('E-1')?.content);
    expect(data.redaction?.markers).toBeGreaterThanOrEqual(1);
    expect(data.hint).toContain('code.read');
    const logged = info.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes('reason=unreadable'))).toBe(true);
  });

  test('未注入项目根时不回读，返回存储内容与标注', async () => {
    const root = createTempProject('readback-no-root-');
    writeProjectFile(root, 'src/client.ts', CLIENT_SOURCE);
    const ledger = openLoopLedger(root);
    captureRead(ledger, 'src/client.ts', CLIENT_SOURCE, { start: 1, end: 7 });
    const data = await evidenceGet(ledger, 'E-1');
    expect(data.verbatim).toBe(false);
    expect(data.content).toBe(ledger.get('E-1')?.content);
  });

  test('secret-bearing 文件（.env）经循环采集丢弃 range，evidence.get 不回读', async () => {
    const root = createTempProject('readback-env-');
    const envText = 'DB_PASSWORD=SYNTHETICpw0123\nAPI_TOKEN=SYNTHETICtoken0123\nPORT=8080\n';
    writeProjectFile(root, '.env', envText);
    const ledger = openLoopLedger(root);
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const [entry] = captureRead(ledger, '.env', envText, { start: 1, end: 3 });
    expect(entry?.file).toBe('.env');
    expect(entry?.range).toBeUndefined();
    expect(entry?.content).not.toContain('SYNTHETIC');
    const persisted = JSON.parse(fs.readFileSync(ledger.filePath, 'utf8').trim());
    expect(persisted.range).toBeUndefined();
    expect(
      info.mock.calls.some((call) =>
        String(call[0]).includes('secret-bearing file recorded without range')
      )
    ).toBe(true);

    const reads = spyFileReads((file) => file.endsWith(`${path.sep}.env`));
    const data = await evidenceGet(ledger, 'E-1', root);
    expect(data.verbatim).not.toBe(true);
    expect(data.content).not.toContain('SYNTHETIC');
    expect(reads.count()).toBe(0);
  });

  test('仍带 range 的 secret-bearing 旧条目也不回读（按类别拒绝，不读文件）', async () => {
    const root = createTempProject('readback-env-legacy-');
    const envText = 'DB_PASSWORD=SYNTHETICpw0123\nPORT=8080\n';
    writeProjectFile(root, 'config/.env.production', envText);
    const ledger = openLoopLedger(root);
    // 升级前的循环台账或宿主 capture 写入的条目仍带 range
    ledger.append({
      tool: 'code.read',
      callId: 'legacy',
      file: 'config/.env.production',
      range: { start: 1, end: 2 },
      content: sourceLines(envText).join('\n'),
    });
    const reads = spyFileReads((file) => file.endsWith('.env.production'));
    const data = await evidenceGet(ledger, 'E-1', root);
    expect(data.verbatim).toBe(false);
    expect(data.content).not.toContain('SYNTHETIC');
    expect(data.hint).toContain('凭据');
    expect(reads.count()).toBe(0);
  });

  test('根内 symlink 指向 secret-bearing 文件：按解析后的真实路径拒绝回读', async () => {
    const root = createTempProject('readback-symlink-env-');
    const envText = 'password: SYNTHETICyamlpw\nport: 8080\n';
    writeProjectFile(root, '.env', envText);
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.symlinkSync(path.join(root, '.env'), path.join(root, 'config', 'app.yml'));
    const ledger = openLoopLedger(root);
    // 采集时 config/app.yml 的内容与 .env 相同：若只按声明路径分类，摘要会判 fresh 并把 .env 原文返回
    ledger.append({
      tool: 'code.read',
      callId: 'symlinked',
      file: 'config/app.yml',
      range: { start: 1, end: 2 },
      content: sourceLines(envText).join('\n'),
    });
    const reads = spyFileReads((file) => file.endsWith(`${path.sep}.env`));
    const data = await evidenceGet(ledger, 'E-1', root);
    expect(data.verbatim).toBe(false);
    expect(data.content).not.toContain('SYNTHETIC');
    expect(reads.count()).toBe(0);
  });

  test('台账实现不提供来源分类能力时一律不回读（失败即关）', async () => {
    const root = createTempProject('readback-foreign-ledger-');
    writeProjectFile(root, 'src/client.ts', CLIENT_SOURCE);
    const entry = {
      id: 'E-1',
      tool: 'code.read',
      file: 'src/client.ts',
      range: { start: 1, end: 7 },
      content: 'stored [redacted] content',
    };
    const foreignLedger = {
      get: (ref: string) => (ref === 'E-1' ? entry : null),
      search: () => [],
      listRecent: () => [entry],
      stats: () => ({ entries: 1, distinctFiles: 1 }),
      checkFreshness: () => 'fresh' as const,
    };
    const reads = spyFileReads((file) => file.endsWith('client.ts'));
    const data = await evidenceGet(foreignLedger, 'E-1', root);
    expect(data.verbatim).toBe(false);
    expect(data.content).toBe('stored [redacted] content');
    expect(data.redaction).toEqual({ markers: 1, lines: [1] });
    expect(reads.count()).toBe(0);
  });

  test('非 code.read 条目（terminal / search）不参与回读，返回形状不变', async () => {
    const root = createTempProject('readback-terminal-');
    const ledger = openLoopLedger(root);
    ledger.append({ tool: 'terminal.exec', callId: 't1', file: 'src/a.ts', content: 'out' });
    const data = await evidenceGet(ledger, 'E-1', root);
    expect(data.content).toBe('out');
    expect(data).not.toHaveProperty('verbatim');
    expect(data).not.toHaveProperty('redaction');
  });
});

describe('测试要求 4：同一份字节；路径越界拒绝', () => {
  test('读取后文件被并发改写：返回的仍是判定所用那一份字节，且只读一次', async () => {
    const root = createTempProject('readback-race-after-');
    const absolute = writeProjectFile(root, 'src/client.ts', CLIENT_SOURCE);
    const ledger = openLoopLedger(root);
    captureRead(ledger, 'src/client.ts', CLIENT_SOURCE, { start: 1, end: 7 });
    const writeFile = fs.writeFileSync;
    const reads = spyFileReads((file) => file.endsWith(`${path.sep}client.ts`), {
      afterRead: () =>
        Reflect.apply(writeFile, fs, [absolute, CLIENT_SOURCE.replace('this.apiKey', 'other.key')]),
    });

    const data = await evidenceGet(ledger, 'E-1@2-5', root);
    expect(reads.count()).toBe(1);
    expect(data.verbatim).toBe(true);
    expect(data.content).toBe(sourceLines(CLIENT_SOURCE).slice(1, 5).join('\n'));
    expect(fs.readFileSync(absolute, 'utf8')).toContain('other.key');
  });

  test('读取前文件被并发改写：判 stale 并返回存储内容，不混用新字节', async () => {
    const root = createTempProject('readback-race-before-');
    const absolute = writeProjectFile(root, 'src/client.ts', CLIENT_SOURCE);
    const ledger = openLoopLedger(root);
    captureRead(ledger, 'src/client.ts', CLIENT_SOURCE, { start: 1, end: 7 });
    const stored = ledger.get('E-1@2-5')?.content;
    const writeFile = fs.writeFileSync;
    const reads = spyFileReads((file) => file.endsWith(`${path.sep}client.ts`), {
      beforeRead: () =>
        Reflect.apply(writeFile, fs, [absolute, CLIENT_SOURCE.replace('this.apiKey', 'other.key')]),
    });

    const data = await evidenceGet(ledger, 'E-1@2-5', root);
    expect(reads.count()).toBe(1);
    expect(data.verbatim).toBe(false);
    expect(data.content).toBe(stored);
    expect(data.content).not.toContain('other.key');
  });

  test('条目路径越出项目根（../）时拒绝回读，不读根外文件', async () => {
    const parent = createTempProject('readback-escape-');
    const root = path.join(parent, 'project');
    fs.mkdirSync(root, { recursive: true });
    writeProjectFile(parent, 'outside.ts', 'export const outside = 1;\nexport const two = 2;\n');
    const ledger = openLoopLedger(root);
    ledger.append({
      tool: 'code.read',
      callId: 'escape',
      file: '../outside.ts',
      range: { start: 1, end: 2 },
      content: 'export const outside = 1;\nexport const two = 2;',
    });
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const reads = spyFileReads((file) => file.endsWith('outside.ts'));
    const data = await evidenceGet(ledger, 'E-1', root);
    expect(data.verbatim).toBe(false);
    expect(reads.count()).toBe(0);
    expect(
      info.mock.calls.some((call) => String(call[0]).includes('reason=outside-project-root'))
    ).toBe(true);
  });

  test('根内 symlink 指向根外文件时拒绝回读', async () => {
    const parent = createTempProject('readback-escape-link-');
    const root = path.join(parent, 'project');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    writeProjectFile(parent, 'outside.ts', 'export const outside = 1;\nexport const two = 2;\n');
    fs.symlinkSync(path.join(parent, 'outside.ts'), path.join(root, 'src', 'link.ts'));
    const ledger = openLoopLedger(root);
    ledger.append({
      tool: 'code.read',
      callId: 'escape-link',
      file: 'src/link.ts',
      range: { start: 1, end: 2 },
      content: 'export const outside = 1;\nexport const two = 2;',
    });
    const reads = spyFileReads((file) => file.endsWith('outside.ts'));
    const data = await evidenceGet(ledger, 'E-1', root);
    expect(data.verbatim).toBe(false);
    expect(reads.count()).toBe(0);
  });
});

describe('测试要求 6：宿主 capture facet 行为不变', () => {
  test('capture 不丢 range（含 secret-bearing 文件），内容与哈希同旧管线，storeConfigHash 公式不变', () => {
    const root = createTempProject('readback-host-capture-');
    const authority = createProductionEvidenceLedgerAuthority({ dataRoot: root, ...COORDINATES });
    const envText = 'DB_PASSWORD=SYNTHETICpw0123\nPORT=8080';
    const entry = authority.capture.capture({
      tool: 'code.read',
      callId: 'host-capture',
      file: '.env',
      range: { start: 1, end: 2 },
      content: envText,
    });
    expect(entry.range).toEqual({ start: 1, end: 2 });
    expect(entry.content).toBe(redactDeveloperText(envText));
    expect(entry.contentHash).toBe(
      `sha256:${createHash('sha256').update(redactDeveloperText(envText)).digest('hex')}`
    );
    expect(authority.read.get('E-1')).toEqual(entry);
    expect(authority.identity.storeConfigHash).toBe(
      `sha256:${createHash('sha256')
        .update(
          JSON.stringify({
            authorityKind: authority.identity.authorityKind,
            persistence: authority.identity.persistence,
            redaction: 'redact-developer-text-v1',
            storeId: authority.identity.storeId,
          })
        )
        .digest('hex')}`
    );
  });
});

describe('验收：循环路径的落盘变换有诊断（限流、不含正文）', () => {
  function batchRead(files: ReadonlyArray<{ path: string; text: string }>, callId: string) {
    return {
      call: {
        id: callId,
        name: 'code',
        args: { action: 'read', params: { filePaths: files.map((file) => file.path) } },
      },
      envelope: {
        ok: true,
        text: 'batch read',
        structuredContent: {
          mode: 'batch',
          files: files.map((file) => {
            const lines = sourceLines(file.text);
            return {
              ok: true,
              path: file.path,
              content: lines.map((line, index) => `${index + 1}|${line}`).join('\n'),
              lineCount: lines.length,
              mode: 'full',
            };
          }),
        },
      },
    };
  }

  function transformationLogs(info: { mock: { calls: unknown[][] } }) {
    return info.mock.calls.filter((call) =>
      String(call[0]).includes('[EvidenceCapture] loop ledger')
    );
  }

  test('被脱敏的条目记 info：条目 id、file、tool、长度、变换类型与标记种类，不含正文', () => {
    const root = createTempProject('readback-loop-diagnostic-');
    const ledger = openLoopLedger(root);
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const secret = 'const api_key = "SYNTHETICsecretvalue0123";\nexport const ready = true;\n';
    const plain = 'export const a = 1;\n';
    const { call, envelope } = batchRead(
      [
        { path: 'src/settings.ts', text: secret },
        { path: 'src/plain.ts', text: plain },
      ],
      'loop-diag'
    );

    const entries = captureEvidenceFromEnvelope(ledger, call, envelope);

    expect(entries).toHaveLength(2);
    const logs = transformationLogs(info);
    // 只有被变换的条目有诊断；未变换的条目不产生日志
    expect(logs).toHaveLength(1);
    const [message, fields] = logs[0] ?? [];
    expect(String(message)).toContain('persisted transformed content');
    expect(fields).toMatchObject({
      evidenceId: 'E-1',
      tool: 'code.read',
      callId: 'loop-diag',
      file: 'src/settings.ts',
      range: '1-2',
      originalLength: sourceLines(secret).join('\n').length,
      storedLength: entries[0]?.content.length,
      transformations: ['redacted'],
    });
    expect((fields as { markerKinds: Record<string, number> }).markerKinds).toEqual({
      redacted: 1,
    });
    expect(JSON.stringify(logs)).not.toContain('SYNTHETIC');
    expect(JSON.stringify(logs)).not.toContain('api_key');
  });

  test('截断也被归类；同一次采集超过逐条上限时其余条目汇总为一条', () => {
    const root = createTempProject('readback-loop-diagnostic-limit-');
    const ledger = openLoopLedger(root);
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const oversized = `${Array.from({ length: 400 }, (_, index) => `export const row${index} = ${index};`).join('\n')}\n`;
    const files = [
      { path: 'src/big.ts', text: oversized },
      ...Array.from({ length: 5 }, (_, index) => ({
        path: `src/settings${index}.ts`,
        text: `const api_key = "SYNTHETICvalue${index}abcdef";\n`,
      })),
    ];
    const { call, envelope } = batchRead(files, 'loop-limit');

    const entries = captureEvidenceFromEnvelope(ledger, call, envelope);

    expect(entries).toHaveLength(6);
    const logs = transformationLogs(info);
    const detailed = logs.filter((log) => String(log[0]).includes('persisted transformed content'));
    const summary = logs.filter((log) => String(log[0]).includes('rate-limited'));
    expect(detailed).toHaveLength(3);
    expect(detailed[0]?.[1]).toMatchObject({
      evidenceId: 'E-1',
      transformations: ['truncated'],
    });
    expect(summary).toHaveLength(1);
    expect(summary[0]?.[1]).toMatchObject({
      tool: 'code.read',
      callId: 'loop-limit',
      reported: 3,
      suppressed: 3,
      sampleEvidenceIds: ['E-4', 'E-5', 'E-6'],
    });
    expect(JSON.stringify(logs)).not.toContain('SYNTHETIC');
  });

  test('诊断通道抛错不影响已完成的 append 与返回的条目', () => {
    const root = createTempProject('readback-loop-diagnostic-throws-');
    const ledger = openLoopLedger(root);
    vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => {
      throw new Error('diagnostic sink down');
    });
    const { call, envelope } = batchRead(
      [{ path: 'src/settings.ts', text: 'const api_key = "SYNTHETICsecretvalue0123";\n' }],
      'loop-throws'
    );
    const entries = captureEvidenceFromEnvelope(ledger, call, envelope);
    expect(entries.map((entry) => entry.id)).toEqual(['E-1']);
    expect(ledger.stats().entries).toBe(1);
  });
});

const I26_SOURCE = [
  'export interface Credentials {',
  '  password: string;',
  '  token?: string;',
  '}',
  'export function check(token: string | null, secret: string, other: string): boolean {',
  '  if (token === null) return false;',
  '  if (secret == other) return true;',
  '  return token == "x";',
  '}',
  '',
].join('\n');

/** 模拟阶段 1 并集底线之后会被改写的形态（D2 接受的误伤回升），证明回读与脱敏版本无关。 */
function aggressiveRedactor(text: string): string {
  return text.replace(
    /\b(password|token|secret)(\??\s*(?:===|==|:)\s*)[^\s;,)]+/g,
    '$1$2[redacted]'
  );
}

describe('测试要求 7：I26 意图在消费者层重新断言', () => {
  test.each([
    ['生产 redactor', 'production'],
    ['阶段 1 形态的激进 redactor', 'aggressive'],
  ] as const)('%s：源码经 evidence.get 回读后与文件逐字节一致', async (_label, mode) => {
    const root = createTempProject('readback-i26-');
    writeProjectFile(root, 'src/guards.ts', I26_SOURCE);
    const ledger =
      mode === 'production'
        ? openLoopLedger(root)
        : new EvidenceLedgerStore({ dataRoot: root, ...COORDINATES, redactor: aggressiveRedactor });
    const [entry] = captureRead(ledger, 'src/guards.ts', I26_SOURCE);
    if (mode === 'aggressive') {
      expect(entry?.content).toContain('password: [redacted]');
      expect(entry?.content).toContain('token === [redacted]');
    }

    const whole = await evidenceGet(ledger, 'E-1', root);
    expect(whole.verbatim).toBe(true);
    expect(
      Buffer.from(whole.content, 'utf8').equals(
        Buffer.from(sourceLines(I26_SOURCE).join('\n'), 'utf8')
      )
    ).toBe(true);
    expect((await evidenceGet(ledger, 'E-1@2-2', root)).content).toBe('  password: string;');
    expect((await evidenceGet(ledger, 'E-1@6-6', root)).content).toBe(
      '  if (token === null) return false;'
    );
    expect((await evidenceGet(ledger, 'E-1@7-8', root)).content).toBe(
      '  if (secret == other) return true;\n  return token == "x";'
    );
  });

  test('回读原文不写回台账，开发者事件仍经 processEvents 脱敏', async () => {
    const root = createTempProject('readback-no-writeback-');
    const source = 'const api_key = "SYNTHETICsecretvalue0123";\nexport const ready = true;\n';
    writeProjectFile(root, 'src/settings.ts', source);
    const ledger = openLoopLedger(root);
    captureRead(ledger, 'src/settings.ts', source);
    const before = fs.readFileSync(ledger.filePath);
    const statsBefore = ledger.stats();

    const data = await evidenceGet(ledger, 'E-1', root);
    // 模型通道拿到原文（与 code.read 一致，非本设计范围）
    expect(data.verbatim).toBe(true);
    expect(data.content).toContain('SYNTHETICsecretvalue0123');

    expect(fs.readFileSync(ledger.filePath).equals(before)).toBe(true);
    expect(ledger.stats()).toEqual(statsBefore);
    expect(fs.readFileSync(ledger.filePath, 'utf8')).not.toContain('SYNTHETICsecretvalue0123');

    const event = projectToolEndEvent(
      { id: 'call-evidence', name: 'evidence', args: { action: 'get', params: { ref: 'E-1' } } },
      { durationMs: 1, cacheHit: false, cacheMiss: false },
      JSON.stringify(data),
      true,
      'runtime'
    );
    expect(event.content?.text).toBeDefined();
    expect(event.content?.text).not.toContain('SYNTHETICsecretvalue0123');
  });
});
