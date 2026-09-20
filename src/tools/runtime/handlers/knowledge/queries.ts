/** 知识 search、prime、detail 的只读查询与受限投影。 */
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
/*  knowledge.search                                                   */
/* ================================================================== */

export async function handleSearch(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const query = params.query as string;
  if (!query) {
    return fail('knowledge.search requires query');
  }

  const kind = (params.kind as string) ?? KNOWLEDGE_SEARCH_DEFAULT_KIND;
  const limit = Math.min((params.limit as number) || 10, 50);
  const category = params.category as string | undefined;

  const engine = ctx.searchEngine;
  if (!isSearchEngine(engine)) {
    return fail('Search engine not available');
  }

  try {
    const results = await engine.search(query, { limit, kind, category });
    const aborted = abortedKnowledgeResult(ctx, 'search');
    if (aborted) {
      return aborted;
    }
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

    return ok({ count: items.length, items }, { tokensEstimate: estimateTokens(formatted) });
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
  const port = ctx.knowledgeRead !== undefined ? 'knowledgeRead' : 'knowledgeRepo';
  const repo = ctx[port];
  const canRead = isKnowledgeReadPort(repo);
  // 未注入读取能力时保留 search-only prime；已注入但缺方法时不能伪装成可用端口。
  if (!canRead && (port === 'knowledgeRead' || repo != null)) {
    return unavailableReadPort('prime', port);
  }

  try {
    const query = [taskGoal, ...keywords].join(' ');
    const results = await engine.search(query, { limit: limit * 2, kind: 'all' });
    const aborted = abortedKnowledgeResult(ctx, 'prime');
    if (aborted) {
      return aborted;
    }
    const top = results
      .slice()
      .sort((a: SearchResult, b: SearchResult) => b.score - a.score)
      .slice(0, limit);

    const knowledge: Array<Record<string, unknown>> = [];
    const diagnosticWarnings: ToolDiagnosticWarning[] = [];
    for (const hit of top) {
      let detail: Record<string, unknown> | null = null;
      if (canRead) {
        try {
          detail = await repo.getById(hit.id);
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
        guidance:
          knowledge.length > 0
            ? 'Existing project knowledge relevant to this task. Follow the doClause/dontClause conventions; cite sources when reusing a pattern; do not re-submit a candidate that duplicates one of these.'
            : 'No existing project knowledge matched this task. Proceed from source analysis; new candidates on this topic are likely novel.',
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

/* ================================================================== */
/*  knowledge.detail                                                   */
/* ================================================================== */

export async function handleDetail(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const id = params.id as string;
  if (!id) {
    return fail('knowledge.detail requires id');
  }

  // undefined 表示旧宿主未迁移；显式空对象/null 是缺能力，不能绕回原始仓储。
  const port = ctx.knowledgeRead !== undefined ? 'knowledgeRead' : 'knowledgeRepo';
  const repo = ctx[port];
  if (!isKnowledgeReadPort(repo)) {
    return unavailableReadPort('detail', port);
  }

  try {
    const recipe = await repo.getById(id);
    const aborted = abortedKnowledgeResult(ctx, 'detail');
    if (aborted) {
      return aborted;
    }
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
