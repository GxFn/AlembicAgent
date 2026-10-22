/**
 * insight preset —— 深度分析+知识产出的运行时基块(W6-e 自 presets.ts 拆出,内容原样)。
 * strategy.stages 的阶段名是契约:AgentStageFactoryRegistry 按名取
 * analyze/quality_gate/produce/rejection_gate 再复制覆盖;数组下标顺序只决定
 * 直接以本 preset 运行时的执行顺序,不被工厂依赖。
 */
import {
  insightGateEvaluator,
  producerRejectionGateEvaluator,
  readEvolutionGateArtifact,
} from '../../evaluation/gateEvaluators.js';
import { BudgetPolicy } from '../../policies/index.js';
import {
  ANALYST_BUDGET,
  ANALYST_SYSTEM_PROMPT,
  buildAnalystPrompt,
} from '../../prompts/insightAnalyst.js';
import { buildAnalyzeRetryPrompt } from '../../prompts/insightGate.js';
import {
  buildProducerPromptV2,
  PRODUCER_BUDGET,
  PRODUCER_SYSTEM_PROMPT,
} from '../../prompts/insightProducer.js';
import { buildProducerRetryPrompt } from '../../prompts/producerRetry.js';
import type { DiagnosticsCollector } from '../../runtime/DiagnosticsCollector.js';
import type { ForcedSummaryMode } from '../../runtime/forcedSummary.js';
import type { PolicyFactoryConfig } from './types.js';

const PRODUCER_TIMEOUT_MS = 900_000;
const PRODUCER_RETRY_TIMEOUT_MS = 300_000;

type ProducerAnalysisArtifact = Parameters<typeof buildProducerPromptV2>[0];

/**
 * I37(L5-P31)：produce 的 promptBuilder 入参 gateArtifact 由 PipelineStrategy 按门名从 quality_gate
 * 读取(不再是「最近一个带产物的门」)；读不到或形状不符时为 null，管线已记
 * pipeline_producer_analysis_artifact_unavailable 诊断。buildProducerPromptV2 要解引用 analysisText 与
 * referencedFiles，缺失时只会得到空指针 TypeError——这里失败关闭并抛出带门名的明确错误：没有分析交接
 * 就不生产知识候选(改动前 null 同样必然抛错，只是错误不可归类)，不以空产物降级渲染。
 */
function requireProducerAnalysisArtifact(value: unknown): ProducerAnalysisArtifact {
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `PRODUCER_ANALYSIS_ARTIFACT_UNAVAILABLE: produce stage requires the "quality_gate" AnalysisArtifact handed off by gate name, got ${kind}`
    );
  }
  const record = value as Record<string, unknown>;
  const missing = [
    typeof record.analysisText === 'string' ? null : 'analysisText',
    Array.isArray(record.referencedFiles) ? null : 'referencedFiles',
  ].filter((field): field is string => field !== null);
  if (missing.length > 0) {
    throw new Error(
      `PRODUCER_ANALYSIS_ARTIFACT_UNAVAILABLE: "quality_gate" artifact lacks ${missing.join(', ')} required by the producer prompt`
    );
  }
  return value as ProducerAnalysisArtifact;
}

// ─── insight: 深度代码分析 + 知识产出 ────────
//
// v3.0 重设计: PipelineStrategy 增强版
//   - 每个 stage 有 systemPrompt + promptBuilder (替代通用 Capability prompt)
//   - quality_gate 用 insightGateEvaluator：返回 pass，或门给出的 analysis_retry / record_repair /
//     summary_rewrite / degrade（门未给动作时退回 retry）。各动作怎么处理（重跑、补写/重写微阶段、
//     PipelineStrategy 内部合成的 degraded_budget_exhausted / degraded_no_findings 等终态）以
//     PipelineStrategy 文件头「门动作表」与 #processGate 为准，这里不复述
//   - rejection_gate 用 producerRejectionGateEvaluator 监控 Producer 拒绝率（pass / retry）
//   - promptBuilder 通过 strategyContext 获取运行时数据 (dimConfig/sessionStore/...)
//
// 维度级 profile generate-dimension / module-mining-dimension 不直接展开本数组：它们声明
// AgentStageFactoryRegistry 的 generateDimensionPipeline 工厂，由工厂按阶段名取出这里的阶段再复制覆盖
// （动态 analyze 预算、终端工具、rescan 提交配额等；严格生产链路改用另一组阶段）。
// 阶段对象不声明 onToolCall：工具调用观察者是 runtime 级 onToolCall，由宿主经 AgentRunInput 的
// execution.onToolCall 传入（AgentService → AgentRuntimeBuilder → AgentRuntime）；PipelineStrategy 只在
// 阶段显式声明 stage.onToolCall 时才用它覆盖 runtime 级钩子，仓内内置阶段目前都不声明。

