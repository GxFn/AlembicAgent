/**
 * Tool registry + handler execution contract — tool/action specs, the parsed
 * tool call, the handler-facing result and DI context, the capability model,
 * and the lightweight DI service interfaces. Canonical home (formerly
 * src/tools/v2/types.ts); the registry DATA (TOOL_REGISTRY) stays in its
 * implementation module.
 */

import { estimateTokens as estimateSharedTokens } from '#shared/tokenUtils.js';
import type { ToolAvailabilitySnapshot } from './availability.js';
import type { ToolRuntimeCallContext } from './context.js';
import type { KnowledgeManagementPort, KnowledgeReadPort } from './knowledge.js';
import type { ToolResultStatus } from './result.js';
import type { ToolActionAllowlist } from './toolSchema.js';

/** JSON Schema 类型简化定义，避免外部依赖 */
export type JSONSchema4 = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/*  Tool Spec & Registry                                               */
/* ------------------------------------------------------------------ */

/** 单个 action 的完整定义 */
export interface ToolAction {
  /** 一行描述 — 用于轻量 schema（首轮发给 LLM） */
  summary: string;
  /** 完整描述 — meta.tools 展开时返回 */
  description: string;
  /** 参数 JSON Schema */
  params: JSONSchema4;
  /** 实际执行函数 */
  handler: ActionHandler;
  /** 缓存策略: none=不缓存, session=会话级, delta=文件hash增量 */
  cache?: 'none' | 'session' | 'delta';
  /** 并发模式: parallel=并行, single=同工具互斥, exclusive=全局独占 */
  concurrency?: 'parallel' | 'single' | 'exclusive';
  /** 风险等级 */
  risk?: 'read-only' | 'write' | 'side-effect';
  /** 输出 token 上限（超出由 compressor 截断） */
  maxOutputTokens?: number;
}

/** 一个工具的完整规格（包含多个 action） */
export interface ToolSpec {
  name: string;
  description: string;
  actions: Record<string, ToolAction>;
}

/** 工具注册表类型 */
export type ToolRegistry = Record<string, ToolSpec>;

/* ------------------------------------------------------------------ */
/*  Tool Call & Result                                                 */
/* ------------------------------------------------------------------ */

/** LLM 发出的工具调用（router 解析后） */
export interface ParsedToolCall {
  tool: string;
  action: string;
  params: Record<string, unknown>;
}

/**
 * 结果元信息 — 对 LLM 不可见，供 ContextWindow 消费。
 *
 * ok 与 resultStatus 的组合规则（沿用上一轮台账 r03/r04 的决定）：ToolResult.ok 是旧兼容标记，
 * 显式 resultStatus 优先，消费方判定结果时以 resultStatus 为准（adapter 归一后即信封的
 * status），不应只看 ok。ok:true 可以与非 success 状态并存：例如 terminal 非零退出码返回
 * ok:true 加 resultStatus:'error'，code 搜索在取消或超时前已有匹配时返回 ok:true 加
 * 'timeout'/'aborted'/'partial'。缺省 resultStatus 时，adapter 才按 ok 归一为 success/error。
 */
export interface ToolResultMeta {
  /** producer/路由层确认的结果状态，优先于旧 ok 标记；缺省时 adapter 才按 ok 归一化。 */
  resultStatus?: ToolResultStatus;
  cached: boolean;
  compression?: { parser: string; ratio: number };
  tokensEstimate: number;
  durationMs: number;
  /**
   * The handler produced a degraded / partial result rather than a full one — e.g.
   * a timeout-killed command's partial output. The adapter surfaces this on the
   * per-call envelope diagnostics so the ordinary-output diagnosticSummary is honest.
   */
  degraded?: boolean;
  /**
   * The handler fell back to a secondary path to produce this result — e.g. a regex
   * scan after the primary ripgrep search failed. Surfaced like {@link degraded}.
   */
  fallbackUsed?: boolean;
  /** Optional warning diagnostics lifted by host adapters. */
  diagnosticWarnings?: ToolDiagnosticWarning[];
}

/** 工具返回值统一结构 */
export interface ToolResult {
  ok: boolean;
  data: unknown;
  error?: string;
  _meta?: ToolResultMeta;
}

