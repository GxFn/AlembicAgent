/**
 * 脱敏阶段 3 的 Agent 侧（L7-P11 方案 b，C03）：严格链逐字节见证 profile 与写盘前格式闸门。
 *
 * 覆盖（设计 redaction-design-2026-10-19 第 6 节阶段 3 的 Agent 侧测试）：
 * - 9,000 字符、含 apiKey 字面量与 PEM 注释（非私钥正文）的文件经见证 capture 后 content === 原文，
 *   并通过 Buffer.equals；contentHash = sha256(原文)；不截断、不脱敏；
 * - 命中 T1 子集（前缀 token、JWT、带正文的 PEM 私钥块）、超过 1 MiB、非 UTF-8 的内容都在写盘前拒绝，
 *   台账没有新行，错误与诊断只带规则种类和文件路径，不带正文；
 * - 见证路径（.asd/evidence-witness/<runId>/）与 storeConfigHash 都不同于默认 profile；
 * - 默认 profile 的路径、脱敏、截断与 storeConfigHash 全部保持原样（按旧公式钉住）；
 * - 见证闸门规则是数据 {id, kind, pattern, examples, negativeExamples}，逐条遍历正反例。
 *
 * 所有秘密样本都是按片段拼出的合成值（SYNTHETIC），源码里不出现连续的 token 形态，
 * 避免本测试文件自己落入宿主投影时命中见证闸门。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVIDENCE_ENTRY_MAX_CHARS } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EVIDENCE_TRUNCATION_MARKER,
  EvidenceLedgerStore,
} from '../src/agent/evidence/EvidenceLedgerStore.js';
import {
  resolveProductionEvidenceLedgerReadBinding,
  resolveProductionEvidenceLedgerStore,
} from '../src/agent/evidence/ProductionEvidenceLedgerAuthority.js';
import {
  findWitnessGateHit,
  inspectWitnessContent,
  WITNESS_GATE_POLICY_ID,
  WITNESS_GATE_RULES,
  WITNESS_MAX_CONTENT_BYTES,
  WITNESS_REJECTION_ERROR_PREFIX,
} from '../src/agent/evidence/witnessGate.js';
import { createProductionEvidenceLedgerAuthority } from '../src/production.js';
import { createTempProject } from './helpers/tempProject.js';

const AUTHORITY_KIND = 'alembic-agent-production-evidence-ledger-v1';
const PERSISTENCE = 'append-only-jsonl-v1';
const RUN_ID = 'run_witness_profile';
const DIMENSION_ID = 'semantic-review';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const posixOnly = it.skipIf(process.platform === 'win32');

afterEach(() => {
  vi.restoreAllMocks();
});

function baseCoordinates(dataRoot: string) {
  return { dataRoot, jobId: RUN_ID, sessionId: RUN_ID, dimensionId: DIMENSION_ID };
}

function openWitness(dataRoot: string) {
  return createProductionEvidenceLedgerAuthority({
    ...baseCoordinates(dataRoot),
    contentProfile: 'verbatim-witness',
  });
}

function witnessFile(dataRoot: string): string {
  return path.join(dataRoot, '.asd', 'evidence-witness', RUN_ID, `${DIMENSION_ID}.jsonl`);
}

function defaultLedgerFile(dataRoot: string): string {
  return path.join(dataRoot, '.asd', 'evidence-ledger', RUN_ID, `${DIMENSION_ID}.jsonl`);
}

function readJsonl(filePath: string): Record<string, unknown>[] {
  return fs
    .readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function captureError(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

function spyLogger() {
  const instance = Logger.getInstance();
  return {
    warn: vi.spyOn(instance, 'warn').mockImplementation(() => instance),
    info: vi.spyOn(instance, 'info').mockImplementation(() => instance),
  };
}

/** 按字母表循环拼出指定长度的合成串（只含 [A-Za-z0-9+/] 中的字符）。 */
function synthetic(length: number, alphabet = 'SYNTHETIC0123456789'): string {
  let out = '';
  for (let index = 0; out.length < length; index += 1) {
    out += alphabet[index % alphabet.length];
  }
  return out;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

// 合成秘密：全部在运行时拼接。
const syntheticGithubToken = ['gh', 'p_', synthetic(36)].join('');
const syntheticJwt = [
  base64UrlJson({ alg: 'HS256', typ: 'JWT' }),
  base64UrlJson({ sub: 'SYNTHETIC', iat: 0 }),
  synthetic(43),
].join('.');
const pemBegin = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
const pemEnd = ['-----END', 'PRIVATE KEY-----'].join(' ');
const syntheticPemBodyLine = synthetic(64, 'SYNTHETICbase64+/');
const syntheticPem = [pemBegin, syntheticPemBodyLine, synthetic(24, 'SYNTHETIC/'), pemEnd].join(
  '\n'
);

/**
 * 9,000+ 字符的见证 fixture：apiKey / password 字面量、URL userinfo（默认脱敏会改写，但都不在见证
 * 闸门内）、注释里的 PEM BEGIN 标记（后面不是私钥正文）、CRLF、制表符与多字节字符。
 */
function buildWitnessSource(): string {
  const lines = [
    '// 见证 fixture：注释里提到 PEM 标记，但后面没有私钥正文。',
    `// Detects ${pemBegin} markers in pasted logs; the marker alone is not a key.`,
    `// ${pemBegin}`,
    'export const witnessNote = "the line above only names the marker";',
    'export const apiKey = "SYNTHETIC-api-key-literal-0001";',
    'export const options = { apiKey: process.env.SYNTHETIC_KEY, password: "hunter2SYNTHETIC" };',
    'export const url = "postgres://witness:SYNTHETICpassword@db.local/app";',
    '\tconst crlfLine = 1;\r',
    'export const unicode = "中文 ✓ émoji 🚀";',
  ];
  for (let index = 0; lines.join('\n').length < 9000; index += 1) {
    lines.push(`export const witnessFiller${index} = ${index};`);
  }
  return `${lines.join('\n')}\n`;
}

describe('verbatim witness profile capture', () => {
  it('captures a 9,000-char source with an apiKey literal and a PEM comment byte-for-byte, no redaction or truncation', () => {
    const dataRoot = createTempProject('witness-profile-capture-');
    const source = buildWitnessSource();
    expect(source.length).toBeGreaterThanOrEqual(9000);
    expect(source.length).toBeGreaterThan(EVIDENCE_ENTRY_MAX_CHARS);
    expect(findWitnessGateHit(source)).toBeNull();
    const logs = spyLogger();

    const authority = openWitness(dataRoot);
    const entry = authority.capture.capture({
      tool: 'code.read',
      callId: 'strict-frozen-file-1',
      file: 'src/witness.ts',
      content: source,
    });

    expect(entry.id).toBe('E-1');
    expect(entry.content).toBe(source);
    expect(Buffer.from(entry.content, 'utf8').equals(Buffer.from(source, 'utf8'))).toBe(true);
    expect(entry.contentHash).toBe(`sha256:${sha256Hex(Buffer.from(source, 'utf8'))}`);
    expect(entry.content).not.toContain(EVIDENCE_TRUNCATION_MARKER);

    // 独立路径：<dataRoot>/.asd/evidence-witness/<runId>/，默认台账目录不被触碰。
    expect(resolveProductionEvidenceLedgerStore(authority).filePath).toBe(witnessFile(dataRoot));
    const persisted = readJsonl(witnessFile(dataRoot));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.content).toBe(source);
    expect(persisted[0]?.contentHash).toBe(entry.contentHash);
    expect(fs.existsSync(path.join(dataRoot, '.asd', 'evidence-ledger'))).toBe(false);

    // 读回、严格快照与重开：内容逐字节一致，身份稳定。
    expect(authority.read.get('E-1')).toEqual(entry);
    const snapshot = authority.read.strictSnapshot();
    expect(snapshot.entries).toHaveLength(1);
    expect(
      Buffer.from(snapshot.entries[0]?.content ?? '', 'utf8').equals(Buffer.from(source, 'utf8'))
    ).toBe(true);
    const reopened = openWitness(dataRoot);
    expect(reopened.identity).toEqual(authority.identity);
    expect(reopened.read.strictSnapshot().snapshotHash).toBe(snapshot.snapshotHash);

    // Durable runtime 的 WeakMap 认证绑定同样接受见证 read facet（宿主切换后沿用同一闸门）。
    expect(resolveProductionEvidenceLedgerReadBinding(authority.read)?.identity).toBe(
      authority.identity
    );

    // 逐字节写入不是“变换”：不发 transformed 诊断，也不发见证拒绝诊断。
    const ledgerWarnings = logs.warn.mock.calls.filter((call) =>
      /\[(ProductionEvidenceLedger|EvidenceLedger)\]/.test(String(call[0]))
    );
    expect(ledgerWarnings).toHaveLength(0);
  });

  it('keeps the default profile transforming the same source (redaction plus 8000-char cap)', () => {
    const dataRoot = createTempProject('witness-profile-default-');
    const source = buildWitnessSource();
    spyLogger();

    const defaultAuthority = createProductionEvidenceLedgerAuthority(baseCoordinates(dataRoot));
    const entry = defaultAuthority.capture.capture({
      tool: 'code.read',
      callId: 'strict-frozen-file-1',
      file: 'src/witness.ts',
      content: source,
    });

    expect(entry.content).not.toBe(source);
    expect(entry.content.length).toBe(EVIDENCE_ENTRY_MAX_CHARS);
    expect(entry.content.endsWith(`\n${EVIDENCE_TRUNCATION_MARKER}`)).toBe(true);
    expect(entry.content).not.toContain('SYNTHETIC-api-key-literal-0001');
    expect(resolveProductionEvidenceLedgerStore(defaultAuthority).filePath).toBe(
      defaultLedgerFile(dataRoot)
    );
    expect(fs.existsSync(path.join(dataRoot, '.asd', 'evidence-witness'))).toBe(false);
  });

  it('admits exactly 1 MiB of UTF-8 bytes without truncation', () => {
    const dataRoot = createTempProject('witness-profile-limit-');
    spyLogger();
    const content = `${'x'.repeat(WITNESS_MAX_CONTENT_BYTES - 2)}é`;
    expect(Buffer.byteLength(content, 'utf8')).toBe(WITNESS_MAX_CONTENT_BYTES);

    const entry = openWitness(dataRoot).capture.capture({
      tool: 'code.read',
      callId: 'strict-frozen-file-1',
      file: 'src/limit.ts',
      content,
    });

    expect(WITNESS_MAX_CONTENT_BYTES).toBe(1024 * 1024);
    expect(entry.content).toBe(content);
    expect(readJsonl(witnessFile(dataRoot))[0]?.content).toBe(content);
  });
});

