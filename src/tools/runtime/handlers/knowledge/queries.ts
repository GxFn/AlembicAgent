/** 知识 search、prime、detail 的只读查询与受限投影。 */
import { runOperation } from '#shared/operation.js';
import { KNOWLEDGE_SEARCH_DEFAULT_KIND, type KnowledgeReadPort } from '#tools/kernel/knowledge.js';
import {
  estimateTokens,
  fail,
  ok,
  type ToolContext,
  type ToolDiagnosticWarning,
  type ToolResult,
} from '#tools/kernel/registry.js';
import type { SearchEngineLike, SearchResult } from './contracts.js';
import { abortedKnowledgeResult } from './operation.js';

function isKnowledgeReadPort(port: unknown): port is KnowledgeReadPort {
  return (
    port !== null &&
    typeof port === 'object' &&
    'getById' in port &&
    typeof port.getById === 'function'
  );
}

function unavailableReadPort(action: string, port: 'knowledgeRead' | 'knowledgeRepo'): ToolResult {
  return {
    ok: false,
    data: {
      action,
      status: 'port-unavailable',
      code: 'KNOWLEDGE_READ_PORT_UNAVAILABLE',
      port,
      method: 'getById',
    },
    error: `Knowledge read port not available for ${action} (${port}.getById)`,
  };
}

function isSearchEngine(port: unknown): port is SearchEngineLike {
  return (
    port !== null &&
    typeof port === 'object' &&
    'search' in port &&
    typeof port.search === 'function'
  );
}

/* ================================================================== */
/*  模型参数归一（search / detail）                                     */
/* ================================================================== */

/** knowledge.search 的 limit 合法区间与缺省值；超出区间夹回，不把非法值透传给宿主端口。 */
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MIN = 1;
const SEARCH_LIMIT_MAX = 50;

/** 参数错误信息里只报告收到的类型，不回显参数值本身（避免把任意模型输出灌进错误文本）。 */
function describeParamType(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }
  return value === null ? 'null' : typeof value;
}

type RequiredTextParam = { ok: true; value: string } | { ok: false; error: string };

/**
 * query / id 这类必填文本参数：缺省或空白按“缺参”报错（沿用原有文案），非字符串按“类型错误”报错。
 * router 的 Ajv 准入已经拒绝非字符串，这里是 handler 自身的防线：直接调用 handler 的宿主或测试替身
 * 不能把数组/数字送进宿主端口。合法值返回 trim 后的文本。
 */
function requiredTextParam(
  value: unknown,
  action: 'knowledge.search' | 'knowledge.detail',
  name: 'query' | 'id'
): RequiredTextParam {
  if (value === undefined || value === null) {
    return { ok: false, error: `${action} requires ${name}` };
  }
  if (typeof value !== 'string') {
    return {
      ok: false,
      error: `${action} ${name} must be a string (received ${describeParamType(value)})`,
    };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: `${action} requires ${name}` };
  }
  return { ok: true, value: trimmed };
}

type OptionalTextParam = { ok: true; value: string | undefined } | { ok: false; error: string };

/**
 * kind / category 这类可选过滤参数：只做类型检查，字符串原样透传（不 trim、不改写取值，
 * 保持宿主既有过滤语义）；undefined/null 视为未提供。
 */
function optionalTextParam(value: unknown, name: 'kind' | 'category'): OptionalTextParam {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return {
      ok: false,
      error: `knowledge.search ${name} must be a string (received ${describeParamType(value)})`,
    };
  }
  return { ok: true, value };
}

/**
 * 把模型给出的 limit 归一到 [1,50] 的整数：未提供用缺省 10；有限数取整后夹回区间；
 * 非数字/NaN/Infinity 回落缺省 10。任何改写都附 KNOWLEDGE_SEARCH_LIMIT_NORMALIZED 诊断，
 * 写明原值类型或取值与生效值，模型据此知道自己的参数被改写；结果本身仍完整，因此不标 degraded。
 */
