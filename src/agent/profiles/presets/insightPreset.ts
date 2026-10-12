/**
 * insight preset —— 深度分析+知识产出的运行时基块(W6-e 自 presets.ts 拆出,内容原样)。
 * strategy.stages 的阶段名是契约:AgentStageFactoryRegistry 按名取
 * analyze/quality_gate/produce/rejection_gate 再复制覆盖;数组下标顺序只决定
 * 直接以本 preset 运行时的执行顺序,不被工厂依赖。
 */
import { DIMENSION_COMPLETION_FLOOR } from '@alembic/core/knowledge';
import {
  insightGateEvaluator,
  producerRejectionGateEvaluator,
  readEvolutionGateArtifact,
} from '../../evaluation/gateEvaluators.js';
import { BudgetPolicy, QualityGatePolicy } from '../../policies/index.js';
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
//   - Quality Gate 使用自定义 evaluator (三态: pass/retry/degrade)
//   - Rejection Gate 监控 Producer 拒绝率
//   - promptBuilder 通过 strategyContext 获取运行时数据 (dimConfig/sessionStore/...)
//
// bootstrap-dimension profile 通过 AgentStageFactoryRegistry 按需覆盖
// onToolCall 由 orchestrator 按维度注入 (闭包引用 ActiveContext)

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
        retryPromptBuilder: (
          retryCtx: { reason?: string },
          _origPrompt: string,
          prev: Record<string, unknown>
        ) => buildAnalyzeRetryPrompt(retryCtx, prev),
        // onToolCall: 由 orchestrator 按维度注入
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
        retryBudget: { maxIterations: 5, temperature: 0.3, timeoutMs: PRODUCER_RETRY_TIMEOUT_MS },
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
    (config?: PolicyFactoryConfig) =>
      new QualityGatePolicy({
        // C-3(2026-07-02 统一重构)：默认阈值改用 Core DIMENSION_COMPLETION_FLOOR 单源
        // (与宿主 dimension_complete evidence gate 同一组数字)。minToolCalls 是
        // pipeline 专属维度(宿主无工具循环),保持本地。
        minEvidenceLength: config?.minEvidenceLength ?? DIMENSION_COMPLETION_FLOOR.minAnalysisChars,
        minFileRefs: config?.minFileRefs ?? DIMENSION_COMPLETION_FLOOR.minFileRefs,
        minToolCalls: config?.minToolCalls ?? 3,
      }),
  ],
  persona: {
    role: 'analyst',
    description: '高级软件架构师 + 知识管理专家',
  },
  memory: {
    enabled: false, // 无状态 worker
  },
};
