import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntimeBuilder } from '../src/agent/service/AgentRuntimeBuilder.js';

/**
 * SOUL 人格资源的归属接线钉子（L1-I4 / L1-P9，方案 A 的 Agent 侧部分）。
 *
 * 背景：SOUL.md 是 Alembic 产品人格，归宿主 ../Alembic 所有；Agent 包根下没有它。
 * 1）包根定位曾在 packageAssets 模块加载期求值，找不到包根会让一个可选资源阻断
 *    Conversation → CapabilityRegistry → tools/runtime 的整条导入链；现在改为在
 *    loadSoulContent 内惰性定位，失败只记一条 warn 并按缺失处理。
 * 2）AgentRuntimeBuilder 新增可选 soulPath，并经 #getCapabilityOpts 透传给 Conversation，
 *    宿主据此传入自己包根下的 SOUL.md。
 */

const AGENT_PACKAGE_JSON = resolve(import.meta.dirname, '..', 'package.json');

function spyLogger(logger: InstanceType<typeof Logger>) {
  return {
    info: vi.spyOn(logger, 'info').mockImplementation(() => logger),
    warn: vi.spyOn(logger, 'warn').mockImplementation(() => logger),
  };
}

function conversationMessages(...spies: Array<{ mock: { calls: unknown[][] } }>): string[] {
  return spies
    .flatMap((spy) => spy.mock.calls.map((call) => String(call[0])))
    .filter((message) => message.includes('[Conversation]'));
}

function builderWith(extra: Record<string, unknown>) {
  return new AgentRuntimeBuilder({
    container: {},
    toolRegistry: { getRouter: () => ({ execute: async () => null }) as never },
    aiProvider: { name: 'fixture', model: 'fixture', chatWithTools: async () => ({ text: '' }) },
    ...extra,
  });
}

function conversationContextOf(builder: AgentRuntimeBuilder): string {
  const runtime = builder.build({ preset: 'chat' });
  const conversation = runtime.capabilities.find(
    (capability) => capability.name === 'conversation'
  );
  expect(conversation).toBeDefined();
  return String(conversation?.buildContext({}) ?? '');
}

describe('conversation SOUL package-root resolution', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('imports Conversation and treats SOUL as missing when the package root cannot be located', async () => {
    // 只隐藏 Agent 自己的 package.json，让向上查找 @alembic/agent 包根必然失败；
    // 其余文件系统访问保持真实，避免影响导入链上的其他模块。
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      const existsSync = (candidate: Parameters<typeof actual.existsSync>[0]) =>
        String(candidate) === AGENT_PACKAGE_JSON ? false : actual.existsSync(candidate);
      return { ...actual, existsSync, default: { ...actual, existsSync } };
    });

    // 修复前：packageAssets 在模块加载期求 PACKAGE_ROOT，这里的动态导入会直接 reject。
    const { Conversation } = await import('../src/tools/runtime/toolsets/Conversation.js');
    const { default: FreshLogger } = await import('@alembic/core/logging');
    const { info, warn } = spyLogger(FreshLogger.getInstance());

    const capability = new Conversation({ projectBriefing: 'demo' });
    const context = capability.buildContext({}) ?? '';

    expect(conversationMessages(info)).toEqual([]);
    const messages = conversationMessages(warn);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('source=default');
    expect(messages[0]).toContain('packageRoot=unresolved');
    expect(messages[0]).toContain('Could not locate package root for @alembic/agent');
    expect(context).toContain('## 项目概况\ndemo');
    expect(context).not.toContain('AI Identity');
  });
});

describe('agent runtime builder soulPath passthrough', () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function tempRoot(): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-soul-builder-')));
    roots.push(root);
    return root;
  }

  it('hands a host-provided soulPath to the conversation capability', async () => {
    const root = await tempRoot();
    const soulPath = join(root, 'SOUL.md');
    await writeFile(soulPath, '# AI Identity\nhost persona fixture\n', 'utf-8');
    const { info, warn } = spyLogger(Logger.getInstance());

    const context = conversationContextOf(builderWith({ soulPath }));

    expect(context).toContain('# AI Identity\nhost persona fixture');
    expect(conversationMessages(info, warn)).toEqual([]);
  });

  it('warns with source=option when the host soulPath does not exist', async () => {
    const root = await tempRoot();
    const missing = join(root, 'SOUL.md');
    const { warn } = spyLogger(Logger.getInstance());

    const context = conversationContextOf(builderWith({ soulPath: missing }));

    const messages = conversationMessages(warn);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('source=option');
    expect(messages[0]).toContain('exists=false');
    expect(messages[0]).toContain(missing);
    expect(context).not.toContain('AI Identity');
  });

  it('falls back to the default package-root SOUL.md when the host passes no soulPath', () => {
    const { info, warn } = spyLogger(Logger.getInstance());

    const context = conversationContextOf(builderWith({}));

    // Agent 包根当前没有 SOUL.md，默认路径缺失是已知状态，只记 info。
    expect(conversationMessages(warn)).toEqual([]);
    const messages = conversationMessages(info);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('source=default');
    expect(messages[0]).toContain('exists=false');
    expect(context).not.toContain('AI Identity');
  });
});
