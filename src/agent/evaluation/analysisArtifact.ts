/**
 * analysisArtifact.ts — AnalysisReport(v1)/AnalysisArtifact(v2) 工件构建
 *
 * W6-d(A1)段级迁移自 src/agent/prompts/insightGate.ts(拆前基线 4fa4814):
 * - 输入类型 AnalystResult/ProjectGraphLike/ActiveContextLike/ToolCallArgsLike/
 *   RawFinding(原 :59-107)与 FILE_REF_RE(原 :171)
 * - sanitizeAnalysisText(原 :182)、extractFileRefs(原 :228)、
 *   splitMarkdownSections(原 :239)、shouldSkipDerivedFindingTitle(原 :252)、
 *   deriveFindingsFromAnalysisText(原 :256)、buildAnalysisReport(原 :297)
 * - createFsSnippetRangeReader(原 :418)、countSnippets(原 :444)、
 *   buildAnalysisArtifact(原 :452)
 *
 * 依赖走向:本文件持有 EvidenceCollector(evidence/)与 qualityGates 的评分器;
 * prompts/ 拆余不再反向依赖本文件。
 *
 * @module evaluation/analysisArtifact
 */

import fs from 'node:fs';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import {
  EvidenceCollector,
  type SnippetRangeReader,
  type ToolCall,
} from '../evidence/EvidenceCollector.js';
import { buildQualityScores, type NormalizedFinding } from './qualityGates.js';

// AD4: lazy logger accessor — the Core logger singleton materializes on first
// use instead of at module import (no import-time work; same singleton).
const logger = () => Logger.getInstance();

// ──────────────────────────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────────────────────────

/** Analyst 执行结果 */
export interface AnalystResult {
  reply?: string;
  toolCalls?: ToolCall[];
  tokenUsage?: unknown;
  reasoningQuality?: unknown;
}

/** ProjectGraph 最小接口 */
export interface ProjectGraphLike {
  getClassInfo(className: string): { filePath?: string } | null | undefined;
  getProtocolInfo(protocolName: string): { filePath?: string } | null | undefined;
}

/** ActiveContext 最小接口 */
export interface ActiveContextLike {
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
