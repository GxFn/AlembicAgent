/**
 * OpenAI 协议由固定版本 AI SDK provider 维护；保留原公共 Transport 入口。
 * 只调用版本化 doGenerate/doEmbed：没有 SDK 重试、工具执行或隐藏的 Agent 循环。
 * 本仓继续负责 HTTP 生命周期/代理、合同转换、权限上游边界与错误/用量归一化。
 */
import { createHash } from 'node:crypto';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
} from '@ai-sdk/provider';
import Logger from '@alembic/core/logging';
import type { LlmCallOptions, TokenUsage, UnifiedMessage } from '../contracts.js';
import { LlmResponseError } from '../errors.js';
import type { ProviderId } from '../registry/ModelDefs.js';
import { prepareStructuredValidation } from '../shared/schemaValidation.js';
import {
  LLMTransport,
  type TransportConfig,
  type TransportRequest,
  type TransportResponse,
} from './LLMTransport.js';
import { normalizeSdkError } from './sdkErrors.js';

export class OpenAiTransport extends LLMTransport {
  readonly #client: OpenAIProvider;
  readonly #embedModel: string;
  readonly #apiStyle: 'chat' | 'responses';
  readonly #connection: string;

  constructor(config: TransportConfig, providerId: ProviderId = 'openai') {
    super(providerId, { ...config, baseUrl: config.baseUrl || 'https://api.openai.com/v1' });
    this.#embedModel =
      typeof config.embedModel === 'string' ? config.embedModel : 'text-embedding-3-small';
    const style = String(
      config.apiStyle ||
        (providerId === 'openai' ? process.env.ALEMBIC_OPENAI_API_STYLE : undefined) ||
        'chat'
    ).toLowerCase();
    this.#apiStyle = style === 'responses' ? 'responses' : 'chat';
    this.#connection = createHash('sha256')
      .update(JSON.stringify([this.providerId, this.baseUrl, this.apiKey]))
      .digest('hex');
    this.#client = createOpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      fetch: (url, options) => this.fetchWithProxy(url, options),
    });
  }

  async chat(request: TransportRequest): Promise<string> {
    return (await this.chatWithTools(request)).text || '';
  }

  async chatWithTools(request: TransportRequest): Promise<TransportResponse> {
    this.requireApiKey(this.providerId === 'ollama' ? 'Ollama' : 'OpenAI');
    Logger.getInstance().debug(
      `[ai-sdk] native_request provider=${this.providerId} protocol=${this.#apiStyle} model=${request.model} tools=${request.tools?.length ?? 0}; retry_owner=gateway`
    );
    const model =
      this.#apiStyle === 'responses'
        ? this.#client.responses(request.model)
        : this.#client.chat(request.model);
    const options: LanguageModelV4CallOptions = {
      prompt: toSdkPrompt(
        request.messages,
        this.#apiStyle === 'chat' ? request.systemPrompt : undefined,
        this.providerId,
        request.model,
        this.#apiStyle,
        this.#connection
      ),
      maxOutputTokens: request.maxTokens,
      temperature: request.temperature,
      tools: request.tools?.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.parameters || { type: 'object', properties: {} },
      })),
      toolChoice:
        request.toolChoice === undefined
          ? undefined
          : ['auto', 'none', 'required'].includes(request.toolChoice)
            ? { type: request.toolChoice as 'auto' | 'none' | 'required' }
            : { type: 'tool', toolName: request.toolChoice },
      responseFormat:
        request.responseFormat === 'json' ? { type: 'json', schema: request.schema } : undefined,
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
    for (const warning of result.warnings) {
      Logger.getInstance().warn(
        `[ai-sdk] provider=${this.providerId} model=${request.model} warning=${warning.type} feature=${'feature' in warning ? warning.feature : 'provider-specific'}; inspect model capabilities`
      );
    }
    const usage = toTokenUsage(result);
    const functionCalls = result.content
      .filter((part) => part.type === 'tool-call')
      .map((part) => {
        let args: unknown;
        try {
          args = JSON.parse(part.input.trim() || '{}');
        } catch (err: unknown) {
          throw new LlmResponseError(
            `Invalid tool arguments from ${this.providerId} (${err instanceof SyntaxError ? 'invalid_json' : 'invalid_input'}); tool execution rejected`,
            usage
          );
        }
        if (
          !args ||
          typeof args !== 'object' ||
          Array.isArray(args) ||
          !part.toolCallId ||
          part.providerExecuted
        ) {
          throw new LlmResponseError(
            `Invalid tool proposal from ${this.providerId}; tool execution rejected`,
            usage
          );
        }
        const tool = request.tools?.find((candidate) => candidate.name === part.toolName);
        const validate = tool
          ? prepareStructuredValidation(tool.parameters, (_level, message) =>
              Logger.getInstance().warn(message)
            )
          : null;
        if (!validate || !validate(args)) {
          throw new LlmResponseError(
            `Unknown tool or invalid arguments from ${this.providerId}; tool execution rejected`,
            usage
          );
        }
        return { id: part.toolCallId, name: part.toolName, args: args as Record<string, unknown> };
      });
    const raw = result.response?.body;
    // 保持 Responses 原有 completed/incomplete 词汇；chat 终于完整转发 stop/length/tool_calls。
    const finishReason =
      this.#apiStyle === 'responses' && isRecord(raw) && typeof raw.status === 'string'
        ? raw.status
        : (result.finishReason.raw ?? result.finishReason.unified);
    const reasoningItemIds =
      this.#apiStyle === 'responses'
        ? [
            ...new Set(
              result.content
                .filter((part) => part.type === 'reasoning')
                .map((part) => part.providerMetadata?.openai?.itemId)
                .filter((id): id is string => typeof id === 'string' && id.length > 0)
            ),
          ]
        : [];
    return {
      ...(reasoningItemIds.length
        ? {
            continuation: {
              kind: 'stored-reasoning-v1' as const,
              provider: this.providerId,
              model: request.model,
              connection: this.#connection,
              reasoningItemIds,
            },
          }
        : {}),
      text:
        result.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('') || null,
      functionCalls: functionCalls.length ? functionCalls : null,
      usage,
      finishReason,
      reasoningContent:
        result.content
          .filter((part) => part.type === 'reasoning')
          .map((part) => part.text)
          .join('') || undefined,
    };
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

