import fs from 'node:fs';
import {
  readingLinkErrors,
  validateExecutionV2,
  validateReadings,
  verifySnapshotIntegrity,
} from './maintenance.mjs';
import { relationErrors } from './relations.mjs';
import { readSnapshot, snapshotIds } from './snapshot-store.mjs';

/** 物理损坏必须进入证据诊断；某一版无法读取时仍明确保留其失败身份。 */
export function readSnapshotHistory(root) {
  const history = [];
  const errors = [];
  let ids;
  try {
    ids = snapshotIds(root);
  } catch (error) {
    return { history, errors: [`Snapshot storage: ${error.message}`] };
  }
  for (const id of ids) {
    try {
      const value = readSnapshot(root, id);
      const invalid = validateSnapshotShape(value, id);
      if (invalid.length) {
        errors.push(`Snapshot ${id}: ${invalid.join('; ')}`);
      } else {
        history.push(value);
      }
    } catch (error) {
      errors.push(`Snapshot ${id}: ${error.message}`);
    }
  }
  return { history, errors };
}

export function readEvidenceJson(file, validate = () => []) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const errors = validate(value);
    return errors.length
      ? { status: 'invalid', value: null, errors }
      : { status: 'ok', value, errors: [] };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { status: 'missing', value: null, errors: [] };
    }
    return { status: 'invalid', value: null, errors: ['Unreadable or malformed JSON'] };
  }
}
export function validatePilotShape(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    !['running', 'pass', 'fail'].includes(value.status) ||
    !Array.isArray(value.scenarios)
  ) {
    return ['Invalid pilot receipt shape'];
  }
  if (
    !value.scenarios.every(
      (s) => s && typeof s.id === 'string' && ['pass', 'fail'].includes(s.status),
    )
  ) {
    return ['Invalid pilot scenario records'];
  }
  if (value.status !== 'pass') {
    return [];
  }
  const expected = ['success', 'denied', 'cancel-before', 'cancel-after', 'timeout', 'partial'];
  const ids = value.scenarios.map((s) => s?.id);
  if (
    ids.length !== expected.length ||
    new Set(ids).size !== expected.length ||
    !expected.every((id) => ids.includes(id)) ||
    value.scenarios.some((s) => s?.status !== 'pass')
  ) {
    return ['Pilot pass lacks all six distinct passing scenarios'];
  }
  if (
    !Array.isArray(value.sourcePatterns) ||
    !Array.isArray(value.harnessPatterns) ||
    typeof value.sourceFingerprint !== 'string' ||
    typeof value.testFingerprint !== 'string' ||
    typeof value.harnessFingerprint !== 'string'
  ) {
    return ['Pilot input binding missing'];
  }
  return [];
}
export function validateSnapshotShape(value, id) {
  if (
    !value ||
    !/^[a-z0-9][a-z0-9-]{2,60}$/u.test(id) ||
    value.id !== id ||
    !Array.isArray(value.documents) ||
    !value.inventory ||
    !Array.isArray(value.inventory.files) ||
    !Array.isArray(value.inventory.edges) ||
    !Number.isFinite(Date.parse(value.capturedAt)) ||
    typeof value.baselineCommit !== 'string'
  ) {
    return ['Invalid snapshot shape or directory identity'];
  }
  return [...verifySnapshotIntegrity(value), ...snapshotContentErrors(value)];
}

