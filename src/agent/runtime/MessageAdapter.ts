import type { LlmContinuation } from '#ai/contracts.js';
/**
 * MessageAdapter — 统一消息操作接口
 *
 * 消除 reactLoop 内的 useCtxWin 双模式分支:
 *   - ContextWindowAdapter: 委托给 ContextWindow 实例 (bootstrap/system 场景)
 *   - SimpleArrayAdapter: 裸数组模式 (对话场景)
 *
 * 两个实现对外暴露相同的 API，并共享 context 层的消息语义纯函数（ContextWindow.ts）：
 * runtime nudge 只保留最新一条、knowledge submit 参数按 provider 历史压缩（同步处理续接）、
 * 工具结果元数据只留布尔 persistedSubmission、toMessages 返回快照、token 估算同一口径。
 * 差异只在压缩能力：裸数组模式不压缩，provider 输入预算只如实测量并在超限时告警。
 * 这样 reactLoop 及其提取方法无需关心底层消息存储方式。
 *
 * 兼容成员（I49）：formatToolResult、getToolResultQuota、compactIfNeeded 与
 * ContextWindowAdapter.contextWindow getter 经 @alembic/agent/runtime 公开，但运行时不使用——
 * 工具结果配额走 BudgetController + projectToolReceipt，常规压缩走 BudgetController → ContextWindow，
 * 强制摘要不读上下文窗口。它们已标为废弃（deprecated 标签），随待决事项②“公开面收窄”删除。
 *
 * @module agent/runtime/MessageAdapter
 */

import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { isToolResultEnvelope } from '#tools/kernel/index.js';
import type { ContextWindow, ToolCallInfo } from '../context/ContextWindow.js';
import {
  createRuntimeNudgeMessage,
  dropStaleRuntimeNudges,
  estimateProviderHistoryTokens,
  isOverProviderInputBudget,
  limitToolResult,
  prepareToolCallsForProviderHistory,
  resolveProviderInputBudgetLimits,
  toolResultHistoryMetadata,
} from '../context/ContextWindow.js';
import { readRejectedEnvelopeText, TOOL_ENVELOPE_SHAPE_REJECTED } from './toolReceipt.js';

export interface ProviderInputBudgetProjection {
  afterMessageCount: number;
  afterProjectedTokens: number;
  beforeMessageCount: number;
  beforeProjectedTokens: number;
  level: number;
  reason: string | null;
  removed: number;
}

/** 工具调用记录 */
interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** 聊天消息（裸数组模式；形状与 ContextWindow 的 ContextMessage 对齐） */
interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoningContent?: string | null;
  continuation?: LlmContinuation;
  /** provider 历史形状：knowledge submit 参数已压缩，args 可能被改写。 */
  toolCalls?: ToolCallInfo[];
  toolCallId?: string;
  name?: string;
  /** kind 只标记 runtime nudge（供下一次 nudge 替换）；persistedSubmission 只接受布尔值。 */
  metadata?: { persistedSubmission?: boolean; kind?: 'runtime_nudge' };
}

// ─────────────────────────────────────────────
//  Base class (接口定义 + JSDoc)
// ─────────────────────────────────────────────

/**
 * 消息适配器基类（概念上的抽象类）。
 *
 * 目前是普通 class：未覆盖的方法在运行时抛 'not implemented'，tsc 不会提示子类漏实现。
 * 改为 TypeScript abstract class 会让外部 `new MessageAdapter()` 变成编译错误，属于公开面变更，
 * 随待决事项②“公开面收窄”处理；在此之前新增子类必须覆盖全部 throw 'not implemented' 的方法。
 *
 * @abstract
 */
export class MessageAdapter {
  #readViewRevision = 0;

  get readViewRevision(): number {
    return this.#readViewRevision;
  }

  /** 工具结果进入历史前已被配额裁剪时，也必须失效当前已读视图。 */
  invalidateReadView(): void {
    this.#readViewRevision++;
  }

  /** 追加用户消息 */
  appendUserMessage(_text: string) {
    throw new Error('not implemented');
  }

