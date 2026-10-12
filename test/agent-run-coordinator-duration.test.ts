import Logger from '@alembic/core/logging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunCoordinator } from '../src/agent/coordination/AgentRunCoordinator.js';
import type {
  AgentConcurrencyPlan,
  AgentRunInput,
  AgentRunResult,
  CompiledAgentProfile,
} from '../src/agent/service/AgentRunContracts.js';

// I23 / P38：协调父结果的 usage.durationMs 曾是各 child 耗时之和，并发下高估墙钟时间，
// 与宿主同一条日志里的墙钟 durationMs 互相矛盾。修复后父 usage.durationMs 是协调 run 的墙钟耗时，
// 各 child 耗时之和改放 phases.childDurationMsTotal；tokens/iterations 仍是 child 累加。
// 用假时钟（只伪造 setTimeout/Date）让墙钟值可精确断言，不依赖机器负载。

const CHILD_MS = 60;

function profile(concurrency: AgentConcurrencyPlan): CompiledAgentProfile {
  return {
    kind: 'compiled-agent-profile',
    id: 'parent-profile',
    title: 'Parent Profile',
    serviceKind: 'system-analysis',
    lifecycle: 'active',
    basePreset: 'chat',
    actionSpace: { mode: 'listed', toolIds: [] },
    additionalTools: [],
    params: {},
    runtimeOverrides: {},
    concurrency,
  };
}

function dimensionPlan(
  mode: AgentConcurrencyPlan['mode'],
  concurrency: number,
  merge: string | undefined = 'generateSessionResults'
): AgentConcurrencyPlan {
  return {
    mode,
    concurrency,
    partitioner: 'generateSessionDimensions',
    ...(merge ? { merge } : {}),
    childProfile: 'child-profile',
  };
}

function dimensionInput(dimensions: unknown[]): AgentRunInput {
  return {
    profile: { id: 'parent-profile' },
    params: { dimensions },
    message: { role: 'user', content: 'coordinate', metadata: { requestId: 'duration' } },
    context: { source: 'internal' },
  };
}

/** 每个 child 真实等待 CHILD_MS（假时钟），并按自身墙钟上报 usage.durationMs。 */
async function timedChild(child: AgentRunInput): Promise<AgentRunResult> {
  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, CHILD_MS));
  const unit = String(child.params?.dimId ?? child.params?.moduleId ?? 'unknown');
  return {
    runId: `${unit}:success`,
    profileId: 'child-profile',
    reply: `done:${unit}`,
    status: 'success',
    phases: { unit },
    toolCalls: [],
    usage: { inputTokens: 2, outputTokens: 3, iterations: 1, durationMs: Date.now() - startedAt },
    diagnostics: null,
  };
}