function normalizeSearchLimit(raw: unknown): {
  limit: number;
  warning?: ToolDiagnosticWarning;
} {
  if (raw === undefined || raw === null) {
    return { limit: SEARCH_LIMIT_DEFAULT };
  }
  const finite = typeof raw === 'number' && Number.isFinite(raw);
  const limit = finite
    ? Math.min(Math.max(Math.floor(raw), SEARCH_LIMIT_MIN), SEARCH_LIMIT_MAX)
    : SEARCH_LIMIT_DEFAULT;
  if (finite && limit === raw) {
    return { limit };
  }
  // 只描述原值的类型/数值，不回显非数字参数的内容。
  const received = finite
    ? String(raw)
    : typeof raw === 'number'
      ? `non-finite number ${String(raw)}`
      : `of type ${describeParamType(raw)}`;
  return {
    limit,
    warning: {
      code: 'KNOWLEDGE_SEARCH_LIMIT_NORMALIZED',
      message: `knowledge.search limit ${received} normalized to ${limit} (allowed integers ${SEARCH_LIMIT_MIN}-${SEARCH_LIMIT_MAX}, default ${SEARCH_LIMIT_DEFAULT})`,
      stage: 'knowledge.search',
      tool: 'knowledge',
    },
  };
}

/* ================================================================== */
/*  knowledge.search                                                   */
/* ================================================================== */

