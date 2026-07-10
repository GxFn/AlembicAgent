/**
 * gateEvaluators.ts — PipelineStrategy gate.evaluator 适配器三件
 *
 * W6-d(A1)段级迁移(拆前基线 4fa4814):
 * - 自 src/agent/prompts/insightGate.ts:
 *   InsightGateStrategyContext(原 :160)、insightGateEvaluator(原 :1102)、
 *   EvolutionToolCallRecord(原 :1210)、evolutionGateEvaluator(原 :1230)、
 *   isSuccessfulEvolutionToolCall(原 :1315)
 * - 自 src/agent/prompts/insightProducer.ts:
 *   ReactLoopResult/ToolCallRecord/GateStrategyContext(原 :59-75)、
 *   producerRejectionGateEvaluator(原 :655)
 *
 * 适配器把 PipelineStrategy 的 (source, phaseResults, strategyContext) 签名
 * 接到工件构建(analysisArtifact)+质量门(qualityGates)+PCV 证据记录调用链。
 *
 * @module evaluation/gateEvaluators
 */

import Logger from '@alembic/core/logging';
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
 * 面向 PipelineStrategy gate.evaluator 的包装函数。
 *
 * 将 PipelineStrategy 的 (source, phaseResults, strategyContext) 签名
 * 适配到 buildAnalysisArtifact + analysisQualityGate 调用链。
 *
 * @param source 前一阶段 (analyze) 的 reactLoop 返回值
 * @param phaseResults 所有阶段结果
 * @param strategyContext orchestrator 注入的运行时上下文
 * @returns }
 */
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
  const referenced = Array.isArray(artifact.referencedFiles)
    ? (artifact.referencedFiles as unknown[]).filter(
        (file): file is string => typeof file === 'string'
      )
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