  /** 追加助手纯文本回复 */
  appendAssistantText(
    _text: string,
    _reasoningContent?: string | null,
    _continuation?: LlmContinuation
  ) {
    throw new Error('not implemented');
  }

  /**
   * 追加助手带工具调用的回复
   * @param _calls functionCalls 数组
   * @param _reasoningContent DeepSeek V4 推理内容（可选）
   */
  appendAssistantWithToolCalls(
    _text: string | null,
    _calls: ToolCallRecord[],
    _reasoningContent?: string | null,
    _continuation?: LlmContinuation
  ) {
    throw new Error('not implemented');
  }

  /** 追加工具执行结果 */
  appendToolResult(
    _callId: string,
    _name: string,
    _content: string,
    _metadata?: { persistedSubmission?: boolean }
  ) {
    throw new Error('not implemented');
  }

  /** 追加系统/用户 nudge 消息 */
  appendUserNudge(_text: string) {
    throw new Error('not implemented');
  }

  /**
   * 导出当前消息列表的快照（浅拷贝数组）。
   * 调用方对返回数组的 push/splice/排序不影响适配器内部历史；消息对象本身仍是共享引用，不得原地修改。
   */
  toMessages(): unknown[] {
    throw new Error('not implemented');
  }

  /**
   * 导出压缩后的消息列表 (L3 collapse 读时投影)
   * 默认等同于 toMessages()；ContextWindowAdapter 会使用 toProjectedMessages 投影。
   */
  toProjectedMessages(): unknown[] {
    return this.toMessages();
  }

  /**
   * 错误恢复：仅保留首条消息，其余历史清空。
   * 注意首条不一定是本次任务 prompt：AgentRuntime 先追加 history 再追加 prompt，
   * 有 history 时保留的是 history 首条（无 history 时才是本次 prompt）。
   */
  resetToPromptOnly() {
    throw new Error('not implemented');
  }

  /**
   * 获取工具结果限额。
   * @deprecated 兼容保留、运行时不使用：真实工具结果配额由 BudgetController + projectToolReceipt 处理。
   *   随待决事项②“公开面收窄”删除。
   * @returns `{ maxChars, maxMatches }` 单次工具结果的字符与匹配条数上限
   */
  getToolResultQuota(): { maxChars: number; maxMatches: number } {
    throw new Error('not implemented');
  }

  /**
   * 压缩检查 — 如果消息过多则自动压缩。
   * @deprecated 兼容保留、运行时不使用：常规压缩由 BudgetController 直接调用 ContextWindow.compactIfNeeded。
   *   随待决事项②“公开面收窄”删除。
   * @returns `{ level, removed }` 本次触发的压缩级别（0 表示未压缩）与移除的消息数
   */
  compactIfNeeded(): { level: number; removed: number } {
    throw new Error('not implemented');
  }

  /**
   * 阶段 provider 输入预算投影 — 无压缩能力的适配器（基类默认实现，SimpleArrayAdapter 沿用）。
   *
   * 不压缩，但必须如实测量：token 与 ContextWindow 同一口径（estimateProviderHistoryTokens），
   * 不能写 0 冒充“测得很小”。超出阶段预算时返回 reason='adapter-without-compaction:<stageProfile>'
   * 并记 warn，说明预算未被执行、投影原样发送；level 恒为 0、removed 恒为 0。
   * opts.reason 只对能压缩的窗口有意义（覆盖压缩原因文本），这里不采用。
   */
  compactForProviderInputBudget(opts?: {
    maxProjectedMessages?: number;
    maxProjectedTokens?: number;
    reason?: string;
    stageProfile?: string;
  }): ProviderInputBudgetProjection {
    const projected = this.toProjectedMessages();
    const messageCount = projected.length;
    const projectedTokens = estimateProviderHistoryTokens(projected);
    const overBudget = isOverProviderInputBudget(messageCount, projectedTokens, opts);
    let reason: string | null = null;
    if (overBudget) {
      const stageProfile = opts?.stageProfile || 'generic';
      const { maxProjectedMessages, maxProjectedTokens } = resolveProviderInputBudgetLimits(opts);
      reason = `adapter-without-compaction:${stageProfile}`;
      // 跳过路径诊断：只写适配器类名、阶段、计数与估算，不写消息正文。日志失败不影响本轮 LLM 输入装配。
      const adapterName = this.constructor.name;
      observeSafely(
        () =>
          Logger.getInstance().warn(
            `[MessageAdapter] ${reason}: adapter=${adapterName} has no compaction, stageProfile=${stageProfile} messages=${messageCount}/${maxProjectedMessages} tokens≈${projectedTokens}/${maxProjectedTokens}; provider input budget not enforced, projection sent unchanged`
          ),
        () => undefined
      );
    }
    return {
      afterMessageCount: messageCount,
      afterProjectedTokens: projectedTokens,
      beforeMessageCount: messageCount,
      beforeProjectedTokens: projectedTokens,
      level: 0,
      reason,
      removed: 0,
    };
  }

