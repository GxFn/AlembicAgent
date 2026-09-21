/** 管理实例上的用量订阅；不参与路由、DI 或模型调用。 */
import type { ManagedAiProvider, TokenRecorder, TokenUsagePayload } from './contracts.js';
import { observeSafely } from './observers.js';

type UsageCallback = (usage: TokenUsagePayload) => void;

export class ProviderUsageTracker {
  #recorder: TokenRecorder | null = null;
  #bindings = new WeakMap<ManagedAiProvider, UsageCallback>();

  constructor(
    private readonly diagnose: (
      event: string,
      identity: { provider: string; model: string }
    ) => void
  ) {}

  setRecorder(recorder: TokenRecorder): void {
    if (!recorder || typeof recorder.record !== 'function') {
      throw new TypeError('Token recorder must provide record()');
    }
    this.#recorder = recorder;
  }

  /** 返回仅供未提交切换使用的撤销函数；成功切换不卸载旧 hook，以保留在途请求。 */
  bind(provider: ManagedAiProvider): () => void {
    const identity = { provider: provider.name, model: provider.model };
    const previousBinding = this.#bindings.get(provider);
    const previous = provider._onTokenUsage;
    if (previousBinding) {
      if (previous !== previousBinding) {
        // 宿主可能装饰了旧 hook。无法从函数身份判断其调用图；再次包裹会重计。
        // 尊重后来接管单回调槽的宿主，由它决定是否继续转发到原 managed hook。
        this.diagnose('usage_hook_replaced_preserving_host', identity);
      }
      return () => {};
    }
    if (previous != null && typeof previous !== 'function') {
      throw new TypeError('Provider token observer must be a function');
    }
    const hadOwn = Object.hasOwn(provider, '_onTokenUsage');
    const callback: UsageCallback = (usage) => {
      // 在外部观察者可能改写 payload 之前提取归属和数值；SDK 的请求元数据优先。
      const valid =
        usage &&
        Number.isSafeInteger(usage.inputTokens) &&
        usage.inputTokens >= 0 &&
        Number.isSafeInteger(usage.outputTokens) &&
        usage.outputTokens >= 0;
      if (!valid) {
        this.diagnose('invalid_usage_rejected', identity);
      } else if (this.#recorder) {
        const record = {
          source: typeof usage.source === 'string' && usage.source ? usage.source : 'provider',
          provider:
            typeof usage.provider === 'string' && usage.provider
              ? usage.provider
              : identity.provider,
          model: typeof usage.model === 'string' && usage.model ? usage.model : identity.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        };
        // record 没有幂等键，抛错也可能已写入；永不自动重试。
        observeSafely(
          () => this.#recorder?.record(record),
          () => this.diagnose('recorder_failed', identity)
        );
      }
      if (previous) {
        observeSafely(
          () => previous.call(provider, usage),
          () => this.diagnose('usage_observer_failed', identity)
        );
      }
    };
    provider._onTokenUsage = callback;
    this.#bindings.set(provider, callback);
    return () => {
      // 尊重宿主后来设置的 hook；只撤销本次拥有的写入。
      if (provider._onTokenUsage !== callback) {
        // 保留已交给宿主的 managed hook 标记，重试不能再包一层造成重复计量。
        this.diagnose('usage_hook_rollback_preserving_host', identity);
        return;
      }
      if (hadOwn) {
        provider._onTokenUsage = previous;
      } else {
        delete provider._onTokenUsage;
      }
      this.#bindings.delete(provider);
    };
  }
}
