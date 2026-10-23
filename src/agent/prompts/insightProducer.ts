/**
 * insightProducer.ts — Insight Producer 领域函数
 *
 * 从旧 ProducerAgent.js 提取的纯领域逻辑:
 * - Producer System Prompt
 * - 预算常量（produce 阶段的真实工具面由 tools/runtime/toolsets/GenerateProduce 的 allowedTools 决定）
 * - Prompt 构建器：生产路径只用 v2 buildProducerPromptV2；v1 buildProducerPrompt 仅因公开面冻结
 *   保留，无生产调用方（也不渲染结构化发现与代码证据），已标废弃并随待决事项②处理
 * - 代码上下文注入 (evidenceMap → prompt section)
 *
 * W6-d(A1)拆分:拒绝率门控 producerRejectionGateEvaluator(拆前 :655)及其
 * 私有类型 ReactLoopResult/ToolCallRecord/GateStrategyContext(拆前 :59-75)
 * 已迁往 ../evaluation/gateEvaluators.ts。
 *
 * 引用方: profiles/presets/insightPreset（冷启动 insight Producer 阶段使用
 * PRODUCER_SYSTEM_PROMPT / PRODUCER_BUDGET / buildProducerPromptV2）与
 * evaluation/stageBuilders（scan Producer 复用 buildCodeContextSection）；
 * 其余导出经 prompts/index 的 export * 进入公开面。
 * 不再包含任何 Agent 类 — Agent 由 AgentRuntime + PipelineStrategy 驱动。
 *
 * @module insightProducer
 */

import { renderGuidance } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { RECIPE_PRODUCTION_PROFILE_PROMPT } from '../../tools/runtime/recipeProductionContract.js';
import {
  type CodeSnippet,
  type EvidenceEntry,
  isDocEvidencePath,
} from '../evidence/EvidenceCollector.js';
import { buildProducerFindingsSection } from './producerFindings.js';
// L6-P23（C59）：字段合同与软硬门禁分级的单源在 producerRetry（不在公开 barrel 内），冷启动、
// scan 与拒绝重试三处提示共用，避免再出现手写副本漂移。
import {
  PRODUCER_SUBMIT_FIELD_CONTRACT,
  PRODUCER_SUBMIT_STYLE_ADVISORIES,
} from './producerRetry.js';

// ──────────────────────────────────────────────────────────────────
// 本地类型定义
// ──────────────────────────────────────────────────────────────────

interface ProducerEvidenceStarter {
  hint: string;
  data?: unknown;
  strength?: number;
  weight?: number;
}

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
  /** R2: Analyst 真实 graph 查询物化的可复制 refs（无 graph 调用时为空/缺失） */
  graphEvidence?: string[];
}

/** 维度配置 */
interface DimConfig {
  id: string;
  label: string;
  allowedKnowledgeTypes?: string[];
  outputType?: string;
  /** G2: plan 按项目规模折算的本维度候选数量建议（引导非硬限，宿主注入） */
  suggestedCandidateRange?: { min: number; max: number };
}

