import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateScopedExecutionShape, validateSnapshotShape } from './evidence.mjs';
import { executionArtifactErrors, normalizedExecutionArtifact } from './maintenance.mjs';
import {
  readConfinedFile,
  readSnapshot,
  snapshotIds,
  writeImmutableFile,
} from './snapshot-store.mjs';

const defaultAtlasDirectory = fileURLToPath(new URL('..', import.meta.url));
const usage =
  'Usage: execution-results.mjs verify | export --source current|<snapshot-id> --group <group-id>';
const meaning =
  'Checks stored evidence self-consistency only; no test execution, source freshness check, independent witness, or evidence-level upgrade.';
const validId = (id) =>
  typeof id === 'string' && /^[a-z0-9][a-z0-9-]{2,60}$/u.test(id) && id !== 'objects';

function parseArguments(args) {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    throw new Error(usage);
  }
  if (args.length === 1 && args[0] === 'verify') {
    return { command: 'verify' };
  }
  if (args.length !== 5 || args[0] !== 'export') {
    throw new Error(usage);
  }
  const values = new Map();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    if (!['--source', '--group'].includes(flag) || values.has(flag)) {
      throw new Error(usage);
    }
    values.set(flag, args[index + 1]);
  }
  const source = values.get('--source');
  const group = values.get('--group');
  if (!validId(source) || typeof group !== 'string' || !/^[a-z0-9-]+$/u.test(group)) {
    throw new Error(`Invalid execution source or group identity. ${usage}`);
  }
  return { command: 'export', source, group };
}

function historyRoot(atlas) {
  for (const relative of ['', 'evidence', 'evidence/snapshots']) {
    const info = fs.lstatSync(path.join(atlas, relative));
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Invalid directory or symlink in execution history: ${relative || 'atlas'}`);
    }
  }
  return path.join(atlas, 'evidence/snapshots');
}
function validatedReport(source, report) {
  if (report == null) {
    return { source, report: null };
  }
  const errors = validateScopedExecutionShape(report);
  if (errors.length) {
    throw new Error(`Execution source ${source}: ${errors.join('; ')}`);
  }
  return { source, report };
}
function currentSource(atlas) {
  const bytes = readConfinedFile(atlas, 'evidence/scoped-execution.json');
  const report = JSON.parse(bytes.toString('utf8'));
  if (!report) {
    throw new Error('Missing current execution report');
  }
  return validatedReport('current', report);
}
function historicalSource(root, source) {
  const snapshot = readSnapshot(root, source);
  const errors = validateSnapshotShape(snapshot, source);
  if (errors.length) {
    throw new Error(`Historical execution source ${source}: ${errors.join('; ')}`);
  }
  return validatedReport(source, snapshot.scopedRuns);
}
function resultBytes(group) {
  if (group.status === 'running') {
    throw new Error(`Execution result is unfinished/running: ${group.id}`);
  }
  const artifact = normalizedExecutionArtifact(group);
  const errors = executionArtifactErrors(group, artifact);
  if (errors.length) {
    throw new Error(errors.join('; '));
  }
  return Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
}

/** 显式来源选择；导出只写 ignored 缓存，旧 resultArtifact 路径不再是读取前提。 */
export function runExecutionResults(args, atlasDirectory = defaultAtlasDirectory) {
  const options = parseArguments(args);
  const atlas = path.resolve(atlasDirectory);
  if (options.command === 'export') {
    const source =
      options.source === 'current'
        ? currentSource(atlas)
        : historicalSource(historyRoot(atlas), options.source);
    if (source.report?.schemaVersion !== 2) {
      throw new Error(
        'Legacy schema1 or unrecorded sources cannot be exported as exact schema2 results',
      );
    }
    const group = source.report.groups.find((entry) => entry.id === options.group);
    if (!group) {
      throw new Error(`Unknown execution group in ${options.source}: ${options.group}`);
    }
    const bytes = resultBytes(group);
    const destination = `.cache/execution-exports/${source.source}/${group.resultArtifactDigest.slice(7)}.json`;
    writeImmutableFile(atlas, destination, bytes, { reuse: true });
    if (!readConfinedFile(atlas, destination).equals(bytes)) {
      throw new Error(`Execution export byte mismatch: ${group.id}`);
    }
    return {
      schemaVersion: 1,
      command: 'export',
      source: source.source,
      groupId: group.id,
      destination,
      resultArtifactDigest: group.resultArtifactDigest,
      bytes: bytes.length,
      meaning,
    };
  }

  const root = historyRoot(atlas);
  const sources = [
    currentSource(atlas),
    ...snapshotIds(root).map((id) => historicalSource(root, id)),
  ];
  const results = new Map();
  let terminalGroups = 0;
  let runningGroups = 0;
  const summary = sources.map(({ source, report }) => {
    const statuses = {};
    for (const group of report?.groups ?? []) {
      statuses[group.status] = (statuses[group.status] ?? 0) + 1;
      if (report.schemaVersion !== 2) {
        continue;
      }
      if (group.status === 'running') {
        runningGroups += 1;
      } else {
        const bytes = resultBytes(group);
        terminalGroups += 1;
        results.set(group.resultArtifactDigest, bytes.length);
      }
    }
    return {
      source,
      schemaVersion: report?.schemaVersion ?? null,
      groups: report?.groups.length ?? 0,
      recordedStatuses: statuses,
    };
  });
  return {
    schemaVersion: 1,
    command: 'verify',
    ok: true,
    meaning,
    sources: summary,
    totals: {
      sources: sources.length,
      legacySources: sources.filter((s) => s.report?.schemaVersion === 1).length,
      unrecordedSources: sources.filter((s) => !s.report).length,
      terminalGroups,
      runningGroups,
      uniqueResults: results.size,
      repeatedReferences: terminalGroups - results.size,
      normalizedBytes: [...results.values()].reduce((sum, size) => sum + size, 0),
    },
  };
}

/** 原子替换当前报告；只负责完整落盘，不更新或重新解释任何证据声明。 */
export function writeExecutionReport(destination, report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Execution report must be a JSON object');
  }
  const serialized = JSON.stringify(report, null, 2);
  if (serialized === undefined) {
    throw new Error('Execution report serialization produced no JSON');
  }
  const bytes = Buffer.from(`${serialized}\n`);
  const file = path.resolve(destination);
  const directory = path.dirname(file);
  const parent = fs.lstatSync(directory);
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error('Execution report parent directory or symlink rejected');
  }
  let previous;
  try {
    previous = fs.lstatSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  if (previous && (previous.isSymbolicLink() || !previous.isFile())) {
    throw new Error('Execution report destination file or symlink rejected');
  }
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let descriptor;
  let failure;
  try {
    descriptor = fs.openSync(temporary, 'wx', previous ? previous.mode & 0o777 : 0o644);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } catch (error) {
    failure = new Error(
      `Atomic execution report write failed: ${error?.code ?? 'write/publish error'}`,
      { cause: error },
    );
  }
  if (descriptor !== undefined) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      failure ??= new Error('Execution report temporary descriptor cleanup failed', {
        cause: error,
      });
    }
  }
  try {
    fs.unlinkSync(temporary);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      failure ??= new Error('Execution report temporary file cleanup failed', { cause: error });
    }
  }
  if (failure) {
    throw failure;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(runExecutionResults(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Execution results command failed');
    process.exitCode = 1;
  }
}
