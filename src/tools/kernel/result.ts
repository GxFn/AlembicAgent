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

/**
 * D23 普通输出禁用字段分两组执行（L3-C02 决策，导出常量的值与次序不变，只改匹配语义）：
 *
 * - 旧信封顶层字段（success、errorCode、message、data.result）：只描述 V1 ToolResult 信封的
 *   顶层形状，因此只沿“根对象链”匹配（经过数组即不再适用）。嵌套的 error.message、
 *   memory/graph 结果里的业务 message、数组元素里的 success 都是工具真实写出的业务字段，
 *   不得删除。
 * - 秘密/私有字段（其余条目：apiKey、hostCredential、threadId、reasoningContent、
 *   thoughtSignature、hiddenReasoning、rawProvider*、legacyCompatibility）：任意深度、按
 *   规范化名字匹配，嵌套对象路径（{thread:{id}}）与扁平键（"thread.id"）、单键（threadId）
 *   视为同一字段，见 normalizeFieldName、PRIVATE_FIELD_TOKENS 与 matchForbiddenField。
 *
 * 宿主 HTTP 出口（/agent/tool 返回规范信封）不执行 D23，那是 cross-repo 决定；Agent 内的
 * 真实出口是 redactToolResultPrivateFields（runtimeBridge 与 AgentTaskHandlers）和本文件的
 * 显示投影 projectToolResultOrdinaryOutput / presentToolResult。
 */
const LEGACY_ENVELOPE_ROOT_FIELDS: ReadonlySet<string> = new Set([
  'success',
  'errorCode',
  'message',
  'data.result',
]);

const PRIVATE_ORDINARY_OUTPUT_FIELDS: readonly string[] = Object.freeze(
  TOOL_RESULT_FORBIDDEN_ORDINARY_OUTPUT_FIELDS.filter(
    (field) => !LEGACY_ENVELOPE_ROOT_FIELDS.has(field)
  )
);

/**
 * 名字规范化：NFKD（全角等兼容字符折叠，并把带附加符号的字母拆成“基字母 + 组合符”）+
 * 小写 + 去掉所有非字母数字字符（组合符、零宽字符、软连字符、空白、标点都在此去掉）。于是
 * apiKey / api_key / API-KEY / "api key" / "provider.apiKey" / 全角 / 带附加符号的写法落到
 * 同一形态，比较只看规范化后的名字（参考 L4-P7 审计：同一字段的等价拼写必须一并覆盖）。
 * 不做跨文字系统的形近字折叠（西里尔 а 与拉丁 a 是不同字母），见 PRIVATE_FIELD_TOKENS。
 */
