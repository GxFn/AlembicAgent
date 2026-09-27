/**
 * 已返回工具回执的数据投影。只组装事实条目和按显式配额生成模型文本，不执行工具、
 * 不写history/PCV/预算、不发送事件。保持args/result/envelope身份，供真实阶段观察者关联。
 */
import { isToolResultEnvelope } from '#tools/kernel/index.js';
import { limitToolResult } from '../context/ContextWindow.js';
import type { FunctionCall, ToolCallEntry, ToolMetadata } from './AgentRuntimeTypes.js';

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
  const text = limitToolResult(entry.tool, isToolResultEnvelope(raw) ? raw.text : raw, quota);
  return {
    text,
    invalidatesReadView:
      entry.tool === 'code' &&
      entry.args.action === 'read' &&
      Boolean(entry.envelope && text !== entry.envelope.text),
  };
}
