import type { AgentMessage } from '../runtime/AgentMessage.js';
import type {
  AgentDiagnostics,
  FileCacheEntry,
  GroundingEnforcement,
  ProgressEvent,
  ToolCallEntry,
} from '../runtime/AgentRuntimeTypes.js';
import type { SystemRunContext } from '../runtime/SystemRunContext.js';

export type BuiltinAgentPreset = 'chat' | 'insight' | 'evolution';

export interface AgentProfileRef {
  id?: string;
  preset?: BuiltinAgentPreset | string;
  params?: Record<string, unknown>;
}

export interface AgentProfileOverride {
  id?: string;
  basePreset: BuiltinAgentPreset | string;
  skills?: string[];
  /**
   * 运行时策略配置，整体替换 preset 的 strategy，交给 resolveStrategy 解析。只接受运行时 StrategyConfig
   * 词汇（'single' / 'pipeline'）；声明模板词汇 'preset' / 'fanout' 只在 AgentProfileDefinition 里有效，
   * 运行时 'fan_out' 随 FanOutStrategy 删除（W2a-06 / L5-P39），写这些值都会在 runtime build 时以
   * Unknown strategy type 失败（L8-C09）。
   */
  strategy?: Record<string, unknown>;
  policies?: unknown[];
  /** 与 preset persona 浅合并；运行时只读 description（系统提示的“# 角色”段），其余键没有读取者（L8-C11）。 */
  persona?: Record<string, unknown>;
  /**
   * 描述性声明（L8-C11）：与 preset memory 浅合并后只留在 getPreset 的配置快照里，不再交给运行时——
   * RuntimeConfig.memory → SystemPromptBuilder → buildContext({ memoryMode }) 这条空传递已删除
   * （W2a-06 / L8-P17），enabled / tiers / mode 都没有读取者。因此 { enabled: false } 不会关闭记忆注入：
   * 记忆是否参与由运行上下文的 memoryCoordinator 决定。声明块本身待宿主测试移除 memory 键后再删除。
   */
  memory?: Record<string, unknown>;
  actionSpace?: AgentActionSpace;
  params?: Record<string, unknown>;
}

/**
 * profile 的描述性服务分类（L8-C11）：编译器只复制或按 preset 推导（serviceKindForPreset），
 * 运行时不据此分支，不能当作行为开关。
 */
export type AgentServiceKind =
  | 'conversation'
  | 'system-analysis'
  | 'knowledge-production'
  | 'translation'
  | 'background-analysis';

export interface AgentProfileDefaults {
  skills?: string[];
  policies?: unknown[];
  /** 同 AgentProfileOverride.persona：与 preset 浅合并，运行时只读 description。 */
  persona?: Record<string, unknown>;
  /** 同 AgentProfileOverride.memory：描述性声明，{ enabled: false } 不关闭记忆注入。 */
  memory?: Record<string, unknown>;
  actionSpace?: AgentActionSpace;
}

/**
 * profile 声明层的策略模板，由 AgentProfileCompiler.compileStrategy 编译成运行时 StrategyConfig。
 * 'fanout' 模板只是标记（W2a-06 / L8-P17）：编译结果为空，真正的扇出由 AgentRunCoordinator 按
 * concurrency 计划执行，child / 分区器 / 合并器只在计划里声明一次（编译期要求计划声明齐全，见
 * AgentConcurrencyPlan）。旧模板上的 childProfile / partitioner / merge 已删除：它们从不被读取。
 */
export type AgentStrategyTemplate =
  | { type: 'preset' }
  | { type: 'single' }
  | { type: 'pipeline'; factory: string; paramsSchema?: string }
  | { type: 'fanout' };

