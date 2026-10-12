/**
 * LoopContext — reactLoop 单次执行的完整状态
 *
 * 封装原 reactLoop 内散落的 10+ 局部变量:
 *   - 注入依赖 (messages, tracker, trace, memoryCoordinator, sharedState；sharedState 会被工具管线
 *     用 ??= 惰性创建并写入)
 *   - 循环状态 (iteration, lastReply, toolCalls, tokenUsage；toolCalls/tokenUsage 是本次 loop 的累计值)
 *   - 错误恢复 (consecutiveAiErrors, consecutiveEmptyResponses)
 *   - 构造期配置 (source, budget, capabilities, baseSystemPrompt, toolSchemas, prompt 等)
 *   - 构造后由 AgentRuntime.#initLoop 挂接的控制器 (exitController, budgetController)
 *
 * 字段都是公开可写的（没有 readonly，以免改变公开 d.ts）；上面的分组描述的是实际写入方，不是类型约束。
 * 使 reactLoop 的提取方法只需接收一个 ctx 参数。
 *
 * @module agent/runtime/LoopContext
 */

import { randomUUID } from 'node:crypto';
import type { ToolResourceScope } from '#tools/kernel/context.js';
import type { Capability } from '../../tools/runtime/toolsets/Capability.js';
import type { ContextWindow } from '../context/ContextWindow.js';
import type { ExplorationTracker } from '../context/ExplorationTracker.js';
import type { EvidenceLedgerStore } from '../evidence/EvidenceLedgerStore.js';
import type { ActiveContext } from '../memory/ActiveContext.js';
import type { MemoryCoordinator } from '../memory/MemoryCoordinator.js';
import type { GroundingEnforcement } from './AgentRuntimeTypes.js';
import type { BudgetController } from './BudgetController.js';
import type { DiagnosticsCollector } from './DiagnosticsCollector.js';
import type { ExitController } from './ExitController.js';
import type { MessageAdapter } from './MessageAdapter.js';
import {
  buildPcvNodeEvidenceSummary,
  createPcvNodeEvidence,
  type PcvNodeEvidenceSummary,
} from './PcvNodeEvidenceRecorder.js';

/** Tool call hook type */
type ToolCallHook = (name: string, params: Record<string, unknown>, result: unknown) => void;
// biome-ignore lint/suspicious/noExplicitAny: accept various hook signatures from callers; unknown[] breaks contravariant param checks.
type ToolCallHookLike = (...args: any[]) => void;

/** Token usage returned by AI providers */
interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheHitTokens?: number;
}

