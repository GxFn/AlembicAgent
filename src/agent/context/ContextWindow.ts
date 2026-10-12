import type { LlmContinuation } from '#ai/contracts.js';
/**
 * ContextWindow — Agent 的上下文窗口管理器
 *
 * 业界最佳实践:
 *   - OpenAI Compaction: 阈值触发自动压缩，保留关键上下文
 *   - LangChain trim_messages: 按 token 裁剪，保证消息合法性
 *   - Anthropic 长上下文: 长文档前置，查询后置
 *   - Gemini API: functionResponse 必须紧跟 functionCall
 *
 * 设计不变量:
 *   1. messages[0] 始终是原始 user prompt（不可删除）
 *   2. assistant(toolCalls) 与其 tool results 是原子单元（不可拆分）
 *   3. 每次 AI 调用前按用量尽量压缩（L1→L2→L3）；L3 至少保留最近两轮工具调用，
 *      因此不保证投影严格落入 tokenBudget 以内（最近两轮本身偏大时仍可能超出）
 *   4. 运行时引导只通过单条 runtime_nudge user 消息（appendUserNudge）：新 nudge 追加前
 *      先移除旧的 runtime_nudge，历史中始终最多保留一条；引导内容由 ExplorationTracker 与
 *      AgentRuntime 的门控（grounding、digest 等）产生，本类只负责存放
 *   5. 「用量」只有一个口径：发给模型的投影视图（toProjectedMessages）。用量比例、
 *      工具结果配额、压缩触发和 L4 判定都读这一个口径；L3 折叠后保留的原始历史
 *      不计入用量，只通过 estimateRetainedTokens() 供诊断观察。
 *
 * 递进压缩（阈值可配置）:
 *   L1: 缩短旧工具结果；L2: 合并文本并保持工具调用/结果配对
 *   L3: 裁剪完整历史轮次；L4: 在预算控制器协调下生成结构化记忆摘要
 *
 * @module ContextWindow
 */

import Logger from '@alembic/core/logging';
import { getModelRegistry } from '#ai/registry/ModelRegistry.js';
import { observeSafely } from '#shared/observers.js';
import { estimateTokensFast } from '../../shared/tokenUtils.js';
import { isPersistedSubmission } from '../utils/toolOutcomes.js';
import {
  buildL4MemoryPackage,
  formatL4MemorySummary,
  L4_DISTILL_FAILED_STATE_KEY,
  type L4MemoryPackage,
  type L4MemoryPackageInput,
  renderL4MemoryPackage,
  validateL4Summary,
} from './l4MemoryPackage.js';

// ─── 类型定义 ──────────────────────────────────────────

/** 工具调用信息（provider 历史里保存的形状；MessageAdapter 的裸数组模式共用此类型）。 */
export interface ToolCallInfo {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}

/** 上下文窗口中的消息 */
export interface ContextMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string | null;
  /** DeepSeek V4 thinking / 推理内容，多轮对话需原样回传 */
  reasoningContent?: string | null;
  continuation?: LlmContinuation;
  toolCalls?: ToolCallInfo[];
  toolCallId?: string;
  name?: string;
  metadata?: {
    kind?: 'l4_memory_summary' | 'runtime_nudge';
    source?: string;
    /** Runtime 已确认的持久化事实，独立于受限的显示文本。 */
    persistedSubmission?: boolean;
    [key: string]: unknown;
  };
}

/** 搜索结果匹配项 */
interface SearchMatch {
  file?: string;
  line?: number;
  code?: string;
  context?: string;
  score?: number;
  lines?: string[];
  _truncated?: boolean;
}

/** 搜索结果对象 */
interface SearchResultLike {
  matches?: SearchMatch[];
  batchResults?: Record<string, SearchResultLike>;
  total?: number;
  searchedFiles?: number;
  _note?: string;
  _raw?: string;
}

/** 文件内容结果对象 */
interface FileResultLike {
  content?: string;
  batchResults?: Record<string, FileResultLike>;
}

/** 工具结果配额 */
interface ToolResultQuota {
  maxChars?: number;
  maxMatches?: number;
}

/**
 * 一组相关消息的原子单元:
 * - assistant(toolCalls) + 所有后续 tool results
 * - 或单独的 user/assistant 文本消息
 */

/** Compaction configuration — per-pipeline overrides */
export interface CompactionConfig {
  /**
   * [L0, L1, L2, L3, L4] usage ratio thresholds。
   * 注意：第 0 位（L0）当前不被任何代码读取——compactIfNeeded 只用 t1..t3，needsL4Compaction 只用 t4，
   * getToolResultQuota 使用独立的固定阶梯（0.5/0.7/0.85/0.95）。保留五元组形状只是为了不改公开类型。
   */
  thresholds?: [number, number, number, number, number];
  /** Whether to enable L4 LLM-based summary (scan pipelines may disable) */
  enableL4LLM?: boolean;
}

export interface ProviderInputBudgetOptions {
  maxProjectedMessages?: number;
  maxProjectedTokens?: number;
  reason?: string;
  stageProfile?: string;
}

export interface ProviderInputBudgetResult {
  afterMessageCount: number;
  afterProjectedTokens: number;
  beforeMessageCount: number;
  beforeProjectedTokens: number;
  level: number;
  reason: string | null;
  removed: number;
}

const DEFAULT_THRESHOLDS: [number, number, number, number, number] = [0.4, 0.55, 0.7, 0.82, 0.92];

export class ContextWindow {
  /** 统一格式消息 */
  #messages: ContextMessage[] = [];
  /**
   * token 预算：构造参数缺省为 24000；运行时（SystemRunContextFactory）通常传入
   * resolveTokenBudget 按模型上下文窗口算出的值。
   */
  #tokenBudget;
  /** 被压缩掉的轮次摘要（用于 digest 生成） */
  #compactionLog: string[] = [];
  /** 被压缩前提取的已提交候选标题 */
  #compactedSubmits = new Set<string>();
  /** 日志器 */
  #logger;
  /** L3 collapse threshold: messages before this index are collapsed in projection. -1 = inactive. */
  #collapseThreshold = -1;
  /** 5-layer compaction thresholds */
  #thresholds: [number, number, number, number, number];
  /** Whether L4 LLM summary is enabled */
  #enableL4LLM: boolean;
  /** Session-level budget pressure (0-1). Affects getToolResultQuota(). */
  #sessionPressure = 0;
  #readViewRevision = 0;

  get readViewRevision(): number {
    return this.#readViewRevision;
  }

