/**
 * OpenAI 协议由固定版本 AI SDK provider 维护；保留原公共 Transport 入口。
 * 只调用版本化 doGenerate/doEmbed：没有 SDK 重试、工具执行或隐藏的 Agent 循环。
 * 本仓继续负责 HTTP 生命周期/代理、合同转换、权限上游边界与错误/用量归一化。
 */
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import Logger from '@alembic/core/logging';
import type { LlmCallOptions } from '../contracts.js';
import type { ProviderId } from '../registry/ModelDefs.js';
import {
  LLMTransport,
  type TransportConfig,
  type TransportRequest,
  type TransportResponse,
} from './LLMTransport.js';
import { type SdkCallContext, sdkConnection } from './sdkContext.js';
import { normalizeSdkError } from './sdkErrors.js';
import { isRecord, sdkCallOptions, sdkResponse } from './sdkProtocol.js';

export class OpenAiTransport extends LLMTransport {
  readonly #client: OpenAIProvider;
  readonly #embedModel: string;
  readonly #apiStyle: 'chat' | 'responses';
  readonly #connection: string;

  constructor(config: TransportConfig, providerId: ProviderId = 'openai') {
    super(providerId, config);
    this.#embedModel = this.settings.embedModel;
    this.#apiStyle = this.settings.apiStyle;
    this.#connection = sdkConnection(this.providerId, this.baseUrl, this.apiKey);
    this.#client = createOpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      fetch: (url, options) => this.fetchWithProxy(url, options),
    });
  }

  async chat(request: TransportRequest): Promise<string> {
    return (await this.chatWithTools(request)).text || '';
  }

  override get maxEmbeddingBatchSize(): number {
    // 显式兼容 embedding 也必须遵守固定版本 SDK 的单批容量；调度/重试仍由 Gateway 拥有。
    const limit = this.#client.embeddingModel(this.#embedModel).maxEmbeddingsPerCall;
    if (typeof limit !== 'number') {
      throw new Error('OpenAI SDK embedding batch limit must be synchronously available');
    }
    return limit;
  }

  async chatWithTools(request: TransportRequest): Promise<TransportResponse> {
    this.requireApiKey(this.providerId === 'ollama' ? 'Ollama' : 'OpenAI');
    const model =
      this.#apiStyle === 'responses'
        ? this.#client.responses(request.model)
        : this.#client.chat(request.model);
    const context: SdkCallContext = {
      provider: this.providerId,
      model: request.model,
      protocol: this.#apiStyle,
      connection: this.#connection,
    };
    const options: LanguageModelV4CallOptions = {
      ...sdkCallOptions(request, context),
      providerOptions: {
        openai: {
          systemMessageMode: 'system',
          strictJsonSchema: false,
          ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
          ...(this.#apiStyle === 'responses' ? { instructions: request.systemPrompt } : {}),
        },
      },
    };
    let result: LanguageModelV4GenerateResult;
    try {
      result = await this.runRequest(
        (signal) => model.doGenerate({ ...options, abortSignal: signal }),
        request.abortSignal
      );
    } catch (err: unknown) {
      throw normalizeSdkError(err, this.providerId);
    }
    return sdkResponse(result, request, context);
  }

  async embed(texts: string[], opts: LlmCallOptions = {}): Promise<number[][]> {
    this.requireApiKey(this.providerId === 'ollama' ? 'Ollama' : 'OpenAI');
    if (texts.length === 0) {
      return [];
    }
    try {
      const model = this.#client.embeddingModel(this.#embedModel);
      if (texts.some((text) => text.length > 8000)) {
        Logger.getInstance().warn(
          `[ai-sdk] embedding_input_truncated provider=${this.providerId} limit=8000; legacy input boundary preserved`
        );
      }
      // 保留旧入口 8000 字符边界；跨批调度由 Gateway/调用者承担，单次尝试不隐藏重放。
      const result = await this.runRequest(
        (signal) =>
          model.doEmbed({ values: texts.map((text) => text.slice(0, 8000)), abortSignal: signal }),
        opts.abortSignal
      );
      const raw = result.response?.body;
      const items = isRecord(raw) && Array.isArray(raw.data) ? raw.data : [];
      if (items.length !== texts.length || result.embeddings.length !== texts.length) {
        throw new Error('Embedding count does not match input count');
      }
      const ordered: number[][] = new Array(texts.length);
      for (const [position, item] of items.entries()) {
        const index = isRecord(item) ? item.index : undefined;
        const vector = result.embeddings[position];
        if (
          typeof index !== 'number' ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= texts.length ||
          ordered[index] ||
          !vector?.length ||
          !vector.every(Number.isFinite)
        ) {
          throw new Error('Invalid embedding index or vector');
        }
        ordered[index] = vector;
      }
      if (ordered.some((vector) => vector.length !== ordered[0].length)) {
        throw new Error('Embedding dimensions do not match within the batch');
      }
      return ordered;
    } catch (err: unknown) {
      throw normalizeSdkError(err, this.providerId);
    }
  }
}
