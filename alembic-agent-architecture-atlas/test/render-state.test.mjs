import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  beginRenderAttempt,
  cancelRenderAttempt,
  finishRenderAttempt,
  latestRenderErrors,
  renderEvidenceErrors,
  renderInputFingerprint,
} from '../scripts/render-state.mjs';

const diagrams = [{ id: 'x#1', digest: 'sha256:code' }],
  version = '12';
const receipt = {
  renderer: 'mermaid',
  rendererVersion: version,
  checkedAt: '2026-10-22T00:00:00Z',
  results: [{ id: 'x#1', digest: 'sha256:code', status: 'pass', width: 20, height: 20 }],
};
const fingerprint = renderInputFingerprint(diagrams, version);
test('running, failed or cancelled latest attempts never reuse an old pass as current success', () => {
  const running = beginRenderAttempt(fingerprint);
  assert.ok(latestRenderErrors(running, diagrams, version).length);
  const failed = finishRenderAttempt(
    running,
    running.id,
    { ...receipt, results: [{ ...receipt.results[0], status: 'fail', width: 0 }] },
    diagrams,
    version,
  );
  assert.equal(failed.status, 'fail');
  assert.ok(latestRenderErrors(failed, diagrams, version).length);
  const pass = finishRenderAttempt(running, running.id, receipt, diagrams, version);
  assert.deepEqual(latestRenderErrors(pass, diagrams, version), []);
  assert.equal(cancelRenderAttempt(running, running.id).status, 'cancelled');
});
test('late or wrong-input completion cannot supersede the latest verification identity', () => {
  const old = beginRenderAttempt(fingerprint),
    newer = beginRenderAttempt(fingerprint);
  assert.throws(() => finishRenderAttempt(newer, old.id, receipt, diagrams, version), /identity/);
  assert.throws(
    () =>
      finishRenderAttempt(
        old,
        old.id,
        receipt,
        [...diagrams, { id: 'new', digest: 'new' }],
        version,
      ),
    /changed/,
  );
  const cancelled = cancelRenderAttempt(old, old.id);
  assert.throws(
    () => finishRenderAttempt(cancelled, old.id, receipt, diagrams, version),
    /running/,
  );
});

test('a delayed begin cannot replace a newer attempt that already acquired authority', () => {
  const initial = beginRenderAttempt(fingerprint);
  const newer = beginRenderAttempt(fingerprint, initial, initial.id);
  assert.throws(() => beginRenderAttempt(fingerprint, newer, initial.id), /authority/);
  const retried = beginRenderAttempt(fingerprint, newer, newer.id);
  assert.notEqual(retried.id, newer.id);
});

test('matching pass identity alone cannot hide a missing successful receipt', () => {
  const running = beginRenderAttempt(fingerprint);
  const passed = finishRenderAttempt(running, running.id, receipt, diagrams, version);
  assert.ok(renderEvidenceErrors(passed, null, diagrams, version).length);
  assert.ok(renderEvidenceErrors(passed, { ...receipt, results: [] }, diagrams, version).length);
  assert.deepEqual(renderEvidenceErrors(passed, receipt, diagrams, version), []);
});
