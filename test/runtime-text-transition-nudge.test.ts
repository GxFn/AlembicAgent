import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExplorationTracker } from '../src/agent/context/ExplorationTracker.js';
import {
  type ExplorationStrategy,
  STRATEGY_ANALYST,
} from '../src/agent/context/exploration/ExplorationStrategies.js';
import { AgentRuntime, type ProgressEvent } from '../src/agent/runtime/index.js';

/**
 * L6-P18（C10）：AgentRuntime 文本轮补发 endRound 的阶段转换 nudge。
 *
 * 文本轮先 endRound 再 onTextResponse。endRound 的 metrics 转换进入非终结阶段（如 EXPLORE→VERIFY）时，
 * 修复前：onTextResponse 同轮又按文本规则推到 RECORD（VERIFY 零轮），且 endRound 返回的转换指令被丢弃。
 * 修复后：同轮不再二次转换；onTextResponse 没有阶段专属 nudge 时，runtime 注入 endRound 的转换 nudge。
 */
const VERIFY_NUDGE_MARK = '现在进入证据验证阶段';

function analystWithoutAuxiliaryNudges(): ExplorationStrategy {
  // 关闭反思/规划 nudge：消息适配器只保留最新一条 runtime nudge，避免它们覆盖待观察的转换 nudge。
  return { ...STRATEGY_ANALYST, enableReflection: false, enablePlanning: false };
}

function createTextOnlyRuntime(tracker: ExplorationTracker) {
  const usage = { inputTokens: 2, outputTokens: 1 };
  const requests: Array<{ phase: string; payload: string }> = [];
  const chatWithTools = vi.fn(async (...args: unknown[]) => {
    // 按调用时刻快照：消息数组之后还会被追加，不能事后读 mock.calls。
    requests.push({ phase: tracker.phase, payload: JSON.stringify(args) });
    return { text: '阶段性分析：模块 A 负责鉴权。', functionCalls: [], usage };
  });
  const progress: ProgressEvent[] = [];
  const runtime = new AgentRuntime({
    aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute: vi.fn() } as never,
    container: { get: () => undefined } as never,
    capabilities: [],
    strategy: { name: 'unused', execute: vi.fn() } as never,
    onProgress: (event) => progress.push(event),
  });
  return { runtime, requests, progress };
}

function transitionProcessEvents(progress: ProgressEvent[]) {
  return progress
    .map((event) => event.processEvent)
    .filter((event): event is NonNullable<ProgressEvent['processEvent']> => !!event)
    .filter((event) => event.metadata?.semanticKind === 'transition-nudge');
}

describe('L6-P18 AgentRuntime text-round transition nudge (C10)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps VERIFY after a text round metrics-transitions EXPLORE→VERIFY and injects the VERIFY transition nudge', async () => {
    const info = vi.spyOn(Logger.getInstance(), 'info');
    const tracker = new ExplorationTracker(analystWithoutAuxiliaryNudges(), {
      maxIterations: 10,
      pipelineType: 'analyst',
    });
    // 预置两次真实代码证据：VERIFY 阶段证据已足，onTextResponse 不给阶段专属 nudge。
    for (const path of ['src/a.ts', 'src/b.ts']) {
      tracker.recordToolCall('code', { action: 'read', params: { path } }, `body of ${path}`);
    }
    const { runtime, requests, progress } = createTextOnlyRuntime(tracker);

    await runtime.reactLoop('analyze', {
      source: 'system',
      context: { pipelinePhase: 'analyze' },
      tracker: tracker as never,
      budgetOverride: { maxIterations: 10, timeoutMs: 60_000 },
    });

    // 文本轮序列：SCAN→EXPLORE、EXPLORE、（idle=2）EXPLORE→VERIFY、VERIFY→RECORD、RECORD…
    const phases = requests.map((request) => request.phase);
    expect(phases).toContain('VERIFY');
    expect(phases.indexOf('VERIFY')).toBeLessThan(phases.indexOf('RECORD'));
    const verifyRequest = requests.find((request) => request.phase === 'VERIFY');
    expect(verifyRequest?.payload).toContain(VERIFY_NUDGE_MARK);

    const verifyTransition = transitionProcessEvents(progress).find((event) =>
      String(event.content?.text ?? '').includes(VERIFY_NUDGE_MARK)
    );
    expect(verifyTransition?.metadata).toMatchObject({
      nudgeType: 'phase_transition',
      phase: 'VERIFY',
      semanticKind: 'transition-nudge',
    });
    expect(
      info.mock.calls.map(([message]) => String(message)).filter((m) => m.includes('text round'))
    ).not.toEqual([]);
  });

  it('lets the phase-specific text nudge supersede the endRound transition nudge and logs it', async () => {
    const info = vi.spyOn(Logger.getInstance(), 'info');
    const tracker = new ExplorationTracker(analystWithoutAuxiliaryNudges(), {
      maxIterations: 10,
      pipelineType: 'analyst',
    });
    const { runtime, requests } = createTextOnlyRuntime(tracker);

    await runtime.reactLoop('analyze', {
      source: 'system',
      context: { pipelinePhase: 'analyze' },
      tracker: tracker as never,
      budgetOverride: { maxIterations: 10, timeoutMs: 60_000 },
    });

    // 首个文本轮 endRound SCAN→EXPLORE；无代码证据时 EXPLORE 分支给“没有真实代码证据”专属 nudge，
    // 它取代 endRound 的“轻量计划阶段已完成”转换提示（与修复前一致），并留下 info 诊断。
    expect(requests[1]?.phase).toBe('EXPLORE');
    expect(requests[1]?.payload).toContain('当前还没有真实代码证据');
    expect(requests[1]?.payload).not.toContain('轻量计划阶段已完成');
    const superseded = info.mock.calls
      .map(([message]) => String(message))
      .filter((m) => m.includes('superseded'));
    expect(superseded.length).toBeGreaterThanOrEqual(1);
    expect(superseded[0]).toContain('SCAN → EXPLORE');
  });
});
