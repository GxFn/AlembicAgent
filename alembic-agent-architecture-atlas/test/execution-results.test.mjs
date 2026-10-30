import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runExecutionResults, writeExecutionReport } from '../scripts/execution-results.mjs';
import { digestEvidence, sealSnapshot } from '../scripts/maintenance.mjs';
import { storeSnapshot } from '../scripts/snapshot-store.mjs';

const sha = `sha256:${'a'.repeat(64)}`;
function group(id = 'same-group', durationMs = 1.25) {
  const collection = [
    {
      index: 0,
      title: 'one case',
      fullName: 'suite one case',
      ancestorTitles: ['suite'],
      location: { line: 7, column: 3 },
    },
  ];
  const collectionDigest = digestEvidence(collection);
  const cases = [
    {
      fileCaseIndex: 0,
      caseId: digestEvidence([collectionDigest, 0]),
      title: 'one case',
      fullName: 'suite one case',
      ancestorTitles: ['suite'],
      status: 'passed',
      durationMs,
    },
  ];
  const value = {
    id,
    file: 'test/a.test.ts',
    status: 'pass',
    sourcePatterns: ['src/a.ts'],
    sourceFiles: ['src/a.ts'],
    sourceFingerprint: sha,
    beforeFingerprint: sha,
    afterFingerprint: sha,
    inputStableDuringRun: true,
    harnessPatterns: ['scripts/run-scoped.mjs'],
    harnessFingerprint: sha,
    command: ['node', 'vitest', 'run', 'test/a.test.ts'],
    startedAt: '2026-10-23T01:00:00Z',
    finishedAt: '2026-10-23T01:01:00Z',
    environment: { node: 'v24', runner: 'vitest', runnerVersion: '4' },
    collection,
    collectionDigest,
    cases,
    passed: 1,
    failed: 0,
    skipped: 0,
    exitCode: 0,
    inputFreshness: 'stale',
  };
  value.resultDigest = digestEvidence({ cases, exitCode: 0 });
  value.resultArtifactDigest = digestEvidence({
    schemaVersion: 2,
    groupId: id,
    collection,
    cases,
    exitCode: 0,
  });
  value.resultArtifact = `evidence/executions/results/${value.resultArtifactDigest.slice(7)}.json`;
  return value;
}
function report(g) {
  return { schemaVersion: 2, checkedAt: '2026-10-23T01:02:00Z', groups: [g] };
}
function fixture(run) {
  const atlas = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-execution-results-'));
  fs.mkdirSync(path.join(atlas, 'evidence/snapshots'), { recursive: true });
  try {
    return run(atlas);
  } finally {
    fs.rmSync(atlas, { recursive: true, force: true });
  }
}
function current(atlas, value = report(group())) {
  fs.writeFileSync(
    path.join(atlas, 'evidence/scoped-execution.json'),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}
function history(atlas, id, value, schemaVersion = 2) {
  let snapshot = {
    schemaVersion,
    id,
    capturedAt: '2026-10-23T01:02:00Z',
    baselineCommit: 'a'.repeat(40),
    documents: [],
    readings: [],
    inventory: { files: [], edges: [], externalEdges: [], unresolved: [] },
    ...(value ? { scopedRuns: value } : {}),
  };
  if (schemaVersion === 2) {
    snapshot = sealSnapshot(snapshot);
  }
  storeSnapshot(
    path.join(atlas, 'evidence/snapshots'),
    Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`),
  );
}

test('verify uses only embedded reports and keeps old source/harness claims unchanged', () =>
  fixture((atlas) => {
    current(atlas);
    history(atlas, 'old-one', report(group()));
    history(atlas, 'old-two', report(group('same-group', 8.75)));
    history(atlas, 'no-runs', null, 1);
    const before = fs.readFileSync(path.join(atlas, 'evidence/scoped-execution.json'));
    const result = runExecutionResults(['verify'], atlas);
    assert.equal(result.ok, true);
    assert.equal(result.totals.uniqueResults, 2);
    assert.equal(result.totals.terminalGroups, 3);
    assert.equal(result.totals.repeatedReferences, 1);
    assert.deepEqual(fs.readFileSync(path.join(atlas, 'evidence/scoped-execution.json')), before);
    assert.equal(fs.existsSync(path.join(atlas, '.cache')), false);
    assert.equal(fs.existsSync(path.join(atlas, 'evidence/executions/results')), false);
    assert.match(result.meaning, /freshness|新鲜度/u);
  }));

test('terminal corruption is rejected while running is not exported or counted as a verified result', () =>
  fixture((atlas) => {
    const bad = group();
    bad.resultArtifactDigest = `sha256:${'b'.repeat(64)}`;
    current(atlas, report(bad));
    assert.throws(() => runExecutionResults(['verify'], atlas), /artifact|digest|result/i);
    const running = {
      ...group(),
      status: 'running',
      inputStableDuringRun: false,
      collection: [],
      collectionDigest: digestEvidence([]),
      cases: [],
      passed: 0,
      failed: 0,
      skipped: 0,
      exitCode: null,
      resultDigest: digestEvidence({ cases: [], exitCode: null }),
    };
    delete running.resultArtifact;
    delete running.resultArtifactDigest;
    current(atlas, report(running));
    const result = runExecutionResults(['verify'], atlas);
    assert.equal(result.totals.runningGroups, 1);
    assert.equal(result.totals.terminalGroups, 0);
    assert.equal(result.totals.uniqueResults, 0);
    assert.throws(
      () => runExecutionResults(['export', '--source', 'current', '--group', 'same-group'], atlas),
      /unfinished|running/i,
    );
    assert.equal(fs.existsSync(path.join(atlas, '.cache')), false);
  }));

test('schema1 stays legacy and cannot be exported as exact schema2 collection evidence', () =>
  fixture((atlas) => {
    current(atlas);
    const legacy = {
      schemaVersion: 1,
      groups: [
        {
          id: 'legacy-group',
          file: 'test/old.test.ts',
          sourcePatterns: ['src/old.ts'],
          sourceFingerprint: sha,
          status: 'pass',
          passed: 1,
          failed: 0,
          skipped: 0,
          cases: [{ title: 'old label', status: 'passed' }],
          exitCode: 0,
          inputStableDuringRun: true,
        },
      ],
    };
    history(atlas, 'old-legacy', legacy, 1);
    const verified = runExecutionResults(['verify'], atlas);
    assert.equal(verified.totals.legacySources, 1);
    assert.equal(verified.totals.uniqueResults, 1);
    assert.throws(
      () =>
        runExecutionResults(['export', '--source', 'old-legacy', '--group', 'legacy-group'], atlas),
      /legacy|schema.?1/i,
    );
  }));

test('export selects a source explicitly and restores the original normalized byte format including duration', () =>
  fixture((atlas) => {
    const now = group('same-group', 1.25);
    const old = group('same-group', 8.75);
    current(atlas, report(now));
    history(atlas, 'old-one', report(old));
    const record = runExecutionResults(
      ['export', '--source', 'old-one', '--group', 'same-group'],
      atlas,
    );
    assert.equal(record.source, 'old-one');
    assert.equal(record.resultArtifactDigest, old.resultArtifactDigest);
    assert.match(record.destination, /^\.cache\/execution-exports\/old-one\/[a-f0-9]{64}\.json$/u);
    const expected = `${JSON.stringify({ schemaVersion: 2, groupId: old.id, collection: old.collection, cases: old.cases, exitCode: 0 }, null, 2)}\n`;
    assert.equal(fs.readFileSync(path.join(atlas, record.destination), 'utf8'), expected);
    const exportedAgain = runExecutionResults(
      ['export', '--group', 'same-group', '--source', 'old-one'],
      atlas,
    );
    assert.equal(exportedAgain.destination, record.destination);
    fs.writeFileSync(path.join(atlas, record.destination), 'different');
    assert.throws(
      () => runExecutionResults(['export', '--source', 'old-one', '--group', 'same-group'], atlas),
      /immutable|exists|conflict/i,
    );
    assert.equal(fs.readFileSync(path.join(atlas, record.destination), 'utf8'), 'different');
  }));

test('missing canonical data, bad scopes and symlink escapes cannot be substituted with another source', () =>
  fixture((atlas) => {
    history(atlas, 'old-one', report(group()));
    assert.throws(() => runExecutionResults(['verify'], atlas), /ENOENT|missing|read/i);
    current(atlas);
    for (const args of [
      [],
      ['verify', '--group', 'same-group'],
      ['export', '--group', 'same-group'],
      ['export', '--source', '../outside', '--group', 'same-group'],
      ['export', '--source', 'current', '--group', '../escape'],
      ['export', '--source', 'unknown-id', '--group', 'same-group'],
      ['export', '--source', 'current', '--group', 'unknown'],
      ['export', '--source', 'current', '--source', 'old-one'],
    ]) {
      assert.throws(() => runExecutionResults(args, atlas));
    }
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-export-outside-'));
    try {
      fs.symlinkSync(outside, path.join(atlas, '.cache'), 'dir');
      assert.throws(
        () =>
          runExecutionResults(['export', '--source', 'current', '--group', 'same-group'], atlas),
        /symlink/i,
      );
      assert.deepEqual(fs.readdirSync(outside), []);
      fs.unlinkSync(path.join(atlas, '.cache'));
      fs.renameSync(path.join(atlas, 'evidence'), path.join(outside, 'evidence'));
      fs.symlinkSync(path.join(outside, 'evidence'), path.join(atlas, 'evidence'), 'dir');
      assert.throws(() => runExecutionResults(['verify'], atlas), /symlink/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }));

test('atomic report writes expose complete JSON and keep old bytes after a publication failure', () =>
  fixture((atlas) => {
    const destination = path.join(atlas, 'evidence/scoped-execution.json');
    const old = report(group('old-group'));
    writeExecutionReport(destination, old);
    const original = fs.readFileSync(destination);
    const rename = fs.renameSync;
    let sawCompleteTemporary = false;
    fs.renameSync = (from, to) => {
      if (to === destination) {
        assert.deepEqual(JSON.parse(fs.readFileSync(from, 'utf8')), report(group('new-group')));
        sawCompleteTemporary = true;
        throw new Error('injected rename failure');
      }
      return rename(from, to);
    };
    try {
      assert.throws(
        () => writeExecutionReport(destination, report(group('new-group'))),
        /write|publish|rename/i,
      );
    } finally {
      fs.renameSync = rename;
    }
    assert.ok(sawCompleteTemporary);
    assert.deepEqual(fs.readFileSync(destination), original);
    assert.deepEqual(fs.readdirSync(path.dirname(destination)).sort(), [
      'scoped-execution.json',
      'snapshots',
    ]);
    writeExecutionReport(destination, report(group('new-group')));
    assert.deepEqual(JSON.parse(fs.readFileSync(destination, 'utf8')), report(group('new-group')));
  }));

test('serialization and fsync failures cannot truncate an existing report; symlink destinations are rejected', () =>
  fixture((atlas) => {
    const destination = path.join(atlas, 'evidence/scoped-execution.json');
    current(atlas);
    const original = fs.readFileSync(destination);
    const cycle = {};
    cycle.self = cycle;
    assert.throws(() => writeExecutionReport(destination, cycle));
    assert.throws(() => writeExecutionReport(destination, undefined));
    assert.throws(() => writeExecutionReport(destination, null));
    assert.throws(() => writeExecutionReport(destination, { toJSON: () => undefined }));
    assert.deepEqual(fs.readFileSync(destination), original);
    const sync = fs.fsyncSync;
    fs.fsyncSync = () => {
      throw new Error('injected sync failure');
    };
    try {
      assert.throws(
        () => writeExecutionReport(destination, report(group('new-group'))),
        /write|sync/i,
      );
    } finally {
      fs.fsyncSync = sync;
    }
    assert.deepEqual(fs.readFileSync(destination), original);
    assert.deepEqual(fs.readdirSync(path.dirname(destination)).sort(), [
      'scoped-execution.json',
      'snapshots',
    ]);
    const target = path.join(atlas, 'preserved.json');
    fs.writeFileSync(target, original);
    fs.unlinkSync(destination);
    fs.symlinkSync(target, destination);
    assert.throws(() => writeExecutionReport(destination, report(group('new-group'))), /symlink/i);
    assert.deepEqual(fs.readFileSync(target), original);
  }));

/** 真实 run-scoped CLI 配临时假产品。fake Vitest 只提供受控 JSON，绝不加载产品测试代码。 */
function scopedCliFixture(run) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-scoped-cli-fixture-'));
  const product = path.join(workspace, 'fixture-product');
  const atlas = path.join(product, 'alembic-agent-architecture-atlas');
  const sourceAtlas = path.resolve(import.meta.dirname, '..');
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  try {
    for (const file of [
      'scripts/run-scoped.mjs',
      'scripts/atlas-lib.mjs',
      'scripts/maintenance.mjs',
      'scripts/execution-results.mjs',
      'scripts/evidence.mjs',
      'scripts/snapshot-store.mjs',
      'scripts/relations.mjs',
      'scripts/public-entrypoints.mjs',
      'scripts/render-contract.mjs',
      'scripts/render-state.mjs',
      'metadata.schema.json',
      'package.json',
      'package-lock.json',
    ]) {
      write(path.join(atlas, file), fs.readFileSync(path.join(sourceAtlas, file)));
    }
    fs.symlinkSync(path.join(sourceAtlas, 'node_modules'), path.join(atlas, 'node_modules'), 'dir');
    write(
      path.join(product, 'package.json'),
      '{"name":"explicit-fixture-product","type":"module"}\n',
    );
    write(
      path.join(product, 'package-lock.json'),
      '{"name":"explicit-fixture-product","lockfileVersion":3}\n',
    );
    write(path.join(product, 'tsconfig.json'), '{"compilerOptions":{}}\n');
    write(
      path.join(product, 'vitest.config.ts'),
      '// Explicit fixture: not loaded by the fake runner.\n',
    );
    write(
      path.join(product, 'src/fixture.ts'),
      '// Fixture input only.\nexport const fixture = true;\n',
    );
    const testSource =
      '// Explicit fixture: never executed; fake Vitest supplies its recorded assertion.\n';
    write(path.join(product, 'test/fixture.test.ts'), testSource);
    write(
      path.join(product, 'node_modules/vitest/package.json'),
      '{"name":"vitest","type":"module","version":"0.0.0-fixture"}\n',
    );
    write(
      path.join(product, 'node_modules/vitest/vitest.mjs'),
      `// Explicit fake Vitest fixture; no real test framework or product module is loaded.
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] !== 'run' || args[1] !== 'test/fixture.test.ts') {
  throw new Error('Unexpected fake-runner fixture arguments');
}
const output = args.find((arg) => arg.startsWith('--outputFile='));
if (!output) {
  throw new Error('Fake runner requires an explicit result destination');
}
fs.appendFileSync('fake-vitest-invocations.log', 'fixture invocation\\n');
fs.writeFileSync(output.slice('--outputFile='.length), JSON.stringify({
  testResults: [{
    name: path.resolve('test/fixture.test.ts'),
    assertionResults: [{
      title: 'explicit fake assertion', fullName: 'fixture explicit fake assertion',
      ancestorTitles: ['fixture'], status: 'passed', duration: 1.25,
      location: {line: 1, column: 1}
    }]
  }]
}));
`,
    );
    const plan = {
      schemaVersion: 1,
      groups: [
        {
          id: 'fixture-group',
          file: 'test/fixture.test.ts',
          sourcePatterns: ['src/**/*.ts'],
          sourceTestFingerprint: `sha256:${createHash('sha256').update(testSource).digest('hex')}`,
          boundary: 'Explicit fixture only: fake Vitest JSON, no product test execution.',
          dependencyReason: 'Fixture inputs only.',
        },
      ],
    };
    write(path.join(atlas, 'evidence/execution-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    const invoke = (...args) =>
      spawnSync(process.execPath, [path.join(atlas, 'scripts/run-scoped.mjs'), ...args], {
        cwd: atlas,
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
      });
    return run({ atlas, product, invoke });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function regularFiles(root, prefix = '') {
  const files = new Map();
  for (const item of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) {
      for (const [name, contents] of regularFiles(root, relative)) {
        files.set(name, contents);
      }
    } else if (item.isFile()) {
      files.set(relative, fs.readFileSync(path.join(root, relative)));
    }
  }
  return files;
}

test('real scoped CLI with fake Vitest writes only the canonical report, never independent result exports', () =>
  scopedCliFixture(({ atlas, product, invoke }) => {
    const before = regularFiles(atlas);
    const execution = invoke();
    assert.equal(execution.status, 0, execution.stderr || execution.error?.message);
    assert.equal(
      fs.readFileSync(path.join(product, 'fake-vitest-invocations.log'), 'utf8'),
      'fixture invocation\n',
    );
    const after = regularFiles(atlas);
    assert.deepEqual(
      [...after.keys()].filter((name) => !before.has(name)),
      ['evidence/scoped-execution.json'],
    );
    for (const [name, bytes] of before) {
      assert.deepEqual(after.get(name), bytes, name);
    }
    const recorded = JSON.parse(after.get('evidence/scoped-execution.json').toString('utf8'));
    assert.equal(recorded.groups.length, 1);
    assert.equal(recorded.groups[0].status, 'pass');
    assert.equal(recorded.groups[0].inputStableDuringRun, true);
    assert.equal(recorded.groups[0].environment.runnerVersion, '0.0.0-fixture');
    assert.equal(recorded.groups[0].cases[0].durationMs, 1.25);
    assert.equal(
      recorded.groups[0].resultArtifactDigest,
      digestEvidence({
        schemaVersion: 2,
        groupId: 'fixture-group',
        collection: recorded.groups[0].collection,
        cases: recorded.groups[0].cases,
        exitCode: 0,
      }),
    );
    assert.equal(fs.existsSync(path.join(atlas, 'evidence/executions/results')), false);
  }));

test('real scoped CLI refuses a tampered terminal digest before invoking fake Vitest on resume', () =>
  scopedCliFixture(({ atlas, product, invoke }) => {
    const first = invoke();
    assert.equal(first.status, 0, first.stderr || first.error?.message);
    const calls = path.join(product, 'fake-vitest-invocations.log');
    const initialCalls = fs.readFileSync(calls);
    const unchanged = invoke('--resume');
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.match(unchanged.stdout, /Reuse unchanged fixture-group/u);
    assert.deepEqual(fs.readFileSync(calls), initialCalls);
    const file = path.join(atlas, 'evidence/scoped-execution.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.groups[0].resultArtifactDigest = `sha256:${'0'.repeat(64)}`;
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    const tampered = fs.readFileSync(file);
    const rejected = invoke('--resume');
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Stored execution evidence is invalid; cannot resume/u);
    assert.deepEqual(fs.readFileSync(calls), initialCalls);
    assert.deepEqual(fs.readFileSync(file), tampered);
    assert.equal(fs.existsSync(path.join(atlas, 'evidence/executions/results')), false);
  }));
