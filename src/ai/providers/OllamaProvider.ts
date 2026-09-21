/**
 * OllamaProvider - Ollama 本地 AI 提供商（方案① 薄壳）
 *
 * 连接本地 Ollama 服务（OpenAI 兼容 API 格式），无需 API Key（使用固定 dummy key）。
 * chat / chatWithTools / chatWithStructuredOutput / embed 委托基类 _gateway* helper，
 * 由 LLMGateway 选用 OpenAiTransport 完成协议拼装、响应解析与横切能力。
 *
 * baseUrl（本地端点）与 embedModel（本地嵌入模型）通过 _transportExtras 透传，
 * 保证本地部署的 LLM / Embedding 模型与端点可配置。
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

// 兼容公开入口；规范化实现由共同配置层持有。
export { normalizeOllamaBaseUrl } from '../configuration.js';

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
