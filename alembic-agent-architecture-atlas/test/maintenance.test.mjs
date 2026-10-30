import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildHealth,
  digestEvidence,
  sealSnapshot,
  validateExecutionV2,
  validateReadings,
  verifySnapshotIntegrity,
} from '../scripts/maintenance.mjs';

const sha = `sha256:${'a'.repeat(64)}`;
function group() {
  const collection = [
    { index: 0, title: 'same label', fullName: 'suite same label', ancestorTitles: ['suite'] },
    { index: 1, title: 'same label', fullName: 'suite same label', ancestorTitles: ['suite'] },
  ];
  const collectionDigest = digestEvidence(collection);
  const cases = collection.map((c) => ({
    fileCaseIndex: c.index,
    title: c.title,
    fullName: c.fullName,
    ancestorTitles: c.ancestorTitles,
    caseId: digestEvidence([collectionDigest, c.index]),
    status: 'passed',
  }));
  const g = {
    id: 'group',
    file: 'test/a.test.ts',
    status: 'pass',
    sourcePatterns: ['src/a.ts'],
    sourceFiles: ['src/a.ts'],
    sourceFingerprint: sha,
    beforeFingerprint: sha,
    afterFingerprint: sha,
    inputStableDuringRun: true,
    command: ['node', 'vitest', 'run', 'test/a.test.ts'],
    startedAt: '2026-10-23T01:00:00Z',
    finishedAt: '2026-10-23T01:01:00Z',
    harnessFingerprint: sha,
    environment: { node: 'v24', runner: 'vitest', runnerVersion: '4' },
    collection,
    collectionDigest,
    cases,
    passed: 2,
    failed: 0,
    skipped: 0,
    exitCode: 0,
  };
  g.resultDigest = digestEvidence({ cases, exitCode: g.exitCode });
  g.resultArtifactDigest = digestEvidence({
    schemaVersion: 2,
    groupId: g.id,
    collection: g.collection,
    cases: g.cases,
    exitCode: g.exitCode,
  });
  g.resultArtifact = `evidence/executions/results/${g.resultArtifactDigest.slice(7)}.json`;
  return g;
}
test('execution identity distinguishes equal labels and rejects duplicate/misbound cases and unbound inputs', () => {
  const g = group();
  assert.deepEqual(validateExecutionV2({ schemaVersion: 2, groups: [g] }), []);
  for (const bad of [
    { ...g, cases: [g.cases[0], g.cases[0]] },
    { ...g, cases: [{ ...g.cases[0], title: 'forged' }, g.cases[1]] },
    { ...g, afterFingerprint: `sha256:${'b'.repeat(64)}` },
    { ...g, command: [] },
    { ...g, collectionDigest: sha },
    { ...g, harnessFingerprint: 'none' },
  ]) {
    assert.ok(validateExecutionV2({ schemaVersion: 2, groups: [bad] }).length);
  }
});
test('reading schema preserves legacy records but validates unique paths, depth and provenance in new records', () => {
  const f = {
    path: 'src/a.ts',
    sha256: sha,
    reading: 'full',
    freshness: 'inherited',
    role: 'role',
    basis: 'basis',
    provenance: { kind: 'retained', snapshotId: 'v4', previousSha256: sha },
  };
  assert.deepEqual(validateReadings({ schemaVersion: 2, files: [f] }), []);
  for (const files of [
    [f, f],
    [{ ...f, path: '../a' }],
    [{ ...f, reading: 'invented' }],
    [{ ...f, provenance: null }],
    [{ ...f, provenance: { kind: 'retained', snapshotId: 'v4', previousSha256: 'bad' } }],
  ]) {
    assert.ok(validateReadings({ schemaVersion: 2, files }).length);
  }
  assert.deepEqual(
    validateReadings({ schemaVersion: 1, files: [{ path: 'src/a.ts', sha256: sha }] }),
    [],
  );
});
test('snapshot integrity survives key order and detects changed historical content', () => {
  const sealed = sealSnapshot({ schemaVersion: 2, id: 'v5', documents: [{ body: 'original' }] });
  assert.deepEqual(verifySnapshotIntegrity(sealed), []);
  assert.ok(verifySnapshotIntegrity({ ...sealed, documents: [{ body: 'changed' }] }).length);
  assert.deepEqual(verifySnapshotIntegrity({ schemaVersion: 1, id: 'old' }), []);
});
test('impact report retains removed paths and separates changed docs, source readings and execution inputs', () => {
  const old = {
    id: 'v4',
    inventory: {
      files: [
        { path: 'src/a.ts', sha256: sha, kind: 'source' },
        { path: 'src/gone.ts', sha256: sha, kind: 'source' },
      ],
    },
    documents: [{ id: 'd', diagrams: [{ id: 'd#1', digest: sha }] }],
  };
  const c = {
    checkedAt: '2026-10-23',
    git: { commit: 'head' },
    inventory: {
      files: [
        { path: 'src/a.ts', sha256: 'new', kind: 'source' },
        { path: 'src/b.ts', sha256: sha, kind: 'source' },
      ],
    },
    readings: [{ path: 'src/a.ts', sha256: sha, reading: 'full' }],
    documents: [
      {
        id: 'd',
        path: 'maps/d.md',
        metadata: { title: 'Doc', sourcePaths: ['src/gone.ts'] },
        inputFiles: ['src/a.ts'],
        body: 'src/a.ts',
        freshness: 'stale',
        errors: ['source fingerprint drift'],
        diagrams: [{ id: 'd#1', digest: sha }],
      },
    ],
    scopedRuns: {
      groups: [
        {
          id: 'g',
          sourceFiles: ['src/a.ts'],
          sourcePatterns: ['src/a.ts'],
          inputFreshness: 'stale',
        },
      ],
    },
    pilotFreshness: 'stale',
    renderFreshness: 'matched',
  };
  const h = buildHealth(c, old);
  assert.deepEqual(h.changes.map((x) => x.status).sort(), ['added', 'changed', 'removed']);
  assert.equal(h.readings.stale, 1);
  assert.equal(h.readings.missing, 1);
  assert.equal(h.impacts.find((x) => x.path === 'src/gone.ts').documents[0].id, 'd');
  assert.equal(h.impacts.find((x) => x.path === 'src/a.ts').executionGroups[0], 'g');
  assert.equal(h.impacts.find((x) => x.path === 'src/b.ts').executionGroups.length, 0);
  assert.equal(h.renderNeeds.length, 0);
});

