/**
 * ClaudeProvider - Anthropic Claude AI 提供商（薄壳）
 *
 * 职责分工：
 *   - 本类：provider 身份、配置与默认值（经 configuration.resolveProviderSettings 解析）。
 *   - wire 协议：由 @ai-sdk/anthropic 维护，ClaudeTransport 只做本仓 DTO ↔ SDK 的边界转换。
 *   - 重试 / 熔断 / 并发闸门 / 用量上报：在 LLMGateway 的 ReliabilityController。
 * chat / chatWithTools / chatWithStructuredOutput 仅委托基类 _gateway* helper；
 * 结构化输出在有 schema 时由 Gateway 独立执行本地校验。
 * Claude 无嵌入 API：embed 返回空数组供上层降级，并在每个实例首次调用时 warn embedding_unsupported。
 */

import Logger from '@alembic/core/logging';
import { AiProvider } from '../AiProvider.js';
import { resolveProviderSettings } from '../configuration.js';
import type {
  AiLogger,
  AiProviderConfig,
  ChatContext,
  ChatWithToolsOptions,
  ChatWithToolsResult,
  LlmCallOptions,
  StructuredOutputOptions,
} from '../contracts.js';
import { throwIfLlmCancelled } from '../errors.js';

export class ClaudeProvider extends AiProvider {
  /** embed 不支持告警是否已发出（每实例一次）。 */
  #embedUnsupportedWarned = false;

  constructor(config: AiProviderConfig = {}) {
    const settings = resolveProviderSettings('claude', config);
    super(settings);
    this.name = 'claude';
    this._transportExtras = settings.transportExtras;
    this._maxConcurrencySource = settings.concurrencySource;
    this.logger = Logger.getInstance() as unknown as AiLogger;
  }

  /** 公开能力标记：chatWithTools 走原生函数调用；当前无运行时读取方（见 AiProvider 同名 getter）。 */
  get supportsNativeToolCalling() {
    return true;
  }

  async chat(prompt: string, context: ChatContext = {}) {
    return this._gatewayChat(prompt, context);
  }

  async chatWithTools(
    prompt: string,
    opts: ChatWithToolsOptions = {}
  ): Promise<ChatWithToolsResult> {
    return this._gatewayChatWithTools(prompt, opts);
  }

  async chatWithStructuredOutput(prompt: string, opts: StructuredOutputOptions = {}) {
    return this._gatewayChatWithStructuredOutput(prompt, opts);
  }

  // Claude 不支持嵌入 API：能力标记为 false，embed 返回空数组触发上层降级。
  override supportsEmbedding(): boolean {
    return false;
  }

  async embed(_text: string | string[], opts: LlmCallOptions = {}) {
    throwIfLlmCancelled(opts.abortSignal);
    // [] 是有意保留的兼容结果（上层据此降级）；这里只补可定位诊断，每实例只记一次避免批量嵌入刷屏。
    if (!this.#embedUnsupportedWarned) {
      this.#embedUnsupportedWarned = true;
      this._log(
        'warn',
        '[claude] embedding_unsupported; returning empty result for upper-layer degrade'
      );
    }
    return [];
  }
}
