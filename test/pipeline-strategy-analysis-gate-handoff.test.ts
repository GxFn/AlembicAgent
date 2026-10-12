/**
 * I37(L5-P31)：Producer 的分析产物按门名交接。
 *
 * 背景：PipelineStrategy.#storeGateResult 对任意门、任意动作只要 artifact 为真就覆盖
 * ctx.gateArtifact，produce 的覆盖率预算(withProducerCoverageBudget)与 promptBuilder 都读这个
 * 「最近一个门产物」。一旦 rejection_gate 或中间门带产物，produce 拿到的是无关对象；quality_gate
 * pass 却不带产物时，produce 拿到更早的 evolution_gate 产物。
 *
 * 本组测试锁定：非严格链的 producer 按名读取 phaseResults.quality_gate.artifact；读不到或形状不符
 * 得到 null 并留下 pipeline_producer_analysis_artifact_unavailable 诊断；严格链仍消费显式投影的
 * ctx.gateArtifact(transition.resultArtifact)；insight / scan 的 producer promptBuilder 对 null
 * 有确定的处理与留痕。
 */
import Logger from '@alembic/core/logging';
import { createFinalExpandedMiningScheduleReceiptV1 } from '@alembic/core/production';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildScanPipelineStages } from '../src/agent/evaluation/stageBuilders.js';
import {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisGateOutcomeV1,
  type StrictAnalysisEpochSnapshotV1,
} from '../src/agent/production/StrictProductionPipeline.js';
import type { StrictProductionRuntimePortV1 } from '../src/agent/production/StrictProductionStages.js';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';
import { INSIGHT_PRESET } from '../src/agent/profiles/presets/insightPreset.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { DiagnosticsCollector } from '../src/agent/runtime/DiagnosticsCollector.js';
import { PipelineStrategy } from '../src/agent/strategies/PipelineStrategy.js';

type Warning = { code: string; stage?: string; message: string };
type Stage = Record<string, unknown>;

const UNAVAILABLE = 'pipeline_producer_analysis_artifact_unavailable';
const SCAN_FALLBACK = 'scan_producer_prompt_fallback';
const PRODUCE_BUDGET = {
  maxIterations: 24,
  maxSubmits: 10,
  softSubmitLimit: 10,
  timeoutMs: 900_000,
};

function findingsOf(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    finding: `finding-${i}`,
    evidence: `src/f${i}.ts:1-3`,
    importance: 7,
  }));
}

/** quality_gate 的 AnalysisArtifact 同形产物(analysisText + findings + referencedFiles)。 */
function analysisArtifact(count: number, analysisText = 'QUALITY-GATE-ANALYSIS-MARKER') {
  return {
    analysisText,
    findings: findingsOf(count),
    referencedFiles: ['src/a.ts'],
    negativeSignals: [],
  };
}

function passGate(name: string, artifact?: unknown): Stage {
  return {
    name,
    gate: {
      evaluator: () => ({
        action: 'pass',
        pass: true,
        ...(artifact === undefined ? {} : { artifact }),
      }),
    },
  };
}

/** 记录每次 produce 阶段收到的提示与 budgetOverride；带 1 次工具调用，避免误入 fast retry。 */
function createCapturingRuntime(options: { produceTimesOutFirst?: boolean } = {}) {
  const produceCalls: Array<{ prompt: string; budget: Record<string, unknown> | undefined }> = [];
  const runtime = {
    id: 'analysis-handoff-runtime',
    async reactLoop(prompt: string, opts?: Record<string, unknown>) {
      const phase = (opts?.context as Record<string, unknown> | undefined)?.pipelinePhase;
      if (phase === 'produce') {
        produceCalls.push({
          prompt,
          budget: opts?.budgetOverride as Record<string, unknown> | undefined,
        });
        if (options.produceTimesOutFirst && produceCalls.length === 1) {
          // 首次尝试硬超时且零工具：满足 fast retry 条件。
          return {
            reply: '',
            toolCalls: [],
            tokenUsage: { input: 1, output: 1 },
            iterations: 1,
            timedOut: true,
          };
        }
      }
      return {
        reply: 'stage output long enough to be a reply',
        toolCalls: [{ tool: 'knowledge' }],
        tokenUsage: { input: 1, output: 1 },
        iterations: 1,
      };
    },
  };
  return { runtime, produceCalls };
}

/** 捕获 producer promptBuilder 收到的 gateArtifact。 */
function capturingProducePromptBuilder() {
  const seen: unknown[] = [];
  const promptBuilder = vi.fn((ctx: Record<string, unknown>) => {
    seen.push(ctx.gateArtifact);
    return 'produce prompt';
  });
  return { promptBuilder, seen };
}

