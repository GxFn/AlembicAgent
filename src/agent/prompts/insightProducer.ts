/**
 * insightProducer.ts — Insight Producer 领域函数
 *
 * 从旧 ProducerAgent.js 提取的纯领域逻辑:
 * - Producer System Prompt
 * - 工具白名单
 * - 预算常量
 * - Prompt 构建器 (v1 + v2)
 * - 代码上下文注入 (evidenceMap → prompt section)
 * - 拒绝率门控 (producerRejectionGateEvaluator)
 *
 * 被 PipelineStrategy 的 bootstrap preset 直接引用。
 * 不再包含任何 Agent 类 — Agent 由 AgentRuntime + PipelineStrategy 驱动。
 *
 * @module insightProducer
 */

import {
  describeSubmitToolFields,
  renderGuidance,
  SUBMIT_REQUIREMENTS,
} from '@alembic/core/knowledge';
import type { EvidenceEntry } from '../domain/EvidenceCollector.js';

// ──────────────────────────────────────────────────────────────────
// 本地类型定义
// ──────────────────────────────────────────────────────────────────

/** AnalysisReport 最小接口 (v1) */
interface AnalysisReportLike {
  analysisText: string;
  referencedFiles: string[];
}

/** AnalysisArtifact 最小接口 (v2) */
interface AnalysisArtifactLike extends AnalysisReportLike {
  findings: Array<{ finding: string; evidence?: string; importance: number }>;
  evidenceMap?: Map<string, EvidenceEntry>;
  negativeSignals: Array<{ searchPattern: string; implication: string }>;
}

/** 维度配置 */
interface DimConfig {
  id: string;
  label: string;
  allowedKnowledgeTypes?: string[];
  outputType?: string;
}

/** 项目基本信息 */
interface ProjectInfo {
  name: string;
}

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

// ──────────────────────────────────────────────────────────────────
// System Prompt — Producer 专用 (~150 tokens)
// ──────────────────────────────────────────────────────────────────