/* ------------------------------------------------------------------ */
/*  Handler Context (DI)                                               */
/* ------------------------------------------------------------------ */

/**
 * AST 大纲中的一条声明，由宿主的 {@link ToolContext.outlineFile} 适配 Core 摘要后给出。
 * 宿主数据进入 handler 前会逐条校验：name/kind 非空字符串、startLine 正整数，否则丢弃并记日志；
 * 可选字段不合法时按缺省处理。
 */
export interface OutlineDefinition {
  name: string;
  /**
   * 声明种类。code.outline 的 kinds 过滤按它匹配（不区分大小写），过滤词汇是
   * class/function/interface/type/method/enum；其他取值（如 variable、property）照常展示，
   * 但不会被任何 kinds 过滤选中。
   */
  kind: string;
  /** 1-based 起始行。 */
  startLine: number;
  /** 1-based 结束行（含）；缺省时只展示起始行。 */
  endLine?: number;
  /** 展示用签名；缺省时展示 name。 */
  signature?: string;
  /** 嵌套深度，顶层为 0；缺省按 0。code.outline 的 maxDepth=N 只保留 depth < N 的声明。 */
  depth?: number;
}

/**
 * Handler 执行上下文 — 通过 DI 注入外部依赖。
 *
 * 设计约束:
 * - 各字段为可选（不是所有 handler 都需要全部依赖），由 ToolContextFactory 在调用前按需组装
 * - 知识读写端口定义在 kernel 叶子合同中，由宿主绑定真实服务；
 *   尚未迁移的 projectGraph/searchEngine 等保留 unknown，由 handler 检查最小能力，
 *   不让 kernel 反向依赖 handler 或具体宿主模块
 * - 轻量级工具组件 (deltaCache/searchCache 等) 通过 DI 接口 (*Like) 定义最小契约
 */
export interface ToolContext {
  /** 宿主当前接线事实；缺省是旧宿主未声明，不代表 actor 获得任何额外权限。 */
  toolAvailability?: ToolAvailabilitySnapshot;
  /** 项目根目录绝对路径 */
  projectRoot: string;

  // ── 重量级 DI 服务 (duck-typed, 真实接口见各 handler) ──

  /**
   * AST 项目图谱。graph handler 与 availability 都按 GRAPH_QUERY_HOST_READERS 查找方法，
   * 不做类型 cast；overview 另读 getOverview。
   */
  projectGraph?: unknown;

  /**
   * 代码实体图谱。唯一生产宿主只提供 impactAnalysis；queryEntity/queryCallGraph/search 是
   * GRAPH_QUERY_HOST_READERS 中标为 legacy 的旧宿主兼容入口（已弃用，移除条件见该常量）。
   */
  codeEntityGraph?: unknown;

  /** 知识搜索引擎 — knowledge 查询先检查运行时 search 能力。 */
  searchEngine?: unknown;

  /** 知识提交网关 — knowledge handler 内部 cast 为 RecipeGatewayLike */
  recipeGateway?: unknown;

  /** 显式知识读取端口；提供后即不再回落 knowledgeRepo。 */
  knowledgeRead?: KnowledgeReadPort;

  /** 显式知识管理端口；缺少具体方法必须报告不可用，不回落原始仓储。 */
  knowledgeManagement?: KnowledgeManagementPort;

  /**
   * 旧宿主兼容入口；仅对应的显式端口未提供时使用，不能冒充 Core 管理服务。
   * knowledge.prime/detail 在 knowledgeRead 缺省时回落到这里，两者都缺时 prime 只做 search-only
   * （带 KNOWLEDGE_PRIME_SEARCH_ONLY 诊断）。唯一生产宿主通过 knowledgeRead 提供详情、不注入本字段；
   * 待决事项③确认单宿主后，prime 改为强制要求 knowledgeRead。
   */
  knowledgeRepo?: unknown;

  /** staging 复核通道 — knowledge.manage(review) cast 为 StagingManagerLike（recordReview）。 */
  stagingManager?: unknown;

