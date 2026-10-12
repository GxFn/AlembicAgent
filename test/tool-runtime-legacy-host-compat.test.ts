/**
 * I23（L4-P34，待决事项③未答复）：旧宿主兼容分支本轮只做注释、诊断与 deprecated 标注，不删除。
 *
 * 本文件守护决定前可以落地的部分：
 * 1. graph.query 的“query type → 宿主方法”表是单一常量（GRAPH_QUERY_HOST_READERS），
 *    availability 快照与 graph handler 都从它派生，不再各自手抄一份方法名；
 * 2. 表里逐项标出旧宿主兼容入口（legacy），且恰好是唯一生产宿主不提供的那几项；
 * 3. noteFinding 字符串回执（旧宿主形态）的兼容转译带诊断，对象回执不受影响。
 *
 * 删除这些分支、收窄 MemoryCoordinatorLike 与 query type enum 依赖待决事项③，不在本包。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EvidenceLedgerLike } from '../src/tools/kernel/index.js';
import { GRAPH_QUERY_HOST_READERS, type ToolContext } from '../src/tools/kernel/registry.js';
import { describeToolAvailability } from '../src/tools/runtime/availability.js';
import { handle as handleGraph } from '../src/tools/runtime/handlers/graph.js';
import { handle as handleMemory } from '../src/tools/runtime/handlers/memory.js';
import { TOOL_REGISTRY } from '../src/tools/runtime/registry.js';

type GraphPort = 'projectGraph' | 'codeEntityGraph';

const ENTITY = 'Fixture';
const LIMIT = 7;

/**
 * 重构前 graph handler 实际发出的调用：读取顺序与实参形状。这里刻意写死而不是从常量推导，
 * 抽常量时任何读取顺序或实参的漂移都会让本用例变红。
 */
const EXPECTED_READERS: Record<
  string,
  Array<{ port: GraphPort; method: string; args: unknown[]; legacy: boolean }>
> = {
  class: [
    { port: 'projectGraph', method: 'getClassInfo', args: [ENTITY], legacy: false },
    { port: 'codeEntityGraph', method: 'queryEntity', args: [ENTITY, 'class'], legacy: true },
  ],
  protocol: [{ port: 'projectGraph', method: 'getProtocolInfo', args: [ENTITY], legacy: false }],
  hierarchy: [{ port: 'projectGraph', method: 'getClassHierarchy', args: [ENTITY], legacy: false }],
  callers: [
    { port: 'projectGraph', method: 'getCallers', args: [ENTITY, LIMIT], legacy: false },
    {
      port: 'codeEntityGraph',
      method: 'queryCallGraph',
      args: [ENTITY, 'callers', LIMIT],
      legacy: true,
    },
  ],
  callees: [
    { port: 'projectGraph', method: 'getCallees', args: [ENTITY, LIMIT], legacy: false },
    {
      port: 'codeEntityGraph',
      method: 'queryCallGraph',
      args: [ENTITY, 'callees', LIMIT],
      legacy: true,
    },
  ],
  overrides: [{ port: 'projectGraph', method: 'getMethodOverrides', args: [ENTITY], legacy: true }],
  extensions: [{ port: 'projectGraph', method: 'getCategoryMap', args: [ENTITY], legacy: true }],
  impact: [
    { port: 'codeEntityGraph', method: 'impactAnalysis', args: [ENTITY, LIMIT], legacy: false },
  ],
  search: [
    { port: 'projectGraph', method: 'searchEntities', args: [ENTITY, LIMIT], legacy: false },
    { port: 'codeEntityGraph', method: 'search', args: [ENTITY, LIMIT], legacy: true },
  ],
};

function registryQueryTypes(): unknown[] {
  const properties = TOOL_REGISTRY.graph.actions.query.params.properties as Record<
    string,
    { enum?: unknown[] }
  >;
  return properties.type.enum ?? [];
}

