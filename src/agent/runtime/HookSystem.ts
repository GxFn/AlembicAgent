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
 *   - 可诊断：钩子失败除了进入本实例 getDiagnostics() 与日志，还可按单次分发写入调用方传入的
 *     运行期诊断（AgentDiagnostics.warnings，code=`hook_handler_failed`）
 *
 * @module agent/runtime/HookSystem
 */

import Logger from '@alembic/core/logging';
import { isThenable, observeSafely } from '#shared/observers.js';
import { redactDeveloperText } from '../utils/Redaction.js';
import { AgentEvents } from './AgentEventBus.js';
import type { AgentDiagnosticWarning, AgentProgressProcessEvent } from './AgentRuntimeTypes.js';

// ── Hook Events ──

/**
 * 公开钩子事件。
 *
 * 契约漂移登记（L5-P41 / I30，待决事项②）：`agent:exit`、`context:compact:before`、
 * `context:compact:after`、`exploration:phase_transition`、`exploration:budget_warning`
 * 这 5 个事件**当前运行时未发出**——AgentRuntime 只分发 agent:iteration:*、llm:call:*、
 * tool:execute:* 与 agent:finalize。订阅它们类型检查能通过，但处理器永远不会被调用。
 * ②决定前保留类型以免外部订阅方在类型层断裂；②确认收窄则删除，确认接线则在退出、压缩与
 * 阶段转换处补发。
 */
export type HookEvent =
  | 'agent:iteration:before'
  | 'agent:iteration:after'
  /** 当前运行时未发出（待决事项②）；registerDefaultHooks 的 step:completed 桥接因此不会触发。 */
  | 'agent:exit'
  | 'agent:finalize'
  | 'tool:execute:before'
  | 'tool:execute:after'
  /** 当前运行时未发出（待决事项②）；压缩事实见 AgentDiagnostics.efficiency 的压缩计数。 */
  | 'context:compact:before'
  /** 当前运行时未发出（待决事项②）。 */
  | 'context:compact:after'
  /** 当前运行时未发出（待决事项②）。 */
  | 'exploration:phase_transition'
  /** 当前运行时未发出（待决事项②）。 */
  | 'exploration:budget_warning'
  | 'llm:call:before'
  | 'llm:call:after';

// ── Payload Types ──

export interface HookPayloadMap {
  'agent:iteration:before': { iteration: number; phase?: string };
  'agent:iteration:after': { iteration: number; hadToolCalls: boolean; hadText: boolean };
  /** 当前运行时未发出（待决事项②）。 */
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
  /** 以下 4 个 payload 对应的事件当前运行时未发出（待决事项②）。 */
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

/** 运行期诊断里钩子失败的 warning code；与 HookErrorDiagnostic.code 分属两个落点。 */
const HOOK_HANDLER_FAILED_WARNING = 'hook_handler_failed';

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
   * @param dispatch - 可选的单次分发上下文。`diagnostics` 是本次分发所属运行的诊断落点（通常是
   *   loop 的 DiagnosticsCollector）；钩子失败时额外写一条 `hook_handler_failed` warning。按分发
   *   传入而不是挂在实例上：同一 runtime 可并发跑多个 loop，共享字段会把失败记到别的运行。
   * @returns For blocking events, returns false if any handler blocked. Otherwise true.
   */
  async emit<E extends HookEvent>(
    event: E,
    payload: HookPayloadMap[E],
    dispatch: { diagnostics?: { warn(warning: AgentDiagnosticWarning): void } | null } = {}
  ): Promise<boolean> {
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
        this.#recordHookError(event, entry, err, 'async', payload, dispatch.diagnostics);
      }
    }

    return !blocked;
  }

  /**
   * Synchronous emit — for performance-critical hooks where async is unnecessary.
   * Does not wait or support blocking; observer promises are monitored for rejection.
   * `dispatch.diagnostics` 语义同 emit；异步拒绝晚于本次调用返回时仍写入同一落点。
   */
  emitSync<E extends HookEvent>(
    event: E,
    payload: HookPayloadMap[E],
    dispatch: { diagnostics?: { warn(warning: AgentDiagnosticWarning): void } | null } = {}
  ): void {
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
        (err) => this.#recordHookError(event, entry, err, 'sync', payload, dispatch.diagnostics)
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
    payload: HookPayloadMap[E],
    sink?: { warn(warning: AgentDiagnosticWarning): void } | null
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
        // 运行期诊断落点单独隔离：调用方 sink 抛错不能吞掉下面的日志，也不能中断后续钩子。
        if (sink) {
          observeSafely(
            () => sink.warn(toRunWarning(diagnostic, payload)),
            () =>
              this.#logger.warn(
                `[HookSystem] run diagnostics sink rejected hook_handler_failed on ${event} (${entry.id}); hookSystem.getDiagnostics() still holds it`
              )
          );
        }
        return this.#logger.warn(
          `[HookSystem] hook error on ${event} (${entry.id}): ${diagnostic.message}`
        );
      },
      () => undefined
    );
  }
}

/**
 * 把钩子失败投影为运行期 warning。钩子失败只被隔离、不阻断（抛错的 tool:execute:before 不等于
 * 返回 false），所以 message 写明“已隔离、运行继续”；message 复用已脱敏的诊断文本。
 * 工具钩子带上 toolId，便于宿主按工具归因。
 */
function toRunWarning(diagnostic: HookErrorDiagnostic, payload: unknown): AgentDiagnosticWarning {
  const toolId = (payload as { toolId?: unknown } | null)?.toolId;
  return {
    code: HOOK_HANDLER_FAILED_WARNING,
    message: `Hook ${diagnostic.hookId} failed on ${diagnostic.event} (${diagnostic.mode} dispatch); handler isolated, run continues: ${diagnostic.message}`,
    ...(typeof toolId === 'string' ? { tool: toolId } : {}),
  };
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
 * Pipeline middleware (allowlistGate and the other gates, evidenceCapture,
 * trackerSignal, traceRecord, submitDedup) remain in ToolExecutionPipeline
 * because they need synchronous access to tool results and loop state.
 * 默认装配顺序以 createToolPipeline 为准；observationRecord 已移出默认装配（L5-P47 / I45）。
 */
export function registerDefaultHooks(
  hookSystem: HookSystem,
  agentId?: string,
  bus?: { publish(type: string, payload: unknown, opts?: { source?: string }): void } | null
): void {
  if (!bus) {
    return;
  }

  // 发布名统一取 AgentEvents 常量：常量改值时桥接跟随，订阅常量的消费者不会静默收不到事件。
  hookSystem.on('llm:call:before', (p) => {
    bus.publish(
      AgentEvents.LLM_CALL_START,
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
      AgentEvents.LLM_CALL_END,
      {
        hasToolCalls: p.hasToolCalls,
        hasText: p.hasText,
        usage: { inputTokens: p.inputTokens, outputTokens: p.outputTokens },
        ...(p.processEvent ? { processEvent: p.processEvent } : {}),
      },
      { source: agentId }
    );
  });

  // 当前是死桥接（待决事项②）：运行时从不分发 agent:exit，AgentEvents.STEP_COMPLETED 因此不会出现。
  // ②确认收窄则连同 agent:exit 一并删除；确认接线则在退出路径补发 agent:exit 后此处自然生效。
  hookSystem.on('agent:exit', (p) => {
    bus.publish(
      AgentEvents.STEP_COMPLETED,
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
