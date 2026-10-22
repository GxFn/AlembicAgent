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
  source: string;
  /**
   * 来自 GRAPH_QUERY_HOST_READERS 的 legacy 标注：被实际调用即记 GRAPH_QUERY_LEGACY_READER，
   * 返回值、返回空、抛错（含以无法字符串化的值拒绝）、读取中被取消都留痕（见 legacyReaderWarnings）。
   */
  legacy: boolean;
  invoke: () => unknown;
}

/** 一次读取器调用的终态：成功路径为 value/empty，非 ok 路径沿用 runOperation 的状态名。 */
type GraphReadResult = 'value' | 'empty' | 'error' | 'aborted' | 'timeout';

/**
 * legacy 读取器被实际调用即留痕，不论本次调用以值、空、抛错还是取消收场：待决事项③要核对的是
 * “旧端口仍被接线并调用”这一事实，只在成功路径留痕会让抛错的调用不可归因。只看最后一次实际调用的
 * 读取器；非 legacy 读取器不记。result 写明终态，供事后区分旧端口是正常服务还是已经失效。
 */
function legacyReaderWarnings(
  hit: GraphRead | undefined,
  stage: string,
  result: GraphReadResult
): ToolDiagnosticWarning[] {
  if (!hit?.legacy) {
    return [];
  }
  return [
    {
      code: 'GRAPH_QUERY_LEGACY_READER',
      tool: 'graph',
      stage,
      message: `path=${hit.source}; reason=legacy-host-port; result=${result}`,
    },
  ];
}

/**
 * 把读取失败的原因转成纯文本，任何输入都不抛错。宿主或测试替身可能以无法字符串化的值拒绝或抛出：
 * 无原型对象、message getter 会抛错的 Error、已撤销的 Proxy（连 instanceof 都会抛）。字符串化一旦抛错，
 * 异常会越过留痕直接落进 handle() 外层 catch，path 与 GRAPH_QUERY_LEGACY_READER 全部丢失，所以这里
 * 降级为占位文案 `[unprintable error value: <字符串化失败原因>]`，并把失败原因单独交给调用方记诊断。
 * 能转成文本的值一律用 String() 收成字符串：原先已能正常出文案的值文案不变；message 为 Symbol 的 Error
 * 原先在拼接文案时抛错，现在得到 `Symbol(...)` 文本。
 */
function describeReadFailure(
  error: unknown,
  status: Exclude<GraphReadResult, 'value' | 'empty'>
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
  args: unknown[] = [],
  legacy = false
): GraphRead | undefined {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
    return undefined;
  }
  const operation: unknown = (target as Record<string, unknown>)[method];
  return typeof operation === 'function'
    ? {
        source: `${source}.${method}`,
        legacy,
        invoke: () => Reflect.apply(operation, target, args),
      }
    : undefined;
}

/**
 * 读取路径、优先级与实参形状全部来自 kernel 的 GRAPH_QUERY_HOST_READERS（availability 共用同一张表）。
 * 表中 legacy 条目是旧宿主兼容入口：照常读取，被实际调用时 readGraph 一律记 GRAPH_QUERY_LEGACY_READER 并带出
 * path=<port>.<method>（overrides/extensions 的唯一读取器位于下标 0，同样留痕；抛错或读取中被取消的调用
 * 也留痕），足以事后核对是否仍有旧宿主；只有成功读取的命中读取器下标大于 0 时才额外记 GRAPH_QUERY_FALLBACK。
 * 消费者与移除条件（待决事项③）见该常量注释。
 */
