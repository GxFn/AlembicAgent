/** 请求字段与旧 note_finding 调用翻译；不做执行、缓存或权限判断。 */
import { DEPTH_SLOT_PROPS } from '#tools/runtime/registry.js';
import type { ToolCall } from './contracts.js';

export function isDirectNoteFindingCall(call: ToolCall) {
  return call.name === 'note_finding';
}

export function toExecutableToolCall(call: ToolCall): ToolCall {
  if (!isDirectNoteFindingCall(call)) {
    return call;
  }
  return {
    ...call,
    name: 'memory',
    args: {
      action: 'note_finding',
      params: {
        finding: call.args.finding,
        // E3：引用契约=台账 ID 数组；excerpt 为可选短摘。旧 evidence 字符串一并透传，
        // 由 handler 统一给出迁移拒绝提示（不在改写层静默吞掉）。
        evidenceRefs: call.args.evidenceRefs,
        excerpt: call.args.excerpt,
        evidence: call.args.evidence,
        importance: call.args.importance,
        ...Object.fromEntries(
          Object.keys(DEPTH_SLOT_PROPS)
            .filter((key) => call.args[key] !== undefined)
            .map((key) => [key, call.args[key]])
        ),
      },
    },
  };
}

export function getToolAction(call: ToolCall): string {
  const params =
    call.args?.params && typeof call.args.params === 'object'
      ? (call.args.params as Record<string, unknown>)
      : {};
  const action = call.args?.action ?? params.action ?? params.operation ?? '';
  return String(action);
}

export function getToolParams(call: ToolCall): Record<string, unknown> {
  return call.args?.params && typeof call.args.params === 'object'
    ? (call.args.params as Record<string, unknown>)
    : call.args;
}