test('reading links cannot claim a missing review, a higher inherited depth or a different source identity', async () => {
  const { readingLinkErrors } = await import('../scripts/maintenance.mjs');
  const f = {
    path: 'src/a.ts',
    sha256: sha,
    reading: 'full',
    provenance: { kind: 'retained', snapshotId: 'v4', previousSha256: sha },
  };
  const inventory = { files: [{ path: f.path, sha256: sha }] };
  const previous = { id: 'v4', readings: [{ ...f, reading: 'partial' }] };
  assert.ok(readingLinkErrors([f], inventory, [], [previous], {}).length);
  const linked = {
    ...f,
    reading: 'partial',
    reviewRecord: 'evidence/review.json',
    reviewPage: 'maps/a.md',
    provenance: { kind: 'reviewed' },
  };
  assert.ok(readingLinkErrors([linked], inventory, [{ path: 'maps/a.md' }], [], {}).length);
  assert.deepEqual(
    readingLinkErrors([linked], inventory, [{ path: 'maps/a.md' }], [], {
      'evidence/review.json': { files: [{ path: f.path, sha256: sha, readingDepth: 'partial' }] },
    }),
    [],
  );
});

test('execution result artifact must match the recorded collection and case identities', async () => {
  const { executionArtifactErrors } = await import('../scripts/maintenance.mjs');
  const g = group();
  const artifact = {
    schemaVersion: 2,
    groupId: g.id,
    collection: g.collection,
    cases: g.cases,
    exitCode: g.exitCode,
  };
  g.resultArtifactDigest = digestEvidence(artifact);
  assert.deepEqual(executionArtifactErrors(g, artifact), []);
  assert.ok(executionArtifactErrors(g, { ...artifact, cases: [] }).length);
  assert.ok(executionArtifactErrors({ ...g, resultDigest: sha }, artifact).length);
});
test('local fixture, shared runtime and global configuration changes have explicit impact scopes; prose does not invalidate executions', () => {
  const paths = ['test/fixtures/a.json', 'src/runtime.ts', 'vitest.config.ts'];
  const files = paths.map((path) => ({ path, sha256: sha, kind: 'support' }));
  const base = { id: 'base', inventory: { files }, documents: [] };
  const make = (changed) => ({
    checkedAt: 'now',
    git: { commit: 'h' },
    inventory: { files: files.map((f) => ({ ...f, sha256: f.path === changed ? 'new' : sha })) },
    documents: [],
    readings: [],
    scopedRuns: {
      groups: [
        {
          id: 'local',
          sourcePatterns: ['test/fixtures/a.json', 'vitest.config.ts'],
          sourceFiles: [],
        },
        { id: 'runtime', sourcePatterns: ['src/**/*.ts', 'vitest.config.ts'], sourceFiles: [] },
      ],
    },
  });
  assert.deepEqual(buildHealth(make(paths[0]), base).impacts[0].executionGroups, ['local']);
  assert.deepEqual(buildHealth(make(paths[1]), base).impacts[0].executionGroups, ['runtime']);
  assert.deepEqual(buildHealth(make(paths[2]), base).impacts[0].executionGroups, [
    'local',
    'runtime',
  ]);
  assert.equal(buildHealth(make('maps/prose.md'), base).impacts.length, 0);
});

