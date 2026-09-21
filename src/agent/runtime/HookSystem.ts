/**
 * HookSystem — 可阻断的执行钩子与兼容事件桥接
 *
 * AgentRuntime 拥有调用时机；本模块负责注册、优先级、工具执行前阻断和错误诊断。
 * AgentEventBus 仍负责广播与请求回执，ToolExecutionPipeline 仍负责工具准入、执行和结果观察。
 *
 * 设计原则：
 *   - 类型安全：每个 HookEvent 有明确的 payload 类型
 *   - 可组合：支持 sync 和 async hook
 *   - 可拦截：tool:execute:before 支持 block（返回 false 阻止执行）
 *   - 兼容：通过默认 hook 桥接 AgentEventBus，避免重复发布工具事件
 *
 * @module agent/runtime/HookSystem
 */

import Logger from '@alembic/core/logging';
import { isThenable, observeSafely } from '#shared/observers.js';
import { redactDeveloperText } from '../utils/Redaction.js';
import type { AgentProgressProcessEvent } from './AgentRuntimeTypes.js';

// ── Hook Events ──

export type HookEvent =
  | 'agent:iteration:before'
  | 'agent:iteration:after'
  | 'agent:exit'
  | 'agent:finalize'
  | 'tool:execute:before'
  | 'tool:execute:after'
  | 'context:compact:before'
  | 'context:compact:after'
  | 'exploration:phase_transition'
  | 'exploration:budget_warning'
  | 'llm:call:before'
  | 'llm:call:after';

// ── Payload Types ──

export interface HookPayloadMap {
  'agent:iteration:before': { iteration: number; phase?: string };
  'agent:iteration:after': { iteration: number; hadToolCalls: boolean; hadText: boolean };
  'agent:exit': { reason: string; iteration: number; detail?: string };
  'agent:finalize': { reply: string; iterations: number; toolCallCount: number };
  'tool:execute:before': {
    toolId: string;
    args: Record<string, unknown>;
    callId: string;
    processEvent?: AgentProgressProcessEvent;
  };
  'tool:execute:after': {
    toolId: string;
    ok: boolean;
    durationMs: number;
    callId: string;
    processEvent?: AgentProgressProcessEvent;
  };
  'context:compact:before': { level: number; usage: number };
  'context:compact:after': { level: number; removed: number; usage: number };
  'exploration:phase_transition': { from: string; to: string; iteration: number };
  'exploration:budget_warning': { used: number; total: number; iteration: number };
  'llm:call:before': {
    iteration: number;
    toolChoice: string;
    processEvent?: AgentProgressProcessEvent;
  };
  'llm:call:after': {
    iteration: number;
    hasToolCalls: boolean;
    hasText: boolean;
    inputTokens?: number;
    outputTokens?: number;
    processEvent?: AgentProgressProcessEvent;
  };
}

// ── Hook Handler Types ──

export type HookHandler<E extends HookEvent> = (payload: HookPayloadMap[E]) => unknown;

export interface HookErrorDiagnostic {
  code: 'HOOK_HANDLER_FAILED';
  event: HookEvent;
  hookId: string;
  message: string;
  mode: 'async' | 'sync';
}

interface HookEntry<E extends HookEvent = HookEvent> {
  event: E;
  handler: HookHandler<E>;
  priority: number;
  once: boolean;
  fired?: boolean;
  id: string;
}

// ── HookSystem Class ──

let _hookCounter = 0;

export class HookSystem {
  readonly #hooks = new Map<HookEvent, HookEntry[]>();
  readonly #hookErrors: HookErrorDiagnostic[] = [];
  readonly #logger = Logger;

  /**
   * Register a hook handler.
   *
   * @param event - The event to listen for
   * @param handler - Handler function. For 'tool:execute:before', return false to block.
   * @param opts - Options: priority (lower = earlier, default 100), once (auto-remove after first call)
   * @returns Unsubscribe function
   */
  on<E extends HookEvent>(
    event: E,
    handler: HookHandler<E>,
    opts: { priority?: number; once?: boolean } = {}
  ): () => void {
    const id = `hook_${++_hookCounter}`;
    const entry: HookEntry<E> = {
      event,
      handler,
      priority: opts.priority ?? 100,
      once: opts.once ?? false,
      id,
    };

    let list = this.#hooks.get(event);
    if (!list) {
      list = [];
      this.#hooks.set(event, list);
    }
    list.push(entry as unknown as HookEntry);
    list.sort((a, b) => a.priority - b.priority);

    return () => this.#removeHook(event, id);
  }

  /** Register a one-shot hook. */
  once<E extends HookEvent>(event: E, handler: HookHandler<E>, priority?: number): () => void {
    return this.on(event, handler, { priority, once: true });
  }