  /** 进化决策网关 — knowledge.manage(evolve/deprecate/skip_evolution) 的唯一写入口 */
  proposalGateway?: unknown;

  /**
   * AST 大纲端口（L4-P36 / I16，待决事项⑤已定：Agent 声明端口、宿主适配）。code.outline 与
   * >500 行 code.read 的骨架优先经由这里取得（下方 astAnalyzer 只是缺省时的已弃用兼容入口）；
   * availability 只按本端口广告 code.outline。
   *
   * - absPath 是已通过项目根校验的绝对路径，relPath 是项目相对路径（用于按扩展名映射语言与日志）；
   * - 宿主负责读源码、按扩展名映射 lang、调用 Core analyzeFile(source, lang)，再把类/方法等适配成
   *   OutlineDefinition[]；Core 不为此新增端口，Agent 也不猜测 Core 摘要的形状；
   * - 语言不支持或文件没有可列出的声明返回 null 或空数组（handler 记为 no-definitions）；
   *   解析异常直接抛错（handler 记为 analyzer-error 并带错误类名），不要吞成 null。
   */
  outlineFile?: (absPath: string, relPath: string) => Promise<OutlineDefinition[] | null>;

  /**
   * 已弃用的 AST 分析器鸭子类型 analyzeFile(absPath) => Promise<{ definitions }>（I16）。
   * 它与 Core analyzeFile(source, lang) 的真实签名不一致，生产宿主也从未注册，所以 availability
   * 不再据此广告 code.outline；handler 只在 outlineFile 缺省时把它当兼容入口调用并记日志。
   * 消费者：仍按旧鸭子类型注入的宿主/测试夹具（唯一生产宿主 ToolContextFactory 透传 tryGet 结果，
   * 实际恒为 undefined）。移除条件：宿主改为注册 outlineFile 并停止透传本字段后，删除本字段与
   * code handler 的 legacy-astAnalyzer 分支（类型收窄随待决事项⑤的后续收尾，由 AlembicAgent 负责）。
   */
  astAnalyzer?: unknown;

  /** 安全策略 — terminal handler 可选引用 */
  safetyPolicy?: unknown;

  /**
   * Seatbelt 沙箱执行器 — terminal handler 通过 DI 注入；未注入时默认拒绝执行。
   * 调用形如 exec(command, { cwd, projectRoot, timeout, signal?, intent? })；intent 由 terminal handler
   * 合并 runtime.terminalIntent（生产链路：runtimeBridge 按 loopCtx.capabilities 投影）与
   * commandAllowlist.intent（带 capability 的 ToolRouter 注入）得到，只在当前能力声明了隔离意图时
   * 出现。宿主可据此选择沙箱 profile；当前 Alembic SandboxExecutorBridge 尚未读取该字段。
   */
  sandboxExecutor?: unknown;

  /**
   * 显式许可：没有 sandboxExecutor 时允许 terminal 以普通子进程执行（继承宿主环境变量）。
   * 只有字面量 true 生效。面向测试夹具和自担风险的受信宿主；生产宿主应注入
   * sandboxExecutor，由沙箱模块自己报告降级，而不是打开这个开关。
   */
  allowUnsandboxedTerminal?: boolean;

  /** Optional audit sink. Mirrors the host AuditLogger.log(entry) duck type. */
  auditSink?: ToolAuditSinkLike;

  /** Optional positive command allowlist for read-mostly terminal capabilities. */
  commandAllowlist?: TerminalCommandAllowlist;

  // ── 轻量级工具组件 (通过 DI 接口约束) ──

  /** 文件读取增量缓存 */
  deltaCache?: DeltaCacheLike;

  /** 搜索结果缓存 */
  searchCache?: SearchCacheLike;

  /** 会话记忆存储 */
  sessionStore?: SessionStoreLike;

  /** 终端输出压缩器 */
  compressor?: OutputCompressorLike;

  // ── 运行时参数 ──

  /** 本次调用 token 预算 (影响输出截断) */
  tokenBudget: number;

  /** 取消信号 */
  abortSignal?: AbortSignal;

  /** 工具注册表引用 (meta.tools 自省需要，由 router 自动注入) */
  toolRegistry?: ToolRegistry;