test('review proof cannot be upgraded from partial to full by editing the reading claim', async () => {
  const { readingLinkErrors } = await import('../scripts/maintenance.mjs');
  const r = {
    path: 'src/a.ts',
    sha256: sha,
    reading: 'full',
    reviewRecord: 'evidence/review.json',
    reviewPage: 'maps/a.md',
    provenance: { kind: 'reviewed' },
  };
  const errors = readingLinkErrors(
    [r],
    { files: [{ path: r.path, sha256: sha }] },
    [{ path: r.reviewPage }],
    [],
    { [r.reviewRecord]: { files: [{ path: r.path, sha256: sha, readingDepth: 'partial' }] } },
  );
  assert.ok(errors.some((e) => e.includes('depth exceeds')));
});

test('an interrupted after-input observation remains a valid failed report, never a passing one', () => {
  const g = {
    ...group(),
    status: 'fail',
    afterFingerprint: null,
    afterInputStatus: 'unavailable',
    inputStableDuringRun: false,
  };
  assert.deepEqual(validateExecutionV2({ schemaVersion: 2, groups: [g] }), []);
  assert.ok(validateExecutionV2({ schemaVersion: 2, groups: [{ ...g, status: 'pass' }] }).length);
});

test('terminal embedded results require the original digest even when nested result hashes are recomputed', () => {
  const g = group();
  for (const bad of [
    { ...g, resultArtifactDigest: undefined },
    { ...g, resultArtifactDigest: sha },
    { ...g, resultArtifact: '../outside.json' },
  ]) {
    assert.ok(validateExecutionV2({ schemaVersion: 2, groups: [bad] }).length);
  }
  const changed = structuredClone(g);
  changed.cases[0].durationMs = 999;
  changed.resultDigest = digestEvidence({ cases: changed.cases, exitCode: changed.exitCode });
  assert.ok(validateExecutionV2({ schemaVersion: 2, groups: [changed] }).length);
});

test('normalized execution projection is detached, preserves duration, and verifies stored claims without exports', async () => {
  const { normalizedExecutionArtifact, executionArtifactErrors } = await import(
    '../scripts/maintenance.mjs'
  );
  const g = group();
  const original = structuredClone(g);
  const projected = normalizedExecutionArtifact(g);
  assert.deepEqual(Object.keys(projected), [
    'schemaVersion',
    'groupId',
    'collection',
    'cases',
    'exitCode',
  ]);
  assert.deepEqual(executionArtifactErrors(g), []);
  assert.ok(executionArtifactErrors(g, null).length);
  projected.cases[0].durationMs = 123.456;
  assert.deepEqual(g, original);
  assert.ok(executionArtifactErrors(g, projected).length);
});

test('running groups remain unfinished; fail and aborted groups retain their terminal evidence', async () => {
  const { executionArtifactErrors } = await import('../scripts/maintenance.mjs');
  const { scopedExecutionCurrentErrors } = await import('../scripts/evidence.mjs');
  const running = {
    ...group(),
    status: 'running',
    collection: [],
    collectionDigest: digestEvidence([]),
    cases: [],
    passed: 0,
    failed: 0,
    skipped: 0,
    exitCode: null,
    inputStableDuringRun: false,
    inputFreshness: 'matched',
    resultDigest: digestEvidence({ cases: [], exitCode: null }),
  };
  delete running.resultArtifact;
  delete running.resultArtifactDigest;
  assert.deepEqual(validateExecutionV2({ schemaVersion: 2, groups: [running] }), []);
  assert.deepEqual(executionArtifactErrors(running), []);
  assert.ok(scopedExecutionCurrentErrors({ schemaVersion: 2, groups: [running] }).length);
  for (const status of ['fail', 'aborted']) {
    const g = { ...group(), status, inputStableDuringRun: false, inputFreshness: 'matched' };
    assert.deepEqual(validateExecutionV2({ schemaVersion: 2, groups: [g] }), []);
    assert.deepEqual(executionArtifactErrors(g), []);
    assert.ok(scopedExecutionCurrentErrors({ schemaVersion: 2, groups: [g] }).length);
  }
});
