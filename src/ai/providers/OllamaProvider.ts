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
import {
  type AiLogger,
  AiProvider,
  type AiProviderConfig,
  type ChatContext,
  type ChatWithToolsOptions,
  type ChatWithToolsResult,
  type StructuredOutputOptions,
} from '../AiProvider.js';

const OLLAMA_DEFAULT_BASE = 'http://localhost:11434/v1';
const OLLAMA_DUMMY_KEY = 'ollama';

export class OllamaProvider extends AiProvider {
  embedModel: string;

  constructor(config: AiProviderConfig = {}) {
    super(config);
    this.name = 'ollama';
    this.model = config.model || 'llama3';
    this.apiKey = config.apiKey || OLLAMA_DUMMY_KEY;
    this.baseUrl = config.baseUrl || process.env.ALEMBIC_OLLAMA_BASE_URL || OLLAMA_DEFAULT_BASE;
    this.embedModel = config.embedModel || 'qwen3-embedding:0.6b';
    this.logger = Logger.getInstance() as unknown as AiLogger;

    // 透传嵌入模型给 OpenAiTransport（Ollama 走 OpenAI 兼容 /embeddings）。
    this._transportExtras = { embedModel: this.embedModel };
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

  async embed(text: string | string[]) {
    return this._gatewayEmbed(text);
  }

  async summarize(code: string) {
    const prompt = `请对以下代码生成结构化摘要，返回 JSON 格式 {title, description, language, patterns: [], keyAPIs: []}:\n\n${code}`;
    return (
      (await this.chatWithStructuredOutput(prompt, { temperature: 0.3, maxTokens: 4096 })) || {
        title: '',
        description: '',
      }
    );
  }
}
