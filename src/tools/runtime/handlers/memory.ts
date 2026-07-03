/**
 * @module tools/runtime/handlers/memory
 *
 * Agent 工作记忆 — 跨轮次的发现记录和召回。
 * Actions: save, recall, note_finding, get_previous_evidence
 */

import { DEPTH_DIMENSIONS } from '@alembic/core/knowledge';
import {
  estimateTokens,
  fail,
  type MemoryNoteFindingResult,
  ok,
  type ToolContext,
  type ToolResult,
} from '#tools/kernel/registry.js';

/**
 * P4/C10: 把 note_finding 的可选结构化深度槽(designIntent/boundaries/failureModes/tradeoffs)序列化成
 * `## <label>` markdown 分节，标签取自 Core DEPTH_DIMENSIONS(单源)。深度随 finding 的 evidence 一并进
 * ActiveContext.#scratchpad，Producer 消费 note_finding 时即可见「为何这样设计 / 边界 / 越界会怎样 / 权衡」。
 *
 * 刻意用 `## <label>` 而非自定义标记：这正是 Core `reviewRecipeDepth` 的输入格式，使 in-process 深度 retry
 * 门(C9)能把 findings 的 evidence 直接喂给同一 Core 裁判做接地判定，零自定义解析、与 host 侧字节同源。
 * 仅收非空槽；不做任何补写或校验(接地判定由 Core reviewRecipeDepth 在 gate/retry 侧统一负责)。
 */
function buildDepthBlock(params: Record<string, unknown>): string {
  const sections: string[] = [];
  for (const dim of DEPTH_DIMENSIONS) {
    if (dim.key === 'multiSourceCorroboration') {
      continue;
    }
    const value = params[dim.key];
    if (typeof value === 'string' && value.trim()) {
      sections.push(`## ${dim.label}\n${value.trim()}`);
    }
  }
  return sections.length > 0 ? sections.join('\n') : '';
}

export async function handle(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  switch (action) {
    case 'save':
      return handleSave(params, ctx);
    case 'recall':
      return handleRecall(params, ctx);
    case 'note_finding':
      return handleNoteFinding(params, ctx);
    case 'get_previous_evidence':
      return handleGetPreviousEvidence(params, ctx);
    default:
      return fail(`Unknown memory action: ${action}`);
  }
}

async function handleSave(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const key = params.key as string | undefined;
  const content = params.content as string | undefined;

  if (!key || !content) {
    return fail('memory.save requires key and content');
  }

  const tags = params.tags as string[] | undefined;
  const category = params.category as string | undefined;

  if (!ctx.sessionStore) {
    return fail('Session store not available');
  }

  const meta: Record<string, unknown> = {};
  if (tags) {
    meta.tags = tags;
  }
  if (category) {
    meta.category = category;
  }

  ctx.sessionStore.save(key, content, meta);

  return ok({ saved: key, size: content.length });
}

/**
 * memory action note_finding — 记录结构化关键发现到 ActiveContext.#scratchpad。
 * 桥接 MemoryCoordinator.noteFinding()，使 QualityGate 能通过
 * distill().keyFindings 评估 evidenceScore。
 */
