import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EVIDENCE_TOOL_IDS } from '@alembic/core/knowledge';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { isSearchAction } from '../src/agent/context/exploration/SignalDetector.js';
import { resolveEvidenceAction } from '../src/agent/evidence/EvidenceCapture.js';
import type {
  ParsedToolCall,
  ToolContext,
  ToolResult,
  ToolResultMeta,
} from '../src/tools/kernel/registry.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';
import { ToolRouter } from '../src/tools/runtime/router.js';

/**
 * AUD-sweep-c：审计确认的工具层注释失实（L3-P5 两条、L4-P1 一条）。
 *
 * 每条都分两半：先用真实调用链核对注释陈述的事实（这部分在修注释前就成立，证明新注释写的
 * 是代码事实），再检查注释本身写出了这些事实（这部分在修注释前失败）。事实核对失败说明
 * 调用链变了，应同步改注释，而不是放宽断言。
 */

const repoRoot = process.cwd();

function readSource(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

/** 取紧挨在 `marker` 之前的那一个 JSDoc 块（不允许中间夹代码）。 */
function docBlockBefore(text: string, marker: string): string {
  const index = text.indexOf(marker);
  expect(index, marker).toBeGreaterThanOrEqual(0);
  const head = text.slice(0, index).trimEnd();
  expect(head.endsWith('*/'), marker).toBe(true);
  return head.slice(head.lastIndexOf('/**'));
}

/** 取 `marker` 所在行之前连续的 `//` 注释行。 */
function lineCommentBefore(text: string, marker: string): string {
  const index = text.indexOf(marker);
  expect(index, marker).toBeGreaterThanOrEqual(0);
  const lines = text.slice(0, index).split('\n');
  lines.pop();
  const comment: string[] = [];
  while (lines.length > 0 && lines[lines.length - 1].trim().startsWith('//')) {
    comment.unshift(lines.pop() as string);
  }
  return comment.join('\n');
}

function overviewAdapter(overview: unknown) {
  return new ToolRouterAdapter({
    contextFactory: {
      create: () => ({
        projectRoot: repoRoot,
        tokenBudget: 4000,
        projectGraph: { getOverview: async () => overview },
      }),
    },
  });
}

const overviewRequest = (abortSignal?: AbortSignal) => ({
  toolId: 'graph',
  args: { action: 'overview' },
  surface: 'runtime' as const,
  actor: { role: 'agent' as const },
  source: { kind: 'runtime' as const },
  ...(abortSignal ? { abortSignal } : {}),
});

describe('ToolRouterAdapter normalization comment matches what normalizeToolResultContent rewrites (L3-P5)', () => {
  it('keeps every ordinary field without a node budget, but rewrites the listed shapes', async () => {
    // 400 条 × 11 键远超 4096 显示节点预算：规范化不施加该预算，一条都不能少。
    const rows = Array.from({ length: 400 }, (_, index) => ({
      id: `r${index}`,
      a: 1,
      b: 2,
      c: 3,
      d: 4,
      e: 5,
      f: 6,
      g: index,
      h: 'x',
      i: true,
      j: null,
    }));
    class HostRecord {
      kind = 'host';
    }
    const cyclic: Record<string, unknown> = { name: 'cycle' };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = { leaf: 'bottom' };
    for (let level = 0; level < 70; level++) {
      deep = { next: deep };
    }
    const overview = {
      rows,
      big: 10n,
      fn: () => 'host code',
      notANumber: Number.NaN,
      when: new Date('2026-01-02T03:04:05.000Z'),
      instance: new HostRecord(),
      cyclic,
      deep,
      toJSON: () => ({ replaced: true }),
      get computed() {
        return 'getter ran';
      },
    };

    const envelope = await overviewAdapter(overview).execute(overviewRequest());

    expect(envelope).toMatchObject({ ok: true, status: 'success' });
    const content = envelope.structuredContent as Record<string, unknown>;
    expect(content.rows).toEqual(rows);
    // 键保留、值换成带内标记的形态。
    expect(content.big).toBe('[unavailable: non-JSON value]');
    expect(content.fn).toBe('[unavailable: non-JSON value]');
    expect(content.notANumber).toBe('[unavailable: non-JSON value]');
    expect(content.computed).toBe('[unavailable: accessor]');
    expect((content.cyclic as Record<string, unknown>).self).toBe(
      '[unavailable: circular reference]'
    );
    // Date 转 ISO，类实例转为只含自有数据的普通对象。
    expect(content.when).toBe('2026-01-02T03:04:05.000Z');
    expect(content.instance).toEqual({ kind: 'host' });
    expect(Object.getPrototypeOf(content.instance)).toBe(Object.prototype);
    // 值为函数的自有 toJSON 键被删除。
    expect(Object.hasOwn(content, 'toJSON')).toBe(false);
    // 超过 64 层嵌套的容器整体换成标记，其下的字段不再输出。
    let cursor: unknown = content.deep;
    let levels = 0;
    while (cursor && typeof cursor === 'object' && 'next' in cursor) {
      cursor = (cursor as Record<string, unknown>).next;
      levels++;
    }
    expect(cursor).toBe('[unavailable: display limit]');
    expect(levels).toBeLessThan(70);
    expect(envelope.text).not.toContain('bottom');
    const codes = envelope.diagnostics.warnings.map((warning) => warning.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'TOOL_RESULT_DISPLAY_CYCLE',
        'TOOL_RESULT_DISPLAY_UNSUPPORTED',
        'TOOL_RESULT_DISPLAY_NORMALIZED',
        'TOOL_RESULT_DISPLAY_LIMIT',
      ])
    );
    expect(envelope.diagnostics.degraded).toBe(true);
  });

  it('documents the rewrites instead of claiming no field is ever removed', () => {
    const comment = lineCommentBefore(
      readSource('src/tools/runtime/adapter/ToolRouterAdapter.ts'),
      'const normalized = normalizeToolResultContent(result.data);'
    );
    expect(comment).not.toMatch(/、原型，不删除任何字段/);
    for (const fact of [
      '4096',
      'toJSON 键被删除',
      'MAX_NESTING_DEPTH',
      '[unavailable: display limit]',
      '[unavailable: accessor]',
      'ISO',
    ]) {
      expect(comment).toContain(fact);
    }
  });
});

