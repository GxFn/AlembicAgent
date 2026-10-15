/**
 * insightAnalyst.ts — Insight Analyst 领域函数
 *
 * 从旧 AnalystAgent.js 提取的纯领域逻辑:
 * - Analyst System Prompt
 * - 工具白名单
 * - 预算常量
 * - 9 段式 Prompt 构建器
 *
 * 被 PipelineStrategy 的 bootstrap preset 直接引用。
 * 不再包含任何 Agent 类 — Agent 由 AgentRuntime + PipelineStrategy 驱动。
 *
 * @module insightAnalyst
 */

import { getDimensionSOP } from '@alembic/core/dimensions';
import { DEPTH_DIMENSIONS } from '@alembic/core/knowledge';
import { estimateTokens, truncateToTokenBudget } from '#shared/tokenUtils.js';
import {
  allocateMemoryBudget,
  DEFAULT_MEMORY_BUDGET,
  type MemoryPromptPort,
  projectMemorySection,
  readPersistentMemorySection,
} from '../memory/MemoryPrompt.js';
import { type MemoryReadOptions, reportMemoryRead } from '../memory/MemoryReadPolicy.js';

/**
 * P4/C10: 深度捕获指令——从 Core DEPTH_DIMENSIONS 单源渲染(与契约/裁判/评分/指引同源)。取四个深度维度
 * (跳过 multiSourceCorroboration，它是跨发现的综合判定，不属单条 note_finding)。让 Analyst 在确认核心发现
 * 时同步用 note_finding 的深度槽结构化记录「为何这样设计 / 边界 / 越界会怎样 / 权衡」，各挂真实 file:line。
 * Producer 被禁补读源码，深度只能在有代码工具的 Analyst 段产生，故指令挂在 Analyst 系统提示里。
 */
// 2026-07-02 重设计(用户决策)：深度捕获从「逐槽填四维」改为「自选角度真挖」——固定四问会把
// 深度退化成填表式格式化措辞。深度槽(designIntent/boundaries/failureModes/tradeoffs)保留为
// 可选的结构化载体：挖到哪个角度就填哪个槽，没挖到的留空。
const DEPTH_CAPTURE_INSTRUCTION = `- **深度捕获（强价值要求，非硬门槛）**: 确认核心发现后，对它做一轮真深挖——从「这个设计最反直觉之处 / 违反它最先坏什么(真实失败路径) / 项目内的例外与对照 / 它替代了什么、代价是什么」里挑你**真的读到代码证据**的角度想透，把洞察写进 finding 或实际挖到的深度槽，evidenceRefs 引用工具返回的台账 ID（由台账映射真实 file:line）；挖到的角度恰好对应深度槽（${DEPTH_DIMENSIONS.filter(
  (d) => d.key !== 'multiSourceCorroboration'
)
  .map((d) => d.label)
  .join(
    ' / '
  )}）就顺手填槽，没挖到的留空——绝不为凑维度写格式化措辞。深度让 Producer 拿到「为何/边界/后果/代价」，而非只有「是什么」。`;

// ──────────────────────────────────────────────────────────────────
// 本地类型定义
// ──────────────────────────────────────────────────────────────────

/** 维度配置 (Analyst) */
interface AnalystDimConfig {
  id: string;
  label: string;
  guide?: string;
  focusKeywords?: string[];
  outputType?: string;
  allowedKnowledgeTypes?: string[];
}

/** 项目信息 (Analyst) */
interface AnalystProjectInfo {
  name: string;
  lang: string;
  fileCount: number;
}

/** DimensionContext 最小接口 */
interface DimensionContextLike {
  buildContextForDimension(dimId: string): {
    previousDimensions: Record<string, DimensionDigestLike>;
  };
}

/** 维度摘要 */
interface DimensionDigestLike {
  summary?: string;
  keyFindings: string[];
  crossRefs?: Record<string, string>;
}

/** EpisodicMemory (SessionStore) 最小接口 */
interface EpisodicMemoryLike {
  /**
   * 以对象形式传入会话预算（C44）：SessionStore 在自己的投影内按
   * 「跨维度建议/反思 > 相关维度发现 > 文件清单」装配后截断；忽略预算的旧端口由外层兜底截断。
   */
  buildContextForDimension(
    dimId: string,
    options: { focusKeywords: string[]; tokenBudget: number }
  ): string | null;
  getRelevantReflections(dimId: string): string | null;
}

/**
 * truncateToTokenBudget 的默认截断标记（SessionStore 用它裁剪会话投影）。端口已在预算内裁剪时，
 * 外层 projectMemorySection 不会再改动文本、也就不会发出截断诊断，所以这里按标记识别端口侧截断。
 * 只有“以标记结尾且已落在本次会话预算内”才算端口按本预算裁剪：按别的（更大）预算裁剪过的旧端口
 * 仍走外层兜底截断与反思补注入。预算小于标记本身（约 7 token）时 tokenUtils 退化为单个 '…'，
 * 此时会话段几乎为空，由 SessionStore 自身的截断日志覆盖，不在这里猜测。
 */
const SESSION_BUDGET_TRUNCATION_MARK = '…(truncated due to budget)';