  #invalidateReadView(reason: string): void {
    this.#readViewRevision++;
    this.#log(
      'info',
      `[ContextWindow] read view invalidated: ${reason}, revision=${this.#readViewRevision}`
    );
  }

  /**
   * 模型名 → 上下文窗口大小映射（token 数）。
   * 键为正则模式，按优先级从上到下匹配。
   * 值为模型的原始上下文窗口上限。
   */
  static MODEL_CONTEXT_WINDOWS = [
    // ── Google Gemini ──
    [/gemini-3/i, 1_048_576],
    [/gemini-2\.5/i, 1_048_576],
    [/gemini-2/i, 1_048_576],
    [/gemini-1\.5/i, 1_048_576],
    [/gemini-1\.0/i, 32_000],
    [/gemini/i, 1_048_576],
    // ── OpenAI ──
    [/gpt-5\.5/i, 1_100_000],
    [/gpt-5\.4-(?:mini|nano)/i, 400_000],
    [/gpt-5\.4/i, 1_050_000],
    [/gpt-5-(?:mini|nano)/i, 400_000],
    [/gpt-5/i, 400_000],
    [/gpt-4o/i, 128_000],
    [/gpt-4-turbo/i, 128_000],
    [/gpt-4-(?!turbo)/i, 8_192],
    [/gpt-3\.5-turbo-16k/i, 16_384],
    [/gpt-3\.5/i, 4_096],
    [/o1|o3|o4/i, 200_000],
    // ── Anthropic ──
    [/claude-opus-4-7/i, 1_000_000],
    [/claude-(?:opus|sonnet)-4[.-]6/i, 1_000_000],
    [/claude-(?:opus|sonnet)-4[.-]5/i, 200_000],
    [/claude-opus-4[.-]1/i, 200_000],
    [/claude-haiku-4/i, 200_000],
    [/claude-.*(?:sonnet|opus)-4/i, 200_000],
    [/claude-3[.-]5/i, 200_000],
    [/claude-3/i, 200_000],
    [/claude/i, 200_000],
    // ── DeepSeek ──
    [/deepseek-v4/i, 1_000_000],
    [/deepseek/i, 1_000_000],
    // ── 本地 Ollama ──
    [/llama3[.-]?[23]/i, 128_000],
    [/llama3/i, 8_192],
    [/llama/i, 4_096],
    [/mistral/i, 32_000],
    [/qwen/i, 128_000],
    [/phi/i, 128_000],
    // ── Mock（测试） ──
    [/mock/i, 32_000],
  ];

  /**
   * 根据模型名称解析合适的 ContextWindow token 预算。
   *
   * 策略: 取模型最大上下文窗口的一个安全分片，按 isSystem 分两套档位（system / 非 system）:
   *   - 超大窗口 (≥400k): 48000 / 36000（1M 级模型可容纳更多上下文）
   *   - 大窗口 (≥200k):   32000 / 24000（tool schemas + system prompt 占显著空间）
   *   - 中窗口 (≥64k):    24000 / 20000
   *   - 小窗口 (≥16k):    14000 / 12000
   *   - 微窗口 (<16k):    窗口 × 0.75 / 窗口 × 0.65（向下取整，余量留给 prompt/tool schema）
   *
   * 上下文窗口来源: provider 提示（opts.provider，其次 ALEMBIC_AI_PROVIDER）为具体 provider 时
   * 按 ModelRegistry.resolve 查询（别名先归一）；缺失或为 'auto' 时按 findByApiModelId 查询；
   * 注册表未命中才回退 MODEL_CONTEXT_WINDOWS 正则表，最后是 32k 保守默认。
   *
   * @param modelName 模型名称，如 'gemini-3-flash-preview', 'gpt-5.4-mini'
   * @param [opts] - isSystem 为 true 时给予更高预算；provider 为调用方已知的 provider 身份
   * @returns 建议的 token 预算
   */
  static resolveTokenBudget(
    modelName: string,
    opts: { isSystem?: boolean; provider?: string } = {}
  ) {
    const { isSystem = false, provider } = opts;

    // 1. 查找模型上下文窗口大小
    //    优先从 ModelRegistry 查询（声明式数据源），回退到旧的正则匹配
    let contextSize = 32_000;
    // 诊断用：source=registry|regex|default 表示窗口取自哪里；lookup 表示注册表按哪种键查询。
    let source: 'registry' | 'regex' | 'default' = 'default';
    let lookup: 'provider' | 'apiModelId' | 'none' = 'none';
    if (modelName) {
      const registry = getModelRegistry();
      const providerHint = (provider || process.env.ALEMBIC_AI_PROVIDER || '').trim();
      // 'auto' 是部署选择而非 ProviderId；缺失或为 auto 时按裸 apiModelId 查注册表
      // （内置表保证 apiModelId 全局唯一，不会命中别家模型）。具体 provider 提示仍是权威：
      // 先经注册表归一别名再按 provider 查，未命中不跨 provider 猜测，直接回退正则表。
      const byProvider = providerHint !== '' && providerHint.toLowerCase() !== 'auto';
      lookup = byProvider ? 'provider' : 'apiModelId';
      const regDef = byProvider
        ? registry.resolve(providerHint, modelName)
        : registry.findByApiModelId(modelName);
      if (regDef) {
        contextSize = regDef.contextWindow;
        source = 'registry';
      } else {
        // 降级路径：注册表未登记该模型时用正则表估算；正则也不匹配则保留 32k 保守默认。
        for (const [pattern, size] of ContextWindow.MODEL_CONTEXT_WINDOWS) {
          if ((pattern as RegExp).test(modelName)) {
            contextSize = size as number;
            source = 'regex';
            break;
          }
        }
      }
    }

    // 2. 按分级策略计算 token 预算
    let budget: number;
    if (contextSize >= 400_000) {
      budget = isSystem ? 48_000 : 36_000;
    } else if (contextSize >= 200_000) {
      budget = isSystem ? 32_000 : 24_000;
    } else if (contextSize >= 64_000) {
      budget = isSystem ? 24_000 : 20_000;
    } else if (contextSize >= 16_000) {
      budget = isSystem ? 14_000 : 12_000;
    } else {
      budget = Math.floor(contextSize * (isSystem ? 0.75 : 0.65));
    }

    // 预算来源诊断：区分注册表命中、正则降级与保守默认，便于追溯“预算偏大/偏小”的根因。
    // 模型名来自配置/环境，只写截断并去掉控制字符后的值，避免伪造日志行。
    const modelLabel = modelName ? modelName.slice(0, 64).replace(/[^\w.:/-]/g, '?') : '(empty)';
    observeSafely(
      () =>
        Logger.getInstance().debug(
          `[ContextWindow] token_budget_source source=${source} lookup=${lookup} model=${modelLabel} contextWindow=${contextSize} system=${isSystem} budget=${budget}`
        ),
      () => undefined
    );

    return budget;
  }

  /** @param [tokenBudget=24000] token 预算上限 */
  constructor(tokenBudget = 24000, compactionConfig?: CompactionConfig) {
    this.#tokenBudget = tokenBudget;
    this.#logger = Logger.getInstance();
    this.#thresholds = compactionConfig?.thresholds ?? DEFAULT_THRESHOLDS;
    // L4 仍保留为显式能力；在 note_finding 证据链稳定前，运行时默认不自动触发。
    this.#enableL4LLM = compactionConfig?.enableL4LLM ?? false;
  }

  // ─── 消息添加 API ──────────────────────────────────────

  /** 追加用户消息 */
  appendUserMessage(content: string) {
    this.#messages.push({ role: 'user', content });
  }

  /**
   * 追加运行时引导消息 — 带 runtime_nudge 标记的 user 消息，用于阶段转换等时机向 AI
   * 明确传达行为期望。与 appendUserMessage 不同：追加前先移除历史中旧的 runtime_nudge
   * （并同步修正 L3 折叠边界），保证同一时刻最多只有一条运行时引导（设计不变量 4）。
   */
  appendUserNudge(content: string) {
    // 过滤规则与 SimpleArrayAdapter 共用（dropStaleRuntimeNudges），保证两种消息存储只保留最新运行时指令。
    const { kept, removedBeforeCollapse } = dropStaleRuntimeNudges(
      this.#messages,
      this.#collapseThreshold
    );
    this.#messages = kept;
    // L3 使用绝对索引；移除旧 nudge 后必须移动边界，不能额外隐藏仍可见的工具调用。
    this.#collapseThreshold -= removedBeforeCollapse;
    this.#messages.push(createRuntimeNudgeMessage(content));
  }

  /**
   * 追加 assistant 消息（含工具调用）
   * @param text assistant 文本
   * @param toolCalls [{id, name, args}]
   * @param reasoningContent DeepSeek V4 推理内容（可选）
   */
  appendAssistantWithToolCalls(
    text: string | null,
    toolCalls: ToolCallInfo[],
    reasoningContent?: string | null,
    continuation?: LlmContinuation
  ) {
    // 参数压缩与续接取舍由 prepareToolCallsForProviderHistory 统一决定（SimpleArrayAdapter 共用），
    // 两种消息存储发给 provider 的历史调用形状一致。
    const history = prepareToolCallsForProviderHistory(toolCalls, continuation);
    const msg: ContextMessage = {
      role: 'assistant',
      content: text || null,
      toolCalls: history.toolCalls,
      // V4 要求: 带 tool_calls 的 assistant 消息的 reasoning_content 必须保留
      // 始终存储此字段（即使为空），确保后续 API 调用不会丢失
      reasoningContent: reasoningContent ?? '',
    };
    if (history.continuationDropDiagnostic) {
      // 一次性诊断：只在追加时记录一次；不含推理正文、参数正文或签名，只记录身份与调用 id。
      this.#log('info', `[ContextWindow] ${history.continuationDropDiagnostic}`);
    } else if (history.continuation) {
      msg.continuation = history.continuation;
    }
    this.#messages.push(msg);
  }

  /**
   * 追加工具结果（必须紧跟 assistant toolCalls 后）
   * @param name 工具名
   * @param content 工具返回内容（已经过 ToolResultLimiter 截断）
   */
  appendToolResult(
    toolCallId: string,
    name: string,
    content: string,
    metadata?: { persistedSubmission?: boolean }
  ) {
    const historyMetadata = toolResultHistoryMetadata(metadata);
    this.#messages.push({
      role: 'tool',
      toolCallId,
      name,
      content,
      ...(historyMetadata ? { metadata: historyMetadata } : {}),
    });
  }

  /** 追加 assistant 纯文本消息（无工具调用） */
  appendAssistantText(
    text: string,
    reasoningContent?: string | null,
    continuation?: LlmContinuation
  ) {
    const msg: ContextMessage = {
      role: 'assistant',
      content: text,
    };
    if (reasoningContent != null) {
      msg.reasoningContent = reasoningContent;
    }
    if (continuation) {
      msg.continuation = structuredClone(continuation);
    }
    this.#messages.push(msg);
  }

  // ─── 压缩 API ─────────────────────────────────────────

  /**
   * 在每次 AI 调用前调用 — 根据 token 使用率同步执行 L1→L3 递进压缩（L4 另由 compactL4 异步处理）
   *
   * 递进策略（括号内为 DEFAULT_THRESHOLDS 缺省值）:
   *   L0: 不存在对应动作。thresholds[0] 当前不被读取；工具结果配额由 getToolResultQuota
   *       的独立固定阶梯（0.5/0.7/0.85/0.95）决定，与 thresholds 无关
   *   L1 (≥0.55): Snip — 截断旧 tool result
   *   L2 (≥0.70): Merge — 合并同角色消息、去重 submit 记录
   *   L3 (≥0.82): Collapse — 读时投影 (#collapseThreshold)
   *   L4 (≥0.92): Auto-compact — 需 LLM 调用，由 compactL4() 单独处理
   *
   * 单次调用可递进（如从 L1 升级到 L3），但不进入 L4（异步）。
   * 使用率按投影视图计算：L3 折叠后投影低于阈值时本方法是 no-op，
   * 直到新增轮次把投影重新推过阈值才会再次折叠。
   *
   * @returns 压缩结果 { level, removed }：level 为本次执行到的最高层级（0 表示用量未达 L1
   *   阈值或消息不超过 4 条）；removed 为各层累计处理条数——L1 截断的工具结果数 + L2 合并的
   *   消息数，L3 只移动投影边界、不计数
   */
  compactIfNeeded() {
    const [, t1, t2, t3] = this.#thresholds;
    // 融合 session 压力: 当 session 预算紧张时，即使 per-call usage 不高，
    // 也主动压缩以减少每轮 input token，延缓 session 累计增长。
    // 乘以 0.8 避免 session 一进入 70% 就立刻触发 L1。
    let usage = Math.max(this.getTokenUsageRatio(), this.#sessionPressure * 0.8);

    if (usage < t1 || this.#messages.length <= 4) {
      return { level: 0, removed: 0 };
    }

    // L1: Snip
    let result = this.#compactL1();
    usage = this.getTokenUsageRatio();
    if (usage < t2) {
      return result;
    }

    // L2: Merge
    const l2 = this.#compactL2Merge();
    result = { level: Math.max(result.level, l2.level), removed: result.removed + l2.removed };
    usage = this.getTokenUsageRatio();
    if (usage < t3) {
      return result;
    }

    // L3: Collapse (set threshold for read-time projection)
    const l3 = this.#compactL3Collapse();
    return { level: Math.max(result.level, l3.level), removed: result.removed + l3.removed };
  }

  /**
   * Provider-input budget projection — independent of the model's giant context window.
   *
   * DeepSeek/Gemini-scale contexts can delay normal ratio-based L3 collapse until after many
   * expensive turns. PCVM Package F needs a stage-level pressure signal that caps what the
   * provider sees, while preserving recent tool rounds and recorded finding refs.
   */
  compactForProviderInputBudget(
    options: ProviderInputBudgetOptions = {}
  ): ProviderInputBudgetResult {
    const { maxProjectedMessages, maxProjectedTokens } = resolveProviderInputBudgetLimits(options);
    const beforeMessageCount = this.toProjectedMessages().length;
    const beforeProjectedTokens = this.estimateProjectedTokens();
    const shouldCompact = isOverProviderInputBudget(
      beforeMessageCount,
      beforeProjectedTokens,
      options
    );

    if (!shouldCompact || this.#messages.length <= 4) {
      if (shouldCompact) {
        // 短路：超出阶段预算但消息不足 5 条，L1-L3 都无可压缩的历史轮次（严格单轮阶段常见），
        // 投影原样发送。返回结构保持 level=0/reason=null，只补一条诊断说明预算未被执行的原因。
        this.#log(
          'info',
          `[ContextWindow] provider input budget skipped: stageProfile=${options.stageProfile || 'generic'} messages=${beforeMessageCount}/${maxProjectedMessages} tokens≈${beforeProjectedTokens}/${maxProjectedTokens}; only ${this.#messages.length} message(s), no compactable history, projection sent unchanged`
        );
      }
      return {
        afterMessageCount: beforeMessageCount,
        afterProjectedTokens: beforeProjectedTokens,
        beforeMessageCount,
        beforeProjectedTokens,
        level: 0,
        reason: null,
        removed: 0,
      };
    }

    const l1 = this.#compactL1();
    const l2 = this.#compactL2Merge();
    const l3 = this.#compactL3Collapse();
    const afterMessageCount = this.toProjectedMessages().length;
    const afterProjectedTokens = this.estimateProjectedTokens();
    const level = Math.max(l1.level, l2.level, l3.level);
    const reason =
      options.reason ||
      `provider-input-budget:${options.stageProfile || 'generic'} messages=${beforeMessageCount}/${maxProjectedMessages} tokens=${beforeProjectedTokens}/${maxProjectedTokens}`;

    if (level > 0) {
      this.#compactionLog.push(
        `provider-input-budget: ${reason}; projected ${beforeProjectedTokens}->${afterProjectedTokens} tokens, ${beforeMessageCount}->${afterMessageCount} messages`
      );
      this.#log(
        'info',
        `[ContextWindow] provider input budget compact: ${reason} | ` +
          `tokens≈${beforeProjectedTokens}->${afterProjectedTokens}, ` +
          `messages=${beforeMessageCount}->${afterMessageCount}`
      );
    }

    return {
      afterMessageCount,
      afterProjectedTokens,
      beforeMessageCount,
      beforeProjectedTokens,
      level,
      reason,
      removed: l1.removed + l2.removed + l3.removed,
    };
  }

  /**
   * Check if L4 compaction is needed (async LLM summary).
   * Should be called by AgentRuntime after compactIfNeeded() when usage is still high.
   */
  needsL4Compaction(): boolean {
    const [, , , , t4] = this.#thresholds;
    return this.#enableL4LLM && this.getTokenUsageRatio() >= t4;
  }

  /**
   * L4 Auto-compact — LLM-based summary (async, called separately by AgentRuntime).
   *
   * 用结构化运行记忆替换旧协议历史；近期消息先进入 memory package。
   * 生成期间若上下文变化，旧摘要失效，不能覆盖新消息或新阶段。
   */
  async compactL4(
    aiProvider: {
      chatWithTools: (
        prompt: string,
        opts: Record<string, unknown>
      ) => Promise<{ text?: string; usage?: Record<string, unknown> }>;
    },
    opts: {
      memoryPackage?: L4MemoryPackage | L4MemoryPackageInput;
      abortSignal?: AbortSignal | null;
    } = {}
  ): Promise<{
    level: 4;
    removed: number;
    usage?: Record<string, unknown>;
    failed?: boolean;
    cancelled?: boolean;
    validationMissing?: string[];
  }> {
    const oldLen = this.#messages.length;
    if (oldLen <= 1) {
      return { level: 4, removed: 0 };
    }

    if (opts.abortSignal?.aborted) {
      this.#log('warn', '[ContextWindow] L4 compact skipped: abort signal already fired');
      return { level: 4, removed: 0, failed: true, cancelled: true };
    }

    const memoryPackage =
      opts.memoryPackage &&
      'kind' in opts.memoryPackage &&
      opts.memoryPackage.kind === 'l4_memory_package'
        ? opts.memoryPackage
        : buildL4MemoryPackage({
            goal: this.#messages[0]?.content || 'unknown',
            ...(opts.memoryPackage || {}),
            recentMessages:
              (opts.memoryPackage as L4MemoryPackageInput | undefined)?.recentMessages ||
              this.#messages.slice(1),
          });
    // distill 失败时包内只剩近期消息与原始回执，摘要质量明显下降；包本身无 logger，在这里留 warn。
    const distillFailure = memoryPackage.failureState.find((state) =>
      state.startsWith(`${L4_DISTILL_FAILED_STATE_KEY}=`)
    );
    if (distillFailure) {
      this.#log(
        'warn',
        `[ContextWindow] L4 memory package degraded: ActiveContext.distill() failed (${distillFailure}); ` +
          'key findings, plan, stats and distilled tool summary are empty, summary input falls back ' +
          'to recent messages and raw tool receipts'
      );
    }
    this.#log(
      'info',
      `[ContextWindow] L4 memory package ready: phase=${memoryPackage.phase}, ` +
        `findings=${memoryPackage.keyFindings.length}, evidenceRefs=${memoryPackage.evidenceRefs.length}, ` +
        `toolSummaries=${memoryPackage.toolResultSummary.length}, ` +
        `unresolvedQuestions=${Array.isArray(memoryPackage.unresolvedQuestions) ? memoryPackage.unresolvedQuestions.length : 0}, ` +
        `failureState=${memoryPackage.failureState.length}`
    );
    const originalMessages = JSON.stringify(this.#messages);
    const originalRevision = this.#readViewRevision;
    const renderedPackage = renderL4MemoryPackage(memoryPackage);
    // 校验器认可 finding id、失败状态的键/值/中文同义词；提示里要求原样保留这些锚点，
    // 让中文改写摘要不因措辞差异被误拒。未决问题另由 formatL4MemorySummary 确定性带过替换。
    const summaryPrompt = [
      '请将下面的 L4 Memory Package 压缩成稳定的运行记忆摘要。',
      '必须保留 phase、stageStatus、关键 finding、证据路径/行号、失败或降级状态和未决问题。',
      '原样保留 finding id（如 finding-1）、Failure / Degraded State 各行（如 degraded=true）和 Unresolved Questions 各条。',
      '不要新增事实，不要输出工具调用，不要引用原始 Chat Completions 协议消息。',
      '用中文输出，不超过 500 字；保留包中的英文 phase/status/path 原文。',
    ]
      .filter(Boolean)
      .join('\n');
    const summaryMessages = [
      { role: 'user', content: `${renderedPackage}\n\n${summaryPrompt}` },
    ] as unknown as ContextMessage[];

    try {
      const summary = await aiProvider.chatWithTools(summaryPrompt, {
        messages: summaryMessages,
        toolChoice: 'none',
        abortSignal: opts.abortSignal ?? undefined,
      });
      if (opts.abortSignal?.aborted) {
        this.#log('warn', '[ContextWindow] L4 compact result discarded after abort');
        return { level: 4, removed: 0, usage: summary.usage, failed: true, cancelled: true };
      }

      // toMessages 的公开原始视图也可能被修改，因此同时核对内容快照与资源视图版本。
      if (
        this.#readViewRevision !== originalRevision ||
        JSON.stringify(this.#messages) !== originalMessages
      ) {
        this.#log(
          'info',
          '[ContextWindow] L4 summary discarded: context changed during generation'
        );
        return {
          level: 4,
          removed: 0,
          usage: summary.usage,
          failed: true,
          validationMissing: ['context_changed'],
        };
      }

      const validation = validateL4Summary(summary.text, memoryPackage);
      if (!validation.ok) {
        this.#log(
          'warn',
          `[ContextWindow] L4 memory summary validation failed: ${validation.missing.join(', ')}`
        );
        this.#compactionLog.push(
          `L4: memory summary validation failed (${validation.missing.join(', ')})`
        );
        return {
          level: 4,
          removed: 0,
          usage: summary.usage,
          failed: true,
          validationMissing: validation.missing,
        };
      }

      this.#extractCompactedSubmits(1);
      const removed = Math.max(0, oldLen - 2);
      this.#messages = [
        this.#messages[0],
        {
          role: 'user',
          content: formatL4MemorySummary(summary.text || '', memoryPackage),
          metadata: {
            kind: 'l4_memory_summary',
            source: 'l4_memory_package/v1',
          },
        },
      ];
      this.#collapseThreshold = -1;
      this.#invalidateReadView('l4_summary');
      this.#compactionLog.push(`L4: memory package summary replaced ${removed} messages`);
      this.#log(
        'info',
        `[ContextWindow] L4 auto-compact: removed ${removed} messages, ` +
          `tokens≈${this.estimateTokens()}/${this.#tokenBudget}`
      );

      return { level: 4, removed, usage: summary.usage };
    } catch (err: unknown) {
      this.#log(
        'warn',
        `[ContextWindow] L4 auto-compact failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return { level: 4, removed: 0, failed: true };
    }
  }

  /**
   * L1 压缩: 截断旧轮次的工具结果内容。
   *
   * reasoning 管理由 SDK transport 处理；这里仅维护通用的消息原子性和配对。
   */
  #compactL1() {
    const TRUNCATE_THRESHOLD = 2000;
    const TRUNCATE_TO = 500;
    let truncated = 0;

    const lastRoundStart = this.#findLastToolRoundStart();
    if (lastRoundStart < 0) {
      return { level: 1, removed: 0 };
    }

    for (let i = 1; i < lastRoundStart; i++) {
      const msg = this.#messages[i];
      if (msg.role === 'tool' && msg.content && msg.content.length > TRUNCATE_THRESHOLD) {
        // A-1：纯头截断 → 首+尾保留，保住扫描类 result 尾部的错误汇总 / match 计数 /
        // 结尾结构；snipHeadTail 内部保证 head+marker+tail ≤ TRUNCATE_TO，跨周期幂等。
        msg.content = snipHeadTail(msg.content, TRUNCATE_TO, L1_SNIP_MARKER_TAG);
        truncated++;
      }
    }

    if (truncated > 0) {
      this.#invalidateReadView('l1_truncation');
      const afterTokens = this.estimateTokens();
      const ratio = this.getTokenUsageRatio();
      this.#log(
        'info',
        `[ContextWindow] L1 compact: truncated ${truncated} tool results | ` +
          `tokens≈${afterTokens}/${this.#tokenBudget} (${(ratio * 100).toFixed(1)}%)`
      );
    }
    return { level: 1, removed: truncated };
  }

  /**
   * L2 Merge: 合并连续同角色文本。工具调用与结果保留完整配对；同标题重试也有独立结果。
   */
  #compactL2Merge() {
    let merged = 0;
    let protectedPairs = 0;

    // Pass 1: merge consecutive same-role text messages (not tool messages)
    for (let i = this.#messages.length - 1; i >= 2; i--) {
      const curr = this.#messages[i];
      const prev = this.#messages[i - 1];
      if (
        i !== this.#collapseThreshold &&
        curr.role === prev.role &&
        curr.role !== 'tool' &&
        !curr.toolCalls &&
        !prev.toolCalls &&
        curr.content &&
        prev.content
      ) {
        // 续接提示绑定这一条消息的原始内容次序，不能合并后只留下其中一份提示。
        if (curr.continuation || prev.continuation || curr.metadata?.kind || prev.metadata?.kind) {
          protectedPairs++;
          continue;
        }
        prev.content = `${prev.content}\n---\n${curr.content}`;
        this.#messages.splice(i, 1);
        if (i < this.#collapseThreshold) {
          this.#collapseThreshold--;
        }
        merged++;
      }
    }

    if (protectedPairs > 0) {
      this.#log(
        'info',
        `[ContextWindow] L2 preserved ${protectedPairs} message pairs with continuation or runtime memory metadata; boundaries remain atomic`
      );
    }

    if (merged > 0) {
      this.#compactionLog.push(`L2-merge: merged ${merged} entries`);
      this.#log(
        'info',
        `[ContextWindow] L2 merge: ${merged} entries merged | ` +
          `tokens≈${this.estimateTokens()}/${this.#tokenBudget}`
      );
    }
    return { level: 2, removed: merged };
  }

  /**
   * L3 Collapse: 设置折叠阈值，使 toProjectedMessages() 返回折叠视图。
   * 原始消息保留不变 (toMessages() 仍返回完整数据)。
   */
  #compactL3Collapse() {
    const roundStarts = this.#findAllToolRoundStarts();
    if (roundStarts.length < 2) {
      return { level: 3, removed: 0 };
    }

    // Collapse everything before the last 2 rounds
    const keepFrom = roundStarts[roundStarts.length - 2];
    if (keepFrom <= 1) {
      return { level: 3, removed: 0 };
    }

    // 边界没有前移：投影不会变化。最近两轮本身就偏大时每轮都会走到这里，
    // 重复写日志、重复提取提交标题没有意义；折叠状态保持，仍报告 L3。
    if (keepFrom <= this.#collapseThreshold) {
      return { level: 3, removed: 0 };
    }

    const retainedTokens = this.estimateRetainedTokens();
    this.#invalidateReadView('l3_collapse');
    this.#extractCompactedSubmits(1, keepFrom);
    this.#collapseThreshold = keepFrom;
    this.#compactionLog.push(`L3-collapse: threshold set at index ${keepFrom}`);
    this.#log(
      'info',
      `[ContextWindow] L3 collapse: projection threshold at index ${keepFrom}, ` +
        `${this.#messages.length - keepFrom} messages visible in projection | ` +
        `provider-visible tokens≈${this.estimateTokens()}/${this.#tokenBudget}, ` +
        `retained history tokens≈${retainedTokens}`
    );
    return { level: 3, removed: 0 };
  }

  // ─── 查询 API ─────────────────────────────────────────

  /** 导出消息（供 AI Provider 使用 — 返回原始引用） */
  toMessages() {
    return this.#messages;
  }

  /**
   * 导出折叠后的消息视图（供 LLM 调用使用）。
   * 当 L3 collapse 激活时，将 #collapseThreshold 之前的消息
   * 折叠为一条摘要行，减少 token 消耗。
   * 当未激活时，返回原始消息。
   */
  toProjectedMessages(): ContextMessage[] {
    if (this.#collapseThreshold < 0) {
      return this.#messages;
    }
    if (this.#collapseThreshold >= this.#messages.length) {
      return this.#messages;
    }

    const collapsedRegion = this.#messages.slice(1, this.#collapseThreshold);
    const toolRounds = collapsedRegion.filter((m) => m.role === 'assistant' && m.toolCalls).length;
    const toolResults = collapsedRegion.filter((m) => m.role === 'tool').length;
    const submitTitles = [...this.#compactedSubmits];

    const summaryParts = [`[Collapsed: ${toolRounds} tool rounds, ${toolResults} results]`];
    if (submitTitles.length > 0) {
      summaryParts.push(`[Submitted: ${submitTitles.join(', ')}]`);
    }

    return [
      this.#messages[0],
      { role: 'user' as const, content: summaryParts.join('\n') },
      ...this.#messages.slice(this.#collapseThreshold),
    ];
  }

  /** 投影视图的 token 估算；与 estimateTokens() 同一口径，保留此名供既有调用方使用。 */
  estimateProjectedTokens(): number {
    return this.estimateTokens();
  }

  /** 获取消息数量 */
  get length() {
    return this.#messages.length;
  }

  /** 当前发给模型的 token 估算（阶段日志等只读观察面使用）。 */
  get tokenCount() {
    return this.estimateTokens();
  }

  /** 获取 token 预算 */
  get tokenBudget() {
    return this.#tokenBudget;
  }

  /**
   * 设置 session-level 预算压力（0-1）。
   * 影响 getToolResultQuota() 返回更保守的配额。
   * 由 AgentRuntime 在每轮迭代前根据 session token 消耗比例更新。
   *
   * 压力的唯一写入方是有会话预算的 BudgetController（used/max 在同一 loop 内单调不减），
   * 所以“从非零降到 0”只会来自无会话预算 loop 的显式清零。该值本身不对外暴露（不加 getter、
   * 不改返回类型），因此在这里记录清除前的原值，使工具配额与压缩时机的变化可追溯。
   */
  setSessionPressure(ratio: number) {
    const previous = this.#sessionPressure;
    const next = Math.max(0, Math.min(1, ratio));
    this.#sessionPressure = next;
    if (previous > 0 && next === 0) {
      this.#log(
        'info',
        `[ContextWindow] session pressure cleared (was ${(previous * 100).toFixed(1)}%); tool result quota and compaction now follow this window's own usage`
      );
    }
  }

  /**
   * 估算实际发送给 LLM 的 token 使用量——即投影视图（L3 折叠生效时不含被折叠的轮次）。
   *
   * SDK 续接块完整计数；旧 reasoningContent 也不能只计最近两轮，
   * 因为适配器可能仍需回传更早的内容。相同内容不与 replay 块重复计数。
   * 参数被压缩（或调用被截断）的轮次不保存续接，因此只计实际会回传的 reasoningContent，
   * 不再按已失效的续接 JSON 估算。
   */
  estimateTokens() {
    return this.#estimateMessagesTokens(this.toProjectedMessages());
  }

  /**
   * 估算保留的原始历史（含已折叠轮次）的 token 量。只用于诊断：它反映内存里留了多少
   * 历史，不代表模型看到的输入，不得用来决定配额或压缩。
   */
  estimateRetainedTokens() {
    return this.#estimateMessagesTokens(this.#messages);
  }

  #estimateMessagesTokens(messages: ContextMessage[]) {
    // 估算口径与 MessageAdapter 裸数组模式共用 estimateProviderHistoryTokens，诊断数值可直接对比。
    return estimateProviderHistoryTokens(messages);
  }

  /** 获取 token 使用率：发给模型的投影视图占预算的比例（可能大于 1）。 */
  getTokenUsageRatio() {
    return this.estimateTokens() / this.#tokenBudget;
  }

  /**
   * Full-context token estimation including system prompt and tool schemas.
   * Used for more accurate budget decisions.
   *
   * @param systemPromptChars - Character length of the system prompt
   * @param toolSchemaCount - Number of tool schemas in the current context
   */
  estimateFullContextTokens(systemPromptChars?: number, toolSchemaCount?: number): number {
    const messageTokens = this.estimateTokens();
    const promptTokens = systemPromptChars ? Math.ceil(systemPromptChars / 3.5) : 1500;
    const toolTokens = (toolSchemaCount ?? 0) * 100;
    return messageTokens + promptTokens + toolTokens;
  }

  /**
   * 获取动态工具结果配额 — 5 级预算阶梯。
   *
   * 综合 ContextWindow 使用率（投影视图口径）和 session-level 预算压力,
   * 取两者的较高值作为有效使用率。折叠后投影变小，配额随之恢复；
   * 会话预算紧张时仍由 sessionPressure 压低配额:
   *
   *   | 有效使用率 | 状态      | maxChars | maxMatches |
   *   |-----------|----------|----------|------------|
   *   | 0 - 50%   | Normal   | 6000     | 15         |
   *   | 50 - 70%  | Elevated | 3000     | 8          |
   *   | 70 - 85%  | High     | 1500     | 5          |
   *   | 85 - 95%  | Critical | 800      | 3          |
   *   | > 95%     | Exhausted| 400      | 2          |
   */
  getToolResultQuota() {
    const usage = this.getTokenUsageRatio();
    const effectiveUsage = Math.max(usage, this.#sessionPressure);

    if (effectiveUsage < 0.5) {
      return { maxChars: 6000, maxMatches: 15 };
    }
    if (effectiveUsage < 0.7) {
      return { maxChars: 3000, maxMatches: 8 };
    }
    if (effectiveUsage < 0.85) {
      return { maxChars: 1500, maxMatches: 5 };
    }
    if (effectiveUsage < 0.95) {
      return { maxChars: 800, maxMatches: 3 };
    }
    return { maxChars: 400, maxMatches: 2 };
  }

  /** 获取压缩日志（用于调试） */
  getCompactionLog() {
    return [...this.#compactionLog];
  }

  /** 获取被压缩掉的已提交候选标题 */
  getCompactedSubmits() {
    return new Set(this.#compactedSubmits);
  }

  /**
   * 清空消息 — 仅保留首条 prompt
   * 用于致命错误后的恢复
   */
  resetToPromptOnly() {
    this.#collapseThreshold = -1;
    if (this.#messages.length > 1) {
      this.#invalidateReadView('reset_to_prompt');
      // 提取所有已提交候选
      this.#extractCompactedSubmits(1);
      this.#messages.length = 1;
      this.#compactionLog.push(`RESET: cleared all messages except prompt`);
    }
  }

  /**
   * Pipeline 阶段隔离 — 清空全部消息。
   *
   * 用于 PipelineStrategy 在阶段间重置 ContextWindow：
   *   analyze → (reset) → produce
   *
   * reactLoop 会将新阶段的 prompt 追加为 messages[0]，
   * systemPrompt 通过 chatWithTools 参数独立传递，不受影响。
   *
   * 保留 compactedSubmits 以支持跨阶段提交去重。
   *
   * 同时清零 sessionPressure：压力只由有会话预算的 BudgetController 在预检时写入，
   * 无预算阶段（如 produce）复用同一窗口时没有任何写入点，上一阶段残留的高压会把
   * getToolResultQuota 压到最低档并让 compactIfNeeded 误触发 L1。有预算的新阶段会在
   * 首轮预检重新写入，不会丢失有效压力。清除前的原值写入 RESET_STAGE 日志以便追溯。
   */
  resetForNewStage() {
    this.#invalidateReadView('new_stage');
    this.#extractCompactedSubmits(0);
    this.#messages = [];
    this.#collapseThreshold = -1;
    const previousPressure = this.#sessionPressure;
    this.#sessionPressure = 0;
    const pressureNote = `session pressure cleared (was ${(previousPressure * 100).toFixed(1)}%)`;
    this.#compactionLog.push(
      `RESET_STAGE: cleared all messages for new pipeline stage; ${pressureNote}`
    );
    if (previousPressure > 0) {
      this.#log('info', `[ContextWindow] stage reset: ${pressureNote}`);
    }
  }

  /**
   * 从消息中提取已提交候选到 compactedSubmits
   * @param fromIdx 从哪个索引开始扫描
   */
  #extractCompactedSubmits(fromIdx: number, toIdx = this.#messages.length) {
    let unconfirmed = 0;
    for (let i = fromIdx; i < toIdx; i++) {
      const message = this.#messages[i];
      if (message.role !== 'assistant' || !message.toolCalls) {
        continue;
      }
      for (const call of message.toolCalls) {
        if (call.name !== 'knowledge' || call.args?.action !== 'submit') {
          continue;
        }
        let confirmed = false;
        for (let j = i + 1; j < this.#messages.length && this.#messages[j].role === 'tool'; j++) {
          const result = this.#messages[j];
          if (result.toolCallId !== call.id) {
            continue;
          }
          if (typeof result.metadata?.persistedSubmission === 'boolean') {
            confirmed = result.metadata.persistedSubmission;
            break;
          }
          try {
            confirmed = isPersistedSubmission({
              tool: call.name,
              args: call.args,
              result: JSON.parse(result.content || ''),
            });
          } catch (err: unknown) {
            if (!(err instanceof SyntaxError)) {
              this.#log(
                'warn',
                '[ContextWindow] receipt inspection failed; title remains unconfirmed'
              );
            }
            // 显示文本或被裁剪的 JSON 无法证明持久化，不得凭请求标题宣称已提交。
            confirmed = false;
          }
          break;
        }
        if (confirmed) {
          this.#compactedSubmits.add(getKnowledgeToolCallLabel(call.args));
        } else {
          unconfirmed++;
        }
      }
    }
    if (unconfirmed > 0) {
      this.#log(
        'info',
        `[ContextWindow] ${unconfirmed} unconfirmed submit title(s) excluded from retained history`
      );
    }
  }

  // ─── 内部方法 ──────────────────────────────────────────

  #log(level: 'info' | 'warn', message: string): void {
    observeSafely(
      () => this.#logger[level](message),
      () => undefined
    );
  }

  /**
   * 找到最后一个 assistant(toolCalls) 的位置
   * @returns 位置索引，-1 表示找不到
   */
  #findLastToolRoundStart() {
    for (let i = this.#messages.length - 1; i >= 1; i--) {
      if (
        this.#messages[i].role === 'assistant' &&
        (this.#messages[i].toolCalls?.length ?? 0) > 0
      ) {
        return i;
      }
    }
    return -1;
  }

  /** 找到所有 assistant(toolCalls) 的位置（按顺序） */
  #findAllToolRoundStarts() {
    const starts: number[] = [];
    for (let i = 1; i < this.#messages.length; i++) {
      if (
        this.#messages[i].role === 'assistant' &&
        (this.#messages[i].toolCalls?.length ?? 0) > 0
      ) {
        starts.push(i);
      }
    }
    return starts;
  }
}

