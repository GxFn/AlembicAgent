/**
 * reliability — LLM 调用的可靠性控制器（有状态，可复用横切能力）
 *
 * Gateway 按 provider 持有控制器；每次 HTTP 尝试都重新核对取消、冷却和熔断。
 * 槽位只包住在途调用，重试等待不占槽；半开探活按逻辑请求独占，跨重试保留。
 * 熔断世代隔离旧请求的迟到结果；协议转换与 HTTP 期限仍由 Transport 负责。
 */

import { observeSafely } from '#shared/observers.js';
import { createLlmAbortError, throwIfLlmCancelled } from '../errors.js';
import { resolveConcurrency } from './concurrency.js';
import { classifyLlmError } from './errorClassify.js';

/** 日志回调，level 与现有 logger 对齐（info/warn/error）。 */
export type ReliabilityLogFn = (level: string, message: string) => void;

/** 单次可靠性调用选项。 */
export interface ReliabilityRunOptions {
  /** 外部主动中止信号；排队、冷却窗等待与重试等待都必须可取消。 */
  abortSignal?: AbortSignal | null;
}

/** 控制器构造选项。 */
export interface ReliabilityOptions {
  /** 最大重试次数（不含首次尝试），默认 3。 */
  maxRetries?: number;
  /** 触发熔断的连续服务端失败次数，默认 5。 */
  circuitThreshold?: number;
  /** 并发上限，默认取 ALEMBIC_AI_MAX_CONCURRENCY 或 4。 */
  maxConcurrency?: number | string;
  /** 标签，用于日志（通常为 provider 名）。 */
  label?: string;
  /** 可选日志回调。 */
  onLog?: ReliabilityLogFn;
}

/** 熔断中错误（与 AiProvider 一致，code=CIRCUIT_OPEN）。 */
function makeCircuitOpenError(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = 'CIRCUIT_OPEN';
  return err;
}

const MAX_TIMER_MS = 2_147_483_647;

interface QueuedRequestSlot {
  resolve: () => void;
  reject: (err: Error) => void;
  abortSignal: AbortSignal | null;
  onAbort: (() => void) | null;
}

export class ReliabilityController {
  readonly maxRetries: number;
  readonly label: string;

  // ── 熔断器状态 ──
  circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  circuitFailures = 0;
  circuitOpenedAt = 0;
  /** 保留旧观察字段：下一次打开时使用的退避窗口。当前窗口单独固定。 */
  circuitCooldownMs = 30_000;
  readonly circuitThreshold: number;

  // ── 并发闸门 + 429 冷却窗 ──
  readonly maxConcurrency: number;
  activeRequests = 0;
  private requestQueue: QueuedRequestSlot[] = [];
  rateLimitedUntil = 0;

  private readonly onLog?: ReliabilityLogFn;
  private activeCircuitCooldownMs = 30_000;
  private circuitEpoch = 0;
  private probeOwner: symbol | null = null;

  constructor(opts: ReliabilityOptions = {}) {
    this.maxRetries = opts.maxRetries ?? 3;
    this.circuitThreshold = opts.circuitThreshold ?? 5;
    this.maxConcurrency = resolveConcurrency(opts.maxConcurrency).value;
    this.label = opts.label || 'llm';
    this.onLog = opts.onLog;
  }

  private log(level: string, message: string): void {
    // 日志观察者不可改变请求结果/占用许可；同一日志通道失败时不递归报告自身。
    observeSafely(
      () => this.onLog?.(level, message),
      () => undefined
    );
  }