/** PersistentMemory 最小接口 */
type SemanticMemoryLike = MemoryPromptPort;
export interface AnalystMemoryOptions extends MemoryReadOptions {
  totalMemoryBudget?: number;
}

/**
 * CodeEntityGraph 最小接口（§9 图谱段专用）。
 *
 * 生产不可达（C56）：generateContextForAgent 在 Agent、Core、宿主中都没有实现；宿主只把 codeEntityGraph
 * 作为 graph 工具端口（queryEntity / impactAnalysis / search，见 tools/kernel/registry.ts）注入工具上下文，
 * 不经 strategyContext 传给本构建器，所以 insightPreset 取到的 ctx.codeEntityGraph 恒为 undefined。
 * §9 删除（保留参数位）还是接线（readMemoryValue 共享 deadline/abort）取决于待决事项①，决定前只补诊断。
 */
interface CodeEntityGraphLike {
  generateContextForAgent(opts: {
    maxEntities: number;
    maxEdges: number;
  }): Promise<string | null> | string | null;
}

/**
 * §9 图谱段的诊断出口。
 *
 * MemoryReadDiagnostic.phase 是 buildAnalystPrompt 公开回调参数里的封闭枚举，新增 'graph' 属于公开面变更
 * （待事项②），所以这里复用 'session'：§9 与 §6 同属 Analyst 首轮注入的会话上下文。来源由
 * 'code-entity-graph' 前缀的 reason 区分，日志行与 DiagnosticsCollector 消息都可据此过滤。
 */
function reportCodeEntityGraphRead(
  options: MemoryReadOptions,
  status: 'aborted' | 'error' | 'invalid',
  reason: string
): void {
  reportMemoryRead(options, { phase: 'session', status, reason: `code-entity-graph-${reason}` });
}

// ──────────────────────────────────────────────────────────────────
// System Prompt — Analyst 专用 (~100 tokens)
// ──────────────────────────────────────────────────────────────────

// 「优先使用注入的 … codeEntityGraph …」一句指向 §9 图谱段，而 §9 在生产中不可达（见
// CodeEntityGraphLike），提示里实际不会出现图谱上下文（C56）。删除这处引用还是接线 §9 取决于待决事项①，
// 决定前不改提示文本，避免在事项未答复时改变模型输入；按①定案时与 §9 一起处理。
export const ANALYST_SYSTEM_PROMPT = `你是一位高级软件架构师，正在深度分析一个真实项目的某个维度。

## 执行计划
你有 **N 轮**工具调用机会（系统会告知具体数字）。请严格按以下节奏分配：

| 阶段 | 轮次占比 | 目标 |
|------|---------|------|
| 1. SCAN 简报 | 首轮 | 消费已有结构上下文并计划，不调用工具 |
| 2. EXPLORE 探索 | 阶段机进入探索后 | graph({ action: "query" }) 理解核心类；code({ action: "search" }) 批量搜索关键模式 |
| 3. 深度验证 | 第 N×60%-N×80% 轮 | code({ action: "read" }) 阅读关键实现，确认细节；确认核心发现后立即记录 |
| 4. 结构化记录 | 总结前 | 用 note_finding({ finding, evidenceRefs, importance }) 补齐核心发现；这是 QualityGate 的重要质量依据 |
| 5. 输出总结 | 最后阶段 | 停止工具，直接输出你的分析文本 |

## 关键规则
- **遵守当前阶段机的预算与总结指令**，但总结前必须已有真实代码证据和结构化发现
- 每一轮都必须产生新证据；全景数据和已有上下文只能作为线索，不能替代至少一次 code/graph 证据工具调用
- 没有调用过 code({ action: "structure" }) / code({ action: "search" }) / graph({ action: "query" }) / code({ action: "read" }) 之前，禁止输出最终分析
- 不要重复搜索相同关键词或读取相同文件（系统会返回缓存并扣轮次）
- 优先使用注入的 panorama / projectInfo / codeEntityGraph / sessionStore，再用工具验证关键事实
- **note_finding 是硬性质量依据**: 一旦在扫描、探索或验证阶段确认核心发现，允许并且应该立即调用 note_finding({ finding, evidenceRefs, importance })；最终至少提交 3 条结构化发现；如果证据面覆盖多个模式/实践，应记录所有已确认的高价值发现，不因数量超过 6 条而停止，缺失或不足会导致 QualityGate retry
- **单一事实源**: Producer 只消费 note_finding 结构化发现。最终 Markdown 只能总结已记录的 note_finding，不得新增未结构化记录的模式家族、候选主题或可提交发现。
- **证据必须落到代码，文档只是线索**: 协作/设计/总结类 markdown（如 wakeflow-ledger、Design、docs 下的 *.md）是二手描述，只能用来导航，不能作为知识证据——note_finding 的 evidenceRefs 台账锚点与最终 (来源: …) 必须指向真实源码/配置文件（.ts/.js/.json/.yaml 等）的具体行。看到 .md 里的架构结论时，回到它描述的真实代码文件验证并引用代码行；抄文档结论而不读代码等同编造。
${DEPTH_CAPTURE_INSTRUCTION}

## 工具效率
- **批量搜索**: code({ action: "search", params: { patterns: ["keywordA", "keywordB", "keywordC"] } }) — 一次搜 3-5 个
- **批量读文件**: code({ action: "read", params: { filePaths: ["a.m", "b.m", "c.m"] } }) — 一次读 3-5 个
- **结构化查询优先**: graph({ action: "query", params: { type: "hierarchy"/"class" } }) 比文本搜索更精确高效；若发现涉及具体调用链（谁调用谁），执行一次 graph 查询留下背书——无 graph 证据的调用链断言会被 GRAPH_REF_INVALID 拒绝（一般依赖/分层/边界描述不受限）
- **调用关系查询优先**: graph({ action: "query", params: { type: "callers"/"callees" } }) 比文本搜索更适合验证调用链
- **终端仅作只读验证**: 如果宿主暴露 terminal({ action: "exec" })，它只用于可复核工程事实；优先跑只读命令，例如 git log/blame/diff/status、npm test/vitest run、tsc --noEmit、lint、grep/rg/find
- **终端禁区**: 不安装依赖、不访问网络、不写/删项目文件、不 sudo、不 chmod/chown、不启动后台 daemon；终端证据先复核，再进入 note_finding 或最终结论

## 输出要求
输出你的分析发现，包括具体的文件完整相对路径（从项目根目录开始）和行号。
每个文件引用格式: (来源: Full/Relative/Path/FileName.ext:行号)
禁止只写文件名，必须写从项目根开始的完整路径。
标注每个发现所属的模块/包名。
用自然语言描述你的理解，不需要特定格式。`;

