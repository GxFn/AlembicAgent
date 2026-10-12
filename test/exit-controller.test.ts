/**
 * ExitController 测试（L5-P1 / I33 基线 + L5-P8 / I03 结构化 code）。
 *
 * 直接构造 ExitController，用假 tracker 与假 validateDuring 锁定分支：
 *   - checkBeforeIteration 的判定顺序：abort 先于阶段超时，阶段超时先于 tracker（且不推进 tick）；
 *   - token 超限只给一次 graceful 机会（forceTerminal 只调用一次，第二次直接 exit）；
 *   - checkAfterLLM 在 SUMMARIZE 空响应下按 tracker.metrics.phaseRounds 给 2 轮 grace。
 *
 * I03 新语义（带 code 的策略决策按结构化 code 分类，不匹配 reason 文本）：
 *   - BudgetPolicy 每条拒绝都带 code；只有会话 token code 走 token_budget_exhausted，
 *     budget_timeout 归为 stage_timeout，其它 code 一律 policy_stop；
 *   - 无 code 的拒绝走兼容回退（code 是可选字段）：按改造前的 reason 判定（含 "token" → token 预算，
 *     否则 policy_stop），每个策略每个 loop 发一次 policy_decision_without_code 诊断（只含策略名与 reason）；
 *     兼容回退不恢复旧的 "session" 子串屏蔽；
 *   - createExitController 只屏蔽阶段未声明 maxSessionInputTokens 时的 budget_session_input_tokens，
 *     屏蔽写 policy_session_limit_bypassed 诊断并继续评估后续策略；BudgetController 不执行的
 *     budget_session_tokens 不屏蔽；自定义策略的 "session expired" 不被吞；
 *   - 有效超时取阶段超时与策略超时的较小正值，策略超时先到时命中 stage_timeout 分支。
 */