function warningsOf(diagnostics: { warnings?: unknown[] } | undefined, code: string): Warning[] {
  return ((diagnostics?.warnings ?? []) as Warning[]).filter((warning) => warning.code === code);
}

function logLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PipelineStrategy — producer 按门名读取 quality_gate 分析产物(I37)', () => {
  it('rejection_gate 判 retry 且附带拒绝统计产物 → produce 重试的 promptBuilder 与预算仍读 quality_gate 的 findings', async () => {
    const infoLog = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const quality = analysisArtifact(20);
    const retryBudget = { maxIterations: 5, temperature: 0.3, timeoutMs: 300_000 };
    const { promptBuilder, seen } = capturingProducePromptBuilder();
    const { runtime, produceCalls } = createCapturingRuntime();
    let rejectionCalls = 0;
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        passGate('quality_gate', quality),
        // 不声明 retryPromptBuilder：门重试时也走 promptBuilder，才能观察重试轮拿到的 gateArtifact。
        { name: 'produce', budget: PRODUCE_BUDGET, retryBudget, promptBuilder },
        {
          name: 'rejection_gate',
          gate: {
            maxRetries: 1,
            evaluator: () => {
              rejectionCalls++;
              return rejectionCalls === 1
                ? {
                    action: 'retry',
                    pass: false,
                    reason: '3 rejections vs 1 success',
                    artifact: { rejected: 3, success: 1 },
                  }
                : { action: 'pass', pass: true };
            },
          },
        },
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'mine' }));

    expect(result.outcome).toBe('completed');
    expect(produceCalls).toHaveLength(2);
    expect(seen).toHaveLength(2);
    // 首轮与重试轮拿到的都是 quality_gate 的同一个产物，而不是拒绝统计对象。
    expect(seen[0]).toBe(quality);
    expect(seen[1]).toBe(quality);
    // 首轮按 20 条 findings 放大；重试轮沿用声明的 retryBudget(P29 语义保持)。
    expect(produceCalls[0].budget).toMatchObject({ maxSubmits: 24, targetSubmits: 20 });
    expect(produceCalls[1].budget).toEqual(retryBudget);
    // 重试轮的预算分叉仍按 quality_gate 的 findings 计数留痕(读到拒绝统计时 findings=0 会直接短路)。
    const skipLog = logLines(infoLog).find((line) => /coverage amplification skipped/.test(line));
    expect(skipLog).toBeDefined();
    expect(skipLog).toContain('findings=20');
    expect(warningsOf(result.diagnostics, UNAVAILABLE)).toEqual([]);
  });

  it('quality_gate 与 produce 之间的中间门带产物 → produce 首轮的放大与提示仍来自 quality_gate', async () => {
    const infoLog = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const quality = analysisArtifact(20);
    const { promptBuilder, seen } = capturingProducePromptBuilder();
    const { runtime, produceCalls } = createCapturingRuntime();
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        passGate('quality_gate', quality),
        passGate('evidence_gate', { checkedFiles: 3 }),
        { name: 'produce', budget: PRODUCE_BUDGET, promptBuilder },
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'mine' }));

    expect(seen).toEqual([quality]);
    expect(produceCalls).toHaveLength(1);
    expect(produceCalls[0].budget).toMatchObject({
      maxSubmits: 24,
      targetSubmits: 20,
      timeoutMs: 1_800_000,
    });
    expect(warningsOf(result.diagnostics, UNAVAILABLE)).toEqual([]);
    // 分叉留痕：说明 producer 按门名读取，并忽略了更新的门产物。
    expect(
      logLines(infoLog).some(
        (line) =>
          line.includes('"produce"') &&
          line.includes('"quality_gate"') &&
          line.includes('ignores newer gate artifact')
      )
    ).toBe(true);
  });

  it('quality_gate pass 不带产物 → producer 得到 null 并有诊断，而不是更早的 evolution_gate 产物', async () => {
    vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const warnLog = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const evolutionArtifact = {
      processed: 2,
      totalRecipes: 2,
      pendingIds: [],
      evolved: 1,
      deprecated: 1,
      skipped: 0,
    };
    const { promptBuilder, seen } = capturingProducePromptBuilder();
    const { runtime, produceCalls } = createCapturingRuntime();
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'evolve' },
        passGate('evolution_gate', evolutionArtifact),
        { name: 'analyze' },
        passGate('quality_gate'),
        { name: 'produce', budget: PRODUCE_BUDGET, promptBuilder },
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'mine' }));

    expect(seen).toEqual([null]);
    // 无产物 → 不放大，预算保持声明值。
    expect(produceCalls[0].budget).toEqual(PRODUCE_BUDGET);
    const warnings = warningsOf(result.diagnostics, UNAVAILABLE);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].stage).toBe('produce');
    expect(warnings[0].message).toContain('"quality_gate"');
    expect(warnings[0].message).toContain('artifact_missing');
    expect(warnings[0].message).toContain('action=pass');
    expect(warnings[0].message).toContain('gateArtifact=null');
    expect(
      logLines(warnLog).some(
        (line) => line.includes('"produce"') && line.includes('artifact_missing')
      )
    ).toBe(true);
    // 不改变结局：诊断只做留痕。
    expect(result.outcome).toBe('completed');
  });

  it.each([
    ['数组', [1, 2, 3]],
    ['字符串', 'analysis text only'],
    ['findings 不是数组', { findings: 'not-an-array', analysisText: 'x' }],
    ['analysisText 不是字符串', { analysisText: 42 }],
    ['既无 findings 也无 analysisText', { score: 3 }],
  ])('quality_gate 产物形状不符(%s) → producer 得到 null，诊断标 artifact_malformed', async (_label, artifact) => {
    vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const { promptBuilder, seen } = capturingProducePromptBuilder();
    const { runtime, produceCalls } = createCapturingRuntime();
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        passGate('quality_gate', artifact),
        { name: 'produce', budget: PRODUCE_BUDGET, promptBuilder },
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'mine' }));

    expect(seen).toEqual([null]);
    expect(produceCalls[0].budget).toEqual(PRODUCE_BUDGET);
    const warnings = warningsOf(result.diagnostics, UNAVAILABLE);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('artifact_malformed');
  });

  it('管线未声明 quality_gate → producer 不再借用其他门的产物(gateArtifact=null)，只记 info 日志不记诊断', async () => {
    const infoLog = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const { promptBuilder, seen } = capturingProducePromptBuilder();
    const { runtime, produceCalls } = createCapturingRuntime();
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        passGate('review_gate', { findings: findingsOf(5) }),
        { name: 'produce', budget: PRODUCE_BUDGET, promptBuilder },
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'mine' }));

    expect(seen).toEqual([null]);
    expect(produceCalls[0].budget).toEqual(PRODUCE_BUDGET);
    expect(warningsOf(result.diagnostics, UNAVAILABLE)).toEqual([]);
    expect(
      logLines(infoLog).some(
        (line) =>
          line.includes('"produce"') &&
          line.includes('no "quality_gate" gate stage') &&
          line.includes('gateArtifact=null')
      )
    ).toBe(true);
  });

  it('fast retry 复用同一次解析结果：null 产物的诊断只记一次', async () => {
    vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const { promptBuilder, seen } = capturingProducePromptBuilder();
    const { runtime, produceCalls } = createCapturingRuntime({ produceTimesOutFirst: true });
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        passGate('quality_gate'),
        {
          name: 'produce',
          budget: PRODUCE_BUDGET,
          retryBudget: { maxIterations: 5, timeoutMs: 300_000 },
          promptBuilder,
        },
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'mine' }));

    expect(produceCalls).toHaveLength(2);
    expect(seen).toEqual([null]);
    expect(warningsOf(result.diagnostics, UNAVAILABLE)).toHaveLength(1);
  });
});

