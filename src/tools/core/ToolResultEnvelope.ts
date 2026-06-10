export type ToolResultStatus =
  | 'success'
  | 'partial'
  | 'error'
  | 'blocked'
  | 'aborted'
  | 'timeout'
  | 'needs-confirmation';

export const TOOL_RESULT_FORBIDDEN_ORDINARY_OUTPUT_FIELDS = Object.freeze([
  'success',
  'errorCode',
  'message',
  'data.result',
  'legacyCompatibility',
  'rawProviderRequest',
  'rawProviderResponse',
  'reasoningContent',
  'reasoning_content',
  'thoughtSignature',
  'hiddenReasoning',
  'apiKey',
  'hostCredential',
  'threadId',
] as const satisfies readonly string[]);

export interface ToolResultTrust {
  source: 'internal' | 'terminal' | 'mcp' | 'skill' | 'macos' | 'user';
  sanitized: boolean;
  containsUntrustedText: boolean;
  containsSecrets: boolean;
}

export interface ToolArtifactRef {
  id: string;
  kind: 'file' | 'log' | 'stdout' | 'stderr' | 'image' | 'resource';
  uri: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface ToolResourceRef {
  uri: string;
  title?: string;
  mimeType?: string;
}

export interface ToolResultCacheInfo {
  hit: boolean;
  policy: 'none' | 'session' | 'scope' | 'persistent';
}

export interface ToolResultDiagnostics {
  degraded: boolean;
  fallbackUsed: boolean;
  warnings: Array<{
    code: string;
    message: string;
    stage?: string;
    tool?: string;
  }>;
  timedOutStages: string[];
  blockedTools: Array<{ tool: string; reason: string }>;
  truncatedToolCalls: number;
  emptyResponses: number;
  aiErrorCount: number;
  gateFailures: Array<{ stage: string; action: string; reason?: string }>;
  toolCalls?: Array<{
    tool: string;
    callId: string;
    parentCallId?: string;
    status: string;
    ok: boolean;
    surface?: string;
    source?: string;
    kind?: string;
    startedAt: string;
    durationMs: number;
  }>;
}

export interface ToolResultEnvelope<T = unknown> {
  ok: boolean;
  toolId: string;
  callId: string;
  parentCallId?: string;
  startedAt: string;
  durationMs: number;
  status: ToolResultStatus;
  text: string;
  structuredContent?: T;
  artifacts?: ToolArtifactRef[];
  resources?: ToolResourceRef[];
  cache?: ToolResultCacheInfo;
  diagnostics: ToolResultDiagnostics;
  trust: ToolResultTrust;
  nextActionHint?: string;
}

export interface ToolResultDiagnosticSummary {
  degraded: boolean;
  fallbackUsed: boolean;
  warningCount: number;
  warningCodes: string[];
  timedOutStages: string[];
  blockedToolCount: number;
  blockedToolIds: string[];
  gateFailureCount: number;
  gateFailureStages: string[];
  aiErrorCount: number;
  truncatedToolCalls: number;
  emptyResponses: number;
  toolCallCount: number;
  redactedFieldCount: number;
  redactedFields: string[];
}

export interface ToolResultFailureTaxonomy {
  agentBranch: string;
  kind: string;
  privateDataSafe: true;
  problemClass: string;
  refPolicy: string;
  retryPolicy: string;
  retryable: boolean;
  stableId: `core.failure.${string}`;
  status: string;
}

export interface ToolResultOrdinaryOutput<T = unknown> {
  ok: boolean;
  toolId: string;
  callId: string;
  parentCallId?: string;
  startedAt: string;
  durationMs: number;
  status: ToolResultStatus;
  text: string;
  structuredContent?: T;
  artifacts?: ToolArtifactRef[];
  resources?: ToolResourceRef[];
  cache?: ToolResultCacheInfo;
  nextActionHint?: string;
  failureTaxonomy?: ToolResultFailureTaxonomy;
  diagnosticSummary: ToolResultDiagnosticSummary;
}

export interface ToolResultOrdinaryOutputProjectionOptions {
  forbiddenFields?: readonly string[];
  failureTaxonomy?: ToolResultFailureTaxonomy | null;
}

interface SanitizedValue {
  value: unknown;
  redactedFields: string[];
}

export function projectToolResultOrdinaryOutput<T = unknown>(
  envelope: ToolResultEnvelope<T>,
  options: ToolResultOrdinaryOutputProjectionOptions = {}
): ToolResultOrdinaryOutput {
  const forbiddenFields = options.forbiddenFields ?? TOOL_RESULT_FORBIDDEN_ORDINARY_OUTPUT_FIELDS;
  const sanitized = sanitizeOrdinaryValue(envelope.structuredContent, forbiddenFields);
  const failureTaxonomy = options.failureTaxonomy ?? undefined;
  const output: ToolResultOrdinaryOutput = {
    ok: envelope.ok,
    toolId: envelope.toolId,
    callId: envelope.callId,
    ...(envelope.parentCallId ? { parentCallId: envelope.parentCallId } : {}),
    startedAt: envelope.startedAt,
    durationMs: envelope.durationMs,
    status: envelope.status,
    text: envelope.text,
    ...(sanitized.value !== undefined ? { structuredContent: sanitized.value } : {}),
    ...(envelope.artifacts?.length
      ? { artifacts: envelope.artifacts.map(projectArtifactRef) }
      : {}),
    ...(envelope.resources?.length
      ? { resources: envelope.resources.map(projectResourceRef) }
      : {}),
    ...(envelope.cache ? { cache: envelope.cache } : {}),
    ...(envelope.nextActionHint ? { nextActionHint: envelope.nextActionHint } : {}),
    ...(failureTaxonomy ? { failureTaxonomy } : {}),
    diagnosticSummary: summarizeToolResultDiagnostics(
      envelope.diagnostics,
      sanitized.redactedFields
    ),
  };

  return output;
}

function summarizeToolResultDiagnostics(
  diagnostics: ToolResultDiagnostics,
  redactedFields: readonly string[]
): ToolResultDiagnosticSummary {
  return {
    degraded: diagnostics.degraded,
    fallbackUsed: diagnostics.fallbackUsed,
    warningCount: diagnostics.warnings.length,
    warningCodes: uniqueStrings(diagnostics.warnings.map((warning) => warning.code)),
    timedOutStages: uniqueStrings(diagnostics.timedOutStages),
    blockedToolCount: diagnostics.blockedTools.length,
    blockedToolIds: uniqueStrings(diagnostics.blockedTools.map((entry) => entry.tool)),
    gateFailureCount: diagnostics.gateFailures.length,
    gateFailureStages: uniqueStrings(diagnostics.gateFailures.map((entry) => entry.stage)),
    aiErrorCount: diagnostics.aiErrorCount,
    truncatedToolCalls: diagnostics.truncatedToolCalls,
    emptyResponses: diagnostics.emptyResponses,
    toolCallCount: diagnostics.toolCalls?.length ?? 0,
    redactedFieldCount: redactedFields.length,
    redactedFields: uniqueStrings(redactedFields),
  };
}

function sanitizeOrdinaryValue(value: unknown, forbiddenFields: readonly string[]): SanitizedValue {
  const forbiddenKeys = new Set(forbiddenFields.filter((field) => !field.includes('.')));
  const forbiddenPaths = new Set(forbiddenFields.filter((field) => field.includes('.')));
  const redactedFields: string[] = [];
  const sanitized = sanitizeOrdinaryNode(value, [], forbiddenKeys, forbiddenPaths, redactedFields);
  return { value: sanitized, redactedFields };
}

function sanitizeOrdinaryNode(
  value: unknown,
  path: string[],
  forbiddenKeys: ReadonlySet<string>,
  forbiddenPaths: ReadonlySet<string>,
  redactedFields: string[]
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeOrdinaryNode(item, path, forbiddenKeys, forbiddenPaths, redactedFields)
    );
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const dottedPath = childPath.join('.');
    if (forbiddenKeys.has(key) || forbiddenPaths.has(dottedPath)) {
      redactedFields.push(dottedPath);
      continue;
    }
    out[key] = sanitizeOrdinaryNode(
      child,
      childPath,
      forbiddenKeys,
      forbiddenPaths,
      redactedFields
    );
  }
  return out;
}

function projectArtifactRef(ref: ToolArtifactRef): ToolArtifactRef {
  return {
    id: ref.id,
    kind: ref.kind,
    uri: ref.uri,
    ...(ref.mimeType ? { mimeType: ref.mimeType } : {}),
    ...(ref.sizeBytes !== undefined ? { sizeBytes: ref.sizeBytes } : {}),
  };
}

function projectResourceRef(ref: ToolResourceRef): ToolResourceRef {
  return {
    uri: ref.uri,
    ...(ref.title ? { title: ref.title } : {}),
    ...(ref.mimeType ? { mimeType: ref.mimeType } : {}),
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}
