/**
 * DeepSeekProvider - DeepSeek AI 提供商（方案① 薄壳）
 *
 * chat / chatWithTools / chatWithStructuredOutput / embed 全部委托基类 _gateway* helper，
 * 由 LLMGateway + DeepSeekTransport 统一承担：
 *   - DeepSeek Chat Completions（OpenAI 兼容）协议拼装与响应解析
 *   - V4 thinking 模式（chat/structured 关闭 thinking 省 token，tools 开启 thinking）
 *   - reasoning_content 在带 tool_calls 的 assistant 消息中的强制回传
 *   - max_tokens 在 thinking+tools 场景的自动提升
 *   - 重试 / 熔断 / 并发闸门 / 用量上报等横切能力
 *
 * DeepSeek 专属的 reasoning_effort（high/max）通过 _transportExtras 透传给 DeepSeekTransport。
 * embed 模型由共同配置层解析，兼容端点继续由 DeepSeekTransport 调用。
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
