import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EVIDENCE_ENTRY_MAX_CHARS } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EVIDENCE_TRUNCATION_MARKER,
  hashEvidenceContent,
} from '../src/agent/evidence/EvidenceLedgerStore.js';
import { resolveProductionEvidenceLedgerStore } from '../src/agent/evidence/ProductionEvidenceLedgerAuthority.js';
import { createProductionEvidenceLedgerAuthority } from '../src/production.js';

const temporaryRoots = new Set<string>();

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  temporaryRoots.clear();
});

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'alembic-agent-production-ledger-'));
  temporaryRoots.add(root);
  return root;
}

describe('production Evidence Ledger authority', () => {
  it('captures immutable evidence and reopens the same strict snapshot identity', () => {
    const dataRoot = createRoot();
    const coordinates = {
      dataRoot,
      jobId: 'job:production-ledger',
      sessionId: 'session:production-ledger',
      dimensionId: 'dimension:strict-fact',
    };
    const authority = createProductionEvidenceLedgerAuthority(coordinates);
    const evidenceEntry = authority.capture.capture({
      tool: 'code.read',
      callId: 'call:strict-fact:1',
      file: 'src/fact.ts',
      content: 'const api_key = "must-redact";',
    });

    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.identity)).toBe(true);
    expect(Object.isFrozen(authority.capture)).toBe(true);
    expect(Object.isFrozen(authority.read)).toBe(true);
    expect(Object.isFrozen(evidenceEntry)).toBe(true);
    expect(evidenceEntry.content).not.toContain('must-redact');

    const firstSnapshot = authority.read.strictSnapshot();
    const reopened = createProductionEvidenceLedgerAuthority(coordinates);
    const reopenedSnapshot = reopened.read.strictSnapshot();
    expect(reopened.identity).toEqual(authority.identity);
    expect(reopenedSnapshot.snapshotHash).toBe(firstSnapshot.snapshotHash);
    expect(reopenedSnapshot.entries).toEqual([evidenceEntry]);
    expect(reopened.read.get(evidenceEntry.id)).toEqual(evidenceEntry);
  });

  it('rejects every malformed public capture draft before file, store, or sequence mutation', () => {
    const captureErrorPrefix = 'ALEMBIC_AGENT_EVIDENCE_LEDGER_CAPTURE_INVALID';
    const callerSpoofError = `${captureErrorPrefix}:CALLER_SPOOF`;
    const expectedUnreadableError = `${captureErrorPrefix}:UNREADABLE_INPUT`;
    const coordinates = {
      dataRoot: createRoot(),
      jobId: 'job:production-ledger',
      sessionId: 'session:production-ledger',
      dimensionId: 'dimension:strict-fact',
    };
    const authority = createProductionEvidenceLedgerAuthority(coordinates);
    const store = resolveProductionEvidenceLedgerStore(authority);
    const captureRuntime = authority.capture.capture as (input: unknown) => unknown;
    const filePath = path.join(
      coordinates.dataRoot,
      '.asd',
      'evidence-ledger',
      coordinates.jobId,
      `${coordinates.dimensionId}.jsonl`
    );
    const getterDraft = {
      tool: 'code.read',
      callId: 'call:caller-spoof:getter',
    };
    Object.defineProperty(getterDraft, 'content', {
      enumerable: true,
      get() {
        throw new Error(callerSpoofError);
      },
    });
    const invalidDrafts: ReadonlyArray<{
      readonly name: string;
      readonly input: unknown;
      readonly expectedError?: string;
    }> = [
      {
        name: 'unknown tool',
        input: { tool: 'caller.fake', callId: 'call:invalid', content: 'invalid' },
      },
      { name: 'null draft', input: null },
      { name: 'array draft', input: [] },
      { name: 'missing tool', input: { callId: 'call:invalid', content: 'invalid' } },
      { name: 'missing callId', input: { tool: 'code.read', content: 'invalid' } },
      { name: 'missing content', input: { tool: 'code.read', callId: 'call:invalid' } },
      {
        name: 'extra top-level field',
        input: {
          tool: 'code.read',
          callId: 'call:invalid',
          content: 'invalid',
          callerTruth: true,
        },
      },
      {
        name: 'non-string tool',
        input: { tool: 7, callId: 'call:invalid', content: 'invalid' },
      },
      {
        name: 'non-string callId',
        input: { tool: 'code.read', callId: 7, content: 'invalid' },
      },
      {
        name: 'non-string content',
        input: { tool: 'code.read', callId: 'call:invalid', content: 7 },
      },
      {
        name: 'non-string file',
        input: {
          tool: 'code.read',
          callId: 'call:invalid',
          file: 7,
          content: 'invalid',
        },
      },
      {
        name: 'empty file',
        input: {
          tool: 'code.read',
          callId: 'call:invalid',
          file: '',
          content: 'invalid',
        },
      },
      {
        name: 'present undefined file',
        input: {
          tool: 'code.read',
          callId: 'call:invalid',
          file: undefined,
          content: 'invalid',
        },
      },
      {
        name: 'null range',
        input: {
          tool: 'code.read',
          callId: 'call:invalid',
          range: null,
          content: 'invalid',
        },
      },
      {
        name: 'present undefined range',
        input: {
          tool: 'code.read',
          callId: 'call:invalid',
          range: undefined,
          content: 'invalid',
        },
      },
      {
        name: 'array range',
        input: {
          tool: 'code.read',
          callId: 'call:invalid',
          range: [1, 2],
          content: 'invalid',
        },
      },
      {
        name: 'missing range start',
        input: {
          tool: 'code.read',
          callId: 'call:invalid',
          range: { end: 2 },
          content: 'invalid',
        },
      },
      {
        name: 'missing range end',
        input: {
          tool: 'code.read',
          callId: 'call:invalid',
          range: { start: 1 },
          content: 'invalid',
        },
      },
      {
        name: 'extra range field',
        input: {
          tool: 'code.read',
          callId: 'call:invalid',
          range: { start: 1, end: 2, zeroBased: true },
          content: 'invalid',
        },
      },
      {
        name: 'zero range start',
        input: {
          tool: 'code.read',
          callId: 'call:invalid',
          range: { start: 0, end: 1 },
          content: 'invalid',
        },
      },
      {
        name: 'negative range end',
        input: {
          tool: 'code.read',
          callId: 'call:invalid',
          range: { start: 1, end: -1 },
          content: 'invalid',
        },
      },
      {
        name: 'descending range',
        input: {
          tool: 'code.read',
          callId: 'call:invalid',
          range: { start: 2, end: 1 },
          content: 'invalid',
        },
      },
      {
        name: 'fractional range',
        input: {
          tool: 'code.read',
          callId: 'call:invalid',
          range: { start: 1.5, end: 2 },
          content: 'invalid',
        },
      },
      {
        name: 'NaN range',
        input: {
          tool: 'code.read',
          callId: 'call:invalid',
          range: { start: Number.NaN, end: 2 },
          content: 'invalid',
        },
      },
      {
        name: 'infinite range',
        input: {
          tool: 'code.read',
          callId: 'call:invalid',
          range: { start: 1, end: Number.POSITIVE_INFINITY },
          content: 'invalid',
        },
      },
      {
        name: 'string range',
        input: {
          tool: 'code.read',
          callId: 'call:invalid',
          range: { start: '1', end: '2' },
          content: 'invalid',
        },
      },
      {
        name: 'Proxy ownKeys caller-prefix spoof',
        input: new Proxy(
          {
            tool: 'code.read',
            callId: 'call:caller-spoof:own-keys',
            content: 'invalid',
          },
          {
            ownKeys() {
              throw new Error(callerSpoofError);
            },
          }
        ),
        expectedError: expectedUnreadableError,
      },
      {
        name: 'property getter caller-prefix spoof',
        input: getterDraft,
        expectedError: expectedUnreadableError,
      },
    ];

    for (const invalid of invalidDrafts) {
      const fileExistedBefore = existsSync(filePath);
      const bytesBefore = fileExistedBefore ? readFileSync(filePath) : null;
      const statsBefore = store.stats();
      const snapshotErrorBefore = captureError(() => authority.read.strictSnapshot());

      const captureFailure = captureError(() => captureRuntime(invalid.input));
      if (invalid.expectedError) {
        expect(captureFailure, invalid.name).toBe(invalid.expectedError);
      } else {
        expect(captureFailure, invalid.name).toContain(captureErrorPrefix);
      }
      expect(existsSync(filePath), invalid.name).toBe(fileExistedBefore);
      expect(fileExistedBefore ? readFileSync(filePath) : null, invalid.name).toEqual(bytesBefore);
      expect(store.stats(), invalid.name).toEqual(statsBefore);
      expect(
        captureError(() => authority.read.strictSnapshot()),
        invalid.name
      ).toBe(snapshotErrorBefore);
    }

    expect(
      authority.capture.capture({
        tool: 'code.read',
        callId: 'call:strict-fact:1',
        file: 'src/fact.ts',
        range: { start: 1, end: 1 },
        content: 'export const fact = true;',
      }).id
    ).toBe('E-1');
  });

  it.each([
    { field: 'jobId', value: '../foreign-job' },
    { field: 'sessionId', value: 'session/foreign' },
    { field: 'dimensionId', value: '..\\foreign-dimension' },
  ] as const)('rejects path-escape $field coordinates', ({ field, value }) => {
    expect(() =>
      createProductionEvidenceLedgerAuthority({
        dataRoot: createRoot(),
        jobId: 'job:production-ledger',
        sessionId: 'session:production-ledger',
        dimensionId: 'dimension:strict-fact',
        [field]: value,
      })
    ).toThrow('ALEMBIC_AGENT_EVIDENCE_LEDGER_COORDINATES_INVALID');
  });

  it('binds identity to the storage root and fails closed for a different empty store', () => {
    const coordinates = {
      dataRoot: createRoot(),
      jobId: 'job:production-ledger',
      sessionId: 'session:production-ledger',
      dimensionId: 'dimension:strict-fact',
    };
    const authority = createProductionEvidenceLedgerAuthority(coordinates);
    authority.capture.capture({
      tool: 'code.read',
      callId: 'call:strict-fact:1',
      file: 'src/fact.ts',
      content: 'export const fact = true;',
    });
    const different = createProductionEvidenceLedgerAuthority({
      ...coordinates,
      dataRoot: createRoot(),
    });

    expect(different.identity.storeId).not.toBe(authority.identity.storeId);
    expect(() => different.read.strictSnapshot()).toThrow('EVIDENCE_LEDGER_STRICT_SNAPSHOT_EMPTY');
  });

  it.each([
    { field: 'jobId', value: 'job:different' },
    { field: 'dimensionId', value: 'dimension:different' },
  ] as const)('does not rebound persisted evidence across a different $field', ({
    field,
    value,
  }) => {
    const coordinates = {
      dataRoot: createRoot(),
      jobId: 'job:production-ledger',
      sessionId: 'session:production-ledger',
      dimensionId: 'dimension:strict-fact',
    };
    const authority = createProductionEvidenceLedgerAuthority(coordinates);
    authority.capture.capture({
      tool: 'code.read',
      callId: 'call:strict-fact:1',
      file: 'src/fact.ts',
      content: 'export const fact = true;',
    });
    const rebound = createProductionEvidenceLedgerAuthority({
      ...coordinates,
      [field]: value,
    });

    expect(rebound.identity.storeId).not.toBe(authority.identity.storeId);
    expect(() => rebound.read.strictSnapshot()).toThrow('EVIDENCE_LEDGER_STRICT_SNAPSHOT_EMPTY');
  });

  it('rejects reopening the persisted JSONL with a different session authority', () => {
    const coordinates = {
      dataRoot: createRoot(),
      jobId: 'job:production-ledger',
      sessionId: 'session:production-ledger',
      dimensionId: 'dimension:strict-fact',
    };
    const authority = createProductionEvidenceLedgerAuthority(coordinates);
    authority.capture.capture({
      tool: 'code.read',
      callId: 'call:strict-fact:1',
      file: 'src/fact.ts',
      content: 'export const fact = true;',
    });
    expect(() =>
      createProductionEvidenceLedgerAuthority({
        ...coordinates,
        sessionId: 'session:rebound',
      })
    ).toThrow('EVIDENCE_LEDGER_PRODUCTION_AUTHORITY_INVALID');
  });

  it.each([
    {
      name: 'missing JSONL entry',
      mutate: (filePath: string) => {
        const lines = readFileSync(filePath, 'utf8').trim().split('\n');
        writeFileSync(filePath, `${lines.slice(1).join('\n')}\n`, 'utf8');
      },
    },
    {
      name: 'duplicate JSONL entry',
      mutate: (filePath: string) => {
        const first = readFileSync(filePath, 'utf8').split('\n')[0];
        appendFileSync(filePath, `${first}\n`, 'utf8');
      },
    },
    {
      name: 'corrupt partial JSONL entry',
      mutate: (filePath: string) => appendFileSync(filePath, '{"partial":', 'utf8'),
    },
    {
      name: 'changed content with stale hash',
      mutate: (filePath: string) => {
        const lines = readFileSync(filePath, 'utf8').trim().split('\n');
        const first = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
        lines[0] = JSON.stringify({ ...first, content: 'caller changed persisted evidence' });
        writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
      },
    },
  ])('fails closed for $name without a partial snapshot fallback', ({ mutate }) => {
    const coordinates = {
      dataRoot: createRoot(),
      jobId: 'job:production-ledger',
      sessionId: 'session:production-ledger',
      dimensionId: 'dimension:strict-fact',
    };
    const authority = createProductionEvidenceLedgerAuthority(coordinates);
    for (const index of [1, 2]) {
      authority.capture.capture({
        tool: 'code.read',
        callId: `call:strict-fact:${index}`,
        file: `src/fact-${index}.ts`,
        content: `export const fact${index} = true;`,
      });
    }
    const filePath = path.join(
      coordinates.dataRoot,
      '.asd',
      'evidence-ledger',
      coordinates.jobId,
      `${coordinates.dimensionId}.jsonl`
    );
    mutate(filePath);
    expect(() => createProductionEvidenceLedgerAuthority(coordinates)).toThrow(
      'EVIDENCE_LEDGER_PRODUCTION_AUTHORITY_INVALID'
    );
  });
});

