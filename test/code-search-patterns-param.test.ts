/**
 * L4-P2（module-review-2026-10-01 I28 / U14-F14）：code.search 只接受 patterns[]。
 *
 * registry 的 schema 把 patterns 列为 required，router 在 Ajv 阶段就拒绝只带单数 pattern 的调用，
 * handler 里的单数 pattern 回退永远走不到，只会让维护者误以为单数参数仍被支持。回退删除后：
 * - router 路径：只带 pattern 的调用仍在进入 handler 之前被拒绝（Missing required param）。
 * - handler 直调：只带 pattern 或缺少 patterns 时返回明确的 fail，不偷偷按单数参数搜索，也不抛异常。
 * - patterns: [] 仍是 fail；正常的 patterns[] 搜索不受影响。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCallRequest } from '../src/tools/kernel/index.js';
import type { ToolContext } from '../src/tools/kernel/registry.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';
import { handle as handleCode } from '../src/tools/runtime/handlers/code.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-code-search-patterns-'));
  await writeFile(join(root, 'small.ts'), 'one\ntwo\nthree');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function context(): ToolContext {
  return { projectRoot: root, tokenBudget: 8000 };
}

function searchRequest(params: Record<string, unknown>): ToolCallRequest {
  return {
    toolId: 'code',
    args: { action: 'search', params },
    surface: 'runtime',
    actor: { user: 'test' },
    source: { kind: 'runtime' },
  };
}

describe('code.search reads patterns[] only', () => {
  it('rejects a singular pattern at the router before the handler runs', async () => {
    const router = new ToolRouterAdapter({ contextFactory: { create: () => context() } });

    const envelope = await router.execute(searchRequest({ pattern: 'two' }));

    expect(envelope.ok).toBe(false);
    expect(envelope.text).toContain('Missing required param "patterns" for code.search');
  });

  it('does not fall back to a singular pattern when the handler is called directly', async () => {
    const result = await handleCode('search', { pattern: 'two' }, context());

    expect(result).toEqual({ ok: false, data: null, error: 'code.search requires patterns[]' });
  });

  it('fails cleanly when patterns is absent or not an array', async () => {
    for (const params of [{}, { patterns: 'two' }, { patterns: null }]) {
      const result = await handleCode('search', params, context());
      expect(result, JSON.stringify(params)).toEqual({
        ok: false,
        data: null,
        error: 'code.search requires patterns[]',
      });
    }
  });

  it('keeps the empty patterns[] failure', async () => {
    const result = await handleCode('search', { patterns: [] }, context());

    expect(result).toEqual({ ok: false, data: null, error: 'code.search requires patterns[]' });
  });

  it('still searches with patterns[]', async () => {
    const result = await handleCode('search', { patterns: ['two'] }, context());

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      total: 1,
      matches: [expect.objectContaining({ file: 'small.ts', line: 2 })],
    });
  });
});
