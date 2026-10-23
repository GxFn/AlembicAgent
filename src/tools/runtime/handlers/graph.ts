/** 图谱工具只编排宿主查询；不复制 Core 图算法，不把未接线或未完成读取当成空图。 */
import { runOperation } from '#shared/operation.js';
import {
  estimateTokens,
  fail,
  GRAPH_QUERY_HOST_READERS,
  type GraphQueryType,
  ok,
  type ToolContext,
  type ToolDiagnosticWarning,
  type ToolResult,
} from '#tools/kernel/registry.js';

interface GraphRead {
  /** <port>.<method>，失败文案的 path 与诊断都用它归因到具体宿主端口。 */
  source: string;
  invoke: () => unknown;
}

/** 一次读取器调用的非 ok 终态，沿用 runOperation 的状态名。 */
type GraphReadFailure = 'error' | 'aborted' | 'timeout';

/**
 * 把读取失败的原因转成纯文本，任何输入都不抛错。宿主或测试替身可能以无法字符串化的值拒绝或抛出：
 * 无原型对象、message getter 会抛错的 Error、已撤销的 Proxy（连 instanceof 都会抛）。字符串化一旦抛错，
 * 异常会越过 path 归因直接落进 handle() 外层 catch，只剩 'Graph <stage> failed: …'，所以这里降级为
 * 占位文案 `[unprintable error value: <字符串化失败原因>]`，并把失败原因单独交给调用方记诊断。
 * 能转成文本的值一律用 String() 收成字符串：原先已能正常出文案的值文案不变；message 为 Symbol 的 Error
 * 原先在拼接文案时抛错，现在得到 `Symbol(...)` 文本。
 */
function describeReadFailure(
  error: unknown,
  status: GraphReadFailure
): { text: string; unprintable?: string } {
  try {
    return { text: error instanceof Error ? String(error.message) : String(error ?? status) };
  } catch (err: unknown) {
    let cause: string;
    try {
      cause = err instanceof Error ? String(err.message) : String(err);
    } catch (nested: unknown) {
      // 字符串化失败的原因本身也无法字符串化（例如 getter 抛出无原型对象）：只给固定标记，不再递归。
      void nested;
      cause = 'unknown';
    }
    return { text: `[unprintable error value: ${cause}]`, unprintable: cause };
  }
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
    ? {
        source: `${source}.${method}`,
        invoke: () => Reflect.apply(operation, target, args),
      }
    : undefined;
}

/**
 * 读取路径与实参形状全部来自 kernel 的 GRAPH_QUERY_HOST_READERS（availability 共用同一张表）。
 * 每个 query type 只有一个生产宿主读取器：它缺失就报端口不可用，返回空就是“没有结果”，不再尝试
 * 备用读取器。旧宿主兼容读取器与对应的回退/旧端口诊断已按待决事项③答复删除（W1-05）。
 */
function queryReader(
  type: GraphQueryType,
  entity: string,
  limit: number,
  ctx: ToolContext
): GraphRead | undefined {
  const spec = GRAPH_QUERY_HOST_READERS[type];
  return reader(spec.port, ctx[spec.port], spec.method, spec.args(entity, limit));
}

async function readGraph(
  read: GraphRead | undefined,
  ctx: ToolContext,
  stage: string,
  project: (value: unknown) => unknown
): Promise<ToolResult> {
  if (!read) {
    return fail(`Graph ${stage} host method is not available`);
  }
  // 是否真的调用了读取器，放在 runOperation 闭包之外：读取器抛错或读取被取消时 outcome 不再携带
  // 闭包返回值，失败分支仍要据此决定是否归因到具体端口。取消先于调用时闭包直接返回，不会进入读取器。
  let invoked = false;
  // 只读端口未必支持底层取消；取消只结束本次等待，迟到结果由 runOperation 消费。
  const outcome = await runOperation(
    async (signal) => {
      if (signal.aborted) {
        return null;
      }
      invoked = true;
      // undefined 与 null 一样表示“宿主没有结果”，统一为 null 交给 project 归一。
      return (await read.invoke()) ?? null;
    },
    { abortSignal: ctx.abortSignal }
  );
  if (outcome.status !== 'ok') {
    // 失败文案带出 path，区分是哪个宿主端口抛错或被取消；取消先于调用时没有可归因的端口，不带 path。
    // path 先于原因文案确定，且原因文案经 describeReadFailure 收口为不抛错的纯文本：拒绝值无法字符串化
    // 时也不会越过归因落进外层 catch。
    const diagnosticWarnings: ToolDiagnosticWarning[] = [];
    const pathSuffix = invoked ? ` (path=${read.source})` : '';
    const reason = describeReadFailure(outcome.error, outcome.status);
    if (reason.unprintable !== undefined) {
      // 降级分叉：原拒绝值无法转成文本，失败文案改用占位。另记 GRAPH_QUERY_UNPRINTABLE_ERROR，走
      // _meta.diagnosticWarnings 通道（adapter 会抬到 envelope 诊断），供事后核对是哪个端口给出了这种值；
      // 只含端口、终态与字符串化失败原因，不含拒绝值本身。
      diagnosticWarnings.push({
        code: 'GRAPH_QUERY_UNPRINTABLE_ERROR',
        tool: 'graph',
        stage,
        message:
          `path=${invoked ? read.source : 'none'}; reason=unprintable-error-value; ` +
          `status=${outcome.status}; stringifyError=${reason.unprintable}`,
      });
    }
    const result = fail(`Graph ${stage} ${outcome.status}: ${reason.text}${pathSuffix}`);
    const interrupted = outcome.status === 'aborted' || outcome.status === 'timeout';
    if (interrupted || diagnosticWarnings.length > 0) {
      result._meta = {
        // 普通读取错误不写 resultStatus：仍由 adapter 按 ok 归一（返回时取消信号已触发则归一为 aborted）。
        ...(interrupted ? { resultStatus: outcome.status } : {}),
        cached: false,
        durationMs: 0,
        tokensEstimate: 0,
        ...(diagnosticWarnings.length > 0 ? { diagnosticWarnings } : {}),
      };
    }
    return result;
  }
  const value = outcome.value;
  // 结构化显示与估算属于 adapter；这里不能为了 stringify 而丢掉已读到的宿主事实。
  return ok(project(value), {
    tokensEstimate: typeof value === 'string' ? estimateTokens(value) : 0,
  });
}

export async function handle(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  try {
    if (action === 'overview') {
      // overview 与 query 共用 readGraph 的非 ok 分支（stage='overview'），失败口径与 query 一致：文案为
      // 'Graph overview <status>: <原因> (path=projectGraph.getOverview)'；拒绝值无法字符串化时降级为占位文案
      // 并另记 GRAPH_QUERY_UNPRINTABLE_ERROR（stage=overview，诊断码沿用 query 前缀，不另起一套）。
      // 守护见 test/tool-runtime-legacy-host-compat.test.ts 的 overview 失败用例。
      return await readGraph(
        reader('projectGraph', ctx.projectGraph, 'getOverview'),
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
    return await readGraph(queryReader(type, entity, limit, ctx), ctx, `query(${type})`, (value) =>
      value == null
        ? { type, entity, message: 'No results found' }
        : { type, entity, result: value }
    );
  } catch (err: unknown) {
    return fail(`Graph ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
