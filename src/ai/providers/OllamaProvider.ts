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

/**
 * Ollama 的 OpenAI 兼容层挂在 /v1 路径，transport 按 `${baseUrl}/embeddings` 直拼。
 * 用户/设置面板常把 baseUrl 配成裸主机端口（http://127.0.0.1:11434）——直拼后
 * /embeddings 对 ollama 是 404（2026-07-06 真机定案：resident 语义道全程未通、
 * "empty_query_embedding" 降级的根因）。裸根路径自动补 /v1 并留痕；显式路径
 * （已带 /v1 或自定义反代前缀）原样保留，只去尾斜杠。
 */
export function normalizeOllamaBaseUrl(rawUrl: string, logger?: AiLogger): string {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/\/+$/, '');
    if (path === '') {
      url.pathname = '/v1';
      const normalized = url.toString().replace(/\/+$/, '');
      logger?.info?.(
        `[ollama] baseUrl normalized to OpenAI-compat /v1: ${rawUrl} -> ${normalized}`
      );
      return normalized;
    }
    return rawUrl.replace(/\/+$/, '');
  } catch {
    // 非法 URL 原样透传，由 transport 请求时报出真实错误。
    return rawUrl;
  }
}

export class OllamaProvider extends AiProvider {
  embedModel: string;

  constructor(config: AiProviderConfig = {}) {
    super(config);
    this.name = 'ollama';
    this.model = config.model || 'llama3';
    this.apiKey = config.apiKey || OLLAMA_DUMMY_KEY;
    this.logger = Logger.getInstance() as unknown as AiLogger;
    this.baseUrl = normalizeOllamaBaseUrl(
      config.baseUrl || process.env.ALEMBIC_OLLAMA_BASE_URL || OLLAMA_DEFAULT_BASE,
      this.logger
    );
    this.embedModel = config.embedModel || 'qwen3-embedding:0.6b';

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
}
