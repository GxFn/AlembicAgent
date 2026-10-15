import { describeSubmitToolFields } from '@alembic/core/knowledge';
import { hasPersistedCandidate, isKnowledgeSubmit } from '../utils/toolOutcomes.js';

// ──────────────────────────────────────────────────────────────────
// Producer / Scan 共享的 knowledge.submit 合同（L6-P23 C59：提交字段合同单源）
// ──────────────────────────────────────────────────────────────────
//
// 此前冷启动 Producer（insightProducer）、拒绝重试提示（本文件）与 scan 提示（scanPrompts）各写
// 一份字段清单，已经漂移：重试提示要求 content.pattern（门禁把它当逐字证据探针）、漏 whenClause /
// dontClause；scan 示例写裸路径；系统提示把软规则写成必拒。现在三处只复用下面三段常量。
//
// 放在本模块的原因（边界说明）：insightProducer.ts 与 scanPrompts.ts 经 prompts/index.ts 的
// `export *` 进入冻结的 @alembic/agent/prompts 公开名集，在它们里面新增导出会改变签名清单；本模块
// 不在 prompts barrel 内，只供 prompts 目录内部共享，不扩公开面。

/**
 * knowledge.submit 字段清单。字段说明取自 Core RecipeAuthoringSpec 的 describeSubmitToolFields
 * （FieldSpec 唯一来源）；必填 / 证据 / 可选的分组由 Agent 当前 submit schema 与门禁决定：
 * dontClause 不在工具 schema 的 required 里，但 Core 门禁 DONT_CLAUSE_REQUIRED 是硬拒，所以列为必填；
 * coreCode 是可选的逐字证据位，不能错标为必填。content.pattern 刻意不列出：门禁同样把它当逐字
 * 证据比对，模型按「代码骨架」理解去填只会新增 SNIPPET_MISMATCH 硬拒。
 */
export const PRODUCER_SUBMIT_FIELD_CONTRACT = buildProducerSubmitFieldContract();

/**
 * 硬门：不满足即被 knowledge.submit 拒绝（Core styleWaiver 软规则集合之外的违规码）。措辞不绑定
 * 某个阶段的工具权限（例如不写「不补读源码」），insight、scan 与重试提示可以共用；
 * 测试会核对这里点名的每个违规码都不是 Core 软规则。
 */
export const PRODUCER_SUBMIT_HARD_GATES = `【硬门——不满足即拒，必须修复后再提交】
- 必填结构：title、description、content.markdown、content.rationale、kind、trigger、whenClause、doClause、dontClause 全部非空（CONTENT_MARKDOWN_REQUIRED / DO_CLAUSE_REQUIRED / DONT_CLAUSE_REQUIRED）。
- 证据引用：维度台账在场时 params.reasoning.evidenceRefs 必填，逐字复制工具返回的真实 E-id 或 E-id@起行-止行；无台账时按当前 schema 提供 reasoning.sources。
- 来源带行号：reasoning.sources 与正文 (来源: …) 一律写 path:起行-止行（完整相对路径），并指向项目内真实文件；裸路径即 SOURCE_REF_LINE_MISSING，不存在的文件即 SOURCE_REF_NOT_FOUND。
- 证据下限：rule / pattern 必须引用至少 3 个不同文件；确属单文件局部的模式/规则时在 params 显式声明 scope: "narrow"，否则改用 kind=fact（INSUFFICIENT_EVIDENCE）。
- coreCode 可选，只能逐字复制已引用行区间内的真实源码；没有合格代码就省略（SNIPPET_MISMATCH）。正文代码块可以提炼，但不能是 operation() / doThing / foo / TODO 之类占位代码（PLACEHOLDER_EVIDENCE）。
- 具体调用链断言（调用方 / 被调用 / caller / callee / invokes）必须有真实 graphRefs 背书，绝不编造（GRAPH_REF_INVALID）；一般的依赖 / 分层 / 边界描述不受此限。`;

/**
 * 风格建议：Core styleWaiver 判为软规则的项（_NON_IMPERATIVE / _NON_ENGLISH 后缀、对比示例、
 * 长度、标题泛化）。2026-07-04 软门不阻断裁定后，只剩这类违规时 knowledge.submit 会先做一次
 * 自动风格修复，再把剩余问题作为 reasoning.styleAdvisories 随候选入库，不会拒绝；口径与
 * GenerateProduce 能力片段「建议——不阻断提交」一致。测试会核对这里点名的每个违规码都是软规则。
 */
