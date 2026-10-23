/**
 * I23（L4-P34）旧宿主兼容分支：按待决事项③答复（2026-10-20，确认 ../Alembic 是唯一宿主）删除后的守护。
 * W1-05 只删 graph 旧读取器与 knowledge.prime 的 knowledgeRepo 回落；noteFinding 字符串回执与
 * MemoryCoordinatorLike 收窄、prime 的 search-only 回落属 W2b（派发行 D2），本文件对应用例保持不变。
 *
 * 本文件守护：
 * 1. graph.query 的“query type → 宿主方法”表仍是单一常量（GRAPH_QUERY_HOST_READERS），availability 与
 *    graph handler 都从它派生；每个 type 恰好一个生产宿主读取器，没有 legacy 标记，也没有备用读取器；
 *    query type 去掉只有旧读取器的 overrides/extensions（模型可见 schema 收窄），Analyst VERIFY 门同步；
 * 2. 只接旧方法（codeEntityGraph.queryEntity/queryCallGraph/search、projectGraph.getMethodOverrides/
 *    getCategoryMap）的上下文不再被读取：availability 不广告，handler 报 host method is not available；
 * 3. GRAPH_QUERY_LEGACY_READER 与 GRAPH_QUERY_FALLBACK 两个诊断码消失；8be39e6/c64c3de 的失败口径
 *    （path 归因、取消、unprintable 降级与 GRAPH_QUERY_UNPRINTABLE_ERROR）改挂到生产读取器上继续成立，
 *    graph.overview 共用同一非 ok 分支；
 * 4. noteFinding 字符串回执的兼容转译带诊断（W2b 前保持）；
 * 5. knowledge.prime 只认 knowledgeRead：只注入 knowledgeRepo 时返回 KNOWLEDGE_READ_PORT_UNAVAILABLE，
 *    不调用 getById；detail 的 knowledgeRepo 回落与 search-only 回落不在本包，保持原样。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Logger from '@alembic/core/logging';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analystVerifyOnlyGate } from '../src/agent/runtime/toolPipeline/phaseGates.js';
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

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTITY = 'Fixture';
const LIMIT = 7;

/** 收窄后的 graph.query type，顺序即 runtime registry 枚举与读取表的键序。 */
const QUERY_TYPES = ['class', 'protocol', 'hierarchy', 'callers', 'callees', 'impact', 'search'];

/**
 * 唯一生产宿主（../Alembic ProjectGraphPorts）提供的读取器：读取顺序与实参形状写死而不是从常量推导，
 * 任何漂移都会让本用例变红。
 */
const EXPECTED_READERS: Record<string, { port: GraphPort; method: string; args: unknown[] }> = {
  class: { port: 'projectGraph', method: 'getClassInfo', args: [ENTITY] },
  protocol: { port: 'projectGraph', method: 'getProtocolInfo', args: [ENTITY] },
  hierarchy: { port: 'projectGraph', method: 'getClassHierarchy', args: [ENTITY] },
  callers: { port: 'projectGraph', method: 'getCallers', args: [ENTITY, LIMIT] },
  callees: { port: 'projectGraph', method: 'getCallees', args: [ENTITY, LIMIT] },
  impact: { port: 'codeEntityGraph', method: 'impactAnalysis', args: [ENTITY, LIMIT] },
  search: { port: 'projectGraph', method: 'searchEntities', args: [ENTITY, LIMIT] },
};

/** 已删除的旧宿主读取器：唯一生产宿主从不提供，删除前四处扫描在宿主与三仓均为 0。 */
const RETIRED_LEGACY_METHODS: Array<{ port: GraphPort; method: string }> = [
  { port: 'codeEntityGraph', method: 'queryEntity' },
  { port: 'codeEntityGraph', method: 'queryCallGraph' },
  { port: 'codeEntityGraph', method: 'search' },
  { port: 'projectGraph', method: 'getMethodOverrides' },
  { port: 'projectGraph', method: 'getCategoryMap' },
];

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

/** 生产宿主形态：两个图谱端口只带生产方法。 */
function productionGraphContext(): ToolContext {
  const ports: Record<GraphPort, Record<string, () => unknown>> = {
    projectGraph: {},
    codeEntityGraph: {},
  };
  for (const reader of Object.values(EXPECTED_READERS)) {
    ports[reader.port][reader.method] = () => ({ via: reader.method });
  }
  return { projectRoot: process.cwd(), ...ports };
}

/**
 * 编译器探针（与 test/contract-surface.test.ts 的 typecheckRouterContractProbes 同一做法）：
 * tsconfig 只包含 src，vitest 不做类型检查，类型收窄只能用 TypeScript compiler API 守护。
 */