function normalizeFieldName(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** 键名按点号拆段后逐段规范化；根路径匹配用它把 "data.result" 这类扁平键与嵌套等价。 */
function normalizedKeySegments(key: string): string[] {
  return key.split('.').map(normalizeFieldName);
}

/**
 * 秘密/私有字段的规范化 token。匹配方式是“祖先键名与当前键名规范化后首尾相接，所得串
 * 在当前键上出现 token”（见 matchForbiddenField）。因此：
 * - 复数（apiKeys、threadIds）、带前缀的同义字段（openaiApiKey、x-api-key、hostThreadId）、
 *   扁平路径键（provider.apiKey）都会命中；
 * - 嵌套对象路径（{thread:{id}}、{provider:{api:{key}}}、{api:[{key}]}）与扁平写法等价，
 *   删除的是补全 token 的那个键（thread.id），兄弟业务字段保留。
 * 代价是名字里含 token 的非秘密字段（例如 apiKeyConfigured、{api:{keyboard}}）也会从模型
 * 可见结果里移除；这是安全收紧方向的有意取舍。
 *
 * 不使用 reasoning* / raw* 前缀族：Recipe 的业务字段 reasoning（reasoning.sources /
 * evidenceRefs）、Core 的 reasoningSources / rawScore / rawContent、recipeAuthoringGate 的
 * violation.raw 都是模型需要看到的数据，前缀匹配会把它们误删。
 *
 * 匹配只看字段名，不看值：值里的 JSON 字符串、"apiKey: x" 形式的文本都是不透明内容
 * （源码、终端输出、文件正文），不解析也不改写。
 */
const PRIVATE_FIELD_TOKENS: ReadonlySet<string> = new Set(
  PRIVATE_ORDINARY_OUTPUT_FIELDS.map(normalizeFieldName)
);

const LEGACY_ROOT_FIELD_TOKENS: ReadonlySet<string> = new Set(
  [...LEGACY_ENVELOPE_ROOT_FIELDS].map((field) => normalizedKeySegments(field).join('.'))
);

/** 编译后的禁用字段规则；所有名字都已规范化。 */
interface ForbiddenFieldMatcher {
  /** 任意深度、可跨祖先键拼接匹配的 token（只来自 D23 秘密/私有组）。 */
  readonly privateTokens: readonly string[];
  /** 拼接时需要保留的祖先尾部长度（最长 token 长度 - 1）；更长的祖先前缀不可能参与命中。 */
  readonly privateTailLength: number;
  /** 任意深度，规范化键名全等匹配（调用方自定义的其它字段，保持原“按键名”语义）。 */
  readonly exactNames: ReadonlySet<string>;
  /** 只沿根对象链、且未经过数组时匹配的规范化点号路径（D23 旧信封字段）。 */
  readonly legacyRootPaths: ReadonlySet<string>;
  /** 调用方自定义的点号路径：保持原语义，从根起按对象键匹配，数组下标不入路径。 */
  readonly customRootPaths: ReadonlySet<string>;
  /** 点号路径的最大段数；对象链超过它后不再追踪，避免深层结构反复拼路径。 */
  readonly maxRootPathSegments: number;
  /** 没有任何规则（规范化入口）：逐键判定直接短路，不为每个键做名字规范化。 */
  readonly matchesNothing: boolean;
}

function compileForbiddenFields(fields: readonly string[]): ForbiddenFieldMatcher {
  const privateTokens = new Set<string>();
  const exactNames = new Set<string>();
  const legacyRootPaths = new Set<string>();
  const customRootPaths = new Set<string>();
  for (const field of fields) {
    const segments = normalizedKeySegments(field);
    const dotted = segments.join('.');
    const whole = normalizeFieldName(field);
    if (segments.some((segment) => segment.length === 0)) {
      // 规范化后为空的段（例如纯符号或 "a..b"）无法安全比较；跳过而不是匹配所有键。
      continue;
    }
    if (LEGACY_ROOT_FIELD_TOKENS.has(dotted)) {
      legacyRootPaths.add(dotted);
    } else if (PRIVATE_FIELD_TOKENS.has(whole)) {
      // 规范化后等于私有 token 的点号写法（例如 "api.key"）按 token 处理，不降级为根路径。
      privateTokens.add(whole);
    } else if (field.includes('.')) {
      customRootPaths.add(dotted);
    } else {
      exactNames.add(whole);
    }
  }
  const rootPathLengths = [...legacyRootPaths, ...customRootPaths].map(
    (path) => path.split('.').length
  );
  return {
    privateTokens: [...privateTokens],
    privateTailLength: Math.max(0, ...[...privateTokens].map((token) => token.length - 1)),
    exactNames,
    legacyRootPaths,
    customRootPaths,
    maxRootPathSegments: Math.max(0, ...rootPathLengths),
    matchesNothing:
      privateTokens.size === 0 &&
      exactNames.size === 0 &&
      legacyRootPaths.size === 0 &&
      customRootPaths.size === 0,
  };
}

const DEFAULT_ORDINARY_OUTPUT_MATCHER = compileForbiddenFields(
  TOOL_RESULT_FORBIDDEN_ORDINARY_OUTPUT_FIELDS
);
const PRIVATE_FIELD_MATCHER = compileForbiddenFields(PRIVATE_ORDINARY_OUTPUT_FIELDS);
const NO_FORBIDDEN_FIELDS = compileForbiddenFields([]);

/**
 * 从根到当前对象的点号路径追踪状态：segments 是只经过对象键的规范化段（数组下标不入
 * 路径），insideArray 表示途中经过了数组（旧信封字段规则从此不再适用）。null 表示路径已
 * 超过所有点号规则的段数，不再追踪。
 */
interface ObjectPathState {
  readonly segments: readonly string[];
  readonly insideArray: boolean;
}

const ROOT_OBJECT_PATH: ObjectPathState = Object.freeze({ segments: [], insideArray: false });

/**
 * 当前容器的祖先拼接尾部：祖先键名（数组透明）规范化后首尾相接，只留最后
 * privateTailLength 个字符。没有私有 token 的规则（规范化入口）直接返回空串，不付代价。
 */
function privateAncestorTail(matcher: ForbiddenFieldMatcher, path: readonly string[]): string {
  if (matcher.privateTokens.length === 0 || path.length === 0) {
    return '';
  }
  return normalizeFieldName(path.join('')).slice(-matcher.privateTailLength);
}

/**
 * 命中类别：'private' 来自 D23 秘密/私有 token 的“包含”匹配，键名里可能拼着值；'listed'
 * 来自规范化全等的名字或点号路径，键名除分隔符外就是规则里的名字。
 */
type ForbiddenFieldMatch = 'private' | 'listed' | null;

/**
 * 私有 token 在“祖先尾部 + 当前键名”上查找。祖先尾部本身不可能已含完整 token：那样的
 * 祖先在上层就已被删除，不会再进入它的子树，所以任何命中都落在当前键上。
 */
function matchForbiddenField(
  matcher: ForbiddenFieldMatcher,
  key: string,
  objectPath: ObjectPathState | null,
  ancestorTail: string
): ForbiddenFieldMatch {
  if (matcher.matchesNothing) {
    return null;
  }
  const normalized = normalizeFieldName(key);
  if (normalized.length > 0) {
    const spanning = ancestorTail.length > 0 ? `${ancestorTail}${normalized}` : normalized;
    for (const token of matcher.privateTokens) {
      if (spanning.includes(token)) {
        return 'private';
      }
    }
    if (matcher.exactNames.has(normalized)) {
      return 'listed';
    }
  }
  if (
    objectPath !== null &&
    (matcher.customRootPaths.size > 0 ||
      (!objectPath.insideArray && matcher.legacyRootPaths.size > 0))
  ) {
    const dotted = [...objectPath.segments, ...normalizedKeySegments(key)].join('.');
    if (
      matcher.customRootPaths.has(dotted) ||
      (!objectPath.insideArray && matcher.legacyRootPaths.has(dotted))
    ) {
      return 'listed';
    }
  }
  return null;
}

/**
 * 被删私有键在 redactedFields（普通输出 diagnosticSummary、运行诊断与日志）里的显示名。
 * “包含”匹配会命中把值拼进键名的写法（"apiKey=sk-…"、"threadId: …"、"apiKey.…"），原样
 * 记录键名就会把刚删除的值写进诊断；所以只有形如标识符（字母、下划线或 $ 开头，只含字母
 * 数字、下划线、$、连字符）且不超过 32 个字符的键名原样显示，其余一律显示为固定占位。
 */
const REPORTABLE_PRIVATE_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]{0,31}$/;