import Logger from '@alembic/core/logging';
import { describe, expect, it, vi } from 'vitest';
import type { ExplorationTracker } from '../src/agent/context/ExplorationTracker.js';
import { BudgetPolicy } from '../src/agent/policies/BudgetPolicy.js';
import { Policy, type StepState } from '../src/agent/policies/Policy.js';
import { PolicyEngine } from '../src/agent/policies/PolicyEngine.js';
import { DiagnosticsCollector } from '../src/agent/runtime/DiagnosticsCollector.js';
import {
  createExitController,
  ExitController,
  type ExitControllerConfig,
  resolveEffectiveTimeoutMs,
} from '../src/agent/runtime/ExitController.js';
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
  // token 分类只认结构化 code；reason 文本只用于展示。
  const tokenStop: ValidateDuring = () => ({
    ok: false,
    reason: 'Budget: token limit exceeded',
    code: 'budget_session_tokens',
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

describe('BudgetPolicy.validateDuring 结构化 code', () => {
  it.each([
    [
      'budget_max_iterations',
      new BudgetPolicy({ maxIterations: 2 }),
      { iteration: 2, startTime: Date.now() },
    ],
    [
      'budget_timeout',
      new BudgetPolicy({ timeoutMs: 1_000 }),
      { iteration: 0, startTime: Date.now() - 5_000 },
    ],
    [
      'budget_session_tokens',
      new BudgetPolicy({ maxSessionTokens: 1_000 }),
      { iteration: 0, startTime: Date.now(), totalTokens: 1_400, totalInputTokens: 700 },
    ],
    [
      'budget_session_input_tokens',
      new BudgetPolicy({ maxSessionInputTokens: 1_000 }),
      { iteration: 0, startTime: Date.now(), totalTokens: 1_500, totalInputTokens: 1_200 },
    ],
  ] as const)('%s：拒绝带对应 code，reason 文本保持原样', (code, policy, stepState) => {
    const decision = policy.validateDuring(stepState as StepState);
    expect(decision).toMatchObject({ ok: false, action: 'stop', code });
    expect(typeof decision.reason).toBe('string');
  });

  it('未超限时不带 code', () => {
    const decision = new BudgetPolicy().validateDuring({ iteration: 0, startTime: Date.now() });
    expect(decision).toEqual({ ok: true, action: 'continue' });
  });

  it('PolicyEngine 原样透传首个拒绝的 code', () => {
    const engine = new PolicyEngine([new BudgetPolicy({ maxIterations: 1 })]);
    expect(engine.validateDuring({ iteration: 1, startTime: Date.now() })).toMatchObject({
      ok: false,
      code: 'budget_max_iterations',
    });
  });
});

describe('ExitController 按 code 分类策略拒绝', () => {
  it('reason 含 token 但带非 token 预算 code：按 code 归为 policy_stop，不触发 grace', () => {
    const tracker = createFakeTracker();
    const controller = createController({
      tracker,
      validateDuring: () => ({
        ok: false,
        reason: 'custom token refresh failed',
        code: 'custom_credentials_expired',
      }),
    });

    const signal = controller.checkBeforeIteration(createLoopCtx(), NO_USAGE);

    expect(signal).toMatchObject({
      action: 'exit',
      reason: 'policy_stop',
      needsSummary: true,
      detail: 'custom token refresh failed',
    });
    expect(tracker.forceTerminal).not.toHaveBeenCalled();
  });

  it('budget_session_input_tokens 与 budget_session_tokens 同样走 token grace', () => {
    const tracker = createFakeTracker();
    const controller = createController({
      tracker,
      validateDuring: () => ({
        ok: false,
        reason: 'Budget: session input token limit (10) reached — used 20',
        code: 'budget_session_input_tokens',
      }),
    });

    expect(controller.checkBeforeIteration(createLoopCtx(), NO_USAGE)).toMatchObject({
      action: 'continue',
      reason: 'token_budget_exhausted',
    });
    expect(tracker.forceTerminal).toHaveBeenCalledTimes(1);
  });

  it('budget_timeout（阶段超时检查未先命中时）归为 stage_timeout，不要求摘要、不 forceTerminal', () => {
    const tracker = createFakeTracker();
    const controller = createController({
      tracker,
      validateDuring: () => ({
        ok: false,
        action: 'stop',
        reason: 'Budget: timeout (50ms) exceeded',
        code: 'budget_timeout',
      }),
    });

    const signal = controller.checkBeforeIteration(createLoopCtx(), NO_USAGE);

    expect(signal).toMatchObject({ action: 'exit', reason: 'stage_timeout', needsSummary: false });
    expect(signal.detail).toContain('Budget: timeout (50ms) exceeded');
    expect(tracker.forceTerminal).not.toHaveBeenCalled();
  });

  it('budget_max_iterations 与其它带 code 的拒绝仍是 policy_stop', () => {
    const controller = createController({
      tracker: null,
      validateDuring: () => ({
        ok: false,
        reason: 'Budget: max iterations (3) reached',
        code: 'budget_max_iterations',
      }),
    });

    expect(controller.checkBeforeIteration(createLoopCtx(), NO_USAGE)).toMatchObject({
      action: 'exit',
      reason: 'policy_stop',
      needsSummary: true,
    });
  });
});

/** createExitController 读取的 LoopContext 字段：tracker/budget/abortSignal/loopStartTime/maxIterations/diagnostics。 */
function createFactoryCtx(overrides: {
  budget: Record<string, unknown> | null;
  tracker?: Record<string, unknown> | null;
  loopStartTime?: number;
  iteration?: number;
  context?: Record<string, unknown>;
}) {
  const diagnostics = new DiagnosticsCollector();
  const ctx = {
    tracker: (overrides.tracker ?? null) as unknown as ExplorationTracker | null,
    budget: overrides.budget,
    abortSignal: null,
    loopStartTime: overrides.loopStartTime ?? Date.now(),
    maxIterations: 20,
    iteration: overrides.iteration ?? 2,
    context: overrides.context ?? {},
    isSystem: false,
    consecutiveEmptyResponses: 0,
    diagnostics,
  } as unknown as LoopContext;
  return { ctx, diagnostics };
}

class StopAllPolicy extends Policy {
  get name() {
    return 'stop-all';
  }

  validateDuring(_stepState: StepState) {
    return { ok: false, action: 'stop', reason: 'custom stop' };
  }
}

class SessionExpiredPolicy extends Policy {
  get name() {
    return 'session-expired';
  }

  validateDuring(_stepState: StepState) {
    return { ok: false, action: 'stop', reason: 'session expired' };
  }
}

function bypassWarnings(diagnostics: DiagnosticsCollector) {
  return diagnostics
    .toJSON()
    .warnings.filter((warning) => warning.code === 'policy_session_limit_bypassed');
}

describe('createExitController 会话限额屏蔽（按 code）', () => {
  it('自定义策略 reason="session expired"（无 code）不被吞：阶段无会话预算时照常 policy_stop', () => {
    const engine = new PolicyEngine([new SessionExpiredPolicy()]);
    const { ctx, diagnostics } = createFactoryCtx({ budget: { maxIterations: 20 } });

    const signal = createExitController(ctx, engine).checkBeforeIteration(ctx, NO_USAGE);

    expect(signal).toMatchObject({
      action: 'exit',
      reason: 'policy_stop',
      detail: 'session expired',
    });
    expect(bypassWarnings(diagnostics)).toHaveLength(0);
  });

  it('只配策略层 maxSessionTokens（single，ctx.budget=getBudget）：累计 1400 时退出，不屏蔽', () => {
    const engine = new PolicyEngine([new BudgetPolicy({ maxSessionTokens: 1_000 })]);
    const { ctx, diagnostics } = createFactoryCtx({ budget: engine.getBudget() });

    const signal = createExitController(ctx, engine).checkBeforeIteration(ctx, {
      input: 700,
      output: 700,
    });

    expect(signal).toMatchObject({
      action: 'exit',
      reason: 'token_budget_exhausted',
      needsSummary: true,
    });
    expect(signal.detail).toContain('session token limit (1000)');
    expect(bypassWarnings(diagnostics)).toHaveLength(0);
  });

  it('阶段未声明 maxSessionInputTokens：策略层 input 会话拒绝被屏蔽、写一次诊断，并继续评估后续策略', () => {
    const engine = new PolicyEngine([
      new BudgetPolicy({ maxIterations: 100, maxSessionInputTokens: 1_000 }),
      new StopAllPolicy(),
    ]);
    // 与 PipelineStrategy 的 budgetOverride 同形：阶段预算不带会话字段。
    const { ctx, diagnostics } = createFactoryCtx({
      budget: { maxIterations: 20, timeoutMs: 600_000 },
      context: { pipelinePhase: 'record_repair' },
    });
    const controller = createExitController(ctx, engine);

    const first = controller.checkBeforeIteration(ctx, { input: 1_400, output: 10 });
    const second = controller.checkBeforeIteration(ctx, { input: 1_500, output: 10 });

    // 被遮蔽的 StopAll 现在能被评估到。
    expect(first).toMatchObject({ action: 'exit', reason: 'policy_stop', detail: 'custom stop' });
    expect(second).toMatchObject({ action: 'exit', reason: 'policy_stop', detail: 'custom stop' });
    const warnings = bypassWarnings(diagnostics);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('budget_session_input_tokens');
    expect(warnings[0]?.message).toContain('BudgetPolicy');
    expect(warnings[0]?.stage).toBe('record_repair');
  });

  it('阶段未声明 maxSessionInputTokens 且无后续拒绝：屏蔽后 continue', () => {
    const engine = new PolicyEngine([
      new BudgetPolicy({ maxIterations: 100, maxSessionInputTokens: 1_000 }),
    ]);
    const { ctx, diagnostics } = createFactoryCtx({ budget: { maxIterations: 20 } });

    const signal = createExitController(ctx, engine).checkBeforeIteration(ctx, {
      input: 1_400,
      output: 10,
    });

    expect(signal).toEqual({ action: 'continue' });
    expect(bypassWarnings(diagnostics)).toHaveLength(1);
  });

  it('阶段声明了 maxSessionInputTokens：策略层 input 会话拒绝照常退出（token_budget_exhausted）', () => {
    const engine = new PolicyEngine([new BudgetPolicy({ maxSessionInputTokens: 1_000 })]);
    const { ctx, diagnostics } = createFactoryCtx({ budget: engine.getBudget() });

    const signal = createExitController(ctx, engine).checkBeforeIteration(ctx, {
      input: 1_200,
      output: 10,
    });

    expect(signal).toMatchObject({ action: 'exit', reason: 'token_budget_exhausted' });
    expect(bypassWarnings(diagnostics)).toHaveLength(0);
  });

  it('非 PolicyEngine 的 validateDuring 源：可屏蔽 code 仍按 code 屏蔽并在诊断中注明后续策略无法逐个评估', () => {
    const { ctx, diagnostics } = createFactoryCtx({ budget: { maxIterations: 20 } });
    const source = {
      validateDuring: (_stepState: StepState) => ({
        ok: false,
        action: 'stop',
        reason: 'Budget: session input token limit (10) reached — used 20',
        code: 'budget_session_input_tokens',
      }),
    };

    const signal = createExitController(ctx, source).checkBeforeIteration(ctx, NO_USAGE);

    expect(signal).toEqual({ action: 'continue' });
    const warnings = bypassWarnings(diagnostics);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('not a PolicyEngine');
  });
});

/** 宿主 ExitController 单测夹具同形：未迁移到结构化 code 的会话 token 停止。 */
const LEGACY_TOKEN_STOP = {
  ok: false,
  action: 'stop',
  reason: 'session token budget exceeded',
} as const;

class LegacyTokenPolicy extends Policy {
  get name() {
    return 'legacy-token';
  }

  validateDuring(_stepState: StepState) {
    return { ...LEGACY_TOKEN_STOP };
  }
}

/** 没有实现 name 的策略：Policy 基类的 name getter 会抛错，诊断退回构造函数名。 */
class NamelessTokenPolicy extends Policy {
  validateDuring(_stepState: StepState) {
    return { ok: false, action: 'stop', reason: 'quota token cap hit' };
  }
}

function codelessWarnings(diagnostics: DiagnosticsCollector) {
  return diagnostics
    .toJSON()
    .warnings.filter((warning) => warning.code === 'policy_decision_without_code');
}

/** 直接构造 ExitController 时带上 diagnostics 的最小 LoopContext。 */
function createLoopCtxWithDiagnostics(iteration = 1) {
  const diagnostics = new DiagnosticsCollector();
  const ctx = {
    iteration,
    isSystem: false,
    consecutiveEmptyResponses: 0,
    diagnostics,
  } as unknown as LoopContext;
  return { ctx, diagnostics };
}

describe('无 code 拒绝的兼容回退（宿主夹具与未迁移策略）', () => {
  it('宿主夹具同形（无 code、无 tracker）：仍归为 token_budget_exhausted，并发出 policy_decision_without_code', () => {
    const controller = createController({
      tracker: null,
      validateDuring: () => ({ ...LEGACY_TOKEN_STOP }),
    });
    const { ctx, diagnostics } = createLoopCtxWithDiagnostics();

    const signal = controller.checkBeforeIteration(ctx, NO_USAGE);

    expect(signal).toMatchObject({
      action: 'exit',
      reason: 'token_budget_exhausted',
      needsSummary: true,
      detail: 'session token budget exceeded',
    });
    // 直接构造时没有 PolicyEngine 可归属，策略名记为 unknown；诊断只含策略名与 reason。
    expect(codelessWarnings(diagnostics)).toEqual([
      {
        code: 'policy_decision_without_code',
        message: 'policy=unknown; reason=session token budget exceeded',
      },
    ]);
  });

  it('宿主夹具同形 + 活跃 tracker：首次 grace（forceTerminal），第二次 exit，诊断每个 loop 只发一次', () => {
    const tracker = createFakeTracker();
    const controller = createController({
      tracker,
      validateDuring: () => ({ ...LEGACY_TOKEN_STOP }),
    });
    const { ctx, diagnostics } = createLoopCtxWithDiagnostics();

    const first = controller.checkBeforeIteration(ctx, NO_USAGE);
    expect(first).toMatchObject({ action: 'continue', reason: 'token_budget_exhausted' });
    expect(first.detail).toContain('forced SUMMARIZE');
    expect(tracker.forceTerminal).toHaveBeenCalledWith('session token budget exceeded');

    tracker.isGracefulExit = true;
    const second = controller.checkBeforeIteration(ctx, NO_USAGE);
    expect(second).toMatchObject({ action: 'exit', reason: 'token_budget_exhausted' });
    expect(tracker.forceTerminal).toHaveBeenCalledTimes(1);
    expect(codelessWarnings(diagnostics)).toHaveLength(1);
  });

  it('无 code 且 reason 不含 token：按旧判定归为 policy_stop，同样发出诊断', () => {
    const tracker = createFakeTracker();
    const controller = createController({
      tracker,
      validateDuring: () => ({ ok: false, reason: 'iteration limit' }),
    });
    const { ctx, diagnostics } = createLoopCtxWithDiagnostics();

    const signal = controller.checkBeforeIteration(ctx, NO_USAGE);

    expect(signal).toMatchObject({ action: 'exit', reason: 'policy_stop', needsSummary: true });
    expect(tracker.forceTerminal).not.toHaveBeenCalled();
    expect(codelessWarnings(diagnostics)).toEqual([
      { code: 'policy_decision_without_code', message: 'policy=unknown; reason=iteration limit' },
    ]);
  });

  it('带 code 的拒绝不发 policy_decision_without_code', () => {
    const controller = createController({
      tracker: null,
      validateDuring: () => ({
        ok: false,
        reason: 'Budget: max iterations (3) reached',
        code: 'budget_max_iterations',
      }),
    });
    const { ctx, diagnostics } = createLoopCtxWithDiagnostics();

    expect(controller.checkBeforeIteration(ctx, NO_USAGE)).toMatchObject({ reason: 'policy_stop' });
    expect(codelessWarnings(diagnostics)).toHaveLength(0);
  });

  it.each([
    ['阶段声明了 maxSessionInputTokens', { maxIterations: 20, maxSessionInputTokens: 50_000 }],
    ['阶段未声明会话预算', { maxIterations: 20 }],
  ])('经 createExitController + PolicyEngine（%s）：诊断带拒绝策略名，且只含策略名与 reason', (_label, budget) => {
    const engine = new PolicyEngine([
      new BudgetPolicy({ maxIterations: 100 }),
      new LegacyTokenPolicy(),
    ]);
    const { ctx, diagnostics } = createFactoryCtx({
      budget,
      context: { pipelinePhase: 'analyze' },
    });

    const signal = createExitController(ctx, engine).checkBeforeIteration(ctx, NO_USAGE);

    // 无 code 的 "session" 拒绝不再按子串屏蔽：兼容回退只恢复分类，不恢复旧的吞没。
    expect(signal).toMatchObject({ action: 'exit', reason: 'token_budget_exhausted' });
    expect(codelessWarnings(diagnostics)).toEqual([
      {
        code: 'policy_decision_without_code',
        message: 'policy=legacy-token; reason=session token budget exceeded',
      },
    ]);
    expect(bypassWarnings(diagnostics)).toHaveLength(0);
  });

  it('策略未实现 name 时诊断退回构造函数名', () => {
    const engine = new PolicyEngine([new NamelessTokenPolicy()]);
    const { ctx, diagnostics } = createFactoryCtx({ budget: { maxIterations: 20 } });

    const signal = createExitController(ctx, engine).checkBeforeIteration(ctx, NO_USAGE);

    expect(signal).toMatchObject({ action: 'exit', reason: 'token_budget_exhausted' });
    expect(codelessWarnings(diagnostics)).toEqual([
      {
        code: 'policy_decision_without_code',
        message: 'policy=NamelessTokenPolicy; reason=quota token cap hit',
      },
    ]);
  });

  it('兼容分支打 warn 日志：写明触发条件、选择路径与分类结果', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    try {
      const controller = createController({
        tracker: null,
        validateDuring: () => ({ ...LEGACY_TOKEN_STOP }),
      });
      controller.checkBeforeIteration(createLoopCtxWithDiagnostics().ctx, NO_USAGE);

      const lines = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes('policy_decision_without_code'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('legacy reason classification');
      expect(lines[0]).toContain('classified=token_budget_exhausted');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('有效超时 = 阶段超时与策略超时的较小正值', () => {
  it.each([
    [600_000, 50, 50],
    [50, 600_000, 50],
    [0, 50, 50],
    [undefined, 120_000, 120_000],
    [100, 0, 100],
    [100, undefined, 100],
    [undefined, undefined, 0],
    [Number.NaN, -1, 0],
    ['100', 50, 50],
  ] as const)('resolveEffectiveTimeoutMs(%s, %s) = %s', (stage, policy, expected) => {
    expect(resolveEffectiveTimeoutMs(stage, policy)).toBe(expected);
  });

  it('策略超时 50ms、阶段超时 600s：在 P2 命中 stage_timeout，不再进入 policy（policy_stop）分支', () => {
    const budgetPolicy = new BudgetPolicy({ maxIterations: 100, timeoutMs: 50 });
    const engine = new PolicyEngine([budgetPolicy]);
    const validateSpy = vi.spyOn(budgetPolicy, 'validateDuring');
    const { ctx } = createFactoryCtx({
      budget: { maxIterations: 100, timeoutMs: 600_000 },
      loopStartTime: Date.now() - 200,
    });

    const signal = createExitController(ctx, engine).checkBeforeIteration(ctx, NO_USAGE);

    expect(signal).toMatchObject({ action: 'exit', reason: 'stage_timeout', needsSummary: false });
    expect(signal.detail).toContain('50ms exceeded');
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it('阶段超时更短时仍以阶段超时为准', () => {
    const engine = new PolicyEngine([new BudgetPolicy({ maxIterations: 100, timeoutMs: 600_000 })]);
    const { ctx } = createFactoryCtx({
      budget: { maxIterations: 100, timeoutMs: 1_000 },
      loopStartTime: Date.now() - 5_000,
    });

    const signal = createExitController(ctx, engine).checkBeforeIteration(ctx, NO_USAGE);

    expect(signal).toMatchObject({ action: 'exit', reason: 'stage_timeout' });
    expect(signal.detail).toContain('1000ms exceeded');
  });

  it('策略超时更紧时打 effective_timeout_from_policy 分叉日志；阶段超时更紧或相等时不打', () => {
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    try {
      const policyTighter = new PolicyEngine([new BudgetPolicy({ timeoutMs: 50 })]);
      const { ctx: tighterCtx } = createFactoryCtx({
        budget: { timeoutMs: 600_000 },
        context: { pipelinePhase: 'analyze' },
      });
      createExitController(tighterCtx, policyTighter);

      const stageTighter = new PolicyEngine([new BudgetPolicy({ timeoutMs: 600_000 })]);
      createExitController(createFactoryCtx({ budget: { timeoutMs: 1_000 } }).ctx, stageTighter);
      // 无 budgetOverride 时 ctx.budget 就是 getBudget() 投影，两者相等，不属于分叉。
      createExitController(
        createFactoryCtx({ budget: stageTighter.getBudget() }).ctx,
        stageTighter
      );

      const branchLogs = info.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes('effective_timeout_from_policy'));
      expect(branchLogs).toHaveLength(1);
      expect(branchLogs[0]).toContain('stage=analyze');
      expect(branchLogs[0]).toContain('policyTimeoutMs=50');
      expect(branchLogs[0]).toContain('stageTimeoutMs=600000');
    } finally {
      info.mockRestore();
    }
  });
});
