/**
 * Tool result contract — the single external-stable result envelope shared by
 * the Agent tool router and every host-surface tool adapter. This is the
 * canonical home (formerly src/tools/core/ToolResultEnvelope.ts); the shape is
 * preserved verbatim so existing consumers and serialized host responses stay
 * byte-compatible during the tool-system convergence.
 */

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
  warningCodes: string[];
}

interface ProjectionState {
  ancestors: Set<object>;
  remaining: number;
  redactedFields: string[];
  warningCodes: Set<string>;
}

export function projectToolResultOrdinaryOutput<T = unknown>(
  envelope: ToolResultEnvelope<T>,
  options: ToolResultOrdinaryOutputProjectionOptions = {}
): ToolResultOrdinaryOutput {
  const forbiddenFields = options.forbiddenFields ?? TOOL_RESULT_FORBIDDEN_ORDINARY_OUTPUT_FIELDS;
  const sanitized = sanitizeOrdinaryValue(envelope.structuredContent, forbiddenFields);
  const sanitizedText = sanitizeOrdinaryText(envelope.text, forbiddenFields);
  const failureTaxonomy = options.failureTaxonomy ?? undefined;
  const output: ToolResultOrdinaryOutput = {
    ok: envelope.ok,
    toolId: envelope.toolId,
    callId: envelope.callId,
    ...(envelope.parentCallId ? { parentCallId: envelope.parentCallId } : {}),
    startedAt: envelope.startedAt,
    durationMs: envelope.durationMs,
    status: envelope.status,
    text: sanitizedText.value as string,
    ...(sanitized.value !== undefined ? { structuredContent: sanitized.value } : {}),
    ...(envelope.artifacts?.length
      ? { artifacts: envelope.artifacts.map(projectArtifactRef) }
      : {}),
    ...(envelope.resources?.length
      ? { resources: envelope.resources.map(projectResourceRef) }
      : {}),
    ...(envelope.cache
      ? { cache: { hit: envelope.cache.hit, policy: envelope.cache.policy } }
      : {}),
    ...(envelope.nextActionHint ? { nextActionHint: envelope.nextActionHint } : {}),
    ...(failureTaxonomy
      ? {
          failureTaxonomy: {
            agentBranch: failureTaxonomy.agentBranch,
            kind: failureTaxonomy.kind,
            privateDataSafe: failureTaxonomy.privateDataSafe,
            problemClass: failureTaxonomy.problemClass,
            refPolicy: failureTaxonomy.refPolicy,
            retryPolicy: failureTaxonomy.retryPolicy,
            retryable: failureTaxonomy.retryable,
            stableId: failureTaxonomy.stableId,
            status: failureTaxonomy.status,
          },
        }
      : {}),
    diagnosticSummary: summarizeToolResultDiagnostics(
      envelope.diagnostics,
      uniqueStrings([...sanitized.redactedFields, ...sanitizedText.redactedFields]),
      uniqueStrings([...sanitized.warningCodes, ...sanitizedText.warningCodes])
    ),
  };

  return output;
}

/** Adapter 的 JSON 文本是同一结果的另一份载体，必须使用与结构化内容相同的字段规则。 */
function sanitizeOrdinaryText(text: string, forbiddenFields: readonly string[]): SanitizedValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err: unknown) {
    void err;
    // 非 JSON 的普通文本没有结构化字段语义，保持原样；已解析 JSON 的清理失败不能走此分支。
    return { value: text, redactedFields: [], warningCodes: [] };
  }
  try {
    const sanitized = sanitizeOrdinaryValue(parsed, forbiddenFields);
    return {
      value:
        sanitized.redactedFields.length > 0 || sanitized.warningCodes.length > 0
          ? JSON.stringify(sanitized.value, null, 2)
          : text,
      redactedFields: sanitized.redactedFields,
      warningCodes: sanitized.warningCodes,
    };
  } catch (err: unknown) {
    // 清理异常只产生固定显示诊断，不能把可能含宿主敏感信息的错误内容或原 JSON 返回。
    void err;
    return {
      value: '[unavailable: JSON display failed]',
      redactedFields: [],
      warningCodes: ['TOOL_RESULT_DISPLAY_UNSUPPORTED'],
    };
  }
}