export const PRODUCER_SYSTEM_PROMPT = `你是知识管理专家。你会收到一段代码分析文本，需要将其中的知识点转化为结构化的知识候选。

核心原则: 分析文本已经包含了所有发现，你的工作是格式化、校验并提交知识候选。
唯一候选义务来自 Analyst 已确认的结构化发现；最终 Markdown 摘要只作为解释背景，不要从 Markdown 里发掘新的候选主题。

每个候选必须:
1. 有清晰的标题 (描述知识点的核心，使用项目真实类名，不以项目名开头)
2. 有项目特写风格的正文 (content.markdown 字段，结合代码展示)
3. 标注相关文件的完整相对路径 + 行号（从项目根目录开始，如 Packages/AOXNetworkKit/Sources/.../NetworkClient.swift:42）
4. 选择正确的 kind (rule/pattern/fact)
5. 提供中文 description（≤80 字，引用真实类名）
6. 提供完整的 Cursor 交付字段 (trigger, doClause, whenClause, dontClause, coreCode 等)
7. 标注所属模块/包名（如「所属模块: AOXNetworkKit」），特别是来自本地子包的知识

工作流程:
1. 阅读结构化发现，识别每个独立的知识点/发现
2. 只使用结构化发现中的 evidence、Analyst evidence refs 和已给出的代码片段；Producer 阶段不补读源码
3. 调用 knowledge({ action: "submit", params: { ... } }) 提交知识候选（内置查重和校验）
4. 目标候选提交完成后直接总结；只有工具错误或证据不确定时才用 meta({ action: "review" }) 自检

关键规则:
- 结构化发现中的每个要点都应转化为至少一个候选；不要把最终 Markdown 里未结构化记录的主题当成额外提交义务
- 不要调用 code.read、search、graph 或 terminal；缺少短代码片段时使用 Analyst 已给出的证据摘要完成候选，证据不足才在最终总结中列为 blocker
- reasoning.sources 必须是非空数组，填写文件的完整相对路径，如 ["Packages/AOXNetworkKit/Sources/AOXNetworkKit/Client/NetworkClient.swift"]（禁止只写文件名）
- sourceRefs / reasoning.sources 只服务最终候选证据；不要为了满足指标编造模块别名、类名或不存在路径
- content.markdown 中的来源标注使用完整相对路径+行号: (来源: Full/Path/FileName.ext:行号)
- 每次 knowledge.submit 前先自检 params.title、params.description、content.markdown、content.rationale、kind、trigger、whenClause、doClause、reasoning.sources 非空；缺少 title/description 等字段会被工具拒绝并浪费 Producer 轮次
- Analyst 结构化发现已全部提交后，不再调用 meta.review，直接输出最终总结
- 如果分析提到了 3 个模式，就应该提交 3 个候选，不要合并
- 禁止: 不要搜索新文件、不要做额外分析、不要使用终端工具，专注于格式化和提交
- 【跨维度去重】每条候选必须聚焦当前维度独有的视角，不得将同一知识点换个说法重复提交。相同的类/模式只在最相关的维度出现一次，宁可少提交也不要充数

🚨 过门禁硬约束（不满足必被拒，白白浪费提交轮次；按此逐条自检后再 submit）:
- sourceRefs / reasoning.sources / content.markdown 的 (来源: …) 必须【逐字复制】上面 Analyst evidence refs 里的「path:起行-止行」，务必带行号——绝不能只写路径（否则 SOURCE_REF_LINE_MISSING）。
- rule / pattern 候选必须引用【至少 3 个不同文件】的 path:行（evidence refs 已给多个，选最相关的 3+ 个）；确实只涉及单文件时，才在 params 里显式加 scope: "narrow"（否则 INSUFFICIENT_EVIDENCE）。
- coreCode 必须【逐字复制】上面「可复制 coreCode」提供的真实代码，不要凭空写；确无对应代码时省略 coreCode，只在 content.markdown 放来自证据的代码块（否则 SNIPPET_MISMATCH）。
- doClause 必须以英文祈使动词开头（use / prefer / require / keep / validate / ensure / return / follow / …，见上方门禁 45 词白名单）；dontClause 以 "Do not …" 开头（否则 DO_CLAUSE_NON_IMPERATIVE）。
- 涉及「依赖 / 调用 / 关系 / 上游 / 下游」等关系声明时，要么附 graph 证据，要么改述为边界 / 导入方向规则并避开这些关系词（否则 GRAPH_REF_INVALID）。

容错规则:
- 直接使用分析文本中已有的代码和描述来提交候选
- 永远不要因为缺少额外文件读取而跳过知识点 — 分析文本已经包含足够信息
- 先提交真实候选；sourceRef 不确定时保留已知真实路径，不要编造路径`;

// ──────────────────────────────────────────────────────────────────
// Producer 可用工具白名单 — 只做格式化和提交
// ──────────────────────────────────────────────────────────────────

export const PRODUCER_TOOLS = ['code', 'knowledge', 'meta'];

// ──────────────────────────────────────────────────────────────────
// Producer 预算
// ──────────────────────────────────────────────────────────────────

export const PRODUCER_BUDGET = {
  maxIterations: 24,
  searchBudget: 4,
  searchBudgetGrace: 3,
  maxSubmits: 10,
  softSubmitLimit: 10,
  idleRoundsToExit: 3,
};

// ──────────────────────────────────────────────────────────────────
// 项目特写写作指南 + 提交门禁规则 (从 Core RecipeAuthoringSpec 权威渲染)
// ──────────────────────────────────────────────────────────────────

// P1.4b producer-prompt-first：in-process 提交此前只过 length-only 门槛，Producer 从不知道 stage-1/2
// 的真实门禁；在 in-process gate（validateAgainst）上线之前，必须先让 Producer 看到与门禁同源的权威
// 规则，否则它只能反向猜测门禁、白白浪费提交轮次。STYLE_GUIDE 改由 renderGuidance('in-process') 渲染：
// 它读取与 validateAgainst 完全相同的 gateRules() 表（guidance==gate 的结构性保证），一次性给出项目
// 特写写作要求 + 全部 stage 门禁规则 + 45/12 祈使动词白名单 + 证据下限。Producer 运行于 bootstrap 冷启动
// 语境（提交携带 dimensionId → resolveAuthoringProfile=cold-start），故按 cold-start 渲染，呈现完整
// 规则上界（含 3-file 证据下限），与它实际面对的门禁一致。
const STYLE_GUIDE = renderGuidance('in-process', undefined, 'cold-start').text;

