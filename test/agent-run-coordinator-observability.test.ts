import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRunCoordinator } from '../src/agent/coordination/AgentRunCoordinator.js';
import type {
  AgentConcurrencyPlan,
  AgentRunInput,
  AgentRunResult,
  CompiledAgentProfile,
} from '../src/agent/service/AgentRunContracts.js';

// I21：协调器的并发度来源、tier 生命周期、整批取消、child 跳过、回调失败/跳过都必须留下日志，
// 且日志通道自身失败不能改变调度结果。这里只断言日志事实与“返回值不变”，不改变调度语义。

type LogCall = { level: 'info' | 'warn'; message: string; meta: Record<string, unknown> };

function spyLogs() {
  const logger = Logger.getInstance();
  const calls: LogCall[] = [];
  vi.spyOn(logger, 'info').mockImplementation((message: unknown, meta?: unknown) => {
    calls.push({ level: 'info', message: String(message), meta: toMeta(meta) });
  });
  vi.spyOn(logger, 'warn').mockImplementation((message: unknown, meta?: unknown) => {
    calls.push({ level: 'warn', message: String(message), meta: toMeta(meta) });
  });
  return calls;
}

function toMeta(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function coordinatorLogs(calls: LogCall[]) {
  return calls.filter((call) => call.message.startsWith('[AgentRunCoordinator]'));
}

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

function tieredPlan(concurrency: AgentConcurrencyPlan['concurrency'] = 1): AgentConcurrencyPlan {
  return {
    mode: 'tiered',
    concurrency,
    partitioner: 'generateSessionDimensions',
    merge: 'generateSessionResults',
    childProfile: 'child-profile',
  };
}

function runInput(dimensions: unknown[]): AgentRunInput {
  return {
    profile: { id: 'parent-profile' },
    params: { dimensions },
    message: { role: 'user', content: 'coordinate', metadata: { requestId: 'observability' } },
    context: { source: 'internal' },
  };
}

function childResult(input: AgentRunInput): AgentRunResult {
  const dimension = String(input.params?.dimId ?? 'unknown');
  return {
    runId: `${dimension}:success`,
    profileId: 'child-profile',
    reply: `done:${dimension}`,
    status: 'success',
    phases: { dimension },
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
    diagnostics: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('AgentRunCoordinator observability — concurrency source', () => {
  it('warns when ALEMBIC_MODULE_MINING_CONCURRENCY is invalid and records the default fallback', async () => {
    vi.stubEnv('ALEMBIC_MODULE_MINING_CONCURRENCY', 'abc');
    const calls = spyLogs();
    let active = 0;
    let peak = 0;
    const result = await new AgentRunCoordinator().run(
      runInput([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
      profile({
        mode: 'parallel',
        concurrency: { env: 'ALEMBIC_MODULE_MINING_CONCURRENCY', default: 2 },
        partitioner: 'generateSessionDimensions',
        merge: 'generateSessionResults',
        childProfile: 'child-profile',
      }),
      async (child) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return childResult(child);
      }
    );
    // 行为不变：非法 env 仍回退到 default=2。
    expect(result?.status).toBe('success');
    expect(peak).toBe(2);
    const logs = coordinatorLogs(calls);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('concurrency env invalid'),
        meta: expect.objectContaining({
          profileId: 'parent-profile',
          env: 'ALEMBIC_MODULE_MINING_CONCURRENCY',
          rawValue: 'abc',
          fallback: 2,
        }),
      })
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: expect.stringContaining('coordination start'),
        meta: expect.objectContaining({
          profileId: 'parent-profile',
          mode: 'parallel',
          childCount: 3,
          concurrency: 2,
          concurrencySource: 'default',
          concurrencyFallbackReason: 'env-invalid',
        }),
      })
    );
  });

  it('records env-sourced and numeric concurrency without warning', async () => {
    vi.stubEnv('ALEMBIC_BOOTSTRAP_CONCURRENCY', '3');
    const calls = spyLogs();
    await new AgentRunCoordinator().run(
      runInput([
        { id: 'a', tier: 0 },
        { id: 'b', tier: 1 },
        { id: 'c', tier: 1 },
      ]),
      profile(tieredPlan({ env: 'ALEMBIC_BOOTSTRAP_CONCURRENCY', default: 2 })),
      async (child) => childResult(child)
    );
    const logs = coordinatorLogs(calls);
    expect(logs.filter((log) => log.level === 'warn')).toEqual([]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('coordination start'),
        meta: expect.objectContaining({
          concurrency: 3,
          concurrencySource: 'env',
          concurrencyEnv: 'ALEMBIC_BOOTSTRAP_CONCURRENCY',
          tierCount: 2,
          tierSizes: [
            { tier: 0, childCount: 1 },
            { tier: 1, childCount: 2 },
          ],
        }),
      })
    );
    // tier 生命周期：每个 tier 都有开始与完成日志。
    const tierStarts = logs.filter((log) => log.message.includes('tier start'));
    const tierCompletes = logs.filter((log) => log.message.includes('tier complete'));
    expect(tierStarts.map((log) => log.meta.tierIndex)).toEqual([0, 1]);
    expect(tierCompletes.map((log) => log.meta.tierIndex)).toEqual([0, 1]);
    expect(tierStarts[1]?.meta.childIds).toEqual(['b', 'c']);
    expect(logs).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('coordination complete'),
        meta: expect.objectContaining({ status: 'success', statusCounts: { success: 3 } }),
      })
    );

    const numericCalls = spyLogs();
    await new AgentRunCoordinator().run(
      runInput([{ id: 'a' }]),
      profile(tieredPlan(4)),
      async (child) => childResult(child)
    );
    expect(coordinatorLogs(numericCalls)).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('coordination start'),
        meta: expect.objectContaining({ concurrency: 4, concurrencySource: 'number' }),
      })
    );
  });
});

