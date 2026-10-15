import {
  collectEvolutionDecisions,
  hasPersistedCandidate,
  isKnowledgeSubmit,
  readToolObservation,
} from '../utils/toolOutcomes.js';
/** Pipeline gate 适配器：分析工件接质量门，实际 evolution/submit 回执接完成判定。
 * 同轮证据投影供后续提交使用；可观测数据不授予新的生产权限。 */

import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { buildPcvQualityGateEvidence } from '../runtime/PcvNodeEvidenceRecorder.js';
import {
  type ActiveContextLike,
  type AnalystResult,
  buildAnalysisArtifact,
  buildAnalysisReport,
  type ProjectGraphLike,
} from './analysisArtifact.js';
import { analysisQualityGate, applyDepthRetryGate, type QualityReport } from './qualityGates.js';

// AD4: lazy logger accessor — the Core logger singleton materializes on first
// use instead of at module import (no import-time work; same singleton).
const logger = () => Logger.getInstance();

// ──────────────────────────────────────────────────────────────────
// Insight Gate Evaluator — 分析质量门适配器
// ──────────────────────────────────────────────────────────────────

/** insightGateEvaluator 策略上下文 */
interface InsightGateStrategyContext {
  projectGraph?: ProjectGraphLike | null;
  activeContext?: ActiveContextLike | null;
  dimId?: string;
  outputType?: string;
  needsCandidates?: boolean;
  /** R1: 宿主注入的项目根，启用 findings 锚点的磁盘补齐（只读、根内限定） */
  projectRoot?: string;
  [key: string]: unknown;
}

/**
 * P1-B-4(挖掘质量升级)：provider 中立的模块覆盖度门——applyGraphRetryGate 的替代者。
 * 旧门"命令模型调 graph"(DeepSeek 实测不从,已删)；本门判据是确定性事实：
 * artifact.referencedFiles=Analyst 真实读过/接地过的文件。模块 ownedFiles 够多(≥minModuleFiles)
 * 而其中被接地的 <minGroundedOwnedFiles 时,把 pass 改为 analysis_retry 并点名未读文件——
 * 定向补读,不重挖已达标部分。仅在基础门 pass 后叠加(不干扰更优先的 record_repair 等动作)；
 * retry 次数由外层 gate.maxRetries 统一约束,耗尽走 retry_exhausted 一等出口。
 */
export function applyModuleCoverageGate<
  T extends { pass: boolean; action?: string; reason?: string },
>(
  gate: T,
  artifact: Record<string, unknown>,
  strategyContext: Record<string, unknown> = {},
  { minModuleFiles = 8, minGroundedOwnedFiles = 3 } = {}
): T {
  if (!gate.pass) {
    return gate;
  }
  const moduleContext =
    strategyContext.moduleContext && typeof strategyContext.moduleContext === 'object'
      ? (strategyContext.moduleContext as { ownedFiles?: unknown })
      : null;
  const ownedFiles = Array.isArray(moduleContext?.ownedFiles)
    ? (moduleContext.ownedFiles as unknown[]).filter(
        (file): file is string => typeof file === 'string'
      )
    : [];
  if (ownedFiles.length < minModuleFiles) {
    return gate;
  }
  const groundedFiles = artifact.groundedFiles ?? artifact.referencedFiles;
  const referenced = Array.isArray(groundedFiles)
    ? (groundedFiles as unknown[]).filter((file): file is string => typeof file === 'string')
    : [];
  // 路径形态宽容匹配(referencedFiles 可能带仓根前缀或相对形态)。
  const grounded = ownedFiles.filter((owned) =>
    referenced.some(
      (ref) => ref === owned || ref.endsWith(`/${owned}`) || owned.endsWith(`/${ref}`)
    )
  );
  if (grounded.length >= minGroundedOwnedFiles) {
    return gate;
  }
  const unread = ownedFiles
    .filter((owned) => !grounded.includes(owned))
    .slice(0, 5)
    .join(', ');
  return {
    ...gate,
    pass: false,
    action: 'analysis_retry',
    reason:
      `Module coverage too thin: only ${grounded.length}/${ownedFiles.length} owned files grounded. ` +
      `Read these key files with code.read before concluding: ${unread}`,
  };
}