const MASKED_PRIVATE_KEY = '[private field]';

function reportedRedactedKey(key: string, match: Exclude<ForbiddenFieldMatch, null>): string {
  if (match === 'listed' || REPORTABLE_PRIVATE_KEY.test(key)) {
    return key;
  }
  return MASKED_PRIVATE_KEY;
}

function childObjectPath(
  matcher: ForbiddenFieldMatcher,
  objectPath: ObjectPathState | null,
  key: string
): ObjectPathState | null {
  if (objectPath === null) {
    return null;
  }
  const segments = [...objectPath.segments, ...normalizedKeySegments(key)];
  return segments.length < matcher.maxRootPathSegments
    ? { segments, insideArray: objectPath.insideArray }
    : null;
}

/** 进入数组：下标不入路径，但旧信封字段规则从此不再适用。 */
function arrayObjectPath(objectPath: ObjectPathState | null): ObjectPathState | null {
  if (objectPath === null || objectPath.insideArray) {
    return objectPath;
  }
  return { segments: objectPath.segments, insideArray: true };
}

/**
 * 结果内容的来源与可信度标注（L4-P05 / I03 定义各字段语义；形状不变）。生产方必须按内容
 * 真实来源填写，不能用一个常量覆盖所有结果；Agent 内的生产方是 ToolRouterAdapter 的 deriveTrust。
 * 消费方据此决定是否隔离、脱敏或做提示注入防护时，要按下面的保守语义理解：
 */
