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
  type MemoryCoordinatorLike,
  type MemoryNoteFindingResult,
  ok,
  type ToolContext,
  type ToolDiagnosticWarning,
  type ToolResult,
} from '#tools/kernel/registry.js';
import { classifyUnresolvedEvidenceRef, EVIDENCE_SUBRANGE_COORDINATE_NOTE } from './evidence.js';

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

  // void 端口也可能由异步宿主实现；完成/失败必须在回执之前明确，不竞速已开始的写入。
  await ctx.sessionStore.save(key, content, meta);

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
      `note_finding 需要 "evidenceRefs"：引用工具返回尾部 [evidence] 标注过的台账条目 id（如 ["E-3","E-7@5-12"]；子区间坐标: ${EVIDENCE_SUBRANGE_COORDINATE_NOTE}）${legacyHint}。手写 file:line 不再被接受。`
    );
  }

  const importance = Math.min(10, Math.max(1, (params.importance as number) || 5));
  const round = resolveFindingRound(ctx);

  if (!ctx.memoryCoordinator) {
    return fail('memory.note_finding requires an active MemoryCoordinator and ActiveContext');
  }

  // 录入即校验（纯台账查询，零 fs 成本）：任一 ref 无效→整条拒收并附近期真实条目提示，
  // 逼模型在还有 code 工具的阶段修正。台账缺席（非维度场景）降级为不校验直存：evidence 文本标
  // unverified，结果再带 _meta.degraded + MEMORY_FINDING_UNVERIFIED_NO_LEDGER，运行诊断可定位这类写入。
  const ledger = ctx.runtime?.evidenceLedger;
  let resolvedLabels: string;
  // M3（VERIFY 机械化）：verified=至少一个引用解析到有文件归属（entry.file 在场）的台账条目，
  // 带不带 range 都算——read 条目与 per-file search 条目都可定位、可复核。只引用无文件归属条目
  // （structure/graph/terminal 等无路径采集）的发现是"未核实线索"——配额不计、producer 不作
  // "已确认"渲染；VERIFY 相 nudge 引导 code.read 补采后重记。无台账运行保持 undefined（不参与判定）。
  let verified: boolean | undefined;
  if (ledger) {
    verified = false;
    const labels: string[] = [];
    for (const ref of refs) {
      const entry = ledger.get(ref);
      if (!entry) {
        // I21：基础 id 存在但子区间越界/落在截断尾部时给出可用区间，不再误报为 id 不存在
        const failure = classifyUnresolvedEvidenceRef(ledger, ref, 'memory.note_finding');
        if (failure.detail) {
          return fail(`evidenceRefs ${failure.detail}`);
        }
        const recent = ledger
          .listRecent(3)
          .map((item) => (item.file ? `${item.id}=${item.file}` : item.id))
          .join('; ');
        return fail(
          `evidenceRefs 无法解析: "${ref}" 不在证据台账（只能引用工具返回里 [evidence] 标注的条目 id）。近期条目: ${recent || '(台账为空——先用 code/graph 工具采集证据)'}`
        );
      }
      // 判据见上方 M3 注释。为何不再要求 range（4/0 复盘放宽，2026-07-04）：per-file search 条目
      // 的 content 带行号前缀，P1b 可机械展开精确行；原 file+range 判据在"全 batch read+per-file
      // search"的真实台账上把 findings 全判 unverified，级联 producer 已确认区清零→候选义务归零→全拒。
      if (entry.file) {
        verified = true;
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
    resolvedLabels = verified
      ? labels.join('; ')
      : `${labels.join('; ')} [unverified: 证据均无文件归属——用 code.read 补采关键文件后重记]`;
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

  if (!ledger) {
    // I26/U15-F6：无台账分支已写入但未校验。verified 保持缺省（不参与核实判定、数据形状不变），
    // 降级只走结果诊断：adapter 把它提升到信封 diagnostics，事后按诊断即可定位未校验写入。
    return ok(result, {
      degraded: true,
      diagnosticWarnings: [
        {
          code: 'MEMORY_FINDING_UNVERIFIED_NO_LEDGER',
          message: `No evidence ledger is bound to this run; evidenceRefs [${refs.join(', ')}] were recorded without verification (path=unverified-direct-write; round=${round})`,
          stage: 'memory.note_finding',
          tool: 'memory',
        },
      ],
    });
  }

  // M3：verified 随结果外露——tracker 据此计 verifiedFindingCount（配额只认核实过的发现）
  return ok(verified === undefined ? result : { ...result, verified });
}

/**
 * I26/U15-F7：发现的轮次是运行时事实——AgentRuntime 的 loop iteration 经 runtimeBridge 投影到
 * ctx.runtime.iteration。不再读 schema 未声明、模型可控的 params.round（曾使轮次恒为 0，或被模型编造）。
 * 非 runtime 表面（宿主直调、没有 agent loop）没有轮次，记 0，与 runtimeBridge 对缺省 iteration
 * 取 0 的口径一致；这不是降级，ActiveContext 只用 round 标注发现先后。
 */
function resolveFindingRound(ctx: ToolContext): number {
  const iteration = ctx.runtime?.iteration;
  return typeof iteration === 'number' && Number.isInteger(iteration) && iteration >= 0
    ? iteration
    : 0;
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

const PREVIOUS_EVIDENCE_STAGE = 'memory.get_previous_evidence';

type PreviousEvidenceHit = ReturnType<NonNullable<MemoryCoordinatorLike['searchEvidence']>>[number];

/**
 * memory.get_previous_evidence — 检索前序维度对特定文件/类/模式的分析证据，避免跨维度重复搜索。
 *
 * I26/U15-F5：未接线、存储缺失、检索失败都不能说成“没有前序证据”（与 graph handler“未接线不当成空”
 * 同一原则）。分叉：
 * - 协调器缺失或不提供任何检索方法 → ok + degraded + MEMORY_EVIDENCE_COORDINATOR_MISSING；
 * - 协调器提供 searchEvidenceWithDiagnostics（Agent MemoryCoordinator 已实现）→ 优先调用，降级时
 *   ok + degraded + 原诊断码（MEMORY_EVIDENCE_STORE_MISSING / MEMORY_EVIDENCE_SEARCH_FAILED）；
 * - 只提供旧 searchEvidence 的宿主/替身 → 原行为（它无法区分“空”与“降级”，不臆造诊断）。
 * 降级仍返回 ok：前序证据只是省一次搜索的捷径，模型应继续自行搜索，而不是把本轮当作工具错误。
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
  const coordinator = ctx.memoryCoordinator;

  if (coordinator && typeof coordinator.searchEvidenceWithDiagnostics === 'function') {
    const search = normalizeEvidenceSearch(
      coordinator.searchEvidenceWithDiagnostics(query, dimId),
      query,
      dimId
    );
    if (search.warnings.length === 0) {
      return formatPreviousEvidence(query, search.results);
    }
    if (search.results.length > 0) {
      // 部分结果：宿主实现可能在降级时仍带回命中，命中照常给出，降级只走诊断。
      return formatPreviousEvidence(query, search.results, search.warnings);
    }
    return degradedPreviousEvidence(search.message, search.warnings);
  }

  if (coordinator && typeof coordinator.searchEvidence === 'function') {
    return formatPreviousEvidence(query, coordinator.searchEvidence(query, dimId));
  }

  const detail = coordinator
    ? 'MemoryCoordinator exposes neither searchEvidenceWithDiagnostics nor searchEvidence'
    : 'No MemoryCoordinator is bound to this tool call';
  return degradedPreviousEvidence(
    `本次运行没有接入前序证据检索（记忆协调器未接线），无法确认是否存在与 "${query}" 相关的前序证据——这不代表前序维度没有相关证据。建议自行搜索。`,
    [evidenceWarning('MEMORY_EVIDENCE_COORDINATOR_MISSING', detail, query, dimId)]
  );
}

/** 把 searchEvidenceWithDiagnostics 的宿主返回值归一成命中 + 诊断；形状不合法按检索失败处理。 */
function normalizeEvidenceSearch(
  raw: unknown,
  query: string,
  dimId: string | undefined
): { results: PreviousEvidenceHit[]; warnings: ToolDiagnosticWarning[]; message: string } {
  const failedMessage = `前序证据检索失败，无法确认是否存在与 "${query}" 相关的前序证据——这不代表前序维度没有相关证据。建议自行搜索。`;
  if (!isRecord(raw) || !Array.isArray(raw.results)) {
    return {
      results: [],
      warnings: [
        evidenceWarning(
          'MEMORY_EVIDENCE_SEARCH_FAILED',
          'searchEvidenceWithDiagnostics returned a malformed result (expected { results: [] })',
          query,
          dimId
        ),
      ],
      message: failedMessage,
    };
  }
  // 命中条目沿用端口类型契约（与旧 searchEvidence 路径同等信任），这里只归一外层形状与降级信号。
  const results = raw.results as PreviousEvidenceHit[];
  const failed = raw.ok === false;
  if (!failed && raw.degraded !== true) {
    return { results, warnings: [], message: '' };
  }

  const warnings: ToolDiagnosticWarning[] = [];
  for (const item of Array.isArray(raw.diagnostics) ? raw.diagnostics : []) {
    if (isRecord(item) && typeof item.code === 'string' && item.code) {
      const message = typeof item.message === 'string' ? item.message : '';
      warnings.push(evidenceWarning(item.code, message, query, dimId));
    }
  }
  if (warnings.length === 0) {
    // 宿主只给了降级标志、没带诊断：按 reason/ok 补一个稳定码，不让降级在结果上隐身。
    const code =
      !failed && raw.reason === 'session-store-missing'
        ? 'MEMORY_EVIDENCE_STORE_MISSING'
        : 'MEMORY_EVIDENCE_SEARCH_FAILED';
    const reason = typeof raw.reason === 'string' ? raw.reason : 'unspecified';
    warnings.push(
      evidenceWarning(
        code,
        `searchEvidenceWithDiagnostics reported a degraded search without diagnostics (reason=${reason})`,
        query,
        dimId
      )
    );
  }

  const storeMissing =
    !failed && warnings.some((warning) => warning.code === 'MEMORY_EVIDENCE_STORE_MISSING');
  return {
    results,
    warnings,
    message: storeMissing
      ? `本次运行没有前序证据存储（SessionStore 未接入），无法检索与 "${query}" 相关的前序证据——这不代表前序维度没有相关证据。建议自行搜索。`
      : failedMessage,
  };
}

function evidenceWarning(
  code: string,
  message: string,
  query: string,
  dimId: string | undefined
): ToolDiagnosticWarning {
  // 诊断里带上关键输入，事后能看出哪次检索、按哪个维度过滤时降级。
  return {
    code,
    message: `${message} (query="${query}"; dimId=${dimId ?? '*'})`,
    stage: PREVIOUS_EVIDENCE_STAGE,
    tool: 'memory',
  };
}

function degradedPreviousEvidence(message: string, warnings: ToolDiagnosticWarning[]): ToolResult {
  return ok({ count: 0, items: [], message }, { degraded: true, diagnosticWarnings: warnings });
}

function formatPreviousEvidence(
  query: string,
  results: PreviousEvidenceHit[],
  warnings: ToolDiagnosticWarning[] = []
): ToolResult {
  const degradedMeta = warnings.length > 0 ? { degraded: true, diagnosticWarnings: warnings } : {};
  if (results.length === 0) {
    return ok(
      {
        count: 0,
        items: [],
        message: `没有找到与 "${query}" 相关的前序证据。建议自行搜索。`,
      },
      degradedMeta
    );
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
  if (warnings.length > 0) {
    lines.push('  ⚠ 前序证据检索处于降级状态，以上结果可能不完整');
  }

  const formatted = lines.join('\n');
  return ok(
    { count: results.length, summary: formatted },
    { tokensEstimate: estimateTokens(formatted), ...degradedMeta }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