async function handleNoteFinding(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const finding = params.finding as string | undefined;
  if (!finding) {
    return fail('memory action note_finding requires "finding" param');
  }

  // E3（证据保真硬切）：引用契约=台账条目 id 数组（evidenceRefs）。旧 evidence 自由文本被拒——
  // 模型手写 file:line 是真机捏造事故的直接通道（设计 §15.E3；E0 表征钉 1 的反转点）。
  const refsRaw = params.evidenceRefs;
  const refs = Array.isArray(refsRaw)
    ? refsRaw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  if (refs.length === 0) {
    const legacyHint =
      typeof params.evidence === 'string' && params.evidence
        ? '（收到旧版 "evidence" 自由文本参数——该形态已退役）'
        : '';
    return fail(
      `note_finding 需要 "evidenceRefs"：引用工具返回尾部 [evidence] 标注过的台账条目 id（如 ["E-3","E-7@5-12"]）${legacyHint}。手写 file:line 不再被接受。`
    );
  }

  const importance = Math.min(10, Math.max(1, (params.importance as number) || 5));
  const round = (params.round as number) || 0;

  if (!ctx.memoryCoordinator) {
    return fail('memory.note_finding requires an active MemoryCoordinator and ActiveContext');
  }

  // 录入即校验（纯台账查询，零 fs 成本）：任一 ref 无效→整条拒收并附近期真实条目提示，
  // 逼模型在还有 code 工具的阶段修正。台账缺席（非维度场景）降级为不校验直存，降级显式标注。
  const ledger = ctx.runtime?.evidenceLedger;
  let resolvedLabels: string;
  if (ledger) {
    const labels: string[] = [];
    for (const ref of refs) {
      const entry = ledger.get(ref);
      if (!entry) {
        const recent = ledger
          .listRecent(3)
          .map((item) => (item.file ? `${item.id}=${item.file}` : item.id))
          .join('; ');
        return fail(
          `evidenceRefs 无法解析: "${ref}" 不在证据台账（只能引用工具返回里 [evidence] 标注的条目 id）。近期条目: ${recent || '(台账为空——先用 code/graph 工具采集证据)'}`
        );
      }
      labels.push(
        entry.file
          ? entry.range
            ? `${entry.id}=${entry.file}:${entry.range.start}-${entry.range.end}`
            : `${entry.id}=${entry.file}`
          : entry.id
      );
    }
    // evidence 字符串由台账机械展开生成（模型不再手写 file:line）——下游投影零改动即携带准确引用
    resolvedLabels = labels.join('; ');
  } else {
    resolvedLabels = `${refs.join('; ')} (unverified: no evidence ledger in this run)`;
  }

  const excerpt =
    typeof params.excerpt === 'string' && params.excerpt.trim() ? params.excerpt.trim() : '';
  const evidence = excerpt ? `${resolvedLabels} — ${excerpt}` : resolvedLabels;

  // P4/C10: 结构化深度槽并入 evidence，让深度随发现一并进 ActiveContext 并流向 Producer。
  const depthBlock = buildDepthBlock(params);
  const evidenceWithDepth = depthBlock ? `${evidence}\n${depthBlock}` : evidence;

  const scopeId =
    typeof ctx.runtime?.dimensionScopeId === 'string' && ctx.runtime.dimensionScopeId.trim()
      ? ctx.runtime.dimensionScopeId
      : undefined;
  const result = normalizeNoteFindingResult(
    ctx.memoryCoordinator.noteFinding(finding, evidenceWithDepth, importance, round, scopeId, refs),
    importance,
    scopeId
  );

  if (!result.recorded || result.target !== 'activeContext') {
    return fail(result.message);
  }

  return ok(result);
}

function normalizeNoteFindingResult(
  result: MemoryNoteFindingResult | string,
  importance: number,
  scopeId?: string
): MemoryNoteFindingResult {
  if (typeof result !== 'string') {
    return result;
  }
  const recorded = !result.startsWith('⚠');
  return {
    recorded,
    target: recorded ? 'activeContext' : 'error',
    importance,
    message: result,
    ...(scopeId ? { scopeId } : {}),
  };
}

/**
 * memory.get_previous_evidence — 检索前序维度对特定文件/类/模式的分析证据。
 * 桥接 MemoryCoordinator.searchEvidence()，避免跨维度重复搜索。
 */
async function handleGetPreviousEvidence(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const query = params.query as string | undefined;
  if (!query) {
    return fail('memory.get_previous_evidence requires "query" param');
  }
  const dimId = params.dimId as string | undefined;

  if (!ctx.memoryCoordinator?.searchEvidence) {
    return ok({
      count: 0,
      items: [],
      message: `没有找到与 "${query}" 相关的前序证据。建议自行搜索。`,
    });
  }

  const results = ctx.memoryCoordinator.searchEvidence(query, dimId);

  if (results.length === 0) {
    return ok({
      count: 0,
      items: [],
      message: `没有找到与 "${query}" 相关的前序证据。建议自行搜索。`,
    });
  }

  const lines = [`📋 前序维度证据 (匹配 "${query}", ${results.length} 条):`];
  for (const r of results.slice(0, 8)) {
    lines.push(`  📄 ${r.filePath}`);
    lines.push(
      `     [${r.evidence.dimId || '?'}] [${r.evidence.importance || 5}/10] ${r.evidence.finding}`
    );
  }
  if (results.length > 8) {
    lines.push(`  …还有 ${results.length - 8} 条证据`);
  }

  const formatted = lines.join('\n');
  return ok(
    { count: results.length, summary: formatted },
    { tokensEstimate: estimateTokens(formatted) }
  );
}

async function handleRecall(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  if (!ctx.sessionStore) {
    return fail('Session store not available');
  }

  const query = params.query as string | undefined;
  const tags = params.tags as string[] | undefined;
  const limit = (params.limit as number) || 10;

  const results = ctx.sessionStore.recall(query, { tags, limit });

  if (results.length === 0) {
    return ok({ count: 0, items: [], message: 'No memories found' });
  }

  const formatted = results.map((r) => `[${r.key}] ${r.content}`).join('\n\n');
  return ok(
    { count: results.length, items: results },
    { tokensEstimate: estimateTokens(formatted) }
  );
}
