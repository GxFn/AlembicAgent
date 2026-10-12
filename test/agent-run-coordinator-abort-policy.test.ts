import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRunCoordinator } from '../src/agent/coordination/AgentRunCoordinator.js';
import { AgentProfileCompiler } from '../src/agent/profiles/AgentProfileCompiler.js';
import { AgentProfileRegistry } from '../src/agent/profiles/AgentProfileRegistry.js';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';
import { GENERATE_PROFILES } from '../src/agent/profiles/definitions/generate.profile.js';
import { SCOPED_MODULE_MINING_PROFILES } from '../src/agent/profiles/definitions/module-mining/ScopedModuleMiningProfile.js';
import type {
  AgentConcurrencyPlan,
  AgentRunInput,
  AgentRunResult,
  CompiledAgentProfile,
} from '../src/agent/service/AgentRunContracts.js';

// I20 / P37（方案 B）：协调器从不读取 abortPolicy，实际取消语义一直是 stop-new
// （tier 边界与每个 child 派发前检查停止事实，同 tier 排队的 child 直接记 aborted）。
// 这里锁定三件事：两个生产 profile 的声明与实际语义一致（stop-new）；同 tier 排队 child 被中止；
// 声明了未实现的 'cancel-running' / 'finish-tier' 时协调器记 warn 诊断，但调度语义仍按 stop-new，不变。

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

function abortPolicyDiagnostics(calls: LogCall[]) {
  return calls.filter(
    (call) =>
      call.message.startsWith('[AgentRunCoordinator]') &&
      call.message.includes('abortPolicy not implemented')
  );
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

function plan(
  mode: AgentConcurrencyPlan['mode'],
  abortPolicy?: AgentConcurrencyPlan['abortPolicy']
): AgentConcurrencyPlan {
  return {
    mode,
    concurrency: 1,
    partitioner: 'generateSessionDimensions',
    merge: 'generateSessionResults',
    childProfile: 'child-profile',
    ...(abortPolicy ? { abortPolicy } : {}),
  };
}

/** a、b 同在 tier0，c 在 tier1；parallel 模式下 tier 字段被忽略，三者同批排队。 */
function runInput(execution: AgentRunInput['execution']): AgentRunInput {
  return {
    profile: { id: 'parent-profile' },
    params: {
      dimensions: [
        { id: 'a', tier: 0 },
        { id: 'b', tier: 0 },
        { id: 'c', tier: 1 },
      ],
    },
    message: { role: 'user', content: 'coordinate', metadata: { requestId: 'abort-policy' } },
    context: { source: 'internal' },
    execution,
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

/**
 * 第一个 child 运行期间宿主请求取消（shouldAbort 翻为 true），返回实际运行过的 child 与各维度回执状态。
 * concurrency=1 保证 b 在 a 运行时仍处于排队状态，正好覆盖“同 tier 排队维度”这一差异点。
 */
async function runWithCancelDuringFirstChild(concurrencyPlan: AgentConcurrencyPlan) {
  let abort = false;
  const ran: string[] = [];
  const result = await new AgentRunCoordinator().run(
    runInput({ shouldAbort: () => abort }),
    profile(concurrencyPlan),
    async (child) => {
      const dimId = String(child.params?.dimId);
      ran.push(dimId);
      abort = true;
      return childResult(child);
    }
  );
  const statuses = Object.fromEntries(
    Object.entries((result?.phases?.dimensionResults ?? {}) as Record<string, AgentRunResult>).map(
      ([dimId, child]) => [dimId, child.status]
    )
  );
  return { ran, result, statuses };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('AgentRunCoordinator abortPolicy — built-in profile declarations', () => {
  it('declares stop-new on both production fan-out profiles, matching the coordinator semantics', () => {
    const generateSession = GENERATE_PROFILES.find((entry) => entry.id === 'generate-session');
    const moduleMiningSession = SCOPED_MODULE_MINING_PROFILES.find(
      (entry) => entry.id === 'module-mining-session'
    );
    expect(generateSession?.concurrency?.abortPolicy).toBe('stop-new');
    expect(moduleMiningSession?.concurrency?.abortPolicy).toBe('stop-new');
  });

  it('keeps stop-new after compilation through the built-in profile registry', () => {
    const compiler = new AgentProfileCompiler({
      profileRegistry: new AgentProfileRegistry(),
      stageFactoryRegistry: new AgentStageFactoryRegistry(),
    });
    for (const id of ['generate-session', 'module-mining-session']) {
      const compiled = compiler.compile({ id }, { params: { concurrency: 1 } });
      expect(compiled.concurrency?.mode).toBe('tiered');
      expect(compiled.concurrency?.abortPolicy).toBe('stop-new');
    }
  });

  it('runs the compiled generate-session profile as stop-new without an abortPolicy diagnostic', async () => {
    const calls = spyLogs();
    const compiler = new AgentProfileCompiler({
      profileRegistry: new AgentProfileRegistry(),
      stageFactoryRegistry: new AgentStageFactoryRegistry(),
    });
    const compiled = compiler.compile({ id: 'generate-session' }, { params: { concurrency: 1 } });
    let abort = false;
    const ran: string[] = [];
    const result = await new AgentRunCoordinator().run(
      runInput({ shouldAbort: () => abort }),
      compiled,
      async (child) => {
        ran.push(String(child.params?.dimId));
        abort = true;
        return childResult(child);
      }
    );
    expect(ran).toEqual(['a']);
    expect(result?.status).toBe('aborted');
    expect(abortPolicyDiagnostics(calls)).toEqual([]);
  });
});

describe('AgentRunCoordinator abortPolicy — stop-new runtime semantics', () => {
  it.each([
    ['undeclared', undefined],
    ['stop-new', 'stop-new'],
  ] as const)('aborts queued same-tier children once cancellation is requested (%s)', async (_label, abortPolicy) => {
    const calls = spyLogs();
    const { ran, statuses } = await runWithCancelDuringFirstChild(plan('tiered', abortPolicy));
    // 同 tier 的 b 在派发前看到停止事实被中止，tier1 的 c 在 tier 边界被整批取消。
    expect(ran).toEqual(['a']);
    expect(statuses).toEqual({ a: 'success', b: 'aborted', c: 'aborted' });
    expect(calls).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: expect.stringContaining('child skipped profile=parent-profile child=b'),
        meta: expect.objectContaining({ childId: 'b', tierIndex: 0, reason: 'shouldAbort' }),
      })
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: expect.stringContaining('tier cancelled profile=parent-profile tier=1'),
        meta: expect.objectContaining({ reason: 'shouldAbort', childIds: ['c'] }),
      })
    );
    // stop-new 就是已实现的语义：不能产生“声明未实现”的诊断。
    expect(abortPolicyDiagnostics(calls)).toEqual([]);
  });
});