// ──────────────────────────────────────────────────────────────────
// Analyst 工具名单（历史常量）
// ──────────────────────────────────────────────────────────────────

/**
 * 早期的 Analyst 工具白名单。
 * @deprecated 无任何消费者，且与真实工具面不一致：analyze 阶段的可用工具由
 *   tools/runtime/toolsets/GenerateAnalyze 与阶段 additionalTools 决定，不读本常量。
 *   随待决事项②“公开面收窄”删除，删除前须附 src、测试、宿主生产与宿主测试的零引用扫描。
 */
export const ANALYST_TOOLS = ['code', 'graph', 'terminal', 'memory', 'meta'];

// ──────────────────────────────────────────────────────────────────
// Analyst 预算 — 使用 analyst 策略（自由探索，无阶段约束）
// ──────────────────────────────────────────────────────────────────

/** 宿主未提供 contextWindowBudget 时的每轮上下文预算估算（token/轮，保守值） */
const DEFAULT_ANALYST_ROUND_CONTEXT_BUDGET = 15_000;
/** 每轮实际 input 占上下文预算的加权平均：早期轮次 ~40%，后期接近上限 ~70% */
const ANALYST_AVG_INPUT_USAGE_RATIO = 0.6;
/** 会话总量 = input × 1.35（output 约占 input 的 30-40%） */
const ANALYST_SESSION_TOTAL_RATIO = 1.35;

/**
 * 迭代数 → 会话 token 上限（静态兜底与 computeAnalystBudget 共用的唯一估算口径）。
 * @param contextWindowBudget ContextWindow 的 tokenBudget；缺省或为 0 时按 15000 token/轮 估算
 */
function analystSessionTokenCaps(
  maxIter: number,
  contextWindowBudget?: number
): { maxSessionTokens: number; maxSessionInputTokens: number } {
  const cwBudget = contextWindowBudget || DEFAULT_ANALYST_ROUND_CONTEXT_BUDGET;
  const avgInputPerRound = Math.ceil(cwBudget * ANALYST_AVG_INPUT_USAGE_RATIO);
  const maxSessionInputTokens = maxIter * avgInputPerRound;
  return {
    maxSessionTokens: Math.ceil(maxSessionInputTokens * ANALYST_SESSION_TOTAL_RATIO),
    maxSessionInputTokens,
  };
}

/** 静态 Analyst 预算的 24 轮基线 */
const ANALYST_BASELINE_ITERATIONS = 24;
const ANALYST_BASELINE_SESSION = analystSessionTokenCaps(ANALYST_BASELINE_ITERATIONS);

/**
 * 默认 Analyst 预算（24 轮基线）。
 *
 * 宿主生产路径总是用 computeAnalystBudget 的结果覆盖（经 _computedBudget 合并进 analyze 阶段预算）；
 * 本常量只在没有动态预算时作为 insightPreset analyze 阶段的兜底。会话 token 上限与
 * computeAnalystBudget(≤40 文件、未提供 contextWindowBudget) 同源（C57 统一口径）。
 */
export const ANALYST_BUDGET = {
  maxIterations: ANALYST_BASELINE_ITERATIONS,
  searchBudget: 18,
  searchBudgetGrace: 10,
  maxSubmits: 0,
  softSubmitLimit: 0,
  idleRoundsToExit: 2,
  /**
   * Session-level total token cap (input + output).
   * 24 轮 × ceil(15000 × 0.6) × 1.35 = 291,600；有动态预算时被 computeAnalystBudget 覆盖。
   */
  maxSessionTokens: ANALYST_BASELINE_SESSION.maxSessionTokens,
  /**
   * Session-level input token cap.
   * 24 轮 × ceil(15000 × 0.6) = 216,000；有动态预算时被 computeAnalystBudget 覆盖。
   */
  maxSessionInputTokens: ANALYST_BASELINE_SESSION.maxSessionInputTokens,
};