// 必填字段清单同样取自 Core spec 的 describeSubmitToolFields（FieldSpec 唯一来源），不再手写，避免
// 字段语义随时间与门禁 / FieldSpec 漂移。
const PRODUCER_SUBMIT_FIELD_CONTRACT = buildProducerSubmitFieldContract();

/** 从 Core spec 的字段描述表渲染 Producer 必填字段清单（spec-sourced，零手写漂移）。 */
function buildProducerSubmitFieldContract(): string {
  const fields = describeSubmitToolFields();
  const keys = [
    'title',
    'description',
    'content.markdown',
    'content.rationale',
    'kind',
    'trigger',
    'whenClause',
    'doClause',
    'dontClause',
    'coreCode',
    'reasoning.sources',
  ];
  return [
    '## knowledge.submit 必填字段（字段说明取自 Core RecipeAuthoringSpec，避免与门禁漂移）',
    ...keys.map((key) => `- ${key}: ${fields[key] ?? ''}`),
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────────
// Prompt 构建
// ──────────────────────────────────────────────────────────────────

/**
 * 构建 Producer Prompt (v1 — 用于 AnalysisReport)
 *
 * @param dimConfig { id, label, allowedKnowledgeTypes, outputType }
 * @param projectInfo { name }
 */
export function buildProducerPrompt(
  analysisReport: AnalysisReportLike,
  dimConfig: DimConfig,
  projectInfo: ProjectInfo
) {
  const parts: string[] = [];

  parts.push(`将以下对 ${projectInfo.name} 项目 "${dimConfig.label}" 维度的分析，转化为知识候选:`);
  parts.push(`---\n${analysisReport.analysisText}\n---`);

  if (analysisReport.referencedFiles.length > 0) {
    parts.push(`分析中引用的关键文件: ${analysisReport.referencedFiles.join(', ')}`);
  }

  parts.push(`维度约束:
- dimensionId: ${dimConfig.id}
- 允许的 knowledgeType: ${(dimConfig.allowedKnowledgeTypes || []).join(', ') || '(all)'}
- category: 只能填写业务/组件分类（View/Service/Tool/Model/Network/Storage/UI/Utility），不要填写维度 ID
- 提交时必须让 knowledge 工具携带 dimensionId=${dimConfig.id}；不要用 category 或 knowledgeType 表示维度归属`);

  parts.push(STYLE_GUIDE);
  parts.push(PRODUCER_SUBMIT_FIELD_CONTRACT);
  parts.push(SUBMIT_REQUIREMENTS);

  return compactProducerPromptParts(parts).join('\n\n');
}

/** Panorama context for Producer */
interface ProducerPanoramaContext {
  moduleRole: string | null;
  moduleLayer: number | null;
  knownGaps: string[];
  layerContext: string | null;
}

/** Rescan context for Producer — gap info + existing recipe titles */
interface ProducerRescanContext {
  existingRecipes: Array<{ title: string; trigger: string }>;
  decayingRecipes?: Array<{ id?: string; title: string; trigger: string; decayReason?: string }>;
  occupiedTriggers: string[];
  gap: number;
  createBudget?: number;
  executionMode?: 'skip' | 'verify-only' | 'produce';
  existing: number;
}

/**
 * 构建 Producer Prompt v2 — 用于 AnalysisArtifact
 *
 * 相比 v1 增加:
 * - §3 结构化发现 (findings)
 * - §4 代码证据 (evidenceMap → code context)
 * - §5 负空间信号
 * - §9 (可选) Rescan 模式约束
 * - §M1 (可选) 全景上下文
 */
export function buildProducerPromptV2(
  artifact: AnalysisArtifactLike,
  dimConfig: DimConfig,
  projectInfo: ProjectInfo,
  rescanContext?: ProducerRescanContext | null,
  panorama?: ProducerPanoramaContext | null,
  toolPolicyHints?: Record<string, unknown> | null
) {
  const parts: string[] = [];

  parts.push(`将以下对 ${projectInfo.name} 项目 "${dimConfig.label}" 维度的分析，转化为知识候选:`);
  const analysisDigest = buildAnalysisDigest(artifact.analysisText, artifact.findings);
  if (analysisDigest) {
    parts.push(`## Analyst 分析摘要 (已压缩)\n${analysisDigest}`);
  }

  // §3 结构化发现
  if (artifact.findings?.length > 0) {
    const findingLines = ['## 关键发现 (Analyst 已确认)'];
    const sorted = [...artifact.findings].sort((a, b) => b.importance - a.importance);
    for (const f of sorted) {
      const badge = f.importance >= 8 ? '⚠️' : '📋';
      findingLines.push(`${badge} **[${f.importance}/10]** ${f.finding}`);
      if (f.evidence) {
        findingLines.push(`  证据: ${f.evidence}`);
      }
    }
    findingLines.push('');
    findingLines.push(
      '☝️ 上述结构化发现是唯一候选义务；最终 Markdown 摘要只作背景，不要从摘要里新增候选主题。'
    );
    parts.push(findingLines.join('\n'));
  }

  // §4 代码证据
  const codeContext = buildCodeContextSection(artifact.evidenceMap);
  if (codeContext) {
    parts.push(codeContext);
  }

  // §5 负空间信号
  if (artifact.negativeSignals?.length > 0) {
    const nsLines = ['## ⛔ 不存在的模式 (不要猜测)'];
    for (const ns of artifact.negativeSignals.slice(0, 5)) {
      nsLines.push(`- "${ns.searchPattern}" — ${ns.implication}`);
    }
    parts.push(nsLines.join('\n'));
  }

  // §6 引用文件
  if (artifact.referencedFiles.length > 0) {
    parts.push(`分析中引用的关键文件: ${artifact.referencedFiles.slice(0, 15).join(', ')}`);
  }

  // §7 维度约束
  parts.push(`维度约束:
- dimensionId: ${dimConfig.id}
- 允许的 knowledgeType: ${(dimConfig.allowedKnowledgeTypes || []).join(', ') || '(all)'}
- category: 只能填写业务/组件分类（View/Service/Tool/Model/Network/Storage/UI/Utility），不要填写维度 ID
- 提交时必须让 knowledge 工具携带 dimensionId=${dimConfig.id}；不要用 category 或 knowledgeType 表示维度归属`);

  // §8 写作指南 + 提交要求
  parts.push(STYLE_GUIDE);
  parts.push(PRODUCER_SUBMIT_FIELD_CONTRACT);
  parts.push(SUBMIT_REQUIREMENTS);
  parts.push(`## Producer 工具边界
- 不使用终端工具，即使当前冷启动启用了终端能力档位
- 不新增搜索探索或源码补读；优先使用 Analyst evidence refs 和已给出的短代码片段
- knowledge({ action: "submit" }) 内置查重和校验，直接提交即可
- meta({ action: "review" }) 用于自检，不替代提交`);
  const terminalCapability = toolPolicyHints?.terminalCapability as
    | Record<string, unknown>
    | undefined;
  if (terminalCapability?.enabled === true) {
    parts.push(
      `当前终端能力档位是 ${String(terminalCapability.toolset || 'unknown')}，但 Producer 阶段禁止使用终端。`
    );
  }

  // §M1 全景上下文 — 帮助 Producer 理解模块定位
  if (panorama) {
    const pLines: string[] = [];
    if (panorama.moduleRole) {
      pLines.push(
        `模块角色: ${panorama.moduleRole}${panorama.moduleLayer !== null ? ` (L${panorama.moduleLayer})` : ''}`
      );
    }
    if (panorama.layerContext) {
      pLines.push(`架构层级: ${panorama.layerContext}`);
    }
    if (panorama.knownGaps.length > 0) {
      pLines.push(`知识空白区: ${panorama.knownGaps.join(', ')} — 优先为这些方向创建候选。`);
    }
    if (pLines.length > 0) {
      parts.push(`## 🏗️ 项目全景\n${pLines.join('\n')}`);
    }
  }

  // §9a Rescan 模式约束 — 限制提交数量，避免重复
  if (rescanContext && (rescanContext.createBudget ?? rescanContext.gap) > 0) {
    const createBudget = rescanContext.createBudget ?? rescanContext.gap;
    const lines = [
      '## ⚠️ 增量扫描模式 — 补齐约束',
      `本维度已有 ${rescanContext.existing} 个有效知识，需补齐 **${rescanContext.gap}** 个。`,
      `**提交上限: ${createBudget} 个候选**。达到目标后立即停止，不要多提交。`,
    ];
    if (rescanContext.occupiedTriggers.length > 0) {
      lines.push(`已占用的 trigger: ${rescanContext.occupiedTriggers.slice(0, 15).join(', ')}`);
      lines.push('禁止使用上述已占用的 trigger，必须为新模式创建新 trigger。');
    }
    if (rescanContext.existingRecipes.length > 0) {
      lines.push('已有知识标题 (禁止重复):');
      for (const r of rescanContext.existingRecipes.slice(0, 8)) {
        lines.push(`- "${r.title}"`);
      }
    }
    parts.push(lines.join('\n'));
  }

  // §9b 衰退 Recipe — 可用 supersedes 替换
  if (rescanContext?.decayingRecipes && rescanContext.decayingRecipes.length > 0) {
    const dLines = [
      '## 🔄 可替换的衰退知识',
      '以下 Recipe 正在衰退，如果 Analyst 发现了更新版本的模式，',
      '你可以用 `supersedes` 参数提交替代版本：',
    ];
    for (const r of rescanContext.decayingRecipes.slice(0, 5)) {
      dLines.push(`- [${r.id || '?'}] "${r.title}" — ${r.decayReason || '衰退中'}`);
      dLines.push(
        `  → 替换方式: knowledge({ action: "submit", params: { ...newRecipe, supersedes: "${r.id || ''}" } })`
      );
    }
    dLines.push('注意: supersedes 提交会创建观察窗口（72h），不是立即替换。');
    dLines.push('替换的新 Recipe 必须基于当前代码，不要复制旧 Recipe 内容。');
    parts.push(dLines.join('\n'));
  }

  return compactProducerPromptParts(parts).join('\n\n');
}

function buildAnalysisDigest(
  analysisText: string,
  findings: AnalysisArtifactLike['findings']
): string | null {
  const text = analysisText.trim();
  if (!text) {
    return null;
  }
  const findingTerms = new Set(
    (findings || [])
      .flatMap((finding) => `${finding.finding}\n${finding.evidence || ''}`.split(/\W+/))
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length >= 4)
  );
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const selected: string[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    const isHeading = /^#{1,4}\s/.test(line) || /^[一二三四五六七八九十]+[、.]/.test(line);
    const hasPath = /[\w./-]+\.(?:swift|ts|tsx|js|mjs|json|md)(?::\d+)?/.test(line);
    const hasFindingTerm = [...findingTerms].some((term) => lower.includes(term));
    if (isHeading || hasPath || hasFindingTerm) {
      selected.push(line);
    }
  }
  const digestSource = selected.length > 0 ? selected : lines.slice(0, 12);
  const digest = digestSource.join('\n');
  return limitText(
    [
      '完整分析文本不在 Producer 阶段重复展开；以下摘要只保留候选拆分所需的结构、路径和关键词。',
      digest,
    ].join('\n'),
    2200
  );
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 48)).trimEnd()}\n... [truncated for Producer token budget]`;
}

/**
 * coreCode 专用截断：绝不追加省略标记。注入代码是给模型【逐字复制】过 snippet-match 门禁的
 * （Core 判据 = 去空白后子串包含 + 逐行有序匹配），limitText 的 `... [truncated ...]` 尾巴不在
 * 真实源码里，复制后必触发 SNIPPET_MISMATCH，与本段注入目的自相矛盾。优先按整行截取源码前缀；
 * 首行本身超限时退化为字符前缀（去空白后仍是源码逐字子串，依然可过门禁）。
 */
function truncateCodeVerbatim(content: string, maxChars: number): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  const lines = trimmed.split('\n');
  const kept: string[] = [];
  let total = 0;
  for (const line of lines) {
    if (total + line.length + 1 > maxChars) {
      break;
    }
    kept.push(line);
    total += line.length + 1;
  }
  return kept.length > 0 ? kept.join('\n') : trimmed.slice(0, maxChars);
}

// ──────────────────────────────────────────────────────────────────
// 代码上下文注入 (Producer v2 辅助)
// ──────────────────────────────────────────────────────────────────

/**
 * 从 evidenceMap 构建 Producer 证据引用段。
 *
 * Package N 将 Producer 证据所有权收敛为 refs-first：这里不再注入大段代码正文。
 * Producer 不再补读源码；这样避免 live history 同时保留 direct code replay、
 * 额外 code.read 和 submit payload。
 */
export function buildCodeContextSection(
  evidenceMap: Map<string, EvidenceEntry> | null | undefined
) {
  if (!evidenceMap || evidenceMap.size === 0) {
    return null;
  }

  const parts = [
    '## 📄 Analyst evidence refs (bounded)',
    // 关键:证据 ref 直接呈现为门禁要求的 `path:起-止行` 形态，Producer 应把它们【逐字复制】进 sourceRefs
    // 与 content.markdown 的 (来源: path:行号)，务必带行号。rule/pattern 候选至少引用 3 个不同文件。
    '下面每条是可【逐字复制】的接地引用(path:起行-止行)。把它们直接用作 sourceRefs 与 (来源: path:行号)，务必带行号；rule/pattern 至少引 3 个不同文件。缺精确短代码片段时用 Analyst 摘要完成候选或在总结列为 blocker，不要编造路径或行号。',
  ];
  let totalChars = 0;
  const BUDGET = 1600;

  const sortedEntries = [...evidenceMap.values()]
    .filter((e) => e.filePath || e.summary || e.codeSnippets.length > 0)
    .sort((a, b) => b.codeSnippets.length - a.codeSnippets.length);

  for (const entry of sortedEntries) {
    if (totalChars >= BUDGET) {
      break;
    }

    // 旧写法 `path [L42-58]` 与门禁 SOURCE_REF_RE(`path:42-58`)不符，DeepSeek 常只复制路径、丢掉
    // `[L42-58]`，触发 SOURCE_REF_LINE_MISSING(本次拒绝首因)。改为把每个行范围渲染成 `path:起-止`，
    // 使证据引用可被逐字复制进候选、直接过门禁的行号与 snippet 匹配判据。
    const primarySnippet = entry.codeSnippets[0];
    const groundedRefs = entry.codeSnippets
      .slice(0, 3)
      .map((snippet) => `${entry.filePath}:${snippet.startLine}-${snippet.endLine}`);
    const refText = groundedRefs.length > 0 ? groundedRefs.join(', ') : entry.filePath;
    const summary = entry.summary ? ` — ${limitText(entry.summary, 140)}` : '';
    const line = `- ${refText}${entry.role ? ` (${entry.role})` : ''}${summary}`;
    parts.push(line);
    totalChars += line.length;
    // 注入首个片段的短代码正文，供 coreCode 逐字复制以过 snippet-match 门禁(旧 refs-first 只给 ref 不给
    // 代码，Producer 只能凭空写 coreCode → SNIPPET_MISMATCH)。截断保持 refs-first 的 token 约束。
    if (primarySnippet?.content?.trim() && totalChars < BUDGET) {
      const code = truncateCodeVerbatim(primarySnippet.content, 220);
      const codeLine = `    可复制 coreCode(来源 ${entry.filePath}:${primarySnippet.startLine}-${primarySnippet.endLine}): ${code}`;
      parts.push(codeLine);
      totalChars += codeLine.length;
    }
  }

  return parts.length > 1 ? parts.join('\n') : null;
}

function compactProducerPromptParts(parts: string[]): string[] {
  const seen = new Set<string>();
  const compacted: string[] = [];
  for (const part of parts) {
    const nextPart = compactRepeatedPromptLines(part, seen);
    if (nextPart.trim()) {
      compacted.push(nextPart);
    }
  }
  return compacted;
}

function compactRepeatedPromptLines(part: string, seen: Set<string>): string {
  const lines = part.split('\n');
  const compactedLines: string[] = [];
  for (const line of lines) {
    const key = normalizePromptLineForCompaction(line);
    if (key && hasSeenPromptLineOverlap(key, seen)) {
      continue;
    }
    compactedLines.push(line);
    if (key) {
      seen.add(key);
    }
  }
  return compactedLines.join('\n').trim();
}

function hasSeenPromptLineOverlap(key: string, seen: Set<string>): boolean {
  if (seen.has(key)) {
    return true;
  }
  for (const existing of seen) {
    if (key.includes(existing) || existing.includes(key)) {
      return true;
    }
  }
  return false;
}

function normalizePromptLineForCompaction(line: string): string | null {
  const normalized = line
    .replace(/[ \t]+/g, ' ')
    .trim()
    .toLowerCase();
  return normalized.length >= 48 ? normalized : null;
}

// ──────────────────────────────────────────────────────────────────
// PipelineStrategy gate.evaluator — 拒绝率门控
// ──────────────────────────────────────────────────────────────────

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
