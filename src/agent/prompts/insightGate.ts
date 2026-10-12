/**
 * insightGate.ts — 质量门打回后的修复类 Prompt 构建(retry/repair/rewrite 三件)
 *
 * W6-d(A1)拆分:原 1,328 行三分混装已按归属拆出——
 * - 工件构建(sanitizeAnalysisText/buildAnalysisReport/buildAnalysisArtifact 等)
 *   → ../evaluation/analysisArtifact.ts
 * - 质量评估器(buildQualityScores/analysisQualityGate/applyDepthRetryGate 等)
 *   → ../evaluation/qualityGates.ts
 * - gate.evaluator 适配器(insightGateEvaluator/evolutionGateEvaluator)
 *   → ../evaluation/gateEvaluators.ts
 * 本文件只保留纯 prompt 文本构建:
 * - buildRetryPrompt(拆前 :781)
 * - buildAnalyzeRetryPrompt(C53:scan 管线与 insight 预设 analyze 阶段共用的门重试提示，内部 helper)
 * - buildRecordRepairPrompt(拆前 :853)+stringifyRecordRepairEvidenceMap(拆前 :814)
 * - buildSummaryRewritePrompt(拆前 :915)
 *
 * ⚠️ 路由常量契约:DEPTH_GAP_REASON/GENERIC_DEPTH_GAP_HINT/REQUIRED_MEMORY_FINDING_SUGGESTION/
 * INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION 必须 import 自 evaluation/qualityGates
 * (门控产出与本文件路由判定同一符号)——退化成本地字面量副本会让深度 retry 与
 * 记忆修复路由在运行期静默失效(编译仍绿)。
 *
 * ⚠️ 公开面:prompts/index.ts 按名 re-export 本文件的 buildRetryPrompt/buildRecordRepairPrompt/
 * buildSummaryRewritePrompt 进入 @alembic/agent/prompts 冻结名集。其余导出(如 buildAnalyzeRetryPrompt)
 * 只供 agent 内部阶段工厂跨文件复用，不得加进那份名单(名集膨胀=签名门红)。
 *
 * @module insightGate
 */

import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import {
  DEPTH_GAP_REASON,
  GENERIC_DEPTH_GAP_HINT,
  getArtifactMemoryFindingCount,
  INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION,
  type NormalizedFinding,
  REQUIRED_MEMORY_FINDING_SUGGESTION,
} from '../evaluation/qualityGates.js';

const logger = () => Logger.getInstance();

/** 观测日志只做旁路记录：日志器异常不得打断提示构建(observeSafely 吞掉观察者错误)。 */
function logPromptPath(message: string) {
  observeSafely(
    () => logger().info(message),
    () => undefined
  );
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
    // C55: missing 有两种来源——门控在作者用小节组织时报缺口维度名；自由叙述(接地核心维度为 0)时
    // 报通用深挖指令 GENERIC_DEPTH_GAP_HINT。通用指令(或空)不是维度名：不能列成「以下深度维度」，
    // 也不能要求逐槽填 designIntent/boundaries/failureModes/tradeoffs(那正是用户否决的四问填表)，
    // 改为引导在正文里补写带真实来源的深度断言——与深度门双轨中 groundedSignalCount 认可的形态一致。
    if (!missing || missing === GENERIC_DEPTH_GAP_HINT) {
      logPromptPath(
        `[InsightGate] retry prompt: depth-gap branch=generic-claims (missing=${missing ? 'generic-hint' : 'empty'})`
      );
      return (
        '分析中的深度断言缺少真实代码接地。不要凭空补写、不要改措辞充数——回到分析(Analyst)段，' +
        '用 code({ action: "read" }) / graph({ action: "query" }) 回到核心发现的相关实现，' +
        '在分析正文中为核心发现补写接地深度断言(因果/代价/例外/对照)，每条句内带真实 (来源: file:line)；' +
        '挖到的角度恰好对应某个深度槽时，再顺手在 note_finding 中填该槽。读不到真实证据就不写。'
      );
    }
    logPromptPath(
      `[InsightGate] retry prompt: depth-gap branch=dimension-names (missing=${JSON.stringify(missing)})`
    );
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
      '上一轮没有形成可验收的结构化证据记录。不要直接写总结；先用 code({ action: "structure" }) / code({ action: "search" }) / graph({ action: "query" }) 定位相关实现，再用 code({ action: "read" }) 验证至少 3 个文件；每确认一个核心发现就调用 note_finding({ finding, evidenceRefs, importance })，evidenceRefs 必须引用已采集证据的 E-id；文件路径与行号由台账展开，最后再输出报告。',
    [INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION]:
      '结构化发现数量不足。先检查已有证据是否覆盖至少 3 个真实文件；如证据不足，继续用 code({ action: "read" }) 验证关键实现；随后调用 note_finding({ finding, evidenceRefs, importance }) 补齐到至少 3 个核心发现，每个 evidenceRefs 必须引用已采集证据的 E-id；文件路径与行号由台账展开，然后再输出最终报告。',
  };

  return (
    (hints as Record<string, string>)[reason] ||
    '请更深入地分析代码，引用至少 3 个具体文件，每个发现都要有代码证据。'
  );
}