/** Shared state between pipeline stages */
interface SharedState {
  submittedTitles?: Set<string>;
  submittedPatterns?: Set<string>;
  submittedTriggers?: Set<string>;
  submitToolName?: string;
  _dimensionMeta?: { id?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Budget configuration */
interface BudgetConfig {
  maxIterations?: number;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  maxSessionInputTokens?: number;
  maxSessionTokens?: number;
  [key: string]: unknown;
}

/** LoopContext configuration — accepts both concrete and duck-typed inputs from callers */
interface LoopContextConfig {
  resourceRunId?: string;
  messages: MessageAdapter;
  tracker?: ExplorationTracker | Record<string, unknown> | null;
  trace?: ActiveContext | Record<string, unknown> | null;
  memoryCoordinator?: MemoryCoordinator | Record<string, unknown> | null;
  sharedState?: SharedState | Record<string, unknown> | null;
  /** 证据台账（Wave A E2）；null=非维度场景，采集/引用校验全部零行为 */
  evidenceLedger?: EvidenceLedgerStore | null;
  source?: string;
  budget: BudgetConfig;
  capabilities: Capability[];
  baseSystemPrompt: string;
  allowedToolIds: string[];
  allowedToolActions?: Record<string, string[]>;
  toolSchemas: Array<Record<string, unknown>>;
  prompt: string;
  onToolCall?: ToolCallHook | ToolCallHookLike | null;
  context?: Record<string, unknown>;
  contextWindow?: ContextWindow | null;
  toolChoiceOverride?: string | null;
  groundingEnforcement?: GroundingEnforcement;
  abortSignal?: AbortSignal | null;
  diagnostics?: DiagnosticsCollector | null;
  exitController?: ExitController | null;
}

export class LoopContext {
  readonly #resourceRunId: string | undefined;
  readonly #resourceViewId = randomUUID();

  get resourceScope(): ToolResourceScope | undefined {
    return this.#resourceRunId
      ? {
          runId: this.#resourceRunId,
          viewId: this.#resourceViewId,
          revision: this.messages.readViewRevision,
        }
      : undefined;
  }
  // ─── 注入依赖 ───

  /** 统一消息适配器 */
  messages: MessageAdapter;

  /** ExplorationTracker 实例 */
  tracker: ExplorationTracker | null;

  /** ActiveContext 实例 */
  trace: ActiveContext | null;

  /** MemoryCoordinator 实例 */
  memoryCoordinator: MemoryCoordinator | null;

  /**
   * 阶段间 / 宿主注入的共享状态。不是只读：工具管线（submissionLedger、duplicateCache）会用 ??=
   * 惰性创建这个对象并写入 _producerSubmitLedger / _toolEfficiencyCache 等隐式键。
   */
  sharedState: SharedState | null;

  // ─── 循环状态 ───

  /** 当前迭代次数 */
  iteration = 0;

  /** 最终回复文本 */
  lastReply = '';

  /** 本次 loop 累计的工具调用记录（逐轮追加，buildResult 原样返回；不在迭代间重置） */
  // biome-ignore lint/suspicious/noExplicitAny: tool call entries have varying shapes across callers; no common structural type satisfies all consumers.
  toolCalls: any[] = [];

  /** 本次 loop 累计 token 用量（addTokenUsage 逐轮累加，buildResult 原样返回） */
  tokenUsage = { input: 0, output: 0, reasoning: 0, cacheHit: 0 };

  /** 循环开始时间戳 */
  loopStartTime = 0;

  // ─── 错误恢复 ───

  /** 连续 AI 错误计数 (2-strike 策略) */
  consecutiveAiErrors = 0;

  /** 连续空响应计数 */
  consecutiveEmptyResponses = 0;

  // ─── 构造期配置 ───
  // 由 LoopContextConfig 注入；AgentRuntime 构造 ctx 后不再改写这些字段（字段本身仍是公开可写的）。

  /** 来源 'user' | 'system' */
  source: string;

  /** 预算配置 */
  budget: BudgetConfig;

  capabilities: Capability[];

  /** 基础系统提示词 */
  baseSystemPrompt: string;

  /** 工具 schemas */
  toolSchemas: Array<Record<string, unknown>>;

  /** 当前 loop 明确允许调用的工具 ID */
  allowedToolIds: string[];

  /** 当前 loop 明确允许调用的工具 action；缺省表示该工具未做 action 级限制 */
  allowedToolActions: Record<string, string[]>;

  /** 原始用户提示 */
  prompt: string;

  /** 工具调用钩子 */
  onToolCall: ToolCallHook | null;

  /** 额外上下文 */
  context: Record<string, unknown>;

  /** 原始 ContextWindow 引用 */
  contextWindow: ContextWindow | null;

  /** 首轮 toolChoice 覆盖 ('required'/'auto'/'none') */
  toolChoiceOverride: string | null;

  /**
   * 本轮 grounding enforcement effective 值（AP-3；默认 `'off'`=PCV observe-only）。
   * AgentRuntime 在 #initLoop 解析（per-run override ?? 全局默认）后注入；
   * CP1 政策文本注入（LLMInputAssembly）与 CP4 analyze 阻断（AgentRuntime 调用点）仅在 `'guard'` 时生效。
   */
  groundingEnforcement: GroundingEnforcement;

  /** 外部中止信号 — hard timeout 时取消进行中的 LLM 调用 */
  abortSignal: AbortSignal | null;

  /** 统一诊断收集器 */
  diagnostics: DiagnosticsCollector | null;

  // ─── 构造后由 AgentRuntime 挂接的控制器 ───
  // createExitController 需要已构造好的 ctx（tracker/budget/abortSignal），BudgetController 需要
  // 运行时累计用量，所以二者都在 AgentRuntime.#initLoop 里于 new LoopContext 之后赋值。

  /** ExitController — 统一退出决策；构造后由 AgentRuntime.#initLoop 通过 createExitController 挂接 */
  exitController: ExitController | null;

  /** BudgetController — 预算决策 + 压缩触发 + 遥测；构造后由 AgentRuntime.#initLoop 挂接 */
  budgetController: BudgetController | null = null;

  // ─── 证据面 ───

  /** PCVM N9 node-local evidence — 供宿主 trace/artifact/metrics 承接 */
  pcvNodeEvidence: PcvNodeEvidenceSummary;

  /** 证据台账（Wave A E2）——采集中间件写、note_finding 校验与 evidence 工具读；null=零行为 */
  evidenceLedger: EvidenceLedgerStore | null;

  constructor(config: LoopContextConfig) {
    this.#resourceRunId = config.resourceRunId;
    this.messages = config.messages;
    this.tracker = (config.tracker || null) as ExplorationTracker | null;
    this.trace = (config.trace || null) as ActiveContext | null;
    this.memoryCoordinator = (config.memoryCoordinator || null) as MemoryCoordinator | null;
    this.evidenceLedger = config.evidenceLedger ?? null;
    this.sharedState = (config.sharedState || null) as SharedState | null;
    this.source = config.source || 'user';
    this.budget = config.budget;
    this.capabilities = config.capabilities;
    this.baseSystemPrompt = config.baseSystemPrompt;
    this.allowedToolIds = config.allowedToolIds;
    this.allowedToolActions = config.allowedToolActions || {};
    this.toolSchemas = config.toolSchemas;
    this.prompt = config.prompt;
    this.onToolCall = (config.onToolCall || null) as ToolCallHook | null;
    this.context = config.context || {};
    this.contextWindow = config.contextWindow || null;
    this.toolChoiceOverride = config.toolChoiceOverride || null;
    this.groundingEnforcement = config.groundingEnforcement ?? 'off';
    this.abortSignal = (config.abortSignal || null) as AbortSignal | null;
    this.diagnostics = config.diagnostics || null;
    this.exitController = config.exitController || null;
    this.loopStartTime = Date.now();
    this.pcvNodeEvidence = createPcvNodeEvidence(this);
  }

  // ─── 计算属性 ───

  /** 是否为 system 场景 */
  get isSystem() {
    return this.source === 'system';
  }

  /** 最大迭代数 */
  get maxIterations() {
    return this.budget.maxIterations || 20;
  }

  // ─── Token 累计辅助 ───

  /**
   * 累加 token 用量到循环级统计
   * @param usage { inputTokens, outputTokens }
   */
  addTokenUsage(usage: TokenUsage | null | undefined) {
    if (!usage) {
      return;
    }
    this.tokenUsage.input += usage.inputTokens || 0;
    this.tokenUsage.output += usage.outputTokens || 0;
    this.tokenUsage.reasoning += usage.reasoningTokens || 0;
    this.tokenUsage.cacheHit += usage.cacheHitTokens || 0;
  }

  // ─── 结果构建 ───

  /**
   * 构建循环返回值
   * @returns }
   */
  buildResult() {
    return {
      reply: this.lastReply,
      toolCalls: [...this.toolCalls],
      tokenUsage: { ...this.tokenUsage },
      iterations: this.iteration,
      pcvNodeEvidence: buildPcvNodeEvidenceSummary(this.pcvNodeEvidence),
      ...(this.diagnostics ? { diagnostics: this.diagnostics.toJSON() } : {}),
    };
  }
}
