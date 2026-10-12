/**
 * insightEvolver.ts — Evolution Agent 领域函数
 *
 * Evolution Agent 是管线中的专职进化角色：
 *   - 接收当前维度的**全部**现有 Recipe（不仅是衰退的）
 *   - 使用工具读取真实代码，验证每个 Recipe 的真实性
 *   - 通过**附加提案**（Proposal）驱动状态变更，不创建新 Recipe
 *   - 三种决策: knowledge.manage 的 operation = evolve / deprecate / skip_evolution
 *     （旧工具名 propose_evolution / confirm_deprecation / skip_evolution 已无生产者，
 *     只在 utils/toolOutcomes.ts 的兼容路径里按 status 读取；manage 回执只认 Core outcome）
 *
 * 被 PipelineStrategy 的 evolution preset 引用。
 * 按维度隔离：每个维度的 Evolve Stage 只处理属于该维度的 Recipe。
 *
 * @module insightEvolver
 */

// ──────────────────────────────────────────────────────────────────
// Local types
// ──────────────────────────────────────────────────────────────────

/**
 * 静态审计 hint（可选）— 来自证据审计。
 *
 * evidence 与 Core `RelevanceAuditResult.evidence` 同义：
 *   - symbolsAlive / codeFilesExist 是**计数**（仍存活的符号/引用数、仍存在的代码文件数），
 *     不是 0..1 比例；提示按计数渲染，绝不能 ×100 渲染成百分比（否则 1 个存活会显示成 100%）。
 *   - 宿主 RescanContext 在 auditEvidence 缺失时传入 `{}`，所以运行时这些字段可能缺失；
 *     渲染端把缺失/非有限数值与缺失布尔一律渲染成「未知」，而不是 NaN% 或 ❌。
 */
export interface AuditHint {
  relevanceScore: number;
  verdict: string; // healthy | watch | decay | severe
  evidence: {
    triggerStillMatches: boolean;
    /** 计数：仍存活的符号/引用数（Core activeCount / health.active / existCount） */
    symbolsAlive: number;
    depsIntact: boolean;
    /** 计数：仍存在的代码文件数；渲染时若 sourceRefs 非空则写成 N/sourceRefs 数 */
    codeFilesExist: number;
  };
  decayReasons: string[];
}

/** 现有 Recipe（含可选的 audit hint 与增量 rescan 影响证据） */
export interface ExistingRecipeForEvolution {
  id: string;
  title: string;
  trigger: string;
  content?: { markdown?: string; rationale?: string; coreCode?: string };
  sourceRefs?: string[];
  /** 静态审计 hint — 仅供参考，Agent 应通过读代码自行验证 */
  auditHint?: AuditHint | null;
  /**
   * diff-based 影响证据（增量 rescan 管线提供，此时 auditHint 为 null）。
   * 与 `EvolutionAuditRecipe.impactEvidence` / Core `EvolutionAuditRecipe.impactEvidence` 对齐；
   * 这里 reason 放宽为 string，只做提示渲染，避免与 Core 的候选原因枚举耦合。
   * 提示中渲染为「变更影响（仅供定位）」，模型仍须以读到的代码为准。
   */
  impactEvidence?: {
    reason: string;
    affectedFiles: string[];
    /** 0..1 的影响分（Core RecipeImpactPlanner），原样保留两位小数渲染 */
    impactScore: number;
    matchedTokens: string[];
  };
}

/** Evolution Agent 上下文 */
export interface EvolutionContext {
  /** 当前维度的全部现有 Recipe（healthy + decaying），按维度过滤后注入 */
  existingRecipes: ExistingRecipeForEvolution[];
  dimensionId: string;
  dimensionLabel: string;
  projectOverview: {
    primaryLang: string;
    fileCount: number;
    modules: string[];
  };
  toolPolicyHints?: Record<string, unknown> | null;
}

// ──────────────────────────────────────────────────────────────────
// System Prompt
// ──────────────────────────────────────────────────────────────────