export const PRODUCER_SUBMIT_STYLE_ADVISORIES = `【风格建议——不阻断提交；只剩这类问题时候选照常入库，问题作为 style advisory 随候选记录供人工复核，不要为它反复改写同一候选浪费轮次】
- doClause 以英文祈使动词开头（use / prefer / require / keep / validate / ensure / return / follow / …，门禁 45 词白名单），dontClause 以 "Do not …" 开头，均用英文（DO_CLAUSE_NON_IMPERATIVE / DONT_CLAUSE_NON_IMPERATIVE / DO_CLAUSE_NON_ENGLISH）。
- content.markdown 含 ✅ 正确 / ❌ 错误的项目内对比示例（CONTENT_CONTRAST_MISSING）。
- content.markdown ≥200 字符，并含代码块或 (来源: path:行号) 标注（STAGE3_MARKDOWN_TOO_SHORT / STAGE3_MARKDOWN_NEEDS_CODE_OR_FILEREF）。
- 标题具体到项目真实类名 / 机制名，不以项目名开头，避免泛化模式名（STAGE3_TITLE_TOO_GENERIC）。`;

/** 从 Core spec 的字段描述表渲染字段清单（说明 spec-sourced，分组 schema/gate-sourced）。 */
function buildProducerSubmitFieldContract(): string {
  const fields = describeSubmitToolFields();
  const requiredKeys = [
    'title',
    'description',
    'content.markdown',
    'content.rationale',
    'kind',
    'trigger',
    'whenClause',
    'doClause',
    'dontClause',
  ];
  return [
    '## knowledge.submit 必填字段（字段说明取自 Core RecipeAuthoringSpec，避免与门禁漂移）',
    ...requiredKeys.map((key) => `- ${key}: ${fields[key] ?? ''}`),
    '## knowledge.submit 证据字段（按本轮 schema 选择）',
    '- reasoning.evidenceRefs: 维度台账在场时必填，使用真实工具返回的条目 ID；无台账时按当前 schema 提供 sources / reasoning.sources。',
    `- reasoning.sources: ${fields['reasoning.sources'] ?? ''}；每项写 path:起行-止行（裸路径会被拒）；无台账兼容运行直接填写，维度台账运行的来源由宿主依据 reasoning.evidenceRefs 展开。`,
    '## knowledge.submit 可选字段',
    // Core 对 coreCode 的说明写作「代码骨架」，容易被理解成可以改写；门禁实际逐字比对，这里补明。
    `- coreCode: ${fields.coreCode ?? ''}；只能逐字复制已引用行区间内的真实源码（门禁逐字比对），没有合格代码就省略。`,
  ].join('\n');
}

/**
 * Scan 与 insight 的提交修复共用真实回执和字段合同；不改变各自工具权限与重试预算。
 * 重试提示只复用上面的共享合同：content 只要 markdown 与 rationale，长度 / 代码块 / 祈使动词
 * 归入不阻断的风格建议，避免模型为软规则或多余的 content.pattern 浪费有限的重试轮次。
 */
export function buildProducerRetryPrompt(source?: { toolCalls?: readonly unknown[] }): string {
  const rejected = (source?.toolCalls || []).filter(
    (call) => isKnowledgeSubmit(call) && !hasPersistedCandidate(call)
  ).length;
  return [
    `你的 ${rejected} 个提交被拒绝了。逐条阅读拒绝消息里的违规码与 nextAction，只修复被指出的问题后重新提交；拒绝消息含 🛑 STOP 时放弃该候选换下一条，绝不对同一候选第三次重试。`,
    '提交要点: content 只需 { markdown: "...", rationale: "..." } 两个字段；kind 仅 rule/pattern/fact；trigger 用 @kebab-case；description 中文简述 ≤80 字并引用真实类名。',
    PRODUCER_SUBMIT_HARD_GATES,
    PRODUCER_SUBMIT_STYLE_ADVISORIES,
    PRODUCER_SUBMIT_FIELD_CONTRACT,
  ].join('\n\n');
}
