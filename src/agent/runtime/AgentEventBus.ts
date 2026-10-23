/**
 * AgentEventBus — Agent 事件广播总线
 *
 * 基于 Node EventEmitter 的单向广播：
 *   - 发布方经 publish() 广播带元信息（source/target/correlationId/timestamp）的事件信封
 *   - 订阅方经继承的 `bus.on(type)` / `bus.on('*')` 通配 / `bus.off` 管理监听器
 *   - publish 在边界隔离观察者的同步异常与异步拒绝
 *
 * L5-P41 / I30 / U20-F8 收窄（待决事项②按删除路线答复）：subscribe() 与 request()/reply 只有
 * 测试调用、没有生产或宿主消费者，已连同订阅表、挂起应答表与 correlationId 应答分支删除。
 * publish 现在只分发给 EventEmitter 监听器，分发顺序（topic 监听在前、`*` 通配在后）不变；
 * 信封里的 target/correlationId 仍原样携带，供监听方自行关联。
 *
 * @module AgentEventBus
 */

import { EventEmitter } from 'node:events';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';

/**
 * 标准事件类型。
 *
 * 发布方是唯一真相源：HookSystem 的 llm:call:* 桥接也引用这里的常量。
 * L5-P41 收窄后只保留 src 内有发布方的键；没有发布方的步骤完成、Agent 间交接、思考、流式增量、
 * 用户输入与扫描请求常量已删除（思考进度走 PROGRESS，progress 事件的 type='thinking'）。
 */
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

  // ── 进度 ──
  PROGRESS: 'progress',
});

export class AgentEventBus extends EventEmitter {
  static #instance: AgentEventBus | null = null;
  #logger;
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

  /** 重置单例（测试用）；移除旧实例的全部监听器，下一次 getInstance() 返回新实例。 */
  static resetInstance() {
    if (AgentEventBus.#instance) {
      AgentEventBus.#instance.removeAllListeners();
    }
    AgentEventBus.#instance = null;
  }

  // ─── 发布 ────────────────────────────────

  /**
   * 发布事件（广播）。只分发给 EventEmitter 监听器：先 `type` 监听，再 `'*'` 通配监听。
   * @param type 事件类型
   * @param payload 事件数据
   * @param [opts.source] 发送者 agentId
   * @param [opts.target] 目标 agentId（只写入信封，不做定向投递）
   * @param [opts.correlationId] 关联 ID（只写入信封，总线不据此应答）
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
    const onFailure = (err: unknown) => {
      this.#logger.warn(
        `[AgentEventBus] Handler error on ${type}: ${err instanceof Error ? err.message : String(err)}`
      );
    };
    for (const listener of listeners) {
      observeSafely(() => listener.call(this, event), onFailure);
    }
  }

  /**
   * 获取事件统计。L5-P41 收窄后只剩 totalEvents：订阅表与挂起应答表随 subscribe/request 删除；
   * 监听器数量请用继承的 `listenerCount()` / `eventNames()`。
   */
  getStats() {
    return {
      totalEvents: this.#eventCount,
    };
  }
}

export default AgentEventBus;