function typecheckProbes(probes: Record<string, string>): Record<string, string[]> {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const virtualFiles = new Map(
    Object.entries(probes).map(([name, text]) => [path.join(REPO_ROOT, 'test', name), text])
  );
  const host = ts.createCompilerHost(options);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);
  host.fileExists = (fileName) => virtualFiles.has(fileName) || baseFileExists(fileName);
  host.readFile = (fileName) => virtualFiles.get(fileName) ?? baseReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = virtualFiles.get(fileName);
    return text === undefined
      ? baseGetSourceFile(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  const program = ts.createProgram([...virtualFiles.keys()], options, host);
  const result: Record<string, string[]> = {};
  for (const name of Object.keys(probes)) {
    const sourceFile = program.getSourceFile(path.join(REPO_ROOT, 'test', name));
    expect(sourceFile).toBeDefined();
    result[name] = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ].map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  }
  return result;
}

describe('graph.query host method table keeps one production reader per query type', () => {
  it('declares exactly the narrowed registry query types, in schema order', () => {
    expect(registryQueryTypes()).toEqual(QUERY_TYPES);
    expect(Object.keys(GRAPH_QUERY_HOST_READERS)).toEqual(QUERY_TYPES);
    expect(TOOL_REGISTRY.graph.actions.query.description).not.toMatch(/overrides|extensions/);
  });

  it('maps every query type to exactly one reader without a legacy marker', () => {
    for (const [type, expected] of Object.entries(EXPECTED_READERS)) {
      const reader: unknown =
        GRAPH_QUERY_HOST_READERS[type as keyof typeof GRAPH_QUERY_HOST_READERS];
      // 单个读取器而不是按优先级排列的读取器数组：没有备用读取器，也就没有回退。
      expect(Array.isArray(reader), type).toBe(false);
      expect(Object.isFrozen(reader), type).toBe(true);
      const spec = reader as {
        port: string;
        method: string;
        args: (e: string, l: number) => unknown;
      };
      expect(Object.keys(spec).sort(), type).toEqual(['args', 'method', 'port']);
      expect(
        { port: spec.port, method: spec.method, args: spec.args(ENTITY, LIMIT) },
        type
      ).toEqual(expected);
    }
  });

  it('narrows the kernel graph types at compile time', () => {
    const diagnostics = typecheckProbes({
      '__graph-query-type-retired.probe.ts': [
        "import type { GraphQueryType } from '../src/tools/kernel/registry.js';",
        "export const retired: GraphQueryType = 'overrides';",
        '',
      ].join('\n'),
      '__graph-reader-legacy-retired.probe.ts': [
        "import type { GraphQueryHostReader } from '../src/tools/kernel/registry.js';",
        'export const reader: GraphQueryHostReader = {',
        "  port: 'projectGraph',",
        "  method: 'getClassInfo',",
        '  args: () => [],',
        '  legacy: true,',
        '};',
        '',
      ].join('\n'),
      // 正对照：读取表的值就是单个读取器。
      '__graph-reader-single.probe.ts': [
        "import { GRAPH_QUERY_HOST_READERS, type GraphQueryHostReader } from '../src/tools/kernel/registry.js';",
        'export const reader: GraphQueryHostReader = GRAPH_QUERY_HOST_READERS.class;',
        '',
      ].join('\n'),
    });
    expect(diagnostics['__graph-query-type-retired.probe.ts']).toEqual([
      "Type '\"overrides\"' is not assignable to type 'GraphQueryType'.",
    ]);
    expect(diagnostics['__graph-reader-legacy-retired.probe.ts']).toEqual([
      "Object literal may only specify known properties, and 'legacy' does not exist in type 'GraphQueryHostReader'.",
    ]);
    expect(diagnostics['__graph-reader-single.probe.ts']).toEqual([]);
  }, 60000);

  it.each(
    Object.values(EXPECTED_READERS)
  )('derives availability and handler reads for $port.$method from the same table', async ({
    port,
    method,
  }) => {
    const servedTypes = Object.entries(EXPECTED_READERS)
      .filter(([, reader]) => reader.port === port && reader.method === method)
      .map(([type]) => type);
    const { ctx, fn } = singleMethodContext(port, method);

    const snapshot = describeToolAvailability(ctx);
    expect(snapshot.parameters?.graph?.query?.type).toEqual(servedTypes);

    for (const type of QUERY_TYPES) {
      fn.mockClear();
      const result = await handleGraph('query', { type, entity: ENTITY, limit: LIMIT }, ctx);
      const reader = EXPECTED_READERS[type];
      if (reader.port !== port || reader.method !== method) {
        // 表里没有这条读取路径：availability 隐藏该分支，handler 也如实报端口不可用。
        expect(result.ok, `${type} via ${port}.${method}`).toBe(false);
        expect(result.error).toBe(`Graph query(${type}) host method is not available`);
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
      expect(result._meta?.fallbackUsed, `${type} fallback`).not.toBe(true);
      expect(result._meta?.diagnosticWarnings ?? [], `${type} diagnostics`).toEqual([]);
    }
  });

  it('never reads the retired legacy host methods', async () => {
    const legacy = new Map<string, ReturnType<typeof vi.fn>>();
    const ports: Record<GraphPort, Record<string, unknown>> = {
      projectGraph: {},
      codeEntityGraph: {},
    };
    for (const { port, method } of RETIRED_LEGACY_METHODS) {
      const fn = vi.fn(() => ({ via: `${port}.${method}` }));
      legacy.set(`${port}.${method}`, fn);
      ports[port][method] = fn;
    }
    const ctx: ToolContext = { projectRoot: process.cwd(), ...ports };

    // availability：只有旧方法时 graph.query 没有任何可用分支，整个动作不广告。
    const snapshot = describeToolAvailability(ctx);
    expect(snapshot.parameters?.graph?.query?.type).toEqual([]);
    expect(snapshot.actions.graph ?? []).not.toContain('query');

    for (const type of ['class', 'callers', 'callees', 'search']) {
      const result = await handleGraph('query', { type, entity: ENTITY, limit: LIMIT }, ctx);
      expect(result.ok, type).toBe(false);
      expect(result.error, type).toBe(`Graph query(${type}) host method is not available`);
    }
    for (const type of ['overrides', 'extensions']) {
      const result = await handleGraph('query', { type, entity: ENTITY }, ctx);
      expect(result.ok, type).toBe(false);
      expect(result.error, type).toMatch(/^Invalid query type: /);
    }
    for (const [name, fn] of legacy) {
      expect(fn, name).not.toHaveBeenCalled();
    }
  });

  it('serves every query type on the production host shape without fallback or diagnostics', async () => {
    const ctx = productionGraphContext();
    const snapshot = describeToolAvailability(ctx);
    expect(snapshot.parameters?.graph?.query?.type).toEqual(QUERY_TYPES);
    expect(
      snapshot.unavailable?.filter((entry) => entry.tool === 'graph' && entry.action === 'query')
    ).toEqual([]);

    for (const type of QUERY_TYPES) {
      const result = await handleGraph('query', { type, entity: ENTITY }, ctx);
      expect(result.ok, type).toBe(true);
      expect(result._meta?.fallbackUsed, type).not.toBe(true);
      expect(result._meta?.diagnosticWarnings ?? [], type).toEqual([]);
    }

    const adapter = new ToolRouterAdapter({
      contextFactory: { create: () => ({ ...ctx, tokenBudget: 4000 }) },
    });
    for (const type of QUERY_TYPES) {
      const envelope = await adapter.execute({
        toolId: 'graph',
        args: { action: 'query', params: { type, entity: ENTITY } },
        surface: 'runtime',
        actor: { role: 'agent' },
        source: { kind: 'runtime' },
      });
      expect(envelope.ok, type).toBe(true);
      expect(envelope.diagnostics.fallbackUsed, type).toBe(false);
      expect(envelope.diagnostics.warnings, type).toEqual([]);
    }
  });

  it.each(['overrides', 'extensions'])('rejects the retired %s query type', async (type) => {
    const result = await handleGraph('query', { type, entity: ENTITY }, productionGraphContext());
    expect(result.ok).toBe(false);
    expect(result.error).toBe(`Invalid query type: ${type}. Valid: ${QUERY_TYPES.join(', ')}`);

    // 模型可见 schema 已收窄：经路由的调用在参数校验处被拒，不再到达 handler。
    const envelope = await new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ ...productionGraphContext(), tokenBudget: 4000 }),
      },
    }).execute({
      toolId: 'graph',
      args: { action: 'query', params: { type, entity: ENTITY } },
      surface: 'runtime',
      actor: { role: 'agent' },
      source: { kind: 'runtime' },
    });
    expect(envelope.ok).toBe(false);
  });

  it('keeps graph method names and retired diagnostics out of availability.ts and the graph handler', () => {
    // 两处都只能经共享常量取方法名；手抄任一 query 方法名都会让两份表重新分叉。
    // 'search' 同时是 knowledge 的动作名（availability 合法使用），字面量检查排除它，
    // 改由“不直接访问 ctx.codeEntityGraph”兜住实体图端口的手抄。
    const methods = [...Object.values(EXPECTED_READERS), ...RETIRED_LEGACY_METHODS]
      .map(({ method }) => method)
      .filter((method) => method !== 'search');
    for (const rel of [
      'src/tools/runtime/availability.ts',
      'src/tools/runtime/handlers/graph.ts',
    ]) {
      const source = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      expect(source, rel).toContain('GRAPH_QUERY_HOST_READERS');
      const literals = methods.filter((method) => new RegExp(`['"\`]${method}['"\`]`).test(source));
      expect(literals, rel).toEqual([]);
      expect(source, rel).not.toMatch(/ctx\.codeEntityGraph/);
    }
    // 已删除的诊断码与旧方法名不再以字符串字面量出现（注释里可以记录删除历史），legacy 标记与
    // 留痕函数整体消失。
    for (const rel of [
      'src/tools/runtime/handlers/graph.ts',
      'src/tools/kernel/registry.ts',
      'src/tools/runtime/availability.ts',
    ]) {
      const source = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      const retiredLiterals = [
        'GRAPH_QUERY_LEGACY_READER',
        'GRAPH_QUERY_FALLBACK',
        'overrides',
        'extensions',
        ...RETIRED_LEGACY_METHODS.map(({ method }) => method).filter((m) => m !== 'search'),
      ].filter((name) => new RegExp(`['"\`]${name}['"\`]`).test(source));
      expect(retiredLiterals, rel).toEqual([]);
      expect(source, rel).not.toMatch(/legacyReaderWarnings|\blegacy\??:|\.legacy\b/);
    }
  });
});