/** 让 adapter 走到真实的 #toEnvelope 与取消归一分支，只替换 handler 产出的 ToolResult。 */
class ScriptedRouter extends ToolRouter {
  readonly #script: (ctx: ToolContext) => ToolResult;

  constructor(script: (ctx: ToolContext) => ToolResult) {
    super();
    this.#script = script;
  }

  override async execute(_call: ParsedToolCall, ctx: ToolContext): Promise<ToolResult> {
    return this.#script(ctx);
  }
}

describe('ToolResultMeta comment states the full ok/resultStatus composition (L3-P5)', () => {
  const meta = (resultStatus?: ToolResultMeta['resultStatus']): ToolResultMeta => ({
    ...(resultStatus ? { resultStatus } : {}),
    cached: false,
    tokensEstimate: 0,
    durationMs: 0,
  });

  it.each([
    {
      name: 'failure without status after cancel',
      ok: false,
      status: undefined,
      abort: true,
      expected: 'aborted',
    },
    {
      name: 'failure without status',
      ok: false,
      status: undefined,
      abort: false,
      expected: 'error',
    },
    {
      name: 'explicit error after cancel',
      ok: false,
      status: 'error',
      abort: true,
      expected: 'error',
    },
    {
      name: 'success without status after cancel',
      ok: true,
      status: undefined,
      abort: true,
      expected: 'success',
    },
    {
      name: 'explicit partial success',
      ok: true,
      status: 'partial',
      abort: false,
      expected: 'partial',
    },
  ] as const)('normalizes $name to $expected', async ({ ok, status, abort, expected }) => {
    const controller = new AbortController();
    const router = new ScriptedRouter(() => {
      // 取消发生在 handler 执行期间：adapter 的执行前检查已经放行。
      if (abort) {
        controller.abort();
      }
      return {
        ok,
        data: ok ? 'partial data' : null,
        ...(ok ? {} : { error: 'host stopped' }),
        _meta: meta(status),
      };
    });
    const adapter = new ToolRouterAdapter({
      router,
      contextFactory: { create: () => ({ projectRoot: repoRoot, tokenBudget: 4000 }) },
    });

    const envelope = await adapter.execute(overviewRequest(controller.signal));

    expect(envelope.ok).toBe(ok);
    expect(envelope.status).toBe(expected);
  });

  // W2a-02（审阅包 L3-P13）：compression 既没有生产者也没有消费者，按决定从类型删除；
  // tsconfig 只含 src、vitest 不做类型检查，所以用 TypeScript 解析器读取成员集合作为守护。
  it('declares no compression member on ToolResultMeta', () => {
    const file = path.join(repoRoot, 'src/tools/kernel/registry.ts');
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const declaration = source.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === 'ToolResultMeta'
    );
    expect(declaration).toBeDefined();
    const members = (declaration?.members ?? []).map((member) =>
      member.name && ts.isIdentifier(member.name) ? member.name.text : '(computed)'
    );
    expect(members).not.toContain('compression');
    expect(members).toEqual([
      'resultStatus',
      'cached',
      'tokensEstimate',
      'durationMs',
      'degraded',
      'fallbackUsed',
      'diagnosticWarnings',
    ]);
  });

  it('names the cancellation branch next to the "missing resultStatus" rule', () => {
    const text = readSource('src/tools/kernel/registry.ts');
    const doc = docBlockBefore(text, 'export interface ToolResultMeta');
    expect(doc).not.toMatch(/缺省 resultStatus 时，adapter 才按 ok 归一为 success\/error。/);
    expect(doc).toContain('abortSignal');
    expect(doc).toContain("'aborted'");
    const field = docBlockBefore(text, '  resultStatus?: ToolResultStatus;');
    expect(field).toContain("'aborted'");
  });
});

