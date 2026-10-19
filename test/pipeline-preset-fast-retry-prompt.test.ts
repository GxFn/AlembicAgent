import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildScanPipelineStages } from '../src/agent/evaluation/stageBuilders.js';
import { INSIGHT_PRESET } from '../src/agent/profiles/presets/insightPreset.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';

// ─── L8-C05(L8-P04，与 L5-P30/I36 同一处改动的入口层配套回归) ───
// 实现已在 PipelineStrategy 落地(fast retry 复用缓存阶段提示 + 超时提示段，retryPromptBuilder 只服务门
// 重试)。L8 关心的是「出厂」阶段定义：insight 预设(INSIGHT_PRESET)与 scan 管线(buildScanPipelineStages)
// 的 produce 同时声明了 retryBudget(声明即开启 fast retry)和面向拒绝的 retryPromptBuilder
// (buildProducerRetryPrompt：「你的 N 个提交被拒绝了」修复清单)。这里不替换 produce 与 rejection_gate，
// 直接用出厂的 promptBuilder / retryPromptBuilder / retryBudget / producerRejectionGateEvaluator 跑管线，
// 只把 analyze 换成无提示阶段、把 quality_gate 换成交出 AnalysisArtifact 的桩(真实 insightGateEvaluator
// 需要 activeContext)，锁住两条重跑路径各自的提示来源：
//   - fast retry(首轮硬超时且零工具)：重跑提示 = 出厂 promptBuilder 的完整阶段提示(含 quality_gate 产物)
//     + 超时提示段；不得出现「0 个提交被拒绝」，retryPromptBuilder 不被调用；
//   - 门重试(rejection_gate 判 retry)：仍由出厂 retryPromptBuilder 按上一轮(即 fast retry 那一轮)的被拒
//     提交数生成修复清单，不追加超时提示，也不会再触发 fast retry。

type StageConfig = Record<string, unknown> & { name: string };
type PipelineWarning = { code: string; stage?: string; message: string };
type RetryPromptBuilderFn = (
  retryCtx: { reason?: string; artifact?: unknown },
  content: string,
  phaseResults: Record<string, unknown>
) => string;
type PromptBuilderFn = (ctx: Record<string, unknown>) => unknown;

const FINDING = 'OrderRepository 统一经 BaseRepository.withTransaction 写库';
const EVIDENCE_REF = 'src/repo/OrderRepository.ts:18-42';
// 带文件路径：insight producer 的分析摘要只保留含结构/路径/发现关键词的行，这一行必须能进摘要。
const ANALYSIS_MARKER = 'L8C05-ANALYSIS-MARKER 写库路径全部经 src/repo/BaseRepository.ts:5-20 包装';
const SNIPPET = 'return this.withTransaction(async (tx) => tx.insert(order));';
const TIMEOUT_NOTICE = '上一次尝试超时且未调用任何工具';
const ZERO_REJECTED = '你的 0 个提交被拒绝了';
const REJECTION_LIST = '个提交被拒绝了';
const dimConfig = { id: 'data-access', label: '数据访问模式', outputType: 'dual' };
const projectInfo = { name: 'l8-demo-app', lang: 'typescript', fileCount: 4 };

afterEach(() => {
  vi.restoreAllMocks();
});

/** quality_gate 交给 produce 的 AnalysisArtifact：分析文本 + 结构化发现 + 带行号的代码证据。 */
function analysisArtifact() {
  return {
    analysisText: `## 数据访问\n${ANALYSIS_MARKER}\n${FINDING}（来源: ${EVIDENCE_REF}）`,
    referencedFiles: ['src/repo/OrderRepository.ts', 'src/repo/BaseRepository.ts'],
    findings: [{ finding: FINDING, evidence: EVIDENCE_REF, importance: 8 }],
    evidenceMap: new Map([
      [
        'src/repo/OrderRepository.ts',
        {
          filePath: 'src/repo/OrderRepository.ts',
          codeSnippets: [{ startLine: 18, endLine: 42, content: SNIPPET }],
          summary: 'OrderRepository 写库入口',
          role: 'implementation',
        },
      ],
    ]),
    negativeSignals: [],
  };
}

const persistedSubmit = (id: string) => ({
  tool: 'knowledge',
  args: { action: 'submit', title: `candidate ${id}` },
  result: { status: 'created', id, lifecycle: 'pending' },
});
const rejectedSubmit = (reason: string) => ({
  tool: 'knowledge',
  args: { action: 'submit', title: `rejected: ${reason}` },
  result: { status: 'rejected', reason },
});