describe('verbatim witness profile rejects before writing', () => {
  const filler = 'export const before = 1;\n';
  const rejectionCases: ReadonlyArray<{
    readonly name: string;
    readonly content: string;
    readonly reason: string;
    readonly kind: string;
    readonly rule?: string;
    readonly forbiddenInDiagnostics: string;
  }> = [
    {
      name: 'a prefixed GitHub token',
      content: `${filler}const token = "${syntheticGithubToken}";\n`,
      reason: 'SECRET_DETECTED',
      kind: 'prefixed-token',
      rule: 'github-token',
      forbiddenInDiagnostics: syntheticGithubToken.slice(4),
    },
    {
      name: 'a JWT whose header and payload decode to JSON',
      content: `${filler}const session = '${syntheticJwt}';\n`,
      reason: 'SECRET_DETECTED',
      kind: 'jwt',
      rule: 'jwt',
      forbiddenInDiagnostics: syntheticJwt.split('.')[2] ?? syntheticJwt,
    },
    {
      name: 'a PEM private key block with a base64 body line',
      content: `${filler}const key = \`${syntheticPem}\`;\n`,
      reason: 'SECRET_DETECTED',
      kind: 'pem-private-key',
      rule: 'pem-private-key-block',
      forbiddenInDiagnostics: syntheticPemBodyLine,
    },
    {
      name: 'content one byte over 1 MiB',
      content: `oversizedWitnessMarker${'y'.repeat(WITNESS_MAX_CONTENT_BYTES)}`,
      reason: 'CONTENT_TOO_LARGE',
      kind: 'byte-limit',
      forbiddenInDiagnostics: 'oversizedWitnessMarker',
    },
    {
      name: 'multi-byte content under 1 MiB characters but over 1 MiB bytes',
      content: `multibyteWitnessMarker${'中'.repeat(400_000)}`,
      reason: 'CONTENT_TOO_LARGE',
      kind: 'byte-limit',
      forbiddenInDiagnostics: 'multibyteWitnessMarker',
    },
    {
      name: 'a lone surrogate that cannot round-trip through UTF-8',
      content: `${filler}const broken = "loneSurrogateMarker\uD800";\n`,
      reason: 'CONTENT_NOT_UTF8',
      kind: 'lone-surrogate',
      forbiddenInDiagnostics: 'loneSurrogateMarker',
    },
    {
      name: 'non-UTF-8 file bytes decoded lossily into replacement characters',
      content: Buffer.concat([
        Buffer.from('const latin1Marker = "caf', 'utf8'),
        Buffer.from([0xe9, 0xff, 0xfe]),
        Buffer.from('";\n', 'utf8'),
      ]).toString('utf8'),
      reason: 'CONTENT_NOT_UTF8',
      kind: 'replacement-character',
      forbiddenInDiagnostics: 'latin1Marker',
    },
  ];

  it.each(rejectionCases)('rejects $name with no new ledger row and no content in the reason', ({
    content,
    reason,
    kind,
    rule,
    forbiddenInDiagnostics,
  }) => {
    const dataRoot = createTempProject('witness-profile-reject-');
    const logs = spyLogger();
    const authority = openWitness(dataRoot);
    const store = resolveProductionEvidenceLedgerStore(authority);
    authority.capture.capture({
      tool: 'code.read',
      callId: 'strict-frozen-file-1',
      file: 'src/first.ts',
      content: 'export const first = true;\n',
    });
    const bytesBefore = fs.readFileSync(witnessFile(dataRoot));
    const statsBefore = store.stats();

    const message = captureError(() =>
      authority.capture.capture({
        tool: 'code.read',
        callId: 'strict-frozen-file-2',
        file: 'src/rejected.ts',
        content,
      })
    );

    expect(message).not.toBeNull();
    expect(message?.startsWith(`${WITNESS_REJECTION_ERROR_PREFIX}:${reason}:${kind}`)).toBe(true);
    expect(message).toContain('file="src/rejected.ts"');
    if (rule) {
      expect(message).toContain(`rule=${rule}`);
    }
    expect(message).not.toContain(forbiddenInDiagnostics);

    // 台账没有新行：字节不变、条目数不变、E-2 不可读、快照仍只有一条。
    expect(fs.readFileSync(witnessFile(dataRoot)).equals(bytesBefore)).toBe(true);
    expect(store.stats()).toEqual(statsBefore);
    expect(authority.read.get('E-2')).toBeNull();
    expect(authority.read.strictSnapshot().entries).toHaveLength(1);

    // 拒绝走诊断：warn 带规则种类与文件路径，不带正文。
    const rejections = logs.warn.mock.calls.filter((call) =>
      String(call[0]).includes('witness capture rejected')
    );
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.[1]).toMatchObject({
      file: 'src/rejected.ts',
      callId: 'strict-frozen-file-2',
      reason,
      kind,
    });
    expect(JSON.stringify(rejections)).not.toContain(forbiddenInDiagnostics);

    // 拒绝不消耗序号：下一次合法 capture 仍是 E-2。
    expect(
      authority.capture.capture({
        tool: 'code.read',
        callId: 'strict-frozen-file-2',
        file: 'src/next.ts',
        content: 'export const next = true;\n',
      }).id
    ).toBe('E-2');
  });

  it('creates no witness directory when the very first capture is rejected', () => {
    const dataRoot = createTempProject('witness-profile-first-reject-');
    spyLogger();
    const authority = openWitness(dataRoot);

    expect(
      captureError(() =>
        authority.capture.capture({
          tool: 'code.read',
          callId: 'strict-frozen-file-1',
          file: 'config/key.ts',
          content: `export const key = ${JSON.stringify(syntheticPem)};\n`,
        })
      )
    ).toContain(`${WITNESS_REJECTION_ERROR_PREFIX}:SECRET_DETECTED:pem-private-key`);
    expect(fs.existsSync(path.join(dataRoot, '.asd'))).toBe(false);
    expect(() => authority.read.strictSnapshot()).toThrow('EVIDENCE_LEDGER_STRICT_SNAPSHOT_EMPTY');
  });
});