// ─── provider 历史语义纯函数（ContextWindow 与 MessageAdapter 裸数组模式共用）────────
// 只在 context 层按名导出，不进入 `@alembic/agent/context` 公开子路径（index.ts 是按名导出，不含这些）。
// 两种消息存储必须给模型同一份历史语义：只保留最新 runtime nudge、knowledge submit 参数按 provider
// 历史压缩并同步处理续接、工具结果元数据只留布尔 persistedSubmission、token 估算与阶段预算默认值同一口径。

const RUNTIME_NUDGE_KIND = 'runtime_nudge';
/** 阶段未给上限时的 provider 输入预算默认值（与历史 compactForProviderInputBudget 默认一致）。 */
const DEFAULT_PROVIDER_INPUT_MAX_MESSAGES = 44;
const DEFAULT_PROVIDER_INPUT_MAX_TOKENS = 16_000;

/** 构造运行时 nudge：metadata.kind 让下一次 nudge 能识别并替换它；provider 序列化不读取 metadata。 */
export function createRuntimeNudgeMessage(content: string): {
  role: 'user';
  content: string;
  metadata: { kind: typeof RUNTIME_NUDGE_KIND };
} {
  return { role: 'user', content, metadata: { kind: RUNTIME_NUDGE_KIND } };
}

