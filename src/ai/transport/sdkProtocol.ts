/** 本仓消息/结果与 SDK V4 之间的共同投影；不创建网络请求或执行工具。 */
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
} from '@ai-sdk/provider';
import Logger from '@alembic/core/logging';
import type { TokenUsage, UnifiedMessage } from '../contracts.js';
import { LlmResponseError } from '../errors.js';
import { prepareStructuredValidation } from '../shared/schemaValidation.js';
import type { TransportRequest, TransportResponse } from './LLMTransport.js';
import type { SdkCallContext } from './sdkContext.js';
import { captureSdkContinuation, replaySdkContinuation } from './sdkContinuation.js';

export function sdkCallOptions(
  request: TransportRequest,
  context: SdkCallContext
): LanguageModelV4CallOptions {
  Logger.getInstance().debug(
    `[ai-sdk] native_request provider=${context.provider} protocol=${context.protocol} model=${request.model} tools=${request.tools?.length ?? 0}; retry_owner=gateway`
  );
  return {
    prompt: toSdkPrompt(
      request.messages,
      context.protocol !== 'responses' ? request.systemPrompt : undefined,
      context.provider,
      request.model,
      context.protocol,
      context.connection
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
  };
}

export function sdkResponse(
  result: LanguageModelV4GenerateResult,
  request: TransportRequest,
  context: SdkCallContext
): TransportResponse {
  for (const warning of result.warnings) {
    Logger.getInstance().warn(
      `[ai-sdk] provider=${context.provider} model=${request.model} warning=${warning.type} feature=${'feature' in warning ? warning.feature : 'provider-specific'}; inspect model capabilities`
    );
  }
  const usage = toTokenUsage(result, context);
  const callIds = new Set<string>();
  // 同次响应内按声明编译一次；不跨请求缓存可变 schema。
  const validators = new Map<string, ((value: unknown) => boolean) | null>();
  const functionCalls = result.content
    .filter((part) => part.type === 'tool-call')
    .map((part) => {
      let args: unknown;
      try {
        args = JSON.parse(part.input.trim() || '{}');
      } catch (err: unknown) {
        throw new LlmResponseError(
          `Invalid tool arguments from ${context.provider} (${err instanceof SyntaxError ? 'invalid_json' : 'invalid_input'}); tool execution rejected`,
          usage
        );
      }
      if (
        request.toolChoice === 'none' ||
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        !part.toolCallId ||
        callIds.has(part.toolCallId) ||
        part.providerExecuted
      ) {
        throw new LlmResponseError(
          `Invalid tool proposal from ${context.provider}; tool execution rejected`,
          usage
        );
      }
      callIds.add(part.toolCallId);
      let validate = validators.get(part.toolName);
      if (validate === undefined) {
        const tool = request.tools?.find((candidate) => candidate.name === part.toolName);
        validate = tool
          ? prepareStructuredValidation(tool.parameters, (_level, message) =>
              Logger.getInstance().warn(message)
            )
          : null;
        validators.set(part.toolName, validate);
      }
      if (!validate || !validate(args)) {
        throw new LlmResponseError(
          `Unknown tool or invalid arguments from ${context.provider}; tool execution rejected`,
          usage
        );
      }
      const signature = part.providerMetadata?.google?.thoughtSignature;
      return {
        id: part.toolCallId,
        name: part.toolName,
        args: args as Record<string, unknown>,
        ...(typeof signature === 'string' ? { thoughtSignature: signature } : {}),
      };
    });
  const raw = result.response?.body;
  // 保持 Responses 原有 completed/incomplete 词汇；chat 终于完整转发 stop/length/tool_calls。
  const finishReason =
    context.protocol === 'responses' && isRecord(raw) && typeof raw.status === 'string'
      ? raw.status
      : (result.finishReason.raw ?? result.finishReason.unified);
  const text =
    result.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join(context.protocol === 'google' || context.protocol === 'anthropic' ? '\n' : '') || null;
  // 用已验证的公共投影绑定续接，不在续接层再次解析工具参数或复制一套消息状态。
  const continuation = captureSdkContinuation(result, context, {
    content: text,
    toolCalls: functionCalls,
  });
  return {
    ...(continuation ? { continuation } : {}),
    text,
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

export function toSdkPrompt(
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
      const replay = replaySdkContinuation(message, {
        provider,
        model,
        connection,
        protocol: apiStyle as SdkCallContext['protocol'],
      });
      if (replay) {
        content.push(...replay.parts);
        if (replay.complete) {
          prompt.push({ role: 'assistant', content });
          continue;
        }
      }
      if (provider === 'deepseek' && !message.continuation && message.reasoningContent != null) {
        content.push({ type: 'reasoning', text: message.reasoningContent });
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
          ...(provider === 'google' && call.thoughtSignature && (!message.continuation || replay)
            ? { providerOptions: { google: { thoughtSignature: call.thoughtSignature } } }
            : {}),
        });
      }
      prompt.push({ role: 'assistant', content });
    }
  }
  return prompt;
}