/** produce 第 n 次 reactLoop 回放 produceAttempts[n]；其他阶段正常完成并带一次读文件工具调用。 */
function scriptedRuntime(produceAttempts: Array<Record<string, unknown>>) {
  const calls: Array<{ phase: string; prompt: string }> = [];
  let produceRuns = 0;
  const runtime = {
    id: 'l8-c05-preset-runtime',
    reactLoop: vi.fn(async (prompt: string, opts?: Record<string, unknown>) => {
      const phase = String((opts?.context as Record<string, unknown> | undefined)?.pipelinePhase);
      calls.push({ phase, prompt });
      const base = {
        reply: `${phase} output`,
        toolCalls: [] as Array<Record<string, unknown>>,
        iterations: 1,
        tokenUsage: { input: 1, output: 1 },
      };
      if (phase === 'produce') {
        const attempt = produceAttempts[Math.min(produceRuns, produceAttempts.length - 1)];
        produceRuns += 1;
        return { ...base, ...attempt };
      }
      return {
        ...base,
        toolCalls: [
          {
            tool: 'code',
            args: { action: 'read', path: 'src/repo/OrderRepository.ts' },
            result: 'contents',
          },
        ],
      };
    }),
  };
  const producePrompts = () =>
    calls.filter((call) => call.phase === 'produce').map((call) => call.prompt);
  return { runtime, producePrompts };
}

/** 首轮硬超时且零工具：满足 canFastRetry。 */
const timedOutZeroTools = { reply: '', toolCalls: [], timedOut: true };

/**
 * 出厂阶段 → 可跑管线：analyze 换成无提示阶段，quality_gate 换成交出 AnalysisArtifact 的桩；
 * produce 与 rejection_gate 保持出厂定义，只把 promptBuilder / retryPromptBuilder 包成委托原实现的 spy。
 */
function wirePresetStages(shipped: StageConfig[]) {
  const produce = shipped.find((stage) => stage.name === 'produce');
  const rejectionGate = shipped.find((stage) => stage.name === 'rejection_gate');
  if (!produce || !rejectionGate) {
    throw new Error('shipped stages lack produce or rejection_gate');
  }
  // 出厂 produce 同时带 retryBudget(开启 fast retry)与面向拒绝的 retryPromptBuilder——正是 L8-C05 的前提。
  expect(produce.retryBudget).toBeTruthy();
  expect(typeof produce.retryPromptBuilder).toBe('function');
  expect(typeof produce.promptBuilder).toBe('function');
  const retryPromptBuilder = vi.fn(produce.retryPromptBuilder as RetryPromptBuilderFn);
  const promptBuilder = vi.fn(produce.promptBuilder as PromptBuilderFn);
  const resetForNewStage = vi.fn();
  const stages: StageConfig[] = [
    { name: 'analyze' },
    {
      name: 'quality_gate',
      gate: {
        evaluator: () => ({ action: 'pass', pass: true, artifact: analysisArtifact() }),
        maxRetries: 1,
      },
    },
    { ...produce, promptBuilder, retryPromptBuilder },
    rejectionGate,
  ];
  return { stages, promptBuilder, retryPromptBuilder, resetForNewStage };
}

function silenceLogger() {
  const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
  vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
  return info;
}

const fastRetryWarnings = (diagnostics: unknown) =>
  (
    ((diagnostics as { warnings?: unknown[] } | undefined)?.warnings ?? []) as PipelineWarning[]
  ).filter((warning) => warning.code === 'pipeline_stage_fast_retry');

const shippedProducePipelines = [
  {
    label: 'insight preset (INSIGHT_PRESET)',
    stages: () => INSIGHT_PRESET.strategy.stages as unknown as StageConfig[],
  },
  {
    label: 'scan extract (buildScanPipelineStages)',
    stages: () =>
      buildScanPipelineStages({
        task: 'extract',
        producePrompt: 'scan extract producer system prompt',
        analyzeCaps: [],
        produceCaps: [],
      }) as StageConfig[],
  },
  {
    label: 'scan summarize (buildScanPipelineStages)',
    stages: () =>
      buildScanPipelineStages({
        task: 'summarize',
        producePrompt: 'scan summarize producer system prompt',
        analyzeCaps: [],
        produceCaps: [],
      }) as StageConfig[],
  },
];