/**
 * 移除历史中已过期的 runtime nudge，返回新数组，不改入参。
 * 首条消息（原始 prompt）永远保留；collapseThreshold 是 L3 折叠边界的绝对索引（-1 表示未折叠），
 * removedBeforeCollapse 供调用方前移边界，避免额外隐藏仍可见的工具调用。
 */
export function dropStaleRuntimeNudges<T extends { metadata?: { kind?: unknown } }>(
  messages: readonly T[],
  collapseThreshold = -1
): { kept: T[]; removed: number; removedBeforeCollapse: number } {
  let removed = 0;
  let removedBeforeCollapse = 0;
  const kept = messages.filter((message, index) => {
    if (index === 0 || message.metadata?.kind !== RUNTIME_NUDGE_KIND) {
      return true;
    }
    removed++;
    if (index < collapseThreshold) {
      removedBeforeCollapse++;
    }
    return false;
  });
  return { kept, removed, removedBeforeCollapse };
}

/** prepareToolCallsForProviderHistory 的结果：写入历史的调用、可保留的续接与一次性诊断文本。 */
export interface ProviderHistoryToolCalls {
  toolCalls: ToolCallInfo[];
  /** 可写入历史的续接（已 structuredClone）；参数被改写或本来就没有续接时为 undefined。 */
  continuation: LlmContinuation | undefined;
  /** 参数被实际改写的调用 id（目前只有 knowledge submit）。 */
  rewrittenCallIds: string[];
  /** 续接因参数改写被丢弃时的诊断正文（不含推理、参数正文或签名），调用方加前缀后记一次日志。 */
  continuationDropDiagnostic: string | null;
}