export const INSIGHT_PRESET = {
  name: '洞察',
  description:
    '深度代码分析 + 知识提取。增强 PipelineStrategy: Analyze→QualityGate→Produce→RejectionGate。',
  capabilities: ['code_analysis', 'knowledge_production'],
  strategy: {
    type: 'pipeline',
    maxRetries: 1,
    stages: [
      // ── Phase 1: Analyst ──
      {
        name: 'analyze',
        capabilities: ['code_analysis'],
        // L5-P26（W1-03）：强制摘要契约由阶段声明，等于原主路径（宿主 analyst tracker）推断。
        // 无 tracker 的旁路不转发本声明（PipelineStrategy），保持 dimension-digest 旧值。
        summaryMode: 'analyst-report' satisfies ForcedSummaryMode,
        budget: {
          maxIterations: ANALYST_BUDGET.maxIterations,
          temperature: 0.4,
          timeoutMs: 480_000,
          maxSessionTokens: ANALYST_BUDGET.maxSessionTokens,
          maxSessionInputTokens: ANALYST_BUDGET.maxSessionInputTokens,
        },
        systemPrompt: ANALYST_SYSTEM_PROMPT,
        promptBuilder: (ctx: Record<string, unknown>) =>
          buildAnalystPrompt(
            ctx.dimConfig as Parameters<typeof buildAnalystPrompt>[0],
            ctx.projectInfo as Parameters<typeof buildAnalystPrompt>[1],
            ctx.dimContext as Parameters<typeof buildAnalystPrompt>[2],
            ctx.sessionStore as Parameters<typeof buildAnalystPrompt>[3],
            ctx.semanticMemory as Parameters<typeof buildAnalystPrompt>[4],
            ctx.codeEntityGraph as Parameters<typeof buildAnalystPrompt>[5],
            ctx.rescanContext as Parameters<typeof buildAnalystPrompt>[6],
            ctx.panorama as Parameters<typeof buildAnalystPrompt>[7],
            ctx.evidenceStarters as Parameters<typeof buildAnalystPrompt>[8],
            // 进化结果按阶段名取进化门产物；没跑进化阶段时为 null，提示省略该小节。
            readEvolutionGateArtifact(ctx.phaseResults),
            ctx.toolPolicyHints as Parameters<typeof buildAnalystPrompt>[10],
            {
              abortSignal: ctx.abortSignal as AbortSignal | undefined,
              timeoutMs: ctx.memoryReadTimeoutMs as number | undefined,
              totalMemoryBudget: ctx.memoryTokenBudget as number | undefined,
              onDiagnostic: (diagnostic) =>
                (ctx.diagnostics as DiagnosticsCollector | undefined)?.warn({
                  code: `memory_${diagnostic.phase}_${diagnostic.status}`,
                  stage: 'analyze',
                  message: diagnostic.reason,
                }),
            }
          ),
        // C53: 与 scan 管线共用 insightGate 的内部构建器，两条管线的 analyze 重试提示不再分叉。
        // L8-C05(I36)：同样只服务门重试(quality_gate 判 analysis_retry 写入 _retryContext 后)。本阶段未声明
        // retryBudget，不进入 fast retry；宿主若补上 retryBudget，fast retry 也只复用 promptBuilder 的阶段提示。
        retryPromptBuilder: (
          retryCtx: { reason?: string },
          _origPrompt: string,
          prev: Record<string, unknown>
        ) => buildAnalyzeRetryPrompt(retryCtx, prev),
        // 不声明阶段级 onToolCall：工具调用观察沿用 runtime 级 execution.onToolCall（见上方说明）。
      },

      // ── Phase 2: Quality Gate ──
      {
        name: 'quality_gate',
        gate: {
          evaluator: insightGateEvaluator,
          maxRetries: 1,
        },
      },

      // ── Phase 3: Producer ──
      {
        name: 'produce',
        capabilities: ['knowledge_production'],
        // L5-P26（W1-03）：与 NudgeGenerator producer 收尾同一 Markdown 契约，等于原主路径（producer tracker）推断。
        summaryMode: 'producer-summary' satisfies ForcedSummaryMode,
        // 透传完整 PRODUCER_BUDGET (searchBudget/maxSubmits/softSubmitLimit/idleRoundsToExit)
        // 供 ExplorationTracker 精确控制 PRODUCE→SUMMARIZE 转换时机
        // DeepSeek Pro 在真实项目候选生产阶段可能很慢；候选已提交前不要过早截断。
        budget: { ...PRODUCER_BUDGET, temperature: 0.3, timeoutMs: PRODUCER_TIMEOUT_MS },
        systemPrompt: PRODUCER_SYSTEM_PROMPT,
        // gateArtifact：PipelineStrategy 按门名读取的 quality_gate AnalysisArtifact(I37)，字段名沿用。
        promptBuilder: (ctx: Record<string, unknown>) =>
          buildProducerPromptV2(
            requireProducerAnalysisArtifact(ctx.gateArtifact),
            ctx.dimConfig as Parameters<typeof buildProducerPromptV2>[1],
            ctx.projectInfo as Parameters<typeof buildProducerPromptV2>[2],
            ctx.rescanContext as Parameters<typeof buildProducerPromptV2>[3],
            ctx.panorama as Parameters<typeof buildProducerPromptV2>[4],
            ctx.toolPolicyHints as Parameters<typeof buildProducerPromptV2>[5],
            // G3: 冷启动预计算统计(bootstrapStrategyFields.evidenceStarters)——量化「为什么这样选」
            ctx.evidenceStarters as Parameters<typeof buildProducerPromptV2>[6],
            // M1b(P5a)：本维度已入库标题——查重视野（主仓 bootstrap dedup seed / rescan 皆可携带）
            ctx.existingDimensionTitles as Parameters<typeof buildProducerPromptV2>[7]
          ),
        // 拒绝率过高时: 缩减预算 + 特定修复 prompt (对齐旧 ProducerAgent 的 rejection retry)
        // retryBudget 被两条重跑路径共用：rejection_gate 判 retry 的门重试，以及 PipelineStrategy 的
        // fast retry(首轮硬超时且确认零工具调用；声明 retryBudget 即开启)。
        retryBudget: { maxIterations: 5, temperature: 0.3, timeoutMs: PRODUCER_RETRY_TIMEOUT_MS },
        // L8-C05(I36)：retryPromptBuilder 只服务门重试——PipelineStrategy 仅在 phaseResults._retryContext
        // 存在(rejection_gate 判 retry)时调用它，此时 prev.produce 是上一轮回执，修复清单的被拒数才有意义。
        // fast retry 不调用它：重跑前 ContextWindow 被清空，管线复用上面 promptBuilder 已构建的完整阶段提示
        // (quality_gate 产物、维度配置、项目信息)再追加超时提示段，并记 pipeline_stage_fast_retry 诊断。
        // 因此这里只生成拒绝修复清单，不需要也不应承载 findings 等阶段任务上下文；不要把它当超时重试提示改造。
        retryPromptBuilder: (
          retryCtx: { reason?: string },
          _origPrompt: string,
          prev: Record<string, unknown>
        ) => {
          return buildProducerRetryPrompt(
            prev.produce as { toolCalls?: readonly unknown[] } | undefined
          );
        },
      },

      // ── Phase 4: Rejection Gate ──
      {
        name: 'rejection_gate',
        gate: {
          evaluator: producerRejectionGateEvaluator,
          maxRetries: 1,
        },
      },
    ],
  },
  policies: [
    (config?: PolicyFactoryConfig) =>
      new BudgetPolicy({
        maxIterations: config?.maxIterations ?? 24,
        maxTokens: config?.maxTokens ?? 4096,
        temperature: config?.temperature ?? 0.3,
        timeoutMs: config?.timeoutMs ?? 3_600_000,
        // 不在策略层设会话字段（maxSessionTokens / maxSessionInputTokens）：会话预算归阶段预算。
        // analyze 阶段预算声明 maxSessionInputTokens（ANALYST_BUDGET 默认值，或 computeAnalystBudget
        // 动态计算、与 contextWindowBudget 对齐）；BudgetController 按阶段内消耗执行，但只触发压缩，
        // 不负责终止（终止靠 maxIterations / 超时），PipelineStrategy 的重试判定读同一口径。
        // 阶段预算里的 maxSessionTokens 目前没有执行者（BudgetController 不消费），去留待事项②。
      }),
    // I43(L5-P44)：不再挂运行级 QualityGatePolicy。它在运行结束后评估的是最后主阶段 produce 的
    // 提交汇报而不是分析正文，且与管线门的文件引用口径不同，同一文本会得出不同结论；分析质量由
    // 上面 quality_gate 阶段的 insightGateEvaluator 判定，这是 insight 运行唯一的质量门。
    // 因此 insight 运行不再产生运行级 quality_warning，观察质量请看管线门结果(_pipelineOutcome 与
    // quality_gate 诊断)。legacy 参数 minEvidenceLength / minFileRefs / minToolCalls 对本预设不再生效；
    // QualityGatePolicy 类仍保留导出，调用方可显式注入。
  ],
  // persona 与 profile/override 浅合并；运行时只读 description（无 systemPrompt 阶段的“# 角色”段），
  // module-mining / generate 维度 profile 不覆盖它，合并结果就是这里的原值。
  persona: {
    role: 'analyst',
    description: '高级软件架构师 + 知识管理专家',
  },
  // 描述性声明（L8-C11）：enabled 没有读取者，并不让 insight 运行“无状态”——scan/insight 的 note_finding
  // 仍经运行上下文的 memoryCoordinator 写入记忆；不要据此去掉 memoryCoordinator。去留待事项②。
  memory: {
    enabled: false,
  },
};