export const EVOLVER_SYSTEM_PROMPT = `你是 Alembic 的 **Evolution Agent**，专职验证项目中现有知识条目（Recipe）的真实性与时效性。

## 核心职责

你通过阅读项目真实代码来验证每条 Recipe 是否仍然反映当前项目实践。
你的工作结果以**提案（Proposal）**方式附加到现有 Recipe 上，推动知识库的渐进式演化。
你**不创建新 Recipe**——那是后续 Produce 阶段的职责。

## 验证流程

对每个 Recipe 按以下步骤验证:
1. 阅读 Recipe 的核心代码片段和源文件引用，理解其描述的模式
2. 使用 \`knowledge({ action: "search" })\` / \`knowledge({ action: "detail" })\` 获取旧知识上下文（必要时）
3. 使用 \`code({ action: "read" })\` 读取源文件，验证代码是否存在且与 Recipe 描述匹配
4. 如果源文件不存在或代码不匹配，使用 \`code({ action: "search" })\` / \`graph({ action: "query" })\` 搜索该模式是否已迁移到其他位置
5. 基于真实代码的验证结果做出决策

## 决策规则

按以下决策树判断（优先级从上到下）:

| 验证结果 | 决策 | 调用方式 |
|---------|------|---------|
| 源文件存在 + 代码匹配 Recipe 描述 | **跳过**: 仍然有效 | \`knowledge({ action: "manage", params: { operation: "skip_evolution", id: "...", reason: "..." } })\` |
| 源文件存在 + 代码已变化（接口改变/重构） | **进化提案**: 附加变更证据 | \`knowledge({ action: "manage", params: { operation: "evolve", id: "...", data: { ... } } })\` |
| 源文件不存在 + 模式已迁移到新位置 | **进化提案**: 附加迁移证据 | \`knowledge({ action: "manage", params: { operation: "evolve", id: "...", data: { ... } } })\` |
| 源文件不存在 + 完全无替代 | **确认废弃**: 知识已失效 | \`knowledge({ action: "manage", params: { operation: "deprecate", id: "...", reason: "..." } })\` |
| 信息不足以做出判断 | **跳过**: 交给时限机制 | \`knowledge({ action: "manage", params: { operation: "skip_evolution", id: "...", reason: "..." } })\` |

## 工具说明（统一使用 knowledge.manage）

- \`knowledge({ action: "manage", params: { operation: "evolve", id, reason, data: { description, evidence, confidence } } })\` — 为 Recipe 附加进化提案，由 ProposalGateway 统一进入观察窗口或证据升级
- \`knowledge({ action: "manage", params: { operation: "deprecate", id, reason, data: { confidence } } })\` — 确认 Recipe 已过时，由 ProposalGateway 统一决定观察窗口或执行路径
- \`knowledge({ action: "manage", params: { operation: "skip_evolution", id, reason } })\` — 显式跳过，reason 中说明是"验证有效"还是"信息不足"
- \`graph({ action: "query" })\` — 验证符号、模块和调用关系，优先于文本猜测

## 重要约束

- 每个 Recipe 必须有一个明确决策，不要遗漏任何一个
- \`knowledge.manage\` 的 Recipe 标识字段只有 \`id\`，禁止使用 \`recipeId\`
- \`knowledge.manage\` 决策是 Evolution Gate 的硬性质量依据；最终 Markdown 报告不能替代工具调用
- 一旦你已经读到足够证据，就应该立即调用 \`knowledge({ action: "manage", params: ... })\`，不要等到最后总结
- evolve 的 evidence 字段必须包含你读到的真实代码，不要编造
- evolve 的 type 区分: enhance（模式迁移/功能扩展）vs correction（描述错误/接口变更）
- 部分 Recipe 附带系统预检提示（auditHint），仅供参考——你必须以实际读到的代码为准
- 预检提示里的「符号存活」「代码文件存在」是计数（N 或 N/引用总数），不是百分比；「未知」表示审计未提供该项
- 增量 rescan 的 Recipe 附带变更影响（impactEvidence: 入选原因、影响分、受影响文件、命中关键词），仅用于定位优先读取的文件，结论仍以读到的代码为准
- 即使预检提示说"healthy"，你读代码后发现不匹配也要提交提案`;