/**
 * 把本轮工具调用整理成 provider 历史形状：knowledge submit 只保留标识字段，其余调用原样保留。
 *
 * 跨层契约：续接的 projectionHash 由 Transport 按捕获时的完整工具参数计算。参数被改写后，
 * 回放必然判 projection_binding_changed，且该消息常驻历史，会在之后每次请求重复告警并丢推理。
 * 谁改写投影谁处理续接：这里直接不保存续接（原生签名/回放块随之放弃），调用方保留 reasoningContent
 * （DeepSeek 推理是未签名文本，可独立回传），并剥离调用上的 Gemini thoughtSignature——签名绑定
 * 改写前的投影，被拒时本来也不会发送，这一轮按无签名历史发送（与改写前的实际请求一致）。
 */
export function prepareToolCallsForProviderHistory(
  toolCalls: readonly ToolCallInfo[],
  continuation?: LlmContinuation
): ProviderHistoryToolCalls {
  const historyCalls = toolCalls.map(compactToolCallForProviderHistory);
  // compactToolCallForProviderHistory 只在 knowledge submit 时返回新的 args 对象；
  // 引用变化即“参数被实际改写”，其余工具（含 knowledge 非 submit 动作）原样保留。
  const rewrittenCallIds = historyCalls
    .filter((call, index) => call.args !== toolCalls[index]?.args)
    .map((call) => call.id);
  if (continuation && rewrittenCallIds.length > 0) {
    return {
      toolCalls: historyCalls.map(withoutThoughtSignature),
      continuation: undefined,
      rewrittenCallIds,
      continuationDropDiagnostic: `continuation_dropped reason=compacted_args provider=${continuation.provider} model=${continuation.model} kind=${continuation.kind} callIds=${formatCallIds(rewrittenCallIds)}; tool-call args compacted for provider history, native continuation discarded, reasoningContent retained, thought signatures omitted`,
    };
  }
  return {
    toolCalls: historyCalls,
    continuation: continuation ? structuredClone(continuation) : undefined,
    rewrittenCallIds,
    continuationDropDiagnostic: null,
  };
}

