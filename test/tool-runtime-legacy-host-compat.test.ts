/**
 * I23（L4-P34，待决事项③未答复）：旧宿主兼容分支本轮只做注释、诊断与 deprecated 标注，不删除。
 *
 * 本文件守护决定前可以落地的部分：
 * 1. graph.query 的“query type → 宿主方法”表是单一常量（GRAPH_QUERY_HOST_READERS），
 *    availability 快照与 graph handler 都从它派生，不再各自手抄一份方法名；
 * 2. 表里逐项标出旧宿主兼容入口（legacy），且恰好是唯一生产宿主不提供的那几项；
 * 3. noteFinding 字符串回执（旧宿主形态）的兼容转译带诊断，对象回执不受影响；
 * 4. graph 的 legacy 读取器被实际调用（含下标 0 的 overrides/extensions 唯一读取器）一律记
 *    GRAPH_QUERY_LEGACY_READER：返回值、返回空、抛错、读取中被取消都留痕（result=value|empty|
 *    error|aborted），失败文案另带 path=<port>.<method>；下标 > 0 的成功读取另记 GRAPH_QUERY_FALLBACK；
 * 5. knowledge.prime/detail 在 knowledgeRead 缺省时回落 knowledgeRepo 会记一条 info 日志，
 *    search-only 回落仍只用 KNOWLEDGE_PRIME_SEARCH_ONLY 诊断。
 *
 * 删除这些分支、收窄 MemoryCoordinatorLike 与 query type enum 依赖待决事项③，不在本包。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EvidenceLedgerLike } from '../src/tools/kernel/index.js';
import {
  GRAPH_QUERY_HOST_READERS,
  type ToolContext,
  type ToolResult,
} from '../src/tools/kernel/registry.js';
import { describeToolAvailability } from '../src/tools/runtime/availability.js';
import { handle as handleGraph } from '../src/tools/runtime/handlers/graph.js';
import { handle as handleKnowledge } from '../src/tools/runtime/handlers/knowledge.js';
import { handle as handleMemory } from '../src/tools/runtime/handlers/memory.js';
import { ToolRouterAdapter } from '../src/tools/runtime/index.js';
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
      // legacy 读取器无论处在下标 0（overrides/extensions 唯一读取器）还是备用位，命中都要留
      // GRAPH_QUERY_LEGACY_READER 痕迹并带出 path=<port>.<method>，供待决事项③事后核对旧宿主；
      // 非 legacy 主读取器命中不记这条诊断。
      const warnings = result._meta?.diagnosticWarnings ?? [];
      const legacyWarnings = warnings.filter(
        (warning) => warning.code === 'GRAPH_QUERY_LEGACY_READER'
      );
      if (reader.legacy) {
        expect(legacyWarnings, `${type} legacy diagnostic`).toEqual([
          expect.objectContaining({
            tool: 'graph',
            stage: `query(${type})`,
            message: expect.stringContaining(`path=${port}.${method}`),
          }),
        ]);
      } else {
        expect(legacyWarnings, `${type} legacy diagnostic`).toEqual([]);
      }
      // 回退诊断与 legacy 诊断互相独立：下标 > 0 时额外记 GRAPH_QUERY_FALLBACK。
      expect(
        warnings.some((warning) => warning.code === 'GRAPH_QUERY_FALLBACK'),
        `${type} fallback diagnostic`
      ).toBe(index > 0);
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
      // 生产形态不经过任何 legacy 读取器，不能留下旧宿主痕迹。
      expect(result._meta?.diagnosticWarnings ?? [], type).toEqual([]);
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

/**
 * I23 第四轮补修（L4-P34r4）：legacy 读取器被实际调用但抛错或读取中被取消时同样要留痕。
 * 此前 readGraph 的非 ok 分支直接 fail，既无 GRAPH_QUERY_LEGACY_READER 也无 path，待决事项③在
 * 抛错场景下无法核对“旧端口仍被接线并调用”；错误文案也分不清抛错的是主读取器还是旧端口。
 */