function toSdkPrompt(
  messages: UnifiedMessage[],
  systemPrompt: string | undefined,
  provider: string,
  model: string,
  apiStyle: string,
  connection: string
): LanguageModelV4Prompt {
  const prompt: LanguageModelV4Prompt = [];
  if (systemPrompt) {
    prompt.push({ role: 'system', content: systemPrompt });
  }
  for (const message of messages) {
    if (message.role === 'user') {
      prompt.push({ role: 'user', content: [{ type: 'text', text: message.content || '' }] });
    } else if (message.role === 'tool') {
      prompt.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.toolCallId || '',
            toolName: message.name || '',
            output: { type: 'text', value: message.content || '' },
          },
        ],
      });
    } else {
      const content: Extract<LanguageModelV4Prompt[number], { role: 'assistant' }>['content'] = [];
      const continuation = message.continuation;
      if (continuation) {
        if (
          apiStyle === 'responses' &&
          continuation.kind === 'stored-reasoning-v1' &&
          continuation.provider === provider &&
          continuation.model === model &&
          continuation.connection === connection &&
          Array.isArray(continuation.reasoningItemIds) &&
          continuation.reasoningItemIds.every((id) => typeof id === 'string' && id.length > 0)
        ) {
          for (const itemId of continuation.reasoningItemIds) {
            content.push({ type: 'reasoning', text: '', providerOptions: { openai: { itemId } } });
          }
        } else {
          Logger.getInstance().warn(
            `[ai-sdk] continuation_filtered provider=${provider} model=${model}; protocol/model/connection identity mismatch`
          );
        }
      }
      if (message.content) {
        content.push({ type: 'text', text: message.content });
      }
      for (const call of message.toolCalls || []) {
        content.push({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: call.name,
          input: call.args,
        });
      }
      prompt.push({ role: 'assistant', content });
    }
  }
  return prompt;
}

function toTokenUsage(result: LanguageModelV4GenerateResult): TokenUsage | null {
  const raw = result.usage.raw;
  const inputTokens = raw?.input_tokens ?? raw?.prompt_tokens;
  const outputTokens = raw?.output_tokens ?? raw?.completion_tokens;
  // SDK 会为缺失的可选细分补 0；本仓保留「未上报」与真实 0 的区别。
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
    return null;
  }
  const inputDetails = raw?.input_tokens_details ?? raw?.prompt_tokens_details;
  const outputDetails = raw?.output_tokens_details ?? raw?.completion_tokens_details;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(isRecord(outputDetails) && typeof outputDetails.reasoning_tokens === 'number'
      ? { reasoningTokens: outputDetails.reasoning_tokens }
      : {}),
    ...(isRecord(inputDetails) && typeof inputDetails.cached_tokens === 'number'
      ? { cacheHitTokens: inputDetails.cached_tokens }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