  /** Agent 记忆协调器 — memory 工具的 note_finding action 桥接到 ActiveContext.#scratchpad */
  memoryCoordinator?: MemoryCoordinatorLike;

  /** Runtime metadata from AgentRuntime, used by write tools to inject system-owned fields. */
  runtime?: ToolRuntimeCallContext;
}

export interface ToolDiagnosticWarning {
  code: string;
  message: string;
  stage?: string;
  tool?: string;
}

export interface ToolAuditEntry {
  requestId?: string;
  actor: string;
  action: string;
  resource: string;
  result: 'success' | 'failure';
  error?: string;
  duration: number;
  data: { commandHash: string };
  context: Record<string, unknown>;
}

export interface ToolAuditSinkLike {
  log(entry: ToolAuditEntry): void | Promise<void>;
}

/** action handler 函数签名 */
export type ActionHandler = (
  params: Record<string, unknown>,
  ctx: ToolContext
) => Promise<ToolResult>;

/* ------------------------------------------------------------------ */
/*  Capability                                                         */
/* ------------------------------------------------------------------ */

/**
 * Capability 定义 — tool → 允许的 action 列表。
 * 参数级（例如 knowledge.manage.operation）allowlist 暂未进入本公开类型；在公开字段获批前由
 * tools/kernel/toolSelection.ts 的 CAPABILITY_PARAMETER_ALLOWLISTS 按能力名登记（L4-P29）。
 */
export interface CapabilityDef {
  name: string;
  description: string;
  promptFragment?: string;
  allowedTools: ToolActionAllowlist;
  commandAllowlist?: TerminalCommandAllowlist;
}

/**
 * capability 级终端命令正向白名单。
 *
 * Agent 侧执行的约束是 bins：agent 层 accessGates 与（ToolContext 注入了 commandAllowlist 时的）
 * terminal handler 都把 bins 交给 checkTerminalCommandAllowlist（bin 白名单 + 写类参数/子命令约束）。
 * intent 不在 Agent 侧执行，而是透传给宿主执行端口（见下）。
 */
export interface TerminalCommandAllowlist {
  bins: readonly string[];
  /**
   * 隔离意图，经执行端口透传给宿主（L4-P38 / I47），两条入口都到达 sandboxExecutor：
   * - 生产链路（宿主构造不带 capability 的 ToolRouterAdapter）：runtimeBridge 从
   *   loopCtx.capabilities 读取每个能力的 commandAllowlist.intent，经 mergeTerminalIntents 合并后
   *   写入 terminal 调用的 ToolCallRequest.runtime.terminalIntent；ToolRouterAdapter 把 runtime 并入
   *   ToolContext。
   * - 带 capability 的 ToolRouter：router 把本 allowlist 注入 ToolContext.commandAllowlist。
   * terminal.exec 再把这两个来源按同一规则合并，复制后作为 sandboxExecutor.exec(command, opts)
   * 的可选字段 opts.intent 交给宿主；无法识别的取值丢弃并打 warn，命令最终没有进沙箱时结果带
   * terminal_intent_not_enforced 诊断。
   * 生效与否取决于宿主是否读取 opts.intent：当前 Alembic 宿主的 SandboxExecutorBridge 尚未读取
   * 该字段（跨仓改造待派发），仍按固定的可写项目目录 profile 执行，此时 npm/node/vitest 等命令
   * 仍可能写文件；不能把这里的声明当成 Agent 侧已兑现的隔离保证。
   */
  intent?: {
    network?: 'none';
    filesystem?: 'read-only';
  };
}

/** 交给宿主执行端口的隔离意图，取值集合与 TerminalCommandAllowlist.intent 相同。 */
type TerminalIntent = NonNullable<TerminalCommandAllowlist['intent']>;

