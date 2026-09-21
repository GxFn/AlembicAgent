/** SDK 调用身份的叶子合同；消息/续接投影共同依赖它，不彼此拥有对方的上下文类型。 */
import { createHash } from 'node:crypto';
import { stableStringify } from '#shared/serialization.js';
import type { LlmContinuation, UnifiedMessage } from '../contracts.js';

export interface SdkCallContext {
  provider: string;
  model: string;
  connection: string;
  protocol: 'chat' | 'responses' | 'google' | 'anthropic' | 'deepseek';
}

/** 只保存连接身份摘要，原始 endpoint 和凭据不能进入可回放消息。 */
export function sdkConnection(provider: string, baseUrl: string, apiKey: string): string {
  return createHash('sha256')
    .update(JSON.stringify([provider, baseUrl, apiKey]))
    .digest('hex');
}

/** 绑定实际 JSON 投影，避免等长文本/同 id 参数变化后仍发送旧签名；摘要不是授权凭证。 */
export function sdkProjectionHash(
  message: Pick<UnifiedMessage, 'content' | 'toolCalls'>,
  continuation: LlmContinuation
): string {
  const projection = [
    message.content ?? '',
    (message.toolCalls ?? []).map((call) => [
      call.id,
      call.name,
      call.args,
      call.thoughtSignature ?? null,
    ]),
    continuation.kind,
    continuation.kind === 'stored-reasoning-v1'
      ? continuation.reasoningItemIds
      : continuation.parts,
  ];
  // 先转成真正的 JSON 值，再稳定排序对象键；undefined 数组项不与空数组混淆。
  const canonical = stableStringify(JSON.parse(JSON.stringify(projection)));
  return createHash('sha256').update(canonical).digest('hex');
}
