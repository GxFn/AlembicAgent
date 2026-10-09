import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/index.js';
import { BudgetController, type BudgetLogger } from '../src/agent/runtime/index.js';

afterEach(() => vi.restoreAllMocks());

function createBudgetController(
  contextWindow: ContextWindow | null,
  opts: {
    maxSessionInputTokens?: number;
    input?: number;
    abortSignal?: AbortSignal;
    enableL4Compaction?: boolean;
    logger?: BudgetLogger;
  } = {}
) {
  return new BudgetController({
    maxSessionInputTokens: opts.maxSessionInputTokens ?? 1000,
    cumulativeUsage: { input: opts.input ?? 850, output: 0, reasoning: 0, cacheHit: 0 },
    contextWindow,
    tracker: null,
    baseSystemPromptLength: 100,
    toolSchemaCount: 0,
    logger: opts.logger ?? { info: () => undefined, warn: () => undefined },
    enableL4Compaction: opts.enableL4Compaction,
    abortSignal: opts.abortSignal,
  });
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
    input: 95_000,
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
      input: 100,
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
      input: 100,
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
      input: 95_000,
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