/**
 * 合并多个来源声明的终端隔离意图（L4-P38 / I47）。runtimeBridge（loopCtx.capabilities 的每个能力）
 * 与 terminal handler（ToolContext.commandAllowlist 与 runtime.terminalIntent）共用这一条规则。
 *
 * 合并规则：按维度取最严格值。每个维度只有一个受限取值（network:'none'、filesystem:'read-only'），
 * 缺省表示该来源未声明限制，所以任一来源声明了受限取值，合并结果就带上它，任何来源都不能放宽
 * 另一个来源的声明。这与 accessGates 要求命令逐个通过每个能力的 bins 一致（多个能力同时生效）。
 *
 * 声明可能来自用 JS 接线的宿主或能力：非对象、数组、未知字段或类型外取值一律丢弃，不猜成更宽或
 * 更严的 profile，并通过 ignored 返回“来源 + 字段 + 取值”描述，由调用方打 warn / 诊断（kernel 不
 * 直接写日志）。每次返回新对象，宿主改动它不会回写能力常量；没有可识别取值时 intent 为 undefined。
 */
export function mergeTerminalIntents(
  declarations: ReadonlyArray<{ source: string; intent: unknown }>
): { intent: TerminalIntent | undefined; ignored: string[] } {
  const intent: TerminalIntent = {};
  const ignored: string[] = [];
  for (const { source, intent: declared } of declarations) {
    if (declared === undefined || declared === null) {
      continue;
    }
    if (typeof declared !== 'object' || Array.isArray(declared)) {
      ignored.push(
        `${source} intent is ${Array.isArray(declared) ? 'array' : typeof declared}, expected object`
      );
      continue;
    }
    for (const [field, value] of Object.entries(declared) as Array<[string, unknown]>) {
      if (value === undefined) {
        continue;
      }
      if (field === 'network' && value === 'none') {
        intent.network = value;
      } else if (field === 'filesystem' && value === 'read-only') {
        intent.filesystem = value;
      } else {
        ignored.push(`${source} field=${field} value=${describeTerminalIntentValue(value)}`);
      }
    }
  }
  return {
    intent: intent.network !== undefined || intent.filesystem !== undefined ? intent : undefined,
    ignored,
  };
}

/**
 * 描述被丢弃的 intent 取值。不用 JSON.stringify 处理任意值：BigInt 或循环引用会抛错，而合并发生在
 * 工具执行的关键路径上，诊断本身不能让调用崩溃。
 */
function describeTerminalIntentValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  return `<${Array.isArray(value) ? 'array' : typeof value}>`;
}

/* ------------------------------------------------------------------ */
/*  graph.query 宿主读取表（graph handler 与 availability 共用）        */
/* ------------------------------------------------------------------ */

/** graph 工具读取的宿主端口，即 ToolContext 上的同名字段。 */
export type GraphHostPort = 'projectGraph' | 'codeEntityGraph';

/** graph.query 的 query type；必须与 runtime registry 中 graph.query 的 type 枚举逐项同序。 */
export type GraphQueryType =
  | 'class'
  | 'protocol'
  | 'hierarchy'
  | 'callers'
  | 'callees'
  | 'overrides'
  | 'extensions'
  | 'impact'
  | 'search';

/** 某个 query type 的一条宿主读取路径。 */
export interface GraphQueryHostReader {
  readonly port: GraphHostPort;
  readonly method: string;
  /** 按 (entity, limit) 组装宿主方法实参；实参形状属于宿主端口契约，不随 handler 改写。 */
  readonly args: (entity: string, limit: number) => unknown[];
  /** 旧宿主兼容入口（已弃用 deprecated）：唯一生产宿主不提供该方法，见下方常量的移除条件。 */
  readonly legacy?: true;
}

function graphReaders(...readers: GraphQueryHostReader[]): readonly GraphQueryHostReader[] {
  return Object.freeze(readers.map((reader) => Object.freeze(reader)));
}

const entityOnly = (entity: string): unknown[] => [entity];
const entityAndLimit = (entity: string, limit: number): unknown[] => [entity, limit];