/**
 * 工具结果写入历史时只保留 Runtime 已确认的布尔 persistedSubmission；其它字段或非布尔值不进历史，
 * 提交标题提取（#extractCompactedSubmits）因此只信任这一种确认来源。
 */
export function toolResultHistoryMetadata(metadata?: {
  persistedSubmission?: unknown;
}): { persistedSubmission: boolean } | undefined {
  return typeof metadata?.persistedSubmission === 'boolean'
    ? { persistedSubmission: metadata.persistedSubmission }
    : undefined;
}

/**
 * provider 可见历史的 token 估算（ContextWindow 的唯一口径，裸数组适配器同样使用）。
 * 入参按未知形状防御读取：非对象消息跳过，只计 content、未被回放块覆盖的 reasoningContent、
 * 续接 JSON 与工具调用 JSON。
 */
export function estimateProviderHistoryTokens(messages: readonly unknown[]): number {
  let total = 0;
  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    const { content, reasoningContent, continuation, toolCalls } = message;
    if (typeof content === 'string' && content) {
      total += estimateTokensFast(content);
    }
    const continuationKind = isRecord(continuation) ? continuation.kind : undefined;
    if (
      typeof reasoningContent === 'string' &&
      reasoningContent &&
      continuationKind !== 'content-replay-v1'
    ) {
      total += estimateTokensFast(reasoningContent);
    }
    if (continuation) {
      total += estimateTokensFast(JSON.stringify(continuation));
    }
    if (toolCalls) {
      total += estimateTokensFast(JSON.stringify(toolCalls));
    }
  }
  return total;
}

