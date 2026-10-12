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

/**
 * 编译单个工具的参数 schema；编译结果由 schemaValidation 按快照缓存，
 * 请求前预编译与响应后校验因此复用同一个已编译校验器。
 */
function prepareToolValidator(
  parameters: Record<string, unknown> | undefined
): ((value: unknown) => boolean) | null {
  return prepareStructuredValidation(
    parameters,
    (_level, message) => Logger.getInstance().warn(message),
    'tool-parameters'
  );
}

/**
 * 请求前预编译全部工具参数 schema：本地 schema 缺陷属于调用方输入错误，
 * 以 LLM_INVALID_REQUEST 拒绝，不发请求、不消耗 token，也不归因为模型输出。
 */
function assertToolSchemasCompile(request: TransportRequest, context: SdkCallContext): void {
  for (const tool of request.tools ?? []) {
    if (prepareToolValidator(tool.parameters) === null) {
      Logger.getInstance().warn(
        `[ai-sdk] invalid_tool_schema provider=${context.provider} model=${request.model} tool=${tool.name}; request rejected before dispatch`
      );
      throw Object.assign(
        new Error(
          `${context.provider} tool parameter schema for "${tool.name}" failed to compile; request rejected before dispatch`
        ),
        { code: 'LLM_INVALID_REQUEST' }
      );
    }
  }
}

export function sdkCallOptions(
  request: TransportRequest,
  context: SdkCallContext
): LanguageModelV4CallOptions {
  assertToolSchemasCompile(request, context);
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
  // 同次响应内按工具名取一次校验器；编译结果来自请求前预编译时写入的快照缓存。
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
        validate = tool ? prepareToolValidator(tool.parameters) : null;
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
  let reportedOutput =
    context.protocol === 'google'
      ? raw?.candidatesTokenCount
      : (raw?.output_tokens ?? raw?.completion_tokens);
  // 仅限 Google：Gemini REST 是 proto3 JSON，零值整型字段会被整项省略。思考把输出预算
  // 用尽、没有可见候选（典型为 finishReason=MAX_TOKENS）时，响应只带 prompt/thoughts/total，
  // 但 prompt 与思考 token 已经计费。此时 prompt 与 thoughts 都是数字，足以证明这是一次
  // 已上报用量的响应，缺失的 candidatesTokenCount 记为可见输出 0；outputTokens 仍取 SDK 的
  // outputTokens.total（= candidates + thoughts）。thoughts 也缺失时没有计费证据，仍走下方
  // 「未上报即 null」；其他协议的缺失字段不做任何推断。
  if (
    context.protocol === 'google' &&
    typeof reportedInput === 'number' &&
    (reportedOutput === undefined || reportedOutput === null) &&
    typeof raw?.thoughtsTokenCount === 'number'
  ) {
    Logger.getInstance().warn(
      `[ai-sdk] usage_candidates_missing provider=${context.provider} protocol=google prompt=${reportedInput} thoughts=${raw.thoughtsTokenCount}; visible output treated as 0, outputTokens taken from SDK output total`
    );
    reportedOutput = 0;
  }
  if (typeof reportedInput !== 'number' || typeof reportedOutput !== 'number') {
    // 「未上报」与真实 0 必须区分：不猜测缺失的计数，但这次调用不会进入预算/成本统计，需留诊断。
    Logger.getInstance().warn(
      `[ai-sdk] usage_unreported provider=${context.provider} protocol=${context.protocol} input=${usageFieldState(reportedInput)} output=${usageFieldState(reportedOutput)}; usage omitted, budget not recorded for this call`
    );
    return null;
  }
  const inputTokens = result.usage.inputTokens.total;
  const outputTokens = result.usage.outputTokens.total;
  // SDK 会为缺失的可选细分补 0；本仓保留「未上报」与真实 0 的区别。
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
    Logger.getInstance().warn(
      `[ai-sdk] usage_unreported provider=${context.provider} protocol=${context.protocol} sdk_input_total=${usageFieldState(inputTokens)} sdk_output_total=${usageFieldState(outputTokens)}; usage omitted, budget not recorded for this call`
    );
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

/** 诊断里只描述计数字段的形态（已上报/缺失/非数字），不输出原始值。 */
function usageFieldState(value: unknown): 'reported' | 'missing' | 'non-numeric' {
  if (value === undefined || value === null) {
    return 'missing';
  }
  return typeof value === 'number' ? 'reported' : 'non-numeric';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