describe('production Evidence Ledger capture content-transformation diagnostics', () => {
  const coordinates = () => ({
    dataRoot: createRoot(),
    jobId: 'job:production-ledger',
    sessionId: 'session:production-ledger',
    dimensionId: 'dimension:strict-fact',
  });
  // 可辨识且不含敏感模式的大文件：行数足以越过 8000 字符上限，尾部行必然被截掉。
  const oversizedSource = Array.from(
    { length: 400 },
    (_, index) => `export const oversizedWitnessLine${index} = ${index};`
  ).join('\n');
  const secretSource = [
    'const apiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";',
    'export const password = "hunter2hunter2";',
    '',
  ].join('\n');

  function spyWarn() {
    return vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => Logger.getInstance());
  }

  function transformationCalls(warn: ReturnType<typeof spyWarn>) {
    return warn.mock.calls.filter((call) => String(call[0]).includes('[ProductionEvidenceLedger]'));
  }

  function readPersistedLines(root: ReturnType<typeof coordinates>): Record<string, unknown>[] {
    const filePath = path.join(
      root.dataRoot,
      '.asd',
      'evidence-ledger',
      root.jobId,
      `${root.dimensionId}.jsonl`
    );
    return readFileSync(filePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('warns with file, original length and transformation kind when the entry cap truncates an oversized capture, without changing the persisted entry', () => {
    expect(oversizedSource.length).toBeGreaterThan(EVIDENCE_ENTRY_MAX_CHARS);
    const warn = spyWarn();
    const root = coordinates();
    const authority = createProductionEvidenceLedgerAuthority(root);

    const entry = authority.capture.capture({
      tool: 'code.read',
      callId: 'call:strict-fact:oversized',
      file: 'src/oversized.ts',
      content: oversizedSource,
    });

    // 现有脱敏+截断语义保持不变：诊断不改变写入内容与返回值。
    expect(entry.content).not.toBe(oversizedSource);
    expect(entry.content.length).toBe(EVIDENCE_ENTRY_MAX_CHARS);
    expect(entry.content.endsWith(`\n${EVIDENCE_TRUNCATION_MARKER}`)).toBe(true);
    expect(entry.contentHash).toBe(hashEvidenceContent(entry.content));
    expect(authority.read.get(entry.id)).toEqual(entry);
    const [persisted] = readPersistedLines(root);
    expect(persisted?.content).toBe(entry.content);
    expect(persisted?.contentHash).toBe(entry.contentHash);

    const calls = transformationCalls(warn);
    expect(calls).toHaveLength(1);
    const [message, meta] = calls[0] as [string, Record<string, unknown>];
    expect(message).toContain('transformed');
    expect(meta).toMatchObject({
      evidenceId: entry.id,
      callId: 'call:strict-fact:oversized',
      file: 'src/oversized.ts',
      originalLength: oversizedSource.length,
      storedLength: EVIDENCE_ENTRY_MAX_CHARS,
      transformations: ['truncated'],
    });
    // 诊断只能带长度与变换类型，不得回显原文。
    expect(JSON.stringify(calls)).not.toContain('oversizedWitnessLine');
  });

  it('warns with the redaction kind when credential-shaped literals are rewritten and keeps the secret out of the diagnostic', () => {
    const warn = spyWarn();
    const root = coordinates();
    const authority = createProductionEvidenceLedgerAuthority(root);

    const entry = authority.capture.capture({
      tool: 'code.read',
      callId: 'call:strict-fact:secret',
      file: 'src/config.ts',
      range: { start: 1, end: 2 },
      content: secretSource,
    });

    expect(entry.content).not.toContain('hunter2hunter2');
    expect(entry.content).not.toContain('sk-proj-');
    expect(entry.content).not.toBe(secretSource);
    expect(entry.content.endsWith(`\n${EVIDENCE_TRUNCATION_MARKER}`)).toBe(false);
    expect(authority.read.get(entry.id)).toEqual(entry);
    const [persisted] = readPersistedLines(root);
    expect(persisted?.content).toBe(entry.content);

    const calls = transformationCalls(warn);
    expect(calls).toHaveLength(1);
    const [, meta] = calls[0] as [string, Record<string, unknown>];
    expect(meta).toMatchObject({
      evidenceId: entry.id,
      file: 'src/config.ts',
      range: '1-2',
      originalLength: secretSource.length,
      storedLength: entry.content.length,
      transformations: ['redacted'],
    });
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain('hunter2hunter2');
    expect(serialized).not.toContain('sk-proj-');
  });

  it('reports both redaction and truncation for an oversized capture that also carries secrets', () => {
    const warn = spyWarn();
    const authority = createProductionEvidenceLedgerAuthority(coordinates());
    const content = `${secretSource}${oversizedSource}`;

    const entry = authority.capture.capture({
      tool: 'code.read',
      callId: 'call:strict-fact:both',
      file: 'src/both.ts',
      content,
    });

    expect(entry.content.length).toBe(EVIDENCE_ENTRY_MAX_CHARS);
    expect(entry.content).not.toContain('hunter2hunter2');
    const calls = transformationCalls(warn);
    expect(calls).toHaveLength(1);
    const [, meta] = calls[0] as [string, Record<string, unknown>];
    expect(meta).toMatchObject({
      file: 'src/both.ts',
      originalLength: content.length,
      storedLength: EVIDENCE_ENTRY_MAX_CHARS,
      transformations: ['redacted', 'truncated'],
    });
    expect(JSON.stringify(calls)).not.toContain('hunter2hunter2');
  });

  it('stays silent for a capture that is persisted verbatim', () => {
    const warn = spyWarn();
    const authority = createProductionEvidenceLedgerAuthority(coordinates());
    const content = 'export const fact = true;\nexport const other = 1;\n';

    const entry = authority.capture.capture({
      tool: 'code.read',
      callId: 'call:strict-fact:verbatim',
      file: 'src/fact.ts',
      content,
    });

    expect(entry.content).toBe(content);
    expect(entry.contentHash).toBe(hashEvidenceContent(content));
    expect(transformationCalls(warn)).toHaveLength(0);
  });

  it('keeps the capture result and persisted entry when the diagnostic channel itself throws', () => {
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => {
      throw new Error('diagnostic channel unavailable');
    });
    const root = coordinates();
    const authority = createProductionEvidenceLedgerAuthority(root);

    const entry = authority.capture.capture({
      tool: 'code.read',
      callId: 'call:strict-fact:logger-down',
      file: 'src/oversized.ts',
      content: oversizedSource,
    });

    expect(entry.id).toBe('E-1');
    expect(entry.content.length).toBe(EVIDENCE_ENTRY_MAX_CHARS);
    expect(authority.read.get('E-1')).toEqual(entry);
    expect(authority.read.strictSnapshot().entries).toEqual([entry]);
    expect(readPersistedLines(root)).toHaveLength(1);
  });
});

function captureError(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}
