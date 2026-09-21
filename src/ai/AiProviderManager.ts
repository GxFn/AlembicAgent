/**
 * AiProviderManager — 宿主可注入的 Provider 路由生命周期。
 * 准备生成模型 → 同步 LLM 路由/DI → 失效 LLM 依赖缓存 → 通知；失败仅补偿路由，不能还原缓存。
 * 用量绑定由独立 tracker 持有，旧请求完成时仍按其真实模型归档。
 */

import Logger from '@alembic/core/logging';
import type {
  ManagedAiProvider,
  ProviderInfo,
  SwitchListener,
  SwitchResult,
  TokenRecorder,
} from './management/contracts.js';
import { isThenable, observeSafely } from './management/observers.js';
import { ProviderUsageTracker } from './management/ProviderUsageTracker.js';

// ── 类型 ────────────────────────────────────────────────

export type {
  ManagedAiProvider,
  ProviderInfo,
  SwitchListener,
  SwitchResult,
  TokenRecorder,
  TokenUsagePayload,
} from './management/contracts.js';

// ── Manager ────────────────────────────────────────────

export class AiProviderManager {
  #provider: ManagedAiProvider;
  #embedProvider: ManagedAiProvider | null = null;
  #listeners = new Set<SwitchListener>();
  #logger = Logger.getInstance();
  #switching = false;
  #recoveryRequired = false;
  #pendingHooks = 0;
  #usageTracker = new ProviderUsageTracker((event, details) => this.#diagnose(event, details));

  /** DI 容器注入: 清除 AI 依赖 singleton 的回调 */
  #clearDependents: (() => string[]) | null = null;

  /** DI 数据管道: 切换时同步 singletons 中的 provider 引用（供 DI 工厂函数读取） */
  #syncToDi: ((provider: ManagedAiProvider, embed: ManagedAiProvider | null) => void) | null = null;

  constructor(initialProvider: ManagedAiProvider) {
    this.#providerInfo(initialProvider);
    this.#provider = initialProvider;
    this.#usageTracker.bind(initialProvider);
  }

  // ═══════════════════════════════════════════════════════
  //  读取接口
  // ═══════════════════════════════════════════════════════

  /** 当前 AI Provider (只读) */
  get provider(): ManagedAiProvider {
    return this.#provider;
  }

  /** 独立显式配置；缺席时不把生成模型当作 embedding 服务。 */
  get embedProvider(): ManagedAiProvider | null {
    return this.#embedProvider;
  }

  /** 兼容旧读取入口，与 embedProvider 相同。 */
  get rawEmbedProvider(): ManagedAiProvider | null {
    return this.#embedProvider;
  }

  /** 是否处于 Mock 模式 */
  get isMock(): boolean {
    return this.#provider.name === 'mock';
  }

  /** 已配置真实 provider，且没有未修复的宿主同步失败。 */
  get isReady(): boolean {
    return !this.isMock && !this.#recoveryRequired;
  }

  /** 当前 provider 名称 */
  get name(): string {
    return this.#provider.name;
  }

  /** 当前模型 */
  get model(): string {
    return this.#provider.model;
  }

  /** 结构化信息快照 */
  get info(): ProviderInfo {
    return this.#providerInfo(this.#provider);
  }

