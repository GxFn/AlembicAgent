/**
 * insightGate.ts — Insight 质量门控领域函数
 *
 * 从旧 HandoffProtocol.js 完整迁移的纯函数模块:
 * - 分析文本清洗 (sanitizeAnalysisText)
 * - AnalysisReport 构建 (v1)
 * - AnalysisArtifact 构建 (v2, 含 evidenceMap/findings/negativeSignals)
 * - 多维度质量评分 (buildQualityScores)
 * - 质量门控 (v1 + v2)
 * - 重试 Prompt 构建
 * - PipelineStrategy gate.evaluator 适配器 (insightGateEvaluator)
 *
 * 被 PipelineStrategy 的 bootstrap preset 直接引用。
 *
 * @module insightGate
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DEPTH_DIMENSIONS,
  type DepthReviewResult,
  DIMENSION_COMPLETION_FLOOR,
  RELATIONSHIP_CN_RE,
  reviewRecipeDepth,
} from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import {
  EvidenceCollector,
  type EvidenceCollectorResult,
  type SnippetRangeReader,
  type ToolCall,
} from '../domain/EvidenceCollector.js';
import { buildPcvQualityGateEvidence } from '../runtime/PcvNodeEvidenceRecorder.js';

// AD4: lazy logger accessor — the Core logger singleton materializes on first
// use instead of at module import (no import-time work; same singleton).
const logger = () => Logger.getInstance();

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
const DEPTH_GAP_REASON = 'Depth dimensions lack grounded evidence';

// ──────────────────────────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────────────────────────

/** Analyst 执行结果 */
interface AnalystResult {
  reply?: string;
  toolCalls?: ToolCall[];
  tokenUsage?: unknown;
  reasoningQuality?: unknown;
}

/** ProjectGraph 最小接口 */
interface ProjectGraphLike {
  getClassInfo(className: string): { filePath?: string } | null | undefined;
  getProtocolInfo(protocolName: string): { filePath?: string } | null | undefined;
}

/** ActiveContext 最小接口 */
interface ActiveContextLike {
  distill(): {
    keyFindings: RawFinding[];
    toolCallSummary: unknown[];
  };
}

/** 工具调用参数 (门控模块内部使用, V2 资源导向格式) */
interface ToolCallArgsLike {
  action?: string;
  params?: {
    path?: string;
    filePath?: string;
    filePaths?: string[];
    patterns?: string[];
    pattern?: string;
    query?: string;
    type?: string;
    entity?: string;
    [key: string]: unknown;
  };
  filePath?: string;
  pattern?: string;
  query?: string;
  className?: string;
  protocolName?: string;
  [key: string]: unknown;
}

/** 原始发现 (来自 ActiveContext.distill()) */
interface RawFinding {
  finding: string;
  evidence: string | string[] | unknown;
  importance: number;
}

/** 标准化发现 */
interface NormalizedFinding {
  finding: string;
  evidence: string;
  importance: number;
}

/** 多维度质量评分 */
interface QualityScores {
  depthScore: number;
  breadthScore: number;
  evidenceScore: number;
  coherenceScore: number;
}

/** 质量报告 */
interface QualityReport {
  scores: QualityScores;
  totalScore: number;
  suggestions: string[];
}

const REQUIRED_MEMORY_FINDING_SUGGESTION = 'Required note_finding calls are missing';
const INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION = 'At least 3 note_finding calls are required';

/** 门控选项 */
interface GateOptions {
  outputType?: string;
  /**
   * memory 中已验证 findings 数(artifact.metadata.memoryFindingCount)。
   * 打回动作分流依据：findings 充足时写作类失败走 summary_rewrite(纯写作重组，
   * 零工具单调用)，只有证据真缺时才走 analysis_retry(整段带工具重挖，最贵)。
   */
  memoryFindingCount?: number;
}

/** 门控结果 */
interface GateResult {
  pass: boolean;
  reason?: string;
  action?: 'analysis_retry' | 'record_repair' | 'summary_rewrite' | 'retry' | 'degrade';
}