/**
 * 空回复时 analyze 源的状态归类，只用于 [QualityGate] 观测行：
 * - missing：源阶段没有留下对象形结果(阶段未执行或结果被替换)
 * - aborted / timed_out：阶段结果自带的中止、超时标记(中止优先于超时，二者都优先于普通空回复)
 * - empty_reply：阶段正常结束但回复为空
 * 阶段抛错时 PipelineStrategy 直接抛出，不会走到门评估器，因此这里没有 error 分类。
 */
function describeEmptyAnalysisSource(source: unknown): {
  sourceState: 'missing' | 'aborted' | 'timed_out' | 'empty_reply';
  toolCallCount: number;
} {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { sourceState: 'missing', toolCallCount: 0 };
  }
  const record = source as { toolCalls?: unknown; aborted?: unknown; timedOut?: unknown };
  const toolCallCount = Array.isArray(record.toolCalls) ? record.toolCalls.length : 0;
  if (record.aborted === true) {
    return { sourceState: 'aborted', toolCallCount };
  }
  if (record.timedOut === true) {
    return { sourceState: 'timed_out', toolCallCount };
  }
  return { sourceState: 'empty_reply', toolCallCount };
}

/**
 * C09(L7-P18)：insight 质量门的候选模式单一判据，基础门的候选档与深度接地门共用这一个结果。
 * - needsCandidates 是布尔时以它为准：冷启动宿主按维度计划显式写入(含 false)。
 * - 否则按 outputType∈{candidate,dual} 判定：scan 的 SystemRunContextFactory.createSystemContext
 *   只写 outputType:'candidate'，不写 needsCandidates。
 * 此前基础门按 outputType 走候选档、深度门只看 needsCandidates，scan 只得到一半候选门(深度门被跳过)。
 * source 只用于 [QualityGate] 观测行，说明判据来自哪个字段；非布尔的 needsCandidates 视为未写入，
 * 观测行另记 needsCandidatesIgnored，便于发现宿主写错类型。
 */
function resolveCandidateOutputMode(
  needsCandidates: unknown,
  outputType: unknown
): {
  isCandidateOutput: boolean;
  source: 'needsCandidates' | 'outputType';
  ignoredNeedsCandidates: boolean;
} {
  if (typeof needsCandidates === 'boolean') {
    return {
      isCandidateOutput: needsCandidates,
      source: 'needsCandidates',
      ignoredNeedsCandidates: false,
    };
  }
  return {
    isCandidateOutput: outputType === 'candidate' || outputType === 'dual',
    source: 'outputType',
    ignoredNeedsCandidates: needsCandidates !== undefined && needsCandidates !== null,
  };
}

/** [QualityGate] 观测行里的候选模式片段：档位 + 判据来源(+ 被忽略的非布尔 needsCandidates)。 */
function describeCandidateMode(mode: ReturnType<typeof resolveCandidateOutputMode>): string {
  return (
    `candidateMode=${mode.isCandidateOutput ? 'candidate' : 'analysis'}(source=${mode.source})` +
    (mode.ignoredNeedsCandidates ? ' needsCandidatesIgnored=non-boolean' : '')
  );
}

