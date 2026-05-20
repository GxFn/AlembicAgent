import { describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/index.js';
import { BudgetController } from '../src/agent/runtime/index.js';

function createBudgetController(
  contextWindow: ContextWindow,
  opts: {
    maxSessionInputTokens?: number;
    input?: number;
    abortSignal?: AbortSignal;
    enableL4Compaction?: boolean;
  } = {}
) {
  return new BudgetController({
    maxSessionInputTokens: opts.maxSessionInputTokens ?? 1000,
    cumulativeUsage: { input: opts.input ?? 850, output: 0, reasoning: 0, cacheHit: 0 },
    contextWindow,
    tracker: null,
    baseSystemPromptLength: 100,
    toolSchemaCount: 0,
    logger: { info: () => undefined, warn: () => undefined },
    enableL4Compaction: opts.enableL4Compaction,
    abortSignal: opts.abortSignal,
  });
}

describe('BudgetController L4 cooldown', () => {
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
