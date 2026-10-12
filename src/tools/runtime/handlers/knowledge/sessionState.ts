/** 跨阶段浅拷贝共享的计数状态；预算字段必须保持引用身份。 */
import { numberValue } from './input.js';

/**
 * submit 修复层计数键的单一登记表（I39）。每个键对应 authoring.ts 中一处
 * "模型输出不合格→程序确定性代修"的路径，键名即 phases._pipelineOutcome.submitRepairs 的投影键：
 * - evidence_refs_inferred：refs 回推——refs 缺席但手写 sources 命中台账同文件条目，机械回填 evidenceRefs；
 * - evidence_sanitized：证据矫正（E7）——basename 唯一矫正 / 丢弃坏引用 / 证据驱动 scope 收窄；
 * - bare_refs_normalized：F4f 裸路径规范化——无行号 sourceRefs 用 Analyst 接地范围补成 path:start-end；
 * - unsafe_core_code_removed：不安全/无界 coreCode 被移除（是剥除不是回填，不复活片段）；
 * - graph_refs_injected：F4e——GRAPH_REF_INVALID 时注入 Analyst 真实 graph 查询的 refs；
 * - style_waiver：软规则一次申辩被接受；
 * - style_repair_subcall：风格修复子调用产物被采纳；
 * - style_advisories：剩余软违规降级为 advisory 随候选入库。
 * 新增修复层必须先在此登记（bumpSubmitRepairStat 的 key 参数按此收窄，编译期拦截错拼），
 * test/knowledge-submit-stop-loss.test.ts 会核对 src 中的写入点与本表一一对应。
 */
export const SUBMIT_REPAIR_STAT_KEYS = [
  'evidence_refs_inferred',
  'evidence_sanitized',
  'bare_refs_normalized',
  'unsafe_core_code_removed',
  'graph_refs_injected',
  'style_waiver',
  'style_repair_subcall',
  'style_advisories',
] as const;

export type SubmitRepairStatKey = (typeof SUBMIT_REPAIR_STAT_KEYS)[number];

/**
 * sharedState._sessionCounters 盒内的全部键（I39：此前键分散在 authoring.ts 与
 * submissionResult.ts 写入、PipelineStrategy 读取，没有统一类型）。盒本身来自无类型的
 * sharedState（宿主或 PipelineStrategy 预建），读取方仍须按"可能缺席或形状不对"防御性读取；
 * 这里约束的是本仓写入形状与键名。
 */
export interface SessionCounters {
  /** H1 同题硬止损：按标题的提交尝试次数（旧宿主顶层 sharedState._submitTitleAttempts 为兼容别名）。 */
  _submitTitleAttempts?: Record<string, number>;
  /** E7-R：按标题的风格修复子调用次数（每题上限 2）。 */
  _styleRepairAttempts?: Record<string, number>;
  /** 软规则申辩的会话累计次数（上限 STYLE_WAIVER_SESSION_LIMIT）。 */
  styleWaiverTotal?: number;
  /** F3 拒绝止损：连续拒绝次数；门禁通过归零。同标题硬止损与必填项前检拒绝不计入。 */
  gateRejectStreak?: number;
  /** F3 拒绝止损：会话累计拒绝次数（全部模型可修的拒绝分支都计入，含同标题硬止损与必填项拒绝）。 */
  gateRejectTotal?: number;
  /** P0-4 修复层命中计数，键见 SUBMIT_REPAIR_STAT_KEYS。 */
  submitRepairStats?: Partial<Record<SubmitRepairStatKey, number>>;
  /** 入库后 Core readiness 回执（submissionResult.ts 写入，PipelineStrategy 收尾投影）。 */
  recipeReadinessReports?: Array<Record<string, unknown>>;
}

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
 * 会话级计数盒(题目预算/修复层计量/waiver 上限/拒绝止损/readiness 回执共用宿主，键见 SessionCounters)。
 *
 * 为什么不能挂 ctx.runtime：ToolExecutionPipeline.buildRuntimeToolCallRequest 对每次工具
 * 调用现造一个一次性 runtime 投影对象——直接写在 ctx.runtime 上的字段随调用即弃(门0 真跑
 * 实测：修复层日志触发而计数恒空；waiver 上限与拒绝止损同因失效,streak 永远到不了阈值)。
 * 为什么是嵌套盒而非 sharedState 顶层字段：PipelineStrategy 的 decisionOnly/recordRepair
 * 阶段会对 sharedState 做浅拷贝,顶层字段写在拷贝上会丢；浅拷贝保留嵌套对象引用,盒内
 * 计数在整个维度会话内单调累计。盒由 PipelineStrategy.execute 入口预建(先于任何阶段拷贝)；
 * 此处兜底自建覆盖非管线宿主。无 sharedState 时返回 null → 计数静默跳过(观测不影响执行)。
 */
export function sessionCounterBox(runtime: unknown): SessionCounters | null {
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
    return existing as SessionCounters;
  }
  const box: SessionCounters = {};
  state._sessionCounters = box;
  return box;
}

/**
 * F3 拒绝止损计数（I39）：streak/total 的唯一累加点，不含日志与指令文案（本模块按 layer
 * contract 不持有日志端口，由 authoring.ts 的 recordRejectAndDirective 选档并落日志）。
 * countsTowardStreak=false 用于同标题硬止损与必填项前检拒绝：只计 total、streak 不动
 * （既不累加也不归零）。无计数盒时返回 null，调用方据此留"跳过"诊断。
 */
export function recordSubmitReject(
  runtime: unknown,
  countsTowardStreak: boolean
): { streak: number; total: number } | null {
  const box = sessionCounterBox(runtime);
  if (!box) {
    return null;
  }
  const previousStreak = Number(box.gateRejectStreak) || 0;
  const streak = countsTowardStreak ? previousStreak + 1 : previousStreak;
  const total = (Number(box.gateRejectTotal) || 0) + 1;
  if (countsTowardStreak) {
    box.gateRejectStreak = streak;
  }
  box.gateRejectTotal = total;
  return { streak, total };
}

/**
 * P0-4(挖掘质量升级)：submit 修复层命中计数。submit 周围有多层"模型输出不合格→程序
 * 确定性代修"的修复路径，逐层键名与含义见 SUBMIT_REPAIR_STAT_KEYS——此前只有日志，无法回答
 * "哪些修复层在真实承重、哪些是死枝"。计数挂在 sessionCounterBox(见上,跨调用稳定)，由
 * PipelineStrategy 在管线收口时投影进 phases._pipelineOutcome.submitRepairs，评估 harness
 * 据此算 repair-hit-rate；P2 契约收紧时按计量裁撤而非盲删。计数失败静默(观测不影响执行)。
 */
export function bumpSubmitRepairStat(runtime: unknown, key: SubmitRepairStatKey): void {
  const box = sessionCounterBox(runtime);
  if (!box) {
    return;
  }
  const stats: Partial<Record<SubmitRepairStatKey, number>> =
    box.submitRepairStats && typeof box.submitRepairStats === 'object' ? box.submitRepairStats : {};
  stats[key] = (Number(stats[key]) || 0) + 1;
  box.submitRepairStats = stats;
}