  async acquireSlot(abortSignal: AbortSignal | null = null): Promise<void> {
    if (abortSignal?.aborted) {
      throw createLlmAbortError(abortSignal.reason);
    }
    if (this.activeRequests < this.maxConcurrency) {
      this.activeRequests += 1;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const queued: QueuedRequestSlot = {
        resolve,
        reject,
        abortSignal,
        onAbort: null,
      };
      queued.onAbort = () => {
        const index = this.requestQueue.indexOf(queued);
        if (index >= 0) {
          this.requestQueue.splice(index, 1);
        }
        reject(createLlmAbortError(abortSignal?.reason));
      };
      abortSignal?.addEventListener('abort', queued.onAbort, { once: true });
      this.requestQueue.push(queued);
    });
  }

  releaseSlot(): void {
    const next = this.requestQueue.shift();
    if (next) {
      if (next.onAbort) {
        next.abortSignal?.removeEventListener('abort', next.onAbort);
      }
      if (next.abortSignal?.aborted) {
        next.reject(createLlmAbortError(next.abortSignal.reason));
        this.releaseSlot();
        return;
      }
      next.resolve();
      return;
    }
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  async waitForRateLimitWindow(abortSignal: AbortSignal | null = null): Promise<void> {
    throwIfLlmCancelled(abortSignal);
    // 其他请求可能延长429窗口；醒来后必须读最新期限，不能仅使用入队时快照。
    while (this.rateLimitedUntil > Date.now()) {
      await this.abortableDelay(this.rateLimitedUntil - Date.now(), abortSignal);
    }
  }

  private async abortableDelay(waitMs: number, abortSignal: AbortSignal | null): Promise<void> {
    const deadline = Date.now() + waitMs;
    throwIfLlmCancelled(abortSignal);
    while (deadline > Date.now()) {
      // Node 对超过32位的timer会回退到1ms；长Retry-After分段等候，避免请求风暴。
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => {
            abortSignal?.removeEventListener('abort', onAbort);
            resolve();
          },
          Math.min(deadline - Date.now(), MAX_TIMER_MS)
        );
        const onAbort = () => {
          clearTimeout(timeout);
          abortSignal?.removeEventListener('abort', onAbort);
          reject(createLlmAbortError(abortSignal?.reason));
        };
        abortSignal?.addEventListener('abort', onAbort, { once: true });
      });
      throwIfLlmCancelled(abortSignal);
    }
  }

  setRateLimitWindow(waitMs: number): void {
    const safeWait = Math.max(0, Number(waitMs) || 0);
    if (!Number.isFinite(safeWait) || safeWait <= 0) {
      this.log('debug', `[RateLimit] ${this.label} ignores invalid/nonpositive cooldown`);
      return;
    }
    const until = Date.now() + safeWait;
    if (until > this.rateLimitedUntil) {
      this.rateLimitedUntil = until;
      this.log('warn', `[RateLimit] ${this.label} enters cooldown ${Math.round(safeWait / 1000)}s`);
    }
  }

  private assertCircuitAvailable(owner: symbol): void {
    const remaining = this.activeCircuitCooldownMs - (Date.now() - this.circuitOpenedAt);
    if (
      (this.circuitState === 'OPEN' && remaining > 0) ||
      (this.circuitState === 'HALF_OPEN' && this.probeOwner !== null && this.probeOwner !== owner)
    ) {
      const reason =
        this.circuitState === 'HALF_OPEN'
          ? 'recovery probe in flight'
          : `cooldown ${Math.ceil(remaining / 1000)}s`;
      this.log('debug', `[CircuitBreaker] ${this.label} request blocked: ${reason}`);
      throw makeCircuitOpenError(`AI 服务熔断中 (${reason})`);
    }
  }

  /** 最后一次门禁与调用启动必须同步完成，不能把过时的许可跨 await 交给调用者。 */
  private async startAttempt<T>(
    owner: symbol,
    signal: AbortSignal | null,
    fn: () => Promise<T>
  ): Promise<{ epoch: number; result: Promise<T> }> {
    for (;;) {
      throwIfLlmCancelled(signal);
      this.assertCircuitAvailable(owner);
      await this.waitForRateLimitWindow(signal);
      await this.acquireSlot(signal);
      try {
        throwIfLlmCancelled(signal);
        this.assertCircuitAvailable(owner);
        if (this.circuitState === 'OPEN') {
          this.circuitState = 'HALF_OPEN';
          this.probeOwner = owner;
          this.log('info', `[CircuitBreaker] ${this.label} HALF_OPEN — one recovery request`);
        }
        // 观察者也可能主动取消或延长冷却；任何回调之后都重新核对再启动传输。
        throwIfLlmCancelled(signal);
        this.assertCircuitAvailable(owner);
        if (this.rateLimitedUntil > Date.now()) {
          this.releaseSlot();
          this.log('debug', `[RateLimit] ${this.label} queued request returns to cooldown`);
          continue;
        }
        if (this.circuitState === 'HALF_OPEN') {
          this.probeOwner = owner;
        }
        return {
          epoch: this.circuitEpoch,
          // executor 同步启动 fn；同步 throw 也成为业务结果，由 run 记账后归还槽位。
          result: new Promise<T>((resolve) => resolve(fn())),
        };
      } catch (err: unknown) {
        this.releaseSlot();
        throw err;
      }
    }
  }

  private recordSuccess(epoch: number): void {
    if (epoch !== this.circuitEpoch) {
      this.log(
        'debug',
        `[CircuitBreaker] ${this.label} stale success does not change current circuit`
      );
      return;
    }
    this.circuitFailures = 0;
    this.circuitState = 'CLOSED';
    this.circuitCooldownMs = 30_000;
    this.probeOwner = null;
  }

  private recordFailure(epoch: number): void {
    if (epoch !== this.circuitEpoch) {
      this.log(
        'debug',
        `[CircuitBreaker] ${this.label} stale failure does not change current circuit`
      );
      return;
    }
    this.circuitFailures += 1;
    if (this.circuitFailures >= this.circuitThreshold) {
      this.circuitState = 'OPEN';
      this.circuitOpenedAt = Date.now();
      this.activeCircuitCooldownMs = this.circuitCooldownMs;
      this.circuitCooldownMs = Math.min(this.circuitCooldownMs * 2, 300_000);
      this.circuitEpoch += 1;
      this.probeOwner = null;
      this.log(
        'warn',
        `[CircuitBreaker] ${this.label} OPEN — ${this.circuitFailures} consecutive failures, cooldown ${this.activeCircuitCooldownMs / 1000}s`
      );
    }
  }

  /**
   * 在可靠性包裹下执行一次 LLM 调用。
   *
   * @param fn 实际的 Transport 调用
   * @param retries 本次重试上限（默认控制器配置）
   * @param baseDelay 退避基数毫秒（默认 2000）
   */
  async run<T>(
    fn: () => Promise<T>,
    retries = this.maxRetries,
    baseDelay = 2000,
    opts: ReliabilityRunOptions = {}
  ): Promise<T> {
    const abortSignal = opts.abortSignal || null;
    const owner = Symbol('reliability-request');
    try {
      for (let attempt = 0; attempt <= retries; attempt++) {
        // 准入拒绝不是远端失败，不进入重试/计数catch。
        const { epoch, result: pending } = await this.startAttempt(owner, abortSignal, fn);
        let delay = 0;
        try {
          const result = await pending;
          throwIfLlmCancelled(abortSignal);
          this.recordSuccess(epoch);
          return result;
        } catch (err: unknown) {
          throwIfLlmCancelled(abortSignal, err);
          const { isAbort, isNetworkError, isRetryable, isServerError, causeCode, status } =
            classifyLlmError(err);

          // AbortError — 外部主动中止，不重试直接抛出
          if (isAbort) {
            throw createLlmAbortError(err);
          }

          // 兼容自定义 transport 的结构化异常：先按原值分类，再只保留已知标量元数据。
          const details = typeof err === 'object' && err !== null ? err : {};
          const retryAfterMs =
            'retryAfterMs' in details &&
            typeof details.retryAfterMs === 'number' &&
            Number.isFinite(details.retryAfterMs)
              ? Math.max(0, details.retryAfterMs)
              : 0;
          const e =
            err instanceof Error
              ? err
              : Object.assign(new Error('LLM operation failed', { cause: err }), {
                  status,
                  retryAfterMs,
                  ...('code' in details && typeof details.code === 'string'
                    ? { code: details.code }
                    : {}),
                  ...('name' in details && typeof details.name === 'string'
                    ? { name: details.name }
                    : {}),
                });

          // 429：触发冷却窗，抑制并发重试风暴
          if (status === 429) {
            const adaptiveCooldown = Math.max(
              retryAfterMs,
              Math.round(baseDelay * 2 ** attempt * 1.5 + Math.random() * 1000)
            );
            this.setRateLimitWindow(adaptiveCooldown);
          }

          // 首次失败记录详细诊断（含 cause）
          if (attempt === 0 && err instanceof Error && (isNetworkError || err.cause)) {
            this.log(
              'warn',
              `[reliability] ${e.message} — cause: ${(e as { cause?: { message?: string } }).cause?.message || causeCode || 'unknown'}`
            );
          }

          if (attempt >= retries || !isRetryable) {
            // 只有服务端 / 网络错误才累计熔断计数；客户端错误 (4xx 非 429) 不触发熔断
            if (isServerError) {
              this.recordFailure(epoch);
            }
            throw e;
          }

          delay = baseDelay * 2 ** attempt + Math.random() * 1000;
          this.log(
            'info',
            `[reliability] attempt ${attempt + 1} failed (${e.message}), retrying in ${Math.round(delay / 1000)}s…`
          );
        } finally {
          this.releaseSlot();
        }
        await this.abortableDelay(delay, abortSignal);
      }
      // 不应到达：最后一轮要么 return 要么 throw
      throw new Error('[reliability] unexpected retry exhaustion');
    } catch (err: unknown) {
      if (classifyLlmError(err).isAbort) {
        this.log('warn', `[reliability] ${this.label} request cancelled; no failure accounting`);
      }
      throw err;
    } finally {
      // 中止或本地输入错误也必须归还半开许可；下个请求可以继续核验服务。
      if (this.probeOwner === owner) {
        this.probeOwner = null;
      }
    }
  }
}
