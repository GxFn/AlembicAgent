import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/index.js';
import { BudgetController, type BudgetLogger } from '../src/agent/runtime/index.js';

afterEach(() => vi.restoreAllMocks());

/**
 * 构造 BudgetController。
 *
 * 会话预算口径是“阶段内”（I02 方案 A）：构造时共享累计器里的 input 是基线，
 * 只有本 loop 经 recordLLMUsage 写入的 input 才计入会话预算比值。
 * - priorRunInput：本 loop 之前整次运行已累计的 input（基线，例如 analyze 已用的量）；
 * - stageInput：本 loop 内已消耗的 input，经 recordLLMUsage 写入（同时写回共享累计器）。
 */
function createBudgetController(
  contextWindow: ContextWindow | null,
  opts: {
    maxSessionInputTokens?: number;
    priorRunInput?: number;
    stageInput?: number;
    abortSignal?: AbortSignal;
    enableL4Compaction?: boolean;
    logger?: BudgetLogger;
  } = {}
) {
  const controller = new BudgetController({
    maxSessionInputTokens: opts.maxSessionInputTokens ?? 1000,
    cumulativeUsage: { input: opts.priorRunInput ?? 0, output: 0, reasoning: 0, cacheHit: 0 },
    contextWindow,
    tracker: null,
    baseSystemPromptLength: 100,
    toolSchemaCount: 0,
    logger: opts.logger ?? { info: () => undefined, warn: () => undefined },
    enableL4Compaction: opts.enableL4Compaction,
    abortSignal: opts.abortSignal,
  });
  const stageInput = opts.stageInput ?? 850;
  if (stageInput > 0) {
    controller.recordLLMUsage({ inputTokens: stageInput });
  }
  return controller;
}

/** 收集 BudgetController 日志，便于断言短路路径的诊断输出。 */
function createCapturingLogger(): BudgetLogger & { lines: { info: string[]; warn: string[] } } {
  const lines = { info: [] as string[], warn: [] as string[] };
  return {
    lines,
    info: (msg: string) => {
      lines.info.push(msg);
    },
    warn: (msg: string) => {
      lines.warn.push(msg);
    },
  };
}

/** 追加若干轮体积很小的工具调用/结果，使 messages>4 但投影使用率仍远低于 L1 阈值。 */
function appendLowUsageToolRounds(window: ContextWindow, rounds: number): void {
  for (let round = 0; round < rounds; round++) {
    window.appendAssistantWithToolCalls(null, [
      { id: `call-${round}`, name: 'code', args: { action: 'read', round } },
    ]);
    window.appendToolResult(`call-${round}`, 'code', `short result ${round}`);
  }
}

/** 模拟有会话预算的 analyze 阶段：used/max = 0.95，预检后把压力写入共享窗口。 */
function pushAnalyzePressure(window: ContextWindow): void {
  const analyze = createBudgetController(window, {
    maxSessionInputTokens: 100_000,
    stageInput: 95_000,
  });
  analyze.checkBeforeLLMCall(1);
  expect(window.getToolResultQuota()).toEqual({ maxChars: 400, maxMatches: 2 });
}