describe('graph legacy reader trace survives a throwing or canceled read', () => {
  const projectRoot = process.cwd();

  function graphLegacyWarnings(result: ToolResult) {
    return (result._meta?.diagnosticWarnings ?? []).filter(
      (warning) => warning.code === 'GRAPH_QUERY_LEGACY_READER'
    );
  }

  function throwing(message: string): () => never {
    return () => {
      throw new Error(message);
    };
  }

  it.each([
    { type: 'overrides', method: 'getMethodOverrides' },
    { type: 'extensions', method: 'getCategoryMap' },
  ])('records the index-0 legacy $type reader when it throws', async ({ type, method }) => {
    const ctx: ToolContext = { projectRoot, projectGraph: { [method]: throwing('boom') } };
    const result = await handleGraph('query', { type, entity: ENTITY }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`Graph query(${type}) error: boom`);
    expect(result.error).toContain(`path=projectGraph.${method}`);
    expect(graphLegacyWarnings(result)).toEqual([
      {
        code: 'GRAPH_QUERY_LEGACY_READER',
        tool: 'graph',
        stage: `query(${type})`,
        message: `path=projectGraph.${method}; reason=legacy-host-port; result=error`,
      },
    ]);
    // 普通读取错误不写 resultStatus：仍由 adapter 按 ok 归一（返回时取消信号已触发则归一为 aborted）。
    expect(result._meta?.resultStatus).toBeUndefined();
    expect(result._meta?.fallbackUsed).not.toBe(true);
  });

  it('records the legacy reader when its promise rejects', async () => {
    const ctx: ToolContext = {
      projectRoot,
      projectGraph: { getMethodOverrides: () => Promise.reject(new Error('boom-async')) },
    };
    const result = await handleGraph('query', { type: 'overrides', entity: ENTITY }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      'Graph query(overrides) error: boom-async (path=projectGraph.getMethodOverrides)'
    );
    expect(graphLegacyWarnings(result)).toEqual([
      expect.objectContaining({
        message: 'path=projectGraph.getMethodOverrides; reason=legacy-host-port; result=error',
      }),
    ]);
  });

  it('attributes a throwing secondary legacy reader by path after the primary returned nothing', async () => {
    const getClassInfo = vi.fn(() => null);
    const ctx: ToolContext = {
      projectRoot,
      projectGraph: { getClassInfo },
      codeEntityGraph: { queryEntity: throwing('legacy-boom') },
    };
    const result = await handleGraph('query', { type: 'class', entity: ENTITY }, ctx);
    expect(result.ok).toBe(false);
    expect(getClassInfo).toHaveBeenCalledExactlyOnceWith(ENTITY);
    expect(result.error).toBe(
      'Graph query(class) error: legacy-boom (path=codeEntityGraph.queryEntity)'
    );
    expect(graphLegacyWarnings(result)).toEqual([
      expect.objectContaining({
        tool: 'graph',
        stage: 'query(class)',
        message: 'path=codeEntityGraph.queryEntity; reason=legacy-host-port; result=error',
      }),
    ]);
    // 没有产出结果就谈不上“经备用路径得到结果”：fallbackUsed 仍只在成功路径为 true。
    expect(result._meta?.fallbackUsed).not.toBe(true);
  });

  it('names the throwing primary reader without a legacy trace and never reaches the legacy port', async () => {
    const queryEntity = vi.fn();
    const ctx: ToolContext = {
      projectRoot,
      projectGraph: { getClassInfo: throwing('primary-boom') },
      codeEntityGraph: { queryEntity },
    };
    const result = await handleGraph('query', { type: 'class', entity: ENTITY }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      'Graph query(class) error: primary-boom (path=projectGraph.getClassInfo)'
    );
    // 主读取器抛错即终止，不进入备用端口；非 legacy 读取器抛错不留旧宿主痕迹。
    expect(queryEntity).not.toHaveBeenCalled();
    expect(result._meta?.diagnosticWarnings ?? []).toEqual([]);
    expect(result._meta?.resultStatus).toBeUndefined();
  });

  it('records the legacy reader that was in flight when the read was canceled', async () => {
    const controller = new AbortController();
    let finish!: (value: null) => void;
    const pending = new Promise<null>((resolve) => {
      finish = resolve;
    });
    const getMethodOverrides = vi.fn(() => {
      // 读取进行中宿主取消：runOperation 先定终态为 aborted，不合作的读取器稍后才结束。
      controller.abort();
      return pending;
    });
    const ctx: ToolContext = {
      projectRoot,
      projectGraph: { getMethodOverrides },
      abortSignal: controller.signal,
    };
    const result = await handleGraph('query', { type: 'overrides', entity: ENTITY }, ctx);
    finish(null);
    expect(result.ok).toBe(false);
    expect(result._meta?.resultStatus).toBe('aborted');
    expect(result.error).toContain('Graph query(overrides) aborted');
    expect(result.error).toContain('path=projectGraph.getMethodOverrides');
    expect(graphLegacyWarnings(result)).toEqual([
      expect.objectContaining({
        stage: 'query(overrides)',
        message: 'path=projectGraph.getMethodOverrides; reason=legacy-host-port; result=aborted',
      }),
    ]);
  });

  it('adds no trace when the cancel arrives before any reader is invoked', async () => {
    const controller = new AbortController();
    controller.abort();
    const getMethodOverrides = vi.fn(() => ({ via: 'projectGraph.getMethodOverrides' }));
    const ctx: ToolContext = {
      projectRoot,
      projectGraph: { getMethodOverrides },
      abortSignal: controller.signal,
    };
    const result = await handleGraph('query', { type: 'overrides', entity: ENTITY }, ctx);
    expect(result.ok).toBe(false);
    expect(result._meta?.resultStatus).toBe('aborted');
    expect(getMethodOverrides).not.toHaveBeenCalled();
    // 从未被调用的 legacy 端口不能留假痕迹，也没有可归因的 path。
    expect(result._meta?.diagnosticWarnings ?? []).toEqual([]);
    expect(result.error).not.toContain('path=');
  });

  it('lifts the throwing legacy reader trace onto the adapter envelope diagnostics', async () => {
    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({
          projectRoot,
          tokenBudget: 4000,
          projectGraph: { getMethodOverrides: throwing('boom') },
        }),
      },
    });
    const envelope = await adapter.execute({
      toolId: 'graph',
      args: { action: 'query', params: { type: 'overrides', entity: ENTITY } },
      surface: 'runtime',
      actor: { role: 'agent' },
      source: { kind: 'runtime' },
    });
    expect(envelope).toMatchObject({ ok: false, status: 'error' });
    expect(envelope.text).toContain('Graph query(overrides) error: boom');
    expect(envelope.text).toContain('path=projectGraph.getMethodOverrides');
    expect(envelope.diagnostics.fallbackUsed).toBe(false);
    expect(envelope.diagnostics.warnings).toEqual([
      expect.objectContaining({
        code: 'GRAPH_QUERY_LEGACY_READER',
        tool: 'graph',
        stage: 'query(overrides)',
        message: 'path=projectGraph.getMethodOverrides; reason=legacy-host-port; result=error',
      }),
    ]);
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

describe('knowledge prime/detail legacy knowledgeRepo port is traced', () => {
  const RECIPE = {
    id: 'R-1',
    title: 'Auth convention',
    kind: 'rule',
    doClause: 'Use AuthService.login',
  };

  function searchEngine() {
    return {
      search: vi.fn(async () => [{ id: RECIPE.id, title: RECIPE.title, score: 0.9 }]),
    };
  }

  function readPort() {
    return { getById: vi.fn(async (id: string) => (id === RECIPE.id ? { ...RECIPE } : null)) };
  }

  /** 只统计提到 knowledgeRepo 的 info 日志：旧端口回落的痕迹，不受其它 info 日志干扰。 */
  function legacyRepoLogs(info: ReturnType<typeof vi.spyOn>): string[] {
    return info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('knowledgeRepo'));
  }

  function spyInfo() {
    return vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs once when prime reads details through the legacy knowledgeRepo port', async () => {
    const info = spyInfo();
    const repo = readPort();
    const ctx: ToolContext = {
      projectRoot: process.cwd(),
      searchEngine: searchEngine(),
      knowledgeRepo: repo,
    };
    const result = await handleKnowledge('prime', { taskGoal: 'goal' }, ctx);
    expect(result.ok).toBe(true);
    expect(repo.getById).toHaveBeenCalledWith(RECIPE.id);
    const logs = legacyRepoLogs(info);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[knowledge.prime]');
    expect(logs[0]).toContain('deprecated');
    // 兼容回落只记日志，不改模型可见的 _meta：结果仍是完整知识包，不标 degraded。
    expect(result._meta?.degraded).not.toBe(true);
    expect(result._meta?.diagnosticWarnings ?? []).toEqual([]);
  });

  it('logs once when detail reads through the legacy knowledgeRepo port', async () => {
    const info = spyInfo();
    const repo = readPort();
    const ctx: ToolContext = { projectRoot: process.cwd(), knowledgeRepo: repo };
    const result = await handleKnowledge('detail', { id: RECIPE.id }, ctx);
    expect(result.ok).toBe(true);
    expect(repo.getById).toHaveBeenCalledExactlyOnceWith(RECIPE.id);
    const logs = legacyRepoLogs(info);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[knowledge.detail]');
    expect(logs[0]).toContain('deprecated');
    expect(result._meta?.diagnosticWarnings ?? []).toEqual([]);
  });

  it('does not log the legacy port when knowledgeRead is provided', async () => {
    const info = spyInfo();
    const read = readPort();
    const ctx: ToolContext = {
      projectRoot: process.cwd(),
      searchEngine: searchEngine(),
      knowledgeRead: read,
    };
    const prime = await handleKnowledge('prime', { taskGoal: 'goal' }, ctx);
    const detail = await handleKnowledge('detail', { id: RECIPE.id }, ctx);
    expect(prime.ok).toBe(true);
    expect(detail.ok).toBe(true);
    expect(read.getById).toHaveBeenCalledTimes(2);
    expect(legacyRepoLogs(info)).toEqual([]);
  });

  it('keeps the search-only fallback on its own diagnostic without the legacy port log', async () => {
    const info = spyInfo();
    const ctx: ToolContext = { projectRoot: process.cwd(), searchEngine: searchEngine() };
    const result = await handleKnowledge('prime', { taskGoal: 'goal' }, ctx);
    expect(result.ok).toBe(true);
    expect(result._meta?.diagnosticWarnings?.map((warning) => warning.code)).toEqual([
      'KNOWLEDGE_PRIME_SEARCH_ONLY',
    ]);
    expect(legacyRepoLogs(info)).toEqual([]);
  });
});