describe('witness profile identity and isolation', () => {
  function legacyDefaultIdentity(dataRoot: string) {
    const storageRootHash = `sha256:${sha256Hex(`storage-root\0${path.resolve(dataRoot)}`)}`;
    const storeId = `agent-evidence-ledger:${sha256Hex(
      JSON.stringify({
        schemaVersion: 1,
        authorityKind: AUTHORITY_KIND,
        storageRootHash,
        jobId: RUN_ID,
        sessionId: RUN_ID,
        dimensionId: DIMENSION_ID,
        persistence: PERSISTENCE,
      })
    )}`;
    const storeConfigHash = `sha256:${sha256Hex(
      JSON.stringify({
        authorityKind: AUTHORITY_KIND,
        persistence: PERSISTENCE,
        redaction: 'redact-developer-text-v1',
        storeId,
      })
    )}`;
    return { storageRootHash, storeId, storeConfigHash };
  }

  it('keeps the default profile storeId and storeConfigHash on the pre-witness formula, explicit or omitted', () => {
    const dataRoot = createTempProject('witness-profile-default-identity-');
    const legacy = legacyDefaultIdentity(dataRoot);

    const omitted = createProductionEvidenceLedgerAuthority(baseCoordinates(dataRoot));
    const explicit = createProductionEvidenceLedgerAuthority({
      ...baseCoordinates(dataRoot),
      contentProfile: 'redacted-evidence',
    });

    expect(omitted.identity.storeId).toBe(legacy.storeId);
    expect(omitted.identity.storeConfigHash).toBe(legacy.storeConfigHash);
    expect(explicit.identity).toEqual(omitted.identity);
    expect(resolveProductionEvidenceLedgerStore(explicit).filePath).toBe(
      defaultLedgerFile(dataRoot)
    );
  });

  it('gives the witness profile its own path, storeId and a storeConfigHash covering profile, limit and gate policy', () => {
    const dataRoot = createTempProject('witness-profile-identity-');
    spyLogger();
    const legacy = legacyDefaultIdentity(dataRoot);
    const witness = openWitness(dataRoot);
    const defaultAuthority = createProductionEvidenceLedgerAuthority(baseCoordinates(dataRoot));

    expect(witness.identity.storeConfigHash).not.toBe(defaultAuthority.identity.storeConfigHash);
    expect(witness.identity.storeId).not.toBe(defaultAuthority.identity.storeId);
    expect(resolveProductionEvidenceLedgerStore(witness).filePath).not.toBe(
      resolveProductionEvidenceLedgerStore(defaultAuthority).filePath
    );
    // 公开身份形状不变：不新增字段，只有 storeId / storeConfigHash 的取值不同。
    expect(Object.keys(witness.identity).sort()).toEqual(
      Object.keys(defaultAuthority.identity).sort()
    );
    expect(witness.identity.persistence).toBe(PERSISTENCE);

    // 钉住见证 profile 的配置哈希公式：profile、无脱敏、无截断、1 MiB 上限、闸门策略 id。
    const expectedStoreId = `agent-evidence-ledger:${sha256Hex(
      JSON.stringify({
        schemaVersion: 1,
        authorityKind: AUTHORITY_KIND,
        storageRootHash: legacy.storageRootHash,
        jobId: RUN_ID,
        sessionId: RUN_ID,
        dimensionId: DIMENSION_ID,
        persistence: PERSISTENCE,
        contentProfile: 'verbatim-witness',
      })
    )}`;
    expect(witness.identity.storeId).toBe(expectedStoreId);
    expect(witness.identity.storeConfigHash).toBe(
      `sha256:${sha256Hex(
        JSON.stringify({
          authorityKind: AUTHORITY_KIND,
          persistence: PERSISTENCE,
          contentProfile: 'verbatim-witness',
          redaction: 'none',
          truncation: 'none',
          maxContentBytes: WITNESS_MAX_CONTENT_BYTES,
          witnessGatePolicyId: WITNESS_GATE_POLICY_ID,
          storeId: expectedStoreId,
        })
      )}`
    );
  });

  it('keeps witness and default ledgers isolated for the same coordinates', () => {
    const dataRoot = createTempProject('witness-profile-isolation-');
    spyLogger();
    const witness = openWitness(dataRoot);
    const defaultAuthority = createProductionEvidenceLedgerAuthority(baseCoordinates(dataRoot));

    const witnessEntry = witness.capture.capture({
      tool: 'code.read',
      callId: 'strict-frozen-file-1',
      file: 'src/a.ts',
      content: 'export const apiKey = "SYNTHETIC-isolation";\n',
    });
    const defaultEntry = defaultAuthority.capture.capture({
      tool: 'code.read',
      callId: 'call:loop:1',
      file: 'src/b.ts',
      content: 'export const b = 2;\n',
    });

    expect(witnessEntry.id).toBe('E-1');
    expect(defaultEntry.id).toBe('E-1');
    expect(witness.read.strictSnapshot().entries).toEqual([witnessEntry]);
    expect(defaultAuthority.read.strictSnapshot().entries).toEqual([defaultEntry]);
    expect(readJsonl(witnessFile(dataRoot))).toHaveLength(1);
    expect(readJsonl(defaultLedgerFile(dataRoot))).toHaveLength(1);
  });

  it.each([
    { name: 'unknown profile string', value: 'verbatim' },
    { name: 'non-string profile', value: 7 },
    { name: 'null profile', value: null },
  ])('rejects $name before touching storage', ({ value }) => {
    const dataRoot = createTempProject('witness-profile-invalid-');
    expect(() =>
      createProductionEvidenceLedgerAuthority({
        ...baseCoordinates(dataRoot),
        contentProfile: value as unknown as 'verbatim-witness',
      })
    ).toThrow('ALEMBIC_AGENT_EVIDENCE_LEDGER_COORDINATES_INVALID');
    expect(fs.existsSync(path.join(dataRoot, '.asd'))).toBe(false);
  });

  posixOnly('hardens the witness directory to 0700/0600 with a self-ignoring .gitignore', () => {
    const dataRoot = createTempProject('witness-profile-hardening-');
    spyLogger();
    openWitness(dataRoot).capture.capture({
      tool: 'code.read',
      callId: 'strict-frozen-file-1',
      file: 'src/a.ts',
      content: 'export const a = 1;\n',
    });
    const witnessRoot = path.join(dataRoot, '.asd', 'evidence-witness');

    expect(fs.statSync(witnessRoot).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(witnessRoot, RUN_ID)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(witnessFile(dataRoot)).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(witnessRoot, '.gitignore'), 'utf8').trim()).toBe('*');
  });
});