/**
 * graph.query 的“query type → 宿主方法”单一来源，数组顺序即读取优先级：handler 依次读取，
 * 前一条缺失或返回空时才进入下一条，并记 GRAPH_QUERY_FALLBACK；availability 只要任一条的方法在场
 * 就广告该分支。此前 graph handler 与 availability 各抄一份方法名，需要手工同步。
 * test/tool-runtime-legacy-host-compat.test.ts 守护本表与 runtime registry 枚举一致、两处消费方都从这里派生。
 *
 * legacy 条目是旧宿主兼容入口（待决事项③未答复，暂不删除，只标注）：
 * - 消费者：未迁移到 ProjectGraphPorts 形态的旧宿主与测试替身（tool-system、tool-availability 等测试的
 *   全接线替身）。唯一生产宿主 ../Alembic 的 ProjectGraphPorts 只提供 getOverview/getClassInfo/
 *   getProtocolInfo/getClassHierarchy/getCallers/getCallees/searchEntities 与 impactAnalysis，所以
 *   availability 在生产中隐藏 overrides/extensions，class/callers/callees/search 只走主读取器。
 * - 移除条件：待决事项③确认 ../Alembic 是唯一宿主后，删除全部 legacy 条目，并把只剩 legacy 读取器的
 *   overrides/extensions 从本表、GraphQueryType 与 runtime registry 枚举一并去掉（模型可见 schema 收窄），
 *   同步改写依赖旧端口的测试替身。
 */
export const GRAPH_QUERY_HOST_READERS: Readonly<
  Record<GraphQueryType, readonly GraphQueryHostReader[]>
> = Object.freeze({
  class: graphReaders(
    { port: 'projectGraph', method: 'getClassInfo', args: entityOnly },
    {
      port: 'codeEntityGraph',
      method: 'queryEntity',
      args: (entity) => [entity, 'class'],
      legacy: true,
    }
  ),
  protocol: graphReaders({ port: 'projectGraph', method: 'getProtocolInfo', args: entityOnly }),
  hierarchy: graphReaders({ port: 'projectGraph', method: 'getClassHierarchy', args: entityOnly }),
  callers: graphReaders(
    { port: 'projectGraph', method: 'getCallers', args: entityAndLimit },
    {
      port: 'codeEntityGraph',
      method: 'queryCallGraph',
      args: (entity, limit) => [entity, 'callers', limit],
      legacy: true,
    }
  ),
  callees: graphReaders(
    { port: 'projectGraph', method: 'getCallees', args: entityAndLimit },
    {
      port: 'codeEntityGraph',
      method: 'queryCallGraph',
      args: (entity, limit) => [entity, 'callees', limit],
      legacy: true,
    }
  ),
  overrides: graphReaders({
    port: 'projectGraph',
    method: 'getMethodOverrides',
    args: entityOnly,
    legacy: true,
  }),
  extensions: graphReaders({
    port: 'projectGraph',
    method: 'getCategoryMap',
    args: entityOnly,
    legacy: true,
  }),
  impact: graphReaders({ port: 'codeEntityGraph', method: 'impactAnalysis', args: entityAndLimit }),
  // 与 class/callers/callees 一致：项目图优先。生产宿主的实体图只有 impactAnalysis，若实体图在前，
  // 每次 search 都会被诊断为 primary-unavailable 回退。
  search: graphReaders(
    { port: 'projectGraph', method: 'searchEntities', args: entityAndLimit },
    { port: 'codeEntityGraph', method: 'search', args: entityAndLimit, legacy: true }
  ),
});

/* ------------------------------------------------------------------ */
/*  DI 接口 (Lightweight)                                              */
/* ------------------------------------------------------------------ */

/** MemoryCoordinator 最小接口 — memory 工具通过此接口桥接 Agent 记忆系统 */
export interface MemoryNoteFindingResult {
  recorded: boolean;
  target: 'activeContext' | 'missing-active-context' | 'error';
  importance: number;
  message: string;
  scratchpadSize?: number;
  scopeId?: string;
}

export interface MemoryCoordinatorLike {
  /**
   * 记录关键发现，应返回 MemoryNoteFindingResult。
   *
   * 返回 string 的回执形态已弃用（deprecated，旧宿主兼容）：memory handler 按“⚠ 前缀=失败”转译，
   * 并在结果上附 MEMORY_NOTE_FINDING_LEGACY_STRING_RECEIPT 诊断。仓内 MemoryCoordinator 与唯一生产
   * 宿主（直接转交 runtime.memoryCoordinator）只返回对象回执。待决事项③确认单宿主后，本签名收窄为
   * 只返回 MemoryNoteFindingResult（类型层公开契约收窄，需同步宿主类型检查）。
   */
  noteFinding(
    finding: string,
    evidence: string,
    importance: number,
    round: number,
    scopeId?: string,
    evidenceRefs?: string[]
  ): MemoryNoteFindingResult | string;