describe('runtime registry header names the action-keyed places outside tools/ (L4-P1)', () => {
  it('evidence capture and exploration metrics key on action names that do not follow the registry', () => {
    // 证据台账只收 Core EVIDENCE_TOOL_IDS 白名单内的 <tool>.<action>（跨仓常量）。
    expect([...EVIDENCE_TOOL_IDS]).toEqual([
      'code.read',
      'code.search',
      'code.outline',
      'code.structure',
      'graph.overview',
      'graph.query',
      'terminal.exec',
    ]);
    expect(resolveEvidenceAction({ name: 'code', args: { action: 'read' }, id: 'c1' })).toBe(
      'code.read'
    );
    // 一个只在注册表里新增的读证据类动作不会落账，note_finding/submit 也就无法引用它。
    expect(resolveEvidenceAction({ name: 'code', args: { action: 'peek' }, id: 'c2' })).toBeNull();
    // 探索指标按动作名分类。
    expect(isSearchAction('code', { action: 'search' })).toBe(true);
    expect(isSearchAction('code', { action: 'peek' })).toBe(false);
    const tracker = readSource('src/agent/context/ExplorationTracker.ts');
    expect(tracker).toMatch(/\['structure', 'search', 'read', 'outline'\]\.includes\(action\)/);
  });

  it('lists evidence capture and exploration classification among the places to sync', () => {
    const text = readSource('src/tools/runtime/registry.ts');
    const header = text.slice(0, text.indexOf('*/') + 2);
    for (const place of [
      'EvidenceCapture.ts',
      'EVIDENCE_TOOL_IDS',
      'AlembicCore',
      'ExplorationTracker.ts',
      'SignalDetector.ts',
    ]) {
      expect(header).toContain(place);
    }
  });
});
