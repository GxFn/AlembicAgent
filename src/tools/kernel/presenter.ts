/**
 * Tool result presenter helpers — render the ordinary-output text and the
 * envelope type guard. Canonical home (formerly
 * src/tools/core/ToolResultPresenter.ts).
 */

import { projectToolResultOrdinaryOutput, type ToolResultEnvelope } from './result.js';

export function presentToolResult(envelope: ToolResultEnvelope) {
  return projectToolResultOrdinaryOutput(envelope).text;
}

export function isToolResultEnvelope(value: unknown): value is ToolResultEnvelope {
  try {
    if (!isDataRecord(value)) {
      return false;
    }
    return (
      typeof value.ok === 'boolean' &&
      hasStrings(value, ['toolId', 'callId', 'startedAt', 'text']) &&
      nonnegativeNumber(value.durationMs) &&
      oneOf(value.status, [
        'success',
        'partial',
        'error',
        'blocked',
        'aborted',
        'timeout',
        'needs-confirmation',
      ]) &&
      optionalString(value.parentCallId) &&
      optionalString(value.nextActionHint) &&
      isTrust(value.trust) &&
      isDiagnostics(value.diagnostics) &&
      (value.cache === undefined ||
        (isDataRecord(value.cache) &&
          typeof value.cache.hit === 'boolean' &&
          oneOf(value.cache.policy, ['none', 'session', 'scope', 'persistent']))) &&
      (value.artifacts === undefined ||
        arrayOf(
          value.artifacts,
          (ref) =>
            isDataRecord(ref) &&
            hasStrings(ref, ['id', 'uri']) &&
            oneOf(ref.kind, ['file', 'log', 'stdout', 'stderr', 'image', 'resource']) &&
            optionalString(ref.mimeType) &&
            (ref.sizeBytes === undefined || nonnegativeNumber(ref.sizeBytes))
        )) &&
      (value.resources === undefined ||
        arrayOf(
          value.resources,
          (ref) =>
            isDataRecord(ref) &&
            hasStrings(ref, ['uri']) &&
            optionalString(ref.title) &&
            optionalString(ref.mimeType)
        ))
    );
  } catch (err: unknown) {
    // revoked proxy 等不可读形态不是真实信封；不执行或泄露宿主异常的文字。
    void err;
    return false;
  }
}

function isDataRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === null || prototype === Object.prototype) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((property) => 'value' in property)
  );
}

function hasStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key) && typeof value[key] === 'string');
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function oneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value);
}

function nonnegativeNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function arrayOf(value: unknown, matches: (item: unknown) => boolean): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property || !('value' in property) || !matches(property.value)) {
      return false;
    }
  }
  return true;
}

function isTrust(value: unknown): boolean {
  return (
    isDataRecord(value) &&
    oneOf(value.source, ['internal', 'terminal', 'mcp', 'skill', 'macos', 'user']) &&
    typeof value.sanitized === 'boolean' &&
    typeof value.containsUntrustedText === 'boolean' &&
    typeof value.containsSecrets === 'boolean'
  );
}

function isDiagnostics(value: unknown): boolean {
  return (
    isDataRecord(value) &&
    typeof value.degraded === 'boolean' &&
    typeof value.fallbackUsed === 'boolean' &&
    ['truncatedToolCalls', 'emptyResponses', 'aiErrorCount'].every((key) =>
      nonnegativeNumber(value[key])
    ) &&
    arrayOf(
      value.warnings,
      (warning) =>
        isDataRecord(warning) &&
        hasStrings(warning, ['code', 'message']) &&
        optionalString(warning.stage) &&
        optionalString(warning.tool)
    ) &&
    arrayOf(value.timedOutStages, (stage) => typeof stage === 'string') &&
    arrayOf(
      value.blockedTools,
      (entry) => isDataRecord(entry) && hasStrings(entry, ['tool', 'reason'])
    ) &&
    arrayOf(
      value.gateFailures,
      (entry) =>
        isDataRecord(entry) &&
        hasStrings(entry, ['stage', 'action']) &&
        optionalString(entry.reason)
    ) &&
    (value.toolCalls === undefined ||
      arrayOf(
        value.toolCalls,
        (entry) =>
          isDataRecord(entry) &&
          hasStrings(entry, ['tool', 'callId', 'status', 'startedAt']) &&
          typeof entry.ok === 'boolean' &&
          nonnegativeNumber(entry.durationMs) &&
          ['parentCallId', 'surface', 'source', 'kind'].every((key) => optionalString(entry[key]))
      ))
  );
}