/**
 * 面向 PipelineStrategy gate.evaluator 的包装函数。
 *
 * 将 PipelineStrategy 的 (source, phaseResults, strategyContext) 签名
 * 适配到 buildAnalysisArtifact + analysisQualityGate 调用链：基础质量门之上依次叠加
 * applyDepthRetryGate(深度接地)与 applyModuleCoverageGate(模块覆盖度)。基础门的候选档与是否叠加
 * 深度门共用 resolveCandidateOutputMode 的单一判据(needsCandidates 布尔优先，否则 outputType)。
 * 副作用：每次评估都会先清空再重写 sharedState._analystGraphEvidence / _analystGroundedRanges，
 * 供同轮 knowledge.submit handler 使用(不授予新的生产权限)。
 *
 * @param source 前一阶段 (analyze) 的 reactLoop 返回值
 * @param phaseResults 所有阶段结果(本评估器不读取，保留以匹配 gate.evaluator 签名)
 * @param strategyContext PipelineStrategy 展开注入的运行时上下文(activeContext / projectGraph /
 *   dimId / outputType / needsCandidates / projectRoot / sharedState / moduleContext 等)
 * @returns `{ action, reason, artifact }`：action 为 pass，或门给出的 analysis_retry /
 *   record_repair / summary_rewrite / degrade(门未给动作时退回 retry)；空回复短路为
 *   degrade 且 artifact=null。否则 artifact 在有 activeContext 时是 AnalysisArtifact，
 *   无 activeContext 时是降级的 AnalysisReport，两者都带 pcvNodeEvidence 与对应 metadata。
 */
