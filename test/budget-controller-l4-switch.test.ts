import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextWindow } from '../src/agent/context/index.js';
import { BudgetController, type BudgetLogger } from '../src/agent/runtime/index.js';

/**
 * L6-P15（C04/C05）：BudgetController 侧的压缩信号与 L4 开关。
 * - C05：env 驱动的 enableL4Compaction 是 L4 唯一执行开关，构造时同步给 ContextWindow；
 *   窗口开关与控制器不一致时（另一控制器改写了共享窗口），compactL4 的 l4_disabled 短路
 *   被归为“跳过”，不计 L4 失败、不冷却、不硬停；
 * - C04：激进/普通压缩预检日志写出 compactIfNeeded 实际返回的等级，而不是只写意图标签。
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** 收集 BudgetController 日志，便于断言预检与跳过路径的诊断输出。 */
function capturingLogger(): BudgetLogger & { lines: { info: string[]; warn: string[] } } {
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

function createController(
  contextWindow: ContextWindow,
  opts: {
    enableL4Compaction?: boolean;
    logger?: BudgetLogger;
    maxSessionInputTokens?: number;
    stageInput?: number;
  } = {}
): BudgetController {
  const controller = new BudgetController({
    maxSessionInputTokens: opts.maxSessionInputTokens ?? 1000,
    cumulativeUsage: { input: 0, output: 0, reasoning: 0, cacheHit: 0 },
    contextWindow,
    tracker: null,
    baseSystemPromptLength: 100,
    toolSchemaCount: 0,
    logger: opts.logger ?? { info: () => undefined, warn: () => undefined },
    ...(opts.enableL4Compaction === undefined
      ? {}
      : { enableL4Compaction: opts.enableL4Compaction }),
  });
  const stageInput = opts.stageInput ?? 0;
  if (stageInput > 0) {
    controller.recordLLMUsage({ inputTokens: stageInput });
  }
  return controller;
}

/** 投影接近预算的小窗口：开关打开时 needsL4Compaction 为 true。 */
function saturatedWindow(compactionConfig?: { enableL4LLM?: boolean }): ContextWindow {
  const window = new ContextWindow(1_000, compactionConfig);
  window.appendUserMessage('initial analyze prompt');
  for (let index = 0; index < 4; index++) {
    window.appendAssistantWithToolCalls(null, [
      { id: `call-${index}`, name: 'code', args: { action: 'read', index } },
    ]);
    window.appendToolResult(`call-${index}`, 'code', `r${index}:${'x'.repeat(1900)}`);
  }
  window.compactIfNeeded();
  return window;
}

describe('BudgetController L4 switch authority (L6-P15 C05)', () => {
  it('syncs the env-driven switch onto the context window when no explicit config is given', () => {
    vi.stubEnv('ALEMBIC_AGENT_ENABLE_L4_COMPACTION', '1');
    const window = saturatedWindow();
    expect(window.needsL4Compaction()).toBe(false);

    createController(window);
    expect(window.needsL4Compaction()).toBe(true);
  });

  it('overrides a window configured with enableL4LLM=true when env leaves L4 off', async () => {
    vi.stubEnv('ALEMBIC_AGENT_ENABLE_L4_COMPACTION', undefined);
    const window = saturatedWindow({ enableL4LLM: true });
    expect(window.needsL4Compaction()).toBe(true);

    createController(window);
    expect(window.needsL4Compaction()).toBe(false);
    const chatWithTools = vi.fn(async () => ({ text: 'summary' }));
    const direct = await window.compactL4({ chatWithTools });
    expect(direct).toMatchObject({ failed: true, validationMissing: ['l4_disabled'] });
    expect(chatWithTools).not.toHaveBeenCalled();
  });

  it('lets an explicit enableL4Compaction config win over env and syncs it', () => {
    vi.stubEnv('ALEMBIC_AGENT_ENABLE_L4_COMPACTION', '1');
    const window = saturatedWindow({ enableL4LLM: true });
    createController(window, { enableL4Compaction: false });
    expect(window.needsL4Compaction()).toBe(false);
  });

  it('classifies an out-of-sync l4_disabled short-circuit as a skip, not an L4 failure', async () => {
    const logger = capturingLogger();
    const window = new ContextWindow(1, { thresholds: [0, 0, 0, 0, 0] });
    window.appendUserMessage('initial prompt');
    window.appendUserMessage('large message');
    // 阶段内压力 1.5（≥1.3）：若被误判为 L4 失败会立即硬停。
    const controller = createController(window, {
      enableL4Compaction: true,
      logger,
      stageInput: 1500,
    });
    // 另一个控制器（显式关闭 L4）复用同一窗口并在构造时把窗口开关同步为 false。
    createController(window, { enableL4Compaction: false });
    const chatWithTools = vi.fn(async () => ({ text: 'summary' }));

    controller.requestL4Compaction();
    expect(controller.pendingL4).toBe(true);
    const result = await controller.executeL4IfPending({ chatWithTools });

    expect(result).toEqual({ level: 0, removed: 0, reason: 'l4_disabled' });
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(controller.getSessionSummary().maxCompactionLevel).toBe(0);
    expect(
      logger.lines.warn.some((line) => line.includes('L4 switch is off on the context window'))
    ).toBe(true);
    // 跳过不进入冷却：下一次请求立即可以挂起。
    controller.requestL4Compaction();
    expect(controller.pendingL4).toBe(true);
  });
});

describe('BudgetController preflight compaction log (L6-P15 C04)', () => {
  it('writes the level compactIfNeeded actually reached on the aggressive path', () => {
    const logger = capturingLogger();
    const window = new ContextWindow(100_000);
    window.appendUserMessage('analyze prompt');
    for (let index = 0; index < 4; index++) {
      window.appendAssistantWithToolCalls(null, [
        { id: `call-${index}`, name: 'code', args: { action: 'read', index } },
      ]);
      window.appendToolResult(`call-${index}`, 'code', `short result ${index}`);
    }
    // 阶段内已用 95%（>90% 激进阈值），而窗口投影远低于 L1 阈值。
    const controller = createController(window, {
      logger,
      maxSessionInputTokens: 100_000,
      stageInput: 95_000,
      enableL4Compaction: false,
    });

    const check = controller.checkBeforeLLMCall(2);

    expect(check.action).toBe('compress');
    expect(check.compaction.level).toBe(1);
    const preflight = logger.lines.info.find((line) => line.includes('session 预检'));
    expect(preflight).toContain('激进压缩');
    expect(preflight).toContain('actual=L1');
    expect(preflight).toContain('removed=0');
    expect(preflight).toContain('L2/L3 follow projected usage');
  });

  it('writes actual=L0 when the window has too few messages to compact', () => {
    const logger = capturingLogger();
    const window = new ContextWindow(100_000);
    window.appendUserMessage('analyze prompt');
    const controller = createController(window, {
      logger,
      maxSessionInputTokens: 100_000,
      // 下一轮估算取上一轮 input（40k），投影 80k/100k = 0.8：越过 75% 压缩阈值，未到 90% 激进阈值。
      stageInput: 40_000,
      enableL4Compaction: false,
    });

    const check = controller.checkBeforeLLMCall(2);

    expect(check.action).toBe('compress');
    expect(check.compaction.level).toBe(0);
    const preflight = logger.lines.info.find((line) => line.includes('session 预检'));
    expect(preflight).toContain('→ 压缩');
    expect(preflight).toContain('actual=L0');
  });
});