// ─── 严格链：ctx.gateArtifact 只承载 G1 transition.resultArtifact 的显式投影，语义不变 ───

const strictMessage = {
  role: 'internal',
  content: 'strict analysis handoff probe',
  metadata: {},
} as AgentMessage;

function createReadyEpoch(): StrictAnalysisEpochSnapshotV1 {
  const schedule = createFinalExpandedMiningScheduleReceiptV1({
    baselineScheduleHash: 'schedule-baseline',
    baselineObligationIds: ['base-1'],
    expansionReceipts: [],
  });
  return createStrictAnalysisEpochSnapshotV1({
    epoch: 1,
    context: createStrictAnalysisContextProjectionV1({
      runId: 'run-handoff',
      journalId: 'journal-handoff',
      manifestHash: 'manifest-handoff',
      planCognitionHash: 'plan-cognition-handoff',
      planHash: 'plan-handoff',
      requiredUniverseHash: 'universe-handoff',
      baselineScheduleHash: 'schedule-baseline',
      expansionHeadHash: null,
      currentExpandedScheduleHash: 'schedule-baseline',
      finalExpandedScheduleHash: schedule.finalExpandedScheduleHash,
      analysisFixpointHash: 'analysis-fixpoint-handoff',
      privateCorpusRevision: null,
      hypothesisExpressionSetHash: null,
      lensBindingsHash: 'lens-handoff',
      sourceArtifactHash: 'artifact-handoff',
      sourceRevisionVectorHash: 'vector-handoff',
      questionIds: ['question-1'],
      factQueryObligationIds: ['base-1'],
      analysisUnitIds: ['unit-1'],
      factIds: ['fact-base'],
      witnessIds: ['witness-base'],
      populationHashes: ['population-1'],
      clusterSetHashes: [],
      inductionReceiptHashes: [],
      hypothesisIds: [],
      falsificationReceiptHashes: [],
      dispositionReviewIds: [],
      evidenceEntryIds: ['evidence-base'],
      derivedFindingCount: 0,
    }),
    populations: [{ populationId: 'population-main', revision: 1, factIds: ['fact-base'] }],
    terminalObligationIds: ['base-1'],
    outstandingObligationIds: [],
  });
}