describe('witness store path (EvidenceLedgerStore)', () => {
  it('refuses an injected redactor on the witness profile', () => {
    const dataRoot = createTempProject('witness-store-redactor-');
    expect(
      () =>
        new EvidenceLedgerStore({
          ...baseCoordinates(dataRoot),
          contentProfile: 'verbatim-witness',
          redactor: (text) => text.replace(/SYNTHETIC/g, '[redacted]'),
        })
    ).toThrow('EVIDENCE_LEDGER_WITNESS_REDACTOR_FORBIDDEN');
  });

  it('stores raw content, hashes the original and checks freshness against raw slices', () => {
    const dataRoot = createTempProject('witness-store-raw-');
    spyLogger();
    const source = buildWitnessSource();
    const lines = source.split('\n');
    const slice = lines.slice(0, 8).join('\n');
    const store = new EvidenceLedgerStore({
      ...baseCoordinates(dataRoot),
      contentProfile: 'verbatim-witness',
    });

    const entry = store.append({
      tool: 'code.read',
      callId: 'strict-frozen-file-1',
      file: 'src/witness.ts',
      range: { start: 1, end: 8 },
      content: slice,
    });

    expect(store.filePath).toBe(witnessFile(dataRoot));
    expect(entry.content).toBe(slice);
    expect(entry.contentHash).toBe(`sha256:${sha256Hex(Buffer.from(slice, 'utf8'))}`);
    expect(store.describeContentTransformation(source)).toEqual({
      redacted: false,
      truncated: false,
      originalLength: source.length,
      storedLength: source.length,
    });
    // 新实例没有进程内原文摘要，走“同尺重算”路径；见证 profile 的同尺就是原文本身。
    const reopened = new EvidenceLedgerStore({
      ...baseCoordinates(dataRoot),
      contentProfile: 'verbatim-witness',
    });
    expect(reopened.checkFreshness('E-1', source)).toBe('fresh');
    expect(
      reopened.checkFreshness('E-1', source.replace('SYNTHETIC-api-key', 'CHANGED-api-key'))
    ).toBe('stale');
  });

  it('keeps the default store path when no profile is given', () => {
    const dataRoot = createTempProject('witness-store-default-');
    const store = new EvidenceLedgerStore(baseCoordinates(dataRoot));
    expect(store.filePath).toBe(defaultLedgerFile(dataRoot));
  });
});