// ──────────────────────────────────────────────────────────────────
// 工具白名单
// ──────────────────────────────────────────────────────────────────

export const EVOLVER_TOOLS = ['code', 'graph', 'knowledge'];

// ──────────────────────────────────────────────────────────────────
// 预算
// ──────────────────────────────────────────────────────────────────

export const EVOLVER_BUDGET = {
  maxIterations: 20,
  searchBudget: 10,
  searchBudgetGrace: 4,
  maxSubmits: 8,
  softSubmitLimit: 8,
  idleRoundsToExit: 2,
};

// ──────────────────────────────────────────────────────────────────
// 外部证据归一化（审计 hint / 增量 rescan 影响证据）
// ──────────────────────────────────────────────────────────────────

/** 缺失或非法的证据项在提示中统一显示为「未知」，不渲染成 NaN% / ❌ 这类误导值。 */
const UNKNOWN_TEXT = '未知';
/** 每条 Recipe 渲染的受影响文件上限（与 sourceRefs 截断口径一致）。 */
const MAX_IMPACT_FILES = 5;
/** 每条 Recipe 渲染的命中关键词上限。 */
const MAX_IMPACT_TOKENS = 10;
/** 单条诊断事件最多列出的 Recipe 数，避免大维度把一条告警撑爆。 */
const MAX_DIAGNOSTIC_RECIPES = 10;

/** 单条 Recipe 在渲染时被归一化的字段（只进诊断事件，不进提示正文）。 */
interface EvidenceIssue {
  recipeId: string;
  fields: string[];
}

/** PipelineStrategy 注入的 DiagnosticsCollector 只需要 warn 这一个口子。 */
interface EvolverDiagnosticsSink {
  warn(warning: { code: string; message: string; stage?: string }): void;
}

/** 归一化后的影响证据；null 字段表示该项缺失或非法，渲染为「未知」。 */
interface NormalizedImpactEvidence {
  reason: string | null;
  affectedFiles: string[];
  impactScore: number | null;
  matchedTokens: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isDiagnosticsSink(value: unknown): value is EvolverDiagnosticsSink {
  return isRecord(value) && typeof value.warn === 'function';
}

/**
 * 读取 PipelineStrategy 平铺进 promptBuilder 入参的 diagnostics。
 * EvolutionContext 公开类型不声明该字段（不新增公开字段），这里只做结构探测；
 * 直接调用 buildEvolverPrompt（无管线）时没有 sink，归一化结果仍以「未知」写在提示正文里。
 */
function readDiagnosticsSink(context: object): EvolverDiagnosticsSink | null {
  if (!('diagnostics' in context)) {
    return null;
  }
  const sink = context.diagnostics;
  return isDiagnosticsSink(sink) ? sink : null;
}

/** 过滤出非空字符串项；非数组或含非字符串项时把字段名记入 invalid。 */
function readStringItems(value: unknown, field: string, invalid: string[]): string[] {
  if (!Array.isArray(value)) {
    invalid.push(field);
    return [];
  }
  const items = value.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0
  );
  if (items.length !== value.length) {
    invalid.push(`${field}[non-string]`);
  }
  return items;
}

/**
 * 渲染静态审计 hint。evidence 的 symbolsAlive/codeFilesExist 与 Core RelevanceAuditResult 同义，
 * 是计数而不是比例：按「符号存活: N」「代码文件存在: N/引用数」渲染。
 * 宿主在 auditEvidence 缺失时会传 `{}`，缺失/非有限数值与缺失布尔都渲染成「未知」并记入 missing。
 */