export interface ToolResultTrust {
  /**
   * 内容的产出通道：'terminal' 是命令输出，'internal' 是 Agent 内置 handler 产出（含它读出的
   * 仓库文件与知识库内容）。通道不等于可信，内容是否可当指令看 containsUntrustedText。
   */
  source: 'internal' | 'terminal' | 'mcp' | 'skill' | 'macos' | 'user';
  /**
   * true 只表示结果内容确实经过了清洗步骤；没有清洗步骤时必须为 false。JSON 安全化（循环、
   * BigInt、accessor 等的替换）与按字段名删除私有字段都不算内容清洗。
   */
  sanitized: boolean;
  /**
   * true 表示内容可能含非 Agent 自写的文本（仓库文件、命令输出、知识库内容、回显模型参数或
   * 宿主异常的失败文案），只能当数据处理，不能当指令执行。失败结果一律为 true。
   */
  containsUntrustedText: boolean;
  /**
   * false 表示“未检测到”，不代表已证明不含密钥：当前生产方没有任何密钥检测步骤，命令输出、
   * 仓库文件里打印出的密钥不会让它变为 true。需要密钥保证的消费方必须自行检测或脱敏；
   * true 才是确定信号（检测到密钥）。
   */
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
  /**
   * 原值含有 JSON.stringify 时会执行宿主代码或越过深度护栏的形态（accessor、toJSON、
   * 非普通原型、不可读值、超深容器）。这类原值在下游序列化时可能重新带出已删字段，
   * 私有字段清理据此决定必须改用副本；NaN/BigInt/循环等不含键的形态不计入。
   */
  opaqueShape: boolean;
}

interface ProjectionState {
  ancestors: Set<object>;
  remaining: number;
  redactedFields: string[];
  warningCodes: Set<string>;
  opaqueShape: boolean;
}

/**
 * 显示投影（presentToolResult、普通输出）的节点预算。它只约束“给人/模型看的那一份”，
 * 不能作用到规范 structuredContent 上：规范化入口传入无上限预算（L3-C01）。
 */
const DISPLAY_NODE_BUDGET = 4096;

/**
 * 嵌套深度上限。两条路径都保留：它是递归栈安全护栏（过深结构会让 JSON.stringify 自身抛
 * RangeError），超限的容器写带内标记并记 TOOL_RESULT_DISPLAY_LIMIT，不会静默丢数据。
 * 只约束容器：叶子值不会加深递归，保留它们也让已规范化的结果再次扫描时保持不变
 * （私有字段清理依赖这一幂等性判断“是否改写过”）。
 */
const MAX_NESTING_DEPTH = 64;

const DISPLAY_LIMIT_MARKER = '[unavailable: display limit]';

const JSON_DISPLAY_FAILED_MARKER = '[unavailable: JSON display failed]';