  #removeHook(event: HookEvent, id: string): void {
    const list = this.#hooks.get(event);
    const index = list?.findIndex((entry) => entry.id === id) ?? -1;
    if (list && index >= 0) {
      list.splice(index, 1);
    }
  }

  #claimOnce(entry: HookEntry): boolean {
    if (!entry.once) {
      return true;
    }
    // 不同分发可能早已快照到同一 entry；共享领取事实，不能只检查 live list。
    if (entry.fired) {
      return false;
    }
    entry.fired = true;
    this.#removeHook(entry.event, entry.id);
    return true;
  }

  /**
   * Emit an event to all registered hooks.
   *
   * For 'tool:execute:before': if any handler returns false, the tool execution is blocked.
   * Handlers are awaited in order; only blocking events interpret a false result.
   *
   * @returns For blocking events, returns false if any handler blocked. Otherwise true.
   */
  async emit<E extends HookEvent>(event: E, payload: HookPayloadMap[E]): Promise<boolean> {
    const list = this.#hooks.get(event);
    if (!list || list.length === 0) {
      return true;
    }

    let blocked = false;

    // 当前分发使用固定快照；自退订不能跳过后续阻断器，新 hook 只影响下一次分发。
    for (const entry of [...list]) {
      // 调用前领取 once，防止同步重入或 await 期间并发 emit 再次执行。
      if (!this.#claimOnce(entry)) {
        continue;
      }
      try {
        const result = entry.handler(payload as never);
        const resolved = isThenable(result) ? await result : result;

        if (event === 'tool:execute:before' && resolved === false) {
          blocked = true;
        }
      } catch (err: unknown) {
        this.#recordHookError(event, entry, err, 'async', payload);
      }
    }

    return !blocked;
  }

  /**
   * Synchronous emit — for performance-critical hooks where async is unnecessary.
   * Does not wait or support blocking; observer promises are monitored for rejection.
   */
  emitSync<E extends HookEvent>(event: E, payload: HookPayloadMap[E]): void {
    const list = this.#hooks.get(event);
    if (!list || list.length === 0) {
      return;
    }

    for (const entry of [...list]) {
      if (!this.#claimOnce(entry)) {
        continue;
      }
      observeSafely(
        () => entry.handler(payload as never),
        (err) => this.#recordHookError(event, entry, err, 'sync', payload)
      );
    }
  }

  /** Remove all hooks for a specific event or all events. */
  clear(event?: HookEvent): void {
    if (event) {
      this.#hooks.delete(event);
    } else {
      this.#hooks.clear();
    }
  }

  /** Get registered hook count for inspection. */
  hookCount(event?: HookEvent): number {
    if (event) {
      return this.#hooks.get(event)?.length ?? 0;
    }
    let total = 0;
    for (const list of this.#hooks.values()) {
      total += list.length;
    }
    return total;
  }

  getDiagnostics(): { hookErrors: HookErrorDiagnostic[] } {
    return { hookErrors: this.#hookErrors.map((entry) => ({ ...entry })) };
  }

  clearDiagnostics(): void {
    this.#hookErrors.splice(0);
  }

  #recordHookError<E extends HookEvent>(
    event: E,
    entry: HookEntry,
    err: unknown,
    mode: 'async' | 'sync',
    payload: HookPayloadMap[E]
  ): void {
    // 错误附件或日志端口自身失败不能重新中断已经隔离的观察者分发。
    observeSafely(
      () => {
        const diagnostic: HookErrorDiagnostic = {
          code: 'HOOK_HANDLER_FAILED',
          event,
          hookId: entry.id,
          // 错误会进入 developer-facing 过程事件；必须在附加到已净化 metadata 前脱敏。
          message: redactDeveloperText(err instanceof Error ? err.message : String(err)),
          mode,
        };
        this.#hookErrors.push(diagnostic);
        attachHookDiagnosticToProcessEvent(payload, diagnostic);
        return this.#logger.warn(
          `[HookSystem] hook error on ${event} (${entry.id}): ${diagnostic.message}`
        );
      },
      () => undefined
    );
  }
}

function attachHookDiagnosticToProcessEvent(
  payload: unknown,
  diagnostic: HookErrorDiagnostic
): void {
  const processEvent = (payload as { processEvent?: AgentProgressProcessEvent } | null)
    ?.processEvent;
  if (!processEvent || typeof processEvent !== 'object') {
    return;
  }
  const metadata = (processEvent.metadata ??= {}) as Record<string, unknown>;
  const hookErrors = Array.isArray(metadata.hookErrors)
    ? (metadata.hookErrors as HookErrorDiagnostic[])
    : [];
  hookErrors.push({ ...diagnostic });
  metadata.hookErrors = hookErrors;
}

// ── Default hooks registration ──

/**
 * Register default hooks that bridge HookSystem events to existing subsystems.
 * Call this during AgentRuntime initialization.
 *
 * Bridges HookSystem → AgentEventBus for backward compatibility.
 * Pipeline middleware (allowlistGate, observationRecord, trackerSignal,
 * traceRecord, submitDedup) remain in ToolExecutionPipeline because they
 * need synchronous access to tool results and loop state.
 */
export function registerDefaultHooks(
  hookSystem: HookSystem,
  agentId?: string,
  bus?: { publish(type: string, payload: unknown, opts?: { source?: string }): void } | null
): void {
  if (!bus) {
    return;
  }

  hookSystem.on('llm:call:before', (p) => {
    bus.publish(
      'llm:call:start',
      {
        agentId,
        iteration: p.iteration,
        toolChoice: p.toolChoice,
        ...(p.processEvent ? { processEvent: p.processEvent } : {}),
      },
      { source: agentId }
    );
  });

  hookSystem.on('llm:call:after', (p) => {
    bus.publish(
      'llm:call:end',
      {
        hasToolCalls: p.hasToolCalls,
        hasText: p.hasText,
        usage: { inputTokens: p.inputTokens, outputTokens: p.outputTokens },
        ...(p.processEvent ? { processEvent: p.processEvent } : {}),
      },
      { source: agentId }
    );
  });

  hookSystem.on('agent:exit', (p) => {
    bus.publish(
      'step:completed',
      {
        reason: p.reason,
        iteration: p.iteration,
        detail: p.detail,
      },
      { source: agentId }
    );
  });

  // tool:execute:before/after are NOT bridged to AgentEventBus here
  // because AgentRuntime.#processToolCalls already publishes
  // TOOL_CALL_START/END directly. Bridging would cause duplicates.
}
