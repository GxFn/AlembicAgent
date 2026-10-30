import { createHash, randomUUID } from 'node:crypto';
import { renderInputKey, validateRenderReceipt } from './render-contract.mjs';
export const renderInputFingerprint = (diagrams, version) =>
  `sha256:${createHash('sha256').update(renderInputKey(diagrams, version)).digest('hex')}`;
export function beginRenderAttempt(inputFingerprint, previous = null, expectedId = null) {
  if ((previous?.id ?? null) !== expectedId) {
    throw new Error('Render attempt authority changed; inspect before retry');
  }
  return {
    id: randomUUID(),
    status: 'running',
    startedAt: new Date().toISOString(),
    inputFingerprint,
  };
}
function assertRunning(previous, id) {
  if (!previous || previous.id !== id) {
    throw new Error('Render attempt identity mismatch; late result rejected');
  }
  if (previous.status !== 'running') {
    throw new Error('Render attempt is no longer running');
  }
}
export function finishRenderAttempt(previous, id, receipt, diagrams, version) {
  assertRunning(previous, id);
  if (previous.inputFingerprint !== renderInputFingerprint(diagrams, version)) {
    throw new Error('Render inputs changed; start a new verification');
  }
  const errors = validateRenderReceipt(receipt, diagrams, version);
  return {
    ...previous,
    status: errors.length ? 'fail' : 'pass',
    finishedAt: new Date().toISOString(),
    errors,
  };
}
export function cancelRenderAttempt(previous, id) {
  assertRunning(previous, id);
  return { ...previous, status: 'cancelled', finishedAt: new Date().toISOString() };
}
export function latestRenderErrors(attempt, diagrams, version) {
  if (!attempt) {
    return ['Latest browser render attempt unavailable'];
  }
  if (attempt.inputFingerprint !== renderInputFingerprint(diagrams, version)) {
    return ['Latest browser render inputs differ'];
  }
  if (attempt.status !== 'pass') {
    return [`Latest browser render attempt: ${attempt.status}`];
  }
  return [];
}

export function renderEvidenceErrors(attempt, receipt, diagrams, version) {
  return [
    ...latestRenderErrors(attempt, diagrams, version),
    ...validateRenderReceipt(receipt, diagrams, version),
  ];
}
