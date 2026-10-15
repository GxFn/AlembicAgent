import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetPolicy, PolicyEngine } from '../src/agent/policies/index.js';
import { AgentEvents } from '../src/agent/runtime/AgentEventBus.js';
import { AgentMessage } from '../src/agent/runtime/AgentMessage.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { AgentPhase, AgentState } from '../src/agent/runtime/AgentState.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';

afterEach(() => vi.restoreAllMocks());

/**
 * I40 / P46：AgentState.toJSON() 产出的快照必须与状态机内部存储脱钩。
 *
 * 旧实现 toJSON() 直接返回内部 #data / #history 引用，AgentRuntime 把它写进 result.state：
 * execute 返回后状态机上的任何转移（通配的 abort/error 在终态仍可匹配）都会把记录追加进
 * 已返回结果的 history，快照前后矛盾。fromJSON 同理直接持有调用方传入的 history 数组。
 * 本文件只覆盖拷贝语义；终态保护与公开面去留依赖全局事项②，不在这里断言。
 */

/** 真实 SingleStrategy + 文本回复的 provider：走完整 start → plan_ready → finish 转移。 */
function textRuntime() {
  const chatWithTools = vi.fn(async () => ({ text: 'done', functionCalls: [] }));
  return new AgentRuntime({
    aiProvider: { name: 'unit-test', model: 'unit', chatWithTools } as never,
    toolRegistry: { getManifest: () => null } as never,
    toolRouter: { execute: vi.fn() } as never,
    strategy: new SingleStrategy(),
    policies: new PolicyEngine([new BudgetPolicy({ maxIterations: 2, timeoutMs: 1000 })]),
    capabilities: [],
  });
}

describe('AgentState snapshot copy semantics (I40)', () => {
  it('toJSON returns data/history copies that later transitions do not append to', () => {
    const state = new AgentState({ initialData: { runtimeId: 'r1' } });
    state.send('start');
    state.send('plan_ready');
    state.send('finish', { reply: 'ok' });
    const snapshot = state.toJSON();
    expect(snapshot.phase).toBe(AgentPhase.COMPLETED);
    expect(snapshot.history).toHaveLength(4);

    // 通配 abort 在终态仍会转移（终态保护属于事项②），但不能改写已经导出的快照。
    expect(state.send('abort', { reason: 'late' })).toBe(true);
    expect(state.phase).toBe(AgentPhase.ABORTED);
    expect(snapshot.phase).toBe(AgentPhase.COMPLETED);
    expect(snapshot.history).toHaveLength(4);
    expect(snapshot.history.at(-1)).toMatchObject({ phase: 'completed', event: 'finish' });
    expect(snapshot.data).not.toHaveProperty('reason');
    expect(state.history).toHaveLength(5);
  });

  it('toJSON copies are not write-through: mutating the snapshot leaves the state intact', () => {
    const state = new AgentState({ initialData: { runtimeId: 'r1' } });
    state.send('start');
    const snapshot = state.toJSON();

    snapshot.history.length = 0;
    snapshot.data.injected = true;

    expect(state.history).toHaveLength(2);
    expect(state.data).not.toHaveProperty('injected');
    // 再次导出得到的是新的独立拷贝。
    const again = state.toJSON();
    expect(again.history).toHaveLength(2);
    expect(again.history).not.toBe(state.toJSON().history);
    expect(again.data).not.toBe(state.toJSON().data);
  });

  it('fromJSON copies the incoming history instead of holding the caller array', () => {
    const source = new AgentState({ initialData: { runtimeId: 'r1' } });
    source.send('start');
    const snapshot = source.toJSON();
    const history = snapshot.history;
    const before = history.length;

    const restored = AgentState.fromJSON(snapshot);
    expect(restored.phase).toBe(AgentPhase.PLANNING);
    expect(restored.history).toEqual(history);

    expect(restored.send('plan_ready')).toBe(true);
    // 恢复出的状态机继续转移，不能追加进调用方持有的快照数组。
    expect(history).toHaveLength(before);
    expect(restored.history).toHaveLength(before + 1);

    // 反向同样隔离：调用方事后改动快照数组，不影响已恢复的状态机。
    history.length = 0;
    expect(restored.history).toHaveLength(before + 1);
  });
});

describe('AgentRuntime result.state stays a stable snapshot after execute (I40)', () => {
  it('does not append to result.state.history when abort happens after execute returned', async () => {
    const runtime = textRuntime();
    const result = await runtime.execute(new AgentMessage({ content: 'task' }));
    expect(result.reply).toBe('done');
    expect(result.state?.phase).toBe('completed');
    const recorded = result.state?.history?.length ?? 0;
    expect(recorded).toBeGreaterThan(0);

    // 公开 abort()：没有活动执行时只记日志（P24/I39），不会转移。
    runtime.abort('late cancel');
    // 直接对公开字段 runtime.state 发送通配 abort：内部状态机转到 aborted，
    // 但已返回结果里的快照必须保持 completed 且 history 不被追加。
    expect(runtime.state.send('abort', { reason: 'late cancel' })).toBe(true);
    expect(runtime.state.phase).toBe('aborted');

    expect(result.state?.phase).toBe('completed');
    expect(result.state?.history).toHaveLength(recorded);
    expect(result.state?.history?.at(-1)).toMatchObject({ phase: 'completed', event: 'finish' });
    expect(result.state?.history?.some((entry) => entry.phase === 'aborted')).toBe(false);
  });

  it('keeps result.state intact when an AGENT_COMPLETED observer transitions the state', async () => {
    const runtime = textRuntime();
    // AGENT_COMPLETED 在 result.state 写入之后发布：观察者此时触发的转移不能回写进本次结果。
    const onCompleted = (event: { payload?: { agentId?: string } }) => {
      if (event.payload?.agentId === runtime.id) {
        runtime.state.send('error', { error: 'observer late error' });
      }
    };
    runtime.bus.on(AgentEvents.AGENT_COMPLETED, onCompleted);
    try {
      const result = await runtime.execute(new AgentMessage({ content: 'task' }));
      expect(runtime.state.phase).toBe('failed');
      expect(result.state?.phase).toBe('completed');
      expect(result.state?.history?.at(-1)).toMatchObject({ phase: 'completed', event: 'finish' });
      expect(result.state?.history?.some((entry) => entry.phase === 'failed')).toBe(false);
      expect(result.state?.data).not.toHaveProperty('error');
    } finally {
      runtime.bus.off(AgentEvents.AGENT_COMPLETED, onCompleted);
    }
  });
});
