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
 * @module core/MessageAdapter
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

/** @abstract */
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

  /** 重置到仅保留初始 prompt (错误恢复) */
  resetToPromptOnly() {
    throw new Error('not implemented');
  }

  /**
   * 获取工具结果限额
   * @returns }
   */
  getToolResultQuota(): { maxChars: number; maxMatches: number } {
    throw new Error('not implemented');
  }

  /**
   * 压缩检查 — 如果消息过多则自动压缩
   * @returns }
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

  /** 获取底层 ContextWindow 实例 (供 forcedSummary 等外部逻辑使用) */
  get contextWindow() {
    return this.#ctxWin;
  }

  get readViewRevision(): number {
    if (this.#legacyReadView) {
      // 旧 duck-typed window 不能证明压缩后仍保留全文；每次请求换视图，保持工具可用。
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

  getToolResultQuota() {
    return this.#ctxWin.getToolResultQuota();
  }

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
 * 不做任何压缩，getToolResultQuota 返回固定 8000，compactIfNeeded 始终返回 no-op；
 * compactForProviderInputBudget 沿用基类：如实测量 token，超出阶段预算时告警并标明未执行。
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
    const first = this.#messages[0];
    this.invalidateReadView();
    this.#messages.length = 0;
    if (first) {
      this.#messages.push(first);
    }
  }

  getToolResultQuota() {
    return { maxChars: 8000, maxMatches: 20 };
  }

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