describe('AgentRunCoordinator abortPolicy — unimplemented declarations', () => {
  it.each([
    ['tiered', 'cancel-running'],
    ['tiered', 'finish-tier'],
    ['parallel', 'cancel-running'],
    ['parallel', 'finish-tier'],
  ] as const)('%s mode with %s records a warn diagnostic and still schedules as stop-new', async (mode, abortPolicy) => {
    const calls = spyLogs();
    const { ran, statuses } = await runWithCancelDuringFirstChild(plan(mode, abortPolicy));
    const diagnostics = abortPolicyDiagnostics(calls);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining(
          `profile=parent-profile declared=${abortPolicy} effective=stop-new`
        ),
        meta: expect.objectContaining({
          profileId: 'parent-profile',
          mode,
          declaredAbortPolicy: abortPolicy,
          effectiveAbortPolicy: 'stop-new',
        }),
      }),
    ]);
    // 诊断不改变调度：已运行的 a 不被协调器打断（cancel-running 未实现），
    // 排队的 b 也不会被放行跑完（finish-tier 未实现），c 同样不再派发。
    expect(ran).toEqual(['a']);
    expect(statuses).toEqual({ a: 'success', b: 'aborted', c: 'aborted' });
  });

  it('reports the diagnostic before any child is dispatched', async () => {
    const calls = spyLogs();
    let diagnosticsAtFirstDispatch = -1;
    await new AgentRunCoordinator().run(
      runInput(undefined),
      profile(plan('tiered', 'cancel-running')),
      async (child) => {
        if (diagnosticsAtFirstDispatch < 0) {
          diagnosticsAtFirstDispatch = abortPolicyDiagnostics(calls).length;
        }
        return childResult(child);
      }
    );
    expect(diagnosticsAtFirstDispatch).toBe(1);
    // 没有取消请求时完整跑完，诊断仍只出现一次（每次协调一次，而不是每个 child 一次）。
    expect(abortPolicyDiagnostics(calls)).toHaveLength(1);
  });

  it('keeps the coordination result unchanged when the diagnostic logger throws', async () => {
    const logger = Logger.getInstance();
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => {
      throw new Error('log sink down');
    });
    const { ran, result, statuses } = await runWithCancelDuringFirstChild(
      plan('tiered', 'finish-tier')
    );
    expect(ran).toEqual(['a']);
    expect(result?.status).toBe('aborted');
    expect(statuses).toEqual({ a: 'success', b: 'aborted', c: 'aborted' });
  });
});