/** 只接一个宿主方法的上下文；方法返回带方法名的非空值，便于确认实际走了哪条读取路径。 */
function singleMethodContext(port: GraphPort, method: string) {
  const fn = vi.fn((...args: unknown[]) => ({ via: `${port}.${method}`, args }));
  const ctx: ToolContext = { projectRoot: process.cwd(), [port]: { [method]: fn } };
  return { ctx, fn };
}

function uniquePortMethods(): Array<{ port: GraphPort; method: string }> {
  const seen = new Map<string, { port: GraphPort; method: string }>();
  for (const readers of Object.values(EXPECTED_READERS)) {
    for (const { port, method } of readers) {
      seen.set(`${port}.${method}`, { port, method });
    }
  }
  return [...seen.values()];
}

describe('graph.query host method table is a single shared constant', () => {
  it('declares exactly the registry query types, in schema order, with the pre-refactor readers', () => {
    expect(Object.keys(GRAPH_QUERY_HOST_READERS)).toEqual(registryQueryTypes());
    for (const [type, expected] of Object.entries(EXPECTED_READERS)) {
      const readers = GRAPH_QUERY_HOST_READERS[type as keyof typeof GRAPH_QUERY_HOST_READERS];
      expect(
        readers.map((reader) => ({
          port: reader.port,
          method: reader.method,
          args: reader.args(ENTITY, LIMIT),
          legacy: reader.legacy === true,
        })),
        type
      ).toEqual(expected);
    }
  });

  it.each(
    uniquePortMethods()
  )('derives availability and handler reads for $port.$method from the same table', async ({
    port,
    method,
  }) => {
    const servedTypes = Object.entries(EXPECTED_READERS)
      .filter(([, readers]) =>
        readers.some((reader) => reader.port === port && reader.method === method)
      )
      .map(([type]) => type);
    const { ctx, fn } = singleMethodContext(port, method);

    const snapshot = describeToolAvailability(ctx);
    expect(snapshot.parameters?.graph?.query?.type).toEqual(
      registryQueryTypes().filter((type) => servedTypes.includes(type as string))
    );

    for (const type of registryQueryTypes() as string[]) {
      fn.mockClear();
      const result = await handleGraph('query', { type, entity: ENTITY, limit: LIMIT }, ctx);
      const reader = EXPECTED_READERS[type].find(
        (candidate) => candidate.port === port && candidate.method === method
      );
      if (!reader) {
        // 表里没有这条读取路径：availability 隐藏该分支，handler 也如实报端口不可用。
        expect(result.ok, `${type} via ${port}.${method}`).toBe(false);
        expect(result.error).toContain('host method is not available');
        expect(fn).not.toHaveBeenCalled();
        continue;
      }
      expect(result.ok, `${type} via ${port}.${method}`).toBe(true);
      expect(fn).toHaveBeenCalledExactlyOnceWith(...reader.args);
      expect(result.data).toMatchObject({
        type,
        entity: ENTITY,
        result: { via: `${port}.${method}` },
      });
      // 只有备用读取器在场时（索引 > 0）才是回退；主读取器直接命中不记回退。
      const index = EXPECTED_READERS[type].indexOf(reader);
      expect(result._meta?.fallbackUsed, `${type} fallback`).toBe(index > 0);
    }
  });

  it('hides exactly the legacy-only query types on the production host shape', async () => {
    const production: Record<GraphPort, Record<string, () => unknown>> = {
      projectGraph: {},
      codeEntityGraph: {},
    };
    for (const readers of Object.values(EXPECTED_READERS)) {
      for (const reader of readers) {
        if (!reader.legacy) {
          production[reader.port][reader.method] = () => ({ via: reader.method });
        }
      }
    }
    const ctx: ToolContext = { projectRoot: process.cwd(), ...production };
    const snapshot = describeToolAvailability(ctx);
    expect(snapshot.parameters?.graph?.query?.type).toEqual(
      registryQueryTypes().filter((type) => type !== 'overrides' && type !== 'extensions')
    );
    expect(
      snapshot.unavailable
        ?.filter((entry) => entry.tool === 'graph' && entry.action === 'query')
        .map((entry) => entry.operation)
        .sort()
    ).toEqual(['extensions', 'overrides']);

    // 生产形态下 class/callers/callees/search 都由主读取器命中，不应被诊断为回退。
    for (const type of ['class', 'callers', 'callees', 'search']) {
      const result = await handleGraph('query', { type, entity: ENTITY }, ctx);
      expect(result.ok, type).toBe(true);
      expect(result._meta?.fallbackUsed, type).toBe(false);
    }
  });

  it('keeps graph method names out of availability.ts and the graph handler', () => {
    // 两处都只能经共享常量取方法名；手抄任一 query 方法名都会让两份表重新分叉。
    // 'search' 同时是 knowledge 的动作名（availability 合法使用），字面量检查排除它，
    // 改由“不直接访问 ctx.codeEntityGraph”兜住实体图端口的手抄。
    const methods = uniquePortMethods()
      .map(({ method }) => method)
      .filter((method) => method !== 'search');
    for (const rel of [
      'src/tools/runtime/availability.ts',
      'src/tools/runtime/handlers/graph.ts',
    ]) {
      const source = readFileSync(path.join(process.cwd(), rel), 'utf8');
      expect(source, rel).toContain('GRAPH_QUERY_HOST_READERS');
      const literals = methods.filter((method) => new RegExp(`['"\`]${method}['"\`]`).test(source));
      expect(literals, rel).toEqual([]);
      expect(source, rel).not.toMatch(/ctx\.codeEntityGraph/);
    }
  });
});

