import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
import { AgentRuntimeBuilder } from '../src/agent/service/AgentRuntimeBuilder.js';
import { PACKAGE_ROOT } from '../src/shared/packageAssets.js';
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

/**
 * SOUL 人格资源缺失诊断钉子（L1-I4 / I46 的 Agent 内部部分）。
 *
 * 背景：Agent 包根当前没有 SOUL.md，宿主也不传 soulPath，Conversation 的人格段在生产中
 * 恒为空，而「文件不存在」与「读取失败」两条分支此前都静默置空。资源归属仍待决定，
 * 这里只锁定可定位的诊断：区分 soulPath 来源（default|option）、是否存在、错误类别，
 * 且不记录文件内容。若日后决定把 SOUL.md 随 Agent 包发布，默认路径用例需同步更新。
 */
describe('conversation SOUL diagnostics', () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  function spyLogger() {
    const logger = Logger.getInstance();
    return {
      info: vi.spyOn(logger, 'info').mockImplementation(() => logger),
      warn: vi.spyOn(logger, 'warn').mockImplementation(() => logger),
    };
  }

  function messagesOf(spy: { mock: { calls: unknown[][] } }): string[] {
    return spy.mock.calls.map((call) => String(call[0]));
  }

  it('reports the default package-root SOUL.md as missing with source=default', () => {
    const defaultPath = resolve(PACKAGE_ROOT, 'SOUL.md');
    expect(existsSync(defaultPath)).toBe(false);
    const { info, warn } = spyLogger();

    const context = new Conversation().buildContext({}) ?? '';

    const messages = [...messagesOf(info), ...messagesOf(warn)].filter((m) =>
      m.includes('[Conversation]')
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('source=default');
    expect(messages[0]).toContain('exists=false');
    expect(messages[0]).toContain(defaultPath);
    expect(context).not.toContain('AI Identity');
  });

  it('warns with source=option when an explicit soulPath does not exist', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-soul-')));
    roots.push(root);
    const missing = join(root, 'SOUL.md');
    const { warn } = spyLogger();

    new Conversation({ soulPath: missing });

    const messages = messagesOf(warn).filter((m) => m.includes('[Conversation]'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('source=option');
    expect(messages[0]).toContain('exists=false');
    expect(messages[0]).toContain(missing);
  });

  it('warns with the error code when an explicit soulPath cannot be read', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-soul-')));
    roots.push(root);
    const { warn } = spyLogger();

    // 目录存在但无法按文件读取（EISDIR），模拟「存在却读取失败」。
    const capability = new Conversation({ soulPath: root });

    const messages = messagesOf(warn).filter((m) => m.includes('[Conversation]'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('source=option');
    expect(messages[0]).toContain('exists=true');
    expect(messages[0]).toContain('EISDIR');
    expect(messages[0]).toContain(root);
    expect(capability.buildContext({})).not.toContain('AI Identity');
  });

  it('loads an explicit soulPath silently when the file is readable', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-soul-')));
    roots.push(root);
    const soulPath = join(root, 'SOUL.md');
    await writeFile(soulPath, '# AI Identity\nfixture persona\n', 'utf-8');
    const { info, warn } = spyLogger();

    const context = new Conversation({ soulPath }).buildContext({}) ?? '';

    expect(context).toContain('# AI Identity\nfixture persona');
    expect(
      [...messagesOf(info), ...messagesOf(warn)].filter((m) => m.includes('[Conversation]'))
    ).toEqual([]);
  });
});
