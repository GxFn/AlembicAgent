/** 显式的Agent定向执行器：仅运行计划中的测试，记录采集集合和执行前后身份，不写产品源码。 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atlasRoot, fingerprint, gitInfo, hash, repositoryRoot } from './atlas-lib.mjs';
import { writeExecutionReport } from './execution-results.mjs';
import {
  digestEvidence,
  normalizedExecutionArtifact,
  validateExecutionV2,
} from './maintenance.mjs';

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const planPath = option('--plan') ?? 'evidence/execution-plan.json';
if (path.isAbsolute(planPath) || planPath.split('/').includes('..')) {
  throw new Error('Plan must be atlas-relative');
}
const plan = JSON.parse(fs.readFileSync(path.join(atlasRoot, planPath), 'utf8'));
if (
  plan.schemaVersion !== 1 ||
  !Array.isArray(plan.groups) ||
  new Set(plan.groups.map((g) => g.id)).size !== plan.groups.length
) {
  throw new Error('Invalid or duplicate execution plan identities');
}
const selected = plan.groups.filter((g) => !option('--group') || g.id === option('--group'));
if (!selected.length) {
  throw new Error('No selected groups');
}
const destination = path.join(atlasRoot, 'evidence/scoped-execution.json');
let prior = fs.existsSync(destination) ? JSON.parse(fs.readFileSync(destination, 'utf8')) : null;
if (prior?.schemaVersion === 1) {
  const dir = path.join(atlasRoot, 'evidence/executions/history');
  fs.mkdirSync(dir, { recursive: true });
  const original = fs.readFileSync(destination);
  const archive = path.join(dir, `${hash(original).slice(7)}.json`);
  if (!fs.existsSync(archive)) {
    fs.writeFileSync(archive, original, { flag: 'wx' });
  }
  prior = null;
}
if (prior?.schemaVersion === 2) {
  const errors = validateExecutionV2(prior);
  if (errors.length) {
    throw new Error(`Stored execution evidence is invalid; cannot resume: ${errors.join('; ')}`);
  }
}
const report =
  prior?.schemaVersion === 2
    ? prior
    : {
        schemaVersion: 2,
        checkedAt: new Date().toISOString(),
        baselineCommit: gitInfo(repositoryRoot).commit,
        scope:
          'Explicit current Agent scenarios; historical v4 receipts remain frozen in snapshots and executions/history.',
        groups: [],
        transition: plan.transition ?? null,
      };
const runnerVersion = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'node_modules/vitest/package.json')),
).version;
const harnessPatterns = [
  'scripts/run-scoped.mjs',
  'scripts/maintenance.mjs',
  'scripts/execution-results.mjs',
  'scripts/atlas-lib.mjs',
  'scripts/snapshot-store.mjs',
  'scripts/relations.mjs',
  'scripts/evidence.mjs',
  'scripts/public-entrypoints.mjs',
  'scripts/render-contract.mjs',
  'scripts/render-state.mjs',
  'metadata.schema.json',
  'package.json',
  'package-lock.json',
];
const corePath = path.join(repositoryRoot, 'node_modules/@alembic/core/package.json');
if (fs.existsSync(corePath)) {
  const core = JSON.parse(fs.readFileSync(corePath, 'utf8'));
  report.externalObservation = {
    package: '@alembic/core',
    version: core.version,
    packageFingerprint: hash(fs.readFileSync(corePath)),
    observedCommit: gitInfo(path.dirname(corePath)).commit,
    meaning:
      'Observed public dependency identity only; adjacent implementation inputs are not frozen and Core tests are not run.',
  };
}
const save = () => {
  report.checkedAt = new Date().toISOString();
  writeExecutionReport(destination, report);
};
function persistResult(group) {
  group.collectionDigest = digestEvidence(group.collection);
  group.passed = group.cases.filter((c) => c.status === 'passed').length;
  group.failed = group.cases.filter((c) => c.status === 'failed').length;
  group.skipped = group.collection.length - group.cases.length;
  group.resultDigest = digestEvidence({ cases: group.cases, exitCode: group.exitCode });
  const normalized = normalizedExecutionArtifact(group);
  const artifact = `${digestEvidence(normalized).slice(7)}.json`;
  // 保留旧导出标识与摘要；完整结果已在 group 内，显式 export 才生成本地副本。
  group.resultArtifact = `evidence/executions/results/${artifact}`;
  group.resultArtifactDigest = digestEvidence(normalized);
}
for (const selection of selected) {
  if (
    !/^[a-z0-9-]+$/u.test(selection.id) ||
    !/^test\/[\w./-]+\.test\.ts$/u.test(selection.file) ||
    selection.file.split('/').includes('..')
  ) {
    throw new Error('Invalid bounded test selection');
  }
  if (
    selection.sourceTestFingerprint &&
    hash(fs.readFileSync(path.join(repositoryRoot, selection.file))) !==
      selection.sourceTestFingerprint
  ) {
    throw new Error(`Review changed test selection before running: ${selection.file}`);
  }
  const sourcePatterns = [
    ...new Set([
      ...(selection.sourcePatterns ?? [
        'src/**/*.ts',
        'test/**/*',
        'scripts/**/*.mjs',
        'docs/**/*',
        'config/**/*',
      ]),
      selection.file,
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'vitest.config.ts',
    ]),
  ];
  const before = fingerprint(repositoryRoot, sourcePatterns),
    harness = fingerprint(atlasRoot, harnessPatterns).digest;
  const existing = report.groups.find((g) => g.id === selection.id);
  if (
    process.argv.includes('--resume') &&
    existing?.status === 'pass' &&
    existing.sourceFingerprint === before.digest &&
    existing.harnessFingerprint === harness &&
    existing.selectionDigest === digestEvidence(selection)
  ) {
    console.log(`Reuse unchanged ${selection.id}`);
    continue;
  }
  const args = [
    'node_modules/vitest/vitest.mjs',
    'run',
    selection.file,
    '--maxWorkers=1',
    '--includeTaskLocation',
  ];
  if (selection.pattern) {
    args.push('-t', selection.pattern);
  }
  const command = ['node', ...args, '--reporter=json'];
  const startedAt = new Date().toISOString();
  const group = {
    id: selection.id,
    file: selection.file,
    status: 'running',
    selectionDigest: digestEvidence(selection),
    sourcePatterns,
    sourceFiles: before.files,
    sourceFingerprint: before.digest,
    beforeFingerprint: before.digest,
    afterFingerprint: before.digest,
    inputStableDuringRun: false,
    harnessPatterns,
    harnessFingerprint: harness,
    environment: {
      node: process.version,
      runner: 'vitest',
      runnerVersion,
      platform: process.platform,
    },
    dependencyMode: selection.dependencyMode ?? 'conservative-source-and-fixtures',
    dependencyReason:
      selection.dependencyReason ??
      'Dynamic runtime/host dispatch and filesystem fixture reads require broad source/fixture binding; shared helpers and repository-reading tests remain conservatively bound.',
    command,
    startedAt,
    finishedAt: startedAt,
    collection: [],
    collectionDigest: digestEvidence([]),
    cases: [],
    passed: 0,
    failed: 0,
    skipped: 0,
    exitCode: null,
    resultDigest: digestEvidence({ cases: [], exitCode: null }),
    boundary:
      selection.boundary ??
      'Controlled Agent tests; not live provider, production host or Core internal acceptance.',
  };
  report.groups = report.groups.filter((g) => g.id !== group.id).concat(group);
  save();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-atlas-run-'));
  try {
    const output = path.join(temporary, 'result.json');
    const execution = spawnSync(
      process.execPath,
      [...args, '--reporter=json', `--outputFile=${output}`],
      { cwd: repositoryRoot, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 },
    );
    const raw = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null;
    const suite = raw?.testResults?.find(
      (s) => path.resolve(s.name) === path.join(repositoryRoot, selection.file),
    );
    const assertions = suite?.assertionResults ?? [];
    group.collection = assertions.map((c, index) => ({
      index,
      title: c.title,
      fullName: c.fullName,
      ancestorTitles: c.ancestorTitles ?? [],
      ...(c.location ? { location: { line: c.location.line, column: c.location.column } } : {}),
    }));
    group.collectionDigest = digestEvidence(group.collection);
    group.cases = assertions.flatMap((c, index) =>
      ['passed', 'failed'].includes(c.status)
        ? [
            {
              fileCaseIndex: index,
              caseId: digestEvidence([group.collectionDigest, index]),
              title: c.title,
              fullName: c.fullName,
              ancestorTitles: c.ancestorTitles ?? [],
              status: c.status,
              durationMs: c.duration ?? 0,
            },
          ]
        : [],
    );
    group.passed = group.cases.filter((c) => c.status === 'passed').length;
    group.failed = group.cases.filter((c) => c.status === 'failed').length;
    group.skipped = assertions.length - group.cases.length;
    group.exitCode = execution.status;
    group.finishedAt = new Date().toISOString();
    group.afterFingerprint = fingerprint(repositoryRoot, sourcePatterns).digest;
    group.inputStableDuringRun =
      group.beforeFingerprint === group.afterFingerprint &&
      harness === fingerprint(atlasRoot, harnessPatterns).digest;
    group.status =
      execution.status === 0 && group.passed > 0 && !group.failed && group.inputStableDuringRun
        ? 'pass'
        : execution.error?.code === 'ETIMEDOUT'
          ? 'aborted'
          : 'fail';
    group.resultDigest = digestEvidence({ cases: group.cases, exitCode: group.exitCode });
    group.failureSummary =
      group.status === 'pass'
        ? null
        : (execution.error?.code ??
          `exit=${execution.status}; inspect the selected test group in the local test runner`);
    persistResult(group);
    save();
    const errors = validateExecutionV2(report);
    if (errors.length) {
      throw new Error(errors.join('; '));
    }
    console.log(
      JSON.stringify({
        id: group.id,
        status: group.status,
        passed: group.passed,
        failed: group.failed,
        skipped: group.skipped,
        inputStable: group.inputStableDuringRun,
      }),
    );
    if (group.status !== 'pass') {
      console.error(
        (execution.stderr ?? execution.stdout ?? '')
          .replaceAll(repositoryRoot, '<repository>')
          .slice(-5000),
      );
      process.exitCode = 1;
      break;
    }
  } catch (error) {
    group.status = 'fail';
    group.finishedAt = new Date().toISOString();
    group.failureSummary = error instanceof Error ? error.name : 'UnknownError';
    group.afterFingerprint = null;
    group.afterInputStatus = 'unavailable';
    group.inputStableDuringRun = false;
    persistResult(group);
    save();
    throw error;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
