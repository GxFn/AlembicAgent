import { describe, expect, it } from 'vitest';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
import { AgentRuntimeBuilder } from '../src/agent/service/AgentRuntimeBuilder.js';
import { Conversation } from '../src/tools/runtime/toolsets/Conversation.js';

/**
 * 对话能力不拥有记忆路径的钉子。
 *
 * 背景：Conversation 曾在构造时接收一个 builder 级的记忆协调器，并调用
 * buildPromptInjection / cacheToolResult。真实的 MemoryCoordinator 没有这两个方法，
 * 前者的 TypeError 被空 catch 吞掉，后者被可选调用跳过——这条路径接上也不会工作。
 * 记忆注入与工具观察缓存由运行循环按本次运行的协调器负责（buildDynamicMemoryPrompt /
 * recordObservation）；能力层再持有一个跨运行共享的协调器还会让不同会话串记忆。
 */

/** 记录对协调器的全部属性访问，暴露「调用了真实合同里不存在的方法」这类静默失败。 */
function trackedCoordinator() {
  const accessed: string[] = [];
  const coordinator = new Proxy(new MemoryCoordinator({ mode: 'user' }), {
    get(target, property, receiver) {
      if (typeof property === 'string') {
        accessed.push(property);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { accessed, coordinator };
}

describe('conversation capability', () => {
  it('builds its context without touching a memory coordinator', () => {
    const { accessed, coordinator } = trackedCoordinator();
    const capability = new Conversation({
      memoryCoordinator: coordinator,
      projectBriefing: 'demo',
    });

    const context = capability.buildContext({});
    capability.onAfterStep({
      toolCalls: [{ tool: 'code', args: { action: 'read' }, result: { content: 'ok' } }],
    });

    expect(context).toContain('## 项目概况\ndemo');
    expect(context).not.toContain('## 记忆上下文');
    expect(accessed).toEqual([]);
  });

  it('is not handed a builder-level coordinator by the runtime builder', () => {
    const { accessed, coordinator } = trackedCoordinator();
    const runtime = new AgentRuntimeBuilder({
      container: {},
      toolRegistry: { getRouter: () => ({ execute: async () => null }) as never },
      aiProvider: { name: 'fixture', model: 'fixture', chatWithTools: async () => ({ text: '' }) },
      // 历史选项：现在被忽略，协调器只能经每次运行的上下文进入运行循环。
      ...({ memoryCoordinator: coordinator } as Record<string, unknown>),
    }).build({ preset: 'chat' });

    for (const capability of runtime.capabilities) {
      capability.buildContext({});
      capability.onAfterStep({ toolCalls: [{ tool: 'code', args: {}, result: {} }] });
    }

    expect(runtime.capabilities.map((capability) => capability.name)).toContain('conversation');
    expect(accessed).toEqual([]);
  });
});
