/**
 * ClaudeProvider - Anthropic Claude AI 提供商（方案① 薄壳）
 *
 * chat / chatWithTools / chatWithStructuredOutput 委托基类 _gateway* helper，
 * 由 LLMGateway + ClaudeTransport 统一承担：
 *   - Anthropic Messages API 协议拼装（顶层 system、content blocks、tool_use/tool_result）
 *   - 连续同角色消息合并、tool_use → 结构化 functionCall 解析
 *   - token 计量与重试 / 熔断 / 并发闸门
 *
 * SDK 选择原生 output_config.format；Gateway 在有 schema 时仍独立执行本地校验。
 * Claude 无嵌入 API，embed 直接返回空数组触发上层降级（与原实现一致）。
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
import { throwIfLlmCancelled } from '../errors.js';

export class ClaudeProvider extends AiProvider {
  constructor(config: AiProviderConfig = {}) {
    const settings = resolveProviderSettings('claude', config);
    super(settings);
    this.name = 'claude';
    this._transportExtras = settings.transportExtras;
    this._maxConcurrencySource = settings.concurrencySource;
    this.logger = Logger.getInstance() as unknown as AiLogger;
  }

  /** 是否支持原生结构化函数调用 */
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

  // Claude 不支持嵌入 API，返回空数组触发上层降级（与原实现一致）。
  override supportsEmbedding(): boolean {
    return false;
  }

  async embed(_text: string | string[], opts: LlmCallOptions = {}) {
    throwIfLlmCancelled(opts.abortSignal);
    return [];
  }
}