describe('PipelineStrategy — 严格链 producer 仍消费 G1 的显式投影(I37 不改严格链语义)', () => {
  it('strict produce 的 buildProducerInput 收到 transition.resultArtifact，且不记按名读取诊断', async () => {
    const epoch = createReadyEpoch();
    const producerInputs: unknown[] = [];
    const port = {
      enabled: true as const,
      analysisLimits: { maxEpochs: 3, maxObligations: 3 },
      expansionPort: createStrictAnalysisExpansionPortV1({
        baselineScheduleHash: 'schedule-baseline',
        baselineObligationIds: ['base-1'],
        knownFactFamilies: [],
        knownSubjectRefs: [],
        obligationCap: 2,
      }),
      readAnalysisEpoch: () => epoch,
      buildProducerInput: (analysis: unknown) => {
        producerInputs.push(analysis);
        return { analysisArtifact: analysis, producerEligibleHypothesisIds: [] };
      },
      // G1 outcome 的 artifact 经 transition.resultArtifact 显式投影给 strict producer。
      validateAnalystResult: (_source: unknown, observed: StrictAnalysisEpochSnapshotV1) =>
        createStrictAnalysisGateOutcomeV1({
          action: 'pass',
          reasonCode: 'stable-fixpoint',
          observedEpochHash: observed.snapshotHash,
          artifact: { strictAnalysis: 'fixpoint-artifact', hypothesisIds: [] },
        }),
      reviewProducerResult: () => ({
        action: 'pass',
        pass: true,
        artifact: { verdict: 'pass' },
      }),
    } satisfies StrictProductionRuntimePortV1;
    const stages = new AgentStageFactoryRegistry().build('generateDimensionPipeline', {
      params: { needsCandidates: true },
      context: { strategyContext: { strictProduction: port } },
    });

    const result = await new PipelineStrategy({ stages }).execute(
      {
        id: 'strict-analysis-handoff',
        reactLoop: async (prompt: string) => ({
          reply: prompt.includes('strict cold-start Producer')
            ? 'producer output'
            : 'analyst output',
          toolCalls: [],
          tokenUsage: { input: 1, output: 1 },
          iterations: 1,
        }),
      },
      strictMessage,
      { strategyContext: { strictProduction: port } }
    );

    const transition = (result.phases.analyst_fixpoint_gate as { artifact?: unknown }).artifact as {
      resultArtifact?: unknown;
    };
    expect(transition?.resultArtifact).toBeTruthy();
    expect(producerInputs).toHaveLength(1);
    expect(producerInputs[0]).toEqual(transition.resultArtifact);
    expect(warningsOf(result.diagnostics, UNAVAILABLE)).toEqual([]);
  });
});

// ─── insight / scan producer promptBuilder：对 null 的确定处理 ───

const promptDimension = { id: 'dim-arch', label: 'Architecture' };

function insightProduceStage(): Stage {
  const stage = (INSIGHT_PRESET.strategy.stages as Stage[]).find((s) => s.name === 'produce');
  if (!stage) {
    throw new Error('insight preset has no produce stage');
  }
  return stage;
}

