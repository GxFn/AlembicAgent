/**
 * OpenAiProvider - OpenAI 提供商（薄壳）
 *
 * 职责分工：
 *   - 本类：provider 身份、配置与默认值（经 configuration.resolveProviderSettings 解析）。
 *   - wire 协议：由 @ai-sdk/openai 维护；OpenAiTransport 做本仓 DTO ↔ SDK 的边界转换，
 *     并按配置的 apiStyle 选择 Chat Completions 或 Responses。
 *   - 重试 / 熔断 / 并发闸门 / 用量上报：在 LLMGateway 的 ReliabilityController。
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

  /** 公开能力标记：chatWithTools 走原生函数调用；当前无运行时读取方（见 AiProvider 同名 getter）。 */
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