function renderAuditHint(hint: unknown, sourceRefCount: number, missing: string[]): string[] {
  if (!isRecord(hint)) {
    missing.push('auditHint[not-an-object]');
    return [];
  }
  const evidence: Record<string, unknown> = isRecord(hint.evidence) ? hint.evidence : {};
  if (!isRecord(hint.evidence)) {
    missing.push('evidence');
  }
  const flag = (field: 'triggerStillMatches' | 'depsIntact'): string => {
    const value = evidence[field];
    if (typeof value === 'boolean') {
      return value ? '✅' : '❌';
    }
    missing.push(field);
    return UNKNOWN_TEXT;
  };
  const count = (field: 'symbolsAlive' | 'codeFilesExist'): number | null => {
    const value = evidence[field];
    if (isFiniteNumber(value)) {
      return value;
    }
    missing.push(field);
    return null;
  };

  const score = isFiniteNumber(hint.relevanceScore) ? `${hint.relevanceScore}/100` : UNKNOWN_TEXT;
  if (!isFiniteNumber(hint.relevanceScore)) {
    missing.push('relevanceScore');
  }
  const verdict =
    typeof hint.verdict === 'string' && hint.verdict.trim().length > 0
      ? hint.verdict
      : UNKNOWN_TEXT;

  const triggerText = flag('triggerStillMatches');
  const symbols = count('symbolsAlive');
  const depsText = flag('depsIntact');
  const files = count('codeFilesExist');
  // 分母只在 sourceRefs 非空且计数不超过引用总数时给出：Core 的影响证据分支用 affectedFiles.length
  // 作为 codeFilesExist，口径可能与 sourceRefs 数不同；超出时只写计数，避免出现 5/3 这类不可能比值。
  let filesText = UNKNOWN_TEXT;
  if (files !== null) {
    filesText =
      sourceRefCount > 0 && files <= sourceRefCount ? `${files}/${sourceRefCount}` : String(files);
  }

  const lines = ['- **系统预检提示** ⚠️ 仅供参考，以你读到的代码为准:'];
  lines.push(`  - 评分: ${score} → ${verdict}`);
  const checks = [
    `Trigger: ${triggerText}`,
    `符号存活: ${symbols === null ? UNKNOWN_TEXT : symbols}`,
    `依赖: ${depsText}`,
    `代码文件存在: ${filesText}`,
  ];
  lines.push(`  - ${checks.join(' | ')}`);
  const decayReasons = readStringItems(hint.decayReasons, 'decayReasons', missing);
  if (decayReasons.length > 0) {
    lines.push(`  - 预检原因: ${decayReasons.join('; ')}`);
  }
  return lines;
}

/**
 * 归一化增量 rescan 的 impactEvidence（外部输入，先校验再渲染）。
 * 非对象整体丢弃；单个字段非法时只丢该字段并记入 invalid，其余合法字段照常渲染。
 * 归一化后没有任何可渲染内容时返回 null，不输出空小节。
 */
function normalizeImpactEvidence(raw: unknown, invalid: string[]): NormalizedImpactEvidence | null {
  if (!isRecord(raw)) {
    invalid.push('impactEvidence[not-an-object]');
    return null;
  }
  const reason =
    typeof raw.reason === 'string' && raw.reason.trim().length > 0 ? raw.reason.trim() : null;
  if (reason === null) {
    invalid.push('reason');
  }
  const affectedFiles = readStringItems(raw.affectedFiles, 'affectedFiles', invalid);
  const impactScore = isFiniteNumber(raw.impactScore) ? raw.impactScore : null;
  if (impactScore === null) {
    invalid.push('impactScore');
  }
  const matchedTokens = readStringItems(raw.matchedTokens, 'matchedTokens', invalid);
  if (
    reason === null &&
    impactScore === null &&
    affectedFiles.length === 0 &&
    matchedTokens.length === 0
  ) {
    return null;
  }
  return { reason, affectedFiles, impactScore, matchedTokens };
}