describe('AgentRunCoordinator observability — skips, cancellation and hooks', () => {
  it('logs prior-failure skips with dimId after a sibling callback fails', async () => {
    const calls = spyLogs();
    const input = runInput([
      { id: 'a', tier: 0 },
      { id: 'b', tier: 0 },
      { id: 'c', tier: 0 },
      { id: 'd', tier: 1 },
    ]);
    input.context.coordination = {
      onChildResult: async ({ childInput }) => {
        if (childInput.params?.dimId === 'a') {
          throw new Error('checkpoint failed');
        }
      },
      onTierComplete: async () => undefined,
    };
    const ran: string[] = [];
    const error = await new AgentRunCoordinator()
      .run(input, profile(tieredPlan(1)), async (child) => {
        ran.push(String(child.params?.dimId));
        return childResult(child);
      })
      .then(
        () => null,
        (err: unknown) => err
      );
    // 行为不变：父 run 抛错且只有 a 启动。
    expect(error).toBeInstanceOf(Error);
    expect(ran).toEqual(['a']);
    const logs = coordinatorLogs(calls);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('coordination hook failed'),
        meta: expect.objectContaining({
          hook: 'onChildResult',
          childId: 'a',
          error: 'checkpoint failed',
        }),
      })
    );
    for (const dimId of ['b', 'c']) {
      expect(logs).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          message: expect.stringContaining('child skipped'),
          meta: expect.objectContaining({ dimId, childId: dimId, reason: 'prior-failure' }),
        })
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('coordination hook skipped'),
          meta: expect.objectContaining({
            hook: 'onChildResult',
            childId: dimId,
            reason: 'prior-failure',
          }),
        })
      );
    }
    expect(logs).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('coordination hook skipped'),
        meta: expect.objectContaining({
          hook: 'onTierComplete',
          tierIndex: 0,
          reason: 'prior-failure',
        }),
      })
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('tier cancelled'),
        meta: expect.objectContaining({
          tierIndex: 1,
          reason: 'prior-failure',
          remainingChildCount: 1,
          childIds: ['d'],
        }),
      })
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('child skipped'),
        meta: expect.objectContaining({ dimId: 'd', reason: 'prior-failure', tierIndex: 1 }),
      })
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('coordination failed'),
        meta: expect.objectContaining({
          failures: [
            expect.objectContaining({
              hook: 'onChildResult',
              childId: 'a',
              message: 'checkpoint failed',
            }),
          ],
          skippedChildIds: ['b', 'c', 'd'],
        }),
      })
    );
  });

  it.each([
    ['shouldAbort', 'info'],
    ['abortSignal', 'info'],
    ['shouldAbort-error', 'warn'],
  ] as const)('logs tier cancellation reason %s', async (reason, level) => {
    const calls = spyLogs();
    const input = runInput([
      { id: 'scan', tier: 0 },
      { id: 'produce', tier: 1 },
      { id: 'verify', tier: 1 },
    ]);
    const controller = new AbortController();
    let tierDone = false;
    input.execution = {
      abortSignal: controller.signal,
      shouldAbort: async () => {
        if (!tierDone) {
          return false;
        }
        if (reason === 'shouldAbort-error') {
          throw new Error('host abort probe failed');
        }
        return reason === 'shouldAbort';
      },
    };
    input.context.coordination = {
      onTierComplete: async () => {
        tierDone = true;
        if (reason === 'abortSignal') {
          controller.abort();
        }
      },
    };
    const outcome = await new AgentRunCoordinator()
      .run(input, profile(tieredPlan(1)), async (child) => childResult(child))
      .then(
        (value) => ({ value }),
        (err: unknown) => ({ err })
      );
    if (reason === 'shouldAbort-error') {
      expect(outcome).toHaveProperty('err');
    } else {
      expect(outcome).toMatchObject({ value: { status: 'aborted' } });
    }
    const logs = coordinatorLogs(calls);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level,
        message: expect.stringContaining('tier cancelled'),
        meta: expect.objectContaining({
          tierIndex: 1,
          reason,
          remainingTierCount: 1,
          remainingChildCount: 2,
          childIds: ['produce', 'verify'],
        }),
      })
    );
    for (const dimId of ['produce', 'verify']) {
      expect(logs).toContainEqual(
        expect.objectContaining({
          level,
          message: expect.stringContaining('child skipped'),
          meta: expect.objectContaining({ dimId, reason, tierIndex: 1 }),
        })
      );
    }
    if (reason === 'shouldAbort-error') {
      expect(logs).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          message: expect.stringContaining('coordination hook failed'),
          meta: expect.objectContaining({
            hook: 'shouldAbort',
            tierIndex: 1,
            error: 'host abort probe failed',
          }),
        })
      );
    }
  });

  it('logs a child that was aborted before dispatch with the abort reason', async () => {
    const calls = spyLogs();
    const input = runInput([{ id: 'a' }]);
    input.execution = { shouldAbort: async () => true };
    const result = await new AgentRunCoordinator().run(
      input,
      profile({ ...tieredPlan(1), mode: 'parallel' }),
      async (child) => childResult(child)
    );
    expect(result?.status).toBe('aborted');
    expect(coordinatorLogs(calls)).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: expect.stringContaining('child skipped'),
        meta: expect.objectContaining({ dimId: 'a', reason: 'shouldAbort' }),
      })
    );
  });

  it('logs a child degraded to an error result with its stage', async () => {
    const calls = spyLogs();
    const result = await new AgentRunCoordinator().run(
      runInput([{ id: 'a' }, { id: 'b' }]),
      profile({ ...tieredPlan(1), mode: 'parallel' }),
      async (child) => {
        if (child.params?.dimId === 'b') {
          throw new Error('provider exploded');
        }
        return childResult(child);
      }
    );
    expect(result?.status).toBe('error');
    expect(coordinatorLogs(calls)).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('child degraded to error result'),
        meta: expect.objectContaining({ dimId: 'b', stage: 'run', error: 'provider exploded' }),
      })
    );
  });

  it('keeps coordination results unchanged when the logger itself throws', async () => {
    const logger = Logger.getInstance();
    vi.spyOn(logger, 'info').mockImplementation(() => {
      throw new Error('log sink down');
    });
    vi.spyOn(logger, 'warn').mockImplementation(() => {
      throw new Error('log sink down');
    });
    vi.stubEnv('ALEMBIC_MODULE_MINING_CONCURRENCY', 'abc');
    const result = await new AgentRunCoordinator().run(
      runInput([
        { id: 'a', tier: 0 },
        { id: 'b', tier: 1 },
      ]),
      profile(tieredPlan({ env: 'ALEMBIC_MODULE_MINING_CONCURRENCY', default: 2 })),
      async (child) => childResult(child)
    );
    expect(result).toMatchObject({
      status: 'success',
      phases: { dimensionResults: { a: { status: 'success' }, b: { status: 'success' } } },
    });
  });
});
