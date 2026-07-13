/**
 * @module tools/runtime/handlers/knowledge
 *
 * 知识管理工具 — Agent 与 Alembic 知识库交互的统一入口。
 * Actions: search, submit, detail, manage
 *
 * 后端: SearchEngine (BM25 + 向量), RecipeProductionGateway, KnowledgeRepository
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RecipeProductionPort } from '@alembic/core';
import { dimensionTags } from '@alembic/core/dimensions';
import {
  applyStyleWaiver,
  getImperativeVerbAllowlist,
  getSystemInjectedFields,
  isSoftAuthoringViolation,
  STYLE_WAIVER_SESSION_LIMIT,
} from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import {
  estimateTokens,
  fail,
  ok,
  type ToolContext,
  type ToolResult,
} from '#tools/kernel/registry.js';
import {
  formatRecipeAuthoringViolations,
  runInProcessRecipeAuthoringGate,
} from './recipeAuthoringGate.js';
import { prepareRecipeProductionItem } from './recipeProductionAdapter.js';
import {
  buildEvidenceCandidatesHint,
  buildViolationRepairTemplates,
  expandEvidenceRefsForSubmit,
  inferEvidenceRefsFromSources,
  isStyleRepairable,
  repairStyleViolations,
  sanitizeSubmissionEvidence,
} from './submitEvidenceExpansion.js';

const AGENT_RUNTIME_SOURCE = 'alembic-agent';
const LEGACY_IDE_AGENT_SOURCE = 'ide-agent';

// C-6(2026-07-02 统一重构)：软硬分级与 waiver 判定下沉 Core styleWaiver 单源——
// 宿主 alembic_submit_knowledge evidence gate 与本 handler 共用同一分级表与申辩语义。
// 本文件仅保留 re-export 供既有测试/消费方引用。
export { applyStyleWaiver, isSoftAuthoringViolation };

/** F4b 反馈里附带的已声明 bounded range 行数上限。只提示，不改写候选。 */
const SNIPPET_REPAIR_MAX_LINES = 12;

/**
 * 严格读取 sourceRefs 中第一个可解析的真实行范围。越界不 clamp、裸路径不猜范围；
 * 仅用于拒绝提示，production adapter 另行决定 coreCode 是否可保留。
 */
function readRefRangeCode(
  sourceRefs: unknown,
  projectRoot: string | undefined
): {
  code: string;
  refText: string;
} | null {
  if (!projectRoot || !Array.isArray(sourceRefs)) {
    return null;
  }
  for (const ref of sourceRefs) {
    if (typeof ref !== 'string') {
      continue;
    }
    const m = ref.match(/^(.+?):(\d+)(?:-(\d+))?$/);
    if (!m?.[1]) {
      continue;
    }
    try {
      const normalized = path.posix.normalize(m[1].replaceAll('\\', '/'));
      if (path.isAbsolute(normalized) || normalized.startsWith('..')) {
        continue;
      }
      const absPath = path.join(projectRoot, normalized);
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        continue;
      }
      const lines = fs.readFileSync(absPath, 'utf-8').split('\n');
      const rawStart = Number(m[2]);
      if (!Number.isFinite(rawStart) || rawStart < 1) {
        continue;
      }
      if (rawStart > lines.length) {
        continue;
      }
      const start = rawStart;
      const requestedEnd = m[3] ? Number(m[3]) : start + SNIPPET_REPAIR_MAX_LINES - 1;
      if (!Number.isFinite(requestedEnd) || requestedEnd < start || requestedEnd > lines.length) {
        continue;
      }
      const end = Math.min(requestedEnd, start + SNIPPET_REPAIR_MAX_LINES - 1);
      const code = lines.slice(start - 1, end).join('\n');
      if (!code.trim()) {
        continue;
      }
      return {
        code,
        refText: `${normalized}:${start}-${end}`,
      };
    } catch {
      // 只读失败换下一个 ref：宁缺毋错。
    }
  }
  return null;
}

/**
 * F4f：裸路径 sourceRefs（无 `:行号`）用 Analyst 接地范围规范化为 `path:start-end`。
 * 范围投影经 sharedState._analystGroundedRanges 注入（insightGateEvaluator 写入），来自
 * evidenceMap 真实片段——裸路径候选由此获得 F4b/F4d 可用的行号锚，非任意指派。
 */
function normalizeBareSourceRefs(
  item: Record<string, unknown>,
  sharedState: Record<string, unknown> | null
): Record<string, unknown> {
  const ranges = sharedState?._analystGroundedRanges as
    | Record<string, Array<{ start: number; end: number }>>
    | undefined;
  if (!Array.isArray(item.sourceRefs)) {
    return item;
  }
  let changed = false;
  const normalizeRef = (ref: unknown): unknown => {
    if (typeof ref !== 'string' || /:\d+/.test(ref)) {
      return ref;
    }
    const filePath = path.posix.normalize(ref.replaceAll('\\', '/'));
    const fileRanges = ranges?.[filePath];
    if (fileRanges?.[0]) {
      changed = true;
      return `${filePath}:${fileRanges[0].start}-${fileRanges[0].end}`;
    }
    return ref;
  };
  const sourceRefs = (item.sourceRefs as unknown[]).map(normalizeRef);
  const reasoning = (item.reasoning ?? {}) as Record<string, unknown>;
  const sources = Array.isArray(reasoning.sources)
    ? (reasoning.sources as unknown[]).map(normalizeRef)
    : reasoning.sources;
  if (!changed) {
    return item;
  }
  Logger.getInstance().info(
    `[knowledge.submit] bare source refs normalized from analyst grounded ranges for "${String(item.title ?? '')}"`
  );
  return { ...item, sourceRefs, reasoning: { ...reasoning, sources } };
}

/**
 * F4b：代码/引用门禁拒绝时，读取第一个可解析 sourceRef 的真实 bounded range 作为诊断提示。
 * 该提示不会修改候选，也不把首个来源或整文件视为 coreCode 答案；失败时静默返回空串。
 */
function buildSnippetRepairHint(sourceRefs: unknown, projectRoot: string | undefined): string {
  const range = readRefRangeCode(sourceRefs, projectRoot);
  if (!range) {
    return '';
  }
  return ` 📎 修复提示：引用范围 ${range.refText} 的真实代码如下。仅当它确实是本候选需要表达的 bounded snippet 时，才逐字重提 coreCode；不得把首个来源或整文件当作自动答案。markdown 特写正文与模板代码保持你自己的提炼创作：\n${range.code}`;
}

export async function handle(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  switch (action) {
    case 'search':
      return handleSearch(params, ctx);
    case 'prime':
      return handlePrime(params, ctx);
    case 'submit':
      return handleSubmit(params, ctx);
    case 'detail':
      return handleDetail(params, ctx);
    case 'manage':
      return handleManage(params, ctx);
    default:
      return fail(`Unknown knowledge action: ${action}`);
  }
}