/**
 * 规范 structuredContent 的 JSON 安全化入口（L3-P06）。
 *
 * - 只处理会让 JSON.stringify 抛错或执行宿主代码的值：循环引用、accessor、自有 toJSON、
 *   BigInt/symbol/function、Date 与非普通原型；不删除任何字段（不带禁用字段规则），
 *   也不施加显示节点预算，因此 handler 返回多大的结构，宿主 /agent/tool 就拿到多大的数据。
 * - 唯一保留的上限是 MAX_NESTING_DEPTH 栈安全护栏，超限处写带内标记并产生警告码。
 * - status 由调用方按 handler 执行真值决定，这里不降级为 partial（决策：不引入 HTTP 206）。
 *
 * 用 default 导出是有意的：kernel/index.ts 与 tools/index.ts 都以 `export *` 再导出本模块，
 * 而 `export *` 不转发 default，所以它只供包内使用，不进入任何公开出口（签名检查的出口与
 * 绑定数不变）。ToolRouterAdapter 直接调用它做规范化；它上面挂着的 redactPrivateFields
 * 是 D23 私有字段清理入口（见文件末尾）。
 */
export default function normalizeToolResultContent(value: unknown): {
  value: unknown;
  warningCodes: string[];
} {
  const sanitized = sanitizeOrdinaryValue(value, NO_FORBIDDEN_FIELDS, Number.POSITIVE_INFINITY);
  return { value: sanitized.value, warningCodes: uniqueStrings(sanitized.warningCodes) };
}

/** redactToolResultPrivateFields 的结果；没有改写时 envelope 就是传入的同一对象。 */
interface ToolResultPrivateFieldRedaction {
  envelope: ToolResultEnvelope;
  /** 被删除的私有字段路径（数组下标不入路径），只含键名，不含任何值。 */
  redactedFields: string[];
  /** 改写载体时顺带发生的 JSON 规范化警告码（toJSON/accessor/类实例/过深/非 JSON 值等）。 */
  warningCodes: string[];
}

interface RedactedCarrier {
  changed: boolean;
  value: unknown;
  redactedFields: string[];
  warningCodes: string[];
}

const UNCHANGED_CARRIER = Object.freeze({
  changed: false,
  value: undefined,
  redactedFields: [],
  warningCodes: [],
});

/**
 * D23 秘密/私有字段在 Agent 内真实出口的执行点（L3-P07）。runtimeBridge 把返回的信封
 * 写入 metadata.envelope，模型历史读 envelope.text，记忆/证据/观察者读 structuredContent
 * 与返回值；AgentTaskHandlers 把 structuredContent 交给任务输出、AI 提示和错误消息。
 * 因此两份载体都要清理：
 *
 * - structuredContent 为对象/数组：任意深度按规范化名字（含嵌套对象路径拼接，见
 *   matchForbiddenField）删除私有字段，不施加显示预算
 *   （模型路径另有 limitToolResult 字符配额），也不动旧信封字段（业务 message 必须保留）。
 *   扫描时若遇到 toJSON、accessor、非普通原型（类实例、数组/Date 子类）或超深容器，原对象
 *   在下游 JSON.stringify 时可能重新带出私有字段，所以同样改用 JSON 安全副本；循环、NaN、
 *   BigInt 这类不含键的形态不触发改写。
 * - structuredContent 为字符串、以及 envelope.text：整段是 JSON 对象/数组时，它就是同一
 *   结果的另一份载体，按同一规则清理后重新序列化；不是 JSON 的字符串（源码、终端输出、
 *   普通错误文本）是不透明内容，原样保留。字段值里嵌套的 JSON 字符串同样视为内容，不解析。
 *
 * 没有任何改写时返回同一信封对象（保留调用方依赖的对象身份）；有改写时返回浅拷贝，
 * 宿主传入的原信封与原数据不被修改。
 */
function redactToolResultPrivateFields(
  envelope: ToolResultEnvelope
): ToolResultPrivateFieldRedaction {
  if (!envelope || typeof envelope !== 'object') {
    return { envelope, redactedFields: [], warningCodes: [] };
  }
  const structured = redactPrivateStructuredCarrier(envelope.structuredContent);
  const text = redactPrivateJsonTextCarrier(envelope.text);
  if (!structured.changed && !text.changed) {
    return { envelope, redactedFields: [], warningCodes: [] };
  }
  return {
    envelope: {
      ...envelope,
      ...(structured.changed ? { structuredContent: structured.value } : {}),
      ...(text.changed ? { text: text.value as string } : {}),
    },
    redactedFields: uniqueStrings([...structured.redactedFields, ...text.redactedFields]),
    warningCodes: uniqueStrings([...structured.warningCodes, ...text.warningCodes]),
  };
}

