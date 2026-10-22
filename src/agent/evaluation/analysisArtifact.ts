/** 分析报告与工件装配：规范化工具事实、保留文本引用、补齐受限源码锚点并计算质量分。
 * 只服务 legacy（insight/scan）分析门；严格冷启动由阶段配置与宿主编排承担，不经过本模块
 * （审阅包 L6-P27 / L7-P27 C45：工件不再接收或透传严格分析上下文投影）。 */

import fs from 'node:fs';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { resolveProjectPath } from '#shared/projectPath.js';
import { NUDGE_DIRECTIVE_TEXTS } from '../context/exploration/NudgeGenerator.js';
import {
  EvidenceCollector,
  type SnippetRangeReader,
  type ToolCall,
} from '../evidence/EvidenceCollector.js';
import { readToolObservation, successfulReadPaths } from '../utils/toolOutcomes.js';
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

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 反思 nudge（NudgeGenerator #checkReflection）的固定收尾句。原始回显（未经 cleanFinalAnswer）里块在
 * 这句之后结束。直接引用注入侧同一份原句，文案改动时清理规则自动同步。
 *
 * 注意：生产链上这句话通常已经不在了——AgentRuntime 以 cleanFinalAnswer(llmResult.text) 作为最终答复，
 * cleanFinalAnswer 按 NUDGE_DIRECTIVE_TEXTS 逐行删掉这类指令回显，gateEvaluators 再把清理后的答复交给
 * buildAnalysisArtifact。因此块的终止绝不能只靠这句话，见下方 REFLECTION_BLOCK_STOP。
 */
const REFLECTION_BLOCK_END = escapeRegExp(NUDGE_DIRECTIVE_TEXTS.noCopyReflection);

/**
 * 反思模板里能作为段落首行的行：思考方向 / 行动效率 / 累计 / 计划进度 / 评估问题的引导行，以及防复制
 * 收尾句。反思块内部的每个段落都以其中之一开头（NudgeGenerator #checkReflection 的 parts 拼接）。
 */
const REFLECTION_PARAGRAPH_HEAD = String.raw`(?:你最近的思考方向|行动效率|累计|请评估)[:：]|📋\s*计划进度|${REFLECTION_BLOCK_END}`;

/** 反思模板段落内部的续行：缩进的思考方向条目（`  1. …`）与编号的评估问题（`1. …`）。 */
const REFLECTION_CONTINUATION_LINE = String.raw`[ \t]+\S|\d+\.\s`;

/**
 * 反思块 / 思考方向块的终止条件（L7-P16/C06 防过度清理）。惰性块体在最早满足下列任一条件处结束：
 *   1. 防复制收尾句（原始回显）：连同这句一起删除后结束；
 *   2. 下一行不是模板行（不是空行、段落引导行或段落续行）：真实标题、下一个 📊 块、正文行都在这里
 *      截断，包括紧跟在块后、没有空行分隔的正文；
 *   3. 空行之后的段落不以模板引导行开头：编号列表、缩进内容等 Analyst 自己的段落在这里截断
 *      （模板里编号 / 缩进行只出现在段落内部，从不作为段落首行）；
 *   4. 文本结尾（不用 m 模式下的 `$`，否则惰性匹配停在第一个行尾）。
 * 空行判定容忍 `\r`（CRLF 文本里的空行是 `\r\n`），与标题行尾的 `[ \t\r]*` 一致。
 * 这些条件只会让块变短：模型改写过的回显最多残留噪声（单行规则还会再清一遍模板行），
 * 不会把块后的真实分析一并删掉。
 */
const REFLECTION_BLOCK_STOP = String.raw`(?:${REFLECTION_BLOCK_END}|(?=\n(?![ \t\r]*\n|${REFLECTION_PARAGRAPH_HEAD}|${REFLECTION_CONTINUATION_LINE})|\n[ \t\r]*\n(?![ \t\r]*\n|${REFLECTION_PARAGRAPH_HEAD})|(?![\s\S])))`;

