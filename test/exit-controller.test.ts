/**
 * ExitController 基线测试（L5-P1 / I33）。
 *
 * 直接构造 ExitController，用假 tracker 与假 validateDuring 锁定语义无争议的分支：
 *   - checkBeforeIteration 的判定顺序：abort 先于阶段超时，阶段超时先于 tracker（且不推进 tick）；
 *   - token 超限只给一次 graceful 机会（forceTerminal 只调用一次，第二次直接 exit）；
 *   - checkAfterLLM 在 SUMMARIZE 空响应下按 tracker.metrics.phaseRounds 给 2 轮 grace。
 *
 * 不在这里断言的内容（留给后续包按新语义补）：
 *   - createExitController 在无 stage session limit 时对 "session" 原因的屏蔽包装；
 *   - 策略级超时被归类为 policy_stop 还是 stage_timeout。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExplorationTracker } from '../src/agent/context/ExplorationTracker.js';
import type { StepState } from '../src/agent/policies/Policy.js';
import { ExitController, type ExitControllerConfig } from '../src/agent/runtime/ExitController.js';
import type { LoopContext } from '../src/agent/runtime/LoopContext.js';

type ValidateDuring = ExitControllerConfig['validateDuring'];

/** 最小 tracker 假体：只提供 ExitController 实际读取的成员；metrics 走公开 getter 形态。 */
function createFakeTracker(overrides: Record<string, unknown> = {}) {
  const tracker: Record<string, unknown> = {
    phase: 'SCAN',
    iteration: 0,
    totalSubmits: 0,
    isGracefulExit: false,
    isHardExit: false,
    tick: vi.fn(),
    shouldExit: vi.fn(() => false),
    forceTerminal: vi.fn(),
    metrics: { phaseRounds: 0 },
    ...overrides,
  };
  return tracker;
}

/** checkBeforeIteration 只读 ctx.iteration；checkAfterLLM 只读 isSystem 与 consecutiveEmptyResponses。 */
function createLoopCtx(
  overrides: { iteration?: number; isSystem?: boolean; consecutiveEmptyResponses?: number } = {}
): LoopContext {
  return {
    iteration: 1,
    isSystem: false,
    consecutiveEmptyResponses: 0,
    ...overrides,
  } as unknown as LoopContext;
}

const okValidate: ValidateDuring = () => ({ ok: true });

function createController(
  overrides: Partial<ExitControllerConfig> & { tracker?: Record<string, unknown> | null } = {}
) {
  const { tracker, ...rest } = overrides;
  const config: ExitControllerConfig = {
    tracker:
      tracker === undefined
        ? (createFakeTracker() as unknown as ExplorationTracker)
        : (tracker as unknown as ExplorationTracker | null),
    effectiveTimeoutMs: 0,
    abortSignal: null,
    validateDuring: okValidate,
    skipPolicyIterCheck: true,
    loopStartTime: Date.now(),
    maxIterations: 10,
    ...rest,
  };
  return new ExitController(config);
}

const NO_USAGE = { input: 0, output: 0 };

describe('ExitController.checkBeforeIteration 判定顺序', () => {
  it('abort 信号先于阶段超时：已超时 + tracker 要求退出时仍报 abort_signal，且不触碰 tracker/policy', () => {
    const abort = new AbortController();
    abort.abort();
    const tracker = createFakeTracker({ shouldExit: vi.fn(() => true) });
    const validateDuring: ValidateDuring = vi.fn(() => ({ ok: false, reason: 'should not run' }));
    const controller = createController({
      tracker,
      abortSignal: abort.signal,
      effectiveTimeoutMs: 1_000,
      loopStartTime: Date.now() - 60_000,
      validateDuring,
    });

    const signal = controller.checkBeforeIteration(createLoopCtx(), NO_USAGE);

    expect(signal).toMatchObject({ action: 'exit', reason: 'abort_signal', needsSummary: false });
    expect(tracker.tick).not.toHaveBeenCalled();
    expect(tracker.shouldExit).not.toHaveBeenCalled();
    expect(validateDuring).not.toHaveBeenCalled();
  });

  it('阶段超时先于 tracker：超时轮不调用 tick/shouldExit，也不进入 policy 判定', () => {
    const tracker = createFakeTracker({ shouldExit: vi.fn(() => true) });
    const validateDuring: ValidateDuring = vi.fn(() => ({ ok: true }));
    const controller = createController({
      tracker,
      effectiveTimeoutMs: 1_000,
      loopStartTime: Date.now() - 5_000,
      validateDuring,
    });

    const signal = controller.checkBeforeIteration(createLoopCtx(), NO_USAGE);

    expect(signal).toMatchObject({ action: 'exit', reason: 'stage_timeout', needsSummary: false });
    expect(signal.detail).toContain('1000ms exceeded');
    expect(tracker.tick).not.toHaveBeenCalled();
    expect(tracker.shouldExit).not.toHaveBeenCalled();
    expect(validateDuring).not.toHaveBeenCalled();
  });

  it('未超时时 tracker.shouldExit 决定退出：先 tick 再判定，退出需要摘要且不再问 policy', () => {
    const tracker = createFakeTracker({
      phase: 'RECORD',
      iteration: 7,
      totalSubmits: 3,
      shouldExit: vi.fn(() => true),
    });
    const validateDuring: ValidateDuring = vi.fn(() => ({ ok: true }));
    const controller = createController({ tracker, effectiveTimeoutMs: 60_000, validateDuring });

    const signal = controller.checkBeforeIteration(createLoopCtx(), NO_USAGE);

    expect(signal).toMatchObject({ action: 'exit', reason: 'tracker_exit', needsSummary: true });
    expect(signal.detail).toBe('phase=RECORD, iter=7, submits=3');
    expect(tracker.tick).toHaveBeenCalledTimes(1);
    expect(validateDuring).not.toHaveBeenCalled();
  });
});