export function toTokenUsage(
  result: LanguageModelV4GenerateResult,
  context: SdkCallContext
): TokenUsage | null {
  const raw = result.usage.raw;
  const reportedInput =
    context.protocol === 'google'
      ? raw?.promptTokenCount
      : (raw?.input_tokens ?? raw?.prompt_tokens);
  const reportedOutput =
    context.protocol === 'google'
      ? raw?.candidatesTokenCount
      : (raw?.output_tokens ?? raw?.completion_tokens);
  if (typeof reportedInput !== 'number' || typeof reportedOutput !== 'number') {
    return null;
  }
  const inputTokens = result.usage.inputTokens.total;
  const outputTokens = result.usage.outputTokens.total;
  // SDK 会为缺失的可选细分补 0；本仓保留「未上报」与真实 0 的区别。
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
    return null;
  }
  const inputDetails = raw?.input_tokens_details ?? raw?.prompt_tokens_details;
  const outputDetails = raw?.output_tokens_details ?? raw?.completion_tokens_details;
  const usage: TokenUsage = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(typeof raw?.thoughtsTokenCount === 'number'
      ? { reasoningTokens: raw.thoughtsTokenCount }
      : {}),
    ...(typeof raw?.cachedContentTokenCount === 'number'
      ? { cacheHitTokens: raw.cachedContentTokenCount }
      : {}),
    ...(typeof raw?.prompt_cache_hit_tokens === 'number'
      ? { cacheHitTokens: raw.prompt_cache_hit_tokens }
      : {}),
    ...(typeof raw?.cache_read_input_tokens === 'number'
      ? { cacheHitTokens: raw.cache_read_input_tokens }
      : {}),
    ...(typeof raw?.cache_creation_input_tokens === 'number'
      ? { cacheWriteTokens: raw.cache_creation_input_tokens }
      : {}),
    ...(isRecord(outputDetails) && typeof outputDetails.reasoning_tokens === 'number'
      ? { reasoningTokens: outputDetails.reasoning_tokens }
      : {}),
    ...(isRecord(inputDetails) && typeof inputDetails.cached_tokens === 'number'
      ? { cacheHitTokens: inputDetails.cached_tokens }
      : {}),
    ...(isRecord(inputDetails) && typeof inputDetails.cache_write_tokens === 'number'
      ? { cacheWriteTokens: inputDetails.cache_write_tokens }
      : {}),
    ...(isRecord(outputDetails) && typeof outputDetails.thinking_tokens === 'number'
      ? { reasoningTokens: outputDetails.thinking_tokens }
      : {}),
  };
  if (
    [reportedInput, reportedOutput, ...Object.values(usage)].some(
      (count) => !Number.isSafeInteger(count) || count < 0
    )
  ) {
    Logger.getInstance().warn(
      `[ai-sdk] invalid_usage provider=${context.provider}; counts omitted without changing model content`
    );
    return null;
  }
  return usage;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