/** 可进行门控评估的分析报告 */
interface GateableReport {
  analysisText: string;
  referencedFiles: string[];
  qualityReport?: QualityReport;
}

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

const FILE_REF_RE =
  /[\w/.-]+\.(?:go|mod|sum|py|pyi|java|kt|kts|js|ts|jsx|tsx|mjs|cjs|swift|m|h|c|cpp|cc|hpp|cs|rb|rs|sql|json|yaml|yml|toml|xml|html|css|scss|less|sh|md|txt|gradle|properties|proto|vue|svelte|graphql|cfg|conf|ini|env|lock|rst)\b/gi;

// ──────────────────────────────────────────────────────────────────
// AnalysisReport 构建
// ──────────────────────────────────────────────────────────────────

/**
 * 清理 Analyst 分析文本中可能泄漏的系统 nudge / graceful exit 指令。
 * 这些内容如果传给 Producer，会干扰其正常工作流。
 */
export function sanitizeAnalysisText(text: string) {
  if (!text) {
    return '';
  }
  const patterns = [
    /\*{0,2}⚠️?\s*(?:你已使用|轮次即将耗尽|仅剩|请立即停止|必须立即结束)[^\n]*\n?/gi,
    /\*{0,2}请立即停止所有工具调用[^\n]*\*{0,2}\n?/gi,
    /请在回复中直接输出\s*dimensionDigest\s*JSON[^\n]*\n?/gi,
    /> ?(?:remainingTasks|如果所有信号都已覆盖)[^\n]*\n?/gi,
    /> ?⚠️ 严禁输出任何非 JSON 内容[^\n]*\n?/gi,
    /```json\s*\n\s*\{\s*"dimensionDigest"\s*:[\s\S]*?\n```/g,
    /^-{2,3}\s*\n\s*第\s*\d+\/\d+\s*轮[^\n]*\n(-{2,3}\s*\n)?/gm,
    /^-{3}\s*$/gm,
    /^#{1,3}\s*(?:计划偏差分析|最终总结阶段|执行计划|下一步计划|分析计划)\s*\n[\s\S]*?(?=\n#{1,3}\s|\n\n(?=[^#\s-]))/gm,
    /^\(提示[:：][^)]*\)\s*\n?/gm,
    /^(?:Wait,|Let me|I'll stop here|I will stop|I need to|I should|I have enough)[^\n]*\n?/gm,
    /^[-•]\s*尝试使用\s*`[^`]+`[^\n]*\n?/gm,
    /^💡\s*提示[:：]?\s*\n?/gm,
    /^请(?:继续|接续)[。.]?\s*$/gm,
    /📊\s*中期反思\s*\([^)]*\):?\s*\n(?:[\s\S]*?(?=\n#{1,3}\s(?!探索计划|第\s*\d)|\n(?=📊)|$))/gm,
    /^你最近的思考方向:\s*\n(?:[\s\S]*?(?=\n#{1,3}\s(?!探索计划|第\s*\d)|\n(?=📊)|$))/gm,
    /^#{1,3}\s*探索计划\s*\n(?:[\s\S]*?(?=\n#{1,3}\s(?!探索计划)|\n\n(?=[^#\s\d-])|\n(?=📊)|$))/gm,
    /^\s*\d+\.\s+#{1,3}\s*探索计划[^\n]*\n(?:\d+\.\s+\*{0,2}[^\n]*\n?)*/gm,
    /^#{1,3}\s*第\s*\d+\s*轮[:：][^\n]*\n(?:[\s\S]*?(?=\n#{1,3}\s(?!探索计划|第\s*\d)|\n\n(?=#{1,3}\s)|\n(?=📊)|$))/gm,
    /^行动效率[:：][^\n]*\n?/gm,
    /^累计[:：]\s*\d+\s*文件[^\n]*\n?/gm,
    /^📋\s*计划进度[:：][^\n]*\n?/gm,
    /^请评估[:：]\s*\n(?:\s*\d+\.\s+[^\n]*\n?)*/gm,
    /^\([请由注](?:在继续|于当前|意[:：])[^)]*\)\s*\n?/gm,
    /^(?:\d+\.\s+)?(?:`[^`]*`\s+)?(?:已经读取|未完成步骤仅剩|计划更新|更新后的计划)[^\n]*\n?/gm,
    /^更新后的计划[:：]\s*\n(?:\s*\d+\.\s+[^\n]*\n?)*/gm,
    /^\s*\d+\.\s*$/gm,
    /^>\s*(?:searchHints|remainingTasks|candidateCount|crossRefs|keyFindings|gaps)\s*[:：][^\n]*\n?/gm,
    /^\*{0,2}(?:请在|请直接|请确保|请务必|现在开始|输出你的|不要输出|不要再|不要包含)\s*[^。\n]*(?:分析文本|分析总结|分析报告|JSON|工具|输出|文本|报告)[^。\n]*[。.]?\s*\*{0,2}$/gm,
    /^\*{0,2}重要\s*[：:][^。\n]*\*{0,2}$/gm,
    /^注意[：:]\s*到达第\s*\d+\s*轮时[^\n]*$/gm,
    /^第\s*\d+\/\d+\s*轮\s*\|[^\n]*$/gm,
  ];
  let cleaned = text;
  for (const pat of patterns) {
    cleaned = cleaned.replace(pat, '');
  }
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