describe('Analyst VERIFY graph gate follows the narrowed query types', () => {
  const ctx = {
    loopCtx: { tracker: { pipelineType: 'analyst', phase: 'VERIFY' } },
  } as unknown as Parameters<typeof analystVerifyOnlyGate.before>[1];

  function verdict(type: string) {
    return analystVerifyOnlyGate.before(
      { id: 'verify', name: 'graph', args: { action: 'query', params: { type, entity: ENTITY } } },
      ctx
    );
  }

  it.each(['overrides', 'extensions'])('blocks the retired %s query type', (type) => {
    const result = verdict(type);
    expect(result?.blocked).toBe(true);
    const error = String((result?.result as { error?: unknown } | undefined)?.error ?? '');
    expect(error).toContain('Analyst VERIFY is evidence-only');
    // 阻断文案只推荐收窄后真实存在的 type。
    expect(error).toContain('graph.query(class|protocol|hierarchy|callers|callees|impact');
    expect(error).not.toMatch(/overrides|extensions/);
  });

  it.each(
    QUERY_TYPES.filter((type) => type !== 'search')
  )('still allows a focused %s query', (type) => {
    expect(verdict(type)).toBeUndefined();
  });
});

/**
 * 8be39e6/c64c3de 的失败口径改挂到生产读取器：抛错、拒绝、读取中被取消都带 path=<port>.<method>；
 * 取消先于读取时不归因；拒绝值无法字符串化时文案降级为 [unprintable error value: …] 并另记
 * GRAPH_QUERY_UNPRINTABLE_ERROR。生产读取器不是旧宿主端口，不再有 legacy 痕迹。
 */
