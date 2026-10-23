import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { AgentRuntimeBuilder } from '../src/agent/service/AgentRuntimeBuilder.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';
import { UnifiedToolCatalog } from '../src/tools/catalog/UnifiedToolCatalog.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/index.js';

/**
 * W2a-02（审阅包 L3-P09）：AgentRuntime / AgentRuntimeBuilder 不再从 toolRegistry.getRouter() 兜底取路由。
 *
 * 生产宿主一直显式传 toolRouter（AgentModule），UnifiedToolCatalog 的 setRouter 没有调用方，兜底恒为
 * null；删除后只认 RuntimeConfig.toolRouter 与容器里的 'toolRouter'。只在目录上挂 router 的旧调用方
 * 会在构造期失败，错误信息点名迁移方式。toolRegistry 收窄为最小端口（manifest 查询），
 * UnifiedToolCatalog 与 RuntimeCapabilityCatalog 都能作为它传入。
 */

function fixtureProvider() {
  return { name: 'fixture', model: 'fixture', chatWithTools: vi.fn() };
}

describe('AgentRuntime tool router wiring without the registry getRouter fallback (W2a-02 / L3-P09)', () => {
  it('rejects a registry that only offers getRouter and never consults it', () => {
    const getRouter = vi.fn(() => ({ execute: vi.fn() }));
    let thrown: unknown;
    try {
      new AgentRuntime({
        aiProvider: fixtureProvider() as never,
        toolRegistry: { getRouter } as never,
        strategy: new SingleStrategy(),
      });
    } catch (err: unknown) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : '';
    expect(message).toContain('AgentRuntime requires ToolRouter');
    // 错误归类：目录上仍挂着 getRouter 的旧接线要能从错误本身看出迁移方式。
    expect(message).toContain('toolRegistry.getRouter is no longer consulted');
    expect(getRouter).not.toHaveBeenCalled();
  });

  it('keeps the plain missing-router error when the registry offers no getRouter', () => {
    expect(
      () =>
        new AgentRuntime({
          aiProvider: fixtureProvider() as never,
          toolRegistry: new UnifiedToolCatalog(),
          strategy: new SingleStrategy(),
        })
    ).toThrow(
      /^AgentRuntime requires ToolRouter\. Runtime tool execution must use the unified router path\.$/
    );
  });

  it('fails the builder at build time when the router only lives on the registry', () => {
    const getRouter = vi.fn(() => ({ execute: vi.fn() }));
    const builder = new AgentRuntimeBuilder({
      container: {},
      toolRegistry: { getRouter } as never,
      aiProvider: fixtureProvider(),
    });
    expect(() => builder.build({ preset: 'chat' })).toThrow('AgentRuntime requires ToolRouter');
    expect(getRouter).not.toHaveBeenCalled();
  });

  it('uses the explicit toolRouter and keeps a manifest-only catalog as the registry port', () => {
    const catalog = new UnifiedToolCatalog();
    const router = { execute: vi.fn() };
    const runtime = new AgentRuntime({
      aiProvider: fixtureProvider() as never,
      toolRegistry: catalog,
      toolRouter: router as never,
      strategy: new SingleStrategy(),
    });
    expect(runtime.toolRouter).toBe(router);
    expect(runtime.toolRegistry).toBe(catalog);
  });

  it('accepts the production RuntimeCapabilityCatalog as the registry port through the builder', () => {
    const catalog = new RuntimeCapabilityCatalog();
    const router = { execute: vi.fn() };
    const runtime = new AgentRuntimeBuilder({
      container: {},
      toolRegistry: catalog,
      toolRouter: router,
      aiProvider: fixtureProvider(),
    }).build({ preset: 'chat' });
    expect(runtime.toolRouter).toBe(router);
    expect(runtime.toolRegistry).toBe(catalog);
  });

  it('still resolves the router from the host container when no explicit router is passed', () => {
    const router = { execute: vi.fn() };
    const runtime = new AgentRuntime({
      aiProvider: fixtureProvider() as never,
      toolRegistry: new UnifiedToolCatalog(),
      container: { get: (name: string) => (name === 'toolRouter' ? router : undefined) },
      strategy: new SingleStrategy(),
    });
    expect(runtime.toolRouter).toBe(router);
  });
});