  /** 检索前序维度的代码证据 — get_previous_evidence 桥接 */
  searchEvidence?(
    query: string,
    dimId?: string
  ): Array<{
    filePath: string;
    evidence: { dimId?: string; importance?: number; finding: string };
  }>;

  /**
   * 带降级诊断的前序证据检索（L4-P21，可选）。get_previous_evidence 优先调用它，以便把
   * “本次运行没有前序证据存储”（MEMORY_EVIDENCE_STORE_MISSING）和“检索失败”
   * （MEMORY_EVIDENCE_SEARCH_FAILED）如实报成降级，而不是说成“没有前序证据”。
   * 只实现 searchEvidence 的旧宿主/替身不受影响（handler 回到旧路径）。
   * 字段刻意比 Agent MemoryCoordinator 的返回类型宽（code/reason 为 string），
   * 让 kernel 不反向依赖 agent，宿主也可以带自己的诊断码。
   */
  searchEvidenceWithDiagnostics?(
    query: string,
    dimId?: string
  ): {
    ok: boolean;
    degraded: boolean;
    reason: string | null;
    results: Array<{
      filePath: string;
      evidence: { dimId?: string; importance?: number; finding: string };
    }>;
    diagnostics: Array<{ code: string; message: string; reason?: string }>;
  };
}

/** DeltaCache 最小接口 */
export interface DeltaCacheLike {
  get(path: string): { hash: string; content: string } | undefined;
  /** hash 传 undefined 时由缓存按自身指纹算法计算，调用方不再各自实现指纹。 */
  set(path: string, hash: string | undefined, content: string): void;
  check(
    path: string,
    currentContent: string
  ): { mode: 'unchanged' | 'delta' | 'full'; content: string; lineCount: number };
  /**
   * 写前新鲜度：content 的指纹是否等于登记的版本指纹（可选）。
   * 缺省的旧实现由 code.write 降级为与缓存全文的精确比对，并输出诊断。
   */
  isFresh?(path: string, content: string): boolean;
}

/** SearchCache 最小接口 */
export interface SearchCacheLike {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
}

/** SessionStore 最小接口 */
export interface SessionStoreLike {
  save(key: string, content: string, meta?: Record<string, unknown>): void;
  recall(
    query?: string,
    opts?: { tags?: string[]; limit?: number }
  ): Array<{
    key: string;
    content: string;
    meta?: Record<string, unknown>;
  }>;
}

/** OutputCompressor 最小接口 */
export interface OutputCompressorLike {
  compress(raw: string, opts: CompressOpts): string | Promise<string>;
}

export interface CompressOpts {
  command?: string;
  tokenBudget?: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** 快速构建成功结果 */
export function ok(data: unknown, meta?: Partial<ToolResultMeta>): ToolResult {
  return {
    ok: true,
    data,
    _meta: {
      cached: false,
      tokensEstimate: 0,
      durationMs: 0,
      ...meta,
    },
  };
}

/** 快速构建失败结果 */
export function fail(error: string): ToolResult {
  return { ok: false, data: null, error };
}

/**
 * 工具层 token 估算，委托 shared/tokenUtils 的共同口径：按 Unicode 字符计，首个 UTF-16 码元
 * 高于 U+2E80 的字符（CJK、emoji 等）每字 0.5，其余每字 0.25，合计向上取整。
 *
 * 曾按 len/4 估算，对中文低估约一倍：maxOutputTokens 的实际放行量变成声明值的两倍，
 * _meta.tokensEstimate 也与记忆层、上下文预算的估算对不上。这里保留函数导出（名与种类不变），
 * Router 截断、handler 的 tokensEstimate 和记忆层由此使用同一把尺子。
 */
export function estimateTokens(text: string): number {
  return estimateSharedTokens(text);
}
