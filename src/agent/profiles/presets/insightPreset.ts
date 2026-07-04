/**
 * insight preset —— 深度分析+知识产出的运行时基块(W6-e 自 presets.ts 拆出,内容原样)。
 * ⚠️ strategy.stages 数组身份与下标顺序是契约:AgentStageFactoryRegistry 按
 * presetStages[0..3] 复制覆盖(analyze/quality_gate/produce/rejection_gate)。
 */
import { DIMENSION_COMPLETION_FLOOR } from '@alembic/core/knowledge';
import {
  insightGateEvaluator,
  producerRejectionGateEvaluator,
} from '../../evaluation/gateEvaluators.js';
import { BudgetPolicy, QualityGatePolicy } from '../../policies/index.js';
import {
  ANALYST_BUDGET,
  ANALYST_SYSTEM_PROMPT,
  buildAnalystPrompt,
} from '../../prompts/insightAnalyst.js';
import { buildRetryPrompt } from '../../prompts/insightGate.js';
import {
  buildProducerPromptV2,
  PRODUCER_BUDGET,
  PRODUCER_SYSTEM_PROMPT,
} from '../../prompts/insightProducer.js';
import type { PolicyFactoryConfig, ToolCallRecord } from './types.js';

const PRODUCER_TIMEOUT_MS = 900_000;
const PRODUCER_RETRY_TIMEOUT_MS = 300_000;

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
            ctx.gateArtifact as Parameters<typeof buildAnalystPrompt>[9],
            ctx.toolPolicyHints as Parameters<typeof buildAnalystPrompt>[10]
          ),
        retryPromptBuilder: (
          retryCtx: { reason?: string },
          _origPrompt: string,
          prev: Record<string, unknown>
        ) => {
          const prevAnalysis = (prev.analyze as { reply?: string } | undefined)?.reply || '';
          const retryHint = buildRetryPrompt(retryCtx.reason ?? '');
          return `${prevAnalysis}\n\n⚠️ 上述分析未通过质量检查: ${retryCtx.reason}\n\n${retryHint}`;
        },
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
        promptBuilder: (ctx: Record<string, unknown>) =>
          buildProducerPromptV2(
            ctx.gateArtifact as Parameters<typeof buildProducerPromptV2>[0], // 来自 quality_gate 的 AnalysisArtifact
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
          const prevProduce = prev.produce as { toolCalls?: ToolCallRecord[] } | undefined;
          const submitCalls = (prevProduce?.toolCalls || []).filter(
            (tc) => (tc.tool || tc.name) === 'knowledge'
          );
          const rejected = submitCalls.filter((tc) => {
            const res = tc.result;
            if (!res) {
              return false;
            }
            if (typeof res === 'string') {
              return res.includes('rejected') || res.includes('error');
            }
            return (
              res.status === 'rejected' ||
              res.status === 'error' ||
              res.reason === 'validation_failed'
            );
          }).length;
          return `你的 ${rejected} 个提交被拒绝了。请根据拒绝原因改进后重新提交，确保:
1. content 必须是对象: { markdown: "...", rationale: "...", pattern: "..." }
2. content.markdown 字段 ≥ 200 字符，含代码块 (\`\`\`)
3. content.rationale 必填 — 设计原理说明（为什么这样设计）
4. 包含来源标注 (来源: FileName.m:行号)
5. 标题使用项目真实类名，不以项目名开头
6. description 中文简述 ≤80 字，引用真实类名
7. 必填: title、description、trigger (@kebab-case)、kind (rule/pattern/fact)、doClause (英文祈使句)、reasoning.sources`;
        },
        skipOnDegrade: true,
      },

      // ── Phase 4: Rejection Gate ──
      {
        name: 'rejection_gate',
        gate: {
          evaluator: producerRejectionGateEvaluator,
          maxRetries: 1,
        },
        skipOnDegrade: true,
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
        // Session token 限制由 BudgetController 统一管理
        // (基于 computeAnalystBudget 动态计算，与 contextWindowBudget 对齐)
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