export function snapshotContentErrors(value) {
  if (value.readingSchemaVersion === 2) {
    const readingErrors = validateReadings({ schemaVersion: 2, files: value.readings });
    if (readingErrors.length) {
      return readingErrors;
    }
  }
  const text = (x) => typeof x === 'string';
  const strings = (x) => Array.isArray(x) && x.every(text);
  const validFile = (f) =>
    f && text(f.path) && text(f.sha256) && text(f.kind) && strings(f.symbols);
  const validDoc = (d) =>
    d &&
    text(d.id) &&
    text(d.path) &&
    text(d.body) &&
    d.metadata &&
    ['title', 'topic', 'viewType', 'truthKind', 'reviewDepth'].every((k) => text(d.metadata[k])) &&
    strings(d.inputFiles) &&
    strings(d.errors) &&
    Array.isArray(d.diagrams) &&
    d.diagrams.every((g) => g && text(g.id) && text(g.source) && text(g.digest));
  if (!value.documents.every(validDoc) || !value.inventory.files.every(validFile)) {
    return ['Invalid snapshot document or file contents'];
  }
  for (const edges of [value.inventory.edges, value.inventory.externalEdges]) {
    if (
      !Array.isArray(edges) ||
      !edges.every((e) => e && text(e.from) && text(e.to) && text(e.kind))
    ) {
      return ['Invalid snapshot import edges'];
    }
  }
  if (!Array.isArray(value.inventory.unresolved)) {
    return ['Invalid unresolved-module inventory'];
  }
  if (
    value.renderReceipt &&
    (!Array.isArray(value.renderReceipt.results) ||
      !value.renderReceipt.results.every((r) => r && text(r.id)))
  ) {
    return ['Invalid snapshot render receipt'];
  }
  if (
    value.pilot &&
    (!Array.isArray(value.pilot.scenarios) ||
      !value.pilot.scenarios.every((s) => s && text(s.id) && text(s.status)))
  ) {
    return ['Invalid snapshot pilot receipt'];
  }
  const errors = [];
  if (value.readingSchemaVersion === 2) {
    errors.push(
      ...readingLinkErrors(
        value.readings,
        value.inventory,
        value.documents,
        value.readingOrigins ?? [],
        value.reviewRecords ?? {},
      ),
    );
  }
  if (value.relations) {
    errors.push(...relationErrors(value.relations, value.documents));
  }
  if (value.scopedRuns) {
    errors.push(...validateScopedExecutionShape(value.scopedRuns));
  }
  return errors;
}

export function validateScopedExecutionShape(value) {
  if (value?.schemaVersion === 2) {
    return validateExecutionV2(value);
  }
  if (value?.schemaVersion !== 1 || !Array.isArray(value.groups) || !value.groups.length) {
    return ['Invalid scoped execution report'];
  }
  const ids = new Set();
  for (const g of value.groups) {
    if (
      !g ||
      typeof g.id !== 'string' ||
      ids.has(g.id) ||
      typeof g.file !== 'string' ||
      !Array.isArray(g.sourcePatterns) ||
      !g.sourcePatterns.length ||
      !g.sourcePatterns.every((p) => typeof p === 'string') ||
      typeof g.sourceFingerprint !== 'string' ||
      !['pass', 'fail'].includes(g.status) ||
      !['passed', 'failed', 'skipped'].every((k) => Number.isSafeInteger(g[k]) && g[k] >= 0) ||
      !Array.isArray(g.cases) ||
      !g.cases.every(
        (c) => c && typeof c.title === 'string' && ['passed', 'failed'].includes(c.status),
      )
    ) {
      return ['Invalid scoped execution group'];
    }
    ids.add(g.id);
    if (
      g.cases.filter((c) => c.status === 'passed').length !== g.passed ||
      g.cases.filter((c) => c.status === 'failed').length !== g.failed ||
      (g.status === 'pass' &&
        (g.failed !== 0 || g.passed === 0 || g.exitCode !== 0 || g.inputStableDuringRun !== true))
    ) {
      return ['Scoped execution counts or pass identity inconsistent'];
    }
  }
  return [];
}

/** 当前验收与封存共用同一道门；历史只能保存采样时已核对的输入身份。 */
export function scopedExecutionCurrentErrors(value) {
  if (!value) {
    return [];
  }
  const errors = validateScopedExecutionShape(value);
  if (errors.length) {
    return errors;
  }
  return value.groups
    .filter((group) => group.status !== 'pass' || group.inputFreshness !== 'matched')
    .map((group) => `Scoped Agent execution needs review: ${group.id}`);
}