function redactPrivateStructuredCarrier(value: unknown): RedactedCarrier {
  if (typeof value === 'string') {
    return redactPrivateJsonTextCarrier(value);
  }
  if (value === null || typeof value !== 'object') {
    // 纯量没有键；function/symbol/bigint 不会进入 JSON 载体，保持原值。
    return UNCHANGED_CARRIER;
  }
  const sanitized = sanitizeOrdinaryValue(value, PRIVATE_FIELD_MATCHER, Number.POSITIVE_INFINITY);
  // 只有删了私有字段、或原值在下游序列化时可能重新带出字段（opaqueShape）才改用副本；
  // NaN、BigInt、循环这类不含键的形态保持原值与对象身份。
  if (sanitized.redactedFields.length === 0 && !sanitized.opaqueShape) {
    return UNCHANGED_CARRIER;
  }
  return {
    changed: true,
    value: sanitized.value,
    redactedFields: sanitized.redactedFields,
    warningCodes: sanitized.warningCodes,
  };
}

function redactPrivateJsonTextCarrier(text: unknown): RedactedCarrier {
  if (typeof text !== 'string') {
    return UNCHANGED_CARRIER;
  }
  const candidate = jsonCarrierCandidate(text);
  // 只有 JSON 对象/数组才有键；其余字符串（含 JSON 纯量）是不透明内容。
  if (!candidate.startsWith('{') && !candidate.startsWith('[')) {
    return UNCHANGED_CARRIER;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      // 形似 JSON 但不是 JSON（例如带行号的源码片段）：按内容原样保留。
      return UNCHANGED_CARRIER;
    }
    // 非语法类解析失败无法确认其中没有私有字段，不能原样交给模型。
    return {
      changed: true,
      value: JSON_DISPLAY_FAILED_MARKER,
      redactedFields: [],
      warningCodes: ['TOOL_RESULT_DISPLAY_UNSUPPORTED'],
    };
  }
  const sanitized = sanitizeOrdinaryValue(parsed, PRIVATE_FIELD_MATCHER, Number.POSITIVE_INFINITY);
  // 解析出的 JSON 没有 accessor/原型；opaqueShape 只可能来自超深容器（其下的私有字段无法
  // 逐键确认，必须随占位一起改写）。
  if (sanitized.redactedFields.length === 0 && !sanitized.opaqueShape) {
    return UNCHANGED_CARRIER;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(sanitized.value, null, 2) ?? JSON_DISPLAY_FAILED_MARKER;
  } catch (err: unknown) {
    // 清理后的值已是 JSON 安全的；序列化仍失败时只给固定占位，不回退到含私有字段的原文。
    void err;
    serialized = JSON_DISPLAY_FAILED_MARKER;
  }
  return {
    changed: true,
    value: serialized,
    redactedFields: sanitized.redactedFields,
    warningCodes: sanitized.warningCodes,
  };
}

/**
 * D23 私有字段清理的包内入口（L3-P07），挂在 default 导出（normalizeToolResultContent）上：
 * 本模块唯一不进入公开出口的通道就是 default，新增具名导出会改变公开绑定。runtimeBridge 受
 * 文件边界约束只能从 kernel 桶导入，kernel/index.ts 因此以具名方式转发这个 default；
 * kernel/index.ts 本身不在任何公开出口链上。
 */
normalizeToolResultContent.redactPrivateFields = redactToolResultPrivateFields;