describe('L8-C05 shipped produce stages: fast retry reuses the stage prompt, gate retry keeps retryPromptBuilder', () => {
  it.each(
    shippedProducePipelines
  )('$label: hard timeout with zero tools reruns produce with the quality_gate artifact prompt plus the timeout notice, never the "0 rejected" fix list', async ({
    stages: shippedStages,
  }) => {
    const info = silenceLogger();
    const { stages, promptBuilder, retryPromptBuilder, resetForNewStage } = wirePresetStages(
      shippedStages()
    );
    const { runtime, producePrompts } = scriptedRuntime([
      timedOutZeroTools,
      { reply: 'produce output after fast retry', toolCalls: [persistedSubmit('cand-1')] },
    ]);

    const output = await new PipelineStrategy({ stages: stages as never }).execute(
      runtime,
      new AgentMessage({ content: 'mine data-access' }),
      {
        strategyContext: { dimConfig, projectInfo },
        contextWindow: { resetForNewStage, tokenCount: 0 },
      }
    );

    const prompts = producePrompts();
    expect(prompts).toHaveLength(2);
    // 首轮提示由出厂 promptBuilder 从 quality_gate 的 AnalysisArtifact 构建。
    expect(prompts[0]).toContain(ANALYSIS_MARKER);
    expect(prompts[0]).toContain(FINDING);
    expect(prompts[0]).toContain(SNIPPET);
    // 重跑前 ContextWindow 被清空：重跑提示必须原样承载首轮完整阶段提示，再附超时提示段。
    expect(resetForNewStage).toHaveBeenCalled();
    expect(prompts[1].startsWith(prompts[0])).toBe(true);
    expect(prompts[1]).toContain(ANALYSIS_MARKER);
    expect(prompts[1]).toContain(FINDING);
    expect(prompts[1]).toContain(SNIPPET);
    expect(prompts[1]).toContain(TIMEOUT_NOTICE);
    expect(prompts[1]).not.toContain(ZERO_REJECTED);
    expect(prompts[1]).not.toContain(REJECTION_LIST);
    expect(prompts[1]).not.toContain('Stage hard timeout');
    // 出厂 retryPromptBuilder 只服务门重试：fast retry 不调用它；promptBuilder 只构建一次(复用缓存)。
    expect(retryPromptBuilder).not.toHaveBeenCalled();
    expect(promptBuilder).toHaveBeenCalledTimes(1);
    // 出厂 rejection_gate(真实 producerRejectionGateEvaluator)对重跑回执判 pass，管线正常完成。
    const phases = output.phases as Record<string, Record<string, unknown>>;
    expect(phases.produce.timedOut).toBeUndefined();
    expect(phases.rejection_gate).toMatchObject({ pass: true, action: 'pass' });
    expect(phases._pipelineOutcome).toMatchObject({ outcome: 'completed' });
    // 分叉留痕：诊断与 info 日志都能看出触发原因、提示来源，以及 retryPromptBuilder 被绕过。
    const warnings = fastRetryWarnings(output.diagnostics);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ stage: 'produce' });
    expect(warnings[0].message).toContain('reason=stage_hard_timeout_zero_tools');
    expect(warnings[0].message).toContain('promptSource=stage_cached');
    expect(warnings[0].message).toContain('retryPromptBuilder=bypassed');
    expect(
      info.mock.calls.some((call) => {
        const text = String(call[0]);
        return (
          text.includes('Stage "produce" confirmed no tools') &&
          text.includes('promptSource=stage_cached') &&
          text.includes('retryPromptBuilder=bypassed')
        );
      })
    ).toBe(true);
  });

  it.each(
    shippedProducePipelines
  )('$label: a rejection_gate retry after the fast retry still uses the shipped retryPromptBuilder, counting the fast-retry attempt rejections', async ({
    stages: shippedStages,
  }) => {
    silenceLogger();
    const { stages, promptBuilder, retryPromptBuilder } = wirePresetStages(shippedStages());
    const { runtime, producePrompts } = scriptedRuntime([
      timedOutZeroTools,
      // fast retry 这一轮：3 条全被拒、0 条落库 → 出厂 rejection_gate 判 retry。
      {
        reply: 'fast retry produced only rejected submissions',
        toolCalls: [rejectedSubmit('a'), rejectedSubmit('b'), rejectedSubmit('c')],
      },
      { reply: 'repaired producer output', toolCalls: [persistedSubmit('cand-1')] },
    ]);

    const output = await new PipelineStrategy({ stages: stages as never }).execute(
      runtime,
      new AgentMessage({ content: 'mine data-access' }),
      { strategyContext: { dimConfig, projectInfo } }
    );

    const prompts = producePrompts();
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain(FINDING);
    expect(prompts[1]).toContain(TIMEOUT_NOTICE);
    expect(prompts[1]).not.toContain(REJECTION_LIST);
    // 门重试：_retryContext 存在，出厂 retryPromptBuilder 按上一轮(fast retry 轮)的 3 条被拒提交出修复清单。
    expect(retryPromptBuilder).toHaveBeenCalledTimes(1);
    expect(retryPromptBuilder.mock.calls[0][0].reason).toContain('3 rejections vs 0 successes');
    expect(prompts[2]).toContain('你的 3 个提交被拒绝了');
    expect(prompts[2]).not.toContain(TIMEOUT_NOTICE);
    // promptBuilder 只在首轮构建一次：fast retry 复用缓存，门重试走 retryPromptBuilder。
    expect(promptBuilder).toHaveBeenCalledTimes(1);
    // 门重试轮(isRetry)不再触发 fast retry：诊断只记首轮那一次。
    expect(fastRetryWarnings(output.diagnostics)).toHaveLength(1);
    const phases = output.phases as Record<string, Record<string, unknown>>;
    expect(phases._retries_rejection_gate).toBe(1);
    expect(phases.rejection_gate).toMatchObject({ pass: true, action: 'pass' });
    expect(phases._pipelineOutcome).toMatchObject({ outcome: 'completed' });
  });
});