/** 渲染「变更影响（仅供定位）」：入选原因、影响分、前 5 个受影响文件、前若干命中关键词。 */
function renderImpactEvidence(impact: NormalizedImpactEvidence): string[] {
  const lines = ['- **变更影响（仅供定位，以你读到的代码为准）**:'];
  const scoreText = impact.impactScore === null ? UNKNOWN_TEXT : impact.impactScore.toFixed(2);
  lines.push(`  - 入选原因: ${impact.reason ?? UNKNOWN_TEXT} | 影响分: ${scoreText}`);
  if (impact.affectedFiles.length > 0) {
    lines.push('  - 受影响文件（优先用 `code({ action: "read" })` 读取或确认缺失）:');
    for (const file of impact.affectedFiles.slice(0, MAX_IMPACT_FILES)) {
      lines.push(`    - \`${file}\``);
    }
    if (impact.affectedFiles.length > MAX_IMPACT_FILES) {
      lines.push(`    - ... 及其他 ${impact.affectedFiles.length - MAX_IMPACT_FILES} 个受影响文件`);
    }
  }
  if (impact.matchedTokens.length > 0) {
    const tokens = impact.matchedTokens
      .slice(0, MAX_IMPACT_TOKENS)
      .map((token) => `\`${token}\``)
      .join(', ');
    const rest =
      impact.matchedTokens.length > MAX_IMPACT_TOKENS
        ? ` 等 ${impact.matchedTokens.length} 个`
        : '';
    lines.push(`  - 命中关键词: ${tokens}${rest}`);
  }
  return lines;
}

/** 每类归一化问题汇总成一条诊断事件，写清触发条件、涉及 Recipe 与字段、处理结果。 */
function reportEvidenceIssues(
  sink: EvolverDiagnosticsSink | null,
  code: string,
  summary: string,
  issues: EvidenceIssue[],
  totalRecipes: number
): void {
  if (!sink || issues.length === 0) {
    return;
  }
  const listed = issues
    .slice(0, MAX_DIAGNOSTIC_RECIPES)
    .map((issue) => `${issue.recipeId}[${issue.fields.join(',')}]`)
    .join('; ');
  const more =
    issues.length > MAX_DIAGNOSTIC_RECIPES
      ? `; +${issues.length - MAX_DIAGNOSTIC_RECIPES} more`
      : '';
  sink.warn({
    code,
    stage: 'evolve',
    message: `${summary} (${issues.length}/${totalRecipes} recipes): ${listed}${more}`,
  });
}

// ──────────────────────────────────────────────────────────────────
// Prompt 构建
// ──────────────────────────────────────────────────────────────────

/**
 * 构建 Evolution Agent 的用户 Prompt
 *
 * 按维度打包全部现有 Recipe 清单 + 可选 audit hint（计数语义）+ 可选增量 rescan 影响证据 + 项目概览，
 * 让 Agent 通过提案机制对每个 Recipe 做出进化/废弃/跳过决策。
 * 审计/影响证据是外部输入：先归一化再渲染，缺失或非法项写「未知」或丢弃，并经管线注入的
 * diagnostics 汇总成 evolver_audit_evidence_unknown / evolver_impact_evidence_invalid 诊断事件。
 */