  /**
   * 格式化工具结果字符串 (统一 limitToolResult 调用)
   * @deprecated 兼容保留、运行时不使用：真实工具结果进入历史前走 projectToolReceipt（读结果被裁剪时由
   *   AgentRuntime 失效已读视图），本方法不会失效已读视图，不能当作生效的裁剪路径。随待决事项②“公开面收窄”删除。
   * @param rawResult 工具原始返回值
   */
  formatToolResult(toolName: string, rawResult: unknown) {
    const quota = this.getToolResultQuota();
    if (isToolResultEnvelope(rawResult)) {
      return limitToolResult(toolName, rawResult.text, quota);
    }
    if (looksLikeToolResultEnvelope(rawResult)) {
      // 形似信封却未过严格守卫（如 durationMs 为负）：不把 trust/diagnostics 等内部字段整份
      // 序列化给模型；text 是自有字符串时回退用它。只记录工具名，不记录信封正文。
      const fallbackText = readRejectedEnvelopeText(rawResult);
      Logger.getInstance().warn(
        `[MessageAdapter] ${TOOL_ENVELOPE_SHAPE_REJECTED}: tool=${toolName}, textFallback=${fallbackText !== undefined}`
      );
      if (fallbackText !== undefined) {
        return limitToolResult(toolName, fallbackText, quota);
      }
    }
    return limitToolResult(toolName, rawResult, quota);
  }
}

/**
 * 宽松信封识别：自有数据属性 toolId/callId/status 均为字符串即视为“意图是信封”。
 * 仅用于区分“守卫失败的信封”和普通工具原值；不读取 accessor，不放行进入严格信封路径。
 */
function looksLikeToolResultEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return ['toolId', 'callId', 'status'].every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && 'value' in descriptor && typeof descriptor.value === 'string');
  });
}

// ─────────────────────────────────────────────
//  ContextWindowAdapter — 委托给 ContextWindow
// ─────────────────────────────────────────────

/**
 * 委托所有消息操作给 ContextWindow 实例。
 *
 * 用于 bootstrap / system 场景，
 * ContextWindow 提供三级递进压缩 + 动态 token 预算。
 */
export class ContextWindowAdapter extends MessageAdapter {
  #ctxWin;
  /**
   * 旧 duck-typed 窗口读视图兼容分支（临时兼容代码登记，I49 / U26-F6）：
   * - 消费者：经 createMessageAdapter / ContextWindowAdapter 公开入口传入、没有合法
   *   readViewRevision 的非标准窗口。当前没有生产消费者——唯一生产来源
   *   SystemRunContextFactory.createContextWindow 与宿主都创建真实 ContextWindow（总有 readViewRevision），
   *   只有 test/tool-resource-scope.test.ts 的 Proxy 用例能进入此分支。
   * - 原因：这类窗口无法证明压缩后仍保留工具全文，增量复用（delta reuse）不安全；与其拒绝窗口，
   *   不如保持工具可用、只禁用增量复用（构造时 warn 一次）。
   * - 行为：readViewRevision getter 每次读取都自增，是有意让每次请求换视图，不是副作用缺陷。
   * - 移除条件：待决事项③“单宿主假设与旧宿主兼容分支”确认只接受真实 ContextWindow 后，删除本分支，
   *   构造参数收紧为必须带 readViewRevision。
   * - 清理触发点：③ 的决定落地时，同一提交删除本字段、getter 中的兼容路径与上述 Proxy 用例。
   * - 负责：AlembicAgent（runtime/MessageAdapter 所有者）。
   */
  readonly #legacyReadView: boolean;

