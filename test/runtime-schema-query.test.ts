import { describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { SingleStrategy } from '../src/agent/strategies/SingleStrategy.js';
import { CapabilityCatalog } from '../src/tools/catalog/CapabilityCatalog.js';
import type { ToolCallRequest } from '../src/tools/kernel/request.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';
import { ToolRouter } from '../src/tools/runtime/router.js';
import { Capability } from '../src/tools/runtime/toolsets/Capability.js';

class ReadCapability extends Capability {
  get name() {
    return 'fixture';
  }
  get promptFragment() {
    return '';
  }
  get tools() {
    return ['code', 'graph'];
  }
  get allowedTools(): unknown {
    return { code: ['read'], graph: ['overview'] };
  }
}

function runtimeWith(catalog: unknown, capability = new ReadCapability()) {
  const execute = vi.fn(async (request: ToolCallRequest) => ({
    ok: true,
    status: 'success',
    toolId: request.toolId,
    callId: 'fixture',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    text: 'read result',
    structuredContent: { observed: true },
  }));
  const chatWithTools = vi
    .fn()
    .mockResolvedValueOnce({
      functionCalls: [
        { id: 'unavailable', name: 'graph', args: { action: 'overview', params: {} } },
        {
          id: 'forbidden',
          name: 'code',
          args: { action: 'write', params: { path: 'x', content: 'never' } },
        },
        { id: 'missing-action', name: 'code', args: { params: { path: 'x' } } },
        { id: 'allowed', name: 'code', args: { action: 'read', params: { path: 'x' } } },
      ],
    })
    .mockResolvedValue({ text: 'done' });
  const runtime = new AgentRuntime({
    aiProvider: { name: 'mock', chatWithTools } as never,
    container: { get: () => catalog },
    toolRegistry: new RuntimeCapabilityCatalog() as never,
    toolRouter: { execute } as never,
    strategy: new SingleStrategy(),
    capabilities: [capability],
  });
  return { runtime, execute, chatWithTools };
}

describe('runtime schema query port', () => {
  it('keeps generic flat tools callable without inventing an action argument', async () => {
    const catalog = new CapabilityCatalog([
      {
        id: 'flat',
        title: 'Flat',
        description: 'fixture',
        lifecycle: 'active',
        inputSchema: {
          type: 'object',
          required: ['input'],
          properties: { input: { type: 'string' } },
        },
      } as never,
    ]);
    class FlatCapability extends ReadCapability {
      get allowedTools(): unknown {
        return { flat: ['invoke'] };
      }
      get tools() {
        return ['flat'];
      }
    }
    const { runtime, execute, chatWithTools } = runtimeWith(catalog, new FlatCapability());
    chatWithTools
      .mockReset()
      .mockResolvedValueOnce({
        functionCalls: [{ id: 'flat', name: 'flat', args: { input: 'value' } }],
      })
      .mockResolvedValue({ text: 'done' });
    await runtime.reactLoop('flat tool');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].args).toEqual({ input: 'value' });
  });
  it('uses querySchemas directly and enforces its effective actions before calling an external host', async () => {
    const catalog = new RuntimeCapabilityCatalog({
      availability: (runtime) =>
        ToolRouter.describeAvailability({ sessionStoreAvailable: true, runtime }),
    });
    const query = vi.spyOn(catalog, 'querySchemas');
    const legacy = vi.spyOn(catalog, 'toMixedSchemasForActions');
    const { runtime, execute, chatWithTools } = runtimeWith(catalog);
    const sharedState = { submittedTitles: new Set<string>() };
    const result = await runtime.reactLoop('task', { sharedState });
    expect(legacy).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]?.runtime?.sharedState).toBe(sharedState);
    expect(query.mock.calls[0]?.[0]?.runtime?.evidenceLedger).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      toolId: 'code',
      args: { action: 'read' },
      runtime: { allowedTools: { code: ['read'] } },
    });
    expect(result.diagnostics?.blockedTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: 'graph' }),
        expect.objectContaining({ tool: 'code' }),
      ])
    );
    const options = chatWithTools.mock.calls[0]?.[1];
    expect(options.toolSchemas?.map((schema: { name: string }) => schema.name)).toEqual(['code']);
  });

  it('retains legacy schema providers without relaxing stage actions', async () => {
    const native = new RuntimeCapabilityCatalog();
    const oldProvider = {
      toToolSchemas: vi.fn((ids?: readonly string[] | null) => native.toToolSchemas(ids)),
    };
    const { runtime, execute } = runtimeWith(oldProvider);
    await runtime.reactLoop('legacy');
    expect(oldProvider.toToolSchemas).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls.map(([call]) => call.args.action)).toEqual(['overview', 'read']);
    expect(
      execute.mock.calls.every(
        ([call]) => call.runtime?.allowedTools?.code?.includes('write') !== true
      )
    ).toBe(true);
  });

  it('rejects an invalid explicit action contract instead of widening through legacy tools', async () => {
    class InvalidCapability extends ReadCapability {
      get allowedTools(): unknown {
        return { code: 'read' };
      }
    }
    const { runtime, chatWithTools, execute } = runtimeWith(
      new RuntimeCapabilityCatalog(),
      new InvalidCapability()
    );
    await expect(runtime.reactLoop('invalid')).rejects.toThrow(
      'Invalid capability action allowlist'
    );
    expect(chatWithTools).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
