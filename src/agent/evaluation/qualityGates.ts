/**
 * qualityGates.ts — 分析质量门(评分 + 门控 + depth/graph retry 门)
 *
 * W6-d(A1)段级迁移自 src/agent/prompts/insightGate.ts(拆前基线 4fa4814):
 * - 深度 retry 常量 DEPTH_RETRY_MIN_GROUNDED_DIMS/DEPTH_GAP_REASON(原 :49,:52)
 * - 评分/门控类型 NormalizedFinding/QualityScores/QualityReport/GateOptions/
 *   GateResult/GateableReport(原 :109-157)
 * - suggestion 路由常量 REQUIRED_MEMORY_FINDING_SUGGESTION/
 *   INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION(原 :131,:132)
 * - buildQualityScores(原 :566)、analysisQualityGate(原 :664)、
 *   applyGateThresholds(原 :680)、analysisQualityGateV1(原 :737)
 * - getArtifactMemoryFindingCount(原 :842;门与 repair prompt 共用,改由本文件单源导出)
 * - reviewInsightDepth(原 :981)、applyDepthRetryGate(原 :1002)、
 *   applyGraphRetryGate 已删除(P1-B-4)：由 gateEvaluators.applyModuleCoverageGate 替代(确定性覆盖度判据,与 provider 意愿无关)
 *
 * ⚠️ 跨段路由常量契约:DEPTH_GAP_REASON 与两条 suggestion 常量既是本文件门控产出的
 * reason/suggestion 字面,也是 prompts/insightGate.ts buildRetryPrompt 的路由键
 * (startsWith 前缀路由 + hints 精确键)。两侧必须引用同一导出——若 prompts 侧退化为
 * 本地字面量副本,编译仍绿,但深度 retry/记忆修复路由在运行期静默失效。
 *
 * @module evaluation/qualityGates
 */

import {
  DEPTH_DIMENSIONS,
  type DepthReviewResult,
  DIMENSION_COMPLETION_FLOOR,
  RELATIONSHIP_CN_RE,
  reviewRecipeDepth,
} from '@alembic/core/knowledge';
import type { EvidenceCollectorResult } from '../evidence/EvidenceCollector.js';

// ──────────────────────────────────────────────────────────────────
// P4/C9: in-process 深度接地 retry 常量
// ──────────────────────────────────────────────────────────────────

/**
 * 深度 retry 的接地维度下限：分析已充分且深度已被尝试(填了 note_finding 深度槽)但接地核心维度少于此数时，
 * 回炉重挖。保守取 2——一条分析只要接地 ≥2 个深度维度即放行，把 retry 只压在「尝试了深度却基本没接地」的
 * 情形，避免给没尝试深度的旧式分析制造回归(P6 真机可上调)。
 */
const DEPTH_RETRY_MIN_GROUNDED_DIMS = 2;

/** 深度缺口 retry 的 reason 前缀(buildRetryPrompt 据此路由到深度重挖分支，后接缺口维度名)。 */
export const DEPTH_GAP_REASON = 'Depth dimensions lack grounded evidence';

// ──────────────────────────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────────────────────────

/** 标准化发现 */
export interface NormalizedFinding {
  finding: string;
  evidence: string;
  importance: number;
}

/** 多维度质量评分 */
export interface QualityScores {
  depthScore: number;
  breadthScore: number;
  evidenceScore: number;
  coherenceScore: number;
}

/** 质量报告 */
export interface QualityReport {
  scores: QualityScores;
  totalScore: number;
  suggestions: string[];
}

export const REQUIRED_MEMORY_FINDING_SUGGESTION = 'Required note_finding calls are missing';
export const INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION = 'At least 3 note_finding calls are required';

/** 门控选项 */
export interface GateOptions {
  outputType?: string;
  /**
   * memory 中已验证 findings 数(artifact.metadata.memoryFindingCount)。
   * 打回动作分流依据：findings 充足时写作类失败走 summary_rewrite(纯写作重组，
   * 零工具单调用)，只有证据真缺时才走 analysis_retry(整段带工具重挖，最贵)。
   */
  memoryFindingCount?: number;
}