  constructor(ctxWin: ContextWindow) {
    super();
    this.#ctxWin = ctxWin;
    this.#legacyReadView =
      !Number.isSafeInteger(ctxWin.readViewRevision) || ctxWin.readViewRevision < 0;
    if (this.#legacyReadView) {
      Logger.getInstance().warn(
        '[MessageAdapter] legacy context window has no read-view revision; delta reuse disabled for this loop'
      );
    }
  }

  /**
   * 获取底层 ContextWindow 实例。
   * @deprecated 兼容保留、运行时不使用：强制摘要不读上下文窗口，AgentRuntime 直接持有 ctx.contextWindow。
   *   随待决事项②“公开面收窄”删除。
   */
  get contextWindow() {
    return this.#ctxWin;
  }

  get readViewRevision(): number {
    if (this.#legacyReadView) {
      // 兼容分支（登记见 #legacyReadView）：旧 duck-typed window 不能证明压缩后仍保留全文；
      // 每次读取自增、每次请求换视图，保持工具可用但禁用增量复用。
      this.invalidateReadView();
      return super.readViewRevision;
    }
    return super.readViewRevision + this.#ctxWin.readViewRevision;
  }

  appendUserMessage(text: string) {
    this.#ctxWin.appendUserMessage(text);
  }

  appendAssistantText(
    text: string,
    reasoningContent?: string | null,
    continuation?: LlmContinuation
  ) {
    this.#ctxWin.appendAssistantText(text, reasoningContent, continuation);
  }

  appendAssistantWithToolCalls(
    text: string | null,
    calls: ToolCallRecord[],
    reasoningContent?: string | null,
    continuation?: LlmContinuation
  ) {
    this.#ctxWin.appendAssistantWithToolCalls(text, calls, reasoningContent, continuation);
  }

  appendToolResult(
    callId: string,
    name: string,
    content: string,
    metadata?: { persistedSubmission?: boolean }
  ) {
    this.#ctxWin.appendToolResult(callId, name, content, metadata);
  }

  appendUserNudge(text: string) {
    this.#ctxWin.appendUserNudge(text);
  }

  toMessages() {
    // ContextWindow.toMessages 返回内部活数组；适配器层统一返回快照，与 SimpleArrayAdapter 别名语义一致，
    // 避免调用方改写数组绕过 L3 折叠边界与 runtime nudge 维护。
    return [...this.#ctxWin.toMessages()];
  }

  toProjectedMessages() {
    return this.#ctxWin.toProjectedMessages();
  }

  resetToPromptOnly() {
    this.#ctxWin.resetToPromptOnly();
  }

  /** @deprecated 兼容保留、运行时不使用，见 MessageAdapter.getToolResultQuota。 */
  getToolResultQuota() {
    return this.#ctxWin.getToolResultQuota();
  }

  /** @deprecated 兼容保留、运行时不使用，见 MessageAdapter.compactIfNeeded。 */
  compactIfNeeded() {
    return this.#ctxWin.compactIfNeeded();
  }

  compactForProviderInputBudget(opts?: {
    maxProjectedMessages?: number;
    maxProjectedTokens?: number;
    reason?: string;
    stageProfile?: string;
  }) {
    return this.#ctxWin.compactForProviderInputBudget(opts);
  }
}

// ─────────────────────────────────────────────
//  SimpleArrayAdapter — 裸数组模式
// ─────────────────────────────────────────────

/**
 * 简单数组消息管理 — 对话场景（以及未注入 contextWindow 的严格阶段）。
 *
 * 不做任何压缩；compactForProviderInputBudget 沿用基类：如实测量 token，超出阶段预算时告警并标明未执行。
 * 兼容成员 getToolResultQuota（固定 8000 字符）与 compactIfNeeded（恒 no-op）运行时不使用，
 * 改这里的配额不会影响真实工具结果裁剪（真实路径是 BudgetController + projectToolReceipt）。
 * 消息语义（nudge 替换、submit 参数压缩、工具结果元数据）与 ContextWindow 共用同一组纯函数。
 */
export class SimpleArrayAdapter extends MessageAdapter {
  #messages: ChatMessage[] = [];