/**
 * 根据项目规模自适应计算 Analyst 预算
 *
 * 策略: 以文件数为主要缩放因子，保持 searchBudget/maxIterations 的比例关系。
 *   - ≤40 文件: 基线 24 轮（小型项目无需额外预算）
 *   - 41~100 文件: 线性插值到 32 轮
 *   - 101~200 文件: 线性插值到 40 轮
 *   - >200 文件: 封顶 40 轮（避免单维度成本失控）
 *
 * searchBudget 按比例随 maxIterations 缩放（保持 75%）。
 * timeoutMs 按比例随 maxIterations 缩放（基线 480s 对应 24 轮）。
 *
 * @param fileCount 项目文件数
 * @param contextWindowBudget ContextWindow 的 tokenBudget，用于计算合理的 session 限额。
 *   如果未提供，使用保守的 15000 token/轮 估算。
 */
export function computeAnalystBudget(
  fileCount: number,
  contextWindowBudget?: number
): typeof ANALYST_BUDGET & { timeoutMs: number } {
  const clamped = Math.max(0, fileCount);
  let maxIter: number;

  if (clamped <= 40) {
    maxIter = 24;
  } else if (clamped <= 100) {
    maxIter = Math.round(24 + ((clamped - 40) / 60) * 8);
  } else if (clamped <= 200) {
    maxIter = Math.round(32 + ((clamped - 100) / 100) * 8);
  } else {
    maxIter = 40;
  }

  // Session token 预算: 基于 ContextWindow budget 动态计算
  // 每轮 input token ≈ contextWindowBudget × avgUsageRatio
  return analystBudgetForIterations(maxIter, contextWindowBudget);
}

/**
 * P1-B-2(挖掘质量升级)：模块作用域的 Analyst 预算。
 * computeAnalystBudget 以【全项目 fileCount】为基准——module-mining child 只负责一个模块，
 * 500 文件项目里 3 文件小模块拿全项目档位(过配)、fan-out 后大小模块又同配(欠配)。
 * 这里以【模块 ownedFiles 数】为基准分档(阈值为可调默认)；session 数学与项目档单源共享。
 */
export function computeModuleAnalystBudget(
  moduleFileCount: number,
  contextWindowBudget?: number
): typeof ANALYST_BUDGET & { timeoutMs: number } {
  const clamped = Math.max(0, moduleFileCount);
  let maxIter: number;
  if (clamped <= 10) {
    maxIter = 18;
  } else if (clamped <= 30) {
    maxIter = 26;
  } else if (clamped <= 60) {
    maxIter = 34;
  } else {
    maxIter = 40;
  }
  return analystBudgetForIterations(maxIter, contextWindowBudget);
}

/** 迭代数 → 完整预算的共享数学(session token 估算/timeout 缩放,项目档与模块档单源)。 */
function analystBudgetForIterations(
  maxIter: number,
  contextWindowBudget?: number
): typeof ANALYST_BUDGET & { timeoutMs: number } {
  // Session token 预算: 每轮 input ≈ contextWindowBudget × 60%，与静态 ANALYST_BUDGET 同一口径
  const { maxSessionTokens, maxSessionInputTokens } = analystSessionTokenCaps(
    maxIter,
    contextWindowBudget
  );

  return {
    ...ANALYST_BUDGET,
    maxIterations: maxIter,
    searchBudget: Math.round(maxIter * 0.75),
    timeoutMs: Math.round((maxIter / 24) * 480_000),
    maxSessionTokens,
    maxSessionInputTokens,
  };
}

// ──────────────────────────────────────────────────────────────────
// 维度 Prompt 模板 (9 段式)
// ──────────────────────────────────────────────────────────────────

/** Panorama context — module role, layer, coupling, gaps */
interface PanoramaContextLike {
  moduleRole: string | null;
  moduleLayer: number | null;
  moduleCoupling: { fanIn: number; fanOut: number } | null;
  knownGaps: string[];
  layerContext: string | null;
}

/** Evidence starters — per-dimension evidence hints from Phase 1-4 */
interface EvidenceStarterEntry {
  hint: string;
  data: unknown;
  strength?: number;
}

/** Rescan context — existing recipes in this dimension */
interface RescanContextLike {
  existingRecipes: Array<{ title: string; trigger: string }>;
  decayingRecipes?: Array<{ title: string; trigger: string; id?: string; decayReason?: string }>;
  gap: number;
  createBudget?: number;
  executionMode?: 'skip' | 'verify-only' | 'produce';
  existing: number;
}

