/**
 * DeepSeekProvider - DeepSeek AI 提供商（薄壳）
 *
 * 职责分工：
 *   - 本类：provider 身份、配置与默认值（经 configuration.resolveProviderSettings 解析）。
 *   - wire 协议：由 @ai-sdk/deepseek 维护；DeepSeekTransport 负责 DTO ↔ SDK 边界转换，
 *     以及 SDK 之外的本仓兼容逻辑（如文本工具调用兼容解析、可配置的兼容 /embeddings 端点）。
 *   - 重试 / 熔断 / 并发闸门 / 用量上报：在 LLMGateway 的 ReliabilityController。
 * chat / chatWithTools / chatWithStructuredOutput / embed 仅委托基类 _gateway* helper。
 *
 * DeepSeek 专属的 reasoning_effort（high/max）经 _transportExtras 透传给 DeepSeekTransport；
 * embed 模型由 configuration 解析。
 *
 * supportsEmbedding()：继承基类的 true，含义是「embed 会真实调用已配置的兼容 embedding 端点」，
 * 不代表 DeepSeek 官方提供 embedding；模型注册表中 DeepSeek 模型的 embedding:false 描述的是
 * 官方模型能力，两者口径不同。事项③已按推荐决定保持现状（L2-P21）：不改为仅在显式配置兼容端点时返回 true。
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

export class DeepSeekProvider extends AiProvider {
  constructor(config: AiProviderConfig = {}) {
    const settings = resolveProviderSettings('deepseek', config);
    super(settings);
    this.name = 'deepseek';
    this._transportExtras = settings.transportExtras;
    this._maxConcurrencySource = settings.concurrencySource;
    this.logger = Logger.getInstance() as unknown as AiLogger;
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

  async embed(text: string | string[], opts: LlmCallOptions = {}) {
    return this._gatewayEmbed(text, opts);
  }
}