describe('witness gate rules (T1 subset data)', () => {
  const REQUIRED_PREFIXES = [
    'ghp_',
    'gho_',
    'ghu_',
    'ghs_',
    'ghr_',
    'github_pat_',
    'glpat-',
    'xoxa-',
    'xoxb-',
    'xoxp-',
    'xoxo-',
    'xoxs-',
    'xoxr-',
    'sk_live_',
    'sk_test_',
    'rk_live_',
    'rk_test_',
    'npm_',
    'sk-ant-',
    'AIza',
  ];

  it('declares only the three approved kinds with data-shaped rules', () => {
    expect(WITNESS_GATE_RULES.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const rule of WITNESS_GATE_RULES) {
      expect(['prefixed-token', 'jwt', 'pem-private-key']).toContain(rule.kind);
      expect(rule.pattern).toBeInstanceOf(RegExp);
      expect(rule.pattern.flags).toContain('g');
      expect(rule.examples.length, rule.id).toBeGreaterThan(0);
      expect(rule.negativeExamples.length, rule.id).toBeGreaterThan(0);
      expect(ids.has(rule.id), rule.id).toBe(false);
      ids.add(rule.id);
    }
    expect(new Set(WITNESS_GATE_RULES.map((rule) => rule.kind))).toEqual(
      new Set(['prefixed-token', 'jwt', 'pem-private-key'])
    );
    expect(WITNESS_GATE_POLICY_ID).toMatch(/^[a-z0-9-]+$/);
  });

  it('covers every design-listed token prefix with at least one positive example', () => {
    const examples = WITNESS_GATE_RULES.filter((rule) => rule.kind === 'prefixed-token').flatMap(
      (rule) => rule.examples
    );
    for (const prefix of REQUIRED_PREFIXES) {
      expect(
        examples.some((example) => example.startsWith(prefix)),
        prefix
      ).toBe(true);
    }
  });

  for (const rule of WITNESS_GATE_RULES) {
    it(`${rule.id}: every positive example hits this rule, bare and inside common carriers`, () => {
      for (const example of rule.examples) {
        const carriers = [
          example,
          `const value = "${example}";`,
          `value: '${example}'\n`,
          `KEY=${example}\n`,
          JSON.stringify({ value: example }),
          `# ${example}`,
        ];
        for (const carried of carriers) {
          const hit = findWitnessGateHit(carried);
          expect(hit, `${rule.id} :: ${JSON.stringify(carried).slice(0, 60)}`).toEqual({
            ruleId: rule.id,
            kind: rule.kind,
          });
        }
      }
    });

    it(`${rule.id}: no negative example hits any gate rule`, () => {
      for (const negative of rule.negativeExamples) {
        expect(findWitnessGateHit(negative), `${rule.id} :: ${negative.slice(0, 60)}`).toBeNull();
      }
    });
  }

  it('keeps URL userinfo, placeholders and lookalike identifiers out of the gate', () => {
    const negatives = [
      'postgres://user:SYNTHETICpassword@db.local/app',
      ['const url = `https://$', '{user}:$', '{password}@example.test/path`;'].join(''),
      'process.env.npm_package_version',
      'const githubTokenEnv = "GITHUB_TOKEN";',
      `// ${pemBegin}\nexport const next = 1;`,
      `const PEM_RE = /${pemBegin}[\\s\\S]*?${pemEnd}/;`,
      'eyJhbGciOiJIUzI1NiJ9 alone is only a header',
      'version 1.2.3 and a.b.c are not tokens',
    ];
    for (const negative of negatives) {
      expect(findWitnessGateHit(negative), negative).toBeNull();
    }
  });

  it('admits the source and test files of this package into a witness ledger', () => {
    // 规则正例全部运行时拼接：这些文件自己被宿主投影捕获时不能命中见证闸门或 UTF-8 判定。
    for (const relative of [
      'src/agent/evidence/witnessGate.ts',
      'src/agent/evidence/EvidenceLedgerStore.ts',
      'src/agent/evidence/ProductionEvidenceLedgerAuthority.ts',
      'test/production-evidence-witness-profile.test.ts',
    ]) {
      const text = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
      expect(inspectWitnessContent(text), relative).toBeNull();
    }
  });
});