/** 项目基本信息 */
interface ProjectInfo {
  name: string;
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
6. 提供完整的 Cursor 必填交付字段 (trigger, doClause, whenClause, dontClause 等)；coreCode 仅在有合格 bounded code evidence 时可选提供
7. 标注所属模块/包名（如「所属模块: AOXNetworkKit」），特别是来自本地子包的知识

工作流程:
1. 阅读结构化发现，识别每个独立的知识点/发现
2. 只使用结构化发现中的 evidence、Analyst evidence refs 和已给出的代码片段；Producer 阶段不补读源码
3. 调用 knowledge({ action: "submit", params: { ... } }) 提交知识候选（内置查重和校验）
4. 目标候选提交完成后直接总结；只有工具错误或证据不确定时才用 meta({ action: "review" }) 自检

关键规则:
- 结构化发现中的每个要点都应转化为至少一个候选；不要把最终 Markdown 里未结构化记录的主题当成额外提交义务
- 不要调用 code.read、search、graph 或 terminal；缺少短代码片段时使用 Analyst 已给出的证据摘要完成候选，证据不足才在最终总结中列为 blocker
- 维度台账在场时 params.reasoning.evidenceRefs 必填，使用工具返回的真实 E-id；宿主据此展开来源。无台账且当前 schema 要求时，reasoning.sources 非空并提供真实 sources，禁止只写文件名。
- sourceRefs / reasoning.sources 只服务最终候选证据；不要为了满足指标编造模块别名、类名或不存在路径
- content.markdown 中的来源标注使用完整相对路径+行号: (来源: Full/Path/FileName.ext:行号)
- 每次 knowledge.submit 前先自检 params.title、params.description、content.markdown、content.rationale、kind、trigger、whenClause、doClause 以及当前 schema 要求的 reasoning.evidenceRefs 或来源字段非空；缺少 title/description 等字段会被工具拒绝并浪费 Producer 轮次
- Analyst 结构化发现已全部提交后，不再调用 meta.review，直接输出最终总结
- 如果分析提到了 3 个模式，就应该提交 3 个候选，不要合并
- 禁止: 不要搜索新文件、不要做额外分析、不要使用终端工具，专注于格式化和提交
- 【跨维度去重】每条候选必须聚焦当前维度独有的视角，不得将同一知识点换个说法重复提交。相同的类/模式只在最相关的维度出现一次，宁可少提交也不要充数

🚨 过门禁硬约束（不满足即拒，白白浪费提交轮次；按此逐条自检后再 submit）:
- 展示性 sourceRefs / content.markdown 的 (来源: …) 必须【逐字复制】上面 Analyst evidence refs 里的「path:起行-止行」，务必带行号——绝不能只写路径（否则 SOURCE_REF_LINE_MISSING）。
- rule / pattern 候选必须引用【至少 3 个不同文件】的 path:行（evidence refs 已给多个，选最相关的 3+ 个）；确实只涉及单文件时，才在 params 里显式加 scope: "narrow"（否则 INSUFFICIENT_EVIDENCE）。
- coreCode 必须【逐字复制】上面「可复制 coreCode」提供的真实代码（它是接地证据位，凭空写会 SNIPPET_MISMATCH）；确无对应代码时省略 coreCode。
- content.markdown 的代码块可以提炼，但绝不能是 operation() / doThing / foo / TODO 之类占位代码（否则 PLACEHOLDER_EVIDENCE）。
- doClause 与 dontClause 都必须非空（否则 DO_CLAUSE_REQUIRED / DONT_CLAUSE_REQUIRED）；措辞要求见下方风格建议。
- 「依赖 / 分层 / 边界 / 上下游」等架构描述可正常使用（接地由 sourceRefs/coreCode 覆盖）。只有【具体调用链断言】（调用链 / 调用方 / 被调用 / caller / callee / invokes）需要 graph 背书：若下方提供了「可复制 graphRefs」，逐字复制相关条目进 reasoning.graphRefs；没有提供就不要写调用链断言，改为描述边界与结构。绝不自行编造 graphRefs（否则 GRAPH_REF_INVALID）。
- sourceRefs / (来源:) 必须指向真实项目文件；精确 bounded 文档引用可为 retrieval profile 事实提供 provenance，但文档绝不可作为 coreCode 证据。coreCode 只能来自真实源码或配置文件的合格 bounded range。
- 拒绝消息含 🛑 STOP 时必须立即遵守：放弃当前候选换下一条，或直接输出最终总结——绝不对同一候选第三次重试。

${PRODUCER_SUBMIT_STYLE_ADVISORIES}
- content.markdown 的代码块是「项目特写」的**范式模板**：以证据代码为素材提炼出可直接复用的规范形态（可去噪、简化、突出模式骨架），配 (来源: path:行号) 标注——不要整段粘贴项目原文充当正文代码（原文混乱无序，无范式意义）。

容错规则:
- 直接使用分析文本中已有的代码和描述来提交候选
- 永远不要因为缺少额外文件读取而跳过知识点 — 分析文本已经包含足够信息
- 先提交真实候选；sourceRef 不确定时保留已知真实路径，不要编造路径`;

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

// 字段清单 PRODUCER_SUBMIT_FIELD_CONTRACT 改由 ./producerRetry.ts 单源提供（Core describeSubmitToolFields
// 渲染说明、Agent schema/门禁决定必填与可选分组），与 scan 提示和拒绝重试提示逐字一致。

// Core 字段说明仍是单一来源；阶段接线说明由 Agent 持有，不能把通用补读建议带入禁补读阶段。
const PRODUCER_SUBMIT_REQUIREMENTS = `提交要求（以本次工具 schema 为准）:
1. 只将 Analyst 已确认的结构化发现转为候选，不按 Markdown 段落凑数量。
2. Producer 不补读源码；缺证据时只检索已有 evidence 台账，仍不足则列为 blocker。
3. 维度台账在场时 params.reasoning.evidenceRefs 必填，逐字复制工具 [evidence] 中的 E-id 或 E-id@起行-止行；不能用裸路径代替。
4. 无台账的兼容运行按当前 schema 提供真实 sources / reasoning.sources；不要编造 E-id。来源采用完整相对路径及已验证行号。
5. description 中文简述 ≤80 字，引用真实类名；content 必须同时包含 markdown 与 rationale。kind 仅 rule/pattern/fact。
6. trigger、whenClause、doClause、dontClause 按字段说明填写；coreCode 可选且只能逐字复制已提供的合格代码片段。`;

// ──────────────────────────────────────────────────────────────────
// Prompt 构建
// ──────────────────────────────────────────────────────────────────

/**
 * I37：维度约束里的 knowledgeType 说明。维度声明了允许列表时由模型按候选内容自选并填入
 * params.knowledgeType（维度 submit schema 同时广告同一列表的可选 enum）；缺失或不在列表内时
 * 宿主回落列表第一个并记录诊断（tools/runtime/handlers/knowledge/input.ts）。无列表时不限制。
 */
function describeKnowledgeTypeConstraint(allowedKnowledgeTypes: string[] | undefined): string {
  const allowed = [
    ...new Set(
      (allowedKnowledgeTypes || [])
        .filter((type): type is string => typeof type === 'string')
        .map((type) => type.trim())
        .filter((type) => type.length > 0)
    ),
  ];
  if (allowed.length === 0) {
    return '- 允许的 knowledgeType: (all)';
  }
  return `- knowledgeType: 按候选内容从本维度允许的类型中自选一个填入 params.knowledgeType（允许: ${allowed.join(', ')}）；缺失或不在列表内时宿主回落为 ${allowed[0]} 并记录诊断`;
}

/**
 * 构建 Producer Prompt (v1 — 用于 AnalysisReport)
 *
 * @param dimConfig { id, label, allowedKnowledgeTypes, outputType }
 * @param projectInfo { name }
 * @deprecated 生产只用 buildProducerPromptV2；v1 不渲染结构化发现与代码证据，与系统提示
 *   “唯一候选义务来自结构化发现”冲突。宿主只在测试中引用。随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
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
${describeKnowledgeTypeConstraint(dimConfig.allowedKnowledgeTypes)}
- category: 只能填写业务/组件分类（View/Service/Tool/Model/Network/Storage/UI/Utility），不要填写维度 ID
- 提交时必须让 knowledge 工具携带 dimensionId=${dimConfig.id}；不要用 category 或 knowledgeType 表示维度归属`);

  parts.push(STYLE_GUIDE);
  parts.push(PRODUCER_SUBMIT_FIELD_CONTRACT);
  parts.push(PRODUCER_SUBMIT_REQUIREMENTS);
  parts.push(RECIPE_PRODUCTION_PROFILE_PROMPT);

  // 段内可能是可复制代码或不同发现，不得做行级/子串去重。只合并完全相同的完整段。
  return [...new Set(parts)].join('\n\n');
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
  toolPolicyHints?: Record<string, unknown> | null,
  /** G3: 冷启动预计算的加权统计/结构证据（命名前缀占比、继承热点等），供「为什么这样选」引用 */
  evidenceStarters?:
    | ReadonlyArray<ProducerEvidenceStarter>
    | Readonly<Record<string, ProducerEvidenceStarter>>
    | null,
  /** M1b（挖掘产出升级 P5a）：本维度已入库知识标题——查重视野，模式中性（bootstrap 饱和库/rescan 皆可） */
  existingDimensionTitles?: ReadonlyArray<{
    id?: string;
    title: string;
    trigger?: string;
  }> | null
) {
  const parts: string[] = [];

  parts.push(`将以下对 ${projectInfo.name} 项目 "${dimConfig.label}" 维度的分析，转化为知识候选:`);
  const analysisDigest = buildAnalysisDigest(artifact.analysisText, artifact.findings);
  if (analysisDigest) {
    parts.push(`## Analyst 分析摘要 (已压缩)\n${analysisDigest}`);
  }

  const findingsSection = buildProducerFindingsSection(artifact.findings || []);
  if (findingsSection) {
    parts.push(findingsSection);
  }

  // §4 代码证据
  const codeContext = buildCodeContextSection(
    artifact.evidenceMap,
    new Set((artifact.findings || []).map((finding) => finding.finding))
  );
  if (codeContext) {
    parts.push(codeContext);
  }

  // §4b graph 证据（R2）：只有 Analyst 真实调过 graph 工具才渲染。关系声明（依赖/调用链/
  // 上游下游等词）过 GRAPH_REF 门禁需要非空 graphRefs——把真实查询物化为可逐字复制的 ref，
  // 而不是让模型在「阉割关系表述」与「编造 ref」之间二选一。
  if (artifact.graphEvidence && artifact.graphEvidence.length > 0) {
    const graphLines = ['## 🕸 可复制 graphRefs (Analyst 真实 graph 查询)'];
    graphLines.push(
      '候选含【具体调用链断言】（调用链 / 调用方 / 被调用 / caller / callee / invokes）时，从下面逐字复制相关条目放进 reasoning.graphRefs（数组）；一般依赖 / 分层 / 边界描述不需要。'
    );
    for (const ref of artifact.graphEvidence.slice(0, 8)) {
      graphLines.push(`- ${ref}`);
    }
    parts.push(graphLines.join('\n'));
  }

  // §4c 项目统计与结构证据（G3）：EvidenceStarters 在冷启动已算好命名前缀占比/类型分布/
  // 继承热点/耦合热点等量化事实——STYLE_GUIDE 要求写「为什么这样选(统计分布、占比)」，此前
  // 素材备好却从未端给 Producer，模型只能泛泛而谈。渲染 top-6 加权证据供直接引用。
  const starters = Array.isArray(evidenceStarters)
    ? evidenceStarters
    : Object.values(evidenceStarters || {});
  if (starters.length > 0) {
    const statLines = ['## 📊 项目统计与结构证据（写「为什么这样选」时可直接引用这些量化事实）'];
    const sorted = [...starters]
      .filter(
        (s): s is ProducerEvidenceStarter =>
          !!s && typeof (s as { hint?: unknown }).hint === 'string'
      )
      .sort((a, b) => (b.strength ?? b.weight ?? 0) - (a.strength ?? a.weight ?? 0))
      .slice(0, 6);
    for (const starter of sorted) {
      const dataText =
        starter.data === undefined || starter.data === null
          ? ''
          : `: ${limitText(JSON.stringify(starter.data), 220)}`;
      statLines.push(`- ${starter.hint}${dataText}`);
    }
    if (statLines.length > 1) {
      parts.push(statLines.join('\n'));
    }
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

  // §7 维度约束（含 G2：plan 按项目规模折算的数量建议——引导非硬限，条数由模型按发现质量自判）
  const rangeHint = dimConfig.suggestedCandidateRange
    ? `\n- 数量建议: plan 按项目规模为本维度建议约 ${dimConfig.suggestedCandidateRange.min}-${dimConfig.suggestedCandidateRange.max} 条。宁深勿多——只有挖到足够深的知识点才提交，不为凑数灌水；发现确实多于建议时也可以超出，由你按发现质量自判`
    : '';
  parts.push(`维度约束:
- dimensionId: ${dimConfig.id}
${describeKnowledgeTypeConstraint(dimConfig.allowedKnowledgeTypes)}
- category: 只能填写业务/组件分类（View/Service/Tool/Model/Network/Storage/UI/Utility），不要填写维度 ID
- 提交时必须让 knowledge 工具携带 dimensionId=${dimConfig.id}；不要用 category 或 knowledgeType 表示维度归属${rangeHint}`);

  // §8 写作指南 + 提交要求
  parts.push(STYLE_GUIDE);
  parts.push(PRODUCER_SUBMIT_FIELD_CONTRACT);
  parts.push(PRODUCER_SUBMIT_REQUIREMENTS);
  parts.push(RECIPE_PRODUCTION_PROFILE_PROMPT);
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

  // §9c（M1b 挖掘产出升级）：已入库知识查重视野——模式中性（不带 rescan 预算语义）。
  // 饱和库上 producer 此前对已有知识全盲，盲写→gateway 静默拒重烧整回合；rescan 模式
  // 已有 §9a 渲染同类信息时跳过本节避免重复。
  if (
    (!rescanContext || !(rescanContext.existingRecipes?.length > 0)) &&
    existingDimensionTitles &&
    existingDimensionTitles.length > 0
  ) {
    const kLines = [
      '## 📚 本维度已入库知识（查重视野）',
      '以下标题已存在，实质相同的发现不要重复提交（会被查重拒绝，浪费提交回合）：',
    ];
    for (const r of existingDimensionTitles.slice(0, 15)) {
      kLines.push(
        `- ${r.id ? `[${r.id}] ` : ''}"${r.title}"${r.trigger ? `（trigger: ${r.trigger}）` : ''}`
      );
    }
    kLines.push(
      '仅当你的证据明显更全/更新且确有增量时，才带 supersedes:<已有条目 id> 提交升级版；否则跳过换下一个发现。'
    );
    parts.push(kLines.join('\n'));
  }

  // 段内可能是可复制代码或不同发现，不得做行级/子串去重。只合并完全相同的完整段。
  return [...new Set(parts)].join('\n\n');
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
  const knownFindings = new Set((findings || []).map((finding) => finding.finding));
  const lines = [
    ...new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !knownFindings.has(line))
    ),
  ];
  if (lines.length === 0) {
    return null;
  }
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

