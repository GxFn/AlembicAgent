/**
 * OpenAiProvider - OpenAI 提供商（薄壳）
 *
 * 方案①重构后，本类只负责 provider 身份与配置；HTTP body 拼装、响应解析、
 * Chat Completions / Responses 协议分支全部下沉到 OpenAiTransport，重试 / 熔断 /
 * 并发 / 用量上报等横切能力由 LLMGateway 的 ReliabilityController 统一提供。
 * chat / chatWithTools / chatWithStructuredOutput / embed 仅委托给基类的 gateway helper。
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

const OPENAI_BASE = 'https://api.openai.com/v1';

export class OpenAiProvider extends AiProvider {
  /** 嵌入模型（保留为公共字段以兼容外部读取），同时透传给 transport。 */
  embedModel: string;

  constructor(config: AiProviderConfig = {}) {
    super(config);
    this.name = 'openai';
    this.model = config.model || process.env.ALEMBIC_AI_MODEL || 'gpt-5.5';
    this.apiKey = config.apiKey || process.env.ALEMBIC_OPENAI_API_KEY || '';
    // 支持通过环境变量覆盖 baseUrl，用于接入 OpenAI 兼容的中转站/代理网关；
    // 与 DeepSeek / Claude provider 的 ALEMBIC_*_BASE_URL 约定保持一致。
    this.baseUrl = config.baseUrl || process.env.ALEMBIC_OPENAI_BASE_URL || OPENAI_BASE;
    this.embedModel =
      config.embedModel || process.env.ALEMBIC_EMBED_MODEL || 'text-embedding-3-small';
    // API 协议风格：'chat'（/chat/completions）或 'responses'（/responses）。
    // 部分中转站只暴露其中一种端点，通过配置或 ALEMBIC_OPENAI_API_STYLE 显式切换，避免 404。
    const styleRaw = (
      (config.apiStyle as string) ||
      process.env.ALEMBIC_OPENAI_API_STYLE ||
      'chat'
    ).toLowerCase();
    const apiStyle = styleRaw === 'responses' ? 'responses' : 'chat';
    // 透传 provider 特有配置给 OpenAiTransport（协议风格与嵌入模型）。
    this._transportExtras = { apiStyle, embedModel: this.embedModel };
    this.logger = Logger.getInstance() as unknown as AiLogger;
  }

  /** OpenAI 支持原生 Function Calling，AgentRuntime 据此跳过文本正则解析。 */
  get supportsNativeToolCalling() {
    return true;
  }

  // ─── 薄壳委托：协议与横切能力由 gateway + transport 承担 ───────────────

  async chat(prompt: string, context: ChatContext = {}): Promise<string> {
    return this._gatewayChat(prompt, context);
  }

  async chatWithTools(
    prompt: string,
    opts: ChatWithToolsOptions = {}
  ): Promise<ChatWithToolsResult> {
    return this._gatewayChatWithTools(prompt, opts);
  }

  async chatWithStructuredOutput(
    prompt: string,
    opts: StructuredOutputOptions = {}
  ): Promise<unknown> {
    return this._gatewayChatWithStructuredOutput(prompt, opts);
  }

  async embed(text: string | string[]): Promise<number[] | number[][]> {
    return this._gatewayEmbed(text);
  }
}

export default OpenAiProvider;