/** 解析阶段 provider 输入预算上限；未给出的上限取默认值。 */
export function resolveProviderInputBudgetLimits(options: ProviderInputBudgetOptions = {}): {
  maxProjectedMessages: number;
  maxProjectedTokens: number;
} {
  return {
    maxProjectedMessages: options.maxProjectedMessages ?? DEFAULT_PROVIDER_INPUT_MAX_MESSAGES,
    maxProjectedTokens: options.maxProjectedTokens ?? DEFAULT_PROVIDER_INPUT_MAX_TOKENS,
  };
}

/** 投影是否超出阶段 provider 输入预算（消息数或 token 任一超限）。 */
export function isOverProviderInputBudget(
  messageCount: number,
  projectedTokens: number,
  options: ProviderInputBudgetOptions = {}
): boolean {
  const { maxProjectedMessages, maxProjectedTokens } = resolveProviderInputBudgetLimits(options);
  return messageCount > maxProjectedMessages || projectedTokens > maxProjectedTokens;
}

/** 运行时调用对象可能携带 Gemini thoughtSignature（ToolCallInfo 未声明该字段）；丢弃续接时一并剥离。 */
function withoutThoughtSignature(call: ToolCallInfo): ToolCallInfo {
  const { thoughtSignature: _signature, ...rest } = call as ToolCallInfo & {
    thoughtSignature?: unknown;
  };
  return rest;
}

/** 诊断里的调用 id 列表封顶，避免单轮大量调用撑爆日志行。 */
function formatCallIds(ids: string[]): string {
  const shown = ids.slice(0, 8).join(',');
  return ids.length > 8 ? `${shown},+${ids.length - 8}` : shown;
}

function compactToolCallForProviderHistory(call: ToolCallInfo): ToolCallInfo {
  if (call.name !== 'knowledge') {
    return call;
  }
  return {
    ...call,
    args: compactKnowledgeArgsForProviderHistory(call.args),
  };
}

function compactKnowledgeArgsForProviderHistory(
  args: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!args) {
    return args;
  }
  const action = typeof args.action === 'string' ? args.action : null;
  if (action !== 'submit') {
    return args;
  }
  const params = isRecord(args.params) ? args.params : args;
  const compactParams = pickDefined({
    category: params.category,
    dimensionId: params.dimensionId,
    kind: params.kind,
    knowledgeType: params.knowledgeType,
    source: params.source,
    supersedes: params.supersedes,
    title: params.title,
    trigger: params.trigger,
  });
  return {
    action,
    params: compactParams,
    payloadSummary: buildSubmitPayloadSummary(params),
    providerHistoryCompacted: true,
  };
}

function buildSubmitPayloadSummary(params: Record<string, unknown>): Record<string, unknown> {
  return {
    contentOmittedForProviderHistory: true,
    omittedFields: [
      'description',
      'content',
      'whenClause',
      'doClause',
      'dontClause',
      'coreCode',
      'reasoning',
    ],
    requiredFieldsComplete: hasCompleteSubmitPayload(params),
    sourceCount: submitSourceCount(params),
  };
}

function hasCompleteSubmitPayload(params: Record<string, unknown>): boolean {
  const content = isRecord(params.content) ? params.content : {};
  const reasoning = isRecord(params.reasoning) ? params.reasoning : {};
  const sources = Array.isArray(reasoning.sources) ? reasoning.sources : [];
  return Boolean(
    stringValue(params.title) &&
      stringValue(params.description) &&
      stringValue(params.kind) &&
      stringValue(params.trigger) &&
      stringValue(params.whenClause) &&
      stringValue(params.doClause) &&
      stringValue(content.markdown) &&
      stringValue(content.rationale) &&
      sources.some((source) => typeof source === 'string' && source.trim())
  );
}

