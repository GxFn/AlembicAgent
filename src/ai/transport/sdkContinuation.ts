/** 只保存协议续接信息；工具参数和可见文本仍由当前消息拥有。 */
import type { LanguageModelV4GenerateResult, LanguageModelV4Prompt } from '@ai-sdk/provider';
import Logger from '@alembic/core/logging';
import type { LlmContinuation, LlmReplayPart, UnifiedMessage } from '../contracts.js';
import type { SdkCallContext } from './sdkProtocol.js';

type AssistantParts = Extract<LanguageModelV4Prompt[number], { role: 'assistant' }>['content'];

export function captureSdkContinuation(
  result: LanguageModelV4GenerateResult,
  context: SdkCallContext
): LlmContinuation | undefined {
  const scope = {
    provider: context.provider,
    model: context.model,
    connection: context.connection,
  };
  if (context.protocol === 'responses') {
    const ids = [
      ...new Set(
        result.content
          .filter((part) => part.type === 'reasoning')
          .map((part) => part.providerMetadata?.openai?.itemId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      ),
    ];
    return ids.length
      ? { ...scope, kind: 'stored-reasoning-v1', reasoningItemIds: ids }
      : undefined;
  }
  if (!['google', 'anthropic', 'deepseek'].includes(context.protocol)) {
    return undefined;
  }
  let textOffset = 0;
  let hasText = false;
  let required = false;
  const parts: LlmReplayPart[] = [];
  for (const part of result.content) {
    const signature = part.providerMetadata?.google?.thoughtSignature;
    const thoughtSignature = typeof signature === 'string' ? signature : undefined;
    if (thoughtSignature !== undefined) {
      required = true;
    }
    if (part.type === 'text') {
      if (hasText && context.protocol !== 'deepseek') {
        textOffset++;
      } // Google/Claude 可见文本用换行连接。
      const end = textOffset + part.text.length;
      parts.push({
        type: 'text',
        start: textOffset,
        end,
        ...(thoughtSignature !== undefined ? { thoughtSignature } : {}),
      });
      textOffset = end;
      hasText = true;
    } else if (part.type === 'tool-call') {
      parts.push({ type: 'tool-call', id: part.toolCallId });
    } else if (part.type === 'reasoning') {
      required = true;
      const metadata = part.providerMetadata?.anthropic;
      parts.push({
        type: 'reasoning',
        text: part.text,
        ...(typeof metadata?.signature === 'string' ? { signature: metadata.signature } : {}),
        ...(typeof metadata?.redactedData === 'string'
          ? { redactedData: metadata.redactedData }
          : {}),
        ...(thoughtSignature !== undefined ? { thoughtSignature } : {}),
      });
    }
  }
  return required ? { ...scope, kind: 'content-replay-v1', parts } : undefined;
}

export function replaySdkContinuation(
  message: UnifiedMessage,
  context: SdkCallContext
): { parts: AssistantParts; complete: boolean } | undefined {
  const continuation = message.continuation;
  if (!continuation) {
    return undefined;
  }
  const reject = (reason: string) => {
    Logger.getInstance().warn(
      `[ai-sdk] continuation_filtered provider=${context.provider} model=${context.model} reason=${reason}; native metadata omitted`
    );
    return undefined;
  };
  if (
    continuation.provider !== context.provider ||
    continuation.model !== context.model ||
    continuation.connection !== context.connection
  ) {
    return reject('identity_mismatch');
  }
  if (continuation.kind === 'stored-reasoning-v1') {
    if (
      context.protocol !== 'responses' ||
      !Array.isArray(continuation.reasoningItemIds) ||
      !continuation.reasoningItemIds.every((id) => typeof id === 'string' && id.length > 0)
    ) {
      return reject('invalid_stored_items');
    }
    return {
      parts: continuation.reasoningItemIds.map((itemId) => ({
        type: 'reasoning',
        text: '',
        providerOptions: { openai: { itemId } },
      })),
      complete: false,
    };
  }
  if (
    continuation.kind !== 'content-replay-v1' ||
    !Array.isArray(continuation.parts) ||
    !continuation.parts.length ||
    !['google', 'anthropic', 'deepseek'].includes(context.protocol)
  ) {
    return reject('unsupported_replay_kind');
  }
  const parts: AssistantParts = [];
  const text = message.content || '';
  const calls = new Map((message.toolCalls || []).map((call) => [call.id, call]));
  for (const part of continuation.parts) {
    if (!part || typeof part !== 'object') {
      return reject('invalid_part');
    }
    if (part.type === 'text') {
      if (
        !Number.isInteger(part.start) ||
        !Number.isInteger(part.end) ||
        part.start < 0 ||
        part.end < part.start ||
        part.end > text.length
      ) {
        return reject('text_projection_changed');
      }
      parts.push({
        type: 'text',
        text: text.slice(part.start, part.end),
        ...(context.protocol === 'google' && typeof part.thoughtSignature === 'string'
          ? { providerOptions: { google: { thoughtSignature: part.thoughtSignature } } }
          : {}),
      });
    } else if (part.type === 'tool-call') {
      const call = calls.get(part.id);
      if (!call) {
        return reject('tool_projection_changed');
      }
      parts.push({
        type: 'tool-call',
        toolCallId: call.id,
        toolName: call.name,
        input: call.args,
        ...(context.protocol === 'google' && call.thoughtSignature
          ? { providerOptions: { google: { thoughtSignature: call.thoughtSignature } } }
          : {}),
      });
      calls.delete(part.id);
    } else if (part.type === 'reasoning' && typeof part.text === 'string') {
      parts.push({
        type: 'reasoning',
        text: part.text,
        providerOptions:
          context.protocol === 'anthropic'
            ? {
                anthropic: {
                  ...(typeof part.signature === 'string' ? { signature: part.signature } : {}),
                  ...(typeof part.redactedData === 'string'
                    ? { redactedData: part.redactedData }
                    : {}),
                },
              }
            : context.protocol === 'google'
              ? {
                  google: {
                    ...(typeof part.thoughtSignature === 'string'
                      ? { thoughtSignature: part.thoughtSignature }
                      : {}),
                  },
                }
              : undefined,
      });
    } else {
      return reject('invalid_part');
    }
  }
  if (calls.size) {
    return reject('tool_projection_changed');
  }
  return { parts, complete: true };
}