export function insightGateEvaluator(
  source: unknown,
  phaseResults: Record<string, unknown>,
  strategyContext: Record<string, unknown> = {}
) {
  const sharedState =
    strategyContext.sharedState && typeof strategyContext.sharedState === 'object'
      ? (strategyContext.sharedState as Record<string, unknown>)
      : null;
  // 每次 gate 都是本轮分析的完整投影；空结果也要清掉旧轮次/维度的来源，防止 submit 借用。
  if (sharedState) {
    sharedState._analystGraphEvidence = [];
    sharedState._analystGroundedRanges = {};
  }
  const { projectGraph, activeContext, dimId, outputType, needsCandidates, projectRoot } =
    strategyContext as InsightGateStrategyContext;

  if (!(source as AnalystResult | null | undefined)?.reply) {
    // 空回复短路：判定保持 degrade + artifact=null(PipelineStrategy 据此终止本维度)。这里只补
    // [QualityGate] 观测行，与其他门动作同一前缀，便于按维度追踪「为什么没有分析」。
    // PCV 质量门证据目前只挂在 artifact.pcvNodeEvidence 上；本分支 artifact 必须为 null，
    // 补证据需要新的承载字段，属于公开返回形状变化，暂不在此添加。
    const { sourceState, toolCallCount } = describeEmptyAnalysisSource(source);
    observeSafely(
      () =>
        logger().info(
          `[QualityGate] dim="${dimId}" action=degrade reason="No analysis output" ` +
            `source=${sourceState} toolCalls=${toolCallCount}`
        ),
      () => undefined
    );
    return { action: 'degrade', reason: 'No analysis output', artifact: null };
  }

  const artifact = activeContext
    ? buildAnalysisArtifact(source as AnalystResult, dimId as string, projectGraph, activeContext, {
        // R1: 宿主注入 projectRoot 才启用锚点补齐；缺失时保持旧行为（不读盘、不编造）。
        ...(typeof projectRoot === 'string' && projectRoot ? { projectRoot } : {}),
      })
    : buildAnalysisReport(source as AnalystResult, dimId as string, projectGraph);

  // P4/C9: 基础质量门 → 叠加深度接地 retry(仅候选生成且已通过时；见 applyDepthRetryGate)。
  // C09(L7-P18)：两个门用同一个候选判据。analysisQualityGate 只区分 candidate/dual 与其他，
  // 所以非候选统一传 'analysis'；scan(只写 outputType:'candidate')因此也执行深度接地门。
  const candidateMode = resolveCandidateOutputMode(needsCandidates, outputType);

  // F4g graph-retry 已删除(P1-B-4)：它靠"命令模型调 graph"，DeepSeek 实测不从(retry 只把
  // 维度拖成 error)。替代者是下方 applyModuleCoverageGate——判据来自确定性事实(实读/接地
  // 了哪些文件)，与 provider 意愿无关。关系声明的 graph 背书仍走 F4e 注入/submit 拒绝反馈。
  let gate = applyDepthRetryGate(
    analysisQualityGate(artifact, {
      outputType: candidateMode.isCandidateOutput ? 'candidate' : 'analysis',
    }),
    artifact as Record<string, unknown>,
    candidateMode.isCandidateOutput
  );
  // P1-B-4：provider 中立覆盖度门。模块够大而 Analyst 接地的 owned 文件过少 → 定向 retry
  // (点名未读文件)。retry 耗尽走 F2 retry_exhausted 一等出口，不会死循环。
  gate = applyModuleCoverageGate(gate, artifact as Record<string, unknown>, strategyContext);
  // F4e：把 Analyst 真实 graph 查询的可复制 refs 经 sharedState 传给 submit handler——
  // GRAPH_REF_INVALID 拒绝时 handler 自动注入（替模型完成「复制」动作；graphEvidence
  // 为空则无背书可注入，保持拒绝，绝不编造）。与 pcv 数据走 sharedState 同一先例模式。
  const artifactGraphEvidence = (artifact as { graphEvidence?: string[] }).graphEvidence;
  if (sharedState && Array.isArray(artifactGraphEvidence) && artifactGraphEvidence.length > 0) {
    sharedState._analystGraphEvidence = artifactGraphEvidence;
  }
  // F4f：evidenceMap 的接地行范围精简投影 → submit handler。模型提交裸路径 sourceRefs
  // （无行号）时，handler 用该文件 Analyst 真实读过/补齐过的范围把 ref 规范化——语义关联
  // 最强的行号来源，非任意指派。
  const artifactEvidenceMap = (artifact as { evidenceMap?: Map<string, unknown> }).evidenceMap;
  if (sharedState && artifactEvidenceMap instanceof Map && artifactEvidenceMap.size > 0) {
    const groundedRanges: Record<string, Array<{ start: number; end: number }>> = {};
    for (const [filePath, entry] of artifactEvidenceMap) {
      const snippets = (entry as { codeSnippets?: Array<{ startLine: number; endLine: number }> })
        .codeSnippets;
      if (Array.isArray(snippets) && snippets.length > 0) {
        groundedRanges[filePath] = snippets
          .slice(0, 3)
          .map((s) => ({ start: s.startLine, end: s.endLine }));
      }
    }
    if (Object.keys(groundedRanges).length > 0) {
      sharedState._analystGroundedRanges = groundedRanges;
    }
  }
  const pcvNodeEvidence = buildPcvQualityGateEvidence({
    artifact,
    dimId: dimId || null,
    gate,
    sharedState,
    source,
    stageNodeContext: strategyContext,
  });
  (artifact as Record<string, unknown>).pcvNodeEvidence = pcvNodeEvidence;
  (artifact as { metadata?: Record<string, unknown> }).metadata = {
    ...((artifact as { metadata?: Record<string, unknown> }).metadata || {}),
    pcvNodeEvidenceRef: pcvNodeEvidence.nodeId,
    pcvNodeEvidenceMissingLinks: pcvNodeEvidence.missingLinkReasons,
    pcvQualityGateStatus: pcvNodeEvidence.qualityGate?.status || null,
  };

  const qr = (artifact as Record<string, unknown>).qualityReport as QualityReport | undefined;
  if (qr?.scores) {
    const artifactMetadata = (artifact as { metadata?: Record<string, unknown> }).metadata || {};
    const memoryFindingCount =
      typeof artifactMetadata.memoryFindingCount === 'number'
        ? artifactMetadata.memoryFindingCount
        : 0;
    observeSafely(
      () =>
        logger().info(
          `[QualityGate] dim="${dimId}" action=${gate.pass ? 'pass' : gate.action} ` +
            `total=${qr.totalScore} depth=${qr.scores.depthScore} breadth=${qr.scores.breadthScore} ` +
            `evidence=${qr.scores.evidenceScore} coherence=${qr.scores.coherenceScore} ` +
            `memoryFindings=${memoryFindingCount} ${describeCandidateMode(candidateMode)}` +
            (qr.suggestions.length > 0 ? ` suggestions=[${qr.suggestions.join('; ')}]` : '')
        ),
      () => undefined
    );
  } else {
    observeSafely(
      () =>
        logger().info(
          `[QualityGate] dim="${dimId}" action=${gate.pass ? 'pass' : gate.action} reason="${gate.reason || 'v1-rules'}" ` +
            `${describeCandidateMode(candidateMode)} (v1 fallback)`
        ),
      () => undefined
    );
  }

  return {
    action: gate.action || (gate.pass ? 'pass' : 'retry'),
    reason: gate.reason || '',
    artifact,
  };
}