describe('graph reader failures keep their path and degraded diagnostics', () => {
  const projectRoot = process.cwd();

  function throwing(message: string): () => never {
    return () => {
      throw new Error(message);
    };
  }

  it.each(
    Object.entries(EXPECTED_READERS).map(([type, reader]) => ({ type, ...reader }))
  )('names the throwing $port.$method reader for $type', async ({ type, port, method }) => {
    const ctx: ToolContext = { projectRoot, [port]: { [method]: throwing('boom') } };
    const result = await handleGraph('query', { type, entity: ENTITY }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(`Graph query(${type}) error: boom (path=${port}.${method})`);
    expect(result._meta?.diagnosticWarnings ?? []).toEqual([]);
    // 普通读取错误不写 resultStatus：仍由 adapter 按 ok 归一（返回时取消信号已触发则归一为 aborted）。
    expect(result._meta?.resultStatus).toBeUndefined();
    expect(result._meta?.fallbackUsed).not.toBe(true);
  });

  it('names the reader when its promise rejects', async () => {
    const ctx: ToolContext = {
      projectRoot,
      projectGraph: { getProtocolInfo: () => Promise.reject(new Error('boom-async')) },
    };
    const result = await handleGraph('query', { type: 'protocol', entity: ENTITY }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      'Graph query(protocol) error: boom-async (path=projectGraph.getProtocolInfo)'
    );
    expect(result._meta?.diagnosticWarnings ?? []).toEqual([]);
  });

  it('returns a primary empty result as no results instead of looking for another reader', async () => {
    const getClassInfo = vi.fn(() => null);
    const queryEntity = vi.fn(() => ({ found: true }));
    const ctx: ToolContext = {
      projectRoot,
      projectGraph: { getClassInfo },
      codeEntityGraph: { queryEntity },
    };
    const result = await handleGraph('query', { type: 'class', entity: ENTITY }, ctx);
    expect(result).toMatchObject({
      ok: true,
      data: { type: 'class', entity: ENTITY, message: 'No results found' },
    });
    expect(getClassInfo).toHaveBeenCalledExactlyOnceWith(ENTITY);
    expect(queryEntity).not.toHaveBeenCalled();
    expect(result._meta?.fallbackUsed).not.toBe(true);
    expect(result._meta?.diagnosticWarnings ?? []).toEqual([]);
  });

  it('names the reader that was in flight when the read was canceled', async () => {
    const controller = new AbortController();
    let finish!: (value: null) => void;
    const pending = new Promise<null>((resolve) => {
      finish = resolve;
    });
    const getCallers = vi.fn(() => {
      // 读取进行中宿主取消：runOperation 先定终态为 aborted，不合作的读取器稍后才结束。
      controller.abort();
      return pending;
    });
    const ctx: ToolContext = {
      projectRoot,
      projectGraph: { getCallers },
      abortSignal: controller.signal,
    };
    const result = await handleGraph('query', { type: 'callers', entity: ENTITY }, ctx);
    finish(null);
    expect(result.ok).toBe(false);
    expect(result._meta?.resultStatus).toBe('aborted');
    expect(result.error).toMatch(/^Graph query\(callers\) aborted: /);
    expect(result.error).toMatch(/ \(path=projectGraph\.getCallers\)$/);
    expect(result._meta?.diagnosticWarnings ?? []).toEqual([]);
  });

  it('adds no path when the cancel arrives before the reader is invoked', async () => {
    const controller = new AbortController();
    controller.abort();
    const getClassInfo = vi.fn(() => ({ via: 'projectGraph.getClassInfo' }));
    const ctx: ToolContext = {
      projectRoot,
      projectGraph: { getClassInfo },
      abortSignal: controller.signal,
    };
    const result = await handleGraph('query', { type: 'class', entity: ENTITY }, ctx);
    expect(result.ok).toBe(false);
    expect(result._meta?.resultStatus).toBe('aborted');
    expect(getClassInfo).not.toHaveBeenCalled();
    // 从未被调用的端口没有可归因的 path，也不留诊断。
    expect(result._meta?.diagnosticWarnings ?? []).toEqual([]);
    expect(result.error).not.toContain('path=');
  });

  // 宿主或测试替身可能以无法字符串化的值拒绝：字符串化本身抛错时，8be39e6 之前的实现会落进 handle()
  // 外层 catch，只剩 'Graph <stage> failed: …'，没有 path。这组拒绝值同时供 query 与 overview 使用。
  function unprintableValues(): Array<{ label: string; make: () => unknown }> {
    return [
      { label: 'a null-prototype object', make: () => Object.create(null) },
      {
        label: 'an Error whose message getter throws',
        make: () => {
          const error = new Error('hidden');
          Object.defineProperty(error, 'message', {
            get() {
              throw new Error('getter');
            },
          });
          return error;
        },
      },
      {
        label: 'an Error whose message getter throws a null-prototype object',
        make: () => {
          const error = new Error('hidden');
          Object.defineProperty(error, 'message', {
            get() {
              throw Object.create(null);
            },
          });
          return error;
        },
      },
      {
        label: 'a revoked Proxy',
        make: () => {
          const { proxy, revoke } = Proxy.revocable({}, {});
          revoke();
          return proxy;
        },
      },
    ];
  }

  const UNPRINTABLE = /\[unprintable error value: [^\]]+\]/;

  function unprintableWarnings(result: ToolResult) {
    return (result._meta?.diagnosticWarnings ?? []).filter(
      (warning) => warning.code === 'GRAPH_QUERY_UNPRINTABLE_ERROR'
    );
  }

  describe('rejection values that cannot be stringified', () => {
    it.each(
      unprintableValues()
    )('keeps path and the degraded diagnostic when the reader rejects with $label', async ({
      make,
    }) => {
      const ctx: ToolContext = {
        projectRoot,
        projectGraph: { getClassInfo: () => Promise.reject(make()) },
      };
      const result = await handleGraph('query', { type: 'class', entity: ENTITY }, ctx);
      expect(result.ok).toBe(false);
      expect(result.error).not.toContain('Graph query failed');
      expect(result.error).toMatch(/^Graph query\(class\) error: /);
      expect(result.error).toMatch(UNPRINTABLE);
      expect(result.error).toMatch(/ \(path=projectGraph\.getClassInfo\)$/);
      expect(result._meta?.resultStatus).toBeUndefined();
      // 降级为占位文案这一分叉只记一条诊断，带出端口、终态与字符串化失败原因。
      const degraded = unprintableWarnings(result);
      expect(result._meta?.diagnosticWarnings).toEqual(degraded);
      expect(degraded).toHaveLength(1);
      expect(degraded[0]).toMatchObject({ tool: 'graph', stage: 'query(class)' });
      expect(degraded[0]?.message).toMatch(
        /^path=projectGraph\.getClassInfo; reason=unprintable-error-value; status=error; stringifyError=.+$/
      );
    });

    it('pins the full text and diagnostics for an impact reader that throws an Error with a throwing message getter', async () => {
      const [, withThrowingGetter] = unprintableValues();
      const ctx: ToolContext = {
        projectRoot,
        codeEntityGraph: {
          impactAnalysis: () => {
            throw withThrowingGetter?.make();
          },
        },
      };
      const result = await handleGraph('query', { type: 'impact', entity: ENTITY }, ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toBe(
        'Graph query(impact) error: [unprintable error value: getter] (path=codeEntityGraph.impactAnalysis)'
      );
      expect(result._meta?.diagnosticWarnings).toEqual([
        {
          code: 'GRAPH_QUERY_UNPRINTABLE_ERROR',
          tool: 'graph',
          stage: 'query(impact)',
          message:
            'path=codeEntityGraph.impactAnalysis; reason=unprintable-error-value; status=error; stringifyError=getter',
        },
      ]);
      expect(result._meta?.fallbackUsed).not.toBe(true);
    });

    it('stringifies an Error whose message is a Symbol instead of escaping to the outer catch', async () => {
      const error = new Error('hidden');
      Object.defineProperty(error, 'message', { value: Symbol('sym-boom') });
      const ctx: ToolContext = {
        projectRoot,
        projectGraph: { getClassHierarchy: () => Promise.reject(error) },
      };
      const result = await handleGraph('query', { type: 'hierarchy', entity: ENTITY }, ctx);
      expect(result.error).toBe(
        'Graph query(hierarchy) error: Symbol(sym-boom) (path=projectGraph.getClassHierarchy)'
      );
      // 能转成文本的值不走降级分支，不记 unprintable 诊断。
      expect(result._meta?.diagnosticWarnings ?? []).toEqual([]);
    });

    it('keeps ordinary Error and string rejections off the unprintable path', async () => {
      for (const rejection of [new Error('boom'), 'str-boom']) {
        const ctx: ToolContext = {
          projectRoot,
          projectGraph: { searchEntities: () => Promise.reject(rejection) },
        };
        const result = await handleGraph('query', { type: 'search', entity: ENTITY }, ctx);
        expect(result.error).toBe(
          `Graph query(search) error: ${rejection instanceof Error ? rejection.message : rejection} (path=projectGraph.searchEntities)`
        );
        expect(result._meta?.diagnosticWarnings ?? []).toEqual([]);
      }
    });

    it('lifts the degraded diagnostic onto the adapter envelope for a null-prototype rejection', async () => {
      const adapter = new ToolRouterAdapter({
        contextFactory: {
          create: () => ({
            projectRoot,
            tokenBudget: 4000,
            projectGraph: { getClassInfo: () => Promise.reject(Object.create(null)) },
          }),
        },
      });
      const envelope = await adapter.execute({
        toolId: 'graph',
        args: { action: 'query', params: { type: 'class', entity: ENTITY } },
        surface: 'runtime',
        actor: { role: 'agent' },
        source: { kind: 'runtime' },
      });
      expect(envelope).toMatchObject({ ok: false, status: 'error' });
      expect(envelope.text).toMatch(UNPRINTABLE);
      expect(envelope.text).toContain('path=projectGraph.getClassInfo');
      expect(envelope.diagnostics.warnings).toEqual([
        expect.objectContaining({
          code: 'GRAPH_QUERY_UNPRINTABLE_ERROR',
          stage: 'query(class)',
        }),
      ]);
    });
  });

  /**
   * graph.overview 与 query 走同一个 readGraph 非 ok 分支（stage='overview'，唯一读取器
   * projectGraph.getOverview）：失败文案为 'Graph overview <status>: <原因> (path=projectGraph.getOverview)'，
   * 降级占位另记 GRAPH_QUERY_UNPRINTABLE_ERROR（stage=overview）。
   */
  describe('graph.overview failure shares the query failure contract', () => {
    function overviewContext(getOverview: () => unknown, abortSignal?: AbortSignal): ToolContext {
      return {
        projectRoot,
        projectGraph: { getOverview },
        ...(abortSignal ? { abortSignal } : {}),
      };
    }

    it.each(
      unprintableValues()
    )('keeps the reader path and degraded diagnostic when getOverview rejects with $label', async ({
      make,
    }) => {
      const result = await handleGraph(
        'overview',
        {},
        overviewContext(() => Promise.reject(make()))
      );
      expect(result.ok).toBe(false);
      expect(result.error).not.toContain('Graph overview failed');
      expect(result.error).toMatch(/^Graph overview error: /);
      expect(result.error).toMatch(UNPRINTABLE);
      expect(result.error).toMatch(/ \(path=projectGraph\.getOverview\)$/);
      const degraded = unprintableWarnings(result);
      expect(result._meta?.diagnosticWarnings).toEqual(degraded);
      expect(degraded).toHaveLength(1);
      expect(degraded[0]).toMatchObject({ tool: 'graph', stage: 'overview' });
      expect(degraded[0]?.message).toMatch(
        /^path=projectGraph\.getOverview; reason=unprintable-error-value; status=error; stringifyError=.+$/
      );
      expect(result._meta?.resultStatus).toBeUndefined();
      expect(result._meta?.fallbackUsed).not.toBe(true);
    });

    it('pins the full overview failure text and diagnostics for a throwing message getter', async () => {
      const [, withThrowingGetter] = unprintableValues();
      const result = await handleGraph(
        'overview',
        {},
        overviewContext(() => {
          throw withThrowingGetter?.make();
        })
      );
      expect(result.error).toBe(
        'Graph overview error: [unprintable error value: getter] (path=projectGraph.getOverview)'
      );
      expect(result._meta?.diagnosticWarnings).toEqual([
        {
          code: 'GRAPH_QUERY_UNPRINTABLE_ERROR',
          tool: 'graph',
          stage: 'overview',
          message:
            'path=projectGraph.getOverview; reason=unprintable-error-value; status=error; stringifyError=getter',
        },
      ]);
    });

    it('keeps ordinary overview failures on the plain path without any diagnostic', async () => {
      for (const rejection of [new Error('boom'), 'str-boom']) {
        const result = await handleGraph(
          'overview',
          {},
          overviewContext(() => Promise.reject(rejection))
        );
        expect(result.error).toBe(
          `Graph overview error: ${rejection instanceof Error ? rejection.message : rejection} (path=projectGraph.getOverview)`
        );
        expect(result._meta?.diagnosticWarnings ?? []).toEqual([]);
      }
    });

    it('names getOverview when the overview read is canceled in flight', async () => {
      const controller = new AbortController();
      let finish!: (value: null) => void;
      const pending = new Promise<null>((resolve) => {
        finish = resolve;
      });
      const result = await handleGraph(
        'overview',
        {},
        overviewContext(() => {
          // 读取进行中宿主取消：runOperation 先定终态为 aborted，不合作的读取器稍后才结束。
          controller.abort();
          return pending;
        }, controller.signal)
      );
      finish(null);
      expect(result.ok).toBe(false);
      expect(result._meta?.resultStatus).toBe('aborted');
      expect(result.error).toMatch(/^Graph overview aborted: /);
      expect(result.error).toMatch(/ \(path=projectGraph\.getOverview\)$/);
      expect(result._meta?.diagnosticWarnings ?? []).toEqual([]);
    });

    it('lifts the overview degraded diagnostic onto the adapter envelope', async () => {
      const adapter = new ToolRouterAdapter({
        contextFactory: {
          create: () => ({
            projectRoot,
            tokenBudget: 4000,
            projectGraph: { getOverview: () => Promise.reject(Object.create(null)) },
          }),
        },
      });
      const envelope = await adapter.execute({
        toolId: 'graph',
        args: { action: 'overview' },
        surface: 'runtime',
        actor: { role: 'agent' },
        source: { kind: 'runtime' },
      });
      expect(envelope).toMatchObject({ ok: false, status: 'error' });
      expect(envelope.text).not.toContain('Graph overview failed');
      expect(envelope.text).toMatch(UNPRINTABLE);
      expect(envelope.text).toContain('path=projectGraph.getOverview');
      expect(envelope.diagnostics.warnings).toEqual([
        expect.objectContaining({
          code: 'GRAPH_QUERY_UNPRINTABLE_ERROR',
          tool: 'graph',
          stage: 'overview',
          message: expect.stringMatching(
            /^path=projectGraph\.getOverview; reason=unprintable-error-value; status=error; /
          ),
        }),
      ]);
    });
  });

  it('keeps a throwing reader on the adapter envelope without fallback or diagnostics', async () => {
    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create: () => ({
          projectRoot,
          tokenBudget: 4000,
          projectGraph: { getCallees: throwing('boom') },
        }),
      },
    });
    const envelope = await adapter.execute({
      toolId: 'graph',
      args: { action: 'query', params: { type: 'callees', entity: ENTITY } },
      surface: 'runtime',
      actor: { role: 'agent' },
      source: { kind: 'runtime' },
    });
    expect(envelope).toMatchObject({ ok: false, status: 'error' });
    expect(envelope.text).toContain('Graph query(callees) error: boom');
    expect(envelope.text).toContain('path=projectGraph.getCallees');
    expect(envelope.diagnostics.fallbackUsed).toBe(false);
    expect(envelope.diagnostics.warnings).toEqual([]);
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

describe('knowledge.prime reads details only through knowledgeRead', () => {
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

  /** 只统计提到 knowledgeRepo 的日志：旧端口相关的痕迹，不受其它日志干扰。 */
  function repoLogs(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('knowledgeRepo'));
  }

  function spyLog(level: 'info' | 'warn') {
    return vi.spyOn(Logger.getInstance(), level).mockImplementation(() => undefined);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses prime on a knowledgeRepo-only host without reading the repository', async () => {
    const info = spyLog('info');
    const warn = spyLog('warn');
    const repo = readPort();
    const engine = searchEngine();
    const ctx: ToolContext = {
      projectRoot: process.cwd(),
      searchEngine: engine,
      knowledgeRepo: repo,
    };
    const result = await handleKnowledge('prime', { taskGoal: 'goal' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      action: 'prime',
      status: 'port-unavailable',
      code: 'KNOWLEDGE_READ_PORT_UNAVAILABLE',
      port: 'knowledgeRead',
      method: 'getById',
    });
    expect(result.error).toBe(
      'Knowledge read port not available for prime (knowledgeRead.getById)'
    );
    expect(repo.getById).not.toHaveBeenCalled();
    expect(engine.search).not.toHaveBeenCalled();
    // 不再走旧端口回落；拒绝原因（knowledgeRepo 不是 prime 的读取端口）单独记 warn 便于宿主排查。
    expect(repoLogs(info)).toEqual([]);
    const refusals = repoLogs(warn);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('[knowledge.prime]');
    expect(refusals[0]).toContain('KNOWLEDGE_READ_PORT_UNAVAILABLE');
  });

  it('does not advertise prime on a knowledgeRepo-only host while detail keeps its fallback', () => {
    const method = vi.fn();
    const snapshot = describeToolAvailability({
      searchEngine: { search: method },
      knowledgeRepo: { getById: method },
      sessionStoreAvailable: true,
    });
    expect(snapshot.actions.knowledge).not.toContain('prime');
    expect(snapshot.unavailable).toEqual(
      expect.arrayContaining([
        {
          tool: 'knowledge',
          action: 'prime',
          reason:
            'knowledge.prime requires all-kind search and knowledgeRead.getById (knowledgeRepo is not accepted)',
        },
      ])
    );
    // detail 的 knowledgeRepo 回落不在本包：仍按旧端口广告。
    expect(snapshot.actions.knowledge).toContain('detail');
    expect(method).not.toHaveBeenCalled();
  });

  it('logs once when detail reads through the legacy knowledgeRepo port', async () => {
    const info = spyLog('info');
    const repo = readPort();
    const ctx: ToolContext = { projectRoot: process.cwd(), knowledgeRepo: repo };
    const result = await handleKnowledge('detail', { id: RECIPE.id }, ctx);
    expect(result.ok).toBe(true);
    expect(repo.getById).toHaveBeenCalledExactlyOnceWith(RECIPE.id);
    const logs = repoLogs(info);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('[knowledge.detail]');
    expect(logs[0]).toContain('deprecated');
    expect(result._meta?.diagnosticWarnings ?? []).toEqual([]);
  });

  it('reads prime and detail through knowledgeRead without any knowledgeRepo log', async () => {
    const info = spyLog('info');
    const warn = spyLog('warn');
    const read = readPort();
    const legacy = readPort();
    const ctx: ToolContext = {
      projectRoot: process.cwd(),
      searchEngine: searchEngine(),
      knowledgeRead: read,
      knowledgeRepo: legacy,
    };
    const prime = await handleKnowledge('prime', { taskGoal: 'goal' }, ctx);
    const detail = await handleKnowledge('detail', { id: RECIPE.id }, ctx);
    expect(prime.ok).toBe(true);
    expect(prime.data).toMatchObject({ knowledge: [{ id: RECIPE.id, doClause: RECIPE.doClause }] });
    expect(detail.ok).toBe(true);
    expect(read.getById).toHaveBeenCalledTimes(2);
    expect(legacy.getById).not.toHaveBeenCalled();
    expect(repoLogs(info)).toEqual([]);
    expect(repoLogs(warn)).toEqual([]);
  });

  it('keeps the search-only fallback on its own diagnostic without a knowledgeRepo log', async () => {
    const info = spyLog('info');
    const ctx: ToolContext = { projectRoot: process.cwd(), searchEngine: searchEngine() };
    const result = await handleKnowledge('prime', { taskGoal: 'goal' }, ctx);
    expect(result.ok).toBe(true);
    expect(result._meta?.diagnosticWarnings?.map((warning) => warning.code)).toEqual([
      'KNOWLEDGE_PRIME_SEARCH_ONLY',
    ]);
    expect(repoLogs(info)).toEqual([]);
  });
});