export function insightGateEvaluator(
  source: unknown,
  phaseResults: Record<string, unknown>,
  strategyContext: Record<string, unknown> = {}
) {
  if (!(source as AnalystResult | null | undefined)?.reply) {
    return { action: 'degrade', reason: 'No analysis output', artifact: null };
  }

  const { projectGraph, activeContext, dimId, outputType, needsCandidates, projectRoot } =
    strategyContext as InsightGateStrategyContext;

  const artifact = activeContext
    ? buildAnalysisArtifact(source as AnalystResult, dimId as string, projectGraph, activeContext, {
        // R1: 宿主注入 projectRoot 才启用锚点补齐；缺失时保持旧行为（不读盘、不编造）。
        ...(typeof projectRoot === 'string' && projectRoot ? { projectRoot } : {}),
      })
    : buildAnalysisReport(source as AnalystResult, dimId as string, projectGraph);

  // P4/C9: 基础质量门 → 叠加深度接地 retry(仅候选生成且已通过时；见 applyDepthRetryGate)。
  const sharedState =
    strategyContext.sharedState && typeof strategyContext.sharedState === 'object'
      ? (strategyContext.sharedState as Record<string, unknown>)
      : null;
  // F4g graph-retry 已删除(P1-B-4)：它靠"命令模型调 graph"，DeepSeek 实测不从(retry 只把
  // 维度拖成 error)。替代者是下方 applyModuleCoverageGate——判据来自确定性事实(实读/接地
  // 了哪些文件)，与 provider 意愿无关。关系声明的 graph 背书仍走 F4e 注入/submit 拒绝反馈。
  let gate = applyDepthRetryGate(
    analysisQualityGate(artifact, {
      outputType: needsCandidates ? 'candidate' : outputType || 'analysis',
    }),
    artifact as Record<string, unknown>,
    Boolean(needsCandidates)
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
    logger().info(
      `[QualityGate] dim="${dimId}" action=${gate.pass ? 'pass' : gate.action} ` +
        `total=${qr.totalScore} depth=${qr.scores.depthScore} breadth=${qr.scores.breadthScore} ` +
        `evidence=${qr.scores.evidenceScore} coherence=${qr.scores.coherenceScore} ` +
        `memoryFindings=${memoryFindingCount}` +
        (qr.suggestions.length > 0 ? ` suggestions=[${qr.suggestions.join('; ')}]` : '')
    );
  } else {
    logger().info(
      `[QualityGate] dim="${dimId}" action=${gate.pass ? 'pass' : gate.action} reason="${gate.reason || 'v1-rules'}" (v1 fallback)`
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
  const expectedIdSet = new Set(expectedIds);
  const toolCalls = source?.toolCalls || [];

  const processedIds = new Set<string>();
  const markProcessed = (id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) {
      return;
    }
    if (expectedIdSet.size > 0 && !expectedIdSet.has(id)) {
      return;
    }
    processedIds.add(id);
  };

  for (const tc of toolCalls) {
    const tool = tc.tool || tc.name;
    const args = tc.args || {};

    if (!isSuccessfulEvolutionToolCall(tc)) {
      continue;
    }

    // V2: knowledge({ action: "manage", params: { operation: "evolve"|"deprecate"|"skip_evolution", id } })
    if (tool === 'knowledge') {
      const params = (args.params as Record<string, unknown>) || args;
      const action = args.action as string | undefined;
      const operation = params.operation as string | undefined;
      const recipeId = (params.id ?? params.recipeId) as string | undefined;

      if (
        action === 'manage' &&
        recipeId &&
        (operation === 'evolve' || operation === 'deprecate' || operation === 'skip_evolution')
      ) {
        markProcessed(recipeId);
      }
      // V2: knowledge.submit with supersedes
      const supersedes = args.supersedes || params.supersedes;
      if ((action === 'submit' || supersedes) && supersedes) {
        markProcessed(supersedes);
      }
    }

    // V1 compat: standalone tool names
    if (tool === 'propose_evolution' && args.recipeId) {
      markProcessed(args.recipeId);
    }
    if (tool === 'confirm_deprecation' && args.recipeId) {
      markProcessed(args.recipeId);
    }
    if (tool === 'skip_evolution' && args.recipeId) {
      markProcessed(args.recipeId);
    }
  }

  const processed = processedIds.size;
  const pendingIds = expectedIds.filter((id) => !processedIds.has(id));

  if (totalRecipes > 0 && pendingIds.length > 0) {
    return {
      action: 'retry',
      reason: `只处理了 ${processed}/${totalRecipes} 个 Recipe，还有 ${pendingIds.length} 个未决策`,
      artifact: { processed, totalRecipes, pendingIds },
    };
  }

  return {
    action: 'pass',
    artifact: { processed, totalRecipes, pendingIds },
  };
}

function isSuccessfulEvolutionToolCall(tc: EvolutionToolCallRecord): boolean {
  if (tc.envelope?.ok === false) {
    return false;
  }
  const result = tc.result as Record<string, unknown> | undefined;
  if (result && typeof result === 'object' && typeof result.error === 'string') {
    return false;
  }
  return true;
}

// ──────────────────────────────────────────────────────────────────
// Producer Rejection Gate Evaluator — 拒绝率门控
// ──────────────────────────────────────────────────────────────────

/** reactLoop 返回值 (门控评估用) */
interface ReactLoopResult {
  toolCalls?: ToolCallRecord[];
}

/** 工具调用记录 */
interface ToolCallRecord {
  tool?: string;
  name?: string;
  result?: string | { status?: string; reason?: string };
}

/** 门控策略上下文 */
interface GateStrategyContext {
  submitToolNames?: string[];
  [key: string]: unknown;
}

/**
 * Producer 拒绝率门控 — 面向 PipelineStrategy gate.evaluator
 *
 * 当 produce 阶段的提交拒绝率过高时触发 retry。
 *
 * @param source produce 阶段的 reactLoop 返回值
 * @returns }
 */
export function producerRejectionGateEvaluator(
  source: ReactLoopResult | null | undefined,
  _phaseResults: unknown,
  _strategyContext: GateStrategyContext = {}
) {
  if (!source?.toolCalls) {
    return { action: 'pass', reason: '' };
  }

  // 可配置的提交工具名 — V2 统一为 knowledge，scan 用 knowledge
  const submitToolNames = _strategyContext.submitToolNames || ['knowledge'];
  const submitCalls = (source.toolCalls || []).filter((tc: ToolCallRecord) =>
    submitToolNames.includes(tc.tool || tc.name || '')
  );
  const rejected = submitCalls.filter((tc: ToolCallRecord) => {
    const res = tc.result;
    if (!res) {
      return false;
    }
    if (typeof res === 'string') {
      return res.includes('rejected') || res.includes('error');
    }
    return (
      res.status === 'rejected' || res.status === 'error' || res.reason === 'validation_failed'
    );
  }).length;
  const success = submitCalls.length - rejected;

  if (rejected > success && rejected >= 2) {
    return { action: 'retry', reason: `${rejected} rejections vs ${success} successes` };
  }
  return { action: 'pass', reason: '' };
}