describe('BudgetController L4 cooldown', () => {
  it('initializes and resets per-round quotas without a context window', () => {
    const controller = createBudgetController(null);
    const budget = controller.getToolBudget(1);
    expect(controller.getRemainingToolBudget()).toEqual({
      maxChars: budget.roundMaxChars,
      maxMatches: budget.perToolMaxMatches,
    });
    controller.recordToolCharsUsed(1000);
    expect(controller.getRemainingToolBudget().maxChars).toBe(budget.roundMaxChars - 1000);
    controller.getToolBudget(1);
    expect(controller.getRemainingToolBudget().maxChars).toBe(budget.roundMaxChars);
  });
  it('keeps L4 compaction disabled by default under pressure', async () => {
    const contextWindow = new ContextWindow(1, { thresholds: [0, 0, 0, 0, 0] });
    contextWindow.appendUserMessage('initial prompt');
    contextWindow.appendUserMessage('large message');
    const controller = createBudgetController(contextWindow, {
      maxSessionInputTokens: 10,
      stageInput: 100,
    });
    const aiProvider = {
      chatWithTools: vi.fn(async () => ({ text: 'summary' })),
    };

    controller.requestL4Compaction();
    expect(controller.pendingL4).toBe(false);

    controller.checkBeforeLLMCall(2);
    expect(controller.pendingL4).toBe(false);

    const result = await controller.executeL4IfPending(aiProvider);
    expect(result).toEqual({ level: 0, removed: 0 });
    expect(aiProvider.chatWithTools).not.toHaveBeenCalled();
  });

  it('does not re-request L4 compaction on the next pressure check after failure', async () => {
    const contextWindow = new ContextWindow(1, { thresholds: [0, 0, 0, 0, 0] });
    contextWindow.appendUserMessage('initial prompt');
    for (const index of [1, 2, 3, 4, 5, 6, 7, 8]) {
      contextWindow.appendUserMessage(`large message ${index} ${'x'.repeat(200)}`);
    }

    const controller = createBudgetController(contextWindow, { enableL4Compaction: true });
    const aiProvider = {
      chatWithTools: vi.fn(async () => {
        throw new Error('bad transcript');
      }),
    };

    controller.requestL4Compaction();
    const failed = await controller.executeL4IfPending(aiProvider);
    expect(failed).toMatchObject({ level: 4, removed: 0, failed: true });
    expect(failed.hardStop).toBeUndefined();
    expect(controller.pendingL4).toBe(false);

    controller.checkBeforeLLMCall(2);
    expect(controller.pendingL4).toBe(false);

    controller.checkBeforeLLMCall(3);
    expect(controller.pendingL4).toBe(true);
    expect(aiProvider.chatWithTools).toHaveBeenCalledTimes(1);
  });

  it('hard-stops L4 compaction when failure happens under runaway budget pressure', async () => {
    const contextWindow = new ContextWindow(1, { thresholds: [0, 0, 0, 0, 0] });
    contextWindow.appendUserMessage('initial prompt');
    contextWindow.appendUserMessage('large message');
    const controller = createBudgetController(contextWindow, {
      maxSessionInputTokens: 10,
      stageInput: 100,
      enableL4Compaction: true,
    });
    const aiProvider = {
      chatWithTools: vi.fn(async () => {
        throw new Error('summary validation failed');
      }),
    };

    controller.requestL4Compaction();
    const failed = await controller.executeL4IfPending(aiProvider);

    expect(failed).toMatchObject({
      level: 4,
      removed: 0,
      failed: true,
      hardStop: true,
      reason: 'l4_compaction_failed_budget_exhausted',
    });
  });

  it('does not start L4 compaction after abort', async () => {
    const contextWindow = new ContextWindow(1, { thresholds: [0, 0, 0, 0, 0] });
    contextWindow.appendUserMessage('initial prompt');
    contextWindow.appendUserMessage('large message');
    const abortController = new AbortController();
    abortController.abort();
    const controller = createBudgetController(contextWindow, {
      abortSignal: abortController.signal,
      enableL4Compaction: true,
    });
    const aiProvider = {
      chatWithTools: vi.fn(async () => ({ text: 'summary' })),
    };

    controller.requestL4Compaction();
    const result = await controller.executeL4IfPending(aiProvider);

    expect(result).toMatchObject({
      level: 4,
      removed: 0,
      failed: true,
      cancelled: true,
      reason: 'abort_signal',
    });
    expect(aiProvider.chatWithTools).not.toHaveBeenCalled();
  });
});

