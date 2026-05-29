/**
 * reliability — LLM 调用的可靠性控制器（有状态，可复用横切能力）
 *
 * 背景：重试、熔断、并发闸门、429 冷却窗历史上内联在 AiProvider 实例里，Gateway 层
 * 想要同样的可靠性只能重写，必然漂移。本类把这套「有状态」横切能力封装成独立单元，
 * Provider 与 Gateway 都可持有一个实例复用，新增厂商不必重复实现。
 *
 * 行为与 AiProvider._withRetry / _acquireRequestSlot / _setRateLimitWindow 对齐：
 *   - 指数退避重试，错误分类复用 shared/error-classify
 *   - 熔断器三态 CLOSED / OPEN / HALF_OPEN，连续服务端失败达阈值后快速失败
 *   - Provider 级并发闸门（信号量）
 *   - 429 自适应冷却窗，抑制并发重试风暴
 *
 * 注意：本控制器是厂商无关的；模型协议细节仍由 Transport 负责，控制器只在
 * Transport 调用外层包裹可靠性逻辑。
 */

import { classifyLlmError } from './error-classify.js';

/** 日志回调，level 与现有 logger 对齐（info/warn/error）。 */
export type ReliabilityLogFn = (level: string, message: string) => void;

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

export class ReliabilityController {
  readonly maxRetries: number;
  readonly label: string;

  // ── 熔断器状态 ──
  circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  circuitFailures = 0;
  circuitOpenedAt = 0;
  circuitCooldownMs = 30_000;
  readonly circuitThreshold: number;

  // ── 并发闸门 + 429 冷却窗 ──
  readonly maxConcurrency: number;
  activeRequests = 0;
  private requestQueue: Array<() => void> = [];
  rateLimitedUntil = 0;

  private readonly onLog?: ReliabilityLogFn;

  constructor(opts: ReliabilityOptions = {}) {
    this.maxRetries = opts.maxRetries ?? 3;
    this.circuitThreshold = opts.circuitThreshold ?? 5;
    this.maxConcurrency = Math.max(
      1,
      Number(opts.maxConcurrency || process.env.ALEMBIC_AI_MAX_CONCURRENCY || 4)
    );
    this.label = opts.label || 'llm';
    this.onLog = opts.onLog;
  }

  private log(level: string, message: string): void {
    this.onLog?.(level, message);
  }

  async acquireSlot(): Promise<void> {
    if (this.activeRequests < this.maxConcurrency) {
      this.activeRequests += 1;
      return;
    }
    await new Promise<void>((resolve) => this.requestQueue.push(resolve));
    this.activeRequests += 1;
  }

  releaseSlot(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    const next = this.requestQueue.shift();
    if (next) {
      next();
    }
  }

  async waitForRateLimitWindow(): Promise<void> {
    const waitMs = this.rateLimitedUntil - Date.now();
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  setRateLimitWindow(waitMs: number): void {
    const safeWait = Math.max(0, Number(waitMs) || 0);
    if (safeWait <= 0) {
      return;
    }
    const until = Date.now() + safeWait;
    if (until > this.rateLimitedUntil) {
      this.rateLimitedUntil = until;
      this.log('warn', `[RateLimit] ${this.label} enters cooldown ${Math.round(safeWait / 1000)}s`);
    }
  }

  /**
   * 在可靠性包裹下执行一次 LLM 调用。
   *
   * @param fn 实际的 Transport 调用
   * @param retries 本次重试上限（默认控制器配置）
   * @param baseDelay 退避基数毫秒（默认 2000）
   */
  async run<T>(fn: () => Promise<T>, retries = this.maxRetries, baseDelay = 2000): Promise<T> {
    // ── 熔断器检查 ──
    if (this.circuitState === 'OPEN') {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed < this.circuitCooldownMs) {
        throw makeCircuitOpenError(
          `AI 服务熔断中 (连续 ${this.circuitFailures} 次失败)，${Math.ceil((this.circuitCooldownMs - elapsed) / 1000)}s 后恢复`
        );
      }
      this.circuitState = 'HALF_OPEN';
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      let slotAcquired = false;
      try {
        await this.waitForRateLimitWindow();
        await this.acquireSlot();
        slotAcquired = true;

        const result = await fn();
        // 成功 → 完全重置熔断器
        this.circuitFailures = 0;
        this.circuitState = 'CLOSED';
        this.circuitCooldownMs = 30_000;
        return result;
      } catch (err: unknown) {
        const e = err as Error & { status?: number; retryAfterMs?: number };
        const { isAbort, isNetworkError, isRetryable, isServerError, causeCode } =
          classifyLlmError(e);

        // AbortError — 外部主动中止，不重试直接抛出
        if (isAbort) {
          throw e;
        }

        // 429：触发冷却窗，抑制并发重试风暴
        if (e.status === 429) {
          const retryAfterMs = Number(e.retryAfterMs || 0);
          const adaptiveCooldown = Math.max(
            retryAfterMs,
            Math.round(baseDelay * 2 ** attempt * 1.5 + Math.random() * 1000)
          );
          this.setRateLimitWindow(adaptiveCooldown);
        }

        // 首次失败记录详细诊断（含 cause）
        if (attempt === 0 && (isNetworkError || (e as { cause?: unknown }).cause)) {
          this.log(
            'warn',
            `[reliability] ${e.message} — cause: ${(e as { cause?: { message?: string } }).cause?.message || causeCode || 'unknown'}`
          );
        }

        if (attempt >= retries || !isRetryable) {
          // 只有服务端 / 网络错误才累计熔断计数；客户端错误 (4xx 非 429) 不触发熔断
          if (isServerError) {
            this.circuitFailures += 1;
            if (this.circuitFailures >= this.circuitThreshold) {
              this.circuitState = 'OPEN';
              this.circuitOpenedAt = Date.now();
              const cooldown = this.circuitCooldownMs;
              this.log(
                'warn',
                `[CircuitBreaker] ${this.label} OPEN — ${this.circuitFailures} consecutive failures, cooldown ${cooldown / 1000}s`
              );
              this.circuitCooldownMs = Math.min(cooldown * 2, 300_000);
            }
          }
          throw e;
        }

        const delay = baseDelay * 2 ** attempt + Math.random() * 1000;
        this.log(
          'info',
          `[reliability] attempt ${attempt + 1} failed (${e.message}), retrying in ${Math.round(delay / 1000)}s…`
        );
        await new Promise((r) => setTimeout(r, delay));
      } finally {
        if (slotAcquired) {
          this.releaseSlot();
        }
      }
    }
    // 不应到达：最后一轮要么 return 要么 throw
    throw new Error('[reliability] unexpected retry exhaustion');
  }
}
