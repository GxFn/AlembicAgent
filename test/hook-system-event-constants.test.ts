import { describe, expect, it, vi } from 'vitest';

// 把 AgentEvents 的桥接常量改成 fixture 值：HookSystem 若仍用字面量发布，就会继续发出旧名，
// 订阅常量的消费者静默收不到事件（L5-P41 / I30 / U20-F8）。只替换桥接相关的三个值，其余保持原样。
vi.mock('../src/agent/runtime/AgentEventBus.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/agent/runtime/AgentEventBus.js')>();
  return {
    ...original,
    AgentEvents: Object.freeze({
      ...original.AgentEvents,
      LLM_CALL_START: 'fixture:llm:start',
      LLM_CALL_END: 'fixture:llm:end',
      STEP_COMPLETED: 'fixture:step:completed',
    }),
  };
});

const { HookSystem, registerDefaultHooks } = await import('../src/agent/runtime/HookSystem.js');

describe('registerDefaultHooks event names follow AgentEvents constants', () => {
  it('publishes llm:call:* and agent:exit bridges under the AgentEvents constant values', () => {
    const hooks = new HookSystem();
    const published: Array<{ type: string; payload: unknown; source?: string }> = [];
    registerDefaultHooks(hooks, 'agent-fixture', {
      publish(type, payload, opts) {
        published.push({ type, payload, source: opts?.source });
      },
    });

    hooks.emitSync('llm:call:before', { iteration: 1, toolChoice: 'auto' });
    hooks.emitSync('llm:call:after', {
      iteration: 1,
      hasToolCalls: false,
      hasText: true,
      inputTokens: 3,
      outputTokens: 2,
    });
    // agent:exit 当前运行时未发出（待决事项②）；这里直接分发只验证桥接名跟随常量。
    hooks.emitSync('agent:exit', { reason: 'fixture_exit', iteration: 1 });

    expect(published.map((event) => event.type)).toEqual([
      'fixture:llm:start',
      'fixture:llm:end',
      'fixture:step:completed',
    ]);
    expect(published.every((event) => event.source === 'agent-fixture')).toBe(true);
    expect(published[2].payload).toEqual({
      reason: 'fixture_exit',
      iteration: 1,
      detail: undefined,
    });
  });
});