/** 证据段总预算（字符）：引用行与「可复制 coreCode」行共用。 */
const CODE_CONTEXT_BUDGET = 1600;

/**
 * 第一遍引用行的单独上限。引用行先于代码渲染，保证 rule/pattern 的「至少 3 个不同文件」有素材；
 * 上限低于总预算，给第二遍的代码片段至少留出 CODE_CONTEXT_BUDGET - CODE_CONTEXT_REF_BUDGET 字符。
 */
const CODE_CONTEXT_REF_BUDGET = 960;

/** 每个条目最多渲染的片段数（与 EvidenceCollector 每文件片段上限一致）。 */
const MAX_RENDERED_SNIPPETS = 3;

/** 每个片段注入的逐字代码前缀上限（字符）。 */
const CORE_CODE_PREFIX_CHARS = 220;

/** 文档 provenance 节、背景文件节与省略提示里最多列出的路径数。 */
const MAX_LISTED_PATHS = 8;

/** 已进入第一遍引用列表的代码证据条目及其在第二遍分到的代码行。 */
interface RenderedEvidenceEntry {
  entry: EvidenceEntry;
  snippets: CodeSnippet[];
  groundedRefs: string[];
  refLine: string;
  codeLines: string[];
}

/** 引用行的两种形态：紧凑形态只有 path:起-止 与 role；引用预算有余量时升级为带摘要的完整形态。 */
function renderEvidenceRefLine(
  entry: EvidenceEntry,
  groundedRefs: readonly string[],
  knownSummaries: ReadonlySet<string> | undefined,
  withSummary: boolean
): string {
  const role = entry.role ? ` (${entry.role})` : '';
  const summary =
    withSummary && entry.summary && !knownSummaries?.has(entry.summary)
      ? ` — ${limitText(entry.summary, 140)}`
      : '';
  return `- ${groundedRefs.join(', ')}${role}${summary}`;
}

