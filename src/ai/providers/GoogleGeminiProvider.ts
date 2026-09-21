/**
 * GoogleGeminiProvider - Google Gemini AI 提供商（方案① 薄壳）
 *
 * chat / chatWithTools / chatWithStructuredOutput / embed 委托基类 _gateway* helper，
 * 由 LLMGateway + GoogleTransport 统一承担：
 *   - Gemini REST contents / functionDeclarations / toolConfig 协议拼装
 *   - 原生 JSON Schema（parametersJsonSchema / responseJsonSchema，由 SDK 维护）
 *   - 原生 JSON mode 与本仓输出 schema 校验
 *   - thoughtSignature 原样回传（Gemini 3+ 必须，否则后续请求 400）
 *   - batchEmbedContents 嵌入、token 计量与重试 / 熔断 / 并发闸门
 *
 * Gemini 并发默认 2（低于通用默认，规避 Google 配额限制）；
 * 嵌入模型经 _transportExtras 透传，由 GoogleTransport 统一补 'models/' 前缀并兜底默认。
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

  /** 是否支持原生结构化函数调用 */
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