describe('BudgetController session pressure lifecycle', () => {
  it('clears inherited session pressure on stage reset so a budget-less stage gets default quotas', () => {
    const window = new ContextWindow(48_000);
    window.appendUserMessage('analyze');
    pushAnalyzePressure(window);

    window.resetForNewStage();
    // 阶段隔离本身就必须清掉压力：此时窗口为空，配额应回到默认档。
    expect(window.getToolResultQuota()).toEqual({ maxChars: 6000, maxMatches: 15 });
    const resetEntry = window.getCompactionLog().at(-1);
    expect(resetEntry).toContain('RESET_STAGE');
    expect(resetEntry).toContain('95.0%');

    window.appendUserMessage('produce');
    appendLowUsageToolRounds(window, 3);
    const logger = createCapturingLogger();
    const produce = createBudgetController(window, {
      maxSessionInputTokens: 0,
      priorRunInput: 95_000,
      stageInput: 0,
      logger,
    });

    expect(produce.checkBeforeLLMCall(1)).toEqual({
      action: 'normal',
      estimatedNextCallTokens: 0,
      sessionUsageRatio: 0,
      compaction: { level: 0, removed: 0 },
    });
    expect(window.getTokenUsageRatio()).toBeLessThan(0.4);
    expect(window.getToolResultQuota()).toEqual({ maxChars: 6000, maxMatches: 15 });
    expect(produce.getToolBudget(1)).toEqual({
      roundMaxChars: 6000,
      perToolMaxChars: 6000,
      perToolMaxMatches: 15,
    });
    expect(window.toMessages().length).toBeGreaterThan(4);
    expect(produce.runCompactionCycle()).toEqual({ level: 0, removed: 0 });
  });

  it('clears stale session pressure when a budget-less loop reuses the window without a stage reset', () => {
    const window = new ContextWindow(48_000);
    window.appendUserMessage('analyze');
    pushAnalyzePressure(window);
    appendLowUsageToolRounds(window, 3);

    const contextWindowInfo = vi
      .spyOn(Logger.getInstance(), 'info')
      .mockImplementation(() => undefined);
    const logger = createCapturingLogger();
    const produce = createBudgetController(window, { maxSessionInputTokens: 0, logger });

    produce.checkBeforeLLMCall(1);
    produce.checkBeforeLLMCall(2);

    expect(window.getToolResultQuota()).toEqual({ maxChars: 6000, maxMatches: 15 });
    expect(produce.runCompactionCycle()).toEqual({ level: 0, removed: 0 });

    // 短路路径必须有诊断：每个无预算 loop 只记一次原因，不逐轮刷屏。
    const clearedByBudget = logger.lines.info.filter((line) => line.includes('no session budget'));
    expect(clearedByBudget).toHaveLength(1);
    expect(clearedByBudget[0]).toContain('[BudgetController]');
    expect(clearedByBudget[0]).toContain('session pressure');

    // 原压力值由持有该值的 ContextWindow 记录；第二次预检时已为 0，不再重复记录。
    const clearedByWindow = contextWindowInfo.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('session pressure cleared'));
    expect(clearedByWindow).toHaveLength(1);
    expect(clearedByWindow[0]).toContain('95.0%');
  });

  it('keeps the budget-less preflight silent and a no-op without a context window', () => {
    const logger = createCapturingLogger();
    const controller = createBudgetController(null, { maxSessionInputTokens: 0, logger });

    expect(controller.checkBeforeLLMCall(1)).toEqual({
      action: 'normal',
      estimatedNextCallTokens: 0,
      sessionUsageRatio: 0,
      compaction: { level: 0, removed: 0 },
    });
    expect(logger.lines.info).toEqual([]);
    expect(logger.lines.warn).toEqual([]);
  });
});

/**
 * I02（L5-P07，方案 A）：阶段会话预算 maxSessionInputTokens 衡量“本 loop 内”的 input 消耗。
 * 共享累计器仍是整次运行的引用（写回不变），但比值、压力、遥测、估算与 L4 硬停都以
 * 构造时的基线为起点，不再拿 analyze 已用的 30 万 input 去比 record_repair 的 12k 预算。
 */
