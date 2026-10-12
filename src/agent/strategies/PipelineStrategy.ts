/**
 * PipelineStrategy — 顺序多阶段执行策略
 *
 * 每个阶段可以有不同的 Capability 和 Budget，阶段间可插入质量门控 (Quality Gate)。
 * 等价于 Anthropic 的 "Prompt Chaining" + "Evaluator-Optimizer"。
 *
 * 门动作表（#processGate；evaluator 返回 action，缺省由 pass 布尔推导为 pass/analysis_retry，
 * action='pass' 却 pass=false 归一为 reject；无 evaluator 时走阈值评估，只产生 pass/analysis_retry）：
 *   - pass                    → 'continue'，进入下一阶段（非终态）
 *   - analysis_retry / retry  → 回退到前一执行阶段重跑（非终态）；次数上限 gate.maxRetries；
 *                               会话输入预算压制时转 degraded_budget_exhausted（终态）；次数耗尽记
 *                               retryExhausted + abandonInfo(retry_exhausted)，再按 skipOnFail 决定是否继续
 *   - record_repair           → 跑记录补写微阶段后重评（非终态）；上限 gate.maxRecordRepairRetries；
 *                               仍不通过转 degraded_no_findings（终态）
 *   - summary_rewrite         → 跑零工具重写微阶段后重评（非终态）；上限 gate.maxSummaryRewriteRetries；
 *                               重写后仍判 summary_rewrite 或产出为空则转 analysis_retry 路径
 *   - degrade                 → ctx.degraded=true 并 'break'（终态；内部合成的 degraded_* 同为终态）
 *   - reject 及其他非通过动作 → 记 abandonInfo，再按 skipOnFail 决定是否继续
 *   - aborted                 → evaluator 被父信号取消，'break'
 *   skipOnFail：缺省/true 时非通过门直接 'break'；显式 false 时 'continue' 执行后续阶段。
 *   它只影响执行是否继续，不改变 outcome 里的非通过事实。
 *
 * 源阶段最终回执超时（I05，方案 A「超时即终态」）：规则只覆盖 produce 上游的分析类阶段（analyze /
 *   evolve 等，即源阶段不是 producer；producer 的例外见本段末尾）。门评估照常进行并记录，但动作按
 *   下表改写——
 *   - pass / summary_rewrite / record_repair → 不是恢复（rewrite/repair 只改 reply，最终回执仍
 *                               timedOut；门 pass 更不会改回执），改走 analysis_retry 整段重跑——
 *                               这是最终回执规则唯一承认的恢复路径（重跑成功会覆盖回执）
 *   - analysis_retry / retry  → 原样进入重试分支；额度用尽、被会话输入预算压制时都是终态 'break'
 *   - degrade 族 / aborted    → 原样（本就终态）
 *   - reject 及其他非通过动作 → 终态 'break'（skipOnFail=false 也不继续：超时回执无可继续之物）
 *   每条终态都写 diagnostics.warn(pipeline_timeout_terminal) + warn 日志 + abandonInfo(action=
 *   timeout_terminal)。执行阶段最终回执超时而下一阶段不是裁决它的门时，主循环直接 'break'，
 *   避免 produce 在超时的 analyze 上白跑并持久化候选（宿主按 timedOutStages 判 timeout、计 0 候选）。
 *   严格链无法合成 transition，源阶段超时时 pass 直接终态；门自身非通过仍走 fail-closed。
 *   producer 阶段（按名 produce/producer，或严格链 strict-producer-v1 角色面；判别与
 *   withProducerCoverageBudget / #resolveStageTracker 同源，见 #isProducerStage）不在规则内，保持
 *   改动前语义：它边跑边经 knowledge.submit 持久化候选，宿主（AgentRunProjections.
 *   isRecoverableProducerTimeoutIssue）按 status=timeout + timedOutStages 含 produce +
 *   phases.produce.toolCalls 里的持久化提交数判「超时可救回」并按首轮回执计数。裁决它的门
 *   （rejection_gate / 严格链 G2）按评估器原始裁决处理：pass 则管线正常结束、outcome 仍按最终回执
 *   判 failed、status 仍为 timeout 交宿主判定；retry 仍是既有拒绝重试。若把 pass 改写成
 *   analysis_retry，会用「N 个提交被拒绝」的拒绝重试 prompt 白跑一轮，并以第二轮回执覆盖首轮已
 *   持久化的提交，宿主计 0 候选——这正是规则不覆盖 producer 的原因。producer 自身超时也不触发
 *   主循环的直接终止（同一边界，见 #terminateOnTimedOutStage）。
 *
 * 严格链（strategyContext 携带 strict production 上下文）：第一个非通过门 fail-closed——写 typed
 * gate return、置 strictFailed 并 'break'，legacy repair/degrade/skipOnFail 均不接管；只有
 * strictGate.retryMode='strict-analysis-epoch' 的 analysis_retry 允许回退到 strict-analyst 阶段，
 * 每次 transition 追加到 phaseResults._strictAnalysisLoopReceipt（只追加，不校验跨 gate 连续性）。
 *
 * Producer 分析产物交接（I37）：非严格链的 producer 阶段（#isProducerStage）按门名读取
 *   phaseResults.quality_gate.artifact，覆盖率预算（withProducerCoverageBudget）与 promptBuilder 入参
 *   gateArtifact（字段名不变）共用这一次读取；读不到或形状不符时为 null 并记
 *   diagnostics.warn(pipeline_producer_analysis_artifact_unavailable)，管线未声明 quality_gate 时只记
 *   info 日志。ctx.gateArtifact（最近一个带产物的门）不再喂给非严格 producer——rejection_gate/中间门
 *   的产物、或 quality_gate 无产物时更早的 evolution_gate 产物都会被误当成分析结果；它只留给严格链
 *   （G1 pass 显式投影 transition.resultArtifact）与非 producer 阶段。见 #resolveStageGateArtifact。
 *
 * 结局投影：execute 末尾把 aborted / failed(strictFailed 或阶段最终回执超时) / abandoned(degrade
 * 族、retry_exhausted、其他非通过) / completed 连同 abandonInfo 写入 phaseResults._pipelineOutcome，
 * 供父 run 聚合 abandonedModules。修复微阶段的结果也写入 phaseResults，不能据插入顺序猜最后主阶段。
 *
 * fast retry（I36）：非严格链、非门重试的阶段若声明了 retryBudget，首次尝试硬超时且确认零工具调用
 *   时用 retryBudget 同阶段重跑一次。重跑前清空 ContextWindow，因此提示必须是首次尝试缓存的完整
 *   阶段提示（为空时重建）再追加超时提示段；retryPromptBuilder 只服务门重试，这里不调用。每次 fast
 *   retry 写 diagnostics.warn(pipeline_stage_fast_retry) + info 日志（原因、提示来源、是否绕过
 *   retryPromptBuilder、retryBudget）。
 *
 * 其他特性：Stage 支持 promptBuilder(context)、systemPrompt、onToolCall；per-stage 硬超时；
 * 阶段隔离 (ContextWindow/ExplorationTracker 状态)。
 *
 * @module PipelineStrategy
 */

import { DIMENSION_COMPLETION_FLOOR } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import { runOperation } from '#shared/operation.js';
import { ExplorationTracker } from '../context/ExplorationTracker.js';
import type { PipelineType } from '../context/exploration/ExplorationStrategies.js';
import {
  createStrictAnalysisEpochSnapshotV1,
  createStrictTypedGateReturnV1,
  type StrictAnalysisContextProjectionV1,
  type StrictAnalysisEpochTransitionV1,
  validateStrictStageToolCallsV1,
} from '../production/StrictProductionPipeline.js';
import { buildRecordRepairPrompt, buildSummaryRewritePrompt } from '../prompts/insightGate.js';
import { AgentEventBus, AgentEvents } from '../runtime/AgentEventBus.js';
import type { AgentMessage } from '../runtime/AgentMessage.js';
import { DiagnosticsCollector, isDegradeGateAction } from '../runtime/DiagnosticsCollector.js';
import type { ForcedSummaryMode } from '../runtime/forcedSummary.js';
import { expandSystemRunContext } from '../runtime/SystemRunContext.js';
import { isPersistedSubmission } from '../utils/toolOutcomes.js';
import { runStageAttempt, type StageAttemptScope } from './pipeline/attempt.js';
import type { PipelineRuntime, StageResult } from './pipeline/contracts.js';
import { Strategy } from './Strategy.js';

// ───── Local Types for PipelineStrategy ──────────────────

/** Budget configuration for a pipeline stage */
interface StageBudget {
  maxIterations?: number;
  timeoutMs?: number;
  [key: string]: unknown;
}

/** Capability reference: plain string name or object with a name property */
type CapabilityRef = string | { name: string; [key: string]: unknown };

/** Quality Gate configuration */
interface GateConfig {
  evaluator?: (
    source: unknown,
    phaseResults: Record<string, unknown>,
    strategyContext: Record<string, unknown>
  ) =>
    | { action?: string; pass?: boolean; reason?: string; artifact?: unknown }
    | Promise<{ action?: string; pass?: boolean; reason?: string; artifact?: unknown }>;
  maxRetries?: number;
  maxRecordRepairRetries?: number;
  recordRepairMinFindings?: number;
  recordRepairMaxRounds?: number;
  recordRepairTimeoutMs?: number;
  recordRepairMaxTokens?: number;
  /** summary_rewrite(纯写作重组)配置：与 record_repair 同一微阶段范式 */
  maxSummaryRewriteRetries?: number;
  summaryRewriteTimeoutMs?: number;
  summaryRewriteMaxTokens?: number;
  useCumulativeToolCalls?: boolean;
  minEvidenceLength?: number;
  minFileRefs?: number;
  minToolCalls?: number;
  custom?: (source: Record<string, unknown>) => { pass: boolean; reason?: string };
  /** 严格链非通过时的 Core typed return 所需 owner/resume 边界。 */
  strictGate?: {
    gate: 'G1' | 'ADMISSION' | 'G2' | 'G3' | 'G4' | 'DURABLE' | 'PUBLIC';
    reasonCode: string;
    owner: string;
    resumePoint: string;
    permittedMutation: string;
    semanticRepairDepth?: number;
    passReasonCode?: string;
    retryMode?: 'strict-analysis-epoch';
  };
  [key: string]: unknown;
}

/** Pipeline stage definition */
interface PipelineStage {
  name: string;
  /** Strict runs must carry an immutable role marker from the strict stage factory. */
  strictRoleSurface?: 'strict-analyst-v1' | 'strict-producer-v1';
  gate?: GateConfig;
  capabilities?: CapabilityRef[];
  additionalTools?: string[];
  promptBuilder?: (ctx: Record<string, unknown>) => Promise<string> | string;
  /**
   * 只服务门重试：门判 analysis_retry/retry 写入 phaseResults._retryContext 后，回退到本阶段重跑时
   * 由 #buildStagePrompt 使用。硬超时零工具的 fast retry 不调用它（I36），而是复用原阶段提示并
   * 追加超时提示。
   */
  retryPromptBuilder?: (
    retryCtx: { reason?: string; artifact?: unknown },
    content: string,
    phaseResults: Record<string, unknown>
  ) => string;
  promptTransform?: (content: string, phaseResults: Record<string, unknown>) => string;
  systemPrompt?: string;
  onToolCall?: (...args: unknown[]) => unknown;
  budget?: StageBudget;
  retryBudget?: StageBudget;
  skipOnFail?: boolean;
  submitToolName?: string;
  decisionOnlyOnRetry?: boolean;
  recordRepairOnly?: boolean;
  disableTracker?: boolean;
  toolChoiceOverride?: string;
  recordRepairEvidencePaths?: string[];
  /** 管线类型标识 — 传递至 ExplorationTracker 用于统一场景判别 */
  pipelineType?: PipelineType;
  source?: string;
  [key: string]: unknown;
}

/** Pipeline execution context (internal mutable state passed between stages) */
interface PipelineContext {
  phaseResults: Record<string, unknown>;
  strategyContext: Record<string, unknown>;
  totalToolCalls: Array<Record<string, unknown>>;
  totalTokenUsage: { input: number; output: number };
  totalIterations: number;
  /**
   * 最近一个带真值产物的门（#storeGateResult 写入）；严格链 G1 pass 时被显式覆盖为
   * transition.resultArtifact。I37：非严格 producer 不读它，改为按门名读取 quality_gate。
   */
  gateArtifact: unknown;
  degraded: boolean;
  diagnostics: DiagnosticsCollector;
  execStageCount: number;
  lastExecutedStageName: string | null;
  /**
   * P0-4(挖掘质量升级)：degrade 的一等化信息。此前 degrade 只置布尔+日志，弱维度
   * 静默产 0 候选，父 run/调用方拿不到"哪个门、什么动作、什么原因"——这里在
   * #storeGateResult 单点捕获首个 degrade 类动作(degrade / degraded_no_findings /
   * degraded_budget_exhausted，均为终态)，最终投影进 phases._pipelineOutcome。
   */
  abandonInfo: { stage: string; action: string; reason: string } | null;
  /**
   * P1-A F2：第三种静默归零形态——analysis_retry 耗尽后 break(不设 degraded)此前产出
   * `completed + 0 候选`且无原因留痕。此标记让 outcome 如实报 abandoned(action='retry_exhausted')，
   * 而 degraded 布尔保持原语义不动(只表示 degrade 类门动作)。
   */
  retryExhausted: boolean;
  /** 严格链失败不是可降级成功，也不沿用 legacy abandoned 语义。 */
  strictFailed: boolean;
  /** 父信号或阶段主动停止都终止本管线；诊断只投影原因，不反向控制流程。 */
  cancelled: boolean;
}