/** 列表超出展示上限时只列前若干项，并写明未列出的数量（不静默截断）。 */
function listPathsBounded(paths: readonly string[], separator = ', '): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).join(separator);
  const hidden = paths.length - MAX_LISTED_PATHS;
  return hidden > 0 ? `${shown}（另有 ${hidden} 个未列出）` : shown;
}

/** 证据段的截断/降级诊断：只做旁路记录，日志器异常不得打断提示构建。 */
function logEvidenceSectionDegraded(message: string): void {
  observeSafely(
    () => Logger.getInstance().info(message),
    () => undefined
  );
}

/**
 * 从 evidenceMap 构建 Producer 证据引用段（refs-first，有界，两遍渲染）。
 *
 * - 分流：非文档且带行号片段的条目进入「可逐字复制」列表；带行号片段的文档条目单独成
 *   「文档 provenance 引用」节，保留 `path:起-止` 但只可写入 reasoning.sources 作为 retrieval-profile
 *   事实的 provenance，不输出可复制 coreCode、不计入 rule/pattern 的代码证据（L6-P22 / C61）；
 *   没有任何行号片段的条目（含文档）才降为「背景文件(无行号)」，明确不可用作 sourceRefs。
 * - 第一遍（L6-P22 / C60）：条目按片段数降序，先为每个代码条目渲染一行不带摘要的紧凑引用
 *   `path:起-止`（每条最多 3 个片段），引用行有单独上限 CODE_CONTEXT_REF_BUDGET，放不下才整条省略；
 *   再用引用预算余量按顺序补上摘要。覆盖优先，3 个满额文件（3 片段 × 30 行）的引用一定都在场。
 * - 第二遍：用总预算 CODE_CONTEXT_BUDGET 扣除引用行后的剩余预算，按条目轮转注入「可复制 coreCode」
 *   （每个文件先注入首片段，再轮到第 2、3 片段），每片段不超过 220 字符的逐字源码前缀，
 *   供候选照抄以通过 snippet-match 门禁；代码行仍紧跟所属条目的引用行。
 * - 预算耗尽时在段尾写明「另有 N 个证据文件因预算未展开…」与「因引用预算未列出」的数量，
 *   并打 info 诊断（触发条件、条目数、两遍预算用量、被省略的路径），不再静默丢弃。
 * - 冷启动 insight Producer（buildProducerPromptV2）与 scan Producer（evaluation/stageBuilders）
 *   共用本函数；是否允许 Producer 再用 code.read 补读源码，由各自的系统提示与工具白名单决定，
 *   不由本函数决定。
 */