/**
 * C53: analyze 阶段的门重试提示——scan 管线(evaluation/stageBuilders)与 insight 预设
 * (profiles/presets/insightPreset)的 analyze.retryPromptBuilder 都委托这里，避免两份拷贝分叉。
 *
 * 提示 = 上一轮 analyze 回复 + 质量门失败原因 + buildRetryPrompt 的分支提示，口径与收敛前逐字一致：
 * - 上一轮回复缺失(analyze 阶段没有结果或 reply 为空)时以空串开头，只靠失败原因与提示引导重挖；
 * - reason 缺失时模板沿用旧插值(`undefined`)，提示按空原因路由到通用深挖文案。
 * 两条降级路径都打观测日志，便于区分「带上一轮分析重试」与「无上一轮分析重试」。
 *
 * ⚠️ 内部 helper：不加入 prompts/index.ts 的按名 re-export(见文件头公开面说明)。
 *
 * @param retryCtx PipelineStrategy 传入的门重试上下文(phaseResults._retryContext)
 * @param prev PipelineStrategy 的 phaseResults；只读取其中 analyze 阶段的 reply
 */
export function buildAnalyzeRetryPrompt(
  retryCtx: { reason?: string },
  prev: Record<string, unknown>
) {
  const prevAnalysis = (prev.analyze as { reply?: string } | undefined)?.reply || '';
  const retryHint = buildRetryPrompt(retryCtx.reason ?? '');
  logPromptPath(
    `[InsightGate] analyze retry prompt: ` +
      `path=${prevAnalysis ? 'with-previous-analysis' : 'no-previous-analysis'} ` +
      `(prevAnalysisChars=${String(prevAnalysis).length}; ` +
      `reason=${retryCtx.reason === undefined ? 'missing' : JSON.stringify(String(retryCtx.reason).slice(0, 120))})`
  );
  return `${prevAnalysis}\n\n⚠️ 上述分析未通过质量检查: ${retryCtx.reason}\n\n${retryHint}`;
}

/** 修复类提示里文件清单的上限(与拆分前一致)。 */
const PROMPT_FILE_LIST_LIMIT = 30;

/** 接地文件段标题：只有真实读取/片段投影过的文件可作为来源。 */
const GROUNDED_FILES_HEADER = '已读取接地的文件（可作为来源）:';
/** 仅提及段标题：正文提及或搜索命中、但未读取的路径。 */
const MENTIONED_ONLY_FILES_HEADER = '仅提及、未读取（禁止作为引用）:';
/** 旧工件段标题：宿主旧工件没有 groundedFiles 字段，无法区分提及与接地。 */
const LEGACY_FILES_HEADER = '引用文件（旧工件未区分接地，仅可引用其中确实读取过的文件）:';

/** 修复/重写提示的文件清单：可引用来源与仅提及路径分开。 */
interface PromptFileSets {
  /** 可作为来源的文件：新工件取 groundedFiles；旧工件兼容回退 referencedFiles。 */
  citable: string[];
  /** referencedFiles 中不在 groundedFiles 里的路径(文本提及/搜索命中)，禁止作为来源。 */
  mentionedOnly: string[];
  /** true = 工件没有可用的 groundedFiles 数组，citable 来自未区分接地的 referencedFiles。 */
  legacyUngrounded: boolean;
}

