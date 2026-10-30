import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  readEvidenceJson,
  scopedExecutionCurrentErrors,
  validatePilotShape,
  validateScopedExecutionShape,
  validateSnapshotShape,
} from '../scripts/evidence.mjs';
import { validateRenderReceipt } from '../scripts/render-contract.mjs';

test('missing, malformed and structurally invalid evidence remain distinct', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-evidence-'));
  const p = path.join(dir, 'data.json');
  try {
    assert.equal(readEvidenceJson(p).status, 'missing');
    fs.writeFileSync(p, '{bad');
    assert.equal(readEvidenceJson(p).status, 'invalid');
    fs.writeFileSync(p, JSON.stringify({ status: 'pass', scenarios: [] }));
    assert.equal(readEvidenceJson(p, validatePilotShape).status, 'invalid');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('malformed renderer arrays and mismatched snapshot identity cannot become pass', () => {
  assert.ok(
    validateRenderReceipt(
      { renderer: 'mermaid', rendererVersion: '1', checkedAt: '2026-10-22', results: null },
      [],
      '1',
    ).length,
  );
  assert.ok(
    validateRenderReceipt(
      { renderer: 'mermaid', rendererVersion: '1', checkedAt: '2026-10-22', results: [null] },
      [],
      '1',
    ).length,
  );
  assert.ok(validateSnapshotShape({ id: 'different' }, 'expected').length);
});

test('non-pass receipts still validate nested scenario records', () => {
  for (const status of ['fail', 'running']) {
    assert.ok(validatePilotShape({ status, scenarios: [null] }).length);
  }
});

test('scoped execution pass requires the observed passing cases, stable inputs and matching counts', () => {
  const group = {
    id: 'scoped',
    file: 'test/example.test.ts',
    sourcePatterns: ['src/**/*.ts'],
    sourceFingerprint: 'sha256:fixture',
    status: 'pass',
    passed: 1,
    failed: 0,
    skipped: 20,
    cases: [{ title: 'actual case', status: 'passed' }],
    exitCode: 0,
    inputStableDuringRun: true,
    inputFreshness: 'matched',
  };
  const report = { schemaVersion: 1, groups: [group] };
  assert.deepEqual(validateScopedExecutionShape(report), []);
  assert.deepEqual(scopedExecutionCurrentErrors(report), []);
  assert.ok(
    scopedExecutionCurrentErrors({
      schemaVersion: 1,
      groups: [{ ...group, inputFreshness: 'stale' }],
    }).length,
  );
  assert.ok(
    scopedExecutionCurrentErrors({ schemaVersion: 1, groups: [{ ...group, status: 'fail' }] })
      .length,
  );
  for (const change of [
    { ...group, passed: 2 },
    { ...group, cases: [] },
    { ...group, inputStableDuringRun: false },
    { ...group, sourcePatterns: [] },
  ]) {
    assert.ok(validateScopedExecutionShape({ schemaVersion: 1, groups: [change] }).length);
  }
});
