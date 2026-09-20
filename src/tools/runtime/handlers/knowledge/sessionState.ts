/** 跨阶段浅拷贝共享的计数状态；预算字段必须保持引用身份。 */
import { numberValue } from './input.js';

/** 标题可合法等于 constructor/__proto__；兼容旧普通字典，保持共享对象身份。 */
export function readTitleAttempt(attempts: Record<string, number>, title: string): number {
  return Object.hasOwn(attempts, title) ? (numberValue(attempts[title]) ?? 0) : 0;
}

export function writeTitleAttempt(
  attempts: Record<string, number>,
  title: string,
  count: number
): void {
  Object.defineProperty(attempts, title, {
    value: count,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

/**
 * 会话级计数盒(题目预算/修复层计量/waiver 上限/拒绝止损共用宿主)。
 *
 * 为什么不能挂 ctx.runtime：ToolExecutionPipeline.buildRuntimeToolCallRequest 对每次工具
 * 调用现造一个一次性 runtime 投影对象——直接写在 ctx.runtime 上的字段随调用即弃(门0 真跑
 * 实测：修复层日志触发而计数恒空；waiver 上限与拒绝止损同因失效,streak 永远到不了阈值)。
 * 为什么是嵌套盒而非 sharedState 顶层字段：PipelineStrategy 的 decisionOnly/recordRepair
 * 阶段会对 sharedState 做浅拷贝,顶层字段写在拷贝上会丢；浅拷贝保留嵌套对象引用,盒内
 * 计数在整个维度会话内单调累计。盒由 PipelineStrategy.execute 入口预建(先于任何阶段拷贝)；
 * 此处兜底自建覆盖非管线宿主。无 sharedState 时返回 null → 计数静默跳过(观测不影响执行)。
 */
export function sessionCounterBox(runtime: unknown): Record<string, unknown> | null {
  if (!runtime || typeof runtime !== 'object') {
    return null;
  }
  const shared = (runtime as Record<string, unknown>).sharedState;
  if (!shared || typeof shared !== 'object' || Array.isArray(shared)) {
    return null;
  }
  const state = shared as Record<string, unknown>;
  const existing = state._sessionCounters;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const box: Record<string, unknown> = {};
  state._sessionCounters = box;
  return box;
}

/**
 * P0-4(挖掘质量升级)：submit 修复层命中计数。submit 周围有多层"模型输出不合格→程序
 * 确定性代修"的修复路径(refs 回推/证据矫正/coreCode 回填/snippet 规范化/graph refs 注入/
 * style waiver/风格修复子调用/advisory 降级)——此前只有日志，无法回答"哪些修复层在真实
 * 承重、哪些是死枝"。计数挂在 sessionCounterBox(见上,跨调用稳定)，由 PipelineStrategy
 * 在管线收口时投影进 phases._pipelineOutcome.submitRepairs，评估 harness 据此算
 * repair-hit-rate；P2 契约收紧时按计量裁撤而非盲删。计数失败静默(观测不影响执行)。
 */
export function bumpSubmitRepairStat(runtime: unknown, key: string): void {
  const box = sessionCounterBox(runtime);
  if (!box) {
    return;
  }
  const stats =
    box.submitRepairStats && typeof box.submitRepairStats === 'object'
      ? (box.submitRepairStats as Record<string, number>)
      : {};
  stats[key] = (Number(stats[key]) || 0) + 1;
  box.submitRepairStats = stats;
}