export function buildEvolverPrompt(
  _phaseInput: unknown,
  _phaseResults: unknown,
  strategyContext: EvolutionContext
): string {
  const { existingRecipes, dimensionId, dimensionLabel, projectOverview } = strategyContext;
  const parts: string[] = [];
  const diagnostics = readDiagnosticsSink(strategyContext);
  const auditIssues: EvidenceIssue[] = [];
  const impactIssues: EvidenceIssue[] = [];

  // §1 任务概述
  parts.push(`# 验证任务: ${dimensionLabel} [${dimensionId}]`);
  parts.push(`你需要验证 **${existingRecipes.length}** 个现有 Recipe 的真实性。`);
  parts.push(
    `项目概况: ${projectOverview.primaryLang} 语言，${projectOverview.fileCount} 个文件。`
  );
  if (projectOverview.modules.length > 0) {
    parts.push(`主要模块: ${projectOverview.modules.slice(0, 10).join(', ')}`);
  }

  // §2 现有 Recipe 清单
  parts.push('# 现有 Recipe 清单');
  parts.push('以下是需要你验证的全部 Recipe。对每一个，你需要读取源文件、验证代码、然后做出决策。');

  for (let i = 0; i < existingRecipes.length; i++) {
    const recipe = existingRecipes[i];
    const lines: string[] = [];
    lines.push(`## [${i + 1}/${existingRecipes.length}] ${recipe.title}`);
    lines.push(`- **ID**: \`${recipe.id}\``);
    lines.push(`- **Trigger**: \`${recipe.trigger}\``);

    // 源文件引用 — 验证的起点
    if (recipe.sourceRefs && recipe.sourceRefs.length > 0) {
      lines.push(`- **源文件引用** (请用 \`code({ action: "read" })\` 读取验证):`);
      for (const ref of recipe.sourceRefs.slice(0, 5)) {
        lines.push(`  - \`${ref}\``);
      }
      if (recipe.sourceRefs.length > 5) {
        lines.push(`  - ... 及其他 ${recipe.sourceRefs.length - 5} 个文件`);
      }
    } else {
      lines.push('- **源文件引用**: 无（需要用 `code({ action: "search" })` 搜索相关代码）');
    }

    // Recipe 声称的核心代码（缩略）
    if (recipe.content?.coreCode) {
      const truncated =
        recipe.content.coreCode.length > 400
          ? `${recipe.content.coreCode.slice(0, 400)}...`
          : recipe.content.coreCode;
      lines.push(`- **Recipe 声称的核心代码** (需验证是否与实际一致):`);
      lines.push(`\`\`\`\n${truncated}\n\`\`\``);
    }

    // Recipe 的设计原理
    if (recipe.content?.rationale) {
      const rationale =
        recipe.content.rationale.length > 200
          ? `${recipe.content.rationale.slice(0, 200)}...`
          : recipe.content.rationale;
      lines.push(`- **设计原理**: ${rationale}`);
    }

    // 静态审计 hint（可选）：计数语义，缺失项渲染「未知」
    if (recipe.auditHint) {
      const missing: string[] = [];
      lines.push(...renderAuditHint(recipe.auditHint, recipe.sourceRefs?.length ?? 0, missing));
      if (missing.length > 0) {
        auditIssues.push({ recipeId: String(recipe.id), fields: missing });
      }
    }

    // 增量 rescan 的 diff 影响证据（可选）：增量路径上 auditHint 为 null，这是唯一的预检信号。
    // undefined/null 属于非增量路径的正常缺省，不算归一化问题。
    if (recipe.impactEvidence !== undefined && recipe.impactEvidence !== null) {
      const invalid: string[] = [];
      const impact = normalizeImpactEvidence(recipe.impactEvidence, invalid);
      if (impact) {
        lines.push(...renderImpactEvidence(impact));
      }
      if (invalid.length > 0) {
        impactIssues.push({ recipeId: String(recipe.id), fields: invalid });
      }
    }

    parts.push(lines.join('\n'));
  }

  reportEvidenceIssues(
    diagnostics,
    'evolver_audit_evidence_unknown',
    'auditHint evidence missing or non-finite; rendered as 未知 instead of a ratio',
    auditIssues,
    existingRecipes.length
  );
  reportEvidenceIssues(
    diagnostics,
    'evolver_impact_evidence_invalid',
    'impactEvidence fields failed validation; dropped from the prompt, valid fields kept',
    impactIssues,
    existingRecipes.length
  );

  // §3 验证工作流
  parts.push('# 验证工作流');
  parts.push('对每个 Recipe 按以下步骤执行:');
  parts.push('');
  parts.push('**步骤 1 — 读取源文件**');
  parts.push('- 使用 `code({ action: "read" })` 读取 sourceRefs 中列出的文件');
  parts.push('- 如果没有 sourceRefs，跳到步骤 2');
  parts.push('');
  parts.push('**步骤 2 — 搜索验证**（仅在源文件缺失或代码不匹配时）');
  parts.push('- 使用 `code({ action: "search" })` 搜索 Recipe 中的类名、函数名、关键模式');
  parts.push('- 使用 `graph({ action: "query" })` 验证符号关系和调用链');
  parts.push('- 确认该模式是否迁移到了新位置或已被完全移除');
  parts.push('');
  const terminalCapability = strategyContext.toolPolicyHints?.terminalCapability as
    | Record<string, unknown>
    | undefined;
  if (terminalCapability?.enabled === true) {
    parts.push('**可选终端验证**');
    parts.push(
      `- 当前终端能力档位: ${String(terminalCapability.toolset || 'terminal-exec')}；终端只用于验证工程命令事实`
    );
    parts.push('- 使用 terminal({ action: "exec" }) 执行验证命令');
    parts.push('- Evolution 阶段仅提供 exec-only 终端能力');
    parts.push('- 禁止 install、网络操作、写项目文件、删除、sudo、后台 daemon');
    parts.push('');
  }
  parts.push('**步骤 3 — 做出决策**');
  parts.push('- 基于步骤 1-2 的验证结果，调用 `knowledge({ action: "manage" })` 提交决策');

  // §4 决策指令
  parts.push('# 决策指令');
  parts.push('对上述每个 Recipe 做出以下三种决策之一，统一使用 `knowledge({ action: "manage" })`:');
  parts.push('');
  parts.push('### 1. 🔄 附加进化提案 — 代码已变但知识仍有价值');
  parts.push('```json');
  parts.push('knowledge({ action: "manage", params: {');
  parts.push('  "operation": "evolve",');
  parts.push('  "id": "recipe-xxx",');
  parts.push('  "reason": "说明发生了什么变化",');
  parts.push('  "data": {');
  parts.push(
    '    "type": "enhance",        // enhance=模式迁移/功能扩展, correction=描述错误/接口变更'
  );
  parts.push('    "description": "说明发生了什么变化",');
  parts.push('    "evidence": {');
  parts.push('      "sourceStatus": "modified", // exists|moved|modified|deleted');
  parts.push('      "currentCode": "你读到的实际代码片段",');
  parts.push('      "newLocation": "新路径（仅 moved 时）",');
  parts.push('      "suggestedChanges": "{结构化 JSON — 见下方格式}"');
  parts.push('    },');
  parts.push('    "confidence": 0.85');
  parts.push('  }');
  parts.push('} })');
  parts.push('```');
  parts.push('');
  parts.push('#### suggestedChanges 格式（重要！）');
  parts.push('suggestedChanges 必须是一个 JSON 字符串，格式如下:');
  parts.push('```json');
  parts.push('{');
  parts.push('  "patchVersion": 1,');
  parts.push('  "changes": [');
  parts.push('    {');
  parts.push('      "field": "coreCode",');
  parts.push('      "action": "replace",');
  parts.push('      "newValue": "更新后的代码片段"');
  parts.push('    },');
  parts.push('    {');
  parts.push('      "field": "content.markdown",');
  parts.push('      "action": "replace-section",');
  parts.push('      "section": "### 使用指南",');
  parts.push('      "newContent": "### 使用指南\\n更新后的内容"');
  parts.push('    }');
  parts.push('  ],');
  parts.push('  "reasoning": "源代码变更原因说明"');
  parts.push('}');
  parts.push('```');
  parts.push('');
  parts.push(
    '可修改的字段: `coreCode`, `doClause`, `dontClause`, `whenClause`, `content.markdown`, `content.rationale`, `sourceRefs`, `headers`'
  );
  parts.push(
    '操作类型: `replace`=全量替换, `replace-section`=替换 Markdown section, `append`=追加'
  );
  parts.push('');
  parts.push('### 2. ⛔ 确认废弃 — 知识确实过时，无法挽救');
  parts.push('```json');
  parts.push(
    'knowledge({ action: "manage", params: { "operation": "deprecate", "id": "recipe-xxx", "reason": "具体废弃原因", "data": { "confidence": 0.7 } } })'
  );
  parts.push('```');
  parts.push('');
  parts.push('### 3. ⏭️ 跳过 — 仍然有效 或 信息不足');
  parts.push('```json');
  parts.push(
    'knowledge({ action: "manage", params: { "operation": "skip_evolution", "id": "recipe-xxx", "reason": "验证有效: 代码与描述完全匹配" } })'
  );
  parts.push('```');
  parts.push('或:');
  parts.push('```json');
  parts.push(
    'knowledge({ action: "manage", params: { "operation": "skip_evolution", "id": "recipe-xxx", "reason": "信息不足: 无法确认源文件位置" } })'
  );
  parts.push('```');

  return parts.join('\n\n');
}