/**
 * fanout 协调计划。AgentRunCoordinator 只读 mode / concurrency / partitioner / childProfile / merge；
 * fanout profile 的计划必须声明 partitioner / childProfile / merge，缺失时编译期抛错。
 * 取消语义固定为 stop-new：tier 边界与每个 child 派发前检查 abortSignal / shouldAbort，已开始的 child
 * 不被协调器打断（父 abortSignal 经 partitioner 透传给 child，由 child 自身收尾），尚未派发的 child
 * （含同 tier 中排队的）记为 aborted。从未被读取的 abortPolicy 声明字段已删除（W2a-06 / L8-P17，
 * L5-P37 的“收窄为 stop-new”被其覆盖）。
 */
export interface AgentConcurrencyPlan {
  mode: 'none' | 'tiered' | 'parallel';
  concurrency?: number | { env: string; default: number };
  partitioner?: string;
  childProfile?: string;
  merge?: string;
}

export interface AgentProfileDefinition {
  id: string;
  title: string;
  /** 描述性元数据，运行时不消费（L8-C11）。 */
  serviceKind: AgentServiceKind;
  /**
   * 描述性生命周期标记（L8-C11）：不阻止编译、不改运行行为；为 'deprecated' 时编译器每次编译记一条
   * profile_lifecycle_deprecated 告警，这是它唯一的读取者。
   */
  lifecycle: 'active' | 'experimental' | 'deprecated';
  basePreset?: BuiltinAgentPreset | string;
  defaults?: AgentProfileDefaults;
  strategy?: AgentStrategyTemplate | Record<string, unknown>;
  /** 描述性元数据，运行时不消费：结果投影由各 run helper 自己完成，不按此字段选择（L8-C11）。 */
  projection?: string;
  concurrency?: AgentConcurrencyPlan;
}

export type AgentActionSpace =
  | { mode: 'none' }
  | { mode: 'listed'; toolIds: string[] }
  | { mode: 'all'; reason: string };

export interface CompiledAgentProfile {
  kind: 'compiled-agent-profile';
  id: string;
  title: string;
  /**
   * 以下 serviceKind / lifecycle / projection 只是从声明复制或推导的描述性元数据，运行时不读取
   * （L8-C11）；override 与 preset 引用路径的 serviceKind 统一按 basePreset 推导，lifecycle 固定 'active'。
   */
  serviceKind: AgentServiceKind;
  lifecycle: 'active' | 'experimental' | 'deprecated';
  basePreset: BuiltinAgentPreset | string;
  skills?: string[];
  strategy?: Record<string, unknown>;
  policies?: unknown[];
  persona?: Record<string, unknown>;
  /** 描述性声明，见 AgentProfileOverride.memory：不会关闭记忆注入。 */
  memory?: Record<string, unknown>;
  actionSpace: AgentActionSpace;
  additionalTools: string[];
  params: Record<string, unknown>;
  projection?: string;
  concurrency?: AgentConcurrencyPlan;
  runtimeOverrides: Record<string, unknown>;
}

export interface AgentRunMessage {
  content: string;
  role?: 'user' | 'system' | 'internal';
  history?: Array<{ role: string; content: string }>;
  metadata?: Record<string, unknown>;
  sessionId?: string;
}

export interface AgentRunActor {
  role?: string;
  user?: string;
  sessionId?: string;
}

export type AgentRunSource =
  | 'http-chat'
  | 'http-stream'
  | 'bootstrap'
  | 'system-workflow'
  | 'mcp'
  | 'internal';

export type AgentRuntimeSource = 'user' | 'system' | 'analyst' | 'producer' | 'remote';

export interface AgentRunCoordinationHooks {
  onChildResult?: (event: {
    childInput: AgentRunInput;
    result: AgentRunResult;
    profile: CompiledAgentProfile;
  }) => void | Promise<void>;
  onTierComplete?: (event: {
    tierIndex: number;
    childInputs: AgentRunInput[];
    results: AgentRunResult[];
    profile: CompiledAgentProfile;
  }) => void | Promise<void>;
}

export type AgentChildInputFactory = (event: {
  plannedInput: AgentRunInput;
  parentInput: AgentRunInput;
}) => AgentRunInput | Promise<AgentRunInput>;