/** 启动协调 run 并推进假时钟；rejection 先挂上处理器，避免推进期间出现未处理拒绝。 */
async function runWithClock<T>(start: () => Promise<T>, advanceMs: number) {
  const settled = start().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  await vi.advanceTimersByTimeAsync(advanceMs);
  return settled;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  // 日志只做静默，避免测试输出噪声；本用例不断言日志。
  const logger = Logger.getInstance();
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AgentRunCoordinator parent duration — wall clock vs child total', () => {
  it('reports wall-clock durationMs for 3 concurrent 60ms children and keeps the child sum in phases.childDurationMsTotal', async () => {
    const outcome = await runWithClock(
      () =>
        new AgentRunCoordinator().run(
          dimensionInput([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
          profile(dimensionPlan('parallel', 3)),
          timedChild
        ),
      CHILD_MS * 3
    );
    expect(outcome.ok).toBe(true);
    const result = outcome.ok ? outcome.value : null;
    expect(result?.status).toBe('success');
    // 并发度 3：三个 child 同时运行，墙钟约 60ms，而不是累加的 180ms。
    expect(result?.usage.durationMs).toBe(CHILD_MS);
    expect(result?.phases?.childDurationMsTotal).toBe(CHILD_MS * 3);
    // tokens/iterations 仍是 child 累加，口径不变。
    expect(result?.usage).toMatchObject({ inputTokens: 6, outputTokens: 9, iterations: 3 });
    // 内置 merger 的投影保持不变。
    expect(Object.keys((result?.phases?.dimensionResults ?? {}) as object)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(result?.phases?.childResults).toHaveLength(3);
  });

  it('serial coordination (concurrency 1) reports wall clock equal to the child sum', async () => {
    const outcome = await runWithClock(
      () =>
        new AgentRunCoordinator().run(
          dimensionInput([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
          profile(dimensionPlan('parallel', 1)),
          timedChild
        ),
      CHILD_MS * 3
    );
    const result = outcome.ok ? outcome.value : null;
    expect(result?.usage.durationMs).toBe(CHILD_MS * 3);
    expect(result?.phases?.childDurationMsTotal).toBe(CHILD_MS * 3);
  });

  it('tiered coordination reports the wall clock across sequential tiers, not the child sum', async () => {
    // tier0 有 a、b（并发 2 同时跑），tier1 有 c：墙钟 = 60 + 60 = 120，child 累计 = 180。
    const outcome = await runWithClock(
      () =>
        new AgentRunCoordinator().run(
          dimensionInput([
            { id: 'a', tier: 0 },
            { id: 'b', tier: 0 },
            { id: 'c', tier: 1 },
          ]),
          profile(dimensionPlan('tiered', 2)),
          timedChild
        ),
      CHILD_MS * 3
    );
    const result = outcome.ok ? outcome.value : null;
    expect(result?.status).toBe('success');
    expect(result?.usage.durationMs).toBe(CHILD_MS * 2);
    expect(result?.phases?.childDurationMsTotal).toBe(CHILD_MS * 3);
  });

  it('applies the same timing to the module-mining merger and to the default merge', async () => {
    const moduleOutcome = await runWithClock(
      () =>
        new AgentRunCoordinator().run(
          {
            profile: { id: 'parent-profile' },
            params: { modules: [{ moduleId: 'm1' }, { moduleId: 'm2' }, { moduleId: 'm3' }] },
            message: { role: 'user', content: 'coordinate' },
            context: { source: 'internal' },
          },
          profile({
            mode: 'parallel',
            concurrency: 3,
            partitioner: 'projectContextModules',
            merge: 'moduleMiningResults',
            childProfile: 'child-profile',
          }),
          timedChild
        ),
      CHILD_MS * 3
    );
    const moduleResult = moduleOutcome.ok ? moduleOutcome.value : null;
    expect(moduleResult?.usage.durationMs).toBe(CHILD_MS);
    expect(moduleResult?.phases?.childDurationMsTotal).toBe(CHILD_MS * 3);
    expect(Object.keys((moduleResult?.phases?.moduleResults ?? {}) as object)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);

    const defaultOutcome = await runWithClock(
      () =>
        new AgentRunCoordinator().run(
          dimensionInput([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
          profile(dimensionPlan('parallel', 3, undefined)),
          timedChild
        ),
      CHILD_MS * 3
    );
    const defaultResult = defaultOutcome.ok ? defaultOutcome.value : null;
    expect(defaultResult?.runId).toBe('parent-profile:parent');
    expect(defaultResult?.usage.durationMs).toBe(CHILD_MS);
    expect(defaultResult?.phases?.childDurationMsTotal).toBe(CHILD_MS * 3);
    expect(defaultResult?.phases?.childResults).toHaveLength(3);
  });

  it('normalizes a registered custom merger result to the coordinator wall clock while keeping its own phases', async () => {
    const coordinator = new AgentRunCoordinator().registerMerger(
      'customMerge',
      (results, _input, compiled) => ({
        runId: `${compiled.id}:custom`,
        profileId: compiled.id,
        reply: 'custom',
        status: 'success',
        phases: { custom: true, count: results.length },
        toolCalls: [],
        // 自定义 merger 拿不到协调开始时间，只能给出 child 累加值；协调器负责改写为墙钟。
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          iterations: 0,
          durationMs: results.reduce((sum, result) => sum + result.usage.durationMs, 0),
        },
        diagnostics: null,
      })
    );
    const outcome = await runWithClock(
      () =>
        coordinator.run(
          dimensionInput([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
          profile(dimensionPlan('parallel', 3, 'customMerge')),
          timedChild
        ),
      CHILD_MS * 3
    );
    const result = outcome.ok ? outcome.value : null;
    expect(result?.runId).toBe('parent-profile:custom');
    expect(result?.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      iterations: 0,
      durationMs: CHILD_MS,
    });
    expect(result?.phases).toEqual({ custom: true, count: 3, childDurationMsTotal: CHILD_MS * 3 });
  });

  it('coordination failure partialResult also carries wall-clock durationMs and the child total', async () => {
    const outcome = await runWithClock(
      () =>
        new AgentRunCoordinator().run(
          {
            ...dimensionInput([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
            context: {
              source: 'internal',
              coordination: {
                onChildResult: ({ childInput }) => {
                  if (childInput.params?.dimId === 'b') {
                    throw new Error('checkpoint write failed');
                  }
                },
              },
            },
          },
          profile(dimensionPlan('parallel', 3)),
          timedChild
        ),
      CHILD_MS * 3
    );
    expect(outcome.ok).toBe(false);
    const error = outcome.ok ? null : outcome.error;
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: 'Agent coordination consumption failed: checkpoint write failed',
      partialResult: {
        status: 'error',
        usage: { durationMs: CHILD_MS, inputTokens: 6, outputTokens: 9, iterations: 3 },
        phases: { childDurationMsTotal: CHILD_MS * 3 },
      },
    });
  });
});