describe('insight preset producer promptBuilder 与按名交接(I37)', () => {
  it('gateArtifact=null → 抛出带门名的明确错误，而不是空指针 TypeError', () => {
    const promptBuilder = insightProduceStage().promptBuilder as (ctx: Stage) => string;
    expect(() =>
      promptBuilder({ gateArtifact: null, dimConfig: promptDimension, projectInfo: { name: 'p' } })
    ).toThrow(/PRODUCER_ANALYSIS_ARTIFACT_UNAVAILABLE[\s\S]*quality_gate/);
    try {
      promptBuilder({ gateArtifact: null, dimConfig: promptDimension, projectInfo: { name: 'p' } });
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TypeError);
    }
  });

  it('真实 insight produce 跑在 PipelineStrategy 中：中间门产物不会替换 quality_gate 的分析文本', async () => {
    vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const quality = analysisArtifact(3);
    const { runtime, produceCalls } = createCapturingRuntime();
    const strategy = new PipelineStrategy({
      stages: [
        { name: 'analyze' },
        passGate('quality_gate', quality),
        passGate('evidence_gate', { checkedFiles: 3 }),
        insightProduceStage(),
      ],
    });

    const result = await strategy.execute(runtime, new AgentMessage({ content: 'mine' }), {
      strategyContext: { dimConfig: promptDimension, projectInfo: { name: 'fixture' } },
    });

    expect(result.outcome).toBe('completed');
    expect(produceCalls).toHaveLength(1);
    expect(produceCalls[0].prompt).toContain('QUALITY-GATE-ANALYSIS-MARKER');
    expect(produceCalls[0].prompt).toContain('finding-0');
  });
});

describe('scan producer promptBuilder 与按名交接(I37)', () => {
  function scanStages() {
    return buildScanPipelineStages({
      task: 'extract',
      producePrompt: 'scan producer system prompt',
      analyzeCaps: [],
      produceCaps: [],
      files: [{ relativePath: 'src/a.ts', content: 'export const a = 1;' }],
    });
  }

  it('真实 scan produce 跑在 PipelineStrategy 中：中间门产物不会把提示打回 analyze.reply 纯文本', async () => {
    vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const [analyze, , produce] = scanStages();
    const quality = analysisArtifact(2, 'SCAN-QUALITY-ANALYSIS-MARKER');
    const { runtime, produceCalls } = createCapturingRuntime();
    const diagnostics = new DiagnosticsCollector();
    const strategy = new PipelineStrategy({
      stages: [
        { ...analyze, promptBuilder: () => 'analyze' },
        passGate('quality_gate', quality),
        passGate('evidence_gate', { checkedFiles: 3 }),
        produce,
      ],
    });

    await strategy.execute(runtime, new AgentMessage({ content: 'scan' }), { diagnostics });

    expect(produceCalls).toHaveLength(1);
    expect(produceCalls[0].prompt).toContain('SCAN-QUALITY-ANALYSIS-MARKER');
    expect(warningsOf(diagnostics.toJSON(), SCAN_FALLBACK)).toEqual([]);
  });

  it('gateArtifact=null 且 analyze.reply 足够长 → 退回分析纯文本并记 scan_producer_prompt_fallback', () => {
    const produce = scanStages()[2] as { promptBuilder: (ctx: Stage) => string };
    const diagnostics = new DiagnosticsCollector();
    const reply = 'analysis '.repeat(40);
    const prompt = produce.promptBuilder({
      gateArtifact: null,
      phaseResults: { analyze: { reply } },
      diagnostics,
    });

    expect(prompt).toContain('## 代码分析');
    const warnings = warningsOf(diagnostics.toJSON(), SCAN_FALLBACK);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].stage).toBe('produce');
    expect(warnings[0].message).toContain('path=analyze_reply');
    expect(warnings[0].message).toContain('gateArtifact=null');
  });

  it('gateArtifact 缺 analysisText 且 analyze.reply 过短 → 退回源文件并记 scan_producer_prompt_fallback', () => {
    const produce = scanStages()[2] as { promptBuilder: (ctx: Stage) => string };
    const diagnostics = new DiagnosticsCollector();
    const prompt = produce.promptBuilder({
      gateArtifact: { findings: [] },
      phaseResults: { analyze: { reply: 'short' } },
      diagnostics,
    });

    expect(prompt).toContain('src/a.ts');
    const warnings = warningsOf(diagnostics.toJSON(), SCAN_FALLBACK);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('path=source_files');
    expect(warnings[0].message).toContain('analysisText missing');
  });

  it('完整产物 → 不记 fallback 诊断', () => {
    const produce = scanStages()[2] as { promptBuilder: (ctx: Stage) => string };
    const diagnostics = new DiagnosticsCollector();
    const prompt = produce.promptBuilder({
      gateArtifact: analysisArtifact(1, 'FULL-ARTIFACT'),
      phaseResults: {},
      diagnostics,
    });

    expect(prompt).toContain('FULL-ARTIFACT');
    expect(warningsOf(diagnostics.toJSON(), SCAN_FALLBACK)).toEqual([]);
  });
});