describe('ExitController token 超限 grace', () => {
  const tokenStop: ValidateDuring = () => ({
    ok: false,
    reason: 'Budget: token limit exceeded',
  });

  it('只给一次 graceful 机会：首次 continue 并 forceTerminal，第二次直接 exit', () => {
    const tracker = createFakeTracker();
    const controller = createController({ tracker, validateDuring: tokenStop });

    const first = controller.checkBeforeIteration(createLoopCtx({ iteration: 1 }), NO_USAGE);
    expect(first).toMatchObject({ action: 'continue', reason: 'token_budget_exhausted' });
    expect(first.detail).toContain('forced SUMMARIZE');
    expect(tracker.forceTerminal).toHaveBeenCalledTimes(1);
    expect(tracker.forceTerminal).toHaveBeenCalledWith('Budget: token limit exceeded');

    const second = controller.checkBeforeIteration(createLoopCtx({ iteration: 2 }), NO_USAGE);
    expect(second).toMatchObject({
      action: 'exit',
      reason: 'token_budget_exhausted',
      needsSummary: true,
      detail: 'Budget: token limit exceeded',
    });
    expect(tracker.forceTerminal).toHaveBeenCalledTimes(1);
  });

  it('tracker 已处于终结状态时不再给 grace，直接 exit 且不调用 forceTerminal', () => {
    const tracker = createFakeTracker({ isGracefulExit: true });
    const controller = createController({ tracker, validateDuring: tokenStop });

    const signal = controller.checkBeforeIteration(createLoopCtx(), NO_USAGE);

    expect(signal).toMatchObject({ action: 'exit', reason: 'token_budget_exhausted' });
    expect(tracker.forceTerminal).not.toHaveBeenCalled();
  });

  it('无 tracker 时没有 grace 可给：token 超限直接 exit', () => {
    const controller = createController({ tracker: null, validateDuring: tokenStop });

    const signal = controller.checkBeforeIteration(createLoopCtx(), NO_USAGE);

    expect(signal).toMatchObject({
      action: 'exit',
      reason: 'token_budget_exhausted',
      needsSummary: true,
    });
  });

  it('policy 收到的 iteration：tracker 模式传 0，非 tracker 模式传已完成轮数', () => {
    const seen: StepState[] = [];
    const recordingValidate: ValidateDuring = (stepState) => {
      seen.push(stepState);
      return { ok: true };
    };
    const usage = { input: 120, output: 30 };

    createController({
      tracker: createFakeTracker(),
      skipPolicyIterCheck: true,
      validateDuring: recordingValidate,
    }).checkBeforeIteration(createLoopCtx({ iteration: 4 }), usage);
    createController({
      tracker: null,
      skipPolicyIterCheck: false,
      validateDuring: recordingValidate,
    }).checkBeforeIteration(createLoopCtx({ iteration: 4 }), usage);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ iteration: 0, totalTokens: 150, totalInputTokens: 120 });
    expect(seen[1]).toMatchObject({ iteration: 3, totalTokens: 150, totalInputTokens: 120 });
  });
});

describe('ExitController.checkAfterLLM SUMMARIZE 空响应 grace', () => {
  const emptyResult = { text: '', functionCalls: [] };

  it.each([
    [0, 'retry', 'grace 1/2'],
    [1, 'retry', 'grace 2/2'],
    [2, 'exit', 'grace exhausted'],
  ] as const)('phaseRounds=%i → action=%s（detail=%s），通过公开 getter metrics 读取轮数', (phaseRounds, action, detail) => {
    const metricsRead = vi.fn(() => ({ phaseRounds }));
    const tracker = createFakeTracker({ phase: 'SUMMARIZE' });
    Object.defineProperty(tracker, 'metrics', { get: metricsRead });
    const controller = createController({ tracker });

    const signal = controller.checkAfterLLM(emptyResult, createLoopCtx({ isSystem: true }));

    expect(metricsRead).toHaveBeenCalled();
    expect(signal).toMatchObject({ action, reason: 'empty_response_terminal', detail });
    if (action === 'exit') {
      expect(signal.needsSummary).toBe(true);
    } else {
      expect(signal.needsSummary).toBeUndefined();
    }
  });

  it('非终结阶段的空响应不走 SUMMARIZE grace：system 场景最多重试两次', () => {
    const tracker = createFakeTracker({ phase: 'SCAN', metrics: { phaseRounds: 0 } });
    const controller = createController({ tracker });

    expect(
      controller.checkAfterLLM(
        emptyResult,
        createLoopCtx({ isSystem: true, consecutiveEmptyResponses: 1 })
      )
    ).toMatchObject({ action: 'retry', reason: 'empty_response', detail: 'retry 2/2' });
    expect(
      controller.checkAfterLLM(
        emptyResult,
        createLoopCtx({ isSystem: true, consecutiveEmptyResponses: 2 })
      )
    ).toMatchObject({ action: 'exit', reason: 'empty_response', needsSummary: true });
  });

  it('llmResult 为 null 直接 exit 并要求摘要；有文本或工具调用则 continue', () => {
    const controller = createController({ tracker: createFakeTracker({ phase: 'SUMMARIZE' }) });

    expect(controller.checkAfterLLM(null, createLoopCtx())).toMatchObject({
      action: 'exit',
      reason: 'empty_response',
      needsSummary: true,
    });
    expect(controller.checkAfterLLM({ text: 'done' }, createLoopCtx())).toEqual({
      action: 'continue',
    });
    expect(
      controller.checkAfterLLM({ text: '', functionCalls: [{ name: 'code' }] }, createLoopCtx())
    ).toEqual({ action: 'continue' });
  });
});