function extractFileRefs(text: string) {
  const refs = new Set<string>();
  for (const match of text.match(FILE_REF_RE) || []) {
    const clean = match.trim();
    if (clean.length > 2 && clean.length < 120) {
      refs.add(clean);
    }
  }
  return [...refs];
}

function splitMarkdownSections(text: string) {
  const headings = [...text.matchAll(/^#{2,4}\s+(.+)$/gm)];
  return headings.map((match, index) => {
    const start = match.index ?? 0;
    const bodyStart = start + match[0].length;
    const nextStart = headings[index + 1]?.index ?? text.length;
    return {
      title: match[1].replace(/[`*_]/g, '').trim(),
      body: text.slice(bodyStart, nextStart).trim(),
    };
  });
}

function shouldSkipDerivedFindingTitle(title: string) {
  return /^(?:待探索|总结|结论|概览|项目概览|分析报告|探索计划|执行计划)$/i.test(title.trim());
}

function deriveFindingsFromAnalysisText(
  analysisText: string,
  knownReferencedFiles: string[]
): NormalizedFinding[] {
  const knownFiles = new Set(knownReferencedFiles);
  const findings: NormalizedFinding[] = [];

  for (const section of splitMarkdownSections(analysisText)) {
    const title = section.title.replace(/^\d+(?:\.\d+)*[、.)\s-]*/, '').trim();
    if (!title || shouldSkipDerivedFindingTitle(title)) {
      continue;
    }

    const fileRefs = extractFileRefs(section.body).filter(
      (ref) => knownFiles.size === 0 || knownFiles.has(ref)
    );
    if (fileRefs.length === 0) {
      continue;
    }

    findings.push({
      finding: title,
      evidence: fileRefs.slice(0, 3).join(', '),
      importance: Math.min(10, 5 + fileRefs.length),
    });

    if (findings.length >= 5) {
      break;
    }
  }

  return findings;
}

/**
 * 从 Analyst 的执行结果构建 AnalysisReport (v1)
 *
 * @param analystResult { reply, toolCalls }
 * @param dimensionId 维度 ID
 * @param [projectGraph] ProjectGraph 实例
 */
export function buildAnalysisReport(
  analystResult: AnalystResult,
  dimensionId: string,
  projectGraph: ProjectGraphLike | null = null
) {
  const referencedFiles = new Set<string>();
  const searchQueries: string[] = [];
  const classesExplored: string[] = [];

  for (const call of analystResult.toolCalls || []) {
    const tool = call.tool || call.name;
    const args: ToolCallArgsLike = call.params || call.args || {};
    const result = call.result;

    switch (tool) {
      case 'code': {
        const p = args.params || args;
        if (args.action === 'read') {
          const fp = p.path || p.filePath || (args as ToolCallArgsLike).filePath;
          if (fp && typeof fp === 'string') {
            referencedFiles.add(fp);
          }
          if (Array.isArray(p.filePaths)) {
            for (const f of p.filePaths) {
              referencedFiles.add(f);
            }
          }
        } else if (args.action === 'search') {
          const pat =
            p.pattern ||
            p.query ||
            (args as ToolCallArgsLike).pattern ||
            (args as ToolCallArgsLike).query;
          if (pat) {
            searchQueries.push(pat as string);
          }
          if (typeof result === 'string') {
            // 扩展名组后必须收 \b：否则 alternation 里 `m` 排在 `md` 前，`findings.md:120`
            // 会被截成 `findings.m`（真机 SOURCE_REF_NOT_FOUND ×8 的来源——模型照抄了截断路径）。
            const fileMatches = result.match(
              /(?:^|\n)([\w/.-]+\.(?:go|mod|sum|py|pyi|java|kt|kts|js|ts|jsx|tsx|mjs|cjs|swift|m|h|c|cpp|cc|hpp|cs|rb|rs|sql|json|yaml|yml|toml|xml|html|css|scss|less|sh|md|txt|gradle|properties|proto|vue|svelte|graphql|cfg|conf|ini|env|lock|rst)\b)(?::\d+)?/gi
            );
            if (fileMatches) {
              for (const m of fileMatches) {
                const clean = m.trim().replace(/:\d+$/, '').replace(/^\n/, '');
                if (clean.length > 2 && clean.length < 120) {
                  referencedFiles.add(clean);
                }
              }
            }
          }
        }
        break;
      }
      case 'graph': {
        const p = args.params || args;
        const entity =
          p.entity ||
          (args as ToolCallArgsLike).className ||
          (args as ToolCallArgsLike).protocolName;
        if (entity && typeof entity === 'string') {
          classesExplored.push(entity);
          if (projectGraph) {
            const info = projectGraph.getClassInfo(entity) || projectGraph.getProtocolInfo(entity);
            if (info?.filePath) {
              referencedFiles.add(info.filePath);
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // 从分析文本中提取文件路径
  const text = sanitizeAnalysisText(analystResult.reply || '');
  for (const f of extractFileRefs(text)) {
    referencedFiles.add(f);
  }

  return {
    analysisText: text,
    referencedFiles: [...referencedFiles],
    searchQueries,
    classesExplored,
    dimensionId,
    metadata: {
      iterations: analystResult.toolCalls?.length || 0,
      toolCallCount: analystResult.toolCalls?.length || 0,
      tokenUsage: analystResult.tokenUsage || null,
      reasoningQuality: analystResult.reasoningQuality || null,
    },
  };
}

// ──────────────────────────────────────────────────────────────────
// AnalysisArtifact 构建 (v2)
// ──────────────────────────────────────────────────────────────────

/**
 * 从 Analyst 执行结果构建 AnalysisArtifact (v2 增强版)
 *
 * 在 v1 AnalysisReport 基础上增加:
 * - evidenceMap: 文件 → 代码片段 + 摘要
 * - explorationLog: 工具调用意图 + 结果摘要序列
 * - negativeSignals: 搜索但未找到的模式
 * - findings: 来自 ActiveContext 的结构化发现
 * - qualityReport: 多维度质量评分
 *
 * @param analystResult { reply, toolCalls }
 * @param dimensionId 维度 ID
 * @param [projectGraph] ProjectGraph 实例
 * @param [activeContext] ActiveContext 实例
 */
/**
 * projectRoot 内的只读行范围端口（R1 锚点补齐用）。逐字读取 [startLine, endLine] 源码，
 * endLine 超文件末尾时收缩为实际末行；相对路径逃逸 / 绝对路径 / 文件缺失返回 null——
 * 绝不让补齐流程读到项目外内容或编造证据。
 */
function createFsSnippetRangeReader(projectRoot: string): SnippetRangeReader {
  return (filePath, startLine, endLine) => {
    try {
      const normalized = path.posix.normalize(String(filePath).replaceAll('\\', '/'));
      if (path.isAbsolute(normalized) || normalized.startsWith('..')) {
        return null;
      }
      const absPath = path.join(projectRoot, normalized);
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        return null;
      }
      const lines = fs.readFileSync(absPath, 'utf-8').split('\n');
      if (startLine < 1 || startLine > lines.length) {
        return null;
      }
      const effectiveEnd = Math.min(endLine, lines.length);
      const content = lines.slice(startLine - 1, effectiveEnd).join('\n');
      return content.trim() ? { content, endLine: effectiveEnd } : null;
    } catch {
      // 只读补齐失败静默跳过：证据缺失优于错误证据。
      return null;
    }
  };
}

/** 统计 collector 当前片段总数（锚点补齐前后对照用） */
function countSnippets(collector: EvidenceCollector): number {
  let total = 0;
  for (const entry of collector.build().evidenceMap.values()) {
    total += entry.codeSnippets.length;
  }
  return total;
}

export function buildAnalysisArtifact(
  analystResult: AnalystResult,
  dimensionId: string,
  projectGraph: ProjectGraphLike | null = null,
  activeContext: ActiveContextLike | null = null,
  opts: { projectRoot?: string } = {}
) {
  const toolCalls = analystResult.toolCalls || [];

  const baseReport = buildAnalysisReport(analystResult, dimensionId, projectGraph);

  const collector = new EvidenceCollector();
  for (let i = 0; i < toolCalls.length; i++) {
    collector.processToolCall(toolCalls[i], i);
  }

  const distilled = activeContext?.distill() || { keyFindings: [], toolCallSummary: [] };
  const memoryFindingCount = distilled.keyFindings.length;
  let derivedFindingCount = 0;
  let findings = distilled.keyFindings.map((f: RawFinding) => ({
    finding: f.finding,
    evidence:
      typeof f.evidence === 'string'
        ? f.evidence
        : Array.isArray(f.evidence)
          ? f.evidence.join(', ')
          : f.evidence
            ? String(f.evidence)
            : '',
    importance: f.importance,
  }));
  if (findings.length === 0) {
    // 降级路径基于 referencedFiles 派生（evidenceMap keys 在此场景与其同源，见下方 allFiles 合并）。
    findings = deriveFindingsFromAnalysisText(baseReport.analysisText, [
      ...new Set(baseReport.referencedFiles),
    ]);
    derivedFindingCount = findings.length;
  }

  // R1 锚点驱动证据补齐：findings 引用的 path:line 锚点若不在已采片段覆盖内（典型：全文读
  // 只留头 30 行窗口，锚点在窗口外），从磁盘补读精确片段——每条发现都有可照抄的逐字证据。
  if (opts.projectRoot) {
    const beforeSnippets = countSnippets(collector);
    collector.groundFindingRefs(findings, createFsSnippetRangeReader(opts.projectRoot));
    const afterSnippets = countSnippets(collector);
    const anchoredFindings = findings.filter(
      (f) => typeof f.evidence === 'string' && /\.[A-Za-z]\w*:\d+/.test(f.evidence)
    ).length;
    // 残余根因分辨日志：anchored=0 → Analyst 没写行号锚（依从性缺口在上游）；
    // anchored>0 且 grounded=0 → 锚点路径解析失败；grounded>0 仍被拒 → Producer 没照抄。
    logger().info(
      `[AnalysisArtifact] anchor grounding: findings=${findings.length}, anchored=${anchoredFindings}, groundedSnippets=+${afterSnippets - beforeSnippets} (dim=${dimensionId})`
    );
  }

  const evidence = collector.build();

  const allFiles = new Set(baseReport.referencedFiles);
  for (const filePath of evidence.evidenceMap.keys()) {
    allFiles.add(filePath);
  }

  const qualityReport = buildQualityScores(baseReport.analysisText, findings, evidence, {
    memoryFindingCount,
    derivedFindingCount,
  });

  return {
    // Layer 1: Core
    analysisText: baseReport.analysisText,
    findings,
    referencedFiles: [...allFiles],
    dimensionId,

    // Layer 2: Detail
    evidenceMap: evidence.evidenceMap,
    explorationLog: evidence.explorationLog,
    negativeSignals: evidence.negativeSignals,
    // R2: Analyst 真实 graph 查询的可复制 refs（Producer 渲染，供关系声明过 GRAPH_REF 门禁）
    graphEvidence: evidence.graphEvidence,

    // Layer 3: Raw
    fullToolTrace: toolCalls,

    // Quality
    qualityReport,

    // Metadata
    metadata: {
      ...baseReport.metadata,
      artifactVersion: 2,
      memoryFindingCount,
      derivedFindingCount,
    },

    // v1 backward compat
    searchQueries: baseReport.searchQueries,
    classesExplored: baseReport.classesExplored,
  };
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
function buildQualityScores(
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

/**
 * 构建重试提示
 *
 * @param reason Gate 失败原因
 */
export function buildRetryPrompt(reason: string) {
  // P4/C9: 深度缺口分支——回炉到有代码工具的 Analyst 段重挖，绝不提示补写具体内容(防诱导编造)。
  if (reason.startsWith(DEPTH_GAP_REASON)) {
    const missing = reason
      .slice(DEPTH_GAP_REASON.length)
      .replace(/^[:：]\s*/, '')
      .trim();
    return (
      `以下深度维度缺少真实代码接地${missing ? `：${missing}` : ''}。` +
      '不要凭空补写、不要改措辞充数——回到分析(Analyst)段，用 code({ action: "read" }) / graph({ action: "query" }) ' +
      '回到相关实现，为缺接地的维度找到真实 file:line 证据；确认后用 note_finding 的深度槽' +
      '(designIntent/boundaries/failureModes/tradeoffs)记录，每条必须挂真实 file:line。读不到真实证据的维度就留空。'
    );
  }
  const hints = {
    'Analysis too short':
      '你的分析不够深入。请使用更多工具（graph({ action: "query" })、code({ action: "read" })、code({ action: "search" })）查看实际代码，输出至少 500 字的分析。',
    'Too few file references':
      '你的分析缺少代码引用。请使用 graph({ action: "query" }) 和 code({ action: "read" }) 查看至少 3 个相关文件，并在分析中引用具体文件和行号。',
    'Analysis lacks structure':
      '请将分析组织成结构化的段落，使用编号列表或标题来区分不同的发现。每个发现应包含具体的文件路径和代码位置。',
    [REQUIRED_MEMORY_FINDING_SUGGESTION]:
      '上一轮没有形成可验收的结构化证据记录。不要直接写总结；先用 code({ action: "structure" }) / code({ action: "search" }) / graph({ action: "query" }) 定位相关实现，再用 code({ action: "read" }) 验证至少 3 个文件；每确认一个核心发现就调用 note_finding({ finding, evidence, importance })，evidence 必须包含完整相对路径和行号，最后再输出报告。',
    [INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION]:
      '结构化发现数量不足。先检查已有证据是否覆盖至少 3 个真实文件；如证据不足，继续用 code({ action: "read" }) 验证关键实现；随后调用 note_finding({ finding, evidence, importance }) 补齐到至少 3 个核心发现，每个 evidence 必须包含完整相对路径和行号，然后再输出最终报告。',
  };

  return (
    (hints as Record<string, string>)[reason] ||
    '请更深入地分析代码，引用至少 3 个具体文件，每个发现都要有代码证据。'
  );
}

function stringifyRecordRepairEvidenceMap(evidenceMap: unknown) {
  if (!evidenceMap) {
    return '';
  }
  const entries =
    evidenceMap instanceof Map
      ? [...evidenceMap.entries()]
      : Object.entries(evidenceMap as Record<string, unknown>);
  return entries
    .slice(0, 12)
    .map(([filePath, value]) => {
      const record = value as { summary?: string; codeSnippets?: Array<{ line?: number }> };
      const lines =
        Array.isArray(record?.codeSnippets) && record.codeSnippets.length > 0
          ? record.codeSnippets
              .slice(0, 3)
              .map((snippet) =>
                typeof snippet.line === 'number' ? `${String(filePath)}:${snippet.line}` : null
              )
              .filter(Boolean)
              .join(', ')
          : String(filePath);
      return `- ${lines}${record?.summary ? ` — ${record.summary}` : ''}`;
    })
    .filter(Boolean)
    .join('\n');
}

function getArtifactMemoryFindingCount(artifact: unknown) {
  const metadata = (artifact as { metadata?: Record<string, unknown> } | null)?.metadata || {};
  const count = metadata.memoryFindingCount;
  return typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

/**
 * 构建 record-only 结构化发现补写提示。
 *
 * 该阶段只允许补齐 note_finding，不再读取代码、图谱或终端。
 */
export function buildRecordRepairPrompt({
  reason = '',
  artifact,
  minFindings = 3,
}: {
  reason?: string;
  artifact?: unknown;
  minFindings?: number;
}) {
  const record = (artifact || {}) as {
    analysisText?: string;
    findings?: NormalizedFinding[];
    referencedFiles?: string[];
    evidenceMap?: unknown;
  };
  const memoryFindingCount = getArtifactMemoryFindingCount(artifact);
  const missing = Math.max(1, minFindings - memoryFindingCount);
  const files = Array.isArray(record.referencedFiles) ? record.referencedFiles.slice(0, 30) : [];
  const existingFindings = Array.isArray(record.findings) ? record.findings.slice(0, 8) : [];
  const evidenceMapText = stringifyRecordRepairEvidenceMap(record.evidenceMap);

  return `QualityGate 判定上一轮分析已经具备可记录发现，但结构化 note_finding 不足。

失败原因: ${reason || 'missing note_finding records'}
当前已记录结构化发现: ${memoryFindingCount}
本阶段至少补写: ${missing} 条

硬性规则:
- 只调用 note_finding({ finding, evidence, importance })
- 每次工具调用只记录一条发现，直到补齐至少 ${minFindings} 条结构化发现
- evidence 必须来自下面的已验证文件路径或证据摘要，并尽量包含行号
- 禁止调用 code、graph、terminal、knowledge 或任何探索/提交工具
- 不要把 Markdown 正文当作完成结果
- 如果无法调用 note_finding，本阶段必须失败并回到调用链修复；不要输出 JSON、Markdown 或其它替代格式

已验证文件:
${files.length > 0 ? files.map((file) => `- ${file}`).join('\n') : '- （无显式文件清单，请只使用分析正文中出现的文件路径）'}

已有发现摘要:
${
  existingFindings.length > 0
    ? existingFindings
        .map((finding) => `- [${finding.importance}/10] ${finding.finding} — ${finding.evidence}`)
        .join('\n')
    : '- （当前没有结构化发现）'
}

证据摘要:
${evidenceMapText || '- （无 evidenceMap，使用分析正文中的文件路径和行号）'}

分析正文（只读依据，不要继续探索）:
${String(record.analysisText || '').slice(0, 8000)}`;
}

/**
 * 构建 summary-rewrite 纯写作重组提示。
 *
 * 触发前提：证据面已达标(findings/文件引用充足)，只有分析写作不过门(文本短、缺结构、
 * 缺接地深度断言——典型是 analyze 超时打断总结)。该阶段零工具、单次调用：把已验证发现
 * 组织成结构化深度分析文本，成本是整段 analysis_retry 重挖的零头。
 * 防编造与 record_repair 同一立场：引用只可来自下方注入的已验证文件/证据，禁止新增。
 */
export function buildSummaryRewritePrompt(options: {
  reason: string;
  artifact: Record<string, unknown> | null | undefined;
}) {
  const record = (options.artifact || {}) as {
    analysisText?: unknown;
    findings?: Array<{ finding?: unknown; evidence?: unknown; importance?: unknown }>;
    referencedFiles?: unknown[];
  };
  const findings = Array.isArray(record.findings) ? record.findings.slice(0, 24) : [];
  const files = Array.isArray(record.referencedFiles)
    ? record.referencedFiles.filter((f): f is string => typeof f === 'string').slice(0, 30)
    : [];
  const prevText = String(record.analysisText || '').slice(0, 2000);

  return `QualityGate 判定你的探索证据已经达标（${findings.length} 条已验证发现），唯一不通过的是分析写作本身。

失败原因: ${options.reason || 'analysis text too short or lacks grounded depth claims'}

本阶段是纯写作重组，不是重新分析:
- 只根据下方「已验证发现」和「已验证文件」写出完整的结构化深度分析
- 用 ## 小节组织；每个核心论断句内带 (来源: 文件路径:行号)
- 引用只能使用下方发现/文件中出现的路径与行号，禁止引入任何新文件、新行号、新事实
- 写出深度：解释为什么这样设计(因果)、代价/权衡、边界或例外，各自落在真实来源上
- 全文不少于 600 字中文；直接输出分析全文，不要解释这次重写

已验证发现:
${
  findings.length > 0
    ? findings
        .map(
          (f) =>
            `- [${f.importance ?? '?'}/10] ${String(f.finding ?? '')} — ${String(f.evidence ?? '')}`
        )
        .join('\n')
    : '-（无结构化发现，使用下方文件与上一稿正文）'
}

已验证文件:
${files.length > 0 ? files.map((file) => `- ${file}`).join('\n') : '-（使用上一稿正文中出现的路径）'}

上一稿正文（可吸收其内容，但必须重写扩充）:
${prevText || '（上一稿为空）'}`;
}

// ──────────────────────────────────────────────────────────────────
// PipelineStrategy gate.evaluator 适配器
// ──────────────────────────────────────────────────────────────────

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

/**
 * F4g graph-retry 门（与 depth-retry 同模式）：候选生成维度的分析含关系词（依赖/分层/调用），
 * 但本会话没有任何真实 graph 查询（graphEvidence 空）时，回炉一次补 graph——它是关系声明过
 * GRAPH_REF 门禁的唯一诚实背书（F4e 只注入真实查询产物，绝不合成）。七轮真机证明动机提示
 * 不足以让 DeepSeek 主动调 graph；把它变成 QualityGate 判据后 retry 指令单一明确。
 * retry 次数由 pipeline 上限兜底，不会无限循环。
 */
export function applyGraphRetryGate(
  baseGate: GateResult,
  artifact: Record<string, unknown>,
  needsCandidates: boolean,
  sharedState: Record<string, unknown> | null = null
): GateResult {
  if (!needsCandidates || !baseGate.pass) {
    return baseGate;
  }
  const graphEvidence = (artifact as { graphEvidence?: string[] }).graphEvidence;
  if (Array.isArray(graphEvidence) && graphEvidence.length > 0) {
    return baseGate;
  }
  // 单次尝试后放行：第 8 轮真机证明 DeepSeek 对明确 retry 指令仍不调 graph——反复 retry 只会
  // 烧穿配额把维度整体卡成 error（比 GRAPH 拒绝更糟）。补挖一次未果就放行 produce，关系类
  // 候选交由 submit 拒绝反馈（改述指导），非关系类候选照常通过。
  const retried = Number(sharedState?._graphRetryCount) || 0;
  if (retried >= 1) {
    return baseGate;
  }
  const analysisText = typeof artifact.analysisText === 'string' ? artifact.analysisText : '';
  const findingsText = Array.isArray(artifact.findings)
    ? (artifact.findings as Array<{ finding?: string }>).map((f) => f?.finding ?? '').join(' ')
    : '';
  if (!GRAPH_RELATIONSHIP_CN_RE.test(`${analysisText} ${findingsText}`)) {
    return baseGate;
  }
  if (sharedState) {
    sharedState._graphRetryCount = retried + 1;
  }
  return { pass: false, action: 'analysis_retry', reason: GRAPH_GAP_REASON };
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
  // F4g graph-retry 已停用（保留函数供未来模型再评估）：沙箱第 8/9 轮实测 DeepSeek 对明确
  // retry 指令仍不调 graph，retry 只会把维度拖成 error（比 GRAPH 拒绝更糟）。关系声明的
  // graph 背书走 F4e 注入（Analyst 恰好调了 graph 时），否则由 submit 拒绝反馈改述。
  const gate = applyDepthRetryGate(
    analysisQualityGate(artifact, {
      outputType: needsCandidates ? 'candidate' : outputType || 'analysis',
    }),
    artifact as Record<string, unknown>,
    Boolean(needsCandidates)
  );
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
// 类型定义 (JSDoc)
// ──────────────────────────────────────────────────────────────────
