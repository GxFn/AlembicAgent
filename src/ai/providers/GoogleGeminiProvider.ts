/**
 * GoogleGeminiProvider - Google Gemini AI 提供商（薄壳）
 *
 * 职责分工：
 *   - 本类：provider 身份、配置与默认值（经 configuration.resolveProviderSettings 解析），
 *     以及 Gemini 专属的 chat / summarize 输出上限 8192。
 *   - wire 协议：由 @ai-sdk/google 维护（contents、函数声明、原生 JSON Schema、
 *     thoughtSignature 回传等），GoogleTransport 只做本仓 DTO ↔ SDK 的边界转换。
 *   - 重试 / 熔断 / 并发闸门 / 用量上报：在 LLMGateway 的 ReliabilityController。
 * chat / chatWithTools / chatWithStructuredOutput / embed 仅委托基类 _gateway* helper。
 *
 * Gemini 并发默认 2（低于通用默认，规避 Google 配额限制）；
 * embedModel 默认值由 configuration 解析，GoogleTransport 去掉可选的 'models/' 前缀。
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

export class GoogleGeminiProvider extends AiProvider {
  constructor(config: AiProviderConfig = {}) {
    const settings = resolveProviderSettings('google', config);
    super(settings);
    this.name = 'google';
    this._transportExtras = settings.transportExtras;
    this._maxConcurrencySource = settings.concurrencySource;
    this.logger = Logger.getInstance() as unknown as AiLogger;
  }

  /** 公开能力标记：chatWithTools 走原生函数调用；当前无运行时读取方（见 AiProvider 同名 getter）。 */
  get supportsNativeToolCalling() {
    return true;
  }

  async chat(prompt: string, context: ChatContext = {}) {
    // Gemini chat 默认 maxOutputTokens 8192（高于通用 4096），保持原实现上限。
    return this._gatewayChat(prompt, {
      ...context,
      maxTokens: context.maxTokens ?? 8192,
    });
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

  async embed(text: string | string[], opts: LlmCallOptions = {}) {
    return this._gatewayEmbed(text, opts);
  }

  /** Gemini 处理更大的代码摘要预算。 */
  protected get summarizeMaxTokens(): number {
    return 8192;
  }
}
