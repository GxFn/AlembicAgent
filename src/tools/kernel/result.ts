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

/**
 * 显示投影（presentToolResult、普通输出）的节点预算。它只约束“给人/模型看的那一份”，
 * 不能作用到规范 structuredContent 上：规范化入口传入无上限预算（L3-C01）。
 */
const DISPLAY_NODE_BUDGET = 4096;

/**
 * 嵌套深度上限。两条路径都保留：它是递归栈安全护栏（过深结构会让 JSON.stringify 自身抛
 * RangeError），超限位置写带内标记并记 TOOL_RESULT_DISPLAY_LIMIT，不会静默丢数据。
 */
const MAX_NESTING_DEPTH = 64;

const DISPLAY_LIMIT_MARKER = '[unavailable: display limit]';

/**
 * 规范 structuredContent 的 JSON 安全化入口（L3-P06）。
 *
 * - 只处理会让 JSON.stringify 抛错或执行宿主代码的值：循环引用、accessor、自有 toJSON、
 *   BigInt/symbol/function、Date 与非普通原型；不删除任何字段（forbiddenFields 为空），
 *   也不施加显示节点预算，因此 handler 返回多大的结构，宿主 /agent/tool 就拿到多大的数据。
 * - 唯一保留的上限是 MAX_NESTING_DEPTH 栈安全护栏，超限处写带内标记并产生警告码。
 * - status 由调用方按 handler 执行真值决定，这里不降级为 partial（决策：不引入 HTTP 206）。
 *
 * 用 default 导出是有意的：kernel/index.ts 与 tools/index.ts 都以 `export *` 再导出本模块，
 * 而 `export *` 不转发 default，所以它只供包内 ToolRouterAdapter 使用，不进入任何公开出口
 * （签名检查的出口与绑定数不变）。
 */
export default function normalizeToolResultContent(value: unknown): {
  value: unknown;
  warningCodes: string[];
} {
  const sanitized = sanitizeOrdinaryValue(value, [], Number.POSITIVE_INFINITY);
  return { value: sanitized.value, warningCodes: uniqueStrings(sanitized.warningCodes) };
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

function sanitizeOrdinaryValue(
  value: unknown,
  forbiddenFields: readonly string[],
  nodeBudget: number = DISPLAY_NODE_BUDGET
): SanitizedValue {
  const forbiddenKeys = new Set(forbiddenFields.filter((field) => !field.includes('.')));
  const forbiddenPaths = new Set(forbiddenFields.filter((field) => field.includes('.')));
  const state: ProjectionState = {
    ancestors: new Set(),
    remaining: nodeBudget,
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
  // 显示投影与规范化都不是业务执行。循环、过深/过宽结构只能带内降级，不能使已确认写入变失败。
  if (depth > MAX_NESTING_DEPTH || (!reserved && state.remaining-- <= 0)) {
    state.warningCodes.add('TOOL_RESULT_DISPLAY_LIMIT');
    return DISPLAY_LIMIT_MARKER;
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
    // 数组下标只物化到预算能覆盖的位置（+1 用于触发耗尽判断）；无上限预算时即全长。
    const keys = array
      ? Array.from({ length: Math.min(value.length, Math.max(0, state.remaining) + 1) }, (_, i) =>
          String(i)
        )
      : Object.keys(value);
    const pending: Array<{ key: string; value: object; path: string[] }> = [];
    // handled：已占用预算的键数；对数组而言等于已展示的下标数。
    let handled = 0;
    // exhaustedAt：预算耗尽时第一个未展示（且未被 D23 删除）的键在 keys 中的位置。
    let exhaustedAt = -1;
    // 先为当前层的自有数据预留节点，再进入子树；前面的超大详情不能吞掉后面的
    // 纯量回执字段。此规则不识别业务 id/status，也不改变原字段的插入次序。
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index] as string;
      const childPath = array ? path : [...path, key];
      const dottedPath = childPath.join('.');
      if (!array && (forbiddenKeys.has(key) || forbiddenPaths.has(dottedPath))) {
        state.redactedFields.push(dottedPath);
        continue;
      }
      if (state.remaining <= 0) {
        exhaustedAt = index;
        break;
      }
      state.remaining--;
      handled++;
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
        child = DISPLAY_LIMIT_MARKER;
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
      defineDataEntry(out, key, array && child === undefined ? null : child);
    }
    // 预算耗尽不能静默：被截掉的部分必须在数据本身里可见（L3-C01）。
    const omitted = array
      ? value.length - handled
      : exhaustedAt < 0
        ? 0
        : countDisplayableKeys(keys, exhaustedAt, path, forbiddenKeys, forbiddenPaths);
    if (omitted > 0) {
      state.warningCodes.add('TOOL_RESULT_DISPLAY_LIMIT');
      if (handled === 0) {
        // 进入容器时预算已耗尽：整个位置写占位，而不是返回看似真实的空 {} / []。
        return DISPLAY_LIMIT_MARKER;
      }
      if (array) {
        // 数组末尾追加省略计数；已展示前缀的下标与原数组一致。
        defineDataEntry(
          out,
          String(handled),
          `[unavailable: display limit, ${omitted} remaining items omitted]`
        );
      } else {
        // 对象在第一个未展示的键上写剩余字段数（含该键自身），不臆造新键名。
        defineDataEntry(
          out,
          keys[exhaustedAt] as string,
          `[unavailable: display limit, ${omitted} remaining fields omitted]`
        );
      }
    }
    for (const child of pending) {
      defineDataEntry(
        out,
        child.key,
        sanitizeOrdinaryNode(
          child.value,
          child.path,
          forbiddenKeys,
          forbiddenPaths,
          state,
          depth + 1,
          true
        )
      );
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

/** __proto__ 也是合法 JSON 数据键；普通赋值会改变新对象的原型，所以统一用 defineProperty。 */
function defineDataEntry(out: Record<string, unknown> | unknown[], key: string, value: unknown) {
  Object.defineProperty(out, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** 预算耗尽后本应展示却被省略的键数：D23 删除的键本来就不展示，不计入省略数。 */
function countDisplayableKeys(
  keys: readonly string[],
  from: number,
  path: readonly string[],
  forbiddenKeys: ReadonlySet<string>,
  forbiddenPaths: ReadonlySet<string>
): number {
  let count = 0;
  for (let index = from; index < keys.length; index++) {
    const key = keys[index] as string;
    if (!forbiddenKeys.has(key) && !forbiddenPaths.has([...path, key].join('.'))) {
      count++;
    }
  }
  return count;
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
