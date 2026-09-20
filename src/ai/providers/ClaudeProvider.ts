/**
 * ClaudeProvider - Anthropic Claude AI 提供商（方案① 薄壳）
 *
 * chat / chatWithTools / chatWithStructuredOutput 委托基类 _gateway* helper，
 * 由 LLMGateway + ClaudeTransport 统一承担：
 *   - Anthropic Messages API 协议拼装（顶层 system、content blocks、tool_use/tool_result）
 *   - 连续同角色消息合并、tool_use → 结构化 functionCall 解析
 *   - token 计量与重试 / 熔断 / 并发闸门
 *
 * 当前 transport 未传原生输出 schema；Gateway 保留文本提取，并在有 schema 时本地校验。
 * Claude 无嵌入 API，embed 直接返回空数组触发上层降级（与原实现一致）。
 */

import Logger from '@alembic/core/logging';
import { AiProvider } from '../AiProvider.js';
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

const CLAUDE_BASE = 'https://api.anthropic.com/v1';

export class ClaudeProvider extends AiProvider {
  constructor(config: AiProviderConfig = {}) {
    super(config);
    this.name = 'claude';
    this.model = config.model || process.env.ALEMBIC_AI_MODEL || 'claude-sonnet-4-6';
    this.apiKey = config.apiKey || process.env.ALEMBIC_CLAUDE_API_KEY || '';
    this.baseUrl = config.baseUrl || process.env.ALEMBIC_CLAUDE_BASE_URL || CLAUDE_BASE;
    // Claude 上游通常自带退避语义，保持 maxRetries=0 避免叠加放大；gateway 据此关闭重试。
    this.maxRetries = 0;
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