function summarizeToolResultDiagnostics(
  diagnostics: ToolResultDiagnostics,
  redactedFields: readonly string[],
  projectionWarnings: readonly string[]
): ToolResultDiagnosticSummary {
  const existingCodes = diagnostics.warnings.map((warning) => warning.code);
  const addedWarnings = projectionWarnings.filter((code) => !existingCodes.includes(code));
  return {
    degraded: diagnostics.degraded || projectionWarnings.length > 0,
    fallbackUsed: diagnostics.fallbackUsed,
    warningCount: diagnostics.warnings.length + addedWarnings.length,
    warningCodes: uniqueStrings([...existingCodes, ...addedWarnings]),
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
  const state: ProjectionState = {
    ancestors: new Set(),
    remaining: 4096,
    redactedFields: [],
    warningCodes: new Set(),
  };
  const sanitized = sanitizeOrdinaryNode(value, [], forbiddenKeys, forbiddenPaths, state, 0);
  return {
    value: sanitized,
    redactedFields: state.redactedFields,
    warningCodes: [...state.warningCodes],
  };
}

function sanitizeOrdinaryNode(
  value: unknown,
  path: string[],
  forbiddenKeys: ReadonlySet<string>,
  forbiddenPaths: ReadonlySet<string>,
  state: ProjectionState,
  depth: number,
  reserved = false
): unknown {
  // 显示投影不是业务执行。循环、过深/过宽结构只能降级显示，不能使已确认写入变失败。
  if (depth > 64 || (!reserved && state.remaining-- <= 0)) {
    state.warningCodes.add('TOOL_RESULT_DISPLAY_LIMIT');
    return '[unavailable: display limit]';
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'object') {
    state.warningCodes.add('TOOL_RESULT_DISPLAY_UNSUPPORTED');
    return '[unavailable: non-JSON value]';
  }
  if (state.ancestors.has(value)) {
    state.warningCodes.add('TOOL_RESULT_DISPLAY_CYCLE');
    return '[unavailable: circular reference]';
  }
  state.ancestors.add(value);
  try {
    // 保留 Date 的原生 JSON 值；不运行宿主自定义 toJSON/valueOf 或属性 getter。
    if (value instanceof Date) {
      if (Object.hasOwn(value, 'toJSON')) {
        state.warningCodes.add('TOOL_RESULT_DISPLAY_NORMALIZED');
      }
      return Number.isFinite(Date.prototype.getTime.call(value))
        ? Date.prototype.toISOString.call(value)
        : null;
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== null && prototype !== Object.prototype) {
      state.warningCodes.add('TOOL_RESULT_DISPLAY_NORMALIZED');
    }
    const out: Record<string, unknown> | unknown[] = array ? [] : {};
    const keys = array
      ? Array.from({ length: Math.min(value.length, state.remaining + 1) }, (_, i) => String(i))
      : Object.keys(value);
    const pending: Array<{ key: string; value: object; path: string[] }> = [];
    // 先为当前层的自有数据预留节点，再进入子树；前面的超大详情不能吞掉后面的
    // 纯量回执字段。此规则不识别业务 id/status，也不改变原字段的插入次序。
    for (const key of keys) {
      const childPath = array ? path : [...path, key];
      const dottedPath = childPath.join('.');
      if (!array && (forbiddenKeys.has(key) || forbiddenPaths.has(dottedPath))) {
        state.redactedFields.push(dottedPath);
        continue;
      }
      if (state.remaining <= 0) {
        state.warningCodes.add('TOOL_RESULT_DISPLAY_LIMIT');
        break;
      }
      state.remaining--;
      const property = Object.getOwnPropertyDescriptor(value, key);
      let child: unknown;
      if (property && !('value' in property)) {
        state.warningCodes.add('TOOL_RESULT_DISPLAY_UNSUPPORTED');
        child = '[unavailable: accessor]';
      } else if (key === 'toJSON' && typeof property?.value === 'function') {
        // 不保留可执行序列化钩子，否则最终 JSON.stringify 可以把已删字段重新注入。
        state.warningCodes.add('TOOL_RESULT_DISPLAY_UNSUPPORTED');
        continue;
      } else if (property?.value !== null && typeof property?.value === 'object') {
        pending.push({ key, value: property.value, path: childPath });
        child = '[unavailable: display limit]';
      } else {
        child = sanitizeOrdinaryNode(
          property?.value,
          childPath,
          forbiddenKeys,
          forbiddenPaths,
          state,
          depth + 1,
          true
        );
      }
      // __proto__ 也是合法 JSON 数据键；普通赋值会改变新对象的原型。
      Object.defineProperty(out, key, {
        value: array && child === undefined ? null : child,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    for (const child of pending) {
      Object.defineProperty(out, child.key, {
        value: sanitizeOrdinaryNode(
          child.value,
          child.path,
          forbiddenKeys,
          forbiddenPaths,
          state,
          depth + 1,
          true
        ),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } catch (err: unknown) {
    void err;
    state.warningCodes.add('TOOL_RESULT_DISPLAY_UNSUPPORTED');
    return '[unavailable: unreadable value]';
  } finally {
    state.ancestors.delete(value);
  }
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