/**
 * 构建 Analyst Prompt
 *
 * 12 段结构:
 *   §1 任务描述
 *   §2 维度指引
 *   §3 SOP (分析步骤 + 常见错误)
 *   §4 输出要求
 *   §5 工具提示
 *   §6 前序维度上下文 (SessionStore / DimensionContext)
 *   §7 Tier Reflection 洞察
 *   §8 历史语义记忆 (Tier 3)
 *   §9 代码实体图谱 (Phase E；生产不可达，去留待事项①，见 CodeEntityGraphLike)
 *   §ES 分析起点证据 (Phase 1-4 Evidence Starters)
 *   §M1 全景上下文 (Panorama Phase 1.8)
 *   §10 Rescan 已有知识上下文
 *
 * @param dimConfig 维度配置 { id, label, guide, focusKeywords, outputType }
 * @param projectInfo { name, lang, fileCount }
 * @param [dimensionContext] DimensionContext 实例 (跨维度上下文)
 * @param [episodicMemory] SessionStore 实例 (v4.0 增强上下文)
 * @param [semanticMemory] PersistentMemory 实例 (v4.1 历史记忆)
 * @param [codeEntityGraph] CodeEntityGraph 实例 (Phase E 代码实体图谱；参数位保留，生产恒不传，见 CodeEntityGraphLike)
 * @param [rescanContext] Rescan 已有知识上下文 (增量扫描时注入)
 * @param [panorama] 全景上下文 — 模块角色/层级/耦合/空白区 (Phase 1.8)
 * @param [evidenceStarters] Phase 1-4 证据启发 — 维度级分析起点
 * @param [evolutionResult] Evolution Stage 产出 — 避免重复分析已处理的 Recipe
 */