describe('BudgetController stage session budget baseline (I02)', () => {
  const RECORD_REPAIR_BUDGET = 12_000;

  function createRunUsage(input: number) {
    return { input, output: 40_000, reasoning: 0, cacheHit: 0 };
  }

  /** 模拟 record_repair：analyze 已累计大量 input，resetForNewStage 后窗口只剩微阶段 prompt。 */
  function createMicroStage(
    runUsage: ReturnType<typeof createRunUsage>,
    opts: { contextWindow?: ContextWindow | null; logger?: BudgetLogger; enableL4?: boolean } = {}
  ) {
    let contextWindow: ContextWindow | null;
    if (opts.contextWindow === undefined) {
      contextWindow = new ContextWindow(24_000);
      contextWindow.appendUserMessage('record repair prompt '.repeat(50));
    } else {
      contextWindow = opts.contextWindow;
    }
    const controller = new BudgetController({
      maxSessionInputTokens: RECORD_REPAIR_BUDGET,
      cumulativeUsage: runUsage,
      contextWindow,
      tracker: null,
      baseSystemPromptLength: 300,
      toolSchemaCount: 2,
      logger: opts.logger ?? { info: () => undefined, warn: () => undefined },
      enableL4Compaction: opts.enableL4 ?? false,
    });
    return { controller, contextWindow };
  }

  it('measures a micro-stage budget against in-stage input, not the run-level cumulative input', () => {
    const runUsage = createRunUsage(300_000);
    const { controller, contextWindow } = createMicroStage(runUsage);

    const result = controller.checkBeforeLLMCall(1);

    // 首轮只有本阶段的下一次调用估算，比值≈est/12000，而不是 (300000+est)/12000≈25。
    expect(result.estimatedNextCallTokens).toBeGreaterThan(0);
    expect(result.sessionUsageRatio).toBeCloseTo(
      result.estimatedNextCallTokens / RECORD_REPAIR_BUDGET,
      10
    );
    expect(result.sessionUsageRatio).toBeLessThan(0.75);
    expect(result.action).toBe('normal');
    expect(controller.sessionUsageRatio).toBe(0);
    // 压力按阶段内已用量写入共享窗口：工具配额不落到最低档。
    expect(contextWindow?.getToolResultQuota()).toEqual({ maxChars: 6000, maxMatches: 15 });
    expect(controller.getToolBudget(1)).toEqual({
      roundMaxChars: 6000,
      perToolMaxChars: 6000,
      perToolMaxMatches: 15,
    });
    // 预检不改运行级累计。
    expect(runUsage.input).toBe(300_000);
  });

  it('writes in-stage usage back to the shared run accumulator while ratios and summary stay in-stage', () => {
    const runUsage = createRunUsage(300_000);
    runUsage.reasoning = 7_000;
    runUsage.cacheHit = 90_000;
    const { controller } = createMicroStage(runUsage);

    controller.recordLLMUsage({
      inputTokens: 6_000,
      outputTokens: 500,
      reasoningTokens: 100,
      cacheHitTokens: 3_000,
    });

    // 共享引用仍是整次运行累计：PipelineStrategy/AgentService 看到的总账不变。
    expect(runUsage).toEqual({
      input: 306_000,
      output: 40_500,
      reasoning: 7_100,
      cacheHit: 93_000,
    });
    expect(controller.cumulativeUsage).toBe(runUsage);
    expect(controller.sessionUsageRatio).toBeCloseTo(0.5, 10);
    expect(controller.getSessionSummary()).toEqual({
      totalIterations: 1,
      totalInputTokens: 6_000,
      totalOutputTokens: 500,
      totalReasoningTokens: 100,
      avgCacheHitRate: 0.5,
      peakSessionUsageRatio: 0.5,
      maxCompactionLevel: 0,
      totalCompactedItems: 0,
      forcedSummarize: false,
    });

    // 下一轮：阶段内 6000 已用 + 上一轮 6000 估算 = 12000/12000。
    const next = controller.checkBeforeLLMCall(2);
    expect(next.estimatedNextCallTokens).toBe(6_000);
    expect(next.sessionUsageRatio).toBeCloseTo(1, 10);
    expect(next.action).toBe('compress');
  });

  it('does not hard-stop a failed L4 in a micro-stage just because earlier stages consumed the run', async () => {
    const contextWindow = new ContextWindow(1, { thresholds: [0, 0, 0, 0, 0] });
    contextWindow.appendUserMessage('initial prompt');
    contextWindow.appendUserMessage('large message');
    const runUsage = createRunUsage(300_000);
    const { controller } = createMicroStage(runUsage, { contextWindow, enableL4: true });
    const aiProvider = {
      chatWithTools: vi.fn(async () => {
        throw new Error('summary validation failed');
      }),
    };

    controller.requestL4Compaction();
    const firstFailure = await controller.executeL4IfPending(aiProvider);
    expect(firstFailure).toMatchObject({ level: 4, failed: true });
    expect(firstFailure.hardStop).toBeUndefined();

    // 阶段内消耗真正失控（16000/12000 ≥ 1.3）时，L4 失败仍然硬停。
    controller.recordLLMUsage({ inputTokens: 16_000 });
    controller.requestL4Compaction();
    const runaway = await controller.executeL4IfPending(aiProvider);
    expect(runaway).toMatchObject({
      level: 4,
      failed: true,
      hardStop: true,
      reason: 'l4_compaction_failed_budget_exhausted',
    });
  });

  it('estimates the next call from in-stage averages when there is no context window', () => {
    const runUsage = createRunUsage(300_000);
    const { controller } = createMicroStage(runUsage, { contextWindow: null });

    // 阶段内尚无消耗：回退默认估算，而不是 300000/(iteration-1)。
    const fresh = controller.checkBeforeLLMCall(3);
    expect(fresh.estimatedNextCallTokens).toBe(8_000);
    expect(fresh.sessionUsageRatio).toBeCloseTo(8_000 / RECORD_REPAIR_BUDGET, 10);
    expect(fresh.action).toBe('normal');

    // 上一轮 usage 缺失（0）时按阶段内均值估算：4000/(3-1)=2000。
    controller.recordLLMUsage({ inputTokens: 4_000 });
    controller.recordLLMUsage({ inputTokens: 0 });
    const averaged = controller.checkBeforeLLMCall(3);
    expect(averaged.estimatedNextCallTokens).toBe(2_000);
    expect(averaged.sessionUsageRatio).toBeCloseTo((4_000 + 2_000) / RECORD_REPAIR_BUDGET, 10);
  });

  it('clamps in-stage usage to zero and warns once if the shared accumulator drops below the baseline', () => {
    const logger = createCapturingLogger();
    const runUsage = createRunUsage(300_000);
    const { controller } = createMicroStage(runUsage, { logger });

    // 防御路径：宿主在 loop 中途把共享累计器改小（正常只有 BudgetController 写入）。
    runUsage.input = 0;
    expect(controller.sessionUsageRatio).toBe(0);
    expect(controller.getSessionSummary().totalInputTokens).toBe(0);
    const warnings = logger.lines.warn.filter((line) =>
      line.includes("below this loop's baseline")
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('input: 0 < baseline 300000');
  });

  it('reports in-stage session usage with the run total and baseline in preflight and turn telemetry', () => {
    const logger = createCapturingLogger();
    const runUsage = createRunUsage(300_000);
    const { controller } = createMicroStage(runUsage, { logger });

    controller.recordLLMUsage({ inputTokens: 6_000, cacheHitTokens: 3_000 });
    controller.emitTurnTelemetry({
      iteration: 1,
      currentUsage: { inputTokens: 6_000, cacheHitTokens: 3_000 },
      compaction: { level: 0, removed: 0 },
    });
    const telemetry = logger.lines.info.find((line) => line.startsWith('[TurnTelemetry]'));
    expect(telemetry).toContain('session=6000/12000 (50.0%)');
    expect(telemetry).toContain('run=306000');

    controller.checkBeforeLLMCall(2);
    const preflight = logger.lines.info.find((line) => line.includes('session 预检'));
    expect(preflight).toContain('stage 6000 used');
    expect(preflight).toContain('12000/12000');
    expect(preflight).toContain('run total 306000');
    expect(preflight).toContain('baseline 300000');
  });
});