export function projectToolResultOrdinaryOutput<T = unknown>(
  envelope: ToolResultEnvelope<T>,
  options: ToolResultOrdinaryOutputProjectionOptions = {}
): ToolResultOrdinaryOutput {
  // 默认规则即 D23 两组语义；调用方显式传入的列表按同一分组规则编译（见 compileForbiddenFields）。
  const matcher =
    options.forbiddenFields === undefined
      ? DEFAULT_ORDINARY_OUTPUT_MATCHER
      : compileForbiddenFields(options.forbiddenFields);
  const sanitized = sanitizeOrdinaryValue(envelope.structuredContent, matcher);
  const sanitizedText = sanitizeOrdinaryText(envelope.text, matcher);
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

/**
 * JSON 载体候选：去掉首尾的 ECMAScript 空白（含 BOM、不换行空格）。JSON.parse 只接受
 * 空格/制表/换行，带 BOM 或 NBSP 包裹的 JSON 若直接解析会报语法错误而被当成普通文本，
 * 从而绕过字段规则。只有确实改写时才输出新文本，未改写的文本保持原样（含原包裹字符）。
 */
function jsonCarrierCandidate(text: string): string {
  return text.trim();
}

/** Adapter 的 JSON 文本是同一结果的另一份载体，必须使用与结构化内容相同的字段规则。 */
function sanitizeOrdinaryText(text: string, matcher: ForbiddenFieldMatcher): SanitizedValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCarrierCandidate(text));
  } catch (err: unknown) {
    void err;
    // 非 JSON 的普通文本没有结构化字段语义，保持原样；已解析 JSON 的清理失败不能走此分支。
    return { value: text, redactedFields: [], warningCodes: [], opaqueShape: false };
  }
  try {
    const sanitized = sanitizeOrdinaryValue(parsed, matcher);
    return {
      value:
        sanitized.redactedFields.length > 0 || sanitized.warningCodes.length > 0
          ? JSON.stringify(sanitized.value, null, 2)
          : text,
      redactedFields: sanitized.redactedFields,
      warningCodes: sanitized.warningCodes,
      opaqueShape: sanitized.opaqueShape,
    };
  } catch (err: unknown) {
    // 清理异常只产生固定显示诊断，不能把可能含宿主敏感信息的错误内容或原 JSON 返回。
    void err;
    return {
      value: JSON_DISPLAY_FAILED_MARKER,
      redactedFields: [],
      warningCodes: ['TOOL_RESULT_DISPLAY_UNSUPPORTED'],
      opaqueShape: true,
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
  matcher: ForbiddenFieldMatcher,
  nodeBudget: number = DISPLAY_NODE_BUDGET
): SanitizedValue {
  const state: ProjectionState = {
    ancestors: new Set(),
    remaining: nodeBudget,
    redactedFields: [],
    warningCodes: new Set(),
    opaqueShape: false,
  };
  const rootPath = matcher.maxRootPathSegments > 0 ? ROOT_OBJECT_PATH : null;
  const sanitized = sanitizeOrdinaryNode(value, [], rootPath, matcher, state, 0);
  return {
    value: sanitized,
    redactedFields: state.redactedFields,
    warningCodes: [...state.warningCodes],
    opaqueShape: state.opaqueShape,
  };
}

function sanitizeOrdinaryNode(
  value: unknown,
  path: string[],
  objectPath: ObjectPathState | null,
  matcher: ForbiddenFieldMatcher,
  state: ProjectionState,
  depth: number,
  reserved = false
): unknown {
  // 显示投影与规范化都不是业务执行。循环、过深/过宽结构只能带内降级，不能使已确认写入变失败。
  if (!reserved && state.remaining-- <= 0) {
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
  // 深度护栏只拦容器：超深子树整体换成带内标记，其中的任何字段（含私有字段）都不再输出。
  if (depth > MAX_NESTING_DEPTH) {
    state.warningCodes.add('TOOL_RESULT_DISPLAY_LIMIT');
    state.opaqueShape = true;
    return DISPLAY_LIMIT_MARKER;
  }
  if (state.ancestors.has(value)) {
    state.warningCodes.add('TOOL_RESULT_DISPLAY_CYCLE');
    return '[unavailable: circular reference]';
  }
  state.ancestors.add(value);
  try {
    // 保留 Date 的原生 JSON 值；不运行宿主自定义 toJSON/valueOf 或属性 getter。
    if (value instanceof Date) {
      // 自有或子类原型上的 toJSON 会在下游 JSON.stringify 时执行宿主代码。
      if (Object.hasOwn(value, 'toJSON') || Object.getPrototypeOf(value) !== Date.prototype) {
        state.warningCodes.add('TOOL_RESULT_DISPLAY_NORMALIZED');
        state.opaqueShape = true;
      }
      return Number.isFinite(Date.prototype.getTime.call(value))
        ? Date.prototype.toISOString.call(value)
        : null;
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== null && prototype !== Object.prototype) {
      state.warningCodes.add('TOOL_RESULT_DISPLAY_NORMALIZED');
      state.opaqueShape = true;
    }
    // 数组只复制下标；自有 toJSON 或数组子类原型会让原数组序列化成任意内容，副本里两者都不保留。
    if (array && (prototype !== Array.prototype || Object.hasOwn(value, 'toJSON'))) {
      state.warningCodes.add('TOOL_RESULT_DISPLAY_NORMALIZED');
      state.opaqueShape = true;
    }
    const out: Record<string, unknown> | unknown[] = array ? [] : {};
    // 数组下标只物化到预算能覆盖的位置（+1 用于触发耗尽判断）；无上限预算时即全长。
    const keys = array
      ? Array.from({ length: Math.min(value.length, Math.max(0, state.remaining) + 1) }, (_, i) =>
          String(i)
        )
      : Object.keys(value);
    const pending: Array<{
      key: string;
      value: object;
      path: string[];
      objectPath: ObjectPathState | null;
    }> = [];
    // 数组元素没有键名，不做字段判定；对象键要与祖先尾部拼接后查私有 token。
    const ancestorTail = array ? '' : privateAncestorTail(matcher, path);
    // 数组下标不入路径，但经过数组后旧信封字段规则不再适用。
    const elementObjectPath = array ? arrayObjectPath(objectPath) : null;
    // handled：已占用预算的键数；对数组而言等于已展示的下标数。
    let handled = 0;
    // exhaustedAt：预算耗尽时第一个未展示（且未被 D23 删除）的键在 keys 中的位置。
    let exhaustedAt = -1;
    // 先为当前层的自有数据预留节点，再进入子树；前面的超大详情不能吞掉后面的
    // 纯量回执字段。此规则不识别业务 id/status，也不改变原字段的插入次序。
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index] as string;
      const childPath = array ? path : [...path, key];
      // D23：数组元素没有键名；对象键先于读取属性判定，accessor 形式的私有字段也不会被执行。
      const forbidden = array ? null : matchForbiddenField(matcher, key, objectPath, ancestorTail);
      if (forbidden !== null) {
        state.redactedFields.push([...path, reportedRedactedKey(key, forbidden)].join('.'));
        continue;
      }
      const nextObjectPath = array ? elementObjectPath : childObjectPath(matcher, objectPath, key);
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
        state.opaqueShape = true;
        child = '[unavailable: accessor]';
      } else if (key === 'toJSON' && typeof property?.value === 'function') {
        // 不保留可执行序列化钩子，否则最终 JSON.stringify 可以把已删字段重新注入。
        state.warningCodes.add('TOOL_RESULT_DISPLAY_UNSUPPORTED');
        state.opaqueShape = true;
        continue;
      } else if (property?.value !== null && typeof property?.value === 'object') {
        pending.push({
          key,
          value: property.value,
          path: childPath,
          objectPath: nextObjectPath,
        });
        child = DISPLAY_LIMIT_MARKER;
      } else {
        child = sanitizeOrdinaryNode(
          property?.value,
          childPath,
          nextObjectPath,
          matcher,
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
        : countDisplayableKeys(keys, exhaustedAt, objectPath, ancestorTail, matcher);
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
          child.objectPath,
          matcher,
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
    state.opaqueShape = true;
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
  objectPath: ObjectPathState | null,
  ancestorTail: string,
  matcher: ForbiddenFieldMatcher
): number {
  let count = 0;
  for (let index = from; index < keys.length; index++) {
    if (matchForbiddenField(matcher, keys[index] as string, objectPath, ancestorTail) === null) {
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