interface GateEvalResult {
  action: string;
  pass: boolean;
  reason?: string;
  artifact?: unknown;
}

function producerStructuredFindingTarget(artifact: unknown): number {
  if (!artifact || typeof artifact !== 'object') {
    return 0;
  }
  const findings = (artifact as { findings?: unknown }).findings;
  return Array.isArray(findings) ? findings.length : 0;
}

/**
 * I37(L5-P31)：非严格链 producer 的分析产物来源门。阶段名是 runtime/host 共享标识(insightPreset、
 * stageBuilders 与 AgentStageFactoryRegistry 都按 analyze/quality_gate/produce/rejection_gate 组装)，
 * producer 按这个名字从 phaseResults 读取，而不是读「最近一个带产物的门」。
 */
const ANALYSIS_GATE_STAGE = 'quality_gate';

/**
 * I11（L5-P26）：本类自己构造的修复微阶段 → 强制摘要模式。
 *
 * summary_rewrite / record_repair 微阶段没有 tracker，正文要么只用于写回 analyze（rewrite），
 * 要么无消费方（repair）；它们无文本退出时不能再由 Runtime 按旧推断补一份 dimensionDigest 兜底，
 * 否则 rewrite 的兜底 JSON 会被当作可用文本覆盖 analyze 正文、绕过 analysis_retry。
 * 过渡实现：阶段策略对象（待决事项④）落地前不在阶段配置上新增公开字段，而是私有登记
 * #runRecordRepairStage / #runSummaryRewriteStage 构造的阶段对象；#runPreparedStage 据此在
 * runLoop context 中显式传 summaryMode，AgentRuntime.#finalize 优先采用该显式声明。
 *
 * 只登记这两个微阶段：它们由门内联调用，不会成为 lastMainStageName，reply 不进入管线最终 reply。
 * 进化补写轮（decisionOnlyOnRetry 的重试）不是微阶段——它是被门跳回重跑的主阶段，reply 就是
 * 管线最终 reply，AgentService.inferRunStatus 以空 reply 判 error，所以不在此登记、保持原推断。
 */
const MICRO_STAGE_SUMMARY_MODES = new WeakMap<PipelineStage, ForcedSummaryMode>();

/** 按门名读取分析产物的结果：status 区分「门没跑 / 门没留产物 / 产物形状不符」，供诊断定位。 */
type AnalysisGateArtifactRead =
  | { status: 'ok'; artifact: Record<string, unknown> }
  | {
      status: 'gate_not_evaluated' | 'artifact_missing' | 'artifact_malformed';
      artifact: null;
      detail: string;
    };

/** 诊断用：列出产物的前 8 个键，非对象时报告其类型。 */
function describeArtifactKeys(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return describeValueKind(value);
  }
  return Object.keys(value).slice(0, 8).join(',') || 'none';
}

function describeValueKind(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * I37：从阶段结果里按门名读取分析产物(仿 gateEvaluators.readEvolutionGateArtifact)。
 *
 * 形状契约取 producer 两个消费方的交集：普通对象，且至少带 findings 数组(覆盖率预算按条数放大)或
 * analysisText 字符串(提示构建)之一；已出现的这两个字段类型不符同样算形状不符。读不到或形状不符
 * 一律返回 artifact=null 并附 status/detail——这里不做任何兜底取值(尤其不回退到别的门的产物)，
 * 由调用方决定记诊断还是只记日志。
 */
function readAnalysisGateArtifact(
  phaseResults: Record<string, unknown>,
  gateName: string
): AnalysisGateArtifactRead {
  const gate = phaseResults[gateName];
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
    return {
      status: 'gate_not_evaluated',
      artifact: null,
      detail: `phaseResults.${gateName} is ${describeValueKind(gate)}`,
    };
  }
  const { artifact, action } = gate as { artifact?: unknown; action?: unknown };
  if (artifact === null || artifact === undefined) {
    // #storeGateResult 把 falsy 产物统一存成 null：门判了动作却没交出分析产物。
    return {
      status: 'artifact_missing',
      artifact: null,
      detail: `gate action=${String(action)} stored no artifact`,
    };
  }
  if (typeof artifact !== 'object' || Array.isArray(artifact)) {
    return {
      status: 'artifact_malformed',
      artifact: null,
      detail: `artifact is ${describeValueKind(artifact)}`,
    };
  }
  const record = artifact as Record<string, unknown>;
  const hasFindings = Array.isArray(record.findings);
  const hasAnalysisText = typeof record.analysisText === 'string';
  const problems: string[] = [];
  if (record.findings !== undefined && record.findings !== null && !hasFindings) {
    problems.push(`findings is ${describeValueKind(record.findings)}`);
  }
  if (record.analysisText !== undefined && record.analysisText !== null && !hasAnalysisText) {
    problems.push(`analysisText is ${describeValueKind(record.analysisText)}`);
  }
  if (problems.length === 0 && !hasFindings && !hasAnalysisText) {
    problems.push(
      `neither findings[] nor analysisText present (keys=${describeArtifactKeys(record)})`
    );
  }
  if (problems.length > 0) {
    return { status: 'artifact_malformed', artifact: null, detail: problems.join('; ') };
  }
  return { status: 'ok', artifact: record };
}

/**
 * I04(L5-P29)：读取阶段预算上的 hardSubmitCap(增量重扫由 AgentStageFactoryRegistry 写入的硬配额)。
 * 缺省/null/undefined → null(bootstrap 冷启动没有配额)；存在但不是有限正数 → 'invalid'，由调用方
 * 记 warn 后按无配额处理——坏配置不能静默改变数量语义，也不能让 produce 因此拿到 0 上限。
 */
function readHardSubmitCap(budget: StageBudget | undefined): number | null | 'invalid' {
  const raw = budget?.hardSubmitCap;
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return 'invalid';
  }
  const cap = Math.floor(raw);
  return cap > 0 ? cap : 'invalid';
}

/**
 * produce 阶段的覆盖率预算：按 quality_gate 的结构化 findings 数决定提交目标/上限/时间。
 * analysisArtifact 由 #resolveStageGateArtifact 按门名从 quality_gate 读取(I37)；读不到时为 null，
 * findings 计 0，预算原样返回(不放大)——读取失败的诊断已由调用方记录。
 *
 * 三条分叉(每条都留日志)：
 *   - isRetry：重试轮沿用声明预算(retryBudget 或 stage.budget 原值)，不放大、不注入 targetSubmits。
 *     preset/stageBuilders 把 retryBudget 声明为"缩减预算"(5 轮/300s 等)，重试 prompt 只修被拒条目；
 *     放大会把 300s 拉到 1800s 并让 tracker 以 targetSubmits=findings 催促提交全部条目。首轮已经
 *     按覆盖率放大过一次，重试不是第二次覆盖；与 fast-retry 直接用 retryBudget 的口径一致。
 *     按决策"沿用声明的 retryBudget"，这里不把 stage.budget 的 hardSubmitCap 补进 retryBudget：
 *     重试轮的提交上限由 retryBudget 自身(未声明时是 tracker 默认值)决定，日志报告阶段声明的 cap
 *     以便定位。
 *   - hardSubmitCap(增量重扫)：配额是计划层硬上限——targetSubmits=min(findings, cap)、maxSubmits=cap，
 *     tracker 在第 cap 次持久化提交后转 SUMMARIZE，完成文本不再被催促。
 *   - 无 cap(bootstrap 冷启动)：保留 H3(2026-07-02 数量专项)放大——静态 10 会把丰富维度硬顶
 *     (真机 findings=24 只能提 10)，放大到 findings+4(拒绝重试余量)，原值作下限。
 * 时间预算(P-5)按最终 maxSubmits 估算：真机每轮提交 60-90s，90s/轮，下限原值、上限 1800s；封顶后
 * cap×90s 通常不超过原值，等价于保持原值。
 */
function withProducerCoverageBudget(
  stage: PipelineStage,
  budget: StageBudget | undefined,
  analysisArtifact: unknown,
  strictProduction: boolean,
  isRetry: boolean
): StageBudget | undefined {
  if (stage.name !== 'produce' && stage.name !== 'producer') {
    return budget;
  }
  if (strictProduction) {
    return budget;
  }
  const findingCount = producerStructuredFindingTarget(analysisArtifact);
  if (findingCount <= 0) {
    return budget;
  }
  const baseMaxSubmits = Number(budget?.maxSubmits) || 10;
  const baseTimeoutMs = Number(budget?.timeoutMs) || 0;
  const capState = readHardSubmitCap(budget);
  if (isRetry) {
    // 预算来源与 #executeStage 的选择顺序一致：retryBudget > stage.budget > 宿主算出的预算。
    // 重试预算(preset retryBudget)本身不带 hardSubmitCap，这里按 stage.budget 报告阶段声明的配额，
    // 让日志能看出"该阶段受 rescan 配额约束，但重试轮按声明的 retryBudget 原值运行"。
    const budgetSource = stage.retryBudget
      ? 'retryBudget'
      : stage.budget
        ? 'stage.budget'
        : 'computed budget';
    const stageCap = readHardSubmitCap(stage.budget);
    _pipelineLogger().info(
      `[PipelineStrategy] Stage "${stage.name}" (retry) reuses declared ${budgetSource} — producer coverage amplification skipped (findings=${findingCount}, stageHardSubmitCap=${stageCap === null ? 'none' : stageCap}, maxSubmits=${budget?.maxSubmits ?? 'default'}, timeoutMs=${baseTimeoutMs || '∞'})`
    );
    return budget;
  }
  if (capState === 'invalid') {
    _pipelineLogger().warn(
      `[PipelineStrategy] Stage "${stage.name}" ignores invalid hardSubmitCap=${String(budget?.hardSubmitCap)} — falling back to coverage amplification (findings=${findingCount}, baseMaxSubmits=${baseMaxSubmits})`
    );
  }
  const hardSubmitCap = typeof capState === 'number' ? capState : null;
  const targetSubmits =
    hardSubmitCap !== null ? Math.min(findingCount, hardSubmitCap) : findingCount;
  const maxSubmits =
    hardSubmitCap !== null ? hardSubmitCap : Math.max(baseMaxSubmits, findingCount + 4);
  const scaledTimeoutMs =
    baseTimeoutMs > 0
      ? Math.min(1_800_000, Math.max(baseTimeoutMs, maxSubmits * 90_000))
      : baseTimeoutMs;
  if (hardSubmitCap !== null) {
    _pipelineLogger().info(
      `[PipelineStrategy] Stage "${stage.name}" producer coverage budget capped by hardSubmitCap — findings=${findingCount}, hardSubmitCap=${hardSubmitCap}, baseMaxSubmits=${baseMaxSubmits} → maxSubmits=${maxSubmits}, targetSubmits=${targetSubmits}, timeoutMs=${scaledTimeoutMs || '∞'}`
    );
  } else {
    _pipelineLogger().info(
      `[PipelineStrategy] Stage "${stage.name}" producer coverage budget amplified — findings=${findingCount}, baseMaxSubmits=${baseMaxSubmits} → maxSubmits=${maxSubmits}, targetSubmits=${targetSubmits}, timeoutMs=${scaledTimeoutMs || '∞'}`
    );
  }
  return {
    ...(budget || {}),
    targetSubmits,
    maxSubmits,
    ...(scaledTimeoutMs > 0 ? { timeoutMs: scaledTimeoutMs } : {}),
  };
}

/**
 * P0-4：读取 knowledge.submit 修复层的会话命中计数。计数宿主是 sharedState._sessionCounters
 * 嵌套盒(handler 侧 sessionCounterBox 写入)——不能挂 runtime：ToolExecutionPipeline 给
 * handler 的 ctx.runtime 是每次调用现造的一次性投影,写上去即弃(门0 真跑实测假零后根修)；
 * 嵌套盒同时对阶段级 sharedState 浅拷贝免疫(拷贝保留盒引用)。这里只做防御性读取——
 * 形状不对/为空一律返回 null(不投影)，绝不让观测面影响执行。
 */
