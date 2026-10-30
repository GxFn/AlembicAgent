import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  auditAtlasFiles,
  classifyAtlasFile,
  inspectAtlasFiles,
  REQUIRED_ATLAS_FILES,
} from '../scripts/check-files.mjs';

const core = () => REQUIRED_ATLAS_FILES.map((file) => ({ path: file, type: 'file', bytes: 1 }));
const kept = [
  'README.md',
  '.gitignore',
  'package-lock.json',
  'src/main.ts',
  'src/styles.css',
  'scripts/check-files.mjs',
  'scripts/render-state.d.mts',
  'test/file-policy.test.mjs',
  'test/reader.test.ts',
  'maps/13-end-to-end/overview.md',
  'docs/architecture.md',
  'planning/2026-10-29-review.md',
  'planning/2026-10-23-assessment.json',
  'evidence/readings.json',
  'evidence/scenarios.json',
  'evidence/execution-plan.json',
  'evidence/scoped-execution.json',
  'evidence/pilot.json',
  'evidence/scope.json',
  'evidence/reviews/source-full-v6.json',
  'evidence/render/current.json',
  'evidence/render/latest-attempt.json',
  'evidence/iterations/v5-v7-validation.json',
  'evidence/iterations/v4-scope.json',
  'evidence/executions/archive-index.json',
];
const excluded = [
  'evidence/current.json',
  'evidence/snapshots/agent-atlas-2026-10-23-v6/snapshot.store.json',
  'evidence/snapshots/agent-atlas-2026-10-23-v6/snapshot.json',
  'evidence/snapshots/old/snapshot.json',
  'evidence/snapshots/objects/not-a-hash.json.gz',
  `evidence/snapshots/objects/${'a'.repeat(64)}.json.gz`,
  'node_modules/pkg/index.js',
  'dist/index.html',
  '.cache/receipt.json',
  '.sites-runtime/site.json',
  'coverage/result.json',
  'evidence/live/bootstrap.json',
  `evidence/executions/results/${'a'.repeat(64)}.json`,
  'evidence/executions/history/old.json',
  'evidence/executions/plans/old.json',
  'evidence/ui/reading-tasks-v7.json',
  'evidence/ui/screen.png',
  'evidence/public-entrypoints.json',
  'evidence/bundle-report.json',
  'evidence/validation.json',
  'evidence/iterations/v5-v7-scope.json',
  'evidence/iterations/v6-full-scope.json',
  'evidence/reviews/atlas-maintenance-review-v6.json',
  'evidence/reviews/full-corrections-v6.json',
];

test('policy retains source/contracts and canonical/history records and names each reason', () => {
  for (const file of kept) {
    const result = classifyAtlasFile(file);
    assert.equal(result.decision, 'keep', file);
    assert.ok(result.category && result.reason, file);
  }
  const result = auditAtlasFiles(core(), { details: true });
  assert.equal(result.ok, true);
  assert.equal(result.summary.bytes, REQUIRED_ATLAS_FILES.length);
  assert.equal(result.files.length, REQUIRED_ATLAS_FILES.length);
  assert.match(result.meaning, /提交边界/);
  assert.match(result.meaning, /不.*新鲜|不.*事实/);
});

test('derived and redundant records remain excluded even inside otherwise retained categories', () => {
  for (const file of excluded) {
    assert.equal(classifyAtlasFile(file).decision, 'exclude', file);
    const result = auditAtlasFiles([...core(), { path: file, type: 'file', bytes: 12 }]);
    assert.equal(result.ok, false, file);
    assert.equal(result.summary.exclude, 1, file);
    assert.ok(
      result.errors.some((error) => error.includes(file)),
      file,
    );
  }
});

test('unknown paths, unsafe names, links and missing core entries cannot pass', () => {
  for (const file of [
    'notes.txt',
    'src/temporary.ts',
    'scripts/debug.js',
    'evidence/random.json',
    'planning/unknown.json',
    '../escape',
    '/absolute',
    'src\\main.ts',
  ]) {
    assert.equal(classifyAtlasFile(file).decision, 'unknown', file);
    assert.equal(auditAtlasFiles([...core(), { path: file, type: 'file', bytes: 1 }]).ok, false);
  }
  assert.equal(auditAtlasFiles([]).ok, false);
  const omitted = core().filter((entry) => entry.path !== 'metadata.schema.json');
  assert.ok(
    auditAtlasFiles(omitted).errors.some((error) => error.includes('metadata.schema.json')),
  );
  const linked = core().map((entry) =>
    entry.path === 'src/main.ts' ? { ...entry, type: 'symlink' } : entry,
  );
  assert.ok(auditAtlasFiles(linked).errors.some((error) => /symlink/iu.test(error)));
  assert.equal(auditAtlasFiles([...core(), core()[0]]).ok, false);
  assert.equal(auditAtlasFiles([{ path: 'README.md', type: 'file', bytes: -1 }]).ok, false);
});

function fixture(run) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-file-policy-'));
  const repository = path.join(parent, 'repo');
  const atlas = path.join(repository, 'atlas');
  fs.mkdirSync(atlas, { recursive: true });
  const git = (...args) =>
    execFileSync('git', args, { cwd: repository, stdio: 'pipe', encoding: 'utf8' });
  const write = (relative, value = '{}\n') => {
    const file = path.join(atlas, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  git('init', '-q');
  for (const file of REQUIRED_ATLAS_FILES) {
    write(file);
  }
  try {
    return run({ parent, repository, atlas, git, write });
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

test('Git candidates include ignored tracked artifacts, omit ignored local data, and never change the index', () =>
  fixture(({ atlas, git, write }) => {
    write('.gitignore', 'dist/\n.cache/\nevidence/executions/results/\n');
    write('dist/blocked.json');
    write('.cache/local.json');
    write(`evidence/executions/results/${'a'.repeat(64)}.json`);
    assert.equal(inspectAtlasFiles(atlas).ok, true);
    git('add', '-f', '--', 'atlas/dist/blocked.json');
    const before = git('ls-files', '--stage');
    const result = inspectAtlasFiles(atlas, { details: true });
    assert.equal(result.ok, false);
    assert.ok(
      result.files.some((file) => file.path === 'dist/blocked.json' && file.decision === 'exclude'),
    );
    assert.ok(!result.files.some((file) => file.path.startsWith('.cache/')));
    assert.equal(git('ls-files', '--stage'), before);
  }));

test('tracked files beneath a replaced symlink directory are rejected without reading their targets', () =>
  fixture(({ atlas, parent, git }) => {
    git('add', '--', 'atlas/src');
    const outside = path.join(parent, 'outside');
    fs.renameSync(path.join(atlas, 'src'), outside);
    fs.symlinkSync(outside, path.join(atlas, 'src'), 'dir');
    const result = inspectAtlasFiles(atlas);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => /symlink/iu.test(error)));
  }));

test('deleted tracked files and ignored core inputs cannot hide behind a nonempty candidate set', () =>
  fixture(({ atlas, git, write }) => {
    git('add', '--', 'atlas/src/main.ts');
    fs.unlinkSync(path.join(atlas, 'src/main.ts'));
    let result = inspectAtlasFiles(atlas);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('src/main.ts')));
    write('src/main.ts');
    write('.gitignore', 'metadata.schema.json\n');
    result = inspectAtlasFiles(atlas);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes('metadata.schema.json')));
  }));

test('CLI rejects unknown arguments before enumerating files', () => {
  const command = fileURLToPath(new URL('../scripts/check-files.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [command, '--unsafe'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage|参数/u);
});