// ──────────────────────────────────────────────────────────────────
// Evolution Gate Evaluator — 检查所有衰退 Recipe 是否都被处理
// ──────────────────────────────────────────────────────────────────

/** Tool call record for evolution gate */
interface EvolutionToolCallRecord {
  tool?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  envelope?: { ok?: boolean };
}

/**
 * 进化门产物：进化阶段对本维度现有 Recipe 的决策账。
 *
 * processed/pendingIds 供进化阶段补写；evolved/deprecated/skipped 供后续分析阶段了解
 * 已处理范围。三类计数按 Recipe 归并，恒有 evolved + deprecated + skipped === processed。
 */
export interface EvolutionGateArtifact {
  processed: number;
  totalRecipes: number;
  pendingIds: string[];
  evolved: number;
  deprecated: number;
  skipped: number;
}

/** 进化门在管线里的阶段名；下游按名取产物，不依赖它是不是「最近一个门」。 */
export const EVOLUTION_GATE_STAGE = 'evolution_gate';

/**
 * Evolution Gate 评估器 — 面向 PipelineStrategy gate.evaluator
 *
 * 检查 Evolution Agent 是否对所有现有 Recipe 做出了决策:
 * - evolved: knowledge.manage(operation: "evolve", id) 或 knowledge.submit(supersedes: ...)
 * - deprecated: knowledge.manage(operation: "deprecate", id)
 * - skipped: knowledge.manage(operation: "skip_evolution", id)
 *
 * 如果还有未处理的 Recipe，返回 retry 要求补充决策。
 *
 * 兼容旧字段: 优先读 existingRecipes，回退 decayedRecipes。
 */
export function evolutionGateEvaluator(
  source: { toolCalls?: EvolutionToolCallRecord[] } | null | undefined,
  _phaseResults: unknown,
  strategyContext: {
    existingRecipes?: Array<{ id: string }>;
    decayedRecipes?: Array<{ id: string }>;
  } = {}
) {
  const totalRecipes = (strategyContext.existingRecipes ?? strategyContext.decayedRecipes ?? [])
    .length;
  const expectedIds = (strategyContext.existingRecipes ?? strategyContext.decayedRecipes ?? []).map(
    (r) => r.id
  );
  // 门配置了 useCumulativeToolCalls：这里看到的是进化阶段全部尝试的累计回执，
  // 所以三类计数覆盖补写轮，而不是只有最后一次尝试。
  const decisions = collectEvolutionDecisions(source?.toolCalls || [], expectedIds);

  const processed = decisions.size;
  const pendingIds = expectedIds.filter((id) => !decisions.has(id));
  const artifact: EvolutionGateArtifact = {
    processed,
    totalRecipes,
    pendingIds,
    evolved: 0,
    deprecated: 0,
    skipped: 0,
  };
  for (const decision of decisions.values()) {
    artifact[decision] += 1;
  }

  if (totalRecipes > 0 && pendingIds.length > 0) {
    return {
      action: 'retry',
      reason: `只处理了 ${processed}/${totalRecipes} 个 Recipe，还有 ${pendingIds.length} 个未决策`,
      artifact,
    };
  }

  return {
    action: 'pass',
    artifact,
  };
}

/**
 * 从阶段结果里按名读取进化门产物；进化阶段没跑、或产物形状不符时返回 null。
 *
 * 提示构建器用它而不是「最近一个门产物」：后者的形状取决于上一个门是谁，
 * 管线里多插一个门就会把无关字段当成进化结果喂给模型。
 */