/** 门控结果 */
export interface GateResult {
  pass: boolean;
  reason?: string;
  action?: 'analysis_retry' | 'record_repair' | 'summary_rewrite' | 'retry' | 'degrade';
}

/** 可进行门控评估的分析报告 */
export interface GateableReport {
  analysisText: string;
  referencedFiles: string[];
  qualityReport?: QualityReport;
}

// ──────────────────────────────────────────────────────────────────
// 多维度质量评分 (v2)
// ──────────────────────────────────────────────────────────────────

/**
 * 计算 AnalysisArtifact 的多维度质量评分
 *
 * 4 维度各 0-100, 加权:
 *   depthScore (30%) — 文件覆盖深度
 *   breadthScore (20%) — 工具使用广度
 *   evidenceScore (30%) — 证据充分性
 *   coherenceScore (20%) — 分析连贯性
 */
export function buildQualityScores(
  analysisText: string,
  findings: NormalizedFinding[],
  evidence: EvidenceCollectorResult,
  options: { memoryFindingCount?: number; derivedFindingCount?: number } = {}
) {
  const scores = {} as QualityScores;

  const uniqueFilesRead = evidence.evidenceMap?.size || 0;
  const snippetCount = [...(evidence.evidenceMap?.values() || [])].reduce(
    (sum, e) => sum + e.codeSnippets.length,
    0
  );
  scores.depthScore = Math.min(100, uniqueFilesRead * 15 + snippetCount * 5);

  const toolTypes = new Set((evidence.explorationLog || []).map((e) => e.tool));
  const logLen = evidence.explorationLog?.length || 0;
  const effectiveRatio =
    logLen > 0 ? (evidence.explorationLog || []).filter((e) => e.effective).length / logLen : 0;
  scores.breadthScore = Math.min(100, toolTypes.size * 20 + effectiveRatio * 40);

  const findingCount = findings?.length || 0;
  const evidencedFindings = (findings || []).filter(
    (f) => f.evidence && f.evidence.length > 0
  ).length;
  if (findingCount > 0) {
    scores.evidenceScore = Math.min(
      100,
      (evidencedFindings / findingCount) * 60 + findingCount * 10
    );
  } else {
    // LLM didn't call note_finding — derive partial score from analysis text quality
    // so a substantial analysis doesn't get zero just because note_finding wasn't used
    const textLen = analysisText?.length || 0;
    const hasFileRefs = uniqueFilesRead > 0;
    scores.evidenceScore = Math.min(
      40,
      (textLen > 2000 ? 15 : textLen > 500 ? 8 : 0) +
        (hasFileRefs ? 15 : 0) +
        (snippetCount > 0 ? 10 : 0)
    );
  }

  const textLen = analysisText?.length || 0;
  const hasHeaders = /#{1,3}\s/.test(analysisText || '');
  const hasLists = /\d+\.\s|[-•]\s/.test(analysisText || '');
  scores.coherenceScore = Math.min(
    100,
    (textLen > 500 ? 40 : textLen / 12.5) +
      (hasHeaders ? 20 : 0) +
      (hasLists ? 20 : 0) +
      (findingCount >= 3 ? 20 : findingCount * 7)
  );

  const totalScore = Math.round(
    scores.depthScore * 0.3 +
      scores.breadthScore * 0.2 +
      scores.evidenceScore * 0.3 +
      scores.coherenceScore * 0.2
  );

  const suggestions: string[] = [];
  if (scores.depthScore < 50) {
    suggestions.push('Need more code({ action: "read" }) to examine code');
  }
  if (scores.evidenceScore < 50) {
    suggestions.push('Findings lack file-level evidence');
  }
  const memoryFindingCount = options.memoryFindingCount ?? 0;
  // memoryFindingCount 只代表 note_finding 已写入 ActiveContext 并可被
  // QualityGate 消费；它不区分 provider native tool_calls 与 DeepSeek
  // 文本兼容转译。产出方式必须看 AgentRuntime note_finding source 日志。
  if (memoryFindingCount === 0) {
    suggestions.push(REQUIRED_MEMORY_FINDING_SUGGESTION);
  } else if (memoryFindingCount < 3) {
    suggestions.push(INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION);
  }
  if (scores.coherenceScore < 50) {
    suggestions.push('Analysis text is too short or unstructured');
  }

  return { scores, totalScore, suggestions };
}

