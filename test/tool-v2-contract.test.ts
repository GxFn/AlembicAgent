import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/tools/v2/index.js';
import {
  DeltaCache,
  OutputCompressor,
  parseGitStatusOutput,
  SearchCache,
  ToolRouterV2,
  V2CapabilityCatalog,
  V2ToolRouterAdapter,
} from '../src/tools/v2/index.js';

function baseToolContext(): ToolContext {
  return {
    projectRoot: '/tmp/alembic-agent-tool-v2-test',
    tokenBudget: 4000,
  };
}

describe('Tool V2 contract exports', () => {
  it('exports capability catalog projections from the V2 registry', () => {
    const catalog = new V2CapabilityCatalog();
    const schemas = catalog.toToolSchemas(['meta']);

    expect(catalog.has('meta')).toBe(true);
    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.name).toBe('meta');
    expect(schemas[0]?.parameters).toMatchObject({
      type: 'object',
    });

    catalog.markExpanded('meta');
    expect(catalog.expandedCount).toBe(1);
  });

  it('exports generic delta and search cache contracts', () => {
    const deltaCache = new DeltaCache(1);
    const first = deltaCache.check('a.ts', 'one\ntwo');
    const unchanged = deltaCache.check('a.ts', 'one\ntwo');
    const changed = deltaCache.check('a.ts', 'one\nthree');

    expect(first.mode).toBe('full');
    expect(unchanged.mode).toBe('unchanged');
    expect(changed.mode).toBe('delta');

    const searchCache = new SearchCache(1);
    const key = SearchCache.makeKey('AgentRuntime', '*.ts');
    searchCache.set(key, { matches: 1 });

    expect(searchCache.get(key)).toEqual({ matches: 1 });
    expect(searchCache.size).toBe(1);
  });

  it('exports output compressor and parser utilities', async () => {
    const gitStatus = [
      'On branch main',
      'Changes not staged for commit:',
      '  modified:   src/index.ts',
      '',
    ].join('\n');
    const parsed = parseGitStatusOutput(gitStatus);
    const compressed = await new OutputCompressor().compress(gitStatus, {
      command: 'git status',
      tokenBudget: 200,
    });

    expect(parsed).toContain('modified');
    expect(compressed).toContain('modified');
  });

  it('routes V2 calls through generic router and adapter contracts', async () => {
    const router = new ToolRouterV2();
    const parsed = router.parseToolCall('meta', {
      action: 'tools',
      params: { name: 'meta' },
    });

    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      throw new Error(parsed.error);
    }

    const result = await router.execute(parsed, baseToolContext());
    expect(result.ok).toBe(true);
    expect(String(result.data)).toContain('[meta]');

    const adapter = new V2ToolRouterAdapter({
      contextFactory: {
        create: () => baseToolContext(),
      },
    });
    const envelope = await adapter.execute({
      toolId: 'meta',
      args: { action: 'tools', params: { name: 'meta' } },
      surface: 'runtime',
      actor: { role: 'agent' },
      source: { kind: 'runtime', name: 'vitest' },
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.text).toContain('[meta]');
    expect(envelope.cache?.policy).toBe('none');
  });
});
