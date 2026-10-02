/**
 * OllamaProvider - Ollama 本地 AI 提供商（薄壳）
 *
 * 连接本地 Ollama 服务（OpenAI 兼容 API 格式），无需 API Key（configuration 补固定 dummy key）。
 *
 * 职责分工：
 *   - 本类：provider 身份、配置与默认值（经 configuration.resolveProviderSettings 解析，
 *     含 baseUrl 规范化与 embedModel 默认值）。
 *   - wire 协议：由 @ai-sdk/openai 维护，LLMGateway 以 'ollama' 身份选用 OpenAiTransport
 *     做本仓 DTO ↔ SDK 的边界转换。
 *   - 重试 / 熔断 / 并发闸门 / 用量上报：在 LLMGateway 的 ReliabilityController。
 * chat / chatWithTools / chatWithStructuredOutput / embed 仅委托基类 _gateway* helper。
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

export class OllamaProvider extends AiProvider {
  embedModel: string;

  constructor(config: AiProviderConfig = {}) {
    const settings = resolveProviderSettings('ollama', config);
    super(settings);
    this.name = 'ollama';
    this._transportExtras = settings.transportExtras;
    this._maxConcurrencySource = settings.concurrencySource;
    this.logger = Logger.getInstance() as unknown as AiLogger;
    this.embedModel = settings.embedModel;
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

  async embed(text: string | string[], opts: LlmCallOptions = {}) {
    return this._gatewayEmbed(text, opts);
  }
}