describe('noteFinding legacy string receipt compatibility', () => {
  function fileLedger(): EvidenceLedgerLike {
    const entry = { id: 'E-1', file: 'src/auth/AuthService.ts', content: 'class AuthService {}' };
    return {
      get: (ref) => (ref === 'E-1' ? entry : null),
      search: () => [entry],
      listRecent: () => [entry],
      stats: () => ({ entries: 1, distinctFiles: 1 }),
      checkFreshness: () => 'unknown',
    };
  }

  function noteFindingContext(receipt: unknown): ToolContext {
    return {
      projectRoot: process.cwd(),
      memoryCoordinator: {
        noteFinding: vi.fn(() => receipt),
      } as unknown as ToolContext['memoryCoordinator'],
      runtime: { evidenceLedger: fileLedger() },
    };
  }

  const params = { finding: 'AuthService owns login', evidenceRefs: ['E-1'] };

  function legacyWarnings(result: Awaited<ReturnType<typeof handleMemory>>) {
    return (result._meta?.diagnosticWarnings ?? []).filter(
      (warning) => warning.code === 'MEMORY_NOTE_FINDING_LEGACY_STRING_RECEIPT'
    );
  }

  it('records a legacy string receipt and reports the compatibility translation', async () => {
    const result = await handleMemory(
      'note_finding',
      params,
      noteFindingContext('📌 recorded by legacy host')
    );
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      recorded: true,
      target: 'activeContext',
      message: '📌 recorded by legacy host',
      verified: true,
    });
    // 兼容转译不是能力降级：结果完整，只留诊断供待决事项③核对是否仍有旧宿主。
    expect(result._meta?.degraded).not.toBe(true);
    expect(legacyWarnings(result)).toEqual([
      expect.objectContaining({
        tool: 'memory',
        stage: 'memory.note_finding',
        message: expect.stringContaining('recorded=true'),
      }),
    ]);
  });

  it('keeps a warning-prefixed legacy string receipt as a failure and still reports the translation', async () => {
    const result = await handleMemory(
      'note_finding',
      params,
      noteFindingContext('⚠ ActiveContext is not available')
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('⚠ ActiveContext is not available');
    expect(legacyWarnings(result)).toEqual([
      expect.objectContaining({ message: expect.stringContaining('recorded=false') }),
    ]);
  });

  it('adds no legacy diagnostic for the production object receipt', async () => {
    const result = await handleMemory(
      'note_finding',
      params,
      noteFindingContext({
        recorded: true,
        target: 'activeContext',
        importance: 5,
        message: 'recorded',
      })
    );
    expect(result.ok).toBe(true);
    expect(result._meta?.diagnosticWarnings ?? []).toEqual([]);
  });
});
