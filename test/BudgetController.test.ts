import { describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/index.js';
import { BudgetController } from '../src/agent/runtime/index.js';

function createBudgetController(contextWindow: ContextWindow) {
  return new BudgetController({
    maxSessionInputTokens: 10,
    cumulativeUsage: { input: 100, output: 0, reasoning: 0, cacheHit: 0 },
    contextWindow,
    tracker: null,
    baseSystemPromptLength: 100,
    toolSchemaCount: 0,
    logger: { info: () => undefined, warn: () => undefined },
  });
}

describe('BudgetController L4 cooldown', () => {
  it('does not re-request L4 compaction on the next pressure check after failure', async () => {
    const contextWindow = new ContextWindow(1, { thresholds: [0, 0, 0, 0, 0] });
    contextWindow.appendUserMessage('initial prompt');
    for (const index of [1, 2, 3, 4, 5, 6, 7, 8]) {
      contextWindow.appendUserMessage(`large message ${index} ${'x'.repeat(200)}`);
    }

    const controller = createBudgetController(contextWindow);
    const aiProvider = {
      chatWithTools: vi.fn(async () => {
        throw new Error('bad transcript');
      }),
    };

    controller.requestL4Compaction();
    const failed = await controller.executeL4IfPending(aiProvider);
    expect(failed).toEqual({ level: 4, removed: 0 });
    expect(controller.pendingL4).toBe(false);

    controller.checkBeforeLLMCall(2);
    expect(controller.pendingL4).toBe(false);

    controller.checkBeforeLLMCall(3);
    expect(controller.pendingL4).toBe(true);
    expect(aiProvider.chatWithTools).toHaveBeenCalledTimes(1);
  });
});