function submitSourceCount(params: Record<string, unknown>): number {
  const reasoning = isRecord(params.reasoning) ? params.reasoning : {};
  const sources = Array.isArray(reasoning.sources) ? reasoning.sources : [];
  return sources.filter((source) => typeof source === 'string' && source.trim()).length;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getKnowledgeToolCallLabel(args: Record<string, unknown> | undefined): string {
  if (!args) {
    return 'untitled';
  }
  const params = isRecord(args.params) ? args.params : args;
  const value = params.title || params.category || params.trigger || 'untitled';
  return typeof value === 'string' && value.trim() ? value.trim() : 'untitled';
}

function pickDefined(values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') {
      result[key] = value;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─── 首+尾截断公共逻辑（A-1 / A-1b 共用）────────────────
// 1. 与 read 入口 clampReadResult(code.ts) 首+尾思路一致，但 marker 文本必须不同
//    （compaction snip / tool-result snip ≠ batch read budget），使两层有损截断可区分。
// 2. 幂等硬约束：budget=TRUNCATE_TO(500) 时 keepHead+marker.length+safeTail ≤ budget，
//    使重写结果落回 TRUNCATE_THRESHOLD(2000) 之下，跨周期不二次截断、不吃刚保留的尾部。
// 3. 比例按 budget 切（CG-2：80%/15% of 500），不按原文长度切。

/** L1 压缩层 marker 词根 —— 与 read 入口 / limit 层均不同 */
const L1_SNIP_MARKER_TAG = 'compaction snip';
/** limit 层 marker 词根 —— 与 read 入口 / L1 层均不同 */
const LIMIT_SNIP_MARKER_TAG = 'tool-result snip';

/**
 * 把长字符串截断为 head + 独立 marker + tail，并保证幂等：
 * keepHead + marker.length + safeTail ≤ budget。
 *
 * 对抗修正#2（FOLD）：原规格注释把不变量写成"任意原文长度恒成立"，实测仅在
 * budget ≳ 340 成立——小 budget 下 keepHead(0.8·budget)+marker 已超界、safeTail
 * 夹 0 仍超。此处采用更稳实现：overflow 优先收缩 safeTail，仍超则继续收缩 keepHead，
 * 使界在任意 budget 下真正无条件成立（不依赖外部 MIN_TOOL_CHARS floor）。
 *
 * 注：keepTail 改用 const（规格示例为 let，但本仓 biome useConst=error 且 keepTail 从不重赋值，
 * 仅 keepHead/safeTail/overflow 重赋值保留 let），行为与规格逐字一致。
 */
function snipHeadTail(text: string, budget: number, tag: string): string {
  let keepHead = Math.floor(budget * 0.8); // CG-2：头 80%
  const keepTail = Math.floor(budget * 0.15); // CG-2：尾 15%
  const omitted = text.length - keepHead - keepTail;
  // marker 含原文长度与省略数（便于审计），用真实 marker.length 入预算。
  const marker = `\n... [${tag}: ${omitted} of ${text.length} chars omitted] ...\n`;
  // 幂等守卫：先收缩 safeTail；若 keepHead+marker 仍超 budget，再收缩 keepHead，
  // 保证 keepHead+marker.length+safeTail ≤ budget 在任意 budget 下成立。
  let safeTail = keepTail;
  let overflow = keepHead + marker.length + safeTail - budget;
  if (overflow > 0) {
    const tailCut = Math.min(safeTail, overflow);
    safeTail -= tailCut;
    overflow -= tailCut;
  }
  if (overflow > 0) {
    keepHead = Math.max(0, keepHead - overflow);
  }
  // 若保留量已覆盖原文，不做截断（避免把短串放大）。
  if (keepHead + safeTail >= text.length) {
    return text;
  }
  const head = text.slice(0, keepHead);
  const tail = safeTail > 0 ? text.slice(-safeTail) : '';
  return `${head}${marker}${tail}`;
}

// ─── ToolResultLimiter ──────────────────────────────────

/**
 * 工具结果入口限制器 — 在工具结果进入 ContextWindow 前压缩
 *
 * @param toolName 工具名
 * @param result 工具原始返回
 * @param quota 动态配额
 * @returns 压缩后的结果字符串
 */
/**
 * P1-A F1(挖掘质量升级)：证据尾注抗截断。
 * `[evidence] E-n=file:range` 尾注是模型引用台账的唯一投递通道；此前它随正文一起被
 * head+tail/纯头截断——窗口压力 ≥0.95 档 per-tool 配额塌到 400 字时尾注整段被吞，
 * 模型引用不到台账 → findings 全 unverified → 产出坍缩(E2E 首跑实证的生产级隐患)。
 * 修法：截断前摘下尾注，正文按剩余预算走原截断逻辑，尾注原样重挂(封顶 800 字防病态)。
 * 尾注只有 ~200 字，任何配额档都保得起；确定性修复，全 provider 生效。
 */
const EVIDENCE_TAIL_RE = /\n\n\[evidence\] [^\n]*$/;

export function limitToolResult(toolName: string, result: unknown, quota: ToolResultQuota) {
  if (typeof result === 'string') {
    const tailMatch = result.match(EVIDENCE_TAIL_RE);
    if (tailMatch) {
      const annotation =
        tailMatch[0].length > 800 ? `${tailMatch[0].slice(0, 800)}…` : tailMatch[0];
      const body = result.slice(0, result.length - tailMatch[0].length);
      const bodyQuota = Math.max(200, (quota.maxChars ?? 4000) - annotation.length);
      const limitedBody = limitToolResultBody(toolName, body, { ...quota, maxChars: bodyQuota });
      return `${typeof limitedBody === 'string' ? limitedBody : JSON.stringify(limitedBody)}${annotation}`;
    }
  }
  return limitToolResultBody(toolName, result, quota);
}

function limitToolResultBody(toolName: string, result: unknown, quota: ToolResultQuota) {
  const { maxChars = 4000, maxMatches = 10 } = quota;

  // knowledge (submit) 结果很短，不截断
  if (toolName === 'knowledge') {
    const raw = typeof result === 'string' ? result : JSON.stringify(result);
    // 刻意保持纯头：knowledge.submit 回显短、尾部无高信号，500 字硬上限只为防超长回显（A-1b 不改此处）。
    return raw.length > 500 ? raw.substring(0, 500) : raw;
  }

  // code 工具: 区分搜索结果、文件内容、其他操作
  if (toolName === 'code') {
    // V2 纯文本搜索结果: "N matches (showing M)\n\n..."（尾部常含 "showing M of N" 汇总）
    if (typeof result === 'string' && /^\d+ matches/.test(result)) {
      // A-1b：纯头 → 首+尾，保住搜索结果尾部的汇总行；marker=LIMIT_SNIP_MARKER_TAG。
      return result.length > maxChars
        ? snipHeadTail(result, maxChars, LIMIT_SNIP_MARKER_TAG)
        : result;
    }

    // V1 结构化搜索结果 (兼容)
    if (
      typeof result === 'object' &&
      result !== null &&
      ((result as SearchResultLike).matches || (result as SearchResultLike).batchResults)
    ) {
      if ((result as SearchResultLike).batchResults) {
        const source = result as SearchResultLike;
        const limited: SearchResultLike = { ...source, batchResults: { ...source.batchResults } };
        const batchResults = limited.batchResults ?? {};
        for (const [key, sub] of Object.entries(batchResults)) {
          batchResults[key] = limitSearchResultObj(sub, Math.min(maxMatches, 3));
        }
        const raw = JSON.stringify(limited);
        // A-1b：V1 batch 搜索纯头 → 首+尾；marker=LIMIT_SNIP_MARKER_TAG。
        return raw.length > maxChars ? snipHeadTail(raw, maxChars, LIMIT_SNIP_MARKER_TAG) : raw;
      }
      return limitSearchResult(result, maxMatches, maxChars);
    }

    // batchResults 已在上面统一处理；这里只剩单个文件内容。
    return limitFileContent(result, maxChars);
  }

  // 通用: 按字符限制
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  if (raw.length > maxChars) {
    // A-1b：通用字符串纯头 → 首+尾；marker=LIMIT_SNIP_MARKER_TAG。
    return snipHeadTail(raw, maxChars, LIMIT_SNIP_MARKER_TAG);
  }
  return raw;
}

/**
 * 限制搜索结果 — 只保留 topN 匹配，每个匹配的 context 截断
 *
 * code (search) 返回格式:
 *   { matches: [{ file, line, code, context, score }], total, searchedFiles }
 */
function limitSearchResult(result: unknown, maxMatches: number, maxChars: number) {
  if (typeof result === 'string') {
    return result.length > maxChars ? `${result.substring(0, maxChars)}\n... [truncated]` : result;
  }

  if (!result || typeof result !== 'object') {
    return JSON.stringify(result || {});
  }

  // 深拷贝避免修改原对象
  const src = result as SearchResultLike;
  const limited: SearchResultLike = { ...src };
  if (Array.isArray(limited.matches)) {
    limited.matches = limited.matches.slice(0, maxMatches).map((m: SearchMatch) => {
      const copy: SearchMatch = { ...m };
      // 截断每个匹配的 context 字段（多行文本）
      if (copy.context && typeof copy.context === 'string') {
        const contextLines = copy.context.split('\n');
        if (contextLines.length > 7) {
          copy.context = `${contextLines.slice(0, 7).join('\n')}\n... [truncated]`;
        }
      }
      // 兼容旧格式: 也处理 lines 数组
      if (Array.isArray(copy.lines) && copy.lines.length > 5) {
        copy.lines = copy.lines.slice(0, 5);
        copy._truncated = true;
      }
      return copy;
    });
    if ((src.matches?.length ?? 0) > maxMatches) {
      limited._note = `Showing ${maxMatches} of ${src.matches?.length ?? 0} matches`;
    }
  }

  const str = JSON.stringify(limited);
  if (str.length > maxChars) {
    return `${str.substring(0, maxChars)}\n... [truncated]`;
  }
  return str;
}

/**
 * 限制搜索结果（返回对象） — 用于批量模式，避免 JSON.stringify → JSON.parse 往返
 * 当源码含控制字符时，stringify→substring 截断会破坏 JSON 结构导致 parse 失败
 */
function limitSearchResultObj(result: unknown, maxMatches: number): SearchResultLike {
  if (!result || typeof result !== 'object') {
    return (result || {}) as SearchResultLike;
  }

  const src = result as SearchResultLike;
  const limited: SearchResultLike = { ...src };
  if (Array.isArray(limited.matches)) {
    limited.matches = limited.matches.slice(0, maxMatches).map((m: SearchMatch) => {
      const copy: SearchMatch = { ...m };
      if (copy.context && typeof copy.context === 'string') {
        const contextLines = copy.context.split('\n');
        if (contextLines.length > 7) {
          copy.context = `${contextLines.slice(0, 7).join('\n')}\n... [truncated]`;
        }
        // 按字符上限截断 context（防止单个代码块过大）
        if (copy.context.length > 500) {
          copy.context = `${copy.context.substring(0, 500)}\n... [truncated]`;
        }
      }
      if (Array.isArray(copy.lines) && copy.lines.length > 5) {
        copy.lines = copy.lines.slice(0, 5);
        copy._truncated = true;
      }
      return copy;
    });
    if ((src.matches?.length ?? 0) > maxMatches) {
      limited._note = `Showing ${maxMatches} of ${src.matches?.length ?? 0} matches`;
    }
  }
  return limited;
}

/** 限制文件内容 — 截断 content 字段（A-1b：纯头 → 首+尾，整行边界保住 imports/exports/收尾结构） */
function limitFileContent(result: unknown, maxChars: number) {
  if (typeof result === 'string') {
    return result.length > maxChars
      ? snipHeadTail(result, maxChars, LIMIT_SNIP_MARKER_TAG)
      : result;
  }

  if (!result || typeof result !== 'object') {
    return JSON.stringify(result || {});
  }

  const src = result as FileResultLike;
  const limited: FileResultLike = { ...src };
  if (limited.content && limited.content.length > maxChars) {
    // A-1b：文件内容保留尾部整行（尾部常是 imports/exports/收尾结构），头 80% / 尾 15% 字符预算。
    // 刻意不复用 snipHeadTail：在整行边界切，保 JSON-内嵌源码可读性；marker tag 与 limit 层一致。
    const headBudget = Math.floor(maxChars * 0.8);
    const tailBudget = Math.floor(maxChars * 0.15);
    const lines = limited.content.split('\n');
    let head = '';
    for (const line of lines) {
      if (head.length + line.length + 1 > headBudget) {
        break;
      }
      head += `${line}\n`;
    }
    let tail = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (tail.length + line.length + 1 > tailBudget) {
        break;
      }
      tail = `${line}\n${tail}`;
    }
    const omitted = src.content?.length ?? 0;
    limited.content = `${head}... [${LIMIT_SNIP_MARKER_TAG}: file content truncated, total ${omitted} chars] ...\n${tail}`;
  }

  return JSON.stringify(limited);
}
