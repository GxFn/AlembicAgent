/**
 * GoogleGeminiProvider - Google Gemini AI 提供商（方案① 薄壳）
 *
 * chat / chatWithTools / chatWithStructuredOutput / embed 委托基类 _gateway* helper，
 * 由 LLMGateway + GoogleTransport 统一承担：
 *   - Gemini REST contents / functionDeclarations / toolConfig 协议拼装
 *   - JSON Schema 清理（去 default/examples，array 强制补 items）
 *   - 原生 JSON mode（responseMimeType + responseSchema 服务端校验）
 *   - thoughtSignature 原样回传（Gemini 3+ 必须，否则后续请求 400）
 *   - batchEmbedContents 嵌入、token 计量与重试 / 熔断 / 并发闸门
 *
 * Gemini 并发默认 2（低于通用默认，规避 Google 配额限制）；
 * 嵌入模型经 _transportExtras 透传，由 GoogleTransport 统一补 'models/' 前缀并兜底默认。
 */

import Logger from '@alembic/core/logging';
import {
  type AiLogger,
  AiProvider,
  type AiProviderConfig,
  type ChatContext,
  type ChatWithToolsOptions,
  type ChatWithToolsResult,
  type StructuredOutputOptions,
} from '../AiProvider.js';

export class GoogleGeminiProvider extends AiProvider {
  constructor(config: AiProviderConfig = {}) {
    super({
      ...config,
      // Gemini 默认并发 2（低于通用默认），规避 Google 配额限制；可被显式配置覆盖。
      maxConcurrency:
        config.maxConcurrency ||
        Number(
          process.env.ALEMBIC_GEMINI_MAX_CONCURRENCY || process.env.ALEMBIC_AI_MAX_CONCURRENCY || 2
        ),
    });
    this.name = 'google';
    // AD5: 上面预先折叠的 maxConcurrency 到达基类时一律呈现为 config 值，
    // 这里用原始输入重推真实来源（Gemini 专属 env 链），保证提示溯源诚实。
    this._maxConcurrencySource = config.maxConcurrency
      ? 'provider-config'
      : process.env.ALEMBIC_GEMINI_MAX_CONCURRENCY || process.env.ALEMBIC_AI_MAX_CONCURRENCY
        ? 'environment'
        : 'conservative-default';
    this.model = config.model || 'gemini-3-flash-preview';
    this.apiKey = config.apiKey || process.env.ALEMBIC_GOOGLE_API_KEY || '';
    this.logger = Logger.getInstance() as unknown as AiLogger;

    // 嵌入模型透传给 GoogleTransport（transport 内部统一补 'models/' 前缀并兜底默认）。
    this._transportExtras = { embedModel: config.embedModel };
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

  async embed(text: string | string[]) {
    return this._gatewayEmbed(text);
  }

  /** Gemini 处理更大的代码摘要预算。 */
  protected get summarizeMaxTokens(): number {
    return 8192;
  }
}