/* ================================================================== */
/*  knowledge.search                                                   */
/* ================================================================== */

async function handleSearch(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const query = params.query as string;
  if (!query) {
    return fail('knowledge.search requires query');
  }

  const kind = (params.kind as string) ?? 'all';
  const limit = Math.min((params.limit as number) || 10, 50);
  const category = params.category as string | undefined;

  const engine = ctx.searchEngine as SearchEngineLike | undefined;
  if (!engine) {
    return fail('Search engine not available');
  }

  try {
    const results = await engine.search(query, { limit, kind, category });
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
async function handlePrime(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const taskGoal = typeof params.taskGoal === 'string' ? params.taskGoal.trim() : '';
  if (!taskGoal) {
    return fail('knowledge.prime requires taskGoal');
  }
  const keywords = Array.isArray(params.keywords)
    ? params.keywords.filter((k): k is string => typeof k === 'string' && k.length > 0).slice(0, 8)
    : [];
  const limit = Math.min(Math.max((params.limit as number) || 5, 1), 10);

  const engine = ctx.searchEngine as SearchEngineLike | undefined;
  const repo = ctx.knowledgeRepo as KnowledgeRepoLike | undefined;
  if (!engine) {
    return fail('Search engine not available');
  }

  try {
    const query = [taskGoal, ...keywords].join(' ');
    const results = await engine.search(query, { limit: limit * 2, kind: 'all' });
    const top = results
      .slice()
      .sort((a: SearchResult, b: SearchResult) => b.score - a.score)
      .slice(0, limit);

    const knowledge: Array<Record<string, unknown>> = [];
    for (const hit of top) {
      let detail: Record<string, unknown> | null = null;
      if (repo) {
        try {
          detail = (await repo.getById(hit.id)) as Record<string, unknown> | null;
        } catch {
          detail = null;
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
      { tokensEstimate: estimateTokens(formatted) }
    );
  } catch (err: unknown) {
    return fail(`Prime failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ================================================================== */
/*  knowledge.submit                                                   */
/* ================================================================== */

async function handleSubmit(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const gateway = ctx.recipeGateway as RecipeGatewayLike | undefined;
  if (!gateway) {
    // 可见化:提交失败经 fail(...) 折叠成 null 结果，记账侧看不到原因；这里显式打日志，使冷启动
    // 「候选一条没落库」的真因(gateway 未接线)能在 combined.log 里被定位。
    Logger.getInstance().warn('[knowledge.submit] rejected: Recipe gateway not available');
    return fail('Recipe gateway not available');
  }

  const validationError = validateSubmitParams(params);
  if (validationError) {
    // run-14 复盘：本路径此前静默——报告计拒但日志零迹，复盘不可归因
    Logger.getInstance().warn(
      `[knowledge.submit] rejected "${String(params.title ?? '')}" (pre-check): ${validationError}`
    );
    return fail(`Validation failed: ${validationError}`);
  }

  try {
    if (params.title) {
      params.title = stripProjectNamePrefix(String(params.title), ctx.projectRoot);
    }

    const dimMeta = (ctx.runtime?.dimensionMeta as DimensionMetaLike | null | undefined) ?? null;
    const effectiveDimensionId =
      dimMeta?.id ?? pickString(params.dimensionId) ?? pickString(ctx.runtime?.dimensionScopeId);
    const isBootstrap = !!dimMeta;
    const content = params.content as Record<string, unknown>;
    const reasoning = params.reasoning as Record<string, unknown> | undefined;
    // sourceRefs 只记录最终候选显式携带的真实引用，不再做过程分类、强修复或指标拆分。
    // 之前 AI 把 sourceRef 错误设计成多轮分类/strict gate/N11 scorecard，导致 20-30 轮资源浪费。
    // 后续若想恢复 canonical index、basename/entity 分类、自动修复或 reject 逻辑，必须先停下并由用户确认。
    const normalizedSources = uniqueStrings(
      normalizeStringArray(reasoning?.sources ?? params.sourceRefs ?? params.filePaths)
    );
    const normalizedSourceRefs = uniqueStrings(
      normalizeStringArray(params.sourceRefs ?? params.filePaths ?? normalizedSources)
    );
    const allowedKnowledgeType = normalizeStringArray(dimMeta?.allowedKnowledgeTypes)[0];
    const effectiveKnowledgeType =
      allowedKnowledgeType ?? pickString(params.knowledgeType) ?? 'code-pattern';
    const effectiveCategory = pickString(params.category) ?? 'Utility';
    const effectiveLanguage =
      pickString(params.language) ??
      pickString(ctx.runtime?.projectLanguage) ??
      pickString(ctx.runtime?.lang) ??
      'markdown';
    const rationale = pickString(content.rationale);
    const description = pickString(params.description) ?? '';
    const itemReasoning = {
      ...reasoning,
      whyStandard: pickString(reasoning?.whyStandard) ?? rationale ?? description,
      sources: normalizedSources,
      confidence:
        typeof reasoning?.confidence === 'number'
          ? reasoning.confidence
          : (params.confidence ?? 0.75),
    };
    const baseTags = normalizeStringArray(params.tags);
    const tags = isBootstrap ? dimensionTags(effectiveDimensionId, baseTags) : baseTags;
    // 拒收治理：refs 机械自推断需在展开前改写 reasoning——item 为可重绑定
    let item = {
      ...params,
      title: params.title as string,
      description,
      content,
      kind: params.kind as string,
      trigger: params.trigger as string,
      whenClause: params.whenClause as string,
      doClause: params.doClause as string,
      dontClause: params.dontClause as string | undefined,
      coreCode: pickString(params.coreCode) ?? '',
      topicHint: pickString(params.topicHint) ?? effectiveCategory,
      headers: normalizeStringArray(params.headers),
      usageGuide: pickString(params.usageGuide) ?? buildDefaultUsageGuide(params),
      tags,
      reasoning: itemReasoning,
      sourceRefs: normalizedSourceRefs,
      dimensionId: effectiveDimensionId,
      knowledgeType: effectiveKnowledgeType,
      category: effectiveCategory,
      language: effectiveLanguage,
      source: isBootstrap ? 'bootstrap' : AGENT_RUNTIME_SOURCE,
      agentNotes: dimMeta
        ? { dimensionId: dimMeta.id, outputType: pickString(dimMeta.outputType) ?? 'candidate' }
        : null,
    };

    // P1.4b in-process flatten (CG-4)：在 Core production port 之前，把 in-process 提交
    // 接到与 host-agent 路径同一套权威门禁 validateAgainst。档位由 resolveAuthoringProfile 从上下文
    // 解析：携带 bootstrap dimension 的冷启动提交 → cold-start（完整门禁，含 3-file 证据下限）；
    // 运行期机会式 in-process AI 开发（无 session / 无 dimension）→ opportunistic（保留全部内容门禁
    // + 廉价 fs 来源接地，但不强制 3-file 下限与 session-scope）。上面的 validateSubmitParams 仅作
    // 廉价 presence/length fast-fail，本门禁是被其 supersede 的权威裁决；命中即按既有 in-process 拒绝
    // 信封形状（fail 字符串）返回，门禁输出字节不变、只改 in-process AI 看到的门槛。
    // F4f 预处理：裸路径 sourceRefs（无行号）用 Analyst 真实接地范围规范化——裸路径候选
    // 此前没有任何自动化通路（F4b/F4d 都需要可解析行号）。范围来自 evidenceMap 投影
    // （sharedState._analystGroundedRanges），即 Analyst 真实读过/锚点补齐过的行，非任意指派。
    // H1(2026-07-02 数量专项)：同题硬止损——真机同一候选被拒后模型无视 STOP 软指令连提 6 次,
    // 烧掉 60% 提交名额。同 title 第 3 次尝试起直接 terminal 拒绝(不跑门禁不给修复提示)。
    const sharedStateForSubmit = (ctx.runtime?.sharedState ?? null) as Record<
      string,
      unknown
    > | null;
    const titleKey = String(item.title ?? '').trim();
    if (sharedStateForSubmit && titleKey) {
      const attempts = (sharedStateForSubmit._submitTitleAttempts ?? {}) as Record<string, number>;
      const tried = attempts[titleKey] ?? 0;
      if (tried >= 3) {
        Logger.getInstance().warn(
          `[knowledge.submit] hard stop-loss: "${titleKey}" already attempted ${tried} times (dim=${String(effectiveDimensionId ?? '')})`
        );
        return fail(
          `🛑 候选 "${titleKey}" 已尝试 ${tried} 次未通过——本会话禁止再提交该标题。立即换一个【不同的】发现提交，或输出最终总结并把它列为 blocker。`
        );
      }
      attempts[titleKey] = tried + 1;
      sharedStateForSubmit._submitTitleAttempts = attempts;
    }

    // E5（证据保真）：reasoning.evidenceRefs 台账机械展开——sources 由程序从台账
    // 条目生成（模型不再手写 file:line），并做新鲜度终检（run 中途文件变更→EVIDENCE_STALE
    // 拒并提示重采）。发生在权威门禁之前的 Agent 层；Core gateRules 与九拒因语义不动。
    let expansion = expandEvidenceRefsForSubmit(item, {
      ledger: ctx.runtime?.evidenceLedger,
      projectRoot: ctx.projectRoot,
    });
    // 拒收治理（2026-07-05）：refs 缺席但手写 sources 命中台账同文件条目→机械回填后重展开。
    // 只映射真实条目（事实面零发明）；回填后照走新鲜度/标签全链，失败仍按原语义拒。
    if (expansion.ok && expansion.resolvedRefs === 0 && ctx.runtime?.evidenceLedger) {
      const inferred = inferEvidenceRefsFromSources(item, ctx.runtime.evidenceLedger);
      if (inferred.length > 0) {
        bumpSubmitRepairStat(ctx.runtime, 'evidence_refs_inferred');
        Logger.getInstance().info(
          `[knowledge.submit] evidenceRefs auto-inferred from cited sources (${inferred.length} refs) for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')})`
        );
        const reasoningObj = (item.reasoning ?? {}) as Record<string, unknown>;
        item = {
          ...item,
          reasoning: {
            ...reasoningObj,
            evidenceRefs: inferred,
          } as unknown as typeof item.reasoning,
        };
        expansion = expandEvidenceRefsForSubmit(item, {
          ledger: ctx.runtime?.evidenceLedger,
          projectRoot: ctx.projectRoot,
        });
      }
    }
    if (!expansion.ok) {
      Logger.getInstance().warn(
        `[knowledge.submit] rejected "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): ${expansion.error}`
      );
      return fail(expansion.error);
    }
    if (expansion.expandedSources.length > 0) {
      Logger.getInstance().info(
        `[knowledge.submit] evidence refs expanded (${expansion.expandedSources.length} sources) for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')})`
      );
    }

    // 核心保证（2026-07-04 用户裁定）：维度运行的 Recipe 必须经关键证据产出——
    // 台账在场时 reasoning.evidenceRefs 为必填（引用 analyst findings 携带的 [E-x] 条目）；
    // 纯手写 sources 不再被接受为唯一证据（那正是捏造通道）。非维度运行（无台账）不受此限。
    // 判定用 resolvedRefs 而非 expandedSources：search/structure/terminal 类条目无 file 字段、
    // 展不出 file:line 标签，但它们是真实采集证据——run-6 曾按 expandedSources=0 误杀这类
    // 忠实引用（重试三连拒到止损）。source 数量下限仍由下游 INSUFFICIENT_EVIDENCE 把守。
    if (ctx.runtime?.evidenceLedger && expansion.resolvedRefs === 0) {
      const hint = buildEvidenceCandidatesHint(ctx.runtime.evidenceLedger);
      Logger.getInstance().warn(
        `[knowledge.submit] rejected "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): EVIDENCE_REFS_REQUIRED`
      );
      return fail(
        `Validation failed: EVIDENCE_REFS_REQUIRED: 维度运行的候选必须以 reasoning.evidenceRefs 引用台账条目 id（先 memory.recall 查看 findings 携带的 [E-x] 标注，优先引用带文件区间的条目）——手写 sources 不能作为唯一证据。改标题重提同一断言不会通过：补上 evidenceRefs，或该断言没有台账证据支撑时直接放弃。${hint}`
      );
    }
    if (
      ctx.runtime?.evidenceLedger &&
      expansion.resolvedRefs > 0 &&
      expansion.expandedSources.length === 0
    ) {
      // 引用全为无 file 条目（search/terminal 类）：证据在场但机械展开不出 sources——
      // 放行进门禁，手写 sources 照常走 fs 校验+自动矫正；留痕以便真机复盘该形态占比。
      Logger.getInstance().info(
        `[knowledge.submit] evidence refs valid but label-less (${expansion.resolvedRefs} refs, search/terminal 类) for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')})`
      );
    }

    // E7（接受率治理）：手写路径自动矫正（basename 唯一匹配台账真实形态，多仓前缀陷阱机械解）
    // + 证据驱动 scope 收窄（rule/pattern 证据 <3 文件自动 narrow——门禁本就接受该通道）。
    const sanitized = sanitizeSubmissionEvidence(expansion.item, {
      ledger: ctx.runtime?.evidenceLedger,
      projectRoot: ctx.projectRoot,
    });
    if (sanitized.corrected.length > 0 || sanitized.dropped.length > 0 || sanitized.scopedNarrow) {
      bumpSubmitRepairStat(ctx.runtime, 'evidence_sanitized');
      Logger.getInstance().info(
        `[knowledge.submit] evidence sanitized for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): corrected=[${sanitized.corrected.join(', ')}] dropped=[${sanitized.dropped.join(', ')}] scopedNarrow=${sanitized.scopedNarrow}`
      );
    }

    let effectiveItem: Record<string, unknown> = normalizeBareSourceRefs(
      sanitized.item,
      sharedStateForSubmit
    );
    const preparedProduction = prepareRecipeProductionItem(effectiveItem, ctx.projectRoot);
    effectiveItem = preparedProduction.item as Record<string, unknown>;
    if (!preparedProduction.codeEvidence.accepted) {
      bumpSubmitRepairStat(ctx.runtime, 'unsafe_core_code_removed');
      Logger.getInstance().warn(
        `[knowledge.submit] unsafe coreCode removed; candidate will remain readiness-blocked until repaired for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')})`
      );
    }
    let gateViolations = runInProcessRecipeAuthoringGate(effectiveItem, {
      projectRoot: ctx.projectRoot,
      dimensionId: effectiveDimensionId,
    });
    if (!preparedProduction.codeEvidence.accepted) {
      const repairablePendingCodes = new Set([
        'SNIPPET_MISMATCH',
        'SOURCE_REF_INVALID',
        'SOURCE_REF_LINE_MISSING',
        'SOURCE_REF_LINE_OUT_OF_RANGE',
        'SOURCE_REF_NOT_FOUND',
      ]);
      gateViolations = gateViolations.filter(
        (violation) => !repairablePendingCodes.has(violation.code)
      );
    }
    // F4e：GRAPH_REF_INVALID 且 Analyst 真有 graph 查询证据时，自动注入 reasoning.graphRefs
    // （替模型完成「复制」动作——graphEvidence 来自真实 graph 调用，非编造；为空则保持拒绝）。
    if (gateViolations.some((v) => v.code === 'GRAPH_REF_INVALID')) {
      const sharedState = (ctx.runtime?.sharedState ?? null) as Record<string, unknown> | null;
      const analystGraphEvidence = Array.isArray(sharedState?._analystGraphEvidence)
        ? (sharedState._analystGraphEvidence as unknown[]).filter(
            (r): r is string => typeof r === 'string' && r.length > 0
          )
        : [];
      if (analystGraphEvidence.length > 0) {
        const reasoning = (effectiveItem.reasoning ?? {}) as Record<string, unknown>;
        const withGraphRefs = {
          ...effectiveItem,
          reasoning: { ...reasoning, graphRefs: analystGraphEvidence },
        };
        const reVerified = runInProcessRecipeAuthoringGate(withGraphRefs, {
          projectRoot: ctx.projectRoot,
          dimensionId: effectiveDimensionId,
        });
        if (!reVerified.some((v) => v.code === 'GRAPH_REF_INVALID')) {
          bumpSubmitRepairStat(ctx.runtime, 'graph_refs_injected');
          Logger.getInstance().info(
            `[knowledge.submit] graph refs injected from analyst evidence (${analystGraphEvidence.length} refs) for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}), remaining violations=${reVerified.length}`
          );
          effectiveItem = withGraphRefs;
          gateViolations = reVerified;
        }
      }
    }
    // 软规则一次申辩制(2026-07-02 用户决策)：门禁规则分两性——硬规则是事实与接地
    // (伪造锚点/重复/必填结构，放行即污染知识库，不可申辩)；软规则是写作风格判断
    // (祈使动词白名单/对比示例/标题泛化/长度)，LLM 可能有正当理由(如项目惯用语)。
    // 软规则全拒时反复猜措辞是最长的提交回合尾巴；改为：LLM 带 ≥20 字 waiverJustification
    // 重新提交即放行，理由随 reasoning.styleWaiver 落库，由 Dashboard 人工审核终裁。
    // 每会话 waiver 上限 5 次防滥用；混有硬违规时申辩无效(先修事实错误)。
    if (gateViolations.length > 0) {
      // waiver 每会话上限的累计宿主必须跨调用稳定(sessionCounterBox)——挂 ctx.runtime 时
      // 每次调用都从 0 起算,上限 5 形同虚设(与修复层计数同因,门0 真跑后根修)。
      const waiverBox = sessionCounterBox(ctx.runtime);
      const waiverTotal = Number(waiverBox?.styleWaiverTotal) || 0;
      const waiver = applyStyleWaiver({
        violations: gateViolations,
        justification: pickString(params.waiverJustification),
        sessionWaiverTotal: waiverTotal,
        item: effectiveItem,
      });
      if (waiver.waived) {
        effectiveItem = waiver.item;
        bumpSubmitRepairStat(ctx.runtime, 'style_waiver');
        if (waiverBox) {
          waiverBox.styleWaiverTotal = waiverTotal + 1;
        }
        Logger.getInstance().warn(
          `[knowledge.submit] style waiver accepted (${waiver.waivedCodes.join(', ')}) for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}), session waivers=${waiverTotal + 1}/${STYLE_WAIVER_SESSION_LIMIT} — pending human review`
        );
        gateViolations = [];
      }
    }
    // E7-R（接受率 100% 最后一级）：纯风格类拒绝→一次 schema 收窄的修复子调用后重跑门禁
    // （每 title 限 1 次；任何失败零影响走原拒绝路径）。证据类违规不修——那是事实问题不是写法问题。
    if (gateViolations.length > 0 && isStyleRepairable(gateViolations)) {
      const repairState = ctx.runtime as Record<string, unknown> | undefined;
      const repairAttempts = (repairState?._styleRepairAttempts ?? {}) as Record<string, number>;
      if ((repairAttempts[titleKey] ?? 0) < 2) {
        repairAttempts[titleKey] = (repairAttempts[titleKey] ?? 0) + 1;
        if (repairState) {
          repairState._styleRepairAttempts = repairAttempts;
        }
        const repaired = await repairStyleViolations(
          effectiveItem,
          gateViolations,
          ctx.runtime?.aiProvider,
          getImperativeVerbAllowlist()
        );
        if (repaired) {
          const reVerified = runInProcessRecipeAuthoringGate(repaired, {
            projectRoot: ctx.projectRoot,
            dimensionId: effectiveDimensionId,
          });
          if (reVerified.length < gateViolations.length) {
            bumpSubmitRepairStat(ctx.runtime, 'style_repair_subcall');
            Logger.getInstance().info(
              `[knowledge.submit] style repair sub-call fixed "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): violations ${gateViolations.length}→${reVerified.length}`
            );
            effectiveItem = repaired;
            gateViolations = reVerified;
          } else {
            // 降级必须可观测：修复产物未减少违规（run-5 静默分支补钉）
            Logger.getInstance().warn(
              `[style-repair] no improvement for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): ${gateViolations.length}→${reVerified.length}`
            );
          }
        }
      }
    }
    // 门禁分层（2026-07-04 用户裁定：要证据/价值/深度，不强制格式）：
    // 硬门=证据接地类（伪造/引用/逐字/重复/必填结构）→ 拒绝，力度不减；
    // 软门=写作风格类（祈使动词/对比示例/标题泛化/长度）→ 不再阻断——一次修复子调用尝试
    // 真修后，剩余软违规降为 style advisory 随候选入库（reasoning.styleAdvisories，
    // Dashboard 人工复核），价值/深度由既有 C4 深度裁判+C8 质量评分继续评判。
    if (
      gateViolations.length > 0 &&
      gateViolations.every((v) => isSoftAuthoringViolation(v.code))
    ) {
      const advisories = gateViolations.map((v) => `${v.code}: ${v.message}`);
      const reasoningObj = (effectiveItem.reasoning ?? {}) as Record<string, unknown>;
      effectiveItem = {
        ...effectiveItem,
        reasoning: { ...reasoningObj, styleAdvisories: advisories },
      };
      bumpSubmitRepairStat(ctx.runtime, 'style_advisories');
      Logger.getInstance().info(
        `[knowledge.submit] style advisories attached (non-blocking) for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): ${gateViolations.map((v) => v.code).join(', ')}`
      );
      gateViolations = [];
    }
    if (gateViolations.length > 0) {
      const detail = formatRecipeAuthoringViolations(gateViolations);
      // F4b 诊断反馈：代码/引用类违规可附一个真实 bounded range，帮助模型判断引用是否相关。
      // 提示不会修改候选，也不会把首个来源、无界范围或整文件自动提升为 coreCode。
      const snippetRepair = gateViolations.some((v) =>
        ['SNIPPET_MISMATCH', 'SOURCE_REF_LINE_OUT_OF_RANGE', 'SOURCE_REF_LINE_MISSING'].includes(
          v.code
        )
      )
        ? buildSnippetRepairHint(effectiveItem.sourceRefs, ctx.projectRoot)
        : '';
      // E5/E6-F1 反馈增强：INSUFFICIENT_EVIDENCE 与 SOURCE_REF_NOT_FOUND 都附台账内真实
      // 可引用的 distinct 文件——E6 真机显示 NOT_FOUND 全部来自 producer 手写路径
      // （多仓前缀陷阱），台账条目本身就是正确形态，引导改用 evidenceRefs。
      const evidenceHint = gateViolations.some(
        (v) => v.code === 'INSUFFICIENT_EVIDENCE' || v.code === 'SOURCE_REF_NOT_FOUND'
      )
        ? buildEvidenceCandidatesHint(ctx.runtime?.evidenceLedger)
        : '';
      // 申辩指引：全部违规都是软规则时告知申辩通道(硬违规在场时先修事实错误，不提申辩)。
      const appealEligible =
        gateViolations.length > 0 && gateViolations.every((v) => isSoftAuthoringViolation(v.code));
      const appealHint = appealEligible
        ? ' ↺ 以上均为风格类软规则：若你有正当理由坚持当前写法(如项目惯用语)，可原样重新提交并附 waiverJustification(≥20 字理由)——将放行并连同理由交人工审核。证据接地/重复/必填结构类硬规则不适用。'
        : '';
      // 可见化:门禁拒绝是冷启动候选不落库的最可能真因(如冷启动档位的 3-file 证据下限、祈使动词、
      // snippet 匹配、source-ref 接地)。打日志带标题+违规明细，便于定位是 DeepSeek 候选质量还是门禁校准。
      Logger.getInstance().warn(
        `[knowledge.submit] rejected "${String((item as { title?: unknown }).title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): ${detail}`
      );
      // F3 拒绝止损：真机 ts-js-module 曾因「拒绝→重试」循环烧穿 produce 阶段 900s（stage_timeout
      // 连坐 session abort 下游 8 维度）。在 runtime 上维护连续/累计拒绝计数，按档位在拒绝消息里
      // 附加 STOP 指令，让模型跳过修不动的候选、及时收束——预算换覆盖，而不是死磕单条。
      // 止损计数宿主同 waiver:必须用 sessionCounterBox——此前挂 ctx.runtime(每调用一次性
      // 投影对象),streak/total 每次从 0 起算,3/12 档位从未触发,900s 烧穿护栏实际失效。
      const stopLossBox = sessionCounterBox(ctx.runtime);
      let stopDirective = '';
      if (stopLossBox) {
        const streak = (Number(stopLossBox.gateRejectStreak) || 0) + 1;
        const total = (Number(stopLossBox.gateRejectTotal) || 0) + 1;
        stopLossBox.gateRejectStreak = streak;
        stopLossBox.gateRejectTotal = total;
        if (total >= 12) {
          stopDirective =
            ' 🛑 STOP: 本会话门禁拒绝已达预算上限——禁止再调用 knowledge submit，立即输出最终总结，把未通过的候选列为 blocker（这不算失败）。';
        } else if (streak >= 3) {
          stopDirective =
            ' 🛑 STOP: 已连续多次被拒——立即放弃当前候选（不要再改写重试它），换下一条【不同】候选继续提交；若没有其他候选，直接输出最终总结并把本条列为 blocker。';
        }
        if (stopDirective) {
          Logger.getInstance().warn(
            `[knowledge.submit] reject stop-loss engaged (dim=${String(effectiveDimensionId ?? '')}): streak=${streak}, total=${total}`
          );
        }
      }
      // E7：风格/措辞类违规附「照抄即过」修复模板（动词白名单来自 Core 单源）
      const repairTemplates = buildViolationRepairTemplates(
        gateViolations,
        getImperativeVerbAllowlist()
      );
      return fail(
        `Validation failed: ${detail}${snippetRepair}${evidenceHint}${repairTemplates}${appealHint}${stopDirective}`
      );
    }
    // 门禁通过即中断连续拒绝计数（提交成败由下游 gateway 判定，与门禁止损无关）。
    {
      const passBox = sessionCounterBox(ctx.runtime);
      if (passBox) {
        passBox.gateRejectStreak = 0;
      }
    }

    const result = await gateway.createOrStage(
      {
        items: [effectiveItem],
        options: {
          supersedes: pickString(params.supersedes),
          existingTitles: ctx.runtime?.submittedTitles ?? undefined,
          existingTriggers: ctx.runtime?.submittedTriggers ?? undefined,
          existingFingerprints: ctx.runtime?.submittedPatterns ?? undefined,
          systemInjectedFields: uniqueStrings([
            ...(isBootstrap ? getSystemInjectedFields() : []),
            'coreCode',
          ]),
          bootstrapDedup: isBootstrap ? (ctx.runtime?.bootstrapDedup as never) : undefined,
        },
      },
      {
        source: AGENT_RUNTIME_SOURCE,
        userId: AGENT_RUNTIME_SOURCE,
        capability: 'knowledge-submit',
      }
    );

    if (result.created.length > 0) {
      const created = result.created[0];
      const readiness = await gateway.evaluateReadiness(created.id);
      const readinessEvidence = {
        id: created.id,
        lifecycle: created.lifecycle,
        ready: readiness.ready,
        violationCodes: readiness.violations.map((violation) => violation.code),
      };
      const readinessBox = sessionCounterBox(ctx.runtime);
      if (readinessBox) {
        const reports = Array.isArray(readinessBox.recipeReadinessReports)
          ? readinessBox.recipeReadinessReports
          : [];
        readinessBox.recipeReadinessReports = [...reports, readinessEvidence];
      }
      if (!readiness.ready) {
        Logger.getInstance().warn(
          `[knowledge.submit] candidate persisted as ${created.lifecycle} with Core readiness violations for "${String(item.title ?? '')}": ${readiness.violations.map((violation) => violation.code).join(', ')}`
        );
      }
      if (ctx.sessionStore) {
        ctx.sessionStore.save(
          `submit:${item.title}`,
          JSON.stringify({
            title: item.title,
            kind: item.kind,
            lifecycle: created.lifecycle,
            production: result.production,
            readiness,
          }),
          { tags: ['submission'] }
        );
      }
      return ok({
        status: 'created',
        id: created.id,
        title: created.title,
        lifecycle: created.lifecycle,
        production: result.production,
        readiness,
      });
    }

    // gateway 层三类非 created 结果统一留痕（run-8 复盘缺口：查重/拒绝/blocked 全静默，
    // 报告 rejected 计数与日志拒因对不上号——饱和 KB 下 duplicate 是主要暗拒来源）。
    if (result.duplicates.length > 0) {
      Logger.getInstance().warn(
        `[knowledge.submit] gateway duplicate for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): similar to ${result.duplicates
          .map((d) => `"${d.title}"`)
          .slice(0, 3)
          .join(', ')}`
      );
      return ok({
        status: 'duplicate_blocked',
        similar: result.duplicates.map((d) => ({
          title: d.title,
          similarity: d.similarTo?.[0]?.similarity ?? 0,
          similarTo: d.similarTo ?? [],
        })),
      });
    }

    if (result.rejected.length > 0) {
      const rejected = result.rejected[0];
      const firstErrors = Array.isArray(rejected.errors) ? rejected.errors.slice(0, 2) : [];
      Logger.getInstance().warn(
        `[knowledge.submit] gateway rejected "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): ${String(rejected.reason ?? '')}${firstErrors.length > 0 ? ` — ${firstErrors.join(' | ').slice(0, 220)}` : ''}`
      );
      const details = [
        `Rejected: ${rejected.reason}`,
        ...(Array.isArray(rejected.errors) ? rejected.errors : []),
        ...(Array.isArray(rejected.warnings)
          ? rejected.warnings.map((warning) => `warning: ${warning}`)
          : []),
      ].join('\n');
      return fail(details);
    }

    if (result.blocked.length > 0) {
      Logger.getInstance().warn(
        `[knowledge.submit] gateway blocked by consolidation "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')})`
      );
      return fail(
        `Blocked by consolidation: ${(result.blocked[0] as { title?: string }).title ?? 'unknown'}`
      );
    }

    return ok({ status: 'processed', result });
  } catch (err: unknown) {
    Logger.getInstance().warn(
      `[knowledge.submit] rejected "${String(params.title ?? '')}" (exception): ${err instanceof Error ? err.message : String(err)}`
    );
    return fail(`Submit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * 会话级计数盒(修复层计量/waiver 上限/拒绝止损三族共用宿主)。
 *
 * 为什么不能挂 ctx.runtime：ToolExecutionPipeline.buildRuntimeToolCallRequest 对每次工具
 * 调用现造一个一次性 runtime 投影对象——直接写在 ctx.runtime 上的字段随调用即弃(门0 真跑
 * 实测：修复层日志触发而计数恒空；waiver 上限与拒绝止损同因失效,streak 永远到不了阈值)。
 * 为什么是嵌套盒而非 sharedState 顶层字段：PipelineStrategy 的 decisionOnly/recordRepair
 * 阶段会对 sharedState 做浅拷贝,顶层字段写在拷贝上会丢；浅拷贝保留嵌套对象引用,盒内
 * 计数在整个维度会话内单调累计。盒由 PipelineStrategy.execute 入口预建(先于任何阶段拷贝)；
 * 此处兜底自建覆盖非管线宿主。无 sharedState 时返回 null → 计数静默跳过(观测不影响执行)。
 */
function sessionCounterBox(runtime: unknown): Record<string, unknown> | null {
  if (!runtime || typeof runtime !== 'object') {
    return null;
  }
  const shared = (runtime as Record<string, unknown>).sharedState;
  if (!shared || typeof shared !== 'object' || Array.isArray(shared)) {
    return null;
  }
  const state = shared as Record<string, unknown>;
  const existing = state._sessionCounters;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const box: Record<string, unknown> = {};
  state._sessionCounters = box;
  return box;
}

/**
 * P0-4(挖掘质量升级)：submit 修复层命中计数。submit 周围有多层"模型输出不合格→程序
 * 确定性代修"的修复路径(refs 回推/证据矫正/coreCode 回填/snippet 规范化/graph refs 注入/
 * style waiver/风格修复子调用/advisory 降级)——此前只有日志，无法回答"哪些修复层在真实
 * 承重、哪些是死枝"。计数挂在 sessionCounterBox(见上,跨调用稳定)，由 PipelineStrategy
 * 在管线收口时投影进 phases._pipelineOutcome.submitRepairs，评估 harness 据此算
 * repair-hit-rate；P2 契约收紧时按计量裁撤而非盲删。计数失败静默(观测不影响执行)。
 */
function bumpSubmitRepairStat(runtime: unknown, key: string): void {
  const box = sessionCounterBox(runtime);
  if (!box) {
    return;
  }
  const stats =
    box.submitRepairStats && typeof box.submitRepairStats === 'object'
      ? (box.submitRepairStats as Record<string, number>)
      : {};
  stats[key] = (Number(stats[key]) || 0) + 1;
  box.submitRepairStats = stats;
}

interface DimensionMetaLike {
  id: string;
  outputType?: unknown;
  allowedKnowledgeTypes?: unknown;
}

function stripProjectNamePrefix(title: string, projectRoot: string) {
  if (!title || !projectRoot) {
    return title;
  }
  const projectName = path.basename(projectRoot);
  if (!projectName || projectName.length < 2) {
    return title;
  }
  const prefix = new RegExp(
    `^${projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[的—–-]?\\s*`,
    'i'
  );
  const stripped = title.replace(prefix, '');
  return stripped.length > 0 ? stripped : title;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function buildDefaultUsageGuide(params: Record<string, unknown>) {
  const whenClause = pickString(params.whenClause) ?? 'When this project pattern applies.';
  const doClause = pickString(params.doClause) ?? 'Follow the documented project pattern.';
  const dontClause = pickString(params.dontClause) ?? 'Avoid contradicting the documented pattern.';
  return `### When\n${whenClause}\n\n### Do\n${doClause}\n\n### Don't\n${dontClause}`;
}

function validateSubmitParams(params: Record<string, unknown>): string | null {
  const errors: string[] = [];
  const title = params.title as string | undefined;
  const description = params.description as string | undefined;
  const content = params.content as Record<string, unknown> | undefined;
  const kind = params.kind as string | undefined;
  const trigger = params.trigger as string | undefined;
  const whenClause = params.whenClause as string | undefined;
  const doClause = params.doClause as string | undefined;
  const reasoning = params.reasoning as Record<string, unknown> | undefined;
  const retrievalProfile = params.retrievalProfile;

  // 拒收治理（2026-07-05 用户裁定"证据足够尽量收"）：长度阈值属风格类——权威门禁已把
  // 长度类violation 分层为 advisory，本廉价前检若先硬拒即旁路分层（run-14 四拒全为此路径
  // 且静默）。前检只留存在性与结构性；上限保护防垃圾输入。
  if (!title || !title.trim() || title.length > 200) {
    errors.push('title is required (≤200 characters)');
  }
  if (!description || !description.trim()) {
    errors.push('description is required');
  }
  if (!content || typeof content !== 'object') {
    errors.push('content must be an object');
  } else {
    const md = content.markdown as string | undefined;
    if (!md || !md.trim()) {
      errors.push('content.markdown is required');
    }
    const rat = content.rationale as string | undefined;
    if (!rat || !rat.trim()) {
      errors.push('content.rationale is required');
    }
  }
  if (!kind || !['rule', 'pattern', 'fact'].includes(kind)) {
    errors.push('kind must be rule/pattern/fact');
  }
  if (!trigger || !trigger.trim()) {
    errors.push('trigger is required');
  }
  if (!whenClause || !whenClause.trim()) {
    errors.push('whenClause is required');
  }
  if (!doClause || !doClause.trim()) {
    errors.push('doClause is required');
  }
  const sources = reasoning?.sources;
  const evidenceRefs = reasoning?.evidenceRefs;
  const hasSources =
    Array.isArray(sources) &&
    sources.filter((source) => typeof source === 'string' && source.trim().length > 0).length > 0;
  // run-15 时序修复：M1a 契约下模型只给 evidenceRefs 不手写 sources（sources 由展开在
  // 前检**之后**机械生成）——refs 在场即满足证据要求，缺席时才要求手写 sources。
  const hasRefs =
    Array.isArray(evidenceRefs) &&
    evidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim().length > 0).length > 0;
  if (!reasoning || (!hasSources && !hasRefs)) {
    errors.push('reasoning.sources or reasoning.evidenceRefs must be a non-empty array');
  }
  if (
    retrievalProfile !== undefined &&
    (!retrievalProfile || typeof retrievalProfile !== 'object' || Array.isArray(retrievalProfile))
  ) {
    errors.push('retrievalProfile must be an object when provided');
  }

  return errors.length > 0 ? errors.join('; ') : null;
}

/* ================================================================== */
/*  knowledge.detail                                                   */
/* ================================================================== */

async function handleDetail(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const id = params.id as string;
  if (!id) {
    return fail('knowledge.detail requires id');
  }

  const repo = ctx.knowledgeRepo as KnowledgeRepoLike | undefined;
  if (!repo) {
    return fail('Knowledge repository not available');
  }

  try {
    const recipe = await repo.getById(id);
    if (!recipe) {
      return fail(`Recipe not found: ${id}`);
    }

    const text = JSON.stringify(recipe, null, 2);
    return ok(recipe, { tokensEstimate: estimateTokens(text) });
  } catch (err: unknown) {
    return fail(`Detail failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ================================================================== */
/*  knowledge.manage                                                   */
/* ================================================================== */

type ManageOperation =
  | 'approve'
  | 'reject'
  | 'publish'
  | 'deprecate'
  | 'update'
  | 'score'
  | 'validate'
  | 'evolve'
  | 'skip_evolution'
  | 'review'
  | 'review-queue';

const VALID_OPERATIONS = new Set<ManageOperation>([
  'approve',
  'reject',
  'publish',
  'deprecate',
  'update',
  'score',
  'validate',
  'evolve',
  'skip_evolution',
  'review',
  'review-queue',
]);

type EvolutionProposalSource =
  | typeof AGENT_RUNTIME_SOURCE
  | typeof LEGACY_IDE_AGENT_SOURCE
  | 'metabolism'
  | 'decay-scan'
  | 'consolidation'
  | 'relevance-audit'
  | 'file-change'
  | 'rescan-evolution';

type EvolutionAction = 'update' | 'deprecate' | 'valid';

interface ProposalGatewayLike {
  submit(decision: {
    recipeId: string;
    action: EvolutionAction;
    source: EvolutionProposalSource;
    confidence: number;
    description?: string;
    evidence?: Record<string, unknown>[];
    reason?: string;
    replacedByRecipeId?: string;
  }): Promise<{
    recipeId: string;
    action: EvolutionAction;
    outcome: string;
    proposalId?: string;
    error?: string;
  }>;
}

const EVOLUTION_SOURCES = new Set<EvolutionProposalSource>([
  AGENT_RUNTIME_SOURCE,
  LEGACY_IDE_AGENT_SOURCE,
  'metabolism',
  'decay-scan',
  'consolidation',
  'relevance-audit',
  'file-change',
  'rescan-evolution',
]);

async function handleManage(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const operation = params.operation as string;
  const id = params.id as string;

  if (!operation || !VALID_OPERATIONS.has(operation as ManageOperation)) {
    return fail(`Invalid operation: ${operation}. Valid: ${[...VALID_OPERATIONS].join(', ')}`);
  }

  // staging 复核队列（Option A：宿主 LLM 按需复核的只读读面）。列表操作，无需 id——须在下方
  // id 必填校验之前处理。返回 staging 中待复核条目及其「断言 vs 源码」所需内容（断言四要素 +
  // reasoning.sources 引用位置）；宿主据此读源码对比，再经 operation='review' 写回结论。
  if (operation === 'review-queue') {
    const stagingManager = ctx.stagingManager as {
      listReviewQueue?(limit?: number): Promise<
        Array<{
          id: string;
          title: string;
          whenClause: string;
          doClause: string;
          dontClause: string;
          coreCode: string;
          sources: string[];
          stagingDeadline: number;
        }>
      >;
    } | null;
    if (!stagingManager || typeof stagingManager.listReviewQueue !== 'function') {
      return fail('Staging manager not available');
    }
    const limitRaw = params.limit;
    const limit =
      typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.floor(limitRaw)
        : undefined;
    const queue = await stagingManager.listReviewQueue(limit);
    return ok({ queue, count: queue.length });
  }

  if (!id) {
    return fail('knowledge.manage requires id');
  }

  const reason = stringValue(params.reason);
  const data = recordValue(params.data);

  if (operation === 'evolve' || operation === 'deprecate' || operation === 'skip_evolution') {
    return handleEvolutionManage(operation, id, reason, data, params, ctx);
  }

  // staging 复核通道（2026-07-06 复核期落地）：AI/程序化复核者把"断言 vs 源码"
  // 结论写回 StagingManager（fail=到期回滚不晋级；pass/缺失=现状晋级）。
  if (operation === 'review') {
    const stagingManager = ctx.stagingManager as {
      recordReview(
        entryId: string,
        review: { outcome: 'pass' | 'fail'; reviewer?: string; notes?: string }
      ): Promise<boolean>;
    } | null;
    if (!stagingManager || typeof stagingManager.recordReview !== 'function') {
      return fail('Staging manager not available');
    }
    const outcome = stringValue(params.outcome);
    if (outcome !== 'pass' && outcome !== 'fail') {
      return fail("knowledge.manage review requires outcome: 'pass' | 'fail'");
    }
    const recorded = await stagingManager.recordReview(id, {
      outcome,
      reviewer: stringValue(params.reviewer) ?? 'in-process-agent',
      ...(reason ? { notes: reason } : {}),
    });
    if (!recorded) {
      return fail(`Staging review rejected: entry ${id} is not in staging`);
    }
    return ok({ id, outcome, recorded: true });
  }

  const repo = ctx.knowledgeRepo as KnowledgeRepoLike | undefined;
  if (!repo) {
    return fail('Knowledge repository not available');
  }

  try {
    switch (operation) {
      case 'approve':
        await repo.approve(id, reason);
        return ok({ operation, id, status: 'approved' });

      case 'reject':
        await repo.reject(id, reason ?? 'Rejected by agent');
        return ok({ operation, id, status: 'rejected' });

      case 'publish':
        await repo.publish(id);
        return ok({ operation, id, status: 'published' });

      case 'update':
        if (!data) {
          return fail('knowledge.manage(update) requires data');
        }
        await repo.update(id, data);
        return ok({ operation, id, status: 'updated' });

      case 'score': {
        const score = (data?.score as number) ?? 0;
        await repo.score(id, score);
        return ok({ operation, id, status: 'scored', score });
      }

      case 'validate': {
        const validation = await repo.validate(id);
        return ok({ operation, id, status: 'validated', result: validation });
      }

      default:
        return fail(`Unhandled operation: ${operation}`);
    }
  } catch (err: unknown) {
    return fail(`Manage(${operation}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleEvolutionManage(
  operation: 'evolve' | 'deprecate' | 'skip_evolution',
  id: string,
  reason: string | undefined,
  data: Record<string, unknown> | undefined,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const gateway = ctx.proposalGateway as ProposalGatewayLike | undefined;
  if (!gateway?.submit) {
    return fail('Evolution gateway not available');
  }

  const confidence =
    numberValue(data?.confidence) ??
    numberValue(params.confidence) ??
    (operation === 'deprecate' ? 0.7 : 0.9);
  const source = resolveEvolutionSource(ctx);
  const description =
    stringValue(data?.description) ??
    stringValue(params.description) ??
    reason ??
    defaultEvolutionDescription(operation);
  const evidence = buildEvolutionEvidence(data, params);

  const action: EvolutionAction =
    operation === 'evolve' ? 'update' : operation === 'deprecate' ? 'deprecate' : 'valid';

  try {
    const result = await gateway.submit({
      recipeId: id,
      action,
      source,
      confidence,
      description,
      evidence,
      reason,
      replacedByRecipeId:
        stringValue(data?.replacedByRecipeId) ??
        stringValue(params.replacedByRecipeId) ??
        stringValue(data?.supersedes) ??
        stringValue(params.supersedes),
    });

    if (result.outcome === 'error') {
      return fail(result.error || `Evolution ${operation} failed`);
    }

    return ok({
      operation,
      id,
      status: evolutionStatus(operation, result.outcome),
      outcome: result.outcome,
      proposalId: result.proposalId,
    });
  } catch (err: unknown) {
    return fail(`Manage(${operation}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function resolveEvolutionSource(ctx: ToolContext): EvolutionProposalSource {
  const raw = ctx.runtime?.sharedState?.evolutionProposalSource;
  return typeof raw === 'string' && EVOLUTION_SOURCES.has(raw as EvolutionProposalSource)
    ? (raw as EvolutionProposalSource)
    : AGENT_RUNTIME_SOURCE;
}

function defaultEvolutionDescription(operation: 'evolve' | 'deprecate' | 'skip_evolution') {
  if (operation === 'evolve') {
    return 'Evolution Agent proposed an update based on code verification';
  }
  if (operation === 'deprecate') {
    return 'Evolution Agent confirmed the recipe is outdated';
  }
  return 'Evolution Agent verified the recipe remains valid or needs no change';
}

function evolutionStatus(
  operation: 'evolve' | 'deprecate' | 'skip_evolution',
  outcome: string
): string {
  if (operation === 'skip_evolution') {
    return outcome === 'verified' ? 'evolution_verified' : 'evolution_skipped';
  }
  if (operation === 'deprecate') {
    return outcome === 'immediately-executed' ? 'deprecated' : 'deprecation_proposed';
  }
  return outcome === 'proposal-upgraded' ? 'evolution_proposal_upgraded' : 'evolution_proposed';
}

function buildEvolutionEvidence(
  data: Record<string, unknown> | undefined,
  params: Record<string, unknown>
): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const rawEvidence = data?.evidence ?? params.evidence;
  if (Array.isArray(rawEvidence)) {
    for (const item of rawEvidence) {
      const record = recordValue(item);
      if (record) {
        records.push(record);
      }
    }
  } else {
    const record = recordValue(rawEvidence);
    if (record) {
      records.push(record);
    }
  }

  const inline = collectInlineEvidence(data, params);
  if (Object.keys(inline).length > 0) {
    records.push(inline);
  }
  return records;
}

function collectInlineEvidence(
  data: Record<string, unknown> | undefined,
  params: Record<string, unknown>
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const key of [
    'type',
    'sourceStatus',
    'currentCode',
    'newLocation',
    'suggestedChanges',
    'confidence',
  ]) {
    const value = data?.[key] ?? params[key];
    if (value !== undefined) {
      record[key] = value;
    }
  }
  return record;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/* ================================================================== */
/*  DI Interface Types                                                 */
/* ================================================================== */

interface SearchResult {
  id: string;
  title: string;
  kind?: string;
  score: number;
  content?: string;
  description?: string;
}

interface SearchEngineLike {
  search(
    query: string,
    opts: { limit: number; kind?: string; category?: string }
  ): Promise<SearchResult[]>;
}

type RecipeGatewayLike = RecipeProductionPort;

interface KnowledgeRepoLike {
  getById(id: string): Promise<Record<string, unknown> | null>;
  approve(id: string, reason?: string): Promise<void>;
  reject(id: string, reason: string): Promise<void>;
  publish(id: string): Promise<void>;
  update(id: string, data: Record<string, unknown>): Promise<void>;
  score(id: string, score: number): Promise<void>;
  validate(id: string): Promise<unknown>;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen - 3)}...`;
}