export async function handleSearch(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const queryParam = requiredTextParam(params.query, 'knowledge.search', 'query');
  if (!queryParam.ok) {
    return fail(queryParam.error);
  }
  const query = queryParam.value;

  const kindParam = optionalTextParam(params.kind, 'kind');
  if (!kindParam.ok) {
    return fail(kindParam.error);
  }
  const kind = kindParam.value ?? KNOWLEDGE_SEARCH_DEFAULT_KIND;
  const categoryParam = optionalTextParam(params.category, 'category');
  if (!categoryParam.ok) {
    return fail(categoryParam.error);
  }
  const category = categoryParam.value;
  const { limit, warning: limitWarning } = normalizeSearchLimit(params.limit);

  const engine = ctx.searchEngine;
  if (!isSearchEngine(engine)) {
    return fail('Search engine not available');
  }

  try {
    // 只读端口没有 signal 参数；取消只结束本次等待，迟到结果由 operation 消费。
    const read = await runOperation(() => engine.search(query, { limit, kind, category }), {
      abortSignal: ctx.abortSignal,
    });
    const aborted = abortedKnowledgeResult(ctx, 'search');
    if (aborted) {
      return aborted;
    }
    if (read.status !== 'ok') {
      throw read.error instanceof Error
        ? read.error
        : new Error(String(read.error ?? `Knowledge search ${read.status}`));
    }
    const results = read.value;
    const items = results.map((r: SearchResult) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      score: r.score,
      preview: truncateText(r.content ?? r.description ?? '', 500),
    }));

    const formatted = items
      .map(
        (i: { title: string; score: number; preview: string }) =>
          `[${i.score.toFixed(2)}] ${i.title}\n  ${i.preview}`
      )
      .join('\n\n');

    return ok(
      { count: items.length, items },
      {
        tokensEstimate: estimateTokens(formatted),
        ...(limitWarning ? { diagnosticWarnings: [limitWarning] } : {}),
      }
    );
  } catch (err: unknown) {
    return fail(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ================================================================== */
/*  knowledge.prime — 写码前拉取任务相关既有知识（主体 Agent 的 prime 等价物）  */
/* ================================================================== */

// 闭环审查落地（2026-07-06）：主体 in-process Agent 此前无 prime 等价物——生成前
// "不知道已有什么"是重复提交与漏用既有模式的共同根源。与宿主 MCP alembic_prime
// 的有意分叉：不带宿主 trust receipt 协议/checkpoint 姿态（那是宿主协议面），
// 交付紧凑知识包（title/trigger/do/dont/sources）供 agent 直接消费。
export async function handlePrime(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const taskGoal = typeof params.taskGoal === 'string' ? params.taskGoal.trim() : '';
  if (!taskGoal) {
    return fail('knowledge.prime requires taskGoal');
  }
  const keywords = Array.isArray(params.keywords)
    ? params.keywords.filter((k): k is string => typeof k === 'string' && k.length > 0).slice(0, 8)
    : [];
  const limit = Math.min(Math.max((params.limit as number) || 5, 1), 10);

  const engine = ctx.searchEngine;
  if (!isSearchEngine(engine)) {
    return fail('Search engine not available');
  }
  // knowledgeRead 缺省时回落 knowledgeRepo、两者都缺时 search-only，都是旧宿主兼容入口（已弃用，
  // 待决事项③未答复，暂不删除）。消费者：未注入 knowledgeRead 的旧宿主与测试替身；唯一生产宿主通过
  // knowledgeRead 提供详情、从不注入 knowledgeRepo。移除条件：待决事项③确认单宿主后，prime 强制要求
  // knowledgeRead，缺失时直接返回 KNOWLEDGE_READ_PORT_UNAVAILABLE，删除 knowledgeRepo 回落与 search-only 分支。
  const port = ctx.knowledgeRead !== undefined ? 'knowledgeRead' : 'knowledgeRepo';
  const repo = ctx[port];
  const canRead = isKnowledgeReadPort(repo);
  // 未注入读取能力时保留 search-only prime；已注入但缺方法时不能伪装成可用端口。
  if (!canRead && (port === 'knowledgeRead' || repo != null)) {
    return unavailableReadPort('prime', port);
  }

  try {
    const query = [taskGoal, ...keywords].join(' ');
    const read = await runOperation(() => engine.search(query, { limit: limit * 2, kind: 'all' }), {
      abortSignal: ctx.abortSignal,
    });
    const aborted = abortedKnowledgeResult(ctx, 'prime');
    if (aborted) {
      return aborted;
    }
    if (read.status !== 'ok') {
      throw read.error instanceof Error
        ? read.error
        : new Error(String(read.error ?? `Knowledge prime ${read.status}`));
    }
    const results = read.value;
    const top = results
      .slice()
      .sort((a: SearchResult, b: SearchResult) => b.score - a.score)
      .slice(0, limit);

    const knowledge: Array<Record<string, unknown>> = [];
    const diagnosticWarnings: ToolDiagnosticWarning[] = [];
    if (!canRead) {
      // search-only 回落：宿主既没有 knowledgeRead，也没有 knowledgeRepo（上面已排除“注入了但缺
      // getById”的情形）。结果只剩搜索摘要，没有 trigger/doClause/dontClause/sources，属于能力
      // 降级，必须标 degraded 并给出诊断，不能让模型以为拿到了完整知识包。
      // 消费者：未注入知识读取能力的宿主与测试替身；当前生产宿主通过 knowledgeRead 提供详情。
      // 移除条件：待决事项③确认单宿主并强制要求 knowledgeRead 后，本分支改为直接报端口不可用。
      diagnosticWarnings.push({
        code: 'KNOWLEDGE_PRIME_SEARCH_ONLY',
        message:
          'Knowledge prime ran search-only: no knowledge read port (knowledgeRead/knowledgeRepo.getById) was provided, so results carry search summaries without trigger/doClause/dontClause/sources.',
        stage: 'knowledge.prime',
        tool: 'knowledge',
      });
    }
    for (const hit of top) {
      let detail: Record<string, unknown> | null = null;
      if (canRead) {
        try {
          const detailRead = await runOperation(() => repo.getById(hit.id), {
            abortSignal: ctx.abortSignal,
          });
          if (detailRead.status !== 'ok') {
            throw detailRead.error instanceof Error
              ? detailRead.error
              : new Error(
                  String(detailRead.error ?? `Knowledge prime detail ${detailRead.status}`)
                );
          }
          detail = detailRead.value;
        } catch (err: unknown) {
          detail = null;
          // prime 的详情增强仍可降级到搜索摘要，但能力失败需要可观察，不能静默回落旧仓储。
          diagnosticWarnings.push({
            code: 'KNOWLEDGE_PRIME_DETAIL_UNAVAILABLE',
            message: `Knowledge prime detail ${hit.id} unavailable: ${err instanceof Error ? err.message : String(err)}`,
            stage: 'knowledge.prime',
            tool: 'knowledge',
          });
        }
        const aborted = abortedKnowledgeResult(ctx, 'prime detail');
        if (aborted) {
          return aborted;
        }
      }
      const reasoning =
        detail?.reasoning && typeof detail.reasoning === 'object'
          ? (detail.reasoning as Record<string, unknown>)
          : {};
      const sources = Array.isArray(reasoning.sources)
        ? reasoning.sources.filter((ref): ref is string => typeof ref === 'string').slice(0, 3)
        : [];
      knowledge.push({
        id: hit.id,
        title: hit.title,
        score: Number(hit.score.toFixed(3)),
        ...(detail?.kind ? { kind: detail.kind } : { kind: hit.kind }),
        ...(typeof detail?.trigger === 'string' && detail.trigger
          ? { trigger: detail.trigger }
          : {}),
        ...(typeof detail?.whenClause === 'string' && detail.whenClause
          ? { whenClause: truncateText(detail.whenClause as string, 240) }
          : {}),
        ...(typeof detail?.doClause === 'string' && detail.doClause
          ? { doClause: truncateText(detail.doClause as string, 500) }
          : {}),
        ...(typeof detail?.dontClause === 'string' && detail.dontClause
          ? { dontClause: truncateText(detail.dontClause as string, 500) }
          : {}),
        ...(sources.length > 0 ? { sources } : {}),
      });
    }

    const formatted = knowledge
      .map((k) => `[${k.score}] ${k.title}${k.doClause ? `\n  DO: ${k.doClause}` : ''}`)
      .join('\n');
    return ok(
      {
        count: knowledge.length,
        knowledge,
        guidance: primeGuidance(knowledge),
      },
      {
        tokensEstimate: estimateTokens(formatted),
        ...(diagnosticWarnings.length > 0 ? { degraded: true, diagnosticWarnings } : {}),
      }
    );
  } catch (err: unknown) {
    return fail(`Prime failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * guidance 只承诺结果里真实存在的内容：至少一条知识带 doClause/dontClause 时才要求遵循条款；
 * search-only 回落或详情读取全部失败时只给出标题/分数，文案改为不承诺条款的版本。
 */
function primeGuidance(knowledge: Array<Record<string, unknown>>): string {
  if (knowledge.length === 0) {
    return 'No existing project knowledge matched this task. Proceed from source analysis; new candidates on this topic are likely novel.';
  }
  if (knowledge.some((k) => k.doClause !== undefined || k.dontClause !== undefined)) {
    return 'Existing project knowledge relevant to this task. Follow the doClause/dontClause conventions; cite sources when reusing a pattern; do not re-submit a candidate that duplicates one of these.';
  }
  return 'Existing project knowledge relevant to this task was found, but only titles and relevance scores are available (convention details were not loaded). Verify the conventions against source before reusing a pattern; do not re-submit a candidate that duplicates one of these.';
}

/* ================================================================== */
/*  knowledge.detail                                                   */
/* ================================================================== */

export async function handleDetail(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const idParam = requiredTextParam(params.id, 'knowledge.detail', 'id');
  if (!idParam.ok) {
    return fail(idParam.error);
  }
  const id = idParam.value;

  // undefined 表示旧宿主未迁移；显式空对象/null 是缺能力，不能绕回原始仓储。
  const port = ctx.knowledgeRead !== undefined ? 'knowledgeRead' : 'knowledgeRepo';
  const repo = ctx[port];
  if (!isKnowledgeReadPort(repo)) {
    return unavailableReadPort('detail', port);
  }

  try {
    const read = await runOperation(() => repo.getById(id), { abortSignal: ctx.abortSignal });
    const aborted = abortedKnowledgeResult(ctx, 'detail');
    if (aborted) {
      return aborted;
    }
    if (read.status !== 'ok') {
      throw read.error instanceof Error
        ? read.error
        : new Error(String(read.error ?? `Knowledge detail ${read.status}`));
    }
    const recipe = read.value;
    if (!recipe) {
      return fail(`Recipe not found: ${id}`);
    }

    const text = JSON.stringify(recipe, null, 2);
    return ok(recipe, { tokensEstimate: estimateTokens(text) });
  } catch (err: unknown) {
    return fail(`Detail failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen - 3)}...`;
}