function queryReaders(
  type: GraphQueryType,
  entity: string,
  limit: number,
  ctx: ToolContext
): Array<GraphRead | undefined> {
  return GRAPH_QUERY_HOST_READERS[type].map((spec) =>
    reader(spec.port, ctx[spec.port], spec.method, spec.args(entity, limit), spec.legacy === true)
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
  // 最后一次实际调用的读取器下标，放在 runOperation 闭包之外：读取器抛错或读取被取消时 outcome 不再携带
  // 闭包返回值，失败分支仍要据此归因到具体端口并给 legacy 读取器留痕。循环先查信号再调用读取器，取消后不会
  // 再进入新的读取器，所以 outcome 结束后它不会再变。
  let invoked: number | undefined;
  // 只读端口未必支持底层取消；只结束等待，并在进入备用端口前重查信号。
  const outcome = await runOperation(
    async (signal) => {
      for (const [index, read] of readers.entries()) {
        if (signal.aborted) {
          return null;
        }
        if (!read) {
          continue;
        }
        invoked = index;
        const value = await read.invoke();
        if (value !== undefined && value !== null) {
          return value;
        }
      }
      return null;
    },
    { abortSignal: ctx.abortSignal }
  );
  // 尚未调用任何读取器（取消先于首次读取）时不归因，避免给从未被调用的 legacy 端口留假痕迹。
  const hit = invoked === undefined ? undefined : readers[invoked];
  if (outcome.status !== 'ok') {
    // 抛错/取消同样是“旧端口被接线并调用”的事实：文案带出 path 以区分主读取器与旧端口抛错，legacy 读取器
    // 照常记 GRAPH_QUERY_LEGACY_READER（result=<status>）。GRAPH_QUERY_FALLBACK/fallbackUsed 只描述
    // “结果经备用路径得到”，没有结果时不记，语义保持不变。留痕与 path 先于原因文案生成，且原因文案经
    // describeReadFailure 收口为不抛错的纯文本：拒绝值无法字符串化时也不会越过留痕落进外层 catch。
    const diagnosticWarnings = legacyReaderWarnings(hit, stage, outcome.status);
    const pathSuffix = hit ? ` (path=${hit.source})` : '';
    const reason = describeReadFailure(outcome.error, outcome.status);
    if (reason.unprintable !== undefined) {
      // 降级分叉：原拒绝值无法转成文本，失败文案改用占位。另记 GRAPH_QUERY_UNPRINTABLE_ERROR，走与 legacy
      // 痕迹相同的 _meta.diagnosticWarnings 通道（adapter 会抬到 envelope 诊断），供事后核对是哪个端口给出了
      // 这种值；只含端口、终态与字符串化失败原因，不含拒绝值本身。它与是否 legacy 无关，非 legacy 读取器同样记。
      diagnosticWarnings.push({
        code: 'GRAPH_QUERY_UNPRINTABLE_ERROR',
        tool: 'graph',
        stage,
        message:
          `path=${hit?.source ?? 'none'}; reason=unprintable-error-value; ` +
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
  // 成功路径至少调用过一个读取器（取消先于首次读取时 runOperation 不会以 ok 结束）；?? 0 只为类型收口。
  const selected = invoked ?? 0;
  // fallbackUsed 只表示“越过了主读取器”（下标 > 0），与是否 legacy 无关，语义保持不变。
  const fallbackUsed = selected > 0;
  const diagnosticWarnings: ToolDiagnosticWarning[] = [];
  if (fallbackUsed) {
    diagnosticWarnings.push({
      code: 'GRAPH_QUERY_FALLBACK',
      tool: 'graph',
      stage,
      message: `path=${hit?.source}; reason=${readers[0] ? 'primary-returned-no-result' : 'primary-unavailable'}`,
    });
  }
  // 旧宿主兼容读取器被实际调用（无论处在主位还是备用位）：单独留痕，供待决事项③核对旧宿主是否仍在。
  // 它返回空时也记录，因为“旧端口仍被接线并调用”本身就是要核对的事实。
  diagnosticWarnings.push(...legacyReaderWarnings(hit, stage, value === null ? 'empty' : 'value'));
  return ok(project(value), {
    // 结构化显示与估算属于 adapter；这里不能为了 stringify 而丢掉已读到的宿主事实。
    tokensEstimate: typeof value === 'string' ? estimateTokens(value) : 0,
    fallbackUsed,
    ...(diagnosticWarnings.length > 0 ? { diagnosticWarnings } : {}),
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
