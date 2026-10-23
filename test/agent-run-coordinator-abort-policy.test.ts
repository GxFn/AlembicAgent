import { readFileSync } from 'node:fs';
import path from 'node:path';
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

// I20 / P37 → W2a-06（L8-P17）：协调器从不读取 abortPolicy，实际取消语义一直是 stop-new
// （tier 边界与每个 child 派发前检查停止事实，同 tier 排队的 child 直接记 aborted）。总控裁定按 L8-P17
// 删除 AgentConcurrencyPlan.abortPolicy 字段（L5-P37 的“收窄为 stop-new”被其覆盖），连同只为它存在的
// “声明未实现”warn 诊断一起删除。这里锁定三件事：两个生产 profile 不再声明该字段；同 tier 排队 child
// 被中止（stop-new 语义不变）；协调器源码不再保留 abortPolicy 读取与诊断。

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

function plan(mode: AgentConcurrencyPlan['mode']): AgentConcurrencyPlan {
  return {
    mode,
    concurrency: 1,
    partitioner: 'generateSessionDimensions',
    merge: 'generateSessionResults',
    childProfile: 'child-profile',
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
async function runWithCancelDuringFirstChild(compiled: CompiledAgentProfile) {
  let abort = false;
  const ran: string[] = [];
  const result = await new AgentRunCoordinator().run(
    runInput({ shouldAbort: () => abort }),
    compiled,
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

function compiler() {
  return new AgentProfileCompiler({
    profileRegistry: new AgentProfileRegistry(),
    stageFactoryRegistry: new AgentStageFactoryRegistry(),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('AgentRunCoordinator cancellation — built-in profile declarations', () => {
  it('declares no abortPolicy on either production fan-out profile', () => {
    const generateSession = GENERATE_PROFILES.find((entry) => entry.id === 'generate-session');
    const moduleMiningSession = SCOPED_MODULE_MINING_PROFILES.find(
      (entry) => entry.id === 'module-mining-session'
    );
    for (const definition of [generateSession, moduleMiningSession]) {
      expect(definition?.concurrency?.mode).toBe('tiered');
      expect(Object.keys(definition?.concurrency ?? {})).not.toContain('abortPolicy');
    }
  });

  it('compiles both fan-out profiles without an abortPolicy key', () => {
    for (const id of ['generate-session', 'module-mining-session']) {
      const compiled = compiler().compile({ id }, { params: { concurrency: 1 } });
      expect(compiled.concurrency?.mode).toBe('tiered');
      expect(Object.keys(compiled.concurrency ?? {})).not.toContain('abortPolicy');
    }
  });

  it('runs the compiled generate-session profile as stop-new', async () => {
    const compiled = compiler().compile({ id: 'generate-session' }, { params: { concurrency: 1 } });
    const { ran, result, statuses } = await runWithCancelDuringFirstChild(compiled);
    expect(ran).toEqual(['a']);
    expect(result?.status).toBe('aborted');
    expect(statuses).toEqual({ a: 'success', b: 'aborted', c: 'aborted' });
  });
});

describe('AgentRunCoordinator cancellation — stop-new runtime semantics', () => {
  it('aborts queued same-tier children and later tiers once cancellation is requested (tiered)', async () => {
    const calls = spyLogs();
    const { ran, statuses } = await runWithCancelDuringFirstChild(profile(plan('tiered')));
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
  });

  it('does not let the running child finish its queued peers in parallel mode either', async () => {
    const { ran, statuses } = await runWithCancelDuringFirstChild(profile(plan('parallel')));
    // 已运行的 a 不被协调器打断；排队的 b、c 派发前看到停止事实，直接记 aborted。
    expect(ran).toEqual(['a']);
    expect(statuses).toEqual({ a: 'success', b: 'aborted', c: 'aborted' });
  });

  it('ignores a stale abortPolicy key from an untyped caller and still schedules stop-new', async () => {
    // JS 宿主绕过类型传入的旧字段不再有读取者：既不改变调度，也不再产生“声明未实现”的诊断。
    const calls = spyLogs();
    const stale = { ...plan('tiered'), abortPolicy: 'finish-tier' } as AgentConcurrencyPlan;
    const { ran, statuses } = await runWithCancelDuringFirstChild(profile(stale));
    expect(ran).toEqual(['a']);
    expect(statuses).toEqual({ a: 'success', b: 'aborted', c: 'aborted' });
    expect(calls.filter((call) => call.message.includes('abortPolicy'))).toEqual([]);
  });
});

describe('AgentRunCoordinator cancellation — retired abortPolicy surface', () => {
  it('keeps no abortPolicy reader or diagnostic in the coordinator source', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src', 'agent', 'coordination', 'AgentRunCoordinator.ts'),
      'utf8'
    );
    expect(source).not.toContain('logUnimplementedAbortPolicy');
    expect(source).not.toContain('describeDeclaredAbortPolicy');
    expect(source).not.toContain('concurrencyPlan.abortPolicy');
    expect(source).not.toContain('abortPolicy not implemented');
  });
});
