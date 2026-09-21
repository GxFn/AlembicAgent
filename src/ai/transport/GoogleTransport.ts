/** Gemini 原生协议交给 SDK；保留本仓取消/代理、批次和结果验证边界。 */
import { createGoogle, type GoogleProvider } from '@ai-sdk/google';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import Logger from '@alembic/core/logging';
import type { LlmCallOptions } from '../contracts.js';
import {
  LLMTransport,
  type TransportConfig,
  type TransportRequest,
  type TransportResponse,
} from './LLMTransport.js';
import { type SdkCallContext, sdkConnection } from './sdkContext.js';
import { normalizeSdkError } from './sdkErrors.js';
import { sdkCallOptions, sdkResponse } from './sdkProtocol.js';

export class GoogleTransport extends LLMTransport {
  readonly #client: GoogleProvider;
  readonly #embedModel: string;
  readonly #connection: string;

  constructor(config: TransportConfig) {
    super('google', config);
    this.#embedModel = this.settings.embedModel.replace(/^models\//, '');
    this.#connection = sdkConnection(this.providerId, this.baseUrl, this.apiKey);
    this.#client = createGoogle({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      fetch: (url, options) => this.fetchWithProxy(url, options),
    });
  }

  async chat(request: TransportRequest): Promise<string> {
    return (await this.chatWithTools(request)).text || '';
  }

  override get maxEmbeddingBatchSize(): number {
    return 100;
  }

  async chatWithTools(request: TransportRequest): Promise<TransportResponse> {
    this.requireApiKey('Google Gemini');
    const context: SdkCallContext = {
      provider: this.providerId,
      model: request.model,
      protocol: 'google',
      connection: this.#connection,
    };
    const model = this.#client.chat(request.model);
    let result: LanguageModelV4GenerateResult;
    try {
      result = await this.runRequest(
        (signal) => model.doGenerate({ ...sdkCallOptions(request, context), abortSignal: signal }),
        request.abortSignal
      );
    } catch (err: unknown) {
      throw normalizeSdkError(err, this.providerId);
    }
    return sdkResponse(result, request, context);
  }

  async embed(texts: string[], opts: LlmCallOptions = {}): Promise<number[][]> {
    this.requireApiKey('Google Gemini');
    const model = this.#client.embeddingModel(this.#embedModel);
    const results: number[][] = [];
    if (texts.some((text) => text.length > 8000)) {
      Logger.getInstance().warn(
        '[ai-sdk] embedding_input_truncated provider=google limit=8000; legacy input boundary preserved'
      );
    }
    for (let start = 0; start < texts.length; start += this.maxEmbeddingBatchSize) {
      const batch = texts.slice(start, start + this.maxEmbeddingBatchSize);
      try {
        const result = await this.runRequest(
          (signal) =>
            model.doEmbed({
              values: batch.map((text) => text.slice(0, 8000)),
              abortSignal: signal,
            }),
          opts.abortSignal
        );
        const vectors = result.embeddings;
        if (
          vectors.length !== batch.length ||
          vectors.some(
            (vector) =>
              !vector.length ||
              !vector.every(Number.isFinite) ||
              vector.length !== (results[0]?.length ?? vectors[0].length)
          )
        ) {
          throw new Error('Invalid embedding count, dimensions or values');
        }
        results.push(...vectors);
      } catch (err: unknown) {
        Logger.getInstance().warn(
          `[ai-sdk] embedding_batch_failed provider=google completed=${results.length} requested=${texts.length}; partial result withheld`
        );
        throw normalizeSdkError(err, this.providerId);
      }
    }
    return results;
  }
}
