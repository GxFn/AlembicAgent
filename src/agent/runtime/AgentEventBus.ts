/**
 * AgentEventBus — Agent 间事件通信总线
 *
 * 借鉴 AutoGen Core Event-Driven 架构 + RxJS Observable 模式:
 *   - Agent 间松耦合通信（publish/subscribe）
 *   - 支持同步和异步事件处理
 *   - 事件元信息与通配监听
 *   - 支持 request/reply 模式（Agent 间 RPC）
 *
 * @module AgentEventBus
 */

import { EventEmitter } from 'node:events';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { runOperation } from '#shared/operation.js';

interface PendingReply {
  requestType: string;
  resolve: (event: unknown) => void;
  cancel: (reason: Error) => void;
}

/** 标准事件类型 */
export const AgentEvents = Object.freeze({
  // ── 生命周期 ──
  AGENT_CREATED: 'agent:created',
  AGENT_STARTED: 'agent:started',
  AGENT_COMPLETED: 'agent:completed',
  AGENT_FAILED: 'agent:failed',
  AGENT_ABORTED: 'agent:aborted',

  // ── 执行 ──
  TOOL_CALL_START: 'tool:call:start',
  TOOL_CALL_END: 'tool:call:end',
  LLM_CALL_START: 'llm:call:start',
  LLM_CALL_END: 'llm:call:end',
  STEP_COMPLETED: 'step:completed',

  // ── Agent 间交互 ──
  HANDOFF_REQUEST: 'handoff:request',
  HANDOFF_ACCEPT: 'handoff:accept',
  HANDOFF_RESULT: 'handoff:result',

  // ── 进度 ──
  PROGRESS: 'progress',
  THINKING: 'thinking',
  STREAM_DELTA: 'stream:delta',

  // ── 外部触发 ──
  USER_INPUT: 'user:input',
  SCAN_REQUEST: 'scan:request',
});

export class AgentEventBus extends EventEmitter {
  static #instance: AgentEventBus | null = null;
  #logger;
  /** topic → handlers */
  #subscriptions = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  /** correlationId → 尚未完成的请求 */
  #pendingReplies = new Map<string, PendingReply>();
  /** 事件计数 */
  #eventCount = 0;

  constructor() {
    super();
    this.setMaxListeners(100);
    this.#logger = Logger.getInstance();
  }

  /** 获取全局单例 */
  static getInstance() {
    if (!AgentEventBus.#instance) {
      AgentEventBus.#instance = new AgentEventBus();
    }
    return AgentEventBus.#instance;
  }

  /** 重置单例（测试用）；取消旧实例的未完成请求并释放等待资源。 */
  static resetInstance() {
    if (AgentEventBus.#instance) {
      AgentEventBus.#instance.removeAllListeners();
      AgentEventBus.#instance.#subscriptions.clear();
      for (const pending of AgentEventBus.#instance.#pendingReplies.values()) {
        pending.cancel(
          new Error(`AgentEventBus request cancelled by reset: ${pending.requestType}`)
        );
      }
      AgentEventBus.#instance.#pendingReplies.clear();
    }
    AgentEventBus.#instance = null;
  }

  // ─── 发布 ────────────────────────────────

  /**
   * 发布事件（广播）
   * @param type 事件类型
   * @param payload 事件数据
   * @param [opts.source] 发送者 agentId
   * @param [opts.target] 目标 agentId
   * @param [opts.correlationId] 关联 ID
   */
  publish(
    type: string,
    payload: Record<string, unknown> = {},
    opts: { source?: string; target?: string; correlationId?: string } = {}
  ) {
    this.#eventCount++;
    const event = {
      type,
      source: opts.source || 'system',
      target: opts.target || null,
      payload,
      timestamp: Date.now(),
      correlationId: opts.correlationId || null,
    };

    // 一次发布冻结所有监听通道。rawListeners 保留 once wrapper 与 EventEmitter 的 this 绑定；
    // 只在 publish 边界隔离观察者，继承的 emit 仍保留 Node EventEmitter 的公开语义。
    const listeners = [...this.rawListeners(type), ...this.rawListeners('*')];
    const handlers = [...(this.#subscriptions.get(type) || [])];
    const onFailure = (err: unknown) => {
      this.#logger.warn(
        `[AgentEventBus] Handler error on ${type}: ${err instanceof Error ? err.message : String(err)}`
      );
    };
    for (const listener of listeners) {
      observeSafely(() => listener.call(this, event), onFailure);
    }
    for (const handler of handlers) {
      observeSafely(() => handler(event), onFailure);
    }

    // 检查是否有 pending reply
    if (opts.correlationId) {
      const pending = this.#pendingReplies.get(opts.correlationId);
      if (pending && type !== pending.requestType) {
        this.#pendingReplies.delete(opts.correlationId);
        pending.resolve(event);
      }
    }
  }

  /**
   * 订阅事件
   * @param type 事件类型
   * @param handler 处理函数 (event) => void
   * @returns 取消订阅函数
   */
  subscribe(type: string, handler: (event: Record<string, unknown>) => void) {
    const handlers = this.#subscriptions.get(type) ?? [];
    this.#subscriptions.set(type, handlers);
    handlers.push(handler);

    return () => {
      const handlers = this.#subscriptions.get(type);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) {
          handlers.splice(idx, 1);
        }
      }
    };
  }

  /**
   * Request/Reply 模式 — 发送请求并等待响应
   * @param requestType 请求事件类型
   * @param payload 请求数据
   * @param [opts.timeout=30000] 超时毫秒
   * @param [opts.source] 发送者
   * @returns 响应事件
   */
  async request(
    requestType: string,
    payload: Record<string, unknown> = {},
    opts: { timeout?: number; source?: string } = {}
  ) {
    const correlationId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timeout = opts.timeout || 30_000;

    const { promise, resolve, reject } = Promise.withResolvers();
    // 生命周期可能在接管 reply 前结束；仍接住发布/重置带来的迟到拒绝，不产生孤立 promise。
    void promise.catch(() => undefined);
    const cancellation = new AbortController();
    const pendingOperation = runOperation(() => promise, {
      timeoutMs: timeout,
      abortSignal: cancellation.signal,
    });
    this.#pendingReplies.set(correlationId, {
      resolve,
      requestType,
      cancel: (reason) => {
        cancellation.abort(reason);
        reject(reason);
      },
    });
    try {
      // 保留同步 publish 合同；只把等待/取消/长 timer 策略交给共享生命周期。
      try {
        this.publish(requestType, payload, {
          source: opts.source,
          correlationId,
        });
      } catch (err: unknown) {
        reject(err);
      }
      const outcome = await pendingOperation;
      if (outcome.status === 'ok') {
        return outcome.value;
      }
      if (outcome.status === 'error') {
        return Promise.reject(outcome.error);
      }
      if (outcome.status === 'aborted') {
        return Promise.reject(cancellation.signal.reason);
      }
      throw new Error(`AgentEventBus request timeout: ${requestType} (${timeout}ms)`);
    } finally {
      this.#pendingReplies.delete(correlationId);
    }
  }

  /** 获取事件统计 */
  getStats() {
    return {
      totalEvents: this.#eventCount,
      subscriptionTopics: this.#subscriptions.size,
      pendingReplies: this.#pendingReplies.size,
    };
  }
}

export default AgentEventBus;
