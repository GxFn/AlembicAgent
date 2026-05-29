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
 * embed 由 DeepSeekTransport 固定使用 deepseek-embedding 模型，无需在此透传。
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

const DEEPSEEK_BASE = 'https://api.deepseek.com';
const VALID_EFFORTS = new Set(['high', 'max']);

export class DeepSeekProvider extends AiProvider {
  constructor(config: AiProviderConfig = {}) {
    super(config);
    this.name = 'deepseek';
    this.model = config.model || process.env.ALEMBIC_AI_MODEL || 'deepseek-v4-flash';
    this.apiKey = config.apiKey || process.env.ALEMBIC_DEEPSEEK_API_KEY || '';
    this.baseUrl = config.baseUrl || process.env.ALEMBIC_DEEPSEEK_BASE_URL || DEEPSEEK_BASE;
    this.logger = Logger.getInstance() as unknown as AiLogger;

    // V4 推理力度 high(默认)/max；透传给 DeepSeekTransport 决定 thinking 模式下的 reasoning_effort。
    const effort =
      (config.reasoningEffort as string) || process.env.ALEMBIC_DEEPSEEK_REASONING_EFFORT || 'high';
    this._transportExtras = {
      reasoningEffort: VALID_EFFORTS.has(effort) ? effort : 'high',
    };
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
