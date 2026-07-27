import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProductionEvidenceLedgerAuthority } from '../src/production.js';

const temporaryRoots = new Set<string>();

afterEach(() => {
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
