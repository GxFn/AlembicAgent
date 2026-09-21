/**
 * OpenAiProvider - OpenAI 提供商（薄壳）
 *
 * 方案①重构后，本类只负责 provider 身份与配置；HTTP body 拼装、响应解析、
 * Chat Completions / Responses 协议分支全部下沉到 OpenAiTransport，重试 / 熔断 /
 * 并发 / 用量上报等横切能力由 LLMGateway 的 ReliabilityController 统一提供。
 * chat / chatWithTools / chatWithStructuredOutput / embed 仅委托给基类的 gateway helper。
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

export class OpenAiProvider extends AiProvider {
  /** 嵌入模型（保留为公共字段以兼容外部读取），同时透传给 transport。 */
  embedModel: string;

  constructor(config: AiProviderConfig = {}) {
    const settings = resolveProviderSettings('openai', config);
    super(settings);
    this.name = 'openai';
    this._transportExtras = settings.transportExtras;
    this._maxConcurrencySource = settings.concurrencySource;
    this.logger = Logger.getInstance() as unknown as AiLogger;
    this.embedModel = settings.embedModel;
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

  async embed(text: string | string[], opts: LlmCallOptions = {}): Promise<number[] | number[][]> {
    return this._gatewayEmbed(text, opts);
  }
}

export default OpenAiProvider;
