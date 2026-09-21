/** Anthropic Messages 的 wire codec 由 SDK 维护；本仓保留工具授权和请求生命周期。 */
import { type AnthropicProvider, createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import {
  LLMTransport,
  type TransportConfig,
  type TransportRequest,
  type TransportResponse,
} from './LLMTransport.js';
import { type SdkCallContext, sdkConnection } from './sdkContext.js';
import { normalizeSdkError } from './sdkErrors.js';
import { sdkCallOptions, sdkResponse } from './sdkProtocol.js';

export class ClaudeTransport extends LLMTransport {
  readonly #client: AnthropicProvider;
  readonly #connection: string;
  constructor(config: TransportConfig) {
    super('claude', config);
    this.#connection = sdkConnection(this.providerId, this.baseUrl, this.apiKey);
    this.#client = createAnthropic({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      fetch: (url, options) => this.fetchWithProxy(url, options),
    });
  }

  async chat(request: TransportRequest): Promise<string> {
    return (await this.chatWithTools(request)).text || '';
  }

  async chatWithTools(request: TransportRequest): Promise<TransportResponse> {
    this.requireApiKey('Claude');
    // 保留 none 时完全不声明工具的合同，不把禁用列表交给 SDK 再解释。
    const effective = {
      ...request,
      maxTokens: request.maxTokens || 4096,
      ...(request.toolChoice === 'none' ? { tools: undefined, toolChoice: undefined } : {}),
    };
    const context: SdkCallContext = {
      provider: this.providerId,
      model: request.model,
      protocol: 'anthropic',
      connection: this.#connection,
    };
    const options = sdkCallOptions(effective, context);
    // 只选择原生输出格式；不让 SDK 隐式增加 JSON 格式化工具或工具循环。
    options.providerOptions = { anthropic: { structuredOutputMode: 'outputFormat' } };
    const model = this.#client.messages(request.model);
    let result: LanguageModelV4GenerateResult;
    try {
      result = await this.runRequest(
        (signal) => model.doGenerate({ ...options, abortSignal: signal }),
        request.abortSignal
      );
    } catch (err: unknown) {
      throw normalizeSdkError(err, this.providerId);
    }
    return sdkResponse(result, effective, context);
  }
}
