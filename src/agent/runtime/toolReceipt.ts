/**
 * 已返回工具回执的数据投影。只组装事实条目和按显式配额生成模型文本，不执行工具、
 * 不写history/PCV/预算、不发送事件。保持args/result/envelope身份，供真实阶段观察者关联。
 */
import { isToolResultEnvelope } from '#tools/kernel/index.js';
import { limitToolResult } from '../context/ContextWindow.js';
import type { FunctionCall, ToolCallEntry, ToolMetadata } from './AgentRuntimeTypes.js';

/** 守卫失败信封的诊断码；投影本身不发送诊断，由调用方按此码记录。 */
export const TOOL_ENVELOPE_SHAPE_REJECTED = 'TOOL_ENVELOPE_SHAPE_REJECTED';

/**
 * 从未通过严格守卫的信封里安全读取 text。只接受自有数据属性上的字符串：守卫拒绝 accessor
 * 正是为了不执行不可信 getter，这里的回退读取也不能执行它。读不到时返回 undefined。
 */
export function readRejectedEnvelopeText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'text');
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

export function createToolReceipt(
  call: FunctionCall,
  result: unknown,
  metadata: ToolMetadata
): ToolCallEntry {
  return {
    tool: call.name,
    args: call.args,
    result,
    envelope: metadata.envelope,
    durationMs: metadata.durationMs,
  };
}

export function projectToolReceipt(
  entry: ToolCallEntry,
  quota: Parameters<typeof limitToolResult>[2]
) {
  const raw = entry.envelope || entry.result;
  const envelopeShapeRejected = Boolean(entry.envelope) && !isToolResultEnvelope(raw);
  // 回执带了信封但严格守卫失败（例如 durationMs 为负）：不能把整份信封（trust/diagnostics/
  // callId 等内部字段）序列化给模型；text 是自有字符串时回退用它，否则保留旧的原值投影。
  // 是否拒绝通过 envelopeShapeRejected 交给调用方记录 TOOL_ENVELOPE_SHAPE_REJECTED 诊断。
  const envelopeText = isToolResultEnvelope(raw)
    ? raw.text
    : envelopeShapeRejected
      ? readRejectedEnvelopeText(raw)
      : undefined;
  const text = limitToolResult(entry.tool, envelopeText ?? raw, quota);
  return {
    text,
    envelopeShapeRejected,
    // 读视图失效只比较安全读出的 text；读不到 text 时按“模型未见全文”保守失效。
    invalidatesReadView:
      entry.tool === 'code' &&
      entry.args.action === 'read' &&
      Boolean(entry.envelope && text !== envelopeText),
  };
}