export interface AgentRunContext {
  source: AgentRunSource;
  runtimeSource?: AgentRuntimeSource;
  actor?: AgentRunActor;
  lang?: string | null;
  promptContext?: Record<string, unknown>;
  systemRunContext?: SystemRunContext;
  strategyContext?: Record<string, unknown>;
  memoryCoordinator?: unknown;
  contextWindow?: unknown;
  trace?: unknown;
  sharedState?: Record<string, unknown>;
  fileCache?: FileCacheEntry[] | null;
  childContexts?: Record<string, Partial<Omit<AgentRunContext, 'childContexts'>>>;
  childInputFactories?: Record<string, AgentChildInputFactory>;
  coordination?: AgentRunCoordinationHooks;
}

export interface AgentRunExecutionOptions {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  shouldAbort?: () => boolean | Promise<boolean>;
  budgetOverride?: Record<string, unknown>;
  toolChoiceOverride?: 'auto' | 'required' | 'none';
  /** per-run grounding enforcement 覆盖（AP-3）；不设则回退 runtime 全局默认（默认 observe-only `'off'`）。 */
  groundingEnforcement?: GroundingEnforcement;
  diagnostics?: unknown;
  onProgress?: ((event: ProgressEvent) => void) | null;
  onToolCall?:
    | ((name: string, args: Record<string, unknown>, result: unknown, iteration: number) => void)
    | null;
}

export interface AgentRunPresentationOptions {
  stream?: boolean;
  /**
   * 只写不读（L8-C11）：AgentService 只读 stream，结果形状恒为 AgentRunResult，各 run helper 自行投影；
   * 设置该字段不会改变返回形状。去留属于待决的公开面收窄（事项②）。
   */
  responseShape?: 'agent-result' | 'chat-reply' | 'system-task-result';
}

export interface AgentRunInput {
  profile: AgentProfileRef | AgentProfileOverride;
  message: AgentRunMessage;
  params?: Record<string, unknown>;
  context: AgentRunContext;
  execution?: AgentRunExecutionOptions;
  presentation?: AgentRunPresentationOptions;
}

export type AgentRunStatus = 'success' | 'blocked' | 'aborted' | 'timeout' | 'error';

export interface AgentRunUsage {
  inputTokens: number;
  outputTokens: number;
  iterations: number;
  durationMs: number;
}

export interface AgentRunResult {
  runId: string;
  profileId: string;
  reply: string;
  status: AgentRunStatus;
  phases?: Record<string, unknown>;
  toolCalls: ToolCallEntry[];
  usage: AgentRunUsage;
  diagnostics: AgentDiagnostics | null;
}

export interface AgentRuntimeRunOptions {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  diagnostics?: unknown;
  strategyContext?: Record<string, unknown>;
  systemRunContext?: SystemRunContext;
  budgetOverride?: Record<string, unknown>;
  toolChoiceOverride?: 'auto' | 'required' | 'none';
  /** per-run grounding enforcement 覆盖（AP-3）；透传至 runtime.execute → reactLoop。 */
  groundingEnforcement?: GroundingEnforcement;
  contextWindow?: unknown;
  trace?: unknown;
  memoryCoordinator?: unknown;
  sharedState?: Record<string, unknown>;
  context?: Record<string, unknown>;
  source?: AgentRuntimeSource | string;
}

export interface AgentRuntimeBuildOptions {
  lang?: string | null;
  onProgress?: ((event: ProgressEvent) => void) | null;
  onToolCall?:
    | ((name: string, args: Record<string, unknown>, result: unknown, iteration: number) => void)
    | null;
}

export interface AgentRuntimeLike {
  id: string;
  setFileCache?(files: FileCacheEntry[] | null): void;
  execute(
    message: AgentMessage,
    opts?: AgentRuntimeRunOptions
  ): Promise<{
    reply: string;
    toolCalls?: ToolCallEntry[];
    tokenUsage?: { input?: number; output?: number };
    iterations?: number;
    durationMs?: number;
    phases?: Record<string, unknown>;
    diagnostics?: AgentDiagnostics;
  }>;
}