export function readEvolutionGateArtifact(phaseResults: unknown): EvolutionGateArtifact | null {
  if (!phaseResults || typeof phaseResults !== 'object') {
    return null;
  }
  const gate = (phaseResults as Record<string, unknown>)[EVOLUTION_GATE_STAGE];
  const artifact =
    gate && typeof gate === 'object' ? (gate as { artifact?: unknown }).artifact : null;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return null;
  }
  const record = artifact as Record<string, unknown>;
  const count = (key: string) => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  };
  const [processed, totalRecipes, evolved, deprecated, skipped] = [
    count('processed'),
    count('totalRecipes'),
    count('evolved'),
    count('deprecated'),
    count('skipped'),
  ];
  if (
    processed === null ||
    totalRecipes === null ||
    evolved === null ||
    deprecated === null ||
    skipped === null
  ) {
    return null;
  }
  return {
    processed,
    totalRecipes,
    pendingIds: Array.isArray(record.pendingIds)
      ? record.pendingIds.filter((id): id is string => typeof id === 'string')
      : [],
    evolved,
    deprecated,
    skipped,
  };
}

// ──────────────────────────────────────────────────────────────────
// Producer Rejection Gate Evaluator — 拒绝率门控
// ──────────────────────────────────────────────────────────────────

/** reactLoop 返回值 (门控评估用) */
interface ReactLoopResult {
  /** 外部工具观察统一交给 readToolObservation 验证，不再维护过时的局部结果壳。 */
  toolCalls?: readonly unknown[];
}

/** 门控策略上下文 */
interface GateStrategyContext {
  submitToolNames?: string[];
  [key: string]: unknown;
}

/** 一组工具调用里提交类调用的已持久化/未持久化计数。 */
function countSubmissions(
  toolCalls: readonly unknown[],
  names: readonly string[]
): { success: number; rejected: number } {
  const submitCalls = toolCalls.filter((call) => {
    const { tool } = readToolObservation(call);
    return names.includes(tool) && (tool !== 'knowledge' || isKnowledgeSubmit(call));
  });
  const success = submitCalls.filter(hasPersistedCandidate).length;
  return { success, rejected: submitCalls.length - success };
}

/**
 * 读取源阶段被门重试覆盖前的先前尝试(C08/L7-P18)。
 *
 * PipelineStrategy 在门判 retry、回跳重跑 producer 阶段前，把即将被 phaseResults[<stage>] 覆盖的回执
 * 工具调用并入内部键 `_priorAttempts_<stage>`：`{ attempts, toolCalls }`。评估器不知道源阶段名，按引用
 * 找：phaseResults 中与 source 是同一对象的阶段键就是源阶段。门配置了 useCumulativeToolCalls 时传入的是
 * 已含全部尝试的副本，找不到同一引用，这里返回 null，避免把先前尝试重复计入。
 * 内部键形状不符时返回 null 并记 warn 日志：退回只看本次尝试的旧判据，不猜测。
 */
function readPriorSourceAttempts(
  source: object,
  phaseResults: unknown
): { stageName: string; attempts: number; toolCalls: readonly unknown[] } | null {
  if (!phaseResults || typeof phaseResults !== 'object' || Array.isArray(phaseResults)) {
    return null;
  }
  const record = phaseResults as Record<string, unknown>;
  const stageName = Object.keys(record).find(
    (key) => !key.startsWith('_') && record[key] === source
  );
  if (!stageName) {
    return null;
  }
  const prior = record[`_priorAttempts_${stageName}`];
  if (prior === undefined) {
    return null;
  }
  const attempts =
    prior && typeof prior === 'object' ? (prior as { attempts?: unknown }).attempts : undefined;
  const toolCalls =
    prior && typeof prior === 'object' ? (prior as { toolCalls?: unknown }).toolCalls : undefined;
  if (
    typeof attempts !== 'number' ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    !Array.isArray(toolCalls)
  ) {
    observeSafely(
      () =>
        logger().warn(
          `[RejectionGate] source="${stageName}" ignoring malformed _priorAttempts_${stageName} ` +
            `(attempts=${typeof attempts === 'number' ? attempts : typeof attempts}, ` +
            `toolCalls=${Array.isArray(toolCalls) ? 'array' : typeof toolCalls}); ` +
            'judging the latest attempt only'
        ),
      () => undefined
    );
    return null;
  }
  return { stageName, attempts, toolCalls };
}

