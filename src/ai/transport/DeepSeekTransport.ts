/** DeepSeek wire 协议交给 SDK；V4 策略与文本工具兼容仍由本仓显式管理。 */
import { createDeepSeek, type DeepSeekProvider as DeepSeekSdkProvider } from '@ai-sdk/deepseek';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import Logger from '@alembic/core/logging';
import type { LlmCallOptions, UnifiedMessage } from '../contracts.js';
import { parseDeepSeekTextToolCalls } from '../deepseekToolCallCompat.js';
import { normalizeToolTranscriptForChatCompletions } from '../toolTranscript.js';
import {
  LLMTransport,
  type TransportConfig,
  type TransportRequest,
  type TransportResponse,
} from './LLMTransport.js';
import { type SdkCallContext, sdkConnection } from './sdkContext.js';
import { normalizeSdkError } from './sdkErrors.js';
import { isRecord, sdkCallOptions, sdkResponse } from './sdkProtocol.js';

const V4_PATTERN = /deepseek-(?:v4|flash|pro)/i;

export class DeepSeekTransport extends LLMTransport {
  readonly #client: DeepSeekSdkProvider;
  readonly #reasoningEffort: string;
  readonly #connection: string;
  constructor(config: TransportConfig) {
    super('deepseek', config);
    this.#reasoningEffort = this.settings.reasoningEffort;
    this.#connection = sdkConnection(this.providerId, this.baseUrl, this.apiKey);
    this.#client = createDeepSeek({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      fetch: (url, options) => this.fetchWithProxy(url, options),
    });
  }

  async chat(request: TransportRequest): Promise<string> {
    return (
      (await this.chatWithTools({ ...request, tools: undefined, toolChoice: 'none' })).text || ''
    );
  }

  async chatWithTools(request: TransportRequest): Promise<TransportResponse> {
    this.requireApiKey('DeepSeek');
    const isV4 = V4_PATTERN.test(request.model);
    const hasTools = Boolean(request.tools?.length) && request.toolChoice !== 'none';
    const normalized = normalizeToolTranscriptForChatCompletions(
      request.messages.map((message) => ({ ...message }))
    );
    if (normalized.normalizedCount) {
      Logger.getInstance().warn(
        `[DeepSeekTransport] normalized ${normalized.normalizedCount} incomplete tool transcript messages before request`
      );
    }
    // 纯本仓投影仅保留 UnifiedMessage 或生成同合同的 user/assistant 文本；不是厂商 JSON 断言。
    const messages = normalized.messages as unknown as UnifiedMessage[];
    const effort = request.reasoningEffort || this.#reasoningEffort;
    const minTokens = effort === 'max' ? 32768 : 16384;
    const maxTokens =
      isV4 && hasTools ? Math.max(request.maxTokens || 0, minTokens) : request.maxTokens;
    if (maxTokens !== request.maxTokens) {
      Logger.getInstance().debug(
        `[DeepSeekTransport] compat_reasoning_budget requested=${request.maxTokens ?? 0} effective=${maxTokens} effort=${effort}`
      );
    }
    const effective: TransportRequest = {
      ...request,
      messages,
      maxTokens,
      tools: hasTools ? request.tools : undefined,
      toolChoice: isV4 ? undefined : request.toolChoice,
      temperature: isV4 && hasTools ? undefined : request.temperature,
    };
    const context: SdkCallContext = {
      provider: this.providerId,
      model: request.model,
      protocol: 'deepseek',
      connection: this.#connection,
    };
    const options = sdkCallOptions(effective, context);
    if (isV4) {
      options.providerOptions = {
        deepseek: {
          thinking: { type: hasTools ? 'enabled' : 'disabled' },
          ...(hasTools ? { reasoningEffort: effort } : {}),
        },
      };
    }
    const model = this.#client.chat(request.model);
    let result: LanguageModelV4GenerateResult;
    try {
      result = await this.runRequest(
        (signal) => model.doGenerate({ ...options, abortSignal: signal }),
        request.abortSignal
      );
    } catch (err: unknown) {
      throw normalizeSdkError(err, this.providerId);
    }
    if (hasTools && !result.content.some((part) => part.type === 'tool-call')) {
      const text = result.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
      const compatCalls = parseDeepSeekTextToolCalls(
        text,
        request.tools?.map((tool) => tool.name)
      );
      if (compatCalls.length) {
        Logger.getInstance().warn(
          `[DeepSeekTransport] compatibility_text_tool_calls count=${compatCalls.length}; validating translated arguments`
        );
        result = {
          ...result,
          content: [
            ...result.content.filter((part) => part.type !== 'text'),
            ...compatCalls.map((call) => ({
              type: 'tool-call' as const,
              toolCallId: call.id,
              toolName: call.name,
              input: JSON.stringify(call.args),
            })),
          ],
        };
      }
    }
    return sdkResponse(result, effective, context);
  }

  async embed(texts: string[], opts: LlmCallOptions = {}): Promise<number[][]> {
    this.requireApiKey('DeepSeek');
    // SDK 没有 embedding 模型。保留已有可配置兼容 endpoint 的真实调用，不宣称官方支持。
    Logger.getInstance().debug(
      '[DeepSeekTransport] compatibility_embedding_endpoint configured_model; SDK embedding unavailable'
    );
    if (texts.some((text) => text.length > 8000)) {
      Logger.getInstance().warn(
        '[DeepSeekTransport] embedding_input_truncated limit=8000; legacy input boundary preserved'
      );
    }
    const data = await this.post(
      `${this.baseUrl.replace(/\/+$/, '')}/embeddings`,
      { model: this.settings.embedModel, input: texts.map((text) => text.slice(0, 8000)) },
      { Authorization: `Bearer ${this.apiKey}` },
      opts.abortSignal
    );
    const items = Array.isArray(data.data) ? data.data : [];
    if (items.length !== texts.length) {
      throw new Error('Embedding count does not match input count');
    }
    const result: number[][] = new Array(texts.length);
    for (const item of items) {
      const index = isRecord(item) ? item.index : undefined;
      const vector = isRecord(item) ? item.embedding : undefined;
      if (
        typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= texts.length ||
        result[index] ||
        !Array.isArray(vector) ||
        !vector.length ||
        !vector.every((value) => typeof value === 'number' && Number.isFinite(value))
      ) {
        throw new Error('Invalid embedding index or vector');
      }
      result[index] = vector;
    }
    if (result.some((vector) => vector.length !== result[0].length)) {
      throw new Error('Embedding dimensions do not match');
    }
    return result;
  }
}