export async function buildAnalystPrompt(
  dimConfig: AnalystDimConfig,
  projectInfo: AnalystProjectInfo,
  dimensionContext: DimensionContextLike | null | undefined,
  episodicMemory: EpisodicMemoryLike | null | undefined,
  semanticMemory: SemanticMemoryLike | null | undefined,
  codeEntityGraph: CodeEntityGraphLike | null | undefined,
  rescanContext?: RescanContextLike | null,
  panorama?: PanoramaContextLike | null,
  evidenceStarters?: Record<string, EvidenceStarterEntry> | null,
  evolutionResult?: {
    evolved?: number;
    deprecated?: number;
    skipped?: number;
    totalRecipes?: number;
  } | null,
  toolPolicyHints?: Record<string, unknown> | null,
  memoryOptions: AnalystMemoryOptions = {}
) {
  const parts: string[] = [];
  const memoryBudget = allocateMemoryBudget(
    'analyst',
    memoryOptions.totalMemoryBudget ?? DEFAULT_MEMORY_BUDGET
  );

  // §1 任务描述
  parts.push(
    `分析项目 ${projectInfo.name} (${projectInfo.lang}, ${projectInfo.fileCount} 个文件) 的 ${dimConfig.label}。`
  );

  // §2 维度指引
  if (dimConfig.guide) {
    parts.push(dimConfig.guide);
  }

  // §3 结构化 SOP (优先) — 替代 focusAreas
  const sop = getDimensionSOP(dimConfig.id);
  if (sop) {
    parts.push('## 分析步骤 (SOP)');
    for (const step of sop.steps) {
      parts.push(`### ${step.phase}`);
      parts.push(step.action);
      if (step.expectedOutput) {
        parts.push(`→ 预期产出: ${step.expectedOutput}`);
      }
    }
    // §3.1 常见错误 (关键质量防护)
    if (sop.commonMistakes && sop.commonMistakes.length > 0) {
      parts.push('## ⚠️ 常见错误（务必避免）');
      for (const m of sop.commonMistakes) {
        parts.push(`- ${m}`);
      }
    }
  } else if (dimConfig.guide) {
    const items = dimConfig.guide
      .split(/[、，,/]/)
      .map((s: string) => s.trim())
      .filter(Boolean);
    if (items.length > 1) {
      parts.push(`重点关注:\n${items.map((f: string) => `- ${f}`).join('\n')}`);
    } else {
      parts.push(`重点关注: ${dimConfig.guide}`);
    }
  }

  // §4 输出要求
  const outputType = dimConfig.outputType || 'analysis';
  const needsCandidates = outputType === 'dual' || outputType === 'candidate';
  const depthHint = needsCandidates
    ? '你的分析将被转化为知识候选，请确保每个发现都有足够的代码证据和文件引用。按实际发现总结，有几个独立知识点就写几个。'
    : '';

  parts.push(`请将分析组织成结构化段落，包含:
1. 在哪些文件/类中发现 (写出从项目根目录开始的完整相对路径+行号，如 Packages/ModuleName/Sources/.../FileName.swift:42)
2. 具体的实现方式和代码特征
3. 为什么选择这种方式（设计意图）
4. 统计数据 (如数量、占比)
5. 所属模块/包名（特别是来自本地子包的发现）

每个关键发现用编号列表呈现，引用 3 个以上具体文件（完整相对路径）。
禁止只写文件名（如 NetworkClient.swift），必须写完整路径（如 Packages/AOXNetworkKit/Sources/AOXNetworkKit/Client/NetworkClient.swift:42）。
${depthHint}
重要: 务必使用 code({ action: "read" }) 阅读代码确认，不要假设文件存在。引用的每个文件路径都必须是你亲眼看到的。
【跨维度去重】只分析属于当前维度视角的内容。不要将其他维度的知识点混入本维度来充数。例如: 分析 code-standard 时只关注命名/注释/文件组织，不要混入设计模式(code-pattern)或分层架构(architecture)的内容。如果某个发现与多个维度相关，则只从当前维度的核心视角分析，避免与其他维度产生重叠。
【本地子包覆盖】如果项目有本地子包/模块（如 Packages/ 目录下的包），必须同时分析其内部实现，不得仅看主项目对其的调用。`);

  // §5 工具使用提示
  parts.push(`【硬性要求：结构化记录发现】
最终 Markdown 报告不能替代 note_finding 结构化函数调用。
note_finding 是 QualityGate 的重要质量依据，也是 Producer 后续生成候选知识的主要输入之一。
不要等到总结阶段；一旦在扫描/探索/验证阶段确认核心发现，允许并且必须主动调用:
note_finding({ finding: "发现描述", evidenceRefs: ["E-1"], importance: 8 })
如果当前维度需要产出候选知识，最终至少记录 3 条 note_finding；如果证据面覆盖多个模式/实践，应记录所有已确认的高价值发现，不因数量超过 6 条而停止；若确认不足 3 条，请记录所有已确认发现，并在最终报告说明不足原因。
最终 Markdown 报告只能围绕已记录的 note_finding 展开；不要把未调用 note_finding 的信号写成核心发现或候选义务。未记录的信号只能放入待探索/未结构化记录说明。
缺少 note_finding(...) 或数量不足会直接影响 QualityGate 评分并触发 retry。`);
  // C53: note_finding 写入 ActiveContext scratchpad(每轮以「📌 已确认的关键发现」注入工作上下文)，
  // 不写工具上下文的 sessionStore，所以 memory recall tags=finding 必然空返回、白耗一轮并误导模型
  // 以为尚未记录。这里只指向真实入口：回执计数/工作上下文、前序维度证据、已采证据台账。
  parts.push(
    '已记录的发现无需另行查询：note_finding 的回执会给出当前累计条数，已记录内容由系统保留在工作上下文的「📌 已确认的关键发现」中，记录前对照它避免重复。' +
      '查前序维度对同一文件/类的分析证据用 memory({ action: "get_previous_evidence", params: { query: "类名/文件名" } })；' +
      '查回已采集证据及其 E-id 用 evidence({ action: "search" }) / evidence({ action: "get" })。'
  );

  // §6 前序维度分析摘要 (Tier 2+ 才有)
  const historyParts: string[] = [];
  try {
    if (memoryOptions.abortSignal?.aborted) {
      // 取消短路：运行已取消时不再读取任何上下文端口（会话、持久记忆、图谱），只返回 §1–§5 的部分提示。
      // 留一条 aborted 诊断，让“提示缺少记忆段”可以追溯到取消而不是读取失败（C56）。
      reportMemoryRead(memoryOptions, {
        phase: 'session',
        status: 'aborted',
        reason: 'prompt-build-aborted',
      });
      return parts.join('\n\n');
    }
    if (episodicMemory && memoryBudget.sessionStore > 0) {
      const sessionBudget = memoryBudget.sessionStore;
      // C44: 把会话预算交给 SessionStore，让它按优先级装配后截断；数组形式不带预算，
      // 只能靠外层尾部截断，排在末尾的跨维度建议与 Tier 反思会最先被裁掉。
      const emContext =
        episodicMemory.buildContextForDimension(dimConfig.id, {
          focusKeywords: dimConfig.focusKeywords || [],
          tokenBudget: sessionBudget,
        }) || '';
      const portTruncated =
        emContext.endsWith(SESSION_BUDGET_TRUNCATION_MARK) &&
        estimateTokens(emContext) <= sessionBudget;
      if (portTruncated) {
        reportMemoryRead(memoryOptions, {
          phase: 'session',
          status: 'truncated',
          reason: 'session-priority-budget',
          budget: sessionBudget,
        });
      }
      // 反思去重比对实际注入文本：遵守预算的端口返回值就是注入内容；忽略预算的旧端口
      // 按外层同一预算尾部截断后再比对，避免“全文含反思、注入时却被裁掉”仍被判为已注入。
      const injected = truncateToTokenBudget(emContext, sessionBudget);
      const reflections = episodicMemory.getRelevantReflections(dimConfig.id);
      if (reflections && !injected.includes(reflections)) {
        if (portTruncated) {
          // 端口已把反思排在同一预算的最高优先级仍放不下：另起一段补注入只会挤掉同级的
          // 跨维度建议或被外层裁掉，因此不补注入，只报告反思超出会话预算。
          reportMemoryRead(memoryOptions, {
            phase: 'session',
            status: 'truncated',
            reason: 'reflections-over-budget',
            budget: sessionBudget,
          });
        } else {
          // 端口投影不含反思（旧端口），或反思落在会被外层裁掉的尾部：按优先级放在会话上下文之前补注入。
          historyParts.push('## 跨维度综合洞察', reflections);
        }
      }
      if (emContext) {
        historyParts.push(emContext);
      }
    } else if (dimensionContext && memoryBudget.sessionStore > 0) {
      const snapshot = dimensionContext.buildContextForDimension(dimConfig.id);
      const prevDims = Object.entries(snapshot.previousDimensions) as [
        string,
        DimensionDigestLike,
      ][];
      if (prevDims.length > 0) {
        historyParts.push(`## 前序维度分析摘要（避免重复探索）`);
        for (const [dimId, digest] of prevDims) {
          historyParts.push(`### ${dimId}\n${digest.summary || '(无摘要)'}`);
          if (digest.keyFindings?.length > 0) {
            historyParts.push(`关键发现: ${digest.keyFindings.join('; ')}`);
          }
          if (digest.crossRefs?.[dimConfig.id]) {
            historyParts.push(`💡 对本维度的建议: ${digest.crossRefs[dimConfig.id]}`);
          }
        }
      }
    }
  } catch (err: unknown) {
    reportMemoryRead(memoryOptions, {
      phase: 'session',
      status: 'error',
      reason: err instanceof Error ? err.name : 'unknown',
    });
  }
  const history = projectMemorySection(
    'session',
    historyParts.join('\n'),
    memoryBudget.sessionStore,
    memoryOptions
  );
  if (history.content) {
    parts.push(history.content);
  }

  // §8: 历史语义记忆 (Tier 3)
  const semanticSection = await readPersistentMemorySection(semanticMemory, {
    ...memoryOptions,
    source: 'bootstrap',
    query: `${dimConfig.label} ${dimConfig.guide || ''} ${projectInfo.lang}`,
    limit: 10,
    tokenBudget: memoryBudget.persistentMemory,
  });
  if (semanticSection.content) {
    parts.push(semanticSection.content);
  }

  // §9: 代码实体图谱 (Phase E)
  // 生产不可达：宿主不向构建器传图谱端口（见 CodeEntityGraphLike），未传时静默跳过，不发诊断，
  // 否则每个维度都会向 DiagnosticsCollector 灌一条无意义告警。§9 删除或接线待事项①；决定前只补诊断，
  // 图谱失败仍不阻断提示构建（非关键段），但每条跳过路径都要能从诊断里看出原因。
  // 读取本身尚未套 readMemoryValue 的 deadline/abort 竞速，属于“接线”分支的改动，随事项①处理。
  if (codeEntityGraph) {
    if (memoryOptions.abortSignal?.aborted) {
      // §8 持久记忆读取期间运行被取消：不再发起图谱读取。
      reportCodeEntityGraphRead(memoryOptions, 'aborted', 'aborted');
    } else if (typeof codeEntityGraph.generateContextForAgent !== 'function') {
      // 端口形状不符（例如误把 graph 工具端口传进来）：过去是 TypeError 被吞掉，现在报告 invalid 后跳过。
      reportCodeEntityGraphRead(memoryOptions, 'invalid', 'port-invalid');
    } else {
      try {
        const graphCtx: unknown = await codeEntityGraph.generateContextForAgent({
          maxEntities: 20,
          maxEdges: 40,
        });
        if (typeof graphCtx === 'string') {
          if (graphCtx) {
            parts.push(graphCtx);
            parts.push('使用 graph({ action: "query" }) 工具可以查询更详细的继承链、影响分析等。');
          }
        } else if (graphCtx !== null && graphCtx !== undefined) {
          // 宿主输出先验证再进提示：非字符串会被 join 成 "[object Object]" 之类的噪声，跳过并报告。
          reportCodeEntityGraphRead(memoryOptions, 'invalid', 'result-invalid');
        }
      } catch (err: unknown) {
        // 图谱是非关键段：失败只跳过本段。诊断只带错误名，不带原始消息，避免观测链泄漏图谱内容。
        reportCodeEntityGraphRead(
          memoryOptions,
          'error',
          `error:${err instanceof Error ? err.name : 'unknown'}`
        );
      }
    }
  }

  // §ES: 分析起点证据 (Phase 1-4 Evidence Starters)
  if (evidenceStarters && Object.keys(evidenceStarters).length > 0) {
    const esLines = ['## 📊 分析起点 (Phase 1-4 自动检测)'];
    esLines.push('以下是自动化分析阶段检测到的与本维度相关的信号，可作为分析起点:');
    // 按 strength 降序排列，取前 6 个最强信号
    const sorted = Object.entries(evidenceStarters)
      .sort(([, a], [, b]) => (b.strength ?? 50) - (a.strength ?? 50))
      .slice(0, 6);
    for (const [key, entry] of sorted) {
      const strengthBadge = (entry.strength ?? 50) >= 75 ? '⚠️' : '📝';
      esLines.push(`${strengthBadge} **${key}**: ${entry.hint}`);
      if (entry.data) {
        const dataStr = Array.isArray(entry.data)
          ? entry.data
              .slice(0, 5)
              .map((d) => `  - ${typeof d === 'string' ? d : JSON.stringify(d)}`)
              .join('\n')
          : typeof entry.data === 'string'
            ? `  ${entry.data}`
            : `  ${JSON.stringify(entry.data, null, 0).slice(0, 300)}`;
        esLines.push(dataStr);
      }
    }
    esLines.push('');
    esLines.push('利用上述信号作为分析切入点，用 code({ action: "read" }) 验证并深入探索。');
    parts.push(esLines.join('\n'));
  }

  // §M1: 全景上下文 (Panorama Phase 1.8) — 模块角色/层级/耦合/空白区
  if (panorama) {
    const pLines = ['## 🏗️ 项目全景 (Panorama)'];
    if (panorama.layerContext) {
      pLines.push(`架构层级: ${panorama.layerContext}`);
    }
    if (panorama.moduleRole) {
      pLines.push(
        `当前模块角色: ${panorama.moduleRole}${panorama.moduleLayer !== null ? ` (L${panorama.moduleLayer})` : ''}`
      );
    }
    if (panorama.moduleCoupling) {
      pLines.push(
        `耦合度: fanIn=${panorama.moduleCoupling.fanIn}, fanOut=${panorama.moduleCoupling.fanOut}`
      );
    }
    if (panorama.knownGaps.length > 0) {
      pLines.push(`已知空白区: ${panorama.knownGaps.join(', ')}`);
      pLines.push('分析时请特别关注上述空白区，它们是最可能产出新知识的方向。');
    }
    parts.push(pLines.join('\n'));
  }

  // §EVO: Evolution 结果 — 避免重复覆盖已被 Evolution Agent 处理的模式
  if (evolutionResult?.totalRecipes && evolutionResult.totalRecipes > 0) {
    const evoLines = [
      '## 🔄 Evolution 结果',
      `Evolution Agent 已审查本维度 ${evolutionResult.totalRecipes} 个现有 Recipe:`,
      `- 进化: ${evolutionResult.evolved ?? 0} 个（已提交新版本替代旧 Recipe）`,
      `- 废弃: ${evolutionResult.deprecated ?? 0} 个（已确认过时）`,
      `- 跳过: ${evolutionResult.skipped ?? 0} 个（仍然有效或信息不足）`,
      '',
      '**你的分析应关注发现新知识点**，不要重复覆盖已处理的模式。',
    ];
    parts.push(evoLines.join('\n'));
  }

  const terminalCapability = toolPolicyHints?.terminalCapability as
    | Record<string, unknown>
    | undefined;
  if (terminalCapability?.enabled === true) {
    parts.push(`## 终端工具使用边界
- 当前终端能力档位: ${String(terminalCapability.toolset || 'terminal-exec')}
- 终端是可选的代码分析证据工具，不是必调工具
- 默认先用全景数据、graph({ action: "query" })、code({ action: "search" })、code({ action: "read" })
- 需要确认工程事实时优先 terminal({ action: "exec" })
- 只读取证命令包括 git log/blame/diff/status、npm test/vitest run、tsc --noEmit、lint、grep/rg/find
- 终端结果可作为 PcvNodeEvidence / grounding guard 证据来源；先复核输出，再推进事实结论
- 当前仅提供 exec-only 终端能力，不提供 shell 或 PTY 工具
- 禁止 install、网络操作、写项目文件、删除、chmod/chown、sudo、后台 daemon`);
  }

  // §10a: Rescan 有效知识上下文 — 避免重复分析已覆盖的模式
  if (rescanContext && rescanContext.existingRecipes.length > 0) {
    const createBudget = rescanContext.createBudget ?? rescanContext.gap;
    const lines = [
      '## ⚠️ 增量扫描模式 — 已有知识 (勿重复)',
      `本维度已有 ${rescanContext.existing} 个有效 Recipe，覆盖缺口 ${rescanContext.gap} 个，本次创建预算 ${createBudget} 个。`,
      '已有 Recipe 标题:',
    ];
    for (const r of rescanContext.existingRecipes.slice(0, 10)) {
      const triggerTag = r.trigger ? ` (trigger: ${r.trigger})` : '';
      lines.push(`- "${r.title}"${triggerTag}`);
    }
    if (rescanContext.existingRecipes.length > 10) {
      lines.push(`- ... 共 ${rescanContext.existingRecipes.length} 个`);
    }
    lines.push('');
    if (rescanContext.executionMode === 'verify-only') {
      lines.push(
        '**你的任务**: 只验证受影响或衰退的已有知识是否仍然成立，记录分析发现；本维度不进入候选生产。'
      );
    } else {
      lines.push(
        '**你的任务**: 专注发现上述 Recipe **尚未覆盖**的新模式。不要重复分析相同的代码特征。'
      );
    }
    parts.push(lines.join('\n'));
  }

  // §10b: Rescan 衰退知识 — 可以替换
  if (rescanContext?.decayingRecipes && rescanContext.decayingRecipes.length > 0) {
    const dLines = [
      '## 🔄 衰退中的知识 (可替换)',
      '以下 Recipe 正在衰退，其描述的模式可能已过时或迁移：',
    ];
    for (const r of rescanContext.decayingRecipes.slice(0, 5)) {
      dLines.push(`- "${r.title}" — 衰退原因: ${r.decayReason || '未知'}`);
    }
    dLines.push('如果你在分析中发现了这些模式的**更新版本**（例如类改名、迁移到新模块），');
    dLines.push('请记录下来，后续 Producer 可以用 supersedes 参数提交替代版本。');
    parts.push(dLines.join('\n'));
  }

  return parts.join('\n\n');
}