function toStringList(value: unknown) {
  return Array.isArray(value)
    ? (value as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * C54: 解析修复类提示可引用的文件。
 *
 * evaluation/analysisArtifact 的 referencedFiles 含正文提及路径与搜索命中(只为旧消费者保留)，
 * 真正接地的是 groundedFiles(真实读取/片段投影)——质量门 reviewInsightDepth 也只认后者。
 * 因此：
 * - 有 groundedFiles 数组 → 只有它可引用；即便为空也不回退 referencedFiles(否则提及路径会被重新
 *   洗成「已验证」)，提及路径单列为禁止引用。
 * - 无 groundedFiles 数组(宿主旧工件) → 兼容回退 referencedFiles，标题注明未区分接地。
 * 三条路径都打观测日志，便于按 stage 追查重写/补记时模型看到的来源口径。
 */
function resolvePromptFileSets(
  record: { groundedFiles?: unknown; referencedFiles?: unknown },
  stage: 'record_repair' | 'summary_rewrite'
): PromptFileSets {
  const referenced = toStringList(record.referencedFiles);
  if (!Array.isArray(record.groundedFiles)) {
    logPromptPath(
      `[InsightGate] ${stage} prompt: artifact has no groundedFiles; falling back to referencedFiles ` +
        `as a legacy ungrounded list (path=legacy-referenced-files; referenced=${referenced.length})`
    );
    return {
      citable: referenced.slice(0, PROMPT_FILE_LIST_LIMIT),
      mentionedOnly: [],
      legacyUngrounded: true,
    };
  }
  const grounded = toStringList(record.groundedFiles);
  const groundedSet = new Set(grounded);
  const mentionedOnly = referenced.filter((file) => !groundedSet.has(file));
  logPromptPath(
    `[InsightGate] ${stage} prompt: citable files from groundedFiles ` +
      `(path=${grounded.length > 0 ? 'grounded' : 'no-grounded'}; grounded=${grounded.length}; ` +
      `mentionedOnly=${mentionedOnly.length})`
  );
  return {
    citable: grounded.slice(0, PROMPT_FILE_LIST_LIMIT),
    mentionedOnly: mentionedOnly.slice(0, PROMPT_FILE_LIST_LIMIT),
    legacyUngrounded: false,
  };
}

/**
 * 渲染文件清单段。notes.emptyLegacy 只用于旧工件且清单为空的情形(保持旧工件原有口径)；
 * 新工件接地清单为空时明确告知只能引用已有发现/证据，不得把正文提及路径当来源。
 */
function renderPromptFileSections(
  files: PromptFileSets,
  notes: { emptyGrounded: string; emptyLegacy: string }
) {
  const list = (items: string[]) => items.map((file) => `- ${file}`).join('\n');
  if (files.legacyUngrounded) {
    return `${LEGACY_FILES_HEADER}\n${files.citable.length > 0 ? list(files.citable) : notes.emptyLegacy}`;
  }
  const groundedSection = `${GROUNDED_FILES_HEADER}\n${
    files.citable.length > 0 ? list(files.citable) : notes.emptyGrounded
  }`;
  if (files.mentionedOnly.length === 0) {
    return groundedSection;
  }
  return `${groundedSection}\n\n${MENTIONED_ONLY_FILES_HEADER}\n${list(files.mentionedOnly)}`;
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
      const record = value as {
        summary?: string;
        codeSnippets?: Array<{ startLine?: number; endLine?: number }>;
      };
      const lines =
        Array.isArray(record?.codeSnippets) && record.codeSnippets.length > 0
          ? record.codeSnippets
              .slice(0, 3)
              .map((snippet) =>
                typeof snippet.startLine === 'number'
                  ? `${String(filePath)}:${snippet.startLine}-${snippet.endLine ?? snippet.startLine}`
                  : null
              )
              .filter(Boolean)
              .join(', ')
          : String(filePath);
      return `- ${lines || String(filePath)}${record?.summary ? ` — ${record.summary}` : ''}`;
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
    referencedFiles?: unknown;
    groundedFiles?: unknown;
    evidenceMap?: unknown;
  };
  const memoryFindingCount = getArtifactMemoryFindingCount(artifact);
  const missing = Math.max(1, minFindings - memoryFindingCount);
  const fileSets = resolvePromptFileSets(record, 'record_repair');
  const fileSections = renderPromptFileSections(fileSets, {
    emptyGrounded: '- （无已读取接地的文件；只能引用下方已有发现与证据摘要中的台账来源）',
    emptyLegacy: '- （无显式文件清单，请只使用分析正文中出现的文件路径）',
  });
  // 只有区分了接地的新工件才渲染「仅提及」段；旧工件不引用不存在的段落。
  const mentionedOnlyRule = fileSets.legacyUngrounded
    ? ''
    : '\n- 「仅提及、未读取」的路径只是正文提及或搜索命中，不是证据，不得作为发现的来源';
  // 无 evidenceMap(V1 报告)时：区分了接地的工件不能再让模型「用正文里的路径」——正文含仅提及路径；
  // 旧工件保持原口径。
  const noEvidenceMapNote = fileSets.legacyUngrounded
    ? '- （无 evidenceMap，使用分析正文中的文件路径和行号）'
    : '- （无 evidenceMap；只能引用上方已读取接地的文件与台账 E-id，正文中仅提及的路径不可作为来源）';
  const existingFindings = Array.isArray(record.findings) ? record.findings.slice(0, 8) : [];
  const evidenceMapText = stringifyRecordRepairEvidenceMap(record.evidenceMap);

  return `QualityGate 判定上一轮分析已经具备可记录发现，但结构化 note_finding 不足。

失败原因: ${reason || 'missing note_finding records'}
当前已记录结构化发现: ${memoryFindingCount}
本阶段至少补写: ${missing} 条

硬性规则:
- 使用 note_finding({ finding, evidenceRefs, importance }) 记录；可用 evidence.search/get 查回已采集证据及其 E-id
- 每次工具调用只记录一条发现，直到补齐至少 ${minFindings} 条结构化发现
- evidenceRefs 必须使用工具实际返回的台账 E-id，不得把 file:line 字符串当成引用 id${mentionedOnlyRule}
- 禁止调用 code、graph、terminal、knowledge 或任何探索/提交工具
- 不要把 Markdown 正文当作完成结果
- 如果无法调用 note_finding，本阶段必须失败并回到调用链修复；不要输出 JSON、Markdown 或其它替代格式

${fileSections}

已有发现摘要:
${
  existingFindings.length > 0
    ? existingFindings
        .map((finding) => `- [${finding.importance}/10] ${finding.finding} — ${finding.evidence}`)
        .join('\n')
    : '- （当前没有结构化发现）'
}

证据摘要:
${evidenceMapText || noEvidenceMapNote}

分析正文（只读依据，不要继续探索）:
${String(record.analysisText || '').slice(0, 8000)}`;
}

/**
 * 构建 summary-rewrite 纯写作重组提示。
 *
 * 触发前提：证据面已达标(findings/文件引用充足)，只有分析写作不过门(文本短、缺结构、
 * 缺接地深度断言——典型是 analyze 超时打断总结)。该阶段零工具、单次调用：把已验证发现
 * 组织成结构化深度分析文本，成本是整段 analysis_retry 重挖的零头。
 * 防编造与 record_repair 同一立场：引用只可来自下方注入的已验证发现与已读取接地的文件，禁止新增；
 * 上一稿正文里出现、但不在接地清单中的路径(文本提及/搜索命中)不得作为来源(C54)。
 */
export function buildSummaryRewritePrompt(options: {
  reason: string;
  artifact: Record<string, unknown> | null | undefined;
}) {
  const record = (options.artifact || {}) as {
    analysisText?: unknown;
    findings?: Array<{ finding?: unknown; evidence?: unknown; importance?: unknown }>;
    referencedFiles?: unknown;
    groundedFiles?: unknown;
  };
  const findings = Array.isArray(record.findings) ? record.findings.slice(0, 24) : [];
  const fileSets = resolvePromptFileSets(record, 'summary_rewrite');
  const fileSections = renderPromptFileSections(fileSets, {
    emptyGrounded: '-（无已读取接地的文件；只能引用上方已验证发现中的来源）',
    emptyLegacy: '-（使用上一稿正文中出现的路径）',
  });
  // 硬性规则里的文件清单名与实际渲染的段落一致：新工件=已读取接地的文件，旧工件=引用文件。
  const fileListName = fileSets.legacyUngrounded ? '引用文件' : '已读取接地的文件';
  const groundingRule = fileSets.legacyUngrounded
    ? ''
    : '\n- 上一稿正文或「仅提及、未读取」清单里出现、但不在「已读取接地的文件」清单中的路径不得作为 (来源: …)';
  const prevText = String(record.analysisText || '').slice(0, 2000);

  return `QualityGate 判定你的探索证据已经达标（${findings.length} 条已验证发现），唯一不通过的是分析写作本身。

失败原因: ${options.reason || 'analysis text too short or lacks grounded depth claims'}

本阶段是纯写作重组，不是重新分析:
- 只根据下方「已验证发现」和「${fileListName}」写出完整的结构化深度分析
- 用 ## 小节组织；每个核心论断句内带 (来源: 文件路径:行号)
- 引用只能使用下方发现/${fileListName}中出现的路径与行号，禁止引入任何新文件、新行号、新事实${groundingRule}
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

${fileSections}

上一稿正文（可吸收其内容，但必须重写扩充）:
${prevText || '（上一稿为空）'}`;
}
