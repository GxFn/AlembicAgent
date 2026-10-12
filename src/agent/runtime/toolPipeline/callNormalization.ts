/**
 * 请求字段与旧 note_finding 调用翻译，以及 record-only 阶段判定单源；不做执行、缓存或权限判断。
 * 阶段判定只回答“本轮是不是 record-only”，具体放行哪些动作仍由 phaseGates 的执行门决定。
 */
import { DEPTH_SLOT_PROPS } from '#tools/runtime/registry.js';
import type { ToolCall } from './contracts.js';

/**
 * record-only 阶段的触发谓词名。阻断诊断与跳过日志直接写出命中的那一项，
 * 便于区分 QualityGate record_repair 微阶段（两种旗标）与 analyst tracker 的 RECORD 相。
 */
export type RecordOnlyStageTrigger =
  | 'sharedState._recordRepairOnly'
  | 'context.recordRepairOnly'
  | 'analyst RECORD phase';

/**
 * 判定所需的最小只读视图。LoopContext 与工具管道的 ToolLoopPort 都结构兼容；
 * 字段全部可选，缺字段（例如单测只给 sharedState）按“未命中”处理，不抛错。
 */
export interface RecordOnlyStageSource {
  readonly sharedState?: Readonly<Record<string, unknown>> | null;
  readonly context?: Readonly<Record<string, unknown>> | null;
  readonly tracker?: { readonly pipelineType?: unknown; readonly phase?: unknown } | null;
}

/**
 * I06：record-only 阶段判定单源。AgentRuntime 的强制摘要豁免与 schema 广告、recordRepairOnlyGate
 * 执行门、LLMInputAssembly 的 record 画像都从这里取结论，避免广告面收窄了而执行门没收窄（或反之）。
 *
 * 命中顺序：
 * 1. sharedState._recordRepairOnly === true —— PipelineStrategy record_repair 微阶段写入的运行态旗标；
 * 2. context.recordRepairOnly === true —— 同一微阶段的阶段上下文旗标（两者通常同时出现，取先命中者）；
 * 3. tracker.pipelineType === 'analyst' 且 tracker.phase === 'RECORD' —— analyst 补记录相。
 *
 * @returns 命中的触发谓词名；不是 record-only 阶段时返回 null。
 */
export function resolveRecordOnlyStageTrigger(
  source: RecordOnlyStageSource | null | undefined
): RecordOnlyStageTrigger | null {
  if (source?.sharedState?._recordRepairOnly === true) {
    return 'sharedState._recordRepairOnly';
  }
  if (source?.context?.recordRepairOnly === true) {
    return 'context.recordRepairOnly';
  }
  if (source?.tracker?.pipelineType === 'analyst' && source.tracker.phase === 'RECORD') {
    return 'analyst RECORD phase';
  }
  return null;
}

export function isRecordOnlyStage(source: RecordOnlyStageSource | null | undefined): boolean {
  return resolveRecordOnlyStageTrigger(source) !== null;
}

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
