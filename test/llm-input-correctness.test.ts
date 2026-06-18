import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExplorationTracker } from '../src/agent/context/index.js';
import { buildAnalystPrompt } from '../src/agent/prompts/index.js';
import {
  DeltaCache,
  TOOL_REGISTRY,
  type ToolContext,
  ToolRouterV2,
} from '../src/tools/runtime/index.js';

interface BatchReadFile {
  ok: boolean;
  path: string;
  content?: string;
  error?: string;
  truncated?: boolean;
  originalTokensEstimate?: number;
}

interface BatchReadData {
  mode: 'batch';
  files: BatchReadFile[];
  summary: {
    requested: number;
    succeeded: number;
    failed: number;
    partialFailure: boolean;
    maxFiles: number;
    maxOutputTokens: number;
    perFileTokenBudget: number;
  };
}

async function withCodeFixture<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'alembic-agent-llm-input-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\nexport const aa = 2;\n');
    await writeFile(join(root, 'src/b.ts'), 'export function b() {\n  return "b";\n}\n');
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function toolContext(root: string, deltaCache?: DeltaCache, tokenBudget = 4000): ToolContext {
  return {
    projectRoot: root,
    tokenBudget,
    ...(deltaCache ? { deltaCache } : {}),
  };
}

describe('LLM input correctness fixture', () => {
  it('awaits async graph context before assembling analyst prompts', async () => {
    const prompt = await buildAnalystPrompt(
      { id: 'architecture', label: 'Architecture' },
      { name: 'FixtureProject', lang: 'typescript', fileCount: 2 },
      null,
      null,
      null,
      {
        generateContextForAgent: async () => '## Code Entity Graph\nAsync graph context',
      },
      null,
      null,
      null,
      null,
      null
    );

    expect(prompt).toContain('Async graph context');
    expect(prompt).not.toContain('[object Promise]');
  });

  it('publishes code.read filePaths in the registry without requiring path', () => {
    const readSpec = TOOL_REGISTRY.code?.actions.read;
    const params = readSpec?.params as {
      required?: string[];
      properties?: Record<string, unknown>;
    };

    expect(params.required ?? []).not.toContain('path');
    expect(params.properties?.path).toBeTruthy();
    expect(params.properties?.filePaths).toBeTruthy();
    expect(readSpec?.description).toContain('partial failure');
  });

  it('keeps code.read path compatible while enabling batch filePaths partial failure', async () => {
    await withCodeFixture(async (root) => {
      const router = new ToolRouterV2();

      const single = await router.execute(
        { tool: 'code', action: 'read', params: { path: 'src/a.ts', maxLines: 1 } },
        toolContext(root)
      );
      expect(single.ok).toBe(true);
      expect(single.data).toContain('1|export const a = 1;');

      const batch = await router.execute(
        {
          tool: 'code',
          action: 'read',
          params: { filePaths: ['src/a.ts', 'src/missing.ts', '../outside.ts'], maxLines: 1 },
        },
        toolContext(root)
      );
      expect(batch.ok).toBe(true);
      expect(batch.error).toBeUndefined();
      expect(JSON.stringify(batch)).not.toContain('Missing required param "path"');

      const data = batch.data as BatchReadData;
      expect(data.mode).toBe('batch');
      expect(data.summary).toMatchObject({
        requested: 3,
        succeeded: 1,
        failed: 2,
        partialFailure: true,
        maxFiles: 5,
      });
      expect(data.files.find((file) => file.path === 'src/a.ts')?.content).toContain(
        '1|export const a = 1;'
      );
      expect(data.files.find((file) => file.path === '../outside.ts')?.error).toContain(
        'outside project root'
      );
    });
  });

  it('applies delta cache per file and caps batch output by token budget', async () => {
    await withCodeFixture(async (root) => {
      const router = new ToolRouterV2();
      const deltaCache = new DeltaCache(10);

      const first = await router.execute(
        { tool: 'code', action: 'read', params: { filePaths: ['src/a.ts', 'src/b.ts'] } },
        toolContext(root, deltaCache)
      );
      expect(first.ok).toBe(true);

      const second = await router.execute(
        { tool: 'code', action: 'read', params: { filePaths: ['src/a.ts', 'src/b.ts'] } },
        toolContext(root, deltaCache)
      );
      const secondData = second.data as BatchReadData;
      expect(secondData.files.every((file) => file.content === '[unchanged since last read]')).toBe(
        true
      );

      const longContent = Array.from(
        { length: 400 },
        (_, i) => `export const value${i} = "${'x'.repeat(80)}";`
      ).join('\n');
      await writeFile(join(root, 'src/long.ts'), longContent);

      const capped = await router.execute(
        { tool: 'code', action: 'read', params: { filePaths: ['src/long.ts'] } },
        toolContext(root, undefined, 1000)
      );
      const cappedData = capped.data as BatchReadData;
      const cappedFile = cappedData.files[0];
      expect(capped.ok).toBe(true);
      expect(cappedFile?.truncated).toBe(true);
      expect(cappedFile?.originalTokensEstimate).toBeGreaterThan(
        cappedData.summary.perFileTokenBudget
      );
      expect(cappedFile?.content).toContain('truncated for batch read budget');
    });
  });

  it('keeps SCAN planning consistent with toolChoice none', () => {
    const tracker = ExplorationTracker.resolve(
      { source: 'system', strategy: 'analyst' },
      { maxIterations: 12, searchBudget: 8 }
    );

    expect(tracker?.phase).toBe('SCAN');
    expect(tracker?.getToolChoice()).toBe('none');

    tracker?.tick();
    const nudge = tracker?.getNudge({ expectPlan: () => undefined } as never);

    expect(nudge?.type).toBe('planning');
    expect(nudge?.text).toContain('下一轮');
    expect(nudge?.text).not.toContain('同一轮');
    expect(nudge?.text).not.toContain('立即开始执行');
  });
});
