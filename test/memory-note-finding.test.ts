import { describe, expect, it, vi } from 'vitest';
import { ExplorationTracker } from '../src/agent/context/index.js';
import { MemoryCoordinator } from '../src/agent/memory/MemoryCoordinator.js';
import { handle as handleMemory } from '../src/tools/v2/handlers/memory.js';
import type { ToolContext } from '../src/tools/v2/types.js';

function createBaseContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    projectRoot: '/tmp/alembic-agent-test',
    tokenBudget: 1000,
    ...overrides,
  };
}

describe('memory.note_finding ActiveContext contract', () => {
  it('does not fall back to sessionStore for structured findings', async () => {
    const sessionStore = {
      save: vi.fn(),
      recall: vi.fn(() => []),
    };

    const result = await handleMemory(
      'note_finding',
      { finding: 'Verified boundary', evidence: 'src/foo.ts:10', importance: 8 },
      createBaseContext({ sessionStore })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('active MemoryCoordinator');
    expect(sessionStore.save).not.toHaveBeenCalled();
  });

  it('passes the dimension scope and returns success only after ActiveContext writes', async () => {
    const noteFinding = vi.fn(() => ({
      recorded: true,
      target: 'activeContext' as const,
      importance: 8,
      message: 'recorded',
      scratchpadSize: 1,
      scopeId: 'architecture:analyst',
    }));

    const result = await handleMemory(
      'note_finding',
      { finding: 'Verified boundary', evidence: 'src/foo.ts:10', importance: 8, round: 3 },
      createBaseContext({
        memoryCoordinator: { noteFinding },
        runtime: { dimensionScopeId: 'architecture:analyst' } as never,
      })
    );

    expect(result.ok).toBe(true);
    expect(noteFinding).toHaveBeenCalledWith(
      'Verified boundary',
      'src/foo.ts:10',
      8,
      3,
      'architecture:analyst'
    );
    expect(result.data).toMatchObject({
      recorded: true,
      target: 'activeContext',
      scratchpadSize: 1,
    });
  });

  it('reports missing ActiveContext as a failed tool call', async () => {
    const coordinator = new MemoryCoordinator();

    const result = await handleMemory(
      'note_finding',
      { finding: 'Verified boundary', evidence: 'src/foo.ts:10', importance: 8 },
      createBaseContext({ memoryCoordinator: coordinator })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('未写入 ActiveContext');
  });

  it('writes through MemoryCoordinator when the scope exists', async () => {
    const coordinator = new MemoryCoordinator();
    coordinator.createDimensionScope('architecture:analyst');

    const result = await handleMemory(
      'note_finding',
      { finding: 'Verified boundary', evidence: 'src/foo.ts:10', importance: 8, round: 2 },
      createBaseContext({
        memoryCoordinator: coordinator,
        runtime: { dimensionScopeId: 'architecture:analyst' } as never,
      })
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      recorded: true,
      target: 'activeContext',
      scratchpadSize: 1,
      scopeId: 'architecture:analyst',
    });
  });
});

describe('ExplorationTracker note_finding metrics', () => {
  it('counts only successful ActiveContext note_finding writes', () => {
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'analyst' },
      { maxIterations: 12, searchBudget: 8 }
    );
    expect(tracker).not.toBeNull();

    tracker?.recordToolCall(
      'memory',
      { action: 'note_finding' },
      { recorded: true, target: 'sessionStore' }
    );
    tracker?.recordToolCall(
      'memory',
      { action: 'note_finding' },
      { error: 'missing active context' }
    );
    expect(tracker?.metrics.memoryFindingCount).toBe(0);

    tracker?.recordToolCall(
      'memory',
      { action: 'note_finding' },
      { recorded: true, target: 'activeContext' }
    );
    expect(tracker?.metrics.memoryFindingCount).toBe(1);

    tracker?.recordToolCall(
      'note_finding',
      { finding: 'direct call', evidence: 'src/foo.ts:1', importance: 8 },
      { recorded: true, target: 'activeContext' }
    );
    expect(tracker?.metrics.memoryFindingCount).toBe(2);
  });
});