  #providerInfo(provider: ManagedAiProvider): ProviderInfo {
    if (
      !provider ||
      typeof provider !== 'object' ||
      typeof provider.name !== 'string' ||
      !provider.name ||
      typeof provider.model !== 'string'
    ) {
      throw new TypeError('Managed provider must have a name and model');
    }
    const supportsEmbedding =
      this.#synchronous(provider.supportsEmbedding?.(), 'capability') ?? false;
    if (typeof supportsEmbedding !== 'boolean') {
      throw new TypeError('Managed provider embedding capability must be boolean');
    }
    return {
      name: provider.name,
      model: provider.model,
      isMock: provider.name === 'mock',
      supportsEmbedding,
    };
  }

  // ═══════════════════════════════════════════════════════
  //  热切换 — 唯一的全局切换入口
  // ═══════════════════════════════════════════════════════

  /**
   * 同步切换。宿主 hooks 必须同步，DI 同步必须允许用旧引用补偿，失效只清缓存。
   * 失败抛 AI_PROVIDER_SWITCH_FAILED（phase/recovery）；观察者失败仅诊断。
   */
  switchProvider(newProvider: ManagedAiProvider): SwitchResult {
    this.#assertRoutingMutable();
    this.#switching = true;
    const previousProvider = this.#provider;
    const previousEmbedding = this.#embedProvider;
    const previousRecovery = this.#recoveryRequired;
    // 本次操作使用固定 hooks；回调中重新绑定只影响下一次切换。
    const syncToDi = this.#syncToDi;
    const clearDependents = this.#clearDependents;
    let phase = 'prepare';
    let published = false;
    let syncAttempted = false;
    const undoBindings: (() => void)[] = [];
    try {
      const previous = this.info;
      const current = this.#providerInfo(newProvider);
      // 生成模型切换不选择、重建或清空独立 embedding。
      const embedding = previousEmbedding;
      phase = 'wire';
      undoBindings.push(this.#usageTracker.bind(newProvider));
      this.#provider = newProvider;
      this.#embedProvider = embedding;
      published = true;
      phase = 'sync';
      if (syncToDi) {
        syncAttempted = true;
        this.#synchronous(syncToDi(newProvider, embedding), 'sync');
      }
      phase = 'invalidate';
      const clearedSingletons = this.#synchronous(clearDependents?.(), 'invalidate') ?? [];
      if (
        !Array.isArray(clearedSingletons) ||
        !clearedSingletons.every((key) => typeof key === 'string')
      ) {
        throw new Error('Dependency clearer must return singleton keys');
      }
      this.#recoveryRequired = false;
      const result: SwitchResult = { previous, current, clearedSingletons: [...clearedSingletons] };
      // 通知不属于提交阶段；观察者异常不能把已经完成的切换伪装为失败。
      phase = 'notify';
      for (const fn of [...this.#listeners]) {
        // 每个订阅者拿独立 DTO；同步异常和异步 rejection 都不改变提交结果。
        observeSafely(
          () =>
            fn({
              previous: { ...result.previous },
              current: { ...result.current },
              clearedSingletons: [...result.clearedSingletons],
            }),
          () => this.#diagnose('listener_failed')
        );
      }
      this.#diagnose(
        'switched',
        { from: previous.name, to: current.name, cleared: result.clearedSingletons },
        'info'
      );
      return result;
    } catch (err: unknown) {
      const compensationErrors: unknown[] = [];
      this.#provider = previousProvider;
      this.#embedProvider = previousEmbedding;
      for (const undo of undoBindings.reverse()) {
        try {
          undo();
        } catch (restoreError: unknown) {
          compensationErrors.push(restoreError);
        }
      }
      if (syncAttempted && syncToDi) {
        try {
          this.#synchronous(syncToDi(previousProvider, previousEmbedding), 'compensate');
        } catch (restoreError: unknown) {
          compensationErrors.push(restoreError);
        }
      }
      this.#recoveryRequired =
        previousRecovery || this.#pendingHooks > 0 || compensationErrors.length > 0;
      const recovery = this.#recoveryRequired
        ? 'required'
        : published
          ? 'routing-restored'
          : 'not-needed';
      this.#diagnose('switch_failed', {
        phase,
        recovery,
        cacheState: phase === 'invalidate' ? 'possibly-invalidated' : 'unchanged',
      });
      // 只补偿路由引用；已失效的缓存和任意宿主副作用不在可逆合同内。
      throw Object.assign(
        new Error(`AI provider switch failed during ${phase}`, {
          cause: compensationErrors.length
            ? new AggregateError(
                [err, ...compensationErrors],
                'Provider switch compensation failed'
              )
            : err,
        }),
        { code: 'AI_PROVIDER_SWITCH_FAILED', phase, recovery }
      );
    } finally {
      this.#switching = false;
    }
  }

  #assertRoutingMutable(): void {
    if (this.#switching || this.#pendingHooks > 0) {
      this.#diagnose('reentrant_switch_rejected');
      throw Object.assign(new Error('AI provider switch is already in progress'), {
        code: 'AI_PROVIDER_SWITCH_IN_PROGRESS',
      });
    }
  }

  #synchronous<T>(value: T, phase: string): T {
    if (!isThenable(value)) {
      return value;
    }
    // 旧 API 是同步提交。不能忽略宿主 Promise 并先宣称切换成功；也不能
    // 让其迟到副作用覆盖下一次切换。挂起期间阻止再次改路由，结束后仍需修复接线。
    this.#recoveryRequired = true;
    this.#pendingHooks += 1;
    const settle = (failed: boolean) => {
      this.#pendingHooks -= 1;
      this.#diagnose('async_hook_settled', { phase, failed, recovery: 'required' });
    };
    void Promise.resolve(value).then(
      () => settle(false),
      () => settle(true)
    );
    this.#diagnose('async_hook_rejected', { phase });
    throw new TypeError(`Provider ${phase} hook must be synchronous`);
  }

  #diagnose(
    event: string,
    details: Record<string, unknown> = {},
    level: 'info' | 'warn' = 'warn'
  ): void {
    try {
      this.#logger[level](`[AiProviderManager] ${event}`, details);
    } catch (err: unknown) {
      // 日志不可改变提交结果或请求结果，也不递归记录日志器自身失败。
      void err;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  Embedding 管理
  // ═══════════════════════════════════════════════════════

  /** 兼容显式旧配置；新宿主的 embedding 由独立 Core port 管理，不参与 LLM 切换。 */
  setEmbedProvider(ep: ManagedAiProvider | null): void {
    this.#assertRoutingMutable();
    if (ep) {
      this.#providerInfo(ep);
      this.#usageTracker.bind(ep);
    }
    this.#embedProvider = ep;
    this.#diagnose('embedding_updated', { provider: ep?.name ?? null }, 'info');
  }

  // ═══════════════════════════════════════════════════════
  //  AOP: Token 追踪
  // ═══════════════════════════════════════════════════════

  /** 注入 TokenRecorder (延迟绑定，避免循环依赖) */
  setTokenRecorder(recorder: TokenRecorder): void {
    this.#usageTracker.setRecorder(recorder);
  }

  // ═══════════════════════════════════════════════════════
  //  事件
  // ═══════════════════════════════════════════════════════

  /** 注册切换监听器，返回取消注册函数 */
  onSwitch(fn: SwitchListener): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  // ═══════════════════════════════════════════════════════
  //  DI 绑定 (仅 ServiceContainer / AiModule 调用)
  // ═══════════════════════════════════════════════════════

  /** 注入同步缓存失效函数；不能依赖 Manager 还原被清理的对象。 */
  _bindDependentClearer(fn: () => string[]): void {
    this.#clearDependents = fn;
  }

  /** 注入同步 DI 赋值函数；失败补偿可能再次以旧引用调用，须可重复赋值。 */
  _bindDiSync(fn: (provider: ManagedAiProvider, embed: ManagedAiProvider | null) => void): void {
    this.#syncToDi = fn;
  }
}