/**
 * 清理 Analyst 分析文本中可能泄漏的系统 nudge / graceful exit 指令。
 * 这些内容如果传给 Producer，会干扰其正常工作流。
 *
 * 多行块规则的终止条件（L7-P16/C06）：块正则保留 m 标志只为让 `^` 锚定行首；“文本结尾”必须写成
 * `(?![\s\S])`——m 模式下 `$` 在每个行尾都成立，惰性的 `[\s\S]*?` 会停在块的第一个行尾，只删首行。
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
    // 计划类小节：到下一个标题、空行后的正文段落，或文本结尾（位于结尾的计划小节此前完全不删）。
    /^#{1,3}\s*(?:计划偏差分析|最终总结阶段|执行计划|下一步计划|分析计划)\s*\n[\s\S]*?(?=\n#{1,3}\s|\n\n(?=[^#\s-])|(?![\s\S]))/gm,
    /^\(提示[:：][^)]*\)\s*\n?/gm,
    /^(?:Wait,|Let me|I'll stop here|I will stop|I need to|I should|I have enough)[^\n]*\n?/gm,
    /^[-•]\s*尝试使用\s*`[^`]+`[^\n]*\n?/gm,
    /^💡\s*提示[:：]?\s*\n?/gm,
    /^请(?:继续|接续)[。.]?\s*$/gm,
    // 反思块（周期的中期反思与停滞反思，同出 NudgeGenerator #checkReflection）：标题行只吃到行尾，
    // 块体按 REFLECTION_BLOCK_STOP 结束——生产输入已被 cleanFinalAnswer 删掉防复制收尾句，块必须能在
    // 模板之后的第一处非模板内容停下，块后的无标题正文（Analyst 提示词允许不带格式）原样保留。
    new RegExp(
      String.raw`📊[ \t]*(?:中期|停滞)反思[ \t]*\([^)\n]*\)[:：]?[ \t\r]*(?=\n|(?![\s\S]))[\s\S]*?${REFLECTION_BLOCK_STOP}`,
      'gm'
    ),
    // 只回显“你最近的思考方向”段落时同样按 REFLECTION_BLOCK_STOP 结束。
    new RegExp(
      String.raw`^你最近的思考方向:[ \t\r]*(?=\n|(?![\s\S]))[\s\S]*?${REFLECTION_BLOCK_STOP}`,
      'gm'
    ),
    /^#{1,3}\s*探索计划\s*\n(?:[\s\S]*?(?=\n#{1,3}\s(?!探索计划)|\n\n(?=[^#\s\d-])|\n(?=📊)|(?![\s\S])))/gm,
    /^\s*\d+\.\s+#{1,3}\s*探索计划[^\n]*\n(?:\d+\.\s+\*{0,2}[^\n]*\n?)*/gm,
    // 轮次小节：与探索计划小节同口径，空行后的正文段落也是终止点，结尾的轮次小节不会吞掉其后的正文。
    /^#{1,3}\s*第\s*\d+\s*轮[:：][^\n]*\n(?:[\s\S]*?(?=\n#{1,3}\s(?!探索计划|第\s*\d)|\n\n(?=#{1,3}\s)|\n\n(?=[^#\s\d-])|\n(?=📊)|(?![\s\S])))/gm,
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

/** 文本派生 findings 的诊断计数（只进日志，不进入工件返回值）。 */
interface DerivedFindingStats {
  /** 参与派生判定的小节数（不含按标题跳过的小节）。 */
  sections: number;
  /** 这些小节正文里提及的文件引用数（同一小节内去重）。 */
  mentionedRefs: number;
  /** 不在接地集合里、被过滤掉的提及数（只提及未读取的文件）。 */
  filteredMentions: number;
  /** 有文件提及但没有任何接地引用、因而不派生的小节数。 */
  sectionsWithoutGroundedRef: number;
}

/**
 * 降级派生：Analyst 没有记 note_finding 时，把“标题 + 正文引用了已接地文件”的 Markdown 小节投影成
 * findings。接地原则（L7-P16/C07）：只认派生前的接地集合——真实读取并在 evidenceMap 留下片段的文件；
 * 正文提及不是证据，接地集合为空时一条都不派生（此前 knownFiles 为空即全部放行，且已知集合来自含
 * 正文提及的 referencedFiles，过滤恒真）。evidence 只列接地文件，被过滤的提及数进入 stats 供诊断日志。
 */