export function buildCodeContextSection(
  evidenceMap: Map<string, EvidenceEntry> | null | undefined,
  knownSummaries?: ReadonlySet<string>
) {
  if (!evidenceMap || evidenceMap.size === 0) {
    return null;
  }

  const parts = [
    '## 📄 Analyst evidence refs (bounded)',
    // 关键:证据 ref 直接呈现为门禁要求的 `path:起-止行` 形态，Producer 应把它们【逐字复制】进 sourceRefs
    // 与 content.markdown 的 (来源: path:行号)，务必带行号。rule/pattern 候选至少引用 3 个不同文件。
    // 只有「- 」开头的行是可复制代码引用；段尾的文档 provenance 节与背景文件节各自写明用途限制。
    '下面以「- 」开头的每条是可【逐字复制】的接地引用(path:起行-止行)。把它们直接用作 sourceRefs 与 (来源: path:行号)，务必带行号；rule/pattern 至少引 3 个不同文件。缺精确短代码片段时用 Analyst 摘要完成候选或在总结列为 blocker，不要编造路径或行号。',
  ];

  const sortedEntries = [...evidenceMap.values()]
    .filter((e) => e.filePath || e.summary || e.codeSnippets.length > 0)
    .sort((a, b) => b.codeSnippets.length - a.codeSnippets.length);

  // 分流。无行号片段的条目不能混进「可逐字复制」列表：裸路径被照抄进 sourceRefs 必触发
  // SOURCE_REF_LINE_MISSING。降级为背景文件，显式告知不可用作 sourceRefs。
  const backgroundFiles: string[] = [];
  // 文档类文件(md 等)绝不进可复制代码列表：协作/设计文档是二手描述，渲染成可复制 ref + coreCode 会诱导
  // 模型提交「抄文档」候选（真机 architecture 维度曾因此 10 提交全拒）。但带精确区间的文档引用是
  // retrieval profile 契约允许的 provenance（RECIPE_PRODUCTION_PROFILE_PROMPT），所以保留区间、单独成节。
  const docProvenanceRefs: string[] = [];
  const codeCandidates: Array<{
    entry: EvidenceEntry;
    snippets: CodeSnippet[];
    groundedRefs: string[];
  }> = [];
  for (const entry of sortedEntries) {
    // 旧写法 `path [L42-58]` 与门禁 SOURCE_REF_RE(`path:42-58`)不符，DeepSeek 常只复制路径、丢掉
    // `[L42-58]`，触发 SOURCE_REF_LINE_MISSING。改为把每个行范围渲染成 `path:起-止`，
    // 使证据引用可被逐字复制进候选、直接过门禁的行号与 snippet 匹配判据。
    const snippets = entry.codeSnippets.slice(0, MAX_RENDERED_SNIPPETS);
    const groundedRefs = snippets.map(
      (snippet) => `${entry.filePath}:${snippet.startLine}-${snippet.endLine}`
    );
    if (groundedRefs.length === 0) {
      backgroundFiles.push(entry.filePath);
      continue;
    }
    if (isDocEvidencePath(entry.filePath)) {
      docProvenanceRefs.push(groundedRefs.join(', '));
      continue;
    }
    codeCandidates.push({ entry, snippets, groundedRefs });
  }

  // 第一遍：引用行，覆盖优先。1a 先为每个条目放紧凑行（只有 path:起-止 与 role，不带摘要），放不下
  // 才省略整条；首条永远保留，与旧实现“首条必渲染”的口径一致，避免超长路径让整段为空。
  // 1b 再用引用预算的余量按顺序把紧凑行升级为带摘要的完整行——摘要只是辅助说明，不能挤掉别的文件引用。
  const rendered: RenderedEvidenceEntry[] = [];
  const refsDroppedPaths: string[] = [];
  let refChars = 0;
  for (const candidate of codeCandidates) {
    const compact = renderEvidenceRefLine(
      candidate.entry,
      candidate.groundedRefs,
      knownSummaries,
      false
    );
    if (rendered.length > 0 && refChars + compact.length > CODE_CONTEXT_REF_BUDGET) {
      refsDroppedPaths.push(candidate.entry.filePath);
      continue;
    }
    rendered.push({
      entry: candidate.entry,
      snippets: candidate.snippets,
      groundedRefs: candidate.groundedRefs,
      refLine: compact,
      codeLines: [],
    });
    refChars += compact.length;
  }
  let summariesDropped = 0;
  for (const item of rendered) {
    const full = renderEvidenceRefLine(item.entry, item.groundedRefs, knownSummaries, true);
    const extra = full.length - item.refLine.length;
    if (extra <= 0) {
      continue;
    }
    if (refChars + extra <= CODE_CONTEXT_REF_BUDGET) {
      item.refLine = full;
      refChars += extra;
    } else {
      summariesDropped++;
    }
  }

  // 第二遍：剩余预算按条目轮转注入可复制 coreCode。每个片段都可能是 finding 真正引用的代码
  // （R1 锚点补齐的深处片段常排在头部窗口之后），轮转保证预算先覆盖更多文件而不是被前两个
  // 满额文件吃光。沿用旧实现“先判预算再追加”的口径：最后一行可略超预算，代码截断保持逐字前缀。
  const codeBudget = Math.max(0, CODE_CONTEXT_BUDGET - refChars);
  let codeChars = 0;
  let expandedSnippets = 0;
  rounds: for (let round = 0; round < MAX_RENDERED_SNIPPETS; round++) {
    for (const item of rendered) {
      const snippet = item.snippets[round];
      if (!snippet?.content?.trim()) {
        continue;
      }
      if (codeChars >= codeBudget) {
        break rounds;
      }
      const code = truncateCodeVerbatim(snippet.content, CORE_CODE_PREFIX_CHARS);
      const codeLine = `    可复制 coreCode(来源 ${item.entry.filePath}:${snippet.startLine}-${snippet.endLine}): ${code}`;
      item.codeLines.push(codeLine);
      codeChars += codeLine.length;
      expandedSnippets++;
    }
  }

  // 有正文却因预算没注入代码的片段：它们的引用仍在上面，但不能据此编写 coreCode。
  // 提示里只给数量——这些文件的引用行已在上方，重复列路径只会挤占提示预算。
  const unexpandedFiles: string[] = [];
  let expandableSnippets = 0;
  for (const item of rendered) {
    parts.push(item.refLine, ...item.codeLines);
    const withContent = item.snippets.filter((snippet) => snippet?.content?.trim()).length;
    expandableSnippets += withContent;
    if (item.codeLines.length < withContent) {
      unexpandedFiles.push(item.entry.filePath);
    }
  }

  if (unexpandedFiles.length > 0) {
    parts.push(
      `另有 ${unexpandedFiles.length} 个证据文件因预算未展开部分可复制 coreCode（${expandableSnippets - expandedSnippets} 个片段只列引用）：这些引用仍可逐字用作 sourceRefs/(来源:)；coreCode 只能逐字复制上方已展开的片段，不要为未展开的引用编写代码。`
    );
  }
  if (refsDroppedPaths.length > 0) {
    // 不列出被省略文件的裸路径：裸路径被照抄进 sourceRefs 必触发 SOURCE_REF_LINE_MISSING。
    parts.push(
      `另有 ${refsDroppedPaths.length} 个证据文件因引用预算未列出：不要凭记忆为它们手写路径或行号。`
    );
  }
  if (docProvenanceRefs.length > 0) {
    parts.push(
      `文档 provenance 引用(仅可逐字写入 reasoning.sources，作为 retrieval-profile 事实的 provenance；不可作 coreCode，不计入 rule/pattern 的 3 文件代码证据): ${listPathsBounded(docProvenanceRefs, '; ')}`
    );
  }
  if (backgroundFiles.length > 0) {
    parts.push(
      `背景文件(无行号证据，绝不可用作 sourceRefs/(来源:)): ${listPathsBounded(backgroundFiles)}`
    );
  }

  const listOverflow =
    Math.max(0, docProvenanceRefs.length - MAX_LISTED_PATHS) +
    Math.max(0, backgroundFiles.length - MAX_LISTED_PATHS);
  if (
    refsDroppedPaths.length > 0 ||
    summariesDropped > 0 ||
    unexpandedFiles.length > 0 ||
    listOverflow > 0
  ) {
    logEvidenceSectionDegraded(
      `[producer-evidence-refs] budget-exhausted codeEntries=${codeCandidates.length} refsListed=${rendered.length} refsDropped=${refsDroppedPaths.length} summariesDropped=${summariesDropped} codeExpanded=${expandedSnippets}/${expandableSnippets} unexpandedFiles=${unexpandedFiles.length} refChars=${refChars}/${CODE_CONTEXT_REF_BUDGET} codeChars=${codeChars}/${codeBudget} docProvenance=${docProvenanceRefs.length} background=${backgroundFiles.length} listOverflow=${listOverflow} droppedPaths=[${refsDroppedPaths.slice(0, MAX_LISTED_PATHS).join(', ')}] unexpandedPaths=[${unexpandedFiles.slice(0, MAX_LISTED_PATHS).join(', ')}]`
    );
  }

  return parts.length > 1 ? parts.join('\n') : null;
}