/**
 * Producer 拒绝率门控 — 面向 PipelineStrategy gate.evaluator
 *
 * 当 produce 阶段的提交拒绝率过高时触发 retry。
 *
 * 首轮(没有先前尝试)：本次尝试的提交拒绝数大于成功数且拒绝 ≥2 时为 retry。
 * 重试轮(C08/L7-P18，源阶段带 `_priorAttempts_<stage>`)：phaseResults[<stage>] 只剩最后一次尝试的回执，
 * 首轮已落库的候选不在其中；这里按先前尝试与本次尝试合计的已持久化候选判断——合计 > 0 即 pass，reason
 * 记合计与本次的拒绝/成功数(不新增质量告警状态)；合计为 0 时仍按本次尝试的判据，重试轮再被拒照旧 retry，
 * 由 PipelineStrategy 记 retry_exhausted / abandoned。
 *
 * @param source produce 阶段的 reactLoop 返回值
 * @param phaseResults 阶段结果表；重试轮从中读取源阶段的先前尝试
 * @returns `{ action, reason }`：retry 时 reason 写明本次拒绝/成功数；重试轮合计有已持久化候选时为 pass
 *   且 reason 写明合计与本次计数；其余(含 source 无 toolCalls)为 pass、reason 为空串。
 */
export function producerRejectionGateEvaluator(
  source: ReactLoopResult | null | undefined,
  phaseResults: unknown,
  strategyContext: GateStrategyContext = {}
) {
  if (!source?.toolCalls) {
    return { action: 'pass', reason: '' };
  }

  const names = strategyContext.submitToolNames ?? ['knowledge'];
  const { success, rejected } = countSubmissions(source.toolCalls || [], names);
  const perAttempt =
    rejected > success && rejected >= 2
      ? { action: 'retry', reason: `${rejected} rejections vs ${success} successes` }
      : { action: 'pass', reason: '' };

  const prior = readPriorSourceAttempts(source, phaseResults);
  if (!prior) {
    return perAttempt;
  }

  const priorCounts = countSubmissions(prior.toolCalls, names);
  const totalSuccess = success + priorCounts.success;
  const totalRejected = rejected + priorCounts.rejected;
  const totalAttempts = prior.attempts + 1;
  const counts =
    `cumulative ${totalRejected} rejections vs ${totalSuccess} successes across ` +
    `${totalAttempts} ${prior.stageName} attempts ` +
    `(latest attempt: ${rejected} rejections vs ${success} successes)`;
  if (totalSuccess > 0) {
    // 分叉留痕：触发条件(重试轮且先前尝试已有落库候选)、选择路径(pass，覆盖单次判据)、关键输入(合计与本次计数)。
    observeSafely(
      () =>
        logger().info(
          `[RejectionGate] source="${prior.stageName}" retry round: ${counts}; ` +
            `persisted candidates exist → action=pass (perAttemptAction=${perAttempt.action})`
        ),
      () => undefined
    );
    return { action: 'pass', reason: `${counts}; persisted candidates exist` };
  }
  // 合计没有已持久化候选：保持单次尝试判据(F2：retry 耗尽如实报 abandoned)。
  observeSafely(
    () =>
      logger().info(
        `[RejectionGate] source="${prior.stageName}" retry round: ${counts}; ` +
          `no persisted candidates across attempts → latest-attempt rule action=${perAttempt.action}`
      ),
    () => undefined
  );
  return perAttempt;
}
