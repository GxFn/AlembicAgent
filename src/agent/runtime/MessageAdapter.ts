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
 * 已删除的兼容成员（I49 / L5-P48，事项②③答复后，四处零引用）：formatToolResult、getToolResultQuota、
 * compactIfNeeded 与 ContextWindowAdapter.contextWindow getter——工具结果配额走 BudgetController +
 * projectToolReceipt，常规压缩走 BudgetController → ContextWindow，强制摘要不读上下文窗口。
 * 基类改为 abstract class，子类漏实现在编译期报错；旧 duck-typed 窗口兼容分支删除，非标准窗口构造即报错。
 *
 * @module agent/runtime/MessageAdapter
 */

import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import type { ContextWindow, ToolCallInfo } from '../context/ContextWindow.js';
import {
  createRuntimeNudgeMessage,
  dropStaleRuntimeNudges,
  estimateProviderHistoryTokens,
  isOverProviderInputBudget,
  prepareToolCallsForProviderHistory,
  resolveProviderInputBudgetLimits,
  toolResultHistoryMetadata,
} from '../context/ContextWindow.js';

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
 * 消息适配器抽象基类。
 *
 * 七个消息操作是 abstract 声明，子类漏实现在编译期报错（此前是普通 class + 运行时 throw
 * 'not implemented'）；`new MessageAdapter()` 同样是编译错误。已读视图版本、读时投影的默认实现与
 * 无压缩能力的预算投影由基类提供。
 */
export abstract class MessageAdapter {
  #readViewRevision = 0;

  get readViewRevision(): number {
    return this.#readViewRevision;
  }

  /** 工具结果进入历史前已被配额裁剪时，也必须失效当前已读视图。 */
  invalidateReadView(): void {
    this.#readViewRevision++;
  }

  /** 追加用户消息 */
  abstract appendUserMessage(text: string): void;

  /** 追加助手纯文本回复 */
  abstract appendAssistantText(
    text: string,
    reasoningContent?: string | null,
    continuation?: LlmContinuation
  ): void;

  /**
   * 追加助手带工具调用的回复
   * @param calls functionCalls 数组
   * @param reasoningContent DeepSeek V4 推理内容（可选）
   */
  abstract appendAssistantWithToolCalls(
    text: string | null,
    calls: ToolCallRecord[],
    reasoningContent?: string | null,
    continuation?: LlmContinuation
  ): void;

  /** 追加工具执行结果 */
  abstract appendToolResult(
    callId: string,
    name: string,
    content: string,
    metadata?: { persistedSubmission?: boolean }
  ): void;

  /** 追加系统/用户 nudge 消息 */
  abstract appendUserNudge(text: string): void;

  /**
   * 导出当前消息列表的快照（浅拷贝数组）。
   * 调用方对返回数组的 push/splice/排序不影响适配器内部历史；消息对象本身仍是共享引用，不得原地修改。
   */
  abstract toMessages(): unknown[];

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
  abstract resetToPromptOnly(): void;

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
   * 只接受带合法 readViewRevision（非负安全整数）的真实 ContextWindow。
   *
   * ③“单宿主假设”答复（2026-10-20）后删除旧 duck-typed 窗口兼容分支（原 #legacyReadView：每次读取
   * 自增视图、禁用增量复用）：唯一生产来源 SystemRunContextFactory.createContextWindow 与宿主都创建真实
   * ContextWindow。没有合法版本号的窗口无法证明压缩后仍保留工具全文，增量复用不安全；这里失败关闭，
   * 记 error 日志后抛 CONTEXT_WINDOW_READ_VIEW_REVISION_INVALID，reactLoop 以该错误拒绝、不发起任何工具请求。
   */
  constructor(ctxWin: ContextWindow) {
    super();
    const revision: unknown = ctxWin.readViewRevision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
      const detail = typeof revision === 'number' ? String(revision) : `<${typeof revision}>`;
      const message = `CONTEXT_WINDOW_READ_VIEW_REVISION_INVALID: context window readViewRevision=${detail} is not a non-negative safe integer; non-standard windows are rejected (legacy read-view fallback removed)`;
      Logger.getInstance().error(`[MessageAdapter] ${message}`);
      throw new Error(message);
    }
    this.#ctxWin = ctxWin;
  }

  get readViewRevision(): number {
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
 * 真实工具结果裁剪在进入历史之前由 BudgetController + projectToolReceipt 完成，适配器不再持有配额。
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