  appendUserMessage(text: string) {
    this.#messages.push({ role: 'user', content: text });
  }

  appendAssistantText(
    text: string,
    reasoningContent?: string | null,
    continuation?: LlmContinuation
  ) {
    const msg: ChatMessage = { role: 'assistant', content: text };
    if (reasoningContent != null) {
      msg.reasoningContent = reasoningContent;
    }
    if (continuation) {
      msg.continuation = structuredClone(continuation);
    }
    this.#messages.push(msg);
  }

  appendAssistantWithToolCalls(
    text: string | null,
    calls: ToolCallRecord[],
    reasoningContent?: string | null,
    continuation?: LlmContinuation
  ) {
    // 与 ContextWindow 共用：knowledge submit 参数压缩为标识字段；参数被改写时不保存续接并剥离签名。
    const history = prepareToolCallsForProviderHistory(calls, continuation);
    const msg: ChatMessage = {
      role: 'assistant',
      content: text,
      toolCalls: history.toolCalls,
      reasoningContent: reasoningContent ?? '',
    };
    if (history.continuationDropDiagnostic) {
      const diagnostic = history.continuationDropDiagnostic;
      // 一次性诊断：只在追加时记录一次；不含推理正文、参数正文或签名。日志失败不影响追加。
      observeSafely(
        () => Logger.getInstance().info(`[MessageAdapter] ${diagnostic}`),
        () => undefined
      );
    } else if (history.continuation) {
      msg.continuation = history.continuation;
    }
    this.#messages.push(msg);
  }

  appendToolResult(
    callId: string,
    name: string,
    content: string,
    metadata?: { persistedSubmission?: boolean }
  ) {
    const historyMetadata = toolResultHistoryMetadata(metadata);
    this.#messages.push({
      role: 'tool',
      toolCallId: callId,
      name,
      content,
      ...(historyMetadata ? { metadata: historyMetadata } : {}),
    });
  }

  appendUserNudge(text: string) {
    // 与 ContextWindow 相同：先移除旧 runtime nudge（首条 prompt 保留），模型只看到最新运行时指令。
    // 裸数组模式没有 L3 折叠边界，无需移动阈值。
    this.#messages = dropStaleRuntimeNudges(this.#messages).kept;
    this.#messages.push(createRuntimeNudgeMessage(text));
  }

  toMessages() {
    return [...this.#messages];
  }

  resetToPromptOnly() {
    // 仅保留首条消息：有 history 时是 history 首条，不是本次任务 prompt（见基类说明）。
    const first = this.#messages[0];
    this.invalidateReadView();
    this.#messages.length = 0;
    if (first) {
      this.#messages.push(first);
    }
  }

  /** @deprecated 兼容保留、运行时不使用，见 MessageAdapter.getToolResultQuota。 */
  getToolResultQuota() {
    return { maxChars: 8000, maxMatches: 20 };
  }

  /** @deprecated 兼容保留、运行时不使用，见 MessageAdapter.compactIfNeeded。 */
  compactIfNeeded() {
    return { level: 0, removed: 0 };
  }
}

// ─────────────────────────────────────────────
//  Factory helper
// ─────────────────────────────────────────────

/** 根据是否提供 contextWindow 创建对应适配器 */
export function createMessageAdapter(contextWindow: ContextWindow | null | undefined) {
  if (contextWindow) {
    return new ContextWindowAdapter(contextWindow);
  }
  return new SimpleArrayAdapter();
}
