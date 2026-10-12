/** 图谱工具只编排宿主查询；不复制 Core 图算法，不把未接线或未完成读取当成空图。 */
import { runOperation } from '#shared/operation.js';
import {
  estimateTokens,
  fail,
  GRAPH_QUERY_HOST_READERS,
  type GraphQueryType,
  ok,
  type ToolContext,
  type ToolResult,
} from '#tools/kernel/registry.js';

interface GraphRead {
  source: string;
  invoke: () => unknown;
}

/** query type 合法性只认共享读取表的自有键；不在本文件另抄一份类型清单。 */
function isQueryType(value: unknown): value is GraphQueryType {
  return typeof value === 'string' && Object.hasOwn(GRAPH_QUERY_HOST_READERS, value);
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

/**
 * 读取路径、优先级与实参形状全部来自 kernel 的 GRAPH_QUERY_HOST_READERS（availability 共用同一张表）。
 * 表中 legacy 条目是旧宿主兼容入口：照常读取，命中时由 readGraph 记 GRAPH_QUERY_FALLBACK 并带出
 * path=codeEntityGraph.<method>，足以事后核对是否仍有旧宿主；消费者与移除条件（待决事项③）见该常量注释。
 */
function queryReaders(
  type: GraphQueryType,
  entity: string,
  limit: number,
  ctx: ToolContext
): Array<GraphRead | undefined> {
  return GRAPH_QUERY_HOST_READERS[type].map((spec) =>
    reader(spec.port, ctx[spec.port], spec.method, spec.args(entity, limit))
  );
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
    if (!isQueryType(type)) {
      return fail(
        `Invalid query type: ${String(type)}. Valid: ${Object.keys(GRAPH_QUERY_HOST_READERS).join(', ')}`
      );
    }
    const entity = typeof params.entity === 'string' ? params.entity : '';
    if (!entity) {
      return fail(`graph.query(${type}) requires entity`);
    }
    const limit = Math.min((typeof params.limit === 'number' ? params.limit : 20) || 20, 100);
    return await readGraph(
      queryReaders(type, entity, limit, ctx),
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
