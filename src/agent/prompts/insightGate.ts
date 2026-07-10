/**
 * insightGate.ts — 质量门打回后的修复类 Prompt 构建(retry/repair/rewrite 三件)
 *
 * W6-d(A1)拆分:原 1,328 行三分混装已按归属拆出——
 * - 工件构建(sanitizeAnalysisText/buildAnalysisReport/buildAnalysisArtifact 等)
 *   → ../evaluation/analysisArtifact.ts
 * - 质量评估器(buildQualityScores/analysisQualityGate/applyDepthRetryGate/
 *   applyDepthRetryGate 等) → ../evaluation/qualityGates.ts
 * - gate.evaluator 适配器(insightGateEvaluator/evolutionGateEvaluator)
 *   → ../evaluation/gateEvaluators.ts
 * 本文件只保留纯 prompt 文本构建:
 * - buildRetryPrompt(拆前 :781)
 * - buildRecordRepairPrompt(拆前 :853)+stringifyRecordRepairEvidenceMap(拆前 :814)
 * - buildSummaryRewritePrompt(拆前 :915)
 *
 * ⚠️ 路由常量契约:DEPTH_GAP_REASON/REQUIRED_MEMORY_FINDING_SUGGESTION/
 * INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION 必须 import 自 evaluation/qualityGates
 * (门控产出与本文件路由判定同一符号)——退化成本地字面量副本会让深度 retry 与
 * 记忆修复路由在运行期静默失效(编译仍绿)。
 *
 * @module insightGate
 */

import {
  DEPTH_GAP_REASON,
  getArtifactMemoryFindingCount,
  INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION,
  type NormalizedFinding,
  REQUIRED_MEMORY_FINDING_SUGGESTION,
} from '../evaluation/qualityGates.js';

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