function readSubmitRepairStats(sharedState: unknown): Record<string, number> | null {
  if (!sharedState || typeof sharedState !== 'object') {
    return null;
  }
  const box = (sharedState as Record<string, unknown>)._sessionCounters;
  if (!box || typeof box !== 'object' || Array.isArray(box)) {
    return null;
  }
  const raw = (box as Record<string, unknown>).submitRepairStats;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function readRecipeReadinessReports(sharedState: unknown): Array<Record<string, unknown>> | null {
  if (!sharedState || typeof sharedState !== 'object') {
    return null;
  }
  const box = (sharedState as Record<string, unknown>)._sessionCounters;
  if (!box || typeof box !== 'object' || Array.isArray(box)) {
    return null;
  }
  const reports = (box as Record<string, unknown>).recipeReadinessReports;
  if (!Array.isArray(reports)) {
    return null;
  }
  const valid = reports.filter(
    (report): report is Record<string, unknown> =>
      !!report && typeof report === 'object' && !Array.isArray(report)
  );
  return valid.length > 0 ? valid : null;
}

/** Lightweight ContextWindow subset consumed by pipeline stages */
interface StageContextWindow {
  resetForNewStage(): void;
  tokenCount?: number;
  [key: string]: unknown;
}

// AD4: lazy logger accessor — the Core logger singleton materializes on first
// use instead of at module import (no import-time work; same singleton).
const _pipelineLogger = () => Logger.getInstance();

/**
 * I36：fast retry（首次尝试硬超时且确认零工具调用后、用 retryBudget 的同阶段重跑）追加在完整
 * 阶段提示之后的提示段。它只说明「上次超时、直接开工」；任务本身（门产物 findings、维度配置、
 * 证据入口等）仍由原阶段提示承载——重跑前 ContextWindow 会被清空，不能只发这一段。
 */
const FAST_RETRY_TIMEOUT_NOTICE =
  '【超时重试】上一次尝试超时且未调用任何工具。请不要先输出长篇规划，直接开始调用工具完成上面的阶段任务。';

/** 在阶段提示末尾追加 fast retry 超时提示；阶段提示为空时只能发送提示段本身（调用方另行留痕）。 */
function appendFastRetryNotice(stagePrompt: string): string {
  return stagePrompt ? `${stagePrompt}\n\n${FAST_RETRY_TIMEOUT_NOTICE}` : FAST_RETRY_TIMEOUT_NOTICE;
}

export class PipelineStrategy extends Strategy {
  #stages: PipelineStage[];

  /** 最大重试次数 (Gate 失败时全局兜底) */
  #maxRetries;

  constructor({
    stages = [],
    maxRetries = 1,
  }: { stages?: PipelineStage[]; maxRetries?: number } = {}) {
    super();
    this.#stages = stages;
    this.#maxRetries = maxRetries;
  }

  get name() {
    return 'pipeline';
  }

  async execute(
    runtime: PipelineRuntime,
    message: AgentMessage,
    opts: Record<string, unknown> = {}
  ) {
    const bus = AgentEventBus.getInstance();
    const rawStrategyContext = {
      ...(opts.systemRunContext ? { systemRunContext: opts.systemRunContext } : {}),
      ...((opts.strategyContext || {}) as Record<string, unknown>),
    };
    // AgentService 会把资源平铺到 RuntimeOptions；只接收这五项，不把 budget 等运行控制
    // 混入 prompt context。既有 system/显式 strategy 投影优先，资源本身保持原引用。
    const flatResources = Object.fromEntries(
      ['contextWindow', 'trace', 'memoryCoordinator', 'sharedState', 'source']
        .filter((key) => opts[key] !== undefined)
        .map((key) => [key, opts[key]])
    );
    const incomingStrategyContext = {
      ...flatResources,
      ...expandSystemRunContext(rawStrategyContext),
    };
    _pipelineLogger().debug('[PipelineStrategy] Context resource projection', {
      flatDefaults: Object.keys(flatResources),
      precedence: 'flat-defaults < system-context < explicit-strategy-context',
    });
    const diagnostics = DiagnosticsCollector.from(
      opts.diagnostics || incomingStrategyContext.diagnostics
    );
    const ctx: PipelineContext = {
      phaseResults: {} as Record<string, unknown>,
      strategyContext: {
        ...incomingStrategyContext,
        ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
        diagnostics,
      },
      totalToolCalls: [] as Array<Record<string, unknown>>,
      totalTokenUsage: { input: 0, output: 0 },
      totalIterations: 0,
      gateArtifact: null,
      degraded: false,
      diagnostics,
      execStageCount: 0,
      lastExecutedStageName: null,
      abandonInfo: null,
      retryExhausted: false,
      strictFailed: false,
      cancelled: false,
    };

    // 会话计数盒预建：必须在任何阶段对 sharedState 做浅拷贝之前把嵌套盒挂上——
    // handler 侧经 ToolExecutionPipeline 每次调用一次性 runtime 投影里的 sharedState 引用
    // 写入同一个盒(修复层计量/waiver 上限/拒绝止损三族计数)，收尾投影从盒读取。
    // 无 sharedState 的宿主保持原静默不计语义。
    const baseSharedStateForCounters = ctx.strategyContext.sharedState as
      | Record<string, unknown>
      | null
      | undefined;
    if (
      baseSharedStateForCounters &&
      typeof baseSharedStateForCounters === 'object' &&
      !baseSharedStateForCounters._sessionCounters
    ) {
      baseSharedStateForCounters._sessionCounters = {};
    }

    let lastMainStageName: string | null = null;
    for (let i = 0; i < this.#stages.length; i++) {
      if (this.#isCancelled(ctx)) {
        this.#recordCancellation(ctx);
        break;
      }
      const stage = this.#stages[i];

      // ── Quality Gate 阶段 ──
      // degrade 类门动作是终态：#processGate 置 ctx.degraded 后必返回 'break'，循环到此结束，
      // 因此这里不需要「降级后跳过后续阶段」的分支。
      if (stage.gate) {
        const gateAction = await this.#processGate(runtime, message, stage, i, ctx, bus);
        if (gateAction === 'break') {
          break;
        }
        if (gateAction === 'continue') {
          continue;
        }
        if (typeof gateAction === 'number') {
          i = gateAction; // retry: jump back
          continue;
        }
        break; // unknown action fallback
      }

      // ── 执行阶段 ──
      await this.#executeStage(runtime, message, stage, ctx, bus);
      lastMainStageName = stage.name;
      // I05：最终回执超时即终态。下一阶段若是裁决本阶段的门，由 #processGate 决定整段重跑
      // 或终止；否则这里直接终止，不让下游(典型是 produce)在超时回执上白跑并持久化候选。
      if (this.#terminateOnTimedOutStage(stage, i, ctx)) {
        break;
      }
    }

    // 最终回复 = 最后一个执行阶段的输出
    // phaseResults 同时保存修复微阶段；覆写已有键不会改变插入顺序，不能据此猜最后主阶段。
    const lastStage = lastMainStageName
      ? (ctx.phaseResults[lastMainStageName] as StageResult | undefined)
      : undefined;

    // P0-4：管线结局一等化。phases 会原样穿透 AgentRuntime.execute → AgentRunResult.phases
    // → coordinator child result → merger，因此 _pipelineOutcome 是父 run 聚合
    // abandonedModules 的唯一读取面(下划线内部键与 _retries_/_retryContext 同一先例)。
    // submitRepairs 是 knowledge.submit 各确定性修复层的会话命中计数(宿主=sharedState 的
    // _sessionCounters 嵌套盒,见 readSubmitRepairStats 注释)——在此投影，
    // 评估 harness 据此算 repair-hit-rate。
    const submitRepairs = readSubmitRepairStats(ctx.strategyContext.sharedState);
    const recipeReadiness = readRecipeReadinessReports(ctx.strategyContext.sharedState);
    // F2：abandoned 覆盖 degrade 族 + retry_exhausted 两类放弃；degraded 布尔语义不变。
    const abandoned = ctx.degraded || ctx.retryExhausted || Boolean(ctx.abandonInfo);
    // 只看每个执行阶段的最终回执；一次超时后的成功重试不能被历史诊断重新判失败。
    const timedOut = this.#stages.some(
      (stage) =>
        !stage.gate && (ctx.phaseResults[stage.name] as StageResult | undefined)?.timedOut === true
    );
    const aborted = this.#isCancelled(ctx);
    if (aborted) {
      this.#recordCancellation(ctx);
    }
    const outcome = aborted
      ? 'aborted'
      : ctx.strictFailed || timedOut
        ? 'failed'
        : abandoned
          ? 'abandoned'
          : 'completed';
    ctx.phaseResults._pipelineOutcome = {
      outcome,
      ...(abandoned && ctx.abandonInfo ? ctx.abandonInfo : {}),
      ...(submitRepairs ? { submitRepairs } : {}),
      ...(recipeReadiness ? { recipeReadiness } : {}),
    };

    return {
      reply: lastStage?.reply || '',
      toolCalls: ctx.totalToolCalls,
      tokenUsage: ctx.totalTokenUsage,
      iterations: ctx.totalIterations,
      phases: ctx.phaseResults,
      degraded: ctx.degraded,
      ...(timedOut ? { timedOut: true } : {}),
      outcome,
      diagnostics: ctx.diagnostics.toJSON(),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // Private: Gate 处理
  // ═══════════════════════════════════════════════════════════

  /**
   * 处理 Quality Gate 阶段
   *
   * @returns 'break' | 'continue' | 目标阶段索引 - 1（调用方 for 循环 i++ 后落到目标阶段）
   */
  async #processGate(
    runtime: PipelineRuntime,
    message: AgentMessage,
    stage: PipelineStage,
    stageIndex: number,
    ctx: PipelineContext,
    bus: AgentEventBus
  ) {
    const { phaseResults } = ctx;
    if (!stage.gate) {
      return 'continue';
    }
    const gate = stage.gate;
    let gateResult = await this.#evaluateGateResult(stage, ctx, bus);
    if (this.#isCancelled(ctx)) {
      return 'break';
    }
    const strictContext = this.#strictProductionContext(ctx);
    const strictAnalysisRetryEnabled =
      Boolean(strictContext) && gate.strictGate?.retryMode === 'strict-analysis-epoch';

    // I05：源阶段最终回执超时即终态。pass/summary_rewrite/record_repair 都不能覆盖超时回执，
    // 改写为 analysis_retry 整段重跑后再入账(phaseResults/gateFailures/PROGRESS 只记有效裁决一次，
    // 原始动作写进 reason)；无法重跑的动作先把评估器原始裁决入账，再记超时终态并终止。
    // 见文件头「源阶段最终回执超时」动作表。
    const timedOutSource = this.#timedOutGateSource(stage, ctx);
    if (timedOutSource !== null) {
      const resolved = this.#resolveTimedOutSourceGate(
        stage,
        gateResult,
        timedOutSource,
        Boolean(strictContext)
      );
      if (resolved.kind === 'terminal') {
        this.#storeGateResult(stage, gateResult, ctx, bus);
        this.#recordTimeoutTerminal(ctx, stage.name || 'gate', resolved.reason);
        return 'break';
      }
      if (resolved.kind === 'rewritten') {
        gateResult = resolved.gateResult;
      }
    }
    this.#storeGateResult(stage, gateResult, ctx, bus);

    // 三态处理
    if (gateResult.action === 'pass') {
      if (strictAnalysisRetryEnabled) {
        const transition = this.#readStrictAnalysisTransition(gateResult, 'pass');
        this.#appendStrictAnalysisLoopReceipt(ctx, transition);
        // Gate artifact 保留 transition 供审计；Producer 仍消费既有 analysisArtifact 语义，
        // 避免把控制回执误当成 authored input。严格 producer 经 #resolveStageGateArtifact 读取的
        // 正是这一显式投影(I37 的按门名交接只作用于非严格链)。
        ctx.gateArtifact = transition.resultArtifact;
      }
      if (strictContext && gate.strictGate?.passReasonCode) {
        this.#appendStrictGateReturn(
          ctx,
          createStrictTypedGateReturnV1({
            gate: gate.strictGate.gate,
            verdict: 'pass',
            reasonCode: gate.strictGate.passReasonCode,
          })
        );
      }
      return 'continue';
    }

    // 严格冷启动在第一个非通过门立即失败关闭。legacy repair/degrade/skip 逻辑均不得接管，
    // 否则 Producer 会消费未达到 fixpoint 或已漂移的结果。
    if (strictContext) {
      const strictGate = gate.strictGate;
      if (!strictGate) {
        throw new Error(`STRICT_GATE_CONFIG_REQUIRED: ${stage.name || 'gate'}`);
      }
      if (gateResult.action === 'analysis_retry' && strictAnalysisRetryEnabled) {
        const transition = this.#readStrictAnalysisTransition(gateResult, 'analysis_retry');
        this.#appendStrictAnalysisLoopReceipt(ctx, transition);
        const previousStageIndex = this.#findPrevExecStageIdx(stageIndex);
        const retryStage = this.#stages[previousStageIndex];
        if (
          previousStageIndex < 0 ||
          retryStage?.name !== 'analyze' ||
          retryStage.strictRoleSurface !== 'strict-analyst-v1'
        ) {
          throw new Error('STRICT_ANALYSIS_RETRY_TARGET_INVALID');
        }
        phaseResults._retryContext = {
          reason: gateResult.reason,
          artifact: transition,
        };
        phaseResults._strictAnalysisRetryCount =
          Number(phaseResults._strictAnalysisRetryCount || 0) + 1;
        phaseResults[`_was_retry_${retryStage.name}`] = true;
        return previousStageIndex - 1;
      }
      if (
        gateResult.artifact &&
        typeof gateResult.artifact === 'object' &&
        !Array.isArray(gateResult.artifact) &&
        (gateResult.artifact as { kind?: unknown }).kind === 'StrictAnalysisEpochTransitionV1'
      ) {
        this.#appendStrictAnalysisLoopReceipt(
          ctx,
          gateResult.artifact as StrictAnalysisEpochTransitionV1
        );
      }
      const { passReasonCode: _passReasonCode, retryMode: _retryMode, ...failureGate } = strictGate;
      const typedReturn = createStrictTypedGateReturnV1({
        ...failureGate,
        verdict: 'failed',
      });
      this.#appendStrictGateReturn(ctx, typedReturn);
      ctx.strictFailed = true;
      return 'break';
    }

    if (gateResult.action === 'degrade') {
      ctx.degraded = true;
      ctx.diagnostics.markDegraded();
      return 'break';
    }

    if (gateResult.action === 'record_repair') {
      const repairKey = `_recordRepairRetries_${stage.name || 'gate'}`;
      phaseResults[repairKey] = ((phaseResults[repairKey] as number) || 0) + 1;
      const maxRecordRepairRetries = gate.maxRecordRepairRetries ?? 1;

      if ((phaseResults[repairKey] as number) <= maxRecordRepairRetries) {
        const repairResult = await this.#runRecordRepairStage(
          runtime,
          message,
          stage,
          gateResult,
          ctx,
          bus
        );
        if (this.#isCancelled(ctx)) {
          return 'break';
        }
        phaseResults._recordRepairToolWritten = this.#stageHasNoteFindingCall(repairResult);

        gateResult = await this.#evaluateGateResult(stage, ctx, bus);
        if (this.#isCancelled(ctx)) {
          return 'break';
        }
        this.#storeGateResult(stage, gateResult, ctx, bus);
        if (gateResult.action === 'pass') {
          return 'continue';
        }
      }

      // 记录补写仍未满足门控时，宁可显式降级也不能让 Producer 基于缺失证据继续提交。
      const failureReason =
        gateResult.reason || 'Record repair did not produce enough validated note_finding records';
      const degradedGate: GateEvalResult = {
        action: 'degraded_no_findings',
        pass: false,
        reason: failureReason,
        artifact: gateResult.artifact,
      };
      this.#storeGateResult(stage, degradedGate, ctx, bus);
      ctx.degraded = true;
      ctx.diagnostics.markDegraded();
      return 'break';
    }

    if (gateResult.action === 'summary_rewrite') {
      // 写作类失败(文本短/缺结构/缺接地深度断言)且证据面已达标：不重跑整段 analyze
      // (最贵路径)，改用零工具单调用把 memory 里的已验证发现重组成合格分析文本。
      // 产出只替换 reply——toolCalls 等证据面保持原样(重写不产生新证据)。
      const rewriteKey = `_summaryRewriteRetries_${stage.name || 'gate'}`;
      phaseResults[rewriteKey] = ((phaseResults[rewriteKey] as number) || 0) + 1;
      const maxRewrites = gate.maxSummaryRewriteRetries ?? 1;

      if ((phaseResults[rewriteKey] as number) <= maxRewrites) {
        const sourceName = (stage.source || this.#prevStageName(stage)) as string;
        const source = phaseResults[sourceName] as Record<string, unknown> | undefined;
        const rewriteResult = await this.#runSummaryRewriteStage(
          runtime,
          message,
          stage,
          gateResult,
          ctx,
          bus
        );
        if (this.#isCancelled(ctx)) {
          return 'break';
        }
        const newReply = typeof rewriteResult?.reply === 'string' ? rewriteResult.reply.trim() : '';
        if (source && newReply.length > 0) {
          phaseResults[sourceName] = { ...source, reply: newReply };
          gateResult = await this.#evaluateGateResult(stage, ctx, bus);
          if (this.#isCancelled(ctx)) {
            return 'break';
          }
          this.#storeGateResult(stage, gateResult, ctx, bus);
          if (gateResult.action === 'pass') {
            return 'continue';
          }
          if (gateResult.action === 'degrade') {
            ctx.degraded = true;
            ctx.diagnostics.markDegraded();
            return 'break';
          }
        } else {
          // 重写微阶段声明 summaryMode=none：模型失败、空回复或被抑制（超时/输入过大）时 reply 为空，
          // 在这里转 analysis_retry，而不是把兜底文本写回 analyze。
          _pipelineLogger().info(
            `[PipelineStrategy] summary_rewrite produced no usable text for "${stage.name}" — falling back to analysis_retry ` +
              `(sourceStage=${sourceName}, sourceFound=${Boolean(source)}, replyChars=${newReply.length}, ` +
              `timedOut=${rewriteResult?.timedOut === true}, iterations=${rewriteResult?.iterations ?? 0})`
          );
        }
      }
      // 重写没有救回来(或产出为空/再次判 rewrite)：转整段重挖路径，与 analysis_retry
      // 共享次数上限与预算压制判断，绝不在 rewrite 里无限打转。
      if (gateResult.action === 'summary_rewrite') {
        gateResult = { ...gateResult, action: 'analysis_retry' };
      }
    }

    if (gateResult.action === 'analysis_retry' || gateResult.action === 'retry') {
      const maxRetries = gate.maxRetries ?? this.#maxRetries;
      const retryKey = `_retries_${stage.name || 'gate'}`;
      phaseResults[retryKey] = ((phaseResults[retryKey] as number) || 0) + 1;

      if ((phaseResults[retryKey] as number) <= maxRetries) {
        const prevIdx = this.#findPrevExecStageIdx(stageIndex);
        if (prevIdx >= 0) {
          const retryTargetStage = this.#stages[prevIdx];
          const budgetSuppression = this.#getRetryBudgetSuppression(retryTargetStage, gate, ctx);
          if (budgetSuppression) {
            const degradedGate: GateEvalResult = {
              action: 'degraded_budget_exhausted',
              pass: false,
              reason: budgetSuppression.reason,
              artifact: gateResult.artifact,
            };
            this.#storeGateResult(stage, degradedGate, ctx, bus);
            ctx.degraded = true;
            ctx.diagnostics.markDegraded();
            if (timedOutSource !== null) {
              // I05：超时回执唯一的恢复路径(整段重跑)被预算压制 → 终态。abandonInfo 已由
              // #storeGateResult 记为 degraded_budget_exhausted(首个即近因)，这里只补超时终态留痕。
              this.#recordTimeoutTerminal(
                ctx,
                stage.name || 'gate',
                `Stage "${timedOutSource}" final receipt timed out and the only recovery (full re-run) was suppressed: ${budgetSuppression.reason}; downstream stages skipped`
              );
            }
            return 'break';
          }
          phaseResults._retryContext = {
            reason: gateResult.reason,
            artifact: gateResult.artifact,
          };
          phaseResults[`_was_retry_${retryTargetStage.name}`] = true;
          return prevIdx - 1; // 循环 i++ 后回到 prevIdx
        }
      }
      // 重试次数耗尽 —— P1-A F2：此前静默 break(completed + 0 候选，无原因)；现在如实
      // 记为第三种放弃形态。不设 ctx.degraded(该布尔只表示 degrade 类门动作)，
      // 只让 outcome/abandonedModules 观测面如实报 retry_exhausted。
      ctx.retryExhausted = true;
      if (timedOutSource !== null) {
        // I05：超时回执的整段重跑额度用尽(或门前没有可重跑的执行阶段)→ 终态。与普通
        // retry_exhausted 不同：skipOnFail=false 也不继续——超时回执上没有可供下游消费的产物，
        // 继续只会让 produce 白跑并持久化宿主计为 0 的候选。
        const attempts = phaseResults[retryKey] as number;
        this.#recordTimeoutTerminal(
          ctx,
          stage.name || 'gate',
          `Stage "${timedOutSource}" final receipt timed out and analysis retries are exhausted (attempts=${attempts}, maxRetries=${maxRetries}` +
            (attempts <= maxRetries ? ', no previous execution stage to retry' : '') +
            `); downstream stages skipped` +
            (stage.skipOnFail === false
              ? ' (skipOnFail=false does not override a terminal timeout)'
              : '') +
            `; reason=${gateResult.reason || 'gate retries exhausted'}`
        );
        return 'break';
      }
      if (!ctx.abandonInfo) {
        ctx.abandonInfo = {
          stage: stage.name || 'gate',
          action: 'retry_exhausted',
          reason: gateResult.reason || 'gate retries exhausted',
        };
      }
      // I35：耗尽是短路路径，必须可定位。_pipelineOutcome 只在本仓被读取，宿主
      // (AgentRunProjections)只看 diagnostics/phases，因此这里补 warn 诊断 + warn 日志。
      // 不复用 recordGateFailure：它会改变 gateFailures 条数，而宿主与 l4MemoryPackage 都
      // 按条读取该字段，耗尽前的每次 'retry' 已经在 #storeGateResult 里逐条记录。
      // attempts<=maxRetries 却到达这里，唯一原因是门前没有可重跑的执行阶段(prevIdx<0)。
      const attempts = phaseResults[retryKey] as number;
      const retryTargetMissing = attempts <= maxRetries;
      this.#warnGateTermination(
        ctx,
        stage,
        'pipeline_gate_retry_exhausted',
        `Gate action "${gateResult.action}" retries exhausted: attempts=${attempts}, maxRetries=${maxRetries}` +
          (retryTargetMissing ? ', no previous execution stage to retry' : '') +
          `; downstream stages ${this.#describeDownstream(stage)}; reason=${
            gateResult.reason || 'gate retries exhausted'
          }`
      );
      if (stage.skipOnFail !== false) {
        return 'break';
      }
      return 'continue';
    }

    // 非通过事实影响最终 outcome；执行是否继续仍尊重显式 skipOnFail，
    // 不能通过 degraded 间接吞掉宿主要求执行的清理阶段。
    ctx.abandonInfo ??= {
      stage: stage.name || 'gate',
      action: gateResult.action,
      reason: gateResult.reason || 'Gate did not pass',
    };
    // I35：兜底分支承接 reject 与一切未识别动作(例如拼错的 'analysis-retry')。原始动作已由
    // #storeGateResult 记入 gateFailures 与 PROGRESS 事件，这里只补「非通过并按 skipOnFail
    // 处置下游」这一事实；code 命名分支，message 说明下游实际是跳过还是继续。
    this.#warnGateTermination(
      ctx,
      stage,
      'pipeline_gate_non_pass_terminated',
      `Gate returned non-pass action "${gateResult.action}" (not pass/retry/repair/degrade); ` +
        `downstream stages ${this.#describeDownstream(stage)}; reason=${
          gateResult.reason || 'Gate did not pass'
        }`
    );
    if (stage.skipOnFail !== false) {
      return 'break';
    }
    return 'continue';
  }

  /** skipOnFail 缺省/true 时非通过门 'break'；显式 false 才继续执行后续阶段。 */
  #describeDownstream(stage: PipelineStage): string {
    return stage.skipOnFail !== false
      ? 'skipped (skipOnFail defaults to true)'
      : 'continue (skipOnFail=false)';
  }

  /**
   * I35：门的短路/终止/异常路径统一在此留痕——同一条信息既进 diagnostics.warnings
   * (随 result.diagnostics 与 AgentRuntime 共享的 collector 到达宿主)，也进 warn 日志
   * (运维定位)。只做加性观测，不触碰 gateFailures / degraded / abandonInfo 语义。
   */
  #warnGateTermination(
    ctx: PipelineContext,
    stage: PipelineStage,
    code:
      | 'pipeline_gate_retry_exhausted'
      | 'pipeline_gate_non_pass_terminated'
      | 'pipeline_gate_evaluation_failed',
    message: string
  ): void {
    const stageName = stage.name || 'gate';
    ctx.diagnostics.warn({ code, stage: stageName, message });
    _pipelineLogger().warn(`[PipelineStrategy] ${code} at gate "${stageName}": ${message}`, {
      code,
      stage: stageName,
    });
  }

  /**
   * I05：门裁决的源阶段(stage.source 或门前最近的执行阶段)最终回执是否超时且落在规则覆盖范围内。
   * 返回源阶段名或 null。只看 phaseResults 里的最终回执：一次超时后被 analysis_retry 重跑覆盖的
   * 回执不再算超时，与 execute 末尾的 outcome 口径一致。
   * 范围边界：源阶段是 producer(#isProducerStage)时返回 null——它的超时回执由宿主按持久化提交数
   * 判可救回，门按评估器原始裁决处理，首轮回执不被第二轮覆盖(见文件头 producer 说明)。
   */
  #timedOutGateSource(stage: PipelineStage, ctx: PipelineContext): string | null {
    const sourceName = (stage.source || this.#prevStageName(stage)) as string | null;
    if (!sourceName) {
      return null;
    }
    const receipt = ctx.phaseResults[sourceName] as StageResult | undefined;
    if (receipt?.timedOut !== true) {
      return null;
    }
    const sourceStage = this.#stages.find((entry) => !entry.gate && entry.name === sourceName);
    if (this.#isProducerStage(sourceStage)) {
      const gateName = stage.name || 'gate';
      const toolCalls = receipt.toolCalls || [];
      const persistedSubmits = toolCalls.filter(isPersistedSubmission).length;
      // 分叉留痕：触发条件(producer 超时)、选择路径(规则不适用、门按原裁决)、关键输入(回执里的
      // 持久化提交数)、后续校验依据(宿主按 timedOutStages + 持久化提交数判可救回)。
      _pipelineLogger().info(
        `[PipelineStrategy] Gate "${gateName}" source stage "${sourceName}" final receipt timed out, but it is the producer stage — timeout-terminal rule not applied: gate verdict handled as-is and the first attempt's receipt is kept (persistedKnowledgeSubmits=${persistedSubmits}, toolCalls=${toolCalls.length}); the host decides recoverability from timedOutStages + persisted submits`,
        {
          gate: gateName,
          sourceStage: sourceName,
          persistedKnowledgeSubmits: persistedSubmits,
          toolCalls: toolCalls.length,
        }
      );
      return null;
    }
    return sourceName;
  }

  /**
   * I05 规则的覆盖边界：producer 阶段按名(produce/producer，与 withProducerCoverageBudget /
   * #resolveStageTracker 同一判别)或严格链角色面(strict-producer-v1)识别；门阶段永远不是 producer。
   * producer 的超时回执不进「超时即终态」规则——理由见文件头「源阶段最终回执超时」段落。
   */
  #isProducerStage(stage: PipelineStage | undefined): boolean {
    if (!stage || stage.gate) {
      return false;
    }
    return (
      stage.name === 'produce' ||
      stage.name === 'producer' ||
      stage.strictRoleSurface === 'strict-producer-v1'
    );
  }

  /**
   * I37(L5-P31)：解析本阶段 promptBuilder 入参 gateArtifact 与 producer 覆盖率预算的取数来源。
   *   - 严格链：ctx.gateArtifact——G1 pass 时显式投影的 transition.resultArtifact(见 #processGate)，
   *     语义不变；
   *   - 非严格 producer(#isProducerStage)：按门名读取 quality_gate 的分析产物，不读「最近一个带产物的
   *     门」(rejection_gate/中间门的产物、或 quality_gate 无产物时更早的 evolution_gate 产物都会被误用)。
   *     读不到或形状不符 → null，并记 pipeline_producer_analysis_artifact_unavailable 诊断 + warn 日志；
   *     管线根本没声明 quality_gate 门时只记 info 日志(没有交接可言，不算异常，也不再借用别的门)；
   *   - 其他非严格阶段：保持 ctx.gateArtifact(通用管线的「最近门产物」入参，仓内无 producer 以外的消费方)。
   * 纯取数 + 留痕，不改 ctx 状态；由 #executeStage 每次执行只调用一次。
   */
  #resolveStageGateArtifact(
    stage: PipelineStage,
    ctx: PipelineContext,
    strictProduction: boolean
  ): unknown {
    if (strictProduction || !this.#isProducerStage(stage)) {
      return ctx.gateArtifact;
    }
    const read = readAnalysisGateArtifact(ctx.phaseResults, ANALYSIS_GATE_STAGE);
    if (read.status === 'ok') {
      if (ctx.gateArtifact && ctx.gateArtifact !== read.artifact) {
        // 改动前这里会把更新的门产物当成分析结果；留痕便于定位「哪个门在 quality_gate 之后交了产物」。
        _pipelineLogger().info(
          `[PipelineStrategy] Stage "${stage.name}" reads analysis artifact from "${ANALYSIS_GATE_STAGE}" by name and ignores newer gate artifact (findings=${producerStructuredFindingTarget(read.artifact)}, newerArtifactKeys=${describeArtifactKeys(ctx.gateArtifact)})`
        );
      }
      return read.artifact;
    }
    const analysisGateDeclared = this.#stages.some(
      (candidate) => Boolean(candidate.gate) && candidate.name === ANALYSIS_GATE_STAGE
    );
    if (!analysisGateDeclared) {
      _pipelineLogger().info(
        `[PipelineStrategy] Stage "${stage.name}" has no "${ANALYSIS_GATE_STAGE}" gate stage in this pipeline — gateArtifact=null (no analysis handoff; producer coverage amplification skipped${ctx.gateArtifact ? '; latest artifact from another gate not used' : ''})`
      );
      return null;
    }
    const message =
      `Producer could not read the analysis artifact from gate "${ANALYSIS_GATE_STAGE}" by name: ` +
      `${read.status} (${read.detail}) — gateArtifact=null, producer coverage amplification skipped` +
      `${ctx.gateArtifact ? '; latest artifact from another gate not used' : ''}.`;
    _pipelineLogger().warn(`[PipelineStrategy] Stage "${stage.name}" ${message}`);
    ctx.diagnostics.warn({
      code: 'pipeline_producer_analysis_artifact_unavailable',
      stage: stage.name,
      message,
    });
    return null;
  }

  /**
   * I05：源阶段最终回执超时时裁决门动作(文件头「源阶段最终回执超时」动作表)。纯判定，不写状态：
   *   - rewritten：pass/summary_rewrite/record_repair 改写为 analysis_retry(保留 artifact 供重试
   *     prompt，原始动作写进 reason)；
   *   - passthrough：analysis_retry/retry、degrade 族、aborted 原样交给既有分支；
   *   - terminal：reject 等其他非通过动作——既不能重跑也无可继续之物(不看 skipOnFail)。
   * 严格链：strict analysis_retry 只接受评估器签发的 transition，管线无权合成，因此
   * pass/summary_rewrite/record_repair 直接 terminal；其余动作 passthrough 走既有 strict 分支
   * (带 transition 的 analysis_retry 仍可重跑，非通过仍 fail-closed)。
   */
  #resolveTimedOutSourceGate(
    stage: PipelineStage,
    gateResult: GateEvalResult,
    sourceName: string,
    strict: boolean
  ):
    | { kind: 'rewritten'; gateResult: GateEvalResult }
    | { kind: 'terminal'; reason: string }
    | { kind: 'passthrough' } {
    const action = gateResult.action;
    const gateName = stage.name || 'gate';
    const notARecovery =
      action === 'pass' || action === 'summary_rewrite' || action === 'record_repair';
    if (notARecovery) {
      if (strict) {
        return {
          kind: 'terminal',
          reason: `Stage "${sourceName}" final receipt timed out on the strict chain; gate action "${action}" cannot recover a timed-out receipt and the pipeline cannot synthesize a strict analysis_retry transition; downstream stages skipped`,
        };
      }
      const reason =
        `Stage "${sourceName}" final receipt timed out; gate action "${action}" cannot recover a timed-out receipt, ` +
        `so the stage is re-run in full (analysis_retry)` +
        (gateResult.reason ? `; gate reason: ${gateResult.reason}` : '');
      _pipelineLogger().info(
        `[PipelineStrategy] Gate "${gateName}" action "${action}" rewritten to analysis_retry — source stage "${sourceName}" final receipt timed out (only a full re-run can replace it)`,
        { gate: gateName, sourceStage: sourceName, originalAction: action }
      );
      return {
        kind: 'rewritten',
        gateResult: { ...gateResult, action: 'analysis_retry', pass: false, reason },
      };
    }
    if (
      action === 'analysis_retry' ||
      action === 'retry' ||
      action === 'aborted' ||
      isDegradeGateAction(action) ||
      strict
    ) {
      return { kind: 'passthrough' };
    }
    return {
      kind: 'terminal',
      reason:
        `Stage "${sourceName}" final receipt timed out and gate returned non-pass action "${action}" (no re-run requested); downstream stages skipped` +
        (stage.skipOnFail === false
          ? ' (skipOnFail=false does not override a terminal timeout)'
          : '') +
        `; reason=${gateResult.reason || 'Gate did not pass'}`,
    };
  }

  /**
   * I05：超时终态的统一留痕——diagnostics.warn(pipeline_timeout_terminal，随 result.diagnostics 到达
   * 宿主) + warn 日志(运维定位) + abandonInfo(action=timeout_terminal，首个即近因，不覆盖已有)。
   * outcome 本身由 execute 末尾按最终回执 timedOut 判 'failed'，这里不改 degraded/strictFailed。
   */
  #recordTimeoutTerminal(ctx: PipelineContext, stageName: string, reason: string): void {
    const code = 'pipeline_timeout_terminal';
    ctx.diagnostics.warn({ code, stage: stageName, message: reason });
    _pipelineLogger().warn(`[PipelineStrategy] ${code} at "${stageName}": ${reason}`, {
      code,
      stage: stageName,
    });
    ctx.abandonInfo ??= { stage: stageName, action: 'timeout_terminal', reason };
  }

  /**
   * I05：执行阶段最终回执超时且下一阶段不是裁决它的门时终止主循环。
   * 取消路径(aborted)由循环顶部的 #isCancelled 处理，这里不抢先改写原因；最后一个阶段超时
   * 没有下游可跳过，保持原语义(只由 outcome 报 failed)，不写终态留痕。
   * 范围边界：producer 自身超时不终止(改动前语义，下游照常执行)——规则只保护 produce 不在超时的
   * 上游回执上白跑；producer 的回执与可救回判定交宿主(见文件头 producer 说明)。
   */
  #terminateOnTimedOutStage(stage: PipelineStage, index: number, ctx: PipelineContext): boolean {
    if (this.#isCancelled(ctx)) {
      return false;
    }
    const receipt = ctx.phaseResults[stage.name] as StageResult | undefined;
    if (receipt?.timedOut !== true) {
      return false;
    }
    const downstream = this.#stages.slice(index + 1);
    if (downstream.length === 0) {
      return false;
    }
    const next = downstream[0];
    if (next.gate && (next.source || this.#prevStageName(next)) === stage.name) {
      return false;
    }
    const downstreamNames = downstream
      .map((entry) => entry.name || (entry.gate ? 'gate' : 'stage'))
      .join(', ');
    if (this.#isProducerStage(stage)) {
      const toolCalls = receipt.toolCalls || [];
      const persistedSubmits = toolCalls.filter(isPersistedSubmission).length;
      _pipelineLogger().info(
        `[PipelineStrategy] Stage "${stage.name}" final receipt timed out, but it is the producer stage — timeout-terminal rule not applied: downstream stages continue on pre-I05 semantics (${downstreamNames}; persistedKnowledgeSubmits=${persistedSubmits}, toolCalls=${toolCalls.length})`,
        {
          stage: stage.name,
          downstream: downstreamNames,
          persistedKnowledgeSubmits: persistedSubmits,
          toolCalls: toolCalls.length,
        }
      );
      return false;
    }
    this.#recordTimeoutTerminal(
      ctx,
      stage.name,
      `Stage "${stage.name}" final receipt timed out and no gate adjudicates it; downstream stages skipped: ${downstreamNames}`
    );
    return true;
  }

  /**
   * analysis_retry 的会话预算压制判定。
   *
   * 口径（I02 方案 A）：阶段会话预算 maxSessionInputTokens 表达“一次阶段执行内”的 input 消耗，
   * 与 BudgetController（每个 reactLoop 以构造时累计为基线）一致。因此这里比较的是重试目标阶段
   * 最近一次执行回执的 tokenUsage.input（reactLoop 返回的 loop 级用量，即阶段内消耗），
   * 不再用 ctx.totalTokenUsage——后者是整条管线累计，含前序阶段、微阶段与历次尝试，
   * 会让“前面阶段用得多”或“重试过一次”就误判目标阶段预算耗尽。
   * 语义：目标阶段上一次执行已用掉 ≥ 阈值的自身预算仍未过门，整段重跑不再值得，降级终止。
   * 分母选择保持原样（retryBudget 声明的会话预算优先，其次 stage.budget）。
   */
  #getRetryBudgetSuppression(
    retryTargetStage: PipelineStage,
    gate: GateConfig,
    ctx: PipelineContext
  ): { reason: string } | null {
    const maxSessionInputTokens =
      numberFromUnknown(retryTargetStage.retryBudget?.maxSessionInputTokens) ??
      numberFromUnknown(retryTargetStage.budget?.maxSessionInputTokens);
    if (!maxSessionInputTokens || maxSessionInputTokens <= 0) {
      return null;
    }

    const threshold = numberFromUnknown(gate.retryBudgetExhaustedRatio) ?? 0.9;
    const stageName = retryTargetStage.name;
    // #executeStage 以 stage.name 写入最近一次尝试的回执（summary_rewrite 只替换 reply，保留 tokenUsage）。
    const receipt = ctx.phaseResults[stageName] as StageResult | undefined;
    const receiptInput = numberFromUnknown(receipt?.tokenUsage?.input);
    // 回执缺 tokenUsage（宿主 runtime 未上报或阶段未真正执行）时按阶段内 0 消耗处理：
    // 没有证据证明目标阶段耗尽了自身预算，就不压制重跑；日志写明该回退。
    const stageInput = receiptInput !== undefined && receiptInput > 0 ? receiptInput : 0;
    const ratio = stageInput / maxSessionInputTokens;
    const suppress = ratio >= threshold;
    _pipelineLogger().info(
      `[PipelineStrategy] retry budget check for "${stageName}": stage input ${stageInput}/${maxSessionInputTokens} (${Math.round(
        ratio * 100
      )}%) vs threshold ${Math.round(threshold * 100)}% → ${suppress ? 'suppress' : 'allow'} retry` +
        ` (scale=stage-internal last run; pipeline input total ${ctx.totalTokenUsage.input}` +
        (receiptInput === undefined
          ? '; retry target has no token usage on its last receipt, treated as 0'
          : '') +
        ')',
      {
        stage: stageName,
        stageInput,
        maxSessionInputTokens,
        threshold,
        pipelineInputTotal: ctx.totalTokenUsage.input,
        receiptUsageMissing: receiptInput === undefined,
        decision: suppress ? 'suppress' : 'allow',
      }
    );
    if (!suppress) {
      return null;
    }

    return {
      reason: `Analysis retry suppressed because session input budget is exhausted (${Math.round(
        ratio * 100
      )}% of maxSessionInputTokens=${maxSessionInputTokens}; stage "${stageName}" last-run input=${stageInput}, pipeline input total=${ctx.totalTokenUsage.input}).`,
    };
  }

  async #evaluateGateResult(
    stage: PipelineStage,
    ctx: PipelineContext,
    bus: AgentEventBus
  ): Promise<GateEvalResult> {
    const { phaseResults, strategyContext } = ctx;
    const gate = stage.gate;
    if (!gate) {
      return { action: 'pass', pass: true };
    }
    const sourceName = (stage.source || this.#prevStageName(stage)) as string;
    const source = phaseResults[sourceName];

    if (typeof gate.evaluator === 'function') {
      this.#ensureGateActiveContext(stage, strategyContext, phaseResults, bus, ctx.diagnostics);
      const gateSource = gate.useCumulativeToolCalls
        ? this.#withCumulativeToolCalls(source, ctx)
        : source;
      const gateDiagnostics = new DiagnosticsCollector();
      const evaluation = await runOperation(
        (signal) =>
          gate.evaluator?.(gateSource, phaseResults, {
            ...strategyContext,
            abortSignal: signal,
            diagnostics: gateDiagnostics,
          }),
        { abortSignal: strategyContext.abortSignal as AbortSignal | undefined }
      );
      ctx.diagnostics.merge(gateDiagnostics.toJSON());
      if (evaluation.status === 'aborted') {
        ctx.cancelled = true;
        this.#recordCancellation(ctx);
        return { action: 'aborted', pass: false };
      }
      if (evaluation.status !== 'ok') {
        // I35：评估器抛错后 execute 不会写 _pipelineOutcome，阶段级 pipeline_attempt_interrupted
        // 也不覆盖门。抛出前先把门名 + 源阶段 + 原始错误写进共享 collector(AgentRuntime 把同一
        // 实例传进来，DiagnosticsCollector.from 原样返回)，让宿主能区分是哪个门挂了。
        // 原 Error 实例原样重抛——不包装，避免破坏宿主的 instanceof/name 归类。
        const errorMessage =
          evaluation.error instanceof Error ? evaluation.error.message : String(evaluation.error);
        this.#warnGateTermination(
          ctx,
          stage,
          'pipeline_gate_evaluation_failed',
          `Gate evaluator threw (source stage "${sourceName}"): ${errorMessage}`
        );
        throw evaluation.error instanceof Error
          ? evaluation.error
          : new Error(
              `Pipeline gate "${stage.name || 'gate'}" evaluation failed (source stage "${sourceName}"): ${errorMessage}`,
              { cause: evaluation.error }
            );
      }
      const evaluated = evaluation.value as GateEvalResult | null;
      if (!evaluated || typeof evaluated !== 'object') {
        // 评估器契约要求返回对象；null/undefined/原始值一律视为无决策，与抛错同码留痕。
        this.#warnGateTermination(
          ctx,
          stage,
          'pipeline_gate_evaluation_failed',
          `Gate evaluator returned no decision (source stage "${sourceName}"): got ${
            evaluated === null ? 'null' : typeof evaluated
          }`
        );
        throw new Error(
          `Pipeline gate "${stage.name || 'gate'}" returned no decision (source stage "${sourceName}")`
        );
      }
      if (evaluated.action === 'pass' && evaluated.pass === false) {
        return {
          ...evaluated,
          action: 'reject',
          reason: evaluated.reason || 'Gate returned conflicting pass and action fields',
        };
      }
      return {
        ...evaluated,
        action: evaluated.action || (evaluated.pass ? 'pass' : 'analysis_retry'),
      };
    }

    // 向后兼容: 阈值评估
    const legacyResult = this.#evaluateGate(gate, phaseResults, sourceName);
    return {
      action: legacyResult.pass ? 'pass' : 'analysis_retry',
      pass: legacyResult.pass,
      reason: legacyResult.reason,
    };
  }

  #storeGateResult(
    stage: PipelineStage,
    gateResult: GateEvalResult,
    ctx: PipelineContext,
    bus: AgentEventBus
  ) {
    bus.publish(AgentEvents.PROGRESS, {
      type: 'quality_gate',
      pass: gateResult.action === 'pass',
      action: gateResult.action,
      reason: gateResult.reason,
      stage: stage.name || 'gate',
    });

    ctx.phaseResults[stage.name || 'gate'] = {
      pass: gateResult.action === 'pass',
      action: gateResult.action,
      reason: gateResult.reason || '',
      artifact: gateResult.artifact || null,
    };
    // ctx.gateArtifact 只是「最近一个带产物的门」：任何门、任何动作都会覆盖，形状取决于上一个门是谁。
    // I37：非严格 producer 不读它(按门名读取上面写入的 phaseResults.quality_gate.artifact)；严格链在
    // G1 pass 时把它显式覆盖为 transition.resultArtifact；非 producer 阶段的 promptBuilder 仍可见它。
    if (gateResult.artifact) {
      ctx.gateArtifact = gateResult.artifact;
    }

    if (gateResult.action !== 'pass') {
      ctx.diagnostics.recordGateFailure(stage.name || 'gate', gateResult.action, gateResult.reason);
    }

    // P0-4：degrade 类动作(degrade / degraded_no_findings / degraded_budget_exhausted)都是
    // 终态(存储后必然 ctx.degraded=true + break)，在此单点捕获首个即可覆盖全部 4 个降级点，
    // 不必在每个分支重复。只记首个：后续不会再有(终态)，防御性保留 first-wins 语义。
    // 谓词与 DiagnosticsCollector.recordGateFailure 共用，保证 abandonInfo 与 diagnostics.degraded
    // 对同一动作集合做出一致判断。
    if (!ctx.abandonInfo && isDegradeGateAction(gateResult.action)) {
      ctx.abandonInfo = {
        stage: stage.name || 'gate',
        action: gateResult.action,
        reason: gateResult.reason || '',
      };
    }
  }

  async #runRecordRepairStage(
    runtime: PipelineRuntime,
    message: AgentMessage,
    gateStage: PipelineStage,
    gateResult: GateEvalResult,
    ctx: PipelineContext,
    bus: AgentEventBus
  ) {
    const gate = gateStage.gate || {};
    // C-3：record_repair 的 findings 底线与两宿主完成阈值同源(Core 单源)。
    const minFindings = gate.recordRepairMinFindings ?? DIMENSION_COMPLETION_FLOOR.minKeyFindings;
    // 与 summary_rewrite 同型:微阶段不干扰外层 stage 隔离判定(快照恢复)。
    const lastStageSnapshot = ctx.lastExecutedStageName;
    const repairStage: PipelineStage = {
      name: `${gateStage.name || 'quality_gate'}_record_repair`,
      capabilities: [],
      additionalTools: ['memory', 'evidence'],
      budget: {
        maxIterations: gate.recordRepairMaxRounds ?? 3,
        timeoutMs: gate.recordRepairTimeoutMs ?? 90_000,
        maxTokens: gate.recordRepairMaxTokens ?? 2048,
        temperature: 0.2,
        // 阶段内口径（I02）：BudgetController 以本 loop 构造时的运行累计为基线计量，
        // analyze 已用的 input 不计入这 12k。
        maxSessionInputTokens: 12_000,
        maxSessionTokens: 16_000,
      },
      disableTracker: true,
      recordRepairOnly: true,
      toolChoiceOverride: 'auto',
      recordRepairEvidencePaths: this.#extractRecordRepairEvidencePaths(gateResult.artifact),
      systemPrompt:
        'You are in a record-only repair stage. Do not explore. Retrieve already captured evidence with evidence.get/search, then use note_finding with evidenceRefs to record verified findings.',
      promptBuilder: () =>
        buildRecordRepairPrompt({
          reason: gateResult.reason || '',
          artifact: gateResult.artifact,
          minFindings,
        }),
    };

    MICRO_STAGE_SUMMARY_MODES.set(repairStage, 'none');

    try {
      return await this.#executeStage(runtime, message, repairStage, ctx, bus);
    } finally {
      ctx.lastExecutedStageName = lastStageSnapshot;
    }
  }

  /**
   * summary_rewrite 微阶段：与 record_repair 同一范式(小预算、disableTracker、inline 重评)，
   * 但更进一步——零工具纯写作。LLM 拿着 artifact 里的已验证发现重组分析文本，
   * 产出经调用方写回 analyze 阶段的 reply 后重评。成本≈一次 chat 调用。
   */
  async #runSummaryRewriteStage(
    runtime: PipelineRuntime,
    message: AgentMessage,
    gateStage: PipelineStage,
    gateResult: GateEvalResult,
    ctx: PipelineContext,
    bus: AgentEventBus
  ) {
    const gate = gateStage.gate || {};
    // 微阶段对「阶段隔离」透明:#executeStage 会把 ctx.lastExecutedStageName 写成微阶段名,
    // 若之后 rewrite 失败转 analysis_retry,analyze 重跑会被误判 isNewStage 而 reset
    // ContextWindow——旧 retry 路径的「♻️ preserving」保留机制被击穿(审计缺陷①)。
    // 快照恢复使微阶段不干扰外层 stage 的隔离判定;record_repair 同型处理。
    const lastStageSnapshot = ctx.lastExecutedStageName;
    const rewriteStage: PipelineStage = {
      name: `${gateStage.name || 'quality_gate'}_summary_rewrite`,
      capabilities: [],
      additionalTools: [],
      budget: {
        maxIterations: 1,
        timeoutMs: (gate.summaryRewriteTimeoutMs as number | undefined) ?? 120_000,
        maxTokens: (gate.summaryRewriteMaxTokens as number | undefined) ?? 4096,
        temperature: 0.3,
        // 阶段内口径（I02）：同 record_repair，只计本微阶段自身的 input。
        maxSessionInputTokens: 24_000,
        maxSessionTokens: 30_000,
      },
      disableTracker: true,
      systemPrompt:
        'You are in a summary-rewrite stage. Do not explore or call tools. Rewrite the analysis text using only the verified findings provided in the prompt.',
      promptBuilder: () =>
        buildSummaryRewritePrompt({
          reason: gateResult.reason || '',
          artifact: gateResult.artifact as Record<string, unknown> | null,
        }),
    };

    MICRO_STAGE_SUMMARY_MODES.set(rewriteStage, 'none');

    try {
      return await this.#executeStage(runtime, message, rewriteStage, ctx, bus);
    } finally {
      ctx.lastExecutedStageName = lastStageSnapshot;
    }
  }

  #stageHasNoteFindingCall(stageResult: StageResult) {
    return (stageResult.toolCalls || []).some((call) => {
      const args = (call.args || call.params || {}) as Record<string, unknown>;
      const toolName = String(call.tool || call.name || '');
      const isNoteFinding =
        toolName === 'note_finding' ||
        (toolName === 'memory' && String(args.action || '') === 'note_finding');
      if (!isNoteFinding) {
        return false;
      }
      return this.#isSuccessfulNoteFindingResult(call.result || call.structuredContent);
    });
  }

  #isSuccessfulNoteFindingResult(result: unknown) {
    if (typeof result === 'string') {
      return !result.startsWith('⚠');
    }
    if (!result || typeof result !== 'object') {
      return false;
    }
    const record = result as Record<string, unknown>;
    return record.recorded === true && record.target === 'activeContext';
  }

  #extractRecordRepairEvidencePaths(artifact: unknown) {
    const paths = new Set<string>();
    const record = artifact as
      | {
          referencedFiles?: unknown;
          evidenceMap?: unknown;
          findings?: Array<{ evidence?: unknown }>;
        }
      | null
      | undefined;
    if (Array.isArray(record?.referencedFiles)) {
      for (const path of record.referencedFiles) {
        if (typeof path === 'string' && path.trim()) {
          paths.add(path.trim());
        }
      }
    }
    if (record?.evidenceMap instanceof Map) {
      for (const path of record.evidenceMap.keys()) {
        if (typeof path === 'string' && path.trim()) {
          paths.add(path.trim());
        }
      }
    } else if (record?.evidenceMap && typeof record.evidenceMap === 'object') {
      for (const path of Object.keys(record.evidenceMap)) {
        paths.add(path);
      }
    }
    if (Array.isArray(record?.findings)) {
      for (const finding of record.findings) {
        const evidence =
          typeof finding.evidence === 'string'
            ? finding.evidence
            : Array.isArray(finding.evidence)
              ? finding.evidence.join(', ')
              : '';
        for (const match of evidence.match(/[\w/.-]+\.[A-Za-z0-9]+/g) || []) {
          paths.add(match);
        }
      }
    }
    return [...paths];
  }

  #ensureGateActiveContext(
    stage: PipelineStage,
    strategyContext: Record<string, unknown>,
    phaseResults: Record<string, unknown>,
    bus: AgentEventBus,
    diagnostics: DiagnosticsCollector
  ) {
    if (!stage.name?.includes('quality') || strategyContext.activeContext) {
      return;
    }

    const warning = strategyContext.trace
      ? 'quality gate missing activeContext; aliased strategyContext.trace to activeContext'
      : 'quality gate missing activeContext and trace; evaluator may fall back to text-only analysis';
    if (strategyContext.trace) {
      strategyContext.activeContext = strategyContext.trace;
    }
    diagnostics.warn({ code: 'pipeline_context_warning', message: warning, stage: stage.name });

    const phaseDiagnostics = (phaseResults._diagnostics || {}) as { warnings?: unknown[] };
    phaseResults._diagnostics = {
      ...phaseDiagnostics,
      warnings: [
        ...(Array.isArray(phaseDiagnostics.warnings) ? phaseDiagnostics.warnings : []),
        { stage: stage.name, warning },
      ],
    };
    bus.publish(AgentEvents.PROGRESS, {
      type: 'pipeline_context_warning',
      stage: stage.name,
      warning,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Private: Stage 执行
  // ═══════════════════════════════════════════════════════════

  /** 执行单个 Pipeline 阶段 */
  async #executeStage(
    runtime: PipelineRuntime,
    message: AgentMessage,
    stage: PipelineStage,
    ctx: PipelineContext,
    bus: AgentEventBus
  ) {
    const { phaseResults, strategyContext } = ctx;

    this.#validateStrictRoleRoute(stage, ctx);

    bus.publish(AgentEvents.PROGRESS, {
      type: 'pipeline_stage_start',
      stage: stage.name,
      capabilities: stage.capabilities?.map((c: CapabilityRef) =>
        typeof c === 'string' ? c : c.name
      ),
    });

    // 在准备前捕获预算；异步 promptBuilder 不能为同一次 attempt 延长或替换期限。
    const isRetry = !!phaseResults[`_was_retry_${stage.name}`];
    const decisionOnly = isRetry && stage.decisionOnlyOnRetry === true;
    const computedBudget = (strategyContext._computedBudget || null) as StageBudget | null;
    const configuredBudget =
      isRetry && stage.retryBudget
        ? stage.retryBudget
        : stage.budget || computedBudget || undefined;
    const strictProduction = Boolean(this.#strictProductionContext(ctx));
    // I37：本阶段 gateArtifact 只解析一次——覆盖率预算、首轮提示与 fast retry 重建共用，诊断不重复。
    const stageGateArtifact = this.#resolveStageGateArtifact(stage, ctx, strictProduction);
    const effectiveBudget = withProducerCoverageBudget(
      stage,
      configuredBudget ? { ...configuredBudget } : undefined,
      stageGateArtifact,
      strictProduction,
      isRetry
    );
    const retryBudget = stage.retryBudget ? { ...stage.retryBudget } : undefined;
    delete phaseResults[`_was_retry_${stage.name}`];
    const ctxWin = (strategyContext.contextWindow || null) as StageContextWindow | null;
    let stagePrompt = '';

    const executeAttempt = async (budget: StageBudget | undefined, fastRetry: boolean) => {
      const timeoutMs = budget?.timeoutMs;
      const attempt = await runStageAttempt(
        runtime,
        {
          stage: stage.name,
          abortSignal: strategyContext.abortSignal as AbortSignal | undefined,
          // 保留原来的 forced-summary 60s 缓冲，但准备与执行只共享这一份期限。
          ...(timeoutMs ? { timeoutMs: timeoutMs + 60_000 } : {}),
          diagnostics: ctx.diagnostics,
          onToolCall: stage.onToolCall,
        },
        async (scope) => {
          const attemptContext = {
            ...strategyContext,
            abortSignal: scope.signal,
            diagnostics: scope.diagnostics,
          };
          // I36：fast retry 是超时重跑，不是门拒绝重试。始终复用首次尝试缓存的完整阶段提示并追加
          // 超时提示段；不调用面向拒绝原因的 retryPromptBuilder（insight/scan 的 produce 用它生成
          // 「N 个提交被拒绝」修复清单，且首次尝试时 phaseResults[stage] 尚未写入，会得到「0 个提交
          // 被拒绝」并丢掉 findings、维度配置与证据入口）。缓存为空时在本次 attempt 的期限内重建。
          let prompt: string;
          if (fastRetry) {
            const basePrompt =
              stagePrompt ||
              (await this.#buildStagePrompt(
                stage,
                message,
                phaseResults,
                attemptContext,
                stageGateArtifact
              ));
            if (!basePrompt && !scope.signal.aborted) {
              _pipelineLogger().warn(
                `[PipelineStrategy] Stage "${stage.name}" fast retry rebuilt an empty stage prompt — sending the timeout notice alone (cachedPromptChars=0, rebuiltPromptChars=0)`
              );
            }
            prompt = appendFastRetryNotice(basePrompt);
          } else {
            prompt = await this.#buildStagePrompt(
              stage,
              message,
              phaseResults,
              attemptContext,
              stageGateArtifact
            );
          }
          // 不合作的准备任务即使晚到，也不能重置上下文或启动一次新的工具循环。
          if (scope.signal.aborted) {
            return { reply: '', toolCalls: [], iterations: 0, tokenUsage: { input: 0, output: 0 } };
          }
          if (!fastRetry) {
            stagePrompt = prompt;
          }
          const isNewStage = ctx.lastExecutedStageName !== stage.name;
          if (ctxWin && (fastRetry || (ctx.execStageCount > 0 && isNewStage))) {
            ctxWin.resetForNewStage();
          } else if (ctxWin && ctx.execStageCount > 0) {
            _pipelineLogger().info(
              `[PipelineStrategy] Retry stage "${stage.name}" — preserving ContextWindow (${ctxWin.tokenCount || 0} tokens)`
            );
          }
          const tracker = this.#resolveStageTracker(stage, ctx, attemptContext, budget);
          if (!fastRetry) {
            ctx.lastExecutedStageName = stage.name;
            ctx.execStageCount++;
          }
          _pipelineLogger().info(
            `[PipelineStrategy] Stage "${stage.name}"${fastRetry || isRetry ? ' (retry)' : ''} — budget: ${budget?.maxIterations || '∞'} iters, timeout: ${budget?.timeoutMs || '∞'}ms`
          );
          return this.#runPreparedStage(
            prompt,
            message,
            stage,
            budget,
            ctxWin,
            tracker,
            attemptContext,
            phaseResults,
            decisionOnly,
            scope
          );
        }
      );
      ctx.cancelled ||= attempt.result.aborted === true;
      this.#accumulateStageAttempt(ctx, attempt.result);
      if (attempt.status === 'error') {
        throw attempt.error instanceof Error
          ? attempt.error
          : new Error(String(attempt.error || 'Pipeline stage failed'));
      }
      if (attempt.result.timedOut) {
        bus.publish(AgentEvents.PROGRESS, {
          type: 'pipeline_stage_timeout',
          stage: stage.name,
          timeoutMs: timeoutMs ? timeoutMs + 60_000 : null,
        });
      }
      return attempt;
    };

    let attempt = await executeAttempt(effectiveBudget, false);
    if (!strictProduction && !isRetry && retryBudget && attempt.canFastRetry) {
      // I36：提示来源与 executeAttempt 的 fastRetry 分支同一判据——缓存的阶段提示非空则复用，
      // 否则重建；阶段若声明了 retryPromptBuilder，这里明确记为 bypassed（它只服务门重试）。
      const promptSource = stagePrompt ? 'stage_cached' : 'stage_rebuilt';
      const retryPromptBuilderState = stage.retryPromptBuilder ? 'bypassed' : 'absent';
      const fastRetryDetail =
        `reason=stage_hard_timeout_zero_tools promptSource=${promptSource} ` +
        `retryPromptBuilder=${retryPromptBuilderState} cachedPromptChars=${stagePrompt.length} ` +
        `retryBudget.maxIterations=${retryBudget.maxIterations ?? '∞'} ` +
        `retryBudget.timeoutMs=${retryBudget.timeoutMs ?? '∞'}`;
      _pipelineLogger().info(
        `[PipelineStrategy] Stage "${stage.name}" confirmed no tools — fast-retrying with retryBudget (${fastRetryDetail})`
      );
      ctx.diagnostics.warn({
        code: 'pipeline_stage_fast_retry',
        stage: stage.name,
        message: `First attempt hit the hard timeout with zero tool calls; re-running once with the stage prompt plus a timeout notice (${fastRetryDetail}).`,
      });
      bus.publish(AgentEvents.PROGRESS, { type: 'pipeline_stage_fast_retry', stage: stage.name });
      attempt = await executeAttempt(retryBudget, true);
    }
    const stageResult = attempt.result;
    phaseResults[stage.name] = stageResult;
    if (this.#isCancelled(ctx)) {
      return stageResult;
    }

    if (strictProduction) {
      const strictContext = this.#strictProductionContext(ctx);
      this.#appendStrictRoleRouteReceipt(stage, ctx);
      validateStrictStageToolCallsV1(
        stage.name,
        stageResult.toolCalls || [],
        strictContext?.factQueryObligationIds || []
      );
    }

    _pipelineLogger().info(
      `[PipelineStrategy] ✅ Stage "${stage.name}" done — ` +
        `${stageResult.iterations || 0} iters, ${stageResult.toolCalls?.length || 0} tool calls, ` +
        `reply: ${stageResult.reply?.length || 0} chars${stageResult.timedOut ? ' (TIMED OUT)' : ''}`
    );

    bus.publish(AgentEvents.PROGRESS, {
      type: 'pipeline_stage_done',
      stage: stage.name,
      iterations: stageResult.iterations,
    });

    return stageResult;
  }

  #isCancelled(ctx: PipelineContext): boolean {
    return (
      ctx.cancelled ||
      (ctx.strategyContext.abortSignal as AbortSignal | undefined)?.aborted === true
    );
  }

  #recordCancellation(ctx: PipelineContext): void {
    const parentAborted =
      (ctx.strategyContext.abortSignal as AbortSignal | undefined)?.aborted === true;
    ctx.diagnostics.recordCancelReason(parentAborted ? 'abort_signal' : 'stage_aborted');
  }

  /** 每次尝试的已知成本均入总账，最终阶段结果仍只表示最后一次尝试。 */
  #accumulateStageAttempt(ctx: PipelineContext, result: StageResult): void {
    ctx.totalToolCalls.push(...(result.toolCalls || []));
    ctx.totalIterations += result.iterations || 0;
    ctx.totalTokenUsage.input += result.tokenUsage?.input || 0;
    ctx.totalTokenUsage.output += result.tokenUsage?.output || 0;
  }

  // ═══════════════════════════════════════════════════════════
  // Private: Helpers
  // ═══════════════════════════════════════════════════════════

  /**
   * 构建阶段 prompt (优先级: 门重试的 retryPromptBuilder > promptBuilder > promptTransform > 原始)。
   * retryPromptBuilder 只在存在 phaseResults._retryContext（门重试）时使用；fast retry 复用首次
   * 尝试缓存的结果，缓存为空时才回到这里重建（I36）。
   * gateArtifact 是 #resolveStageGateArtifact 为本阶段解析好的值（I37：非严格 producer 为按门名读取的
   * quality_gate 产物或 null），以原字段名 gateArtifact 注入 promptBuilder，入参约定不变。
   */
  async #buildStagePrompt(
    stage: PipelineStage,
    message: AgentMessage,
    phaseResults: Record<string, unknown>,
    strategyContext: Record<string, unknown>,
    gateArtifact: unknown
  ) {
    let prompt: string;
    if (phaseResults._retryContext && stage.retryPromptBuilder) {
      const retryCtx = phaseResults._retryContext as { reason?: string; artifact?: unknown };
      prompt = stage.retryPromptBuilder(retryCtx, message.content, phaseResults);
    } else if (stage.promptBuilder) {
      prompt = await stage.promptBuilder({
        message: message.content,
        phaseResults,
        gateArtifact,
        ...strategyContext,
      });
    } else if (stage.promptTransform) {
      prompt = stage.promptTransform(message.content, phaseResults);
    } else {
      prompt = message.content;
    }

    // 清除已消费的 retryContext
    if (
      !(strategyContext.abortSignal as AbortSignal | undefined)?.aborted &&
      phaseResults._retryContext
    ) {
      delete phaseResults._retryContext;
    }
    return prompt;
  }

  /** 为阶段解析 ExplorationTracker */
  #resolveStageTracker(
    stage: PipelineStage,
    ctx: PipelineContext,
    strategyContext: Record<string, unknown>,
    effectiveBudget: StageBudget | undefined
  ) {
    if (this.#strictProductionContext(ctx)) {
      return null;
    }
    if (stage.disableTracker || stage.recordRepairOnly) {
      return null;
    }

    let stageTracker = (strategyContext.tracker || null) as ExplorationTracker | null;
    const submitToolName = (stage.submitToolName || strategyContext.submitToolName || undefined) as
      | string
      | undefined;
    const pipelineType = (stage.pipelineType || strategyContext.pipelineType || undefined) as
      | PipelineType
      | undefined;

    if (stageTracker && ctx.execStageCount > 0) {
      const trackerStrategy =
        stage.name === 'produce' || stage.name === 'producer' ? 'producer' : 'analyst';
      stageTracker = ExplorationTracker.resolve(
        { source: strategyContext.source || 'system', strategy: trackerStrategy },
        {
          ...(effectiveBudget || {}),
          ...(submitToolName ? { submitToolName } : {}),
          ...(pipelineType ? { pipelineType } : {}),
        }
      );
    } else if (stageTracker && ctx.execStageCount === 0 && submitToolName) {
      if (stageTracker.submitToolName !== submitToolName) {
        stageTracker = ExplorationTracker.resolve(
          { source: strategyContext.source || 'system', strategy: 'analyst' },
          {
            ...(effectiveBudget || {}),
            submitToolName,
            ...(pipelineType ? { pipelineType } : {}),
          }
        );
      }
    }

    return stageTracker;
  }

  #strictProductionContext(ctx: PipelineContext): StrictAnalysisContextProjectionV1 | null {
    const strictProduction = ctx.strategyContext.strictProduction;
    if (
      !strictProduction ||
      typeof strictProduction !== 'object' ||
      Array.isArray(strictProduction)
    ) {
      return null;
    }
    const record = strictProduction as Record<string, unknown>;
    if (record.enabled !== true) {
      return null;
    }
    const readAnalysisEpoch = record.readAnalysisEpoch;
    if (typeof readAnalysisEpoch !== 'function') {
      throw new Error('STRICT_ANALYSIS_EPOCH_READER_REQUIRED');
    }
    const snapshot = readAnalysisEpoch.call(record) as ReturnType<
      typeof createStrictAnalysisEpochSnapshotV1
    > | null;
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      Array.isArray(snapshot) ||
      snapshot.schemaVersion !== 1
    ) {
      throw new Error('STRICT_ANALYSIS_EPOCH_INVALID');
    }
    const { schemaVersion: _schemaVersion, snapshotHash, ...snapshotInput } = snapshot;
    const normalized = createStrictAnalysisEpochSnapshotV1(snapshotInput);
    if (normalized.snapshotHash !== snapshotHash) {
      throw new Error('STRICT_ANALYSIS_EPOCH_HASH_MISMATCH');
    }
    return normalized.context;
  }

  #validateStrictRoleRoute(stage: PipelineStage, ctx: PipelineContext): void {
    if (!this.#strictProductionContext(ctx)) {
      return;
    }
    const expected =
      stage.name === 'analyze'
        ? 'strict-analyst-v1'
        : stage.name === 'produce'
          ? 'strict-producer-v1'
          : null;
    if (expected && stage.strictRoleSurface !== expected) {
      throw new Error(`STRICT_PRODUCTION_STAGE_ROUTE_REQUIRED:${stage.name}`);
    }
  }

  #appendStrictRoleRouteReceipt(stage: PipelineStage, ctx: PipelineContext): void {
    if (
      stage.strictRoleSurface !== 'strict-analyst-v1' &&
      stage.strictRoleSurface !== 'strict-producer-v1'
    ) {
      return;
    }
    const previous = (ctx.phaseResults._strictRoleRouteReceipt || {}) as Record<string, unknown>;
    ctx.phaseResults._strictRoleRouteReceipt = {
      kind: 'StrictRoleRouteReceiptV1',
      strictAnalystCalls:
        Number(previous.strictAnalystCalls || 0) +
        (stage.strictRoleSurface === 'strict-analyst-v1' ? 1 : 0),
      strictProducerCalls:
        Number(previous.strictProducerCalls || 0) +
        (stage.strictRoleSurface === 'strict-producer-v1' ? 1 : 0),
      legacyAnalystCalls: 0,
      legacyProducerCalls: 0,
    };
  }

  #appendStrictGateReturn(ctx: PipelineContext, typedReturn: unknown): void {
    const previous = Array.isArray(ctx.phaseResults._strictGateReturns)
      ? ctx.phaseResults._strictGateReturns
      : [];
    ctx.phaseResults._strictGateReturns = [...previous, typedReturn];
  }

  #readStrictAnalysisTransition(
    gateResult: GateEvalResult,
    expectedAction: 'pass' | 'analysis_retry'
  ): StrictAnalysisEpochTransitionV1 {
    const transition = gateResult.artifact as Partial<StrictAnalysisEpochTransitionV1> | null;
    if (
      !transition ||
      transition.kind !== 'StrictAnalysisEpochTransitionV1' ||
      transition.schemaVersion !== 1 ||
      transition.action !== expectedAction ||
      typeof transition.transitionHash !== 'string' ||
      transition.transitionHash.length === 0
    ) {
      throw new Error('STRICT_ANALYSIS_RETRY_TRANSITION_REQUIRED');
    }
    return transition as StrictAnalysisEpochTransitionV1;
  }

  #appendStrictAnalysisLoopReceipt(
    ctx: PipelineContext,
    transition: StrictAnalysisEpochTransitionV1
  ): void {
    const previous =
      ctx.phaseResults._strictAnalysisLoopReceipt &&
      typeof ctx.phaseResults._strictAnalysisLoopReceipt === 'object' &&
      !Array.isArray(ctx.phaseResults._strictAnalysisLoopReceipt)
        ? (ctx.phaseResults._strictAnalysisLoopReceipt as Record<string, unknown>)
        : null;
    const epochs = Array.isArray(previous?.epochs) ? previous.epochs : [];
    ctx.phaseResults._strictAnalysisLoopReceipt = {
      kind: 'StrictAnalysisLoopReceiptV1',
      limits: transition.limits,
      epochs: [
        ...epochs,
        {
          epoch: transition.before.epoch,
          nextEpoch: transition.after.epoch,
          action: transition.action,
          reasonCode: transition.reasonCode,
          beforeSnapshotHash: transition.before.snapshotHash,
          afterSnapshotHash: transition.after.snapshotHash,
          currentExpandedScheduleHash: transition.after.currentExpandedScheduleHash,
          terminalObligationIds: transition.after.terminalObligationIds,
          outstandingObligationIds: transition.after.outstandingObligationIds,
          enrolledObligationIds: transition.enrolledObligationIds,
          executedObligationIds: transition.executedObligationIds,
          transitionHash: transition.transitionHash,
        },
      ],
      terminalAction: transition.action === 'analysis_retry' ? null : transition.action,
      finalEpoch: transition.after.epoch,
    };
  }

  /** 真实 stage→reactLoop 投影；signal、诊断与观察钩子由唯一 attempt 边界注入。 */
  #runPreparedStage(
    stagePrompt: string,
    message: AgentMessage,
    stage: PipelineStage,
    effectiveBudget: StageBudget | undefined,
    ctxWin: StageContextWindow | null,
    stageTracker: ExplorationTracker | null,
    strategyContext: Record<string, unknown>,
    phaseResults: Record<string, unknown>,
    decisionOnly: boolean,
    scope: StageAttemptScope
  ): Promise<StageResult> {
    const dimensionScopeId =
      typeof (strategyContext.sharedState as Record<string, unknown> | undefined)
        ?._dimensionScopeId === 'string'
        ? ((strategyContext.sharedState as Record<string, unknown>)._dimensionScopeId as string)
        : typeof strategyContext.scopeId === 'string'
          ? strategyContext.scopeId
          : undefined;
    const baseSharedState = ((strategyContext.sharedState as Record<string, unknown>) ||
      null) as Record<string, unknown> | null;
    const messageContext = ((message.metadata.context as Record<string, unknown>) ||
      null) as Record<string, unknown> | null;
    const pcvStageNodeMap =
      messageContext?.pcvStageNodeMap ??
      strategyContext.pcvStageNodeMap ??
      baseSharedState?._pcvStageNodeMap ??
      baseSharedState?.pcvStageNodeMap ??
      null;
    const pcvChainNodes =
      messageContext?.pcvChainNodes ??
      strategyContext.pcvChainNodes ??
      baseSharedState?._pcvChainNodes ??
      baseSharedState?.pcvChainNodes ??
      null;
    const stageNodeMap =
      messageContext?.stageNodeMap ??
      strategyContext.stageNodeMap ??
      baseSharedState?.stageNodeMap ??
      null;
    const sourceIdentities =
      messageContext?.sourceIdentities ??
      messageContext?.projectScopeSourceIdentities ??
      strategyContext.sourceIdentities ??
      strategyContext.projectScopeSourceIdentities ??
      baseSharedState?._sourceIdentities ??
      baseSharedState?.sourceIdentities ??
      baseSharedState?.projectScopeSourceIdentities ??
      null;
    const stageSharedState = decisionOnly
      ? {
          ...(baseSharedState || {}),
          _evolutionDecisionOnly: true,
          ...(sourceIdentities !== null ? { _sourceIdentities: sourceIdentities } : {}),
        }
      : stage.recordRepairOnly
        ? {
            ...(baseSharedState || {}),
            _recordRepairOnly: true,
            _recordRepairEvidencePaths: stage.recordRepairEvidencePaths || [],
            ...(sourceIdentities !== null ? { _sourceIdentities: sourceIdentities } : {}),
          }
        : sourceIdentities !== null
          ? {
              ...(baseSharedState || {}),
              _sourceIdentities: sourceIdentities,
            }
          : baseSharedState;

    const summaryMode = this.#stageSummaryMode(stage);
    if (summaryMode) {
      _pipelineLogger().debug(
        `[PipelineStrategy] Stage "${stage.name}" declares summaryMode=${summaryMode} (repair micro-stage)`
      );
    } else if (decisionOnly) {
      // 进化补写轮刻意不声明：它是最后一个主阶段，无文本退出时须由 Runtime 原推断产出非空 reply。
      _pipelineLogger().debug(
        `[PipelineStrategy] Stage "${stage.name}" evolution decision-only retry — no summaryMode declared, runtime keeps inferred forced summary so the final pipeline reply stays non-empty`
      );
    }

    return scope.runLoop(stagePrompt, {
      history: message.history,
      context: {
        ...(messageContext || {}),
        ...(pcvStageNodeMap !== null ? { pcvStageNodeMap } : {}),
        ...(pcvChainNodes !== null ? { pcvChainNodes } : {}),
        ...(stageNodeMap !== null ? { stageNodeMap } : {}),
        ...(sourceIdentities !== null ? { sourceIdentities } : {}),
        pipelinePhase: stage.name,
        previousPhases: phaseResults,
        evidenceStarters: strategyContext.evidenceStarters || null,
        toolPolicyHints: strategyContext.toolPolicyHints || null,
        ...(stage.recordRepairOnly
          ? {
              recordRepairOnly: true,
              recordRepairEvidencePaths: stage.recordRepairEvidencePaths || [],
            }
          : {}),
        ...(dimensionScopeId ? { dimensionScopeId } : {}),
        // 显式摘要契约放在最后，覆盖宿主消息上下文里的同名键：微阶段的“不产出摘要”不能被改写。
        ...(summaryMode ? { summaryMode } : {}),
      },
      capabilityOverride: stage.capabilities,
      additionalToolsOverride: stage.additionalTools,
      budgetOverride: effectiveBudget,
      systemPromptOverride: stage.systemPrompt,
      contextWindow: ctxWin,
      tracker: stageTracker,
      trace: strategyContext.trace || null,
      memoryCoordinator: strategyContext.memoryCoordinator || null,
      sharedState: stageSharedState,
      source: strategyContext.source || null,
      toolChoiceOverride: stage.toolChoiceOverride || null,
    });
  }

  /**
   * 本阶段需显式声明的强制摘要模式（I11）；null 表示不声明，由 AgentRuntime 按 tracker/阶段标记选择。
   * 只有本类构造的 summary_rewrite / record_repair 微阶段 → 'none'。进化补写轮（decisionOnlyOnRetry
   * 的重试）不声明：其 reply 是管线最终 reply，必须由原推断产出非空摘要（见 MICRO_STAGE_SUMMARY_MODES）。
   */
  #stageSummaryMode(stage: PipelineStage): ForcedSummaryMode | null {
    return MICRO_STAGE_SUMMARY_MODES.get(stage) ?? null;
  }

  /** 质量门控评估 (向后兼容: 阈值模式) */
  #evaluateGate(gateConfig: GateConfig, phaseResults: Record<string, unknown>, sourceName: string) {
    const source = phaseResults[sourceName] as StageResult | undefined;
    if (!source?.reply) {
      return { pass: false, reason: `No output from stage "${sourceName}"` };
    }

    const reply = source.reply;
    const reasons: string[] = [];

    if (gateConfig.minEvidenceLength && reply.length < gateConfig.minEvidenceLength) {
      reasons.push(`分析长度不足: ${reply.length} < ${gateConfig.minEvidenceLength}`);
    }

    if (gateConfig.minFileRefs) {
      const fileRefCount = (reply.match(/[\w/]+\.\w+/g) || []).length;
      if (fileRefCount < gateConfig.minFileRefs) {
        reasons.push(`文件引用不足: ${fileRefCount} < ${gateConfig.minFileRefs}`);
      }
    }

    if (gateConfig.minToolCalls) {
      const toolCalls = source.toolCalls?.length || 0;
      if (toolCalls < gateConfig.minToolCalls) {
        reasons.push(`工具调用不足: ${toolCalls} < ${gateConfig.minToolCalls}`);
      }
    }

    if (gateConfig.custom && typeof gateConfig.custom === 'function') {
      const customResult = gateConfig.custom(source);
      if (!customResult.pass) {
        reasons.push(customResult.reason ?? '');
      }
    }

    return reasons.length === 0 ? { pass: true } : { pass: false, reason: reasons.join('; ') };
  }

  #withCumulativeToolCalls(source: unknown, ctx: PipelineContext) {
    const base =
      source && typeof source === 'object' && !Array.isArray(source)
        ? ({ ...(source as Record<string, unknown>) } as Record<string, unknown>)
        : { value: source };

    return {
      ...base,
      toolCalls: ctx.totalToolCalls,
      iterations: ctx.totalIterations,
      tokenUsage: ctx.totalTokenUsage,
    };
  }

  /** 找到当前 gate 之前最近的执行阶段索引 (用于 retry 回退) */
  #findPrevExecStageIdx(currentIdx: number) {
    for (let j = currentIdx - 1; j >= 0; j--) {
      if (!this.#stages[j].gate) {
        return j;
      }
    }
    return -1;
  }

  #prevStageName(currentStage: PipelineStage) {
    const idx = this.#stages.indexOf(currentStage);
    for (let i = idx - 1; i >= 0; i--) {
      if (!this.#stages[i].gate && this.#stages[i].name) {
        return this.#stages[i].name;
      }
    }
    return null;
  }
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
