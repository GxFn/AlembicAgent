/**
 * DeepSeek wire 协议交给 SDK；V4 策略与文本工具兼容仍由本仓显式管理。
 * V4 家族身份统一读 registry/ModelQuirks 的 resolveDeepSeekV4Family(注册表优先、共享名字正则回退)，
 * 本文件不再自带模型名正则。按请求的 thinking 调整(toolChoice/temperature 丢弃、maxTokens 下限、
 * thinking 开关)仍由本 transport 持有，ParameterGuard 的静态约束不覆盖这部分。
 */
import { createDeepSeek, type DeepSeekProvider as DeepSeekSdkProvider } from '@ai-sdk/deepseek';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import Logger from '@alembic/core/logging';
import type { LlmCallOptions, UnifiedMessage } from '../contracts.js';
import { parseDeepSeekTextToolCalls } from '../deepseekToolCallCompat.js';
import { resolveDeepSeekV4Family } from '../registry/ModelQuirks.js';
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
    const v4Family = resolveDeepSeekV4Family(request.model);
    const isV4 = v4Family.isV4;
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
    // V4 拒绝强制 tool_choice；thinking 开启(有工具)时 temperature 无效，一并不发。
    const dropToolChoice = isV4 && request.toolChoice !== undefined;
    const dropTemperature = isV4 && hasTools && request.temperature !== undefined;
    if (isV4 || v4Family.source === 'name-fallback') {
      // 诊断只记录判定来源与被丢弃的参数名，不记录参数原值或消息内容；
      // source=name-fallback 表示模型未登记、按共享名字正则判定，供核对注册表是否需要补登记。
      const dropped =
        [dropToolChoice ? 'toolChoice' : '', dropTemperature ? 'temperature' : '']
          .filter(Boolean)
          .join(',') || 'none';
      Logger.getInstance().debug(
        `[DeepSeekTransport] v4_param_policy model=${request.model} v4=${isV4} source=${v4Family.source} hasTools=${hasTools} dropped=${dropped}`
      );
    }
    const effective: TransportRequest = {
      ...request,
      messages,
      maxTokens,
      tools: hasTools ? request.tools : undefined,
      toolChoice: dropToolChoice ? undefined : request.toolChoice,
      temperature: dropTemperature ? undefined : request.temperature,
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
    if (!Array.isArray(data.data)) {
      // 2xx 但缺少 data 数组属于上游/代理返回坏 body，与 SDK 路径同归 LLM_INVALID_RESPONSE；
      // 不再按空数组继续，否则会被误报成“数量不符”。诊断只记录形状类别，不记录正文。
      const shape = data.data === null ? 'null' : typeof data.data;
      Logger.getInstance().warn(
        `[DeepSeekTransport] embedding_data_missing dataType=${shape} requested=${texts.length}; classified LLM_INVALID_RESPONSE`
      );
      throw Object.assign(new Error(`${this.providerId} embedding response has no data array`), {
        code: 'LLM_INVALID_RESPONSE',
      });
    }
    const items: unknown[] = data.data;
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
