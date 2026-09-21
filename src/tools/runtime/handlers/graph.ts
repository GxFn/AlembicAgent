/** 图谱工具只编排宿主查询；不复制 Core 图算法，不把未接线或未完成读取当成空图。 */
import { runOperation } from '#shared/operation.js';
import {
  estimateTokens,
  fail,
  ok,
  type ToolContext,
  type ToolResult,
} from '#tools/kernel/registry.js';

type QueryType =
  | 'class'
  | 'protocol'
  | 'hierarchy'
  | 'callers'
  | 'callees'
  | 'overrides'
  | 'extensions'
  | 'impact'
  | 'search';
const QUERY_TYPES = new Set<QueryType>([
  'class',
  'protocol',
  'hierarchy',
  'callers',
  'callees',
  'overrides',
  'extensions',
  'impact',
  'search',
]);
interface GraphRead {
  source: string;
  invoke: () => unknown;
}

/** 校验方法而不试调用；保留实例 this，兼容同步 Core 图谱与异步宿主端口。 */
function reader(
  source: string,
  target: unknown,
  method: string,
  args: unknown[] = []
): GraphRead | undefined {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
    return undefined;
  }
  const operation: unknown = (target as Record<string, unknown>)[method];
  return typeof operation === 'function'
    ? { source: `${source}.${method}`, invoke: () => Reflect.apply(operation, target, args) }
    : undefined;
}

function queryReaders(
  type: QueryType,
  entity: string,
  limit: number,
  ctx: ToolContext
): Array<GraphRead | undefined> {
  const project = (method: string, args: unknown[] = [entity]) =>
    reader('projectGraph', ctx.projectGraph, method, args);
  const entities = (method: string, args: unknown[]) =>
    reader('codeEntityGraph', ctx.codeEntityGraph, method, args);
  switch (type) {
    case 'class':
      return [project('getClassInfo'), entities('queryEntity', [entity, 'class'])];
    case 'protocol':
      return [project('getProtocolInfo')];
    case 'hierarchy':
      return [project('getClassHierarchy')];
    case 'callers':
      return [
        project('getCallers', [entity, limit]),
        entities('queryCallGraph', [entity, 'callers', limit]),
      ];
    case 'callees':
      return [
        project('getCallees', [entity, limit]),
        entities('queryCallGraph', [entity, 'callees', limit]),
      ];
    case 'overrides':
      return [project('getMethodOverrides')];
    case 'extensions':
      return [project('getCategoryMap')];
    case 'impact':
      return [entities('impactAnalysis', [entity, limit])];
    case 'search':
      return [entities('search', [entity, limit]), project('searchEntities', [entity, limit])];
  }
}

async function readGraph(
  readers: Array<GraphRead | undefined>,
  ctx: ToolContext,
  stage: string,
  project: (value: unknown) => unknown
): Promise<ToolResult> {
  if (!readers.some(Boolean)) {
    return fail(`Graph ${stage} host method is not available`);
  }
  // 只读端口未必支持底层取消；只结束等待，并在进入备用端口前重查信号。
  const outcome = await runOperation(
    async (signal) => {
      let selected = 0;
      for (const [index, read] of readers.entries()) {
        if (signal.aborted) {
          return { value: null, selected };
        }
        if (!read) {
          continue;
        }
        selected = index;
        const value = await read.invoke();
        if (value !== undefined && value !== null) {
          return { value, selected };
        }
      }
      return { value: null, selected };
    },
    { abortSignal: ctx.abortSignal }
  );
  if (outcome.status !== 'ok') {
    const reason =
      outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error ?? outcome.status);
    const result = fail(`Graph ${stage} ${outcome.status}: ${reason}`);
    if (outcome.status === 'aborted' || outcome.status === 'timeout') {
      result._meta = {
        resultStatus: outcome.status,
        cached: false,
        durationMs: 0,
        tokensEstimate: 0,
      };
    }
    return result;
  }
  const { value, selected } = outcome.value;
  const fallbackUsed = selected > 0;
  return ok(project(value), {
    // 结构化显示与估算属于 adapter；这里不能为了 stringify 而丢掉已读到的宿主事实。
    tokensEstimate: typeof value === 'string' ? estimateTokens(value) : 0,
    fallbackUsed,
    ...(fallbackUsed
      ? {
          diagnosticWarnings: [
            {
              code: 'GRAPH_QUERY_FALLBACK',
              tool: 'graph',
              stage,
              message: `path=${readers[selected]?.source}; reason=${readers[0] ? 'primary-returned-no-result' : 'primary-unavailable'}`,
            },
          ],
        }
      : {}),
  });
}

export async function handle(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  try {
    if (action === 'overview') {
      return await readGraph(
        [reader('projectGraph', ctx.projectGraph, 'getOverview')],
        ctx,
        action,
        (value) => {
          if (value == null) {
            return { message: 'Project graph is empty or not built yet' };
          }
          if (typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Invalid graph overview result: expected an object');
          }
          // Core/宿主给出的统计字段是事实；不再丢弃 totalClasses 等字段或补造零计数。
          return value;
        }
      );
    }
    if (action !== 'query') {
      return fail(`Unknown graph action: ${action}`);
    }
    const type = params.type;
    if (typeof type !== 'string' || !QUERY_TYPES.has(type as QueryType)) {
      return fail(`Invalid query type: ${String(type)}. Valid: ${[...QUERY_TYPES].join(', ')}`);
    }
    const entity = typeof params.entity === 'string' ? params.entity : '';
    if (!entity) {
      return fail(`graph.query(${type}) requires entity`);
    }
    const limit = Math.min((typeof params.limit === 'number' ? params.limit : 20) || 20, 100);
    return await readGraph(
      queryReaders(type as QueryType, entity, limit, ctx),
      ctx,
      `query(${type})`,
      (value) =>
        value == null
          ? { type, entity, message: 'No results found' }
          : { type, entity, result: value }
    );
  } catch (err: unknown) {
    return fail(`Graph ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