// ──────────────────────────────────────────────────────────────────
// 质量门控 (Gate)
// ──────────────────────────────────────────────────────────────────

/**
 * 读取 artifact.metadata.memoryFindingCount(缺失/非法时取 0)。
 * 门控(analysisQualityGate/applyDepthRetryGate)与 prompts 侧 buildRecordRepairPrompt
 * 用同一口径决定「重写」还是「重挖」——单源导出，避免两侧口径漂移。
 */
export function getArtifactMemoryFindingCount(artifact: unknown) {
  const metadata = (artifact as { metadata?: Record<string, unknown> } | null)?.metadata || {};
  const count = metadata.memoryFindingCount;
  return typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

/**
 * 分析质量门控
 *
 * 自动检测 v1 (AnalysisReport) 和 v2 (AnalysisArtifact):
 * - v2: 从 qualityReport.totalScore 计算
 * - v1: 使用 4 条规则
 *
 * @param [options.outputType] 'analysis' | 'dual' | 'candidate'
 * @returns }
 */
export function analysisQualityGate(report: GateableReport, options: GateOptions = {}): GateResult {
  // memoryFindingCount 优先取调用方显式值，否则从 artifact.metadata 读——两个子门与
  // applyDepthRetryGate 用同一口径决定「重写」还是「重挖」。
  const enriched: GateOptions = {
    ...options,
    memoryFindingCount: options.memoryFindingCount ?? getArtifactMemoryFindingCount(report),
  };
  if (report.qualityReport?.scores) {
    return applyGateThresholds(report.qualityReport, enriched);
  }
  return analysisQualityGateV1(report, enriched);
}

/** summary_rewrite 分流的最低 findings 数：C-3 起与两宿主完成阈值同源(Core 单源)。 */
const SUMMARY_REWRITE_MIN_FINDINGS = DIMENSION_COMPLETION_FLOOR.minKeyFindings;

function applyGateThresholds(qualityReport: QualityReport, options: GateOptions = {}): GateResult {
  const { totalScore } = qualityReport;
  const { scores } = qualityReport;
  const needsCandidates = options.outputType === 'dual' || options.outputType === 'candidate';
  const threshold = needsCandidates ? 60 : 45;
  const analysisAdequateForRecordRepair =
    scores.depthScore >= 40 && scores.breadthScore >= 35 && scores.coherenceScore >= 50;
  const recordRepairAction = analysisAdequateForRecordRepair ? 'record_repair' : 'analysis_retry';
  if (needsCandidates && qualityReport.suggestions.includes(REQUIRED_MEMORY_FINDING_SUGGESTION)) {
    return {
      pass: false,
      reason: REQUIRED_MEMORY_FINDING_SUGGESTION,
      action: recordRepairAction,
    };
  }
  if (
    needsCandidates &&
    qualityReport.suggestions.includes(INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION)
  ) {
    return {
      pass: false,
      reason: INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION,
      action: recordRepairAction,
    };
  }
  if (totalScore >= threshold) {
    return { pass: true };
  }
  if (totalScore >= threshold - 20) {
    // coherence 是唯一短板且证据面已满(典型：analyze 被超时打断，findings 都在 memory
    // 里但总结文本没写出来)——整段重挖是浪费，改走 summary_rewrite 纯写作重组。
    if (
      scores.coherenceScore < 50 &&
      scores.depthScore >= 40 &&
      scores.breadthScore >= 35 &&
      scores.evidenceScore >= 60 &&
      (options.memoryFindingCount ?? 0) >= SUMMARY_REWRITE_MIN_FINDINGS
    ) {
      return {
        pass: false,
        reason: `Coherence-only gap with adequate evidence (score ${totalScore}/${threshold}, findings=${options.memoryFindingCount})`,
        action: 'summary_rewrite',
      };
    }
    return {
      pass: false,
      reason: `Quality score ${totalScore}/${threshold}`,
      action: 'analysis_retry',
    };
  }
  return {
    pass: false,
    reason: `Quality score ${totalScore}/${threshold}`,
    action: 'degrade',
  };
}

function analysisQualityGateV1(report: GateableReport, options: GateOptions = {}): GateResult {
  const needsCandidates = options.outputType === 'dual' || options.outputType === 'candidate';
  const minChars = needsCandidates ? 400 : 200;
  const minFileRefs = needsCandidates ? 3 : 2;
  // V1 的「文本短/缺结构」同属写作类失败：findings 已记录充足时改走 summary_rewrite。
  const writingGapAction =
    (options.memoryFindingCount ?? 0) >= SUMMARY_REWRITE_MIN_FINDINGS
      ? ('summary_rewrite' as const)
      : ('analysis_retry' as const);

  if (report.analysisText.length < minChars) {
    return { pass: false, reason: 'Analysis too short', action: writingGapAction };
  }
  if (report.referencedFiles.length < minFileRefs) {
    return { pass: false, reason: 'Too few file references', action: 'analysis_retry' };
  }

  const refusalPatterns = [
    /I cannot|I'm unable|I don't have access/i,
    /无法分析|无法访问|没有足够/,
  ];
  if (refusalPatterns.some((p) => p.test(report.analysisText))) {
    return { pass: false, reason: 'Agent refused to analyze', action: 'degrade' };
  }

  const hasStructure =
    /#{1,3}\s/.test(report.analysisText) ||
    /\d+\.\s/.test(report.analysisText) ||
    /[-•]\s/.test(report.analysisText) ||
    /[：:].+\n/.test(report.analysisText) ||
    report.analysisText.length >= 500 ||
    (report.referencedFiles.length >= 3 && report.analysisText.length >= 200);
  if (!hasStructure) {
    return { pass: false, reason: 'Analysis lacks structure', action: writingGapAction };
  }

  return { pass: true };
}

// ──────────────────────────────────────────────────────────────────
// P4/C9 深度接地 retry 门 + F4g graph retry 门
// ──────────────────────────────────────────────────────────────────

/**
 * P4/C9: 对一次分析产物做「深度接地」审查(复用 Core reviewRecipeDepth，与 host 提交侧 depthGaps 字节同源)。
 * in-process 的接地集 = analyst 真读过/引用过的文件(artifact.referencedFiles)——「引用了你真读过的文件」
 * 即接地，与 host 侧「resolver 解析成功」同义。深度文本 = 分析正文 + 各 note_finding 的 evidence(C10 已把
 * 深度槽序列化成 `## <label>` 分节，reviewRecipeDepth 直接识别，无需自定义解析)。
 */
function reviewInsightDepth(artifact: Record<string, unknown>): DepthReviewResult {
  const findings = Array.isArray(artifact.findings)
    ? (artifact.findings as Array<{ evidence?: unknown }>)
    : [];
  const evidenceText = findings
    .map((f) => (typeof f.evidence === 'string' ? f.evidence : ''))
    .join('\n');
  const analysisText = typeof artifact.analysisText === 'string' ? artifact.analysisText : '';
  const validSourcePaths = Array.isArray(artifact.referencedFiles)
    ? (artifact.referencedFiles as unknown[]).filter((p): p is string => typeof p === 'string')
    : [];
  return reviewRecipeDepth({ markdown: `${analysisText}\n${evidenceText}` }, { validSourcePaths });
}

/**
 * P4/C9: 深度接地 retry 门。仅在候选生成(needsCandidates)且分析已充分(baseGate.pass)时启动——不影响纯分析
 * 或已失败的分析。核心口径：只有当深度确被「尝试」(analyst 填了 note_finding 深度槽 → 有 `## <label>` 分节
 * 或未接地论述)却接地核心维度不足 DEPTH_RETRY_MIN_GROUNDED_DIMS 时，才回炉重挖；没尝试深度的旧式分析
 * (attempted=false)不触发，避免回归。retry 只报缺口维度名 + 回 Analyst 段重挖，绝不提示补写具体内容(防编造)。
 * 无论是否 retry 都把接地维度写进 metadata 供观测。retry 次数由 pipeline 上限兜底，不会无限循环。
 */
export function applyDepthRetryGate(
  baseGate: GateResult,
  artifact: Record<string, unknown>,
  needsCandidates: boolean
): GateResult {
  if (!needsCandidates || !baseGate.pass) {
    return baseGate;
  }
  const depthReview = reviewInsightDepth(artifact);
  const groundedCore = depthReview.grounded.filter((k) => k !== 'multiSourceCorroboration');
  // 双轨(2026-07-02 用户决策)：自由叙述里的接地深度断言(groundedSignalCount)与小节维度
  // 覆盖取较高者——深挖写作不再被迫用 `## 四问小节` 组织。
  const groundedSignals =
    typeof (depthReview as { groundedSignalCount?: number }).groundedSignalCount === 'number'
      ? (depthReview as { groundedSignalCount: number }).groundedSignalCount
      : 0;
  const depthUnits = Math.max(groundedCore.length, groundedSignals);
  const attempted =
    depthReview.ungroundedClaims.length > 0 || groundedCore.length > 0 || groundedSignals > 0;
  (artifact as { metadata?: Record<string, unknown> }).metadata = {
    ...((artifact.metadata as Record<string, unknown>) || {}),
    depthGroundedDims: groundedCore,
    depthGroundedSignals: groundedSignals,
    depthGroundedFileCount: depthReview.groundedFileCount,
  };
  if (attempted && depthUnits < DEPTH_RETRY_MIN_GROUNDED_DIMS) {
    const missingLabels = depthReview.missing
      .filter((k) => k !== 'multiSourceCorroboration')
      .map((k) => DEPTH_DIMENSIONS.find((d) => d.key === k)?.label ?? k);
    // 自由叙述模式下缺口不再按维度名报(那会把作者推回四问模板)，改报通用深挖指令；
    // 仅当作者本就在用小节组织(groundedCore>0)时才报维度名帮助定位。
    const gapHint =
      groundedCore.length > 0
        ? missingLabels.join(' / ')
        : 'add grounded depth claims (cause/cost/exception/contrast, each with a real (来源: file:line))';
    // 深度断言缺口分流：findings 已充足=写作问题(把已验证发现组织成含接地深度断言的
    // 文本，summary_rewrite 单调用可修)；findings 不足=证据问题(必须回 analyze 重挖)。
    const action =
      getArtifactMemoryFindingCount(artifact) >= SUMMARY_REWRITE_MIN_FINDINGS
        ? 'summary_rewrite'
        : 'analysis_retry';
    return {
      pass: false,
      action,
      reason: `${DEPTH_GAP_REASON}: ${gapHint}`,
    };
  }
  return baseGate;
}

/**
 * C-7(2026-07-02 统一重构)：关系词表改为 Core 单源导出——此前是「本地同形副本」，
 * Core 收窄词表(20dae5e)时必须手动同步；现在 graph-retry 判定与 submit 门禁共用同一 RegExp。
 */
const GRAPH_RELATIONSHIP_CN_RE = RELATIONSHIP_CN_RE;

/** graph-retry 的 reason（buildRetryPrompt 会把它呈给 Analyst 作为重挖指令） */
const GRAPH_GAP_REASON =
  'Relationship claims lack graph backing: run ONE graph({ action: "query" }) on the core classes/modules you already identified, then re-summarize. Do not add new topics.';