function deriveFindingsFromAnalysisText(
  analysisText: string,
  groundedFiles: ReadonlySet<string>
): { findings: NormalizedFinding[]; stats: DerivedFindingStats } {
  const findings: NormalizedFinding[] = [];
  const stats: DerivedFindingStats = {
    sections: 0,
    mentionedRefs: 0,
    filteredMentions: 0,
    sectionsWithoutGroundedRef: 0,
  };

  for (const section of splitMarkdownSections(analysisText)) {
    const title = section.title.replace(/^\d+(?:\.\d+)*[、.)\s-]*/, '').trim();
    if (!title || shouldSkipDerivedFindingTitle(title)) {
      continue;
    }
    stats.sections += 1;

    const mentioned = extractFileRefs(section.body);
    const fileRefs = mentioned.filter((ref) => groundedFiles.has(ref));
    stats.mentionedRefs += mentioned.length;
    stats.filteredMentions += mentioned.length - fileRefs.length;
    if (fileRefs.length === 0) {
      if (mentioned.length > 0) {
        stats.sectionsWithoutGroundedRef += 1;
      }
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

  return { findings, stats };
}

/**
 * 派生降级路径的诊断日志：派生条数、接地集合大小与被过滤的提及。接地集合为空时标
 * skipped=no-grounded-files（无接地不派生），有接地但没有小节引用它时标 skipped=no-grounded-mentions。
 * 派生 findings 只是文本投影，buildQualityScores 不给它们 evidence / coherence 加分。
 */
function reportDerivedFindings(
  stats: DerivedFindingStats,
  derivedCount: number,
  groundedFileCount: number,
  dimensionId: string
) {
  const skipped =
    groundedFileCount === 0
      ? ', skipped=no-grounded-files'
      : derivedCount === 0
        ? ', skipped=no-grounded-mentions'
        : '';
  observeSafely(
    () =>
      logger().info(
        `[AnalysisArtifact] derived findings: derived=${derivedCount}, groundedFiles=${groundedFileCount}, ` +
          `sections=${stats.sections}, mentionedRefs=${stats.mentionedRefs}, ` +
          `filteredMentions=${stats.filteredMentions}, ` +
          `sectionsWithoutGroundedRef=${stats.sectionsWithoutGroundedRef}${skipped} (dim=${dimensionId})`
      ),
    () => undefined
  );
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
  return buildReportFromEvidence(
    analystResult,
    dimensionId,
    projectGraph,
    collectToolEvidence(analystResult.toolCalls || [], dimensionId)
  );
}

/** Collector 采集诊断快照（只在本模块用于日志，不进入报告 / 工件返回值）。 */
type CollectorDiagnostics = ReturnType<EvidenceCollector['diagnostics']>;

/** 采集诊断日志里最多列出的提取异常条数（其余只计数）。 */
const MAX_EXTRACTION_ERRORS_IN_LOG = 3;

function collectToolEvidence(toolCalls: ToolCall[], dimensionId: string): EvidenceCollector {
  const collector = new EvidenceCollector();
  toolCalls.forEach((call, index) => {
    collector.processToolCall(call, index);
  });
  reportCollectionDiagnostics(collector.diagnostics(), toolCalls.length, dimensionId);
  return collector;
}

/**
 * 工具调用采集阶段的诊断日志（L7-P14 / C13）：Collector 吞掉的提取异常、被忽略的畸形 graph 字段，
 * 以及预算 / 每文件名额 / 单片段超预算导致的丢弃。全为 0 时不打日志（常态无噪声）。
 * 提取异常与畸形宿主字段说明宿主回执不符合契约 → warn；只有容量丢弃是预算控制的预期结果 → info。
 */
function reportCollectionDiagnostics(
  diagnostics: CollectorDiagnostics,
  toolCallCount: number,
  dimensionId: string
) {
  const {
    extractionErrors,
    malformedHostFields,
    droppedByBudget,
    droppedByFileCap,
    droppedOversize,
  } = diagnostics;
  const abnormal = extractionErrors.length > 0 || malformedHostFields > 0;
  if (!abnormal && droppedByBudget + droppedByFileCap + droppedOversize === 0) {
    return;
  }
  const listed = extractionErrors
    .slice(0, MAX_EXTRACTION_ERRORS_IN_LOG)
    .map((entry) => `#${entry.round} ${entry.tool}.${entry.action}: ${entry.message}`);
  const more =
    extractionErrors.length > MAX_EXTRACTION_ERRORS_IN_LOG
      ? `; +${extractionErrors.length - MAX_EXTRACTION_ERRORS_IN_LOG} more`
      : '';
  const errorDetail = listed.length > 0 ? ` [${listed.join('; ')}${more}]` : '';
  const line =
    `[AnalysisArtifact] evidence collection diagnostics: toolCalls=${toolCallCount}, ` +
    `extractionErrors=${extractionErrors.length}${errorDetail}, malformedHostFields=${malformedHostFields}, ` +
    `droppedByBudget=${droppedByBudget}, droppedByFileCap=${droppedByFileCap}, ` +
    `droppedOversize=${droppedOversize} (dim=${dimensionId})`;
  observeSafely(
    () => (abnormal ? logger().warn(line) : logger().info(line)),
    () => undefined
  );
}

/** V1 报告和 V2 工件共用同一采集投影，outline/失败/截断结果不能变成接地事实。 */
function buildReportFromEvidence(
  analystResult: AnalystResult,
  dimensionId: string,
  projectGraph: ProjectGraphLike | null,
  collector: EvidenceCollector
) {
  const referencedFiles = new Set<string>();
  const searchQueries: string[] = [];
  const classesExplored: string[] = [];

  const groundedFiles = new Set(
    [...collector.build().evidenceMap.values()]
      .filter((entry) => entry.codeSnippets.length > 0)
      .map((entry) => entry.filePath)
  );
  for (const call of analystResult.toolCalls || []) {
    const { tool, action, params, result, ok } = readToolObservation(call);
    if (!ok) {
      continue;
    }
    if (tool === 'code' && action === 'read') {
      // 请求路径不是成功回执；批量读取只纳入成功成员，与 runtime 的已读口径共用。
      for (const file of successfulReadPaths(call)) {
        referencedFiles.add(file);
      }
    } else if (tool === 'code' && action === 'search') {
      const query = params.pattern ?? params.query;
      if (typeof query === 'string') {
        searchQueries.push(query);
      }
      if (typeof call.result === 'string') {
        for (const file of extractFileRefs(call.result)) {
          referencedFiles.add(file);
        }
      } else if (Array.isArray(result.matches)) {
        for (const match of result.matches) {
          if (match && typeof match === 'object' && typeof match.file === 'string') {
            referencedFiles.add(match.file);
          }
        }
      }
    } else if (tool === 'graph') {
      const entity = params.entity ?? params.className ?? params.protocolName;
      if (typeof entity === 'string' && entity) {
        classesExplored.push(entity);
        const info = projectGraph?.getClassInfo(entity) || projectGraph?.getProtocolInfo(entity);
        if (info?.filePath) {
          referencedFiles.add(info.filePath);
        }
      }
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
    // 文本提及仍保留给旧消费者；质量门只把真实读取/片段投影当作接地事实。
    groundedFiles: [...groundedFiles],
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
 * 读盘端口返回 null 的原因计数（L7-P16/C43），各项之和对应 collector 的 anchorReaderMiss。
 * 只在闭包内累计并并入 anchor grounding 日志，不进入工件返回值。
 */
interface SnippetReaderMisses {
  /** 绝对路径 / `..` 逃逸，或 resolveProjectPath 的 Access denied（根内 symlink 指向根外等）。 */
  outsideRoot: number;
  /** ENOENT / ENOTDIR，或目标不是普通文件。 */
  missing: number;
  /** 起始行 < 1 或超过文件行数。 */
  outOfRange: number;
  /** 行范围内只有空白。 */
  emptyRange: number;
  /** 其它读取异常（权限不足等）。 */
  readError: number;
}

/** 从 unknown 异常里取 Node errno code（不是 errno 异常时为 undefined）。 */
function errnoCode(err: unknown): string | undefined {
  if (err instanceof Error && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return undefined;
}

/** 读盘异常归类：缺失与根外拒绝是可预期的未命中，其余都算读取错误。 */
function classifyReaderError(err: unknown): 'missing' | 'outsideRoot' | 'readError' {
  const code = errnoCode(err);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return 'missing';
  }
  // resolveProjectPath 的越界 / 不可解析拒绝统一以 “Access denied” 开头（src/shared/projectPath.ts）。
  if (err instanceof Error && err.message.startsWith('Access denied')) {
    return 'outsideRoot';
  }
  return 'readError';
}

/**
 * projectRoot 内的只读行范围端口（R1 锚点补齐用）。逐字读取 [startLine, endLine] 源码，
 * endLine 超文件末尾时收缩为实际末行；相对路径逃逸 / 绝对路径 / 文件缺失 / symlink 逃逸返回 null——
 * 绝不让补齐流程读到项目外内容或编造证据。每次返回 null 都按原因计入 misses（C43），调用方把计数
 * 并入 anchor grounding 日志，越界拒绝与读取错误不再被静默吞掉。
 */
function createFsSnippetRangeReader(projectRoot: string): {
  reader: SnippetRangeReader;
  misses: SnippetReaderMisses;
} {
  const misses: SnippetReaderMisses = {
    outsideRoot: 0,
    missing: 0,
    outOfRange: 0,
    emptyRange: 0,
    readError: 0,
  };
  const reader: SnippetRangeReader = (filePath, startLine, endLine) => {
    try {
      const normalized = path.posix.normalize(String(filePath).replaceAll('\\', '/'));
      if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
        misses.outsideRoot += 1;
        return null;
      }
      const absPath = resolveProjectPath(projectRoot, normalized).absolute;
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        misses.missing += 1;
        return null;
      }
      const lines = fs.readFileSync(absPath, 'utf-8').split('\n');
      if (startLine < 1 || startLine > lines.length) {
        misses.outOfRange += 1;
        return null;
      }
      const effectiveEnd = Math.min(endLine, lines.length);
      const content = lines.slice(startLine - 1, effectiveEnd).join('\n');
      if (!content.trim()) {
        misses.emptyRange += 1;
        return null;
      }
      return { content, endLine: effectiveEnd };
    } catch (err: unknown) {
      // 只读补齐失败跳过（证据缺失优于错误证据），但按原因计数，供 anchor grounding 日志定位。
      misses[classifyReaderError(err)] += 1;
      return null;
    }
  };
  return { reader, misses };
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
 * @param [opts] projectRoot 启用锚点补读（缺省时不读盘）。严格冷启动不经过本函数（审阅包
 *   L6-P27 / L7-P27 C45：严格链由阶段配置 capabilities:[] 与宿主编排表达）；opts 不再接收
 *   严格冷启动开关，ActiveContext 蒸馏结果里也不再有严格投影可透传。无类型检查的 JS 调用方
 *   若仍传入旧开关，该字段不会被读取，得到的就是普通 legacy 工件。
 */
export function buildAnalysisArtifact(
  analystResult: AnalystResult,
  dimensionId: string,
  projectGraph: ProjectGraphLike | null = null,
  activeContext: ActiveContextLike | null = null,
  opts: { projectRoot?: string } = {}
) {
  const toolCalls = analystResult.toolCalls || [];

  const collector = collectToolEvidence(toolCalls, dimensionId);
  const baseReport = buildReportFromEvidence(analystResult, dimensionId, projectGraph, collector);

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
    // 降级路径（没有 note_finding）：只按派生前接地集合派生（L7-P16/C07）。referencedFiles 含正文提及，
    // 而小节正文来自同一段文本，拿它过滤恒真；接地集合 = baseReport.groundedFiles 并上此刻 evidenceMap
    // 中有片段的 key（两者同源于同一 collector，并集只防两处投影将来分叉）。必须在下方锚点补读之前取，
    // 补读读到的磁盘片段不能反过来为派生 findings 自证接地。
    const derivationGrounding = new Set(baseReport.groundedFiles);
    for (const [filePath, entry] of collector.build().evidenceMap) {
      if (entry.codeSnippets.length > 0) {
        derivationGrounding.add(filePath);
      }
    }
    const derived = deriveFindingsFromAnalysisText(baseReport.analysisText, derivationGrounding);
    findings = derived.findings;
    derivedFindingCount = findings.length;
    reportDerivedFindings(
      derived.stats,
      derivedFindingCount,
      derivationGrounding.size,
      dimensionId
    );
  }

  // R1 锚点驱动证据补齐：findings 引用的 path:line 锚点若不在已采片段覆盖内（典型：全文读
  // 只留头 30 行窗口，锚点在窗口外），从磁盘补读精确片段——每条发现都有可照抄的逐字证据。
  let postHocLiveReadCount = 0;
  if (opts.projectRoot) {
    const beforeSnippets = countSnippets(collector);
    const beforeDiagnostics = collector.diagnostics();
    const { reader, misses } = createFsSnippetRangeReader(opts.projectRoot);
    collector.groundFindingRefs(findings, reader);
    const afterSnippets = countSnippets(collector);
    const afterDiagnostics = collector.diagnostics();
    postHocLiveReadCount = Math.max(0, afterSnippets - beforeSnippets);
    const anchoredFindings = findings.filter(
      (f) => typeof f.evidence === 'string' && /\.[A-Za-z]\w*:\d+/.test(f.evidence)
    ).length;
    // 补齐阶段自己的跳过 / 丢弃：前后两次诊断快照求差，不混入工具调用采集阶段的计数。
    const grounding = (key: Exclude<keyof CollectorDiagnostics, 'extractionErrors'>) =>
      afterDiagnostics[key] - beforeDiagnostics[key];
    // 残余根因分辨日志（下列计数按锚点，一条 finding 可带多个锚点）：
    // anchored=0 → Analyst 没写行号锚（依从性缺口在上游）；
    // anchored>0 且 grounded=0 → 看同行计数：readerMiss 及其方括号内的读盘端口分类（C43：outsideRoot
    //   路径越界或 symlink 逃逸被拒 / missing 文件缺失 / outOfRange 行号超界 / emptyRange 空范围 /
    //   readError 其它读取失败）、
    //   droppedByFileCap / droppedByBudget / droppedOversize（每文件名额或片段预算挡住补读）、
    //   alreadyCovered（起始行已有片段覆盖）、docSkipped（文档锚点按设计不补）、invalidRange（行号无效）；
    // grounded>0 仍被拒 → Producer 没照抄。
    const readerMissDetail =
      `[outsideRoot=${misses.outsideRoot}, missing=${misses.missing}, outOfRange=${misses.outOfRange}, ` +
      `emptyRange=${misses.emptyRange}, readError=${misses.readError}]`;
    observeSafely(
      () =>
        logger().info(
          `[AnalysisArtifact] anchor grounding: findings=${findings.length}, anchored=${anchoredFindings}, ` +
            `groundedSnippets=+${afterSnippets - beforeSnippets}, readerMiss=${grounding('anchorReaderMiss')} ` +
            `${readerMissDetail}, ` +
            `alreadyCovered=${grounding('anchorAlreadyCovered')}, docSkipped=${grounding('anchorDocSkipped')}, ` +
            `invalidRange=${grounding('anchorInvalidRange')}, droppedByFileCap=${grounding('droppedByFileCap')}, ` +
            `droppedByBudget=${grounding('droppedByBudget')}, droppedOversize=${grounding('droppedOversize')} ` +
            `(dim=${dimensionId})`
        ),
      () => undefined
    );
  }

  const evidence = collector.build();

  const allFiles = new Set(baseReport.referencedFiles);
  const groundedFiles = new Set(baseReport.groundedFiles);
  for (const filePath of evidence.evidenceMap.keys()) {
    allFiles.add(filePath);
    if (evidence.evidenceMap.get(filePath)?.codeSnippets.length) {
      groundedFiles.add(filePath);
    }
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
    groundedFiles: [...groundedFiles],
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
      postHocLiveReadCount,
    },

    // v1 backward compat
    searchQueries: baseReport.searchQueries,
    classesExplored: baseReport.classesExplored,
  };
}
