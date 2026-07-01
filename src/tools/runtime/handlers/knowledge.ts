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
import { dimensionTags } from '@alembic/core/dimensions';
import { getSystemInjectedFields, type RecipeAuthoringViolation } from '@alembic/core/knowledge';
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

const AGENT_RUNTIME_SOURCE = 'alembic-agent';
const LEGACY_IDE_AGENT_SOURCE = 'ide-agent';

/** F4b 自愈反馈里附带的真实代码行数上限（足够 coreCode 照抄，不炸拒绝消息体积） */
const SNIPPET_REPAIR_MAX_LINES = 12;

/** markdown 首个 fenced code block（与 Core collectCodeEvidence 的判据同形） */
const FIRST_FENCED_RE = /(```[a-zA-Z0-9_-]*\s*\n)([\s\S]*?)(```)/;

/**
 * 读取 sourceRefs 中第一个可解析 ref 的真实行范围原文（越界行号 clamp 进文件）。
 * F4b 修复提示与 F4d 自动对齐共用。只读、projectRoot 内限定、失败返回 null。
 */
function readRefRangeCode(
  sourceRefs: unknown,
  projectRoot: string | undefined
): {
  code: string;
  refText: string;
  outOfRange: boolean;
  rawStart: number;
  fileLines: number;
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
      const outOfRange = rawStart > lines.length;
      const start = outOfRange
        ? Math.max(1, lines.length - SNIPPET_REPAIR_MAX_LINES + 1)
        : rawStart;
      const requestedEnd = m[3] ? Number(m[3]) : start + SNIPPET_REPAIR_MAX_LINES - 1;
      const end = Math.min(requestedEnd, start + SNIPPET_REPAIR_MAX_LINES - 1, lines.length);
      const code = lines.slice(start - 1, end).join('\n');
      if (!code.trim()) {
        continue;
      }
      return {
        code,
        refText: `${normalized}:${start}-${end}`,
        outOfRange,
        rawStart,
        fileLines: lines.length,
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
  if (!ranges || !Array.isArray(item.sourceRefs)) {
    return item;
  }
  let changed = false;
  const normalizeRef = (ref: unknown): unknown => {
    if (typeof ref !== 'string' || /:\d+/.test(ref)) {
      return ref;
    }
    const filePath = path.posix.normalize(ref.replaceAll('\\', '/'));
    const fileRanges = ranges[filePath];
    if (!fileRanges?.[0]) {
      return ref;
    }
    changed = true;
    return `${filePath}:${fileRanges[0].start}-${fileRanges[0].end}`;
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
 * F4c 内部规范化重验：门禁的代码证据取三处（coreCode / content.pattern / markdown 首个
 * fenced block），三处都须逐字匹配 cited range。真机 DeepSeek 反复只抄对其中一处、另一处
 * 坚持自写「示意代码」——同一候选换标题重试三轮全卡 SNIPPET_MISMATCH，烧轮次不收敛。
 * 这里在 handler 内做确定性消化：只要有一处代码与引用范围逐字匹配（即真实接地成立），
 * 就把其余代码位同步为该真实代码并重跑完整门禁；任一变体全过即用它提交。
 * 这是规范化而非编造——被同步的代码本身已通过 snippet-match 验证为源文件原文。
 */
function tryNormalizeSnippetEvidence(
  item: Record<string, unknown>,
  opts: { projectRoot: string | undefined; dimensionId: string | undefined }
): {
  item: Record<string, unknown>;
  direction: string;
  violations: RecipeAuthoringViolation[];
} | null {
  if (!opts.projectRoot) {
    return null;
  }
  const content = (item.content ?? {}) as Record<string, unknown>;
  const markdown = typeof content.markdown === 'string' ? content.markdown : '';
  const coreCode = typeof item.coreCode === 'string' ? item.coreCode.trim() : '';
  const fenced = markdown.match(FIRST_FENCED_RE)?.[2]?.trim() ?? '';

  const variants: Array<{ direction: string; item: Record<string, unknown> }> = [];
  // 方向 1：coreCode 为真 → markdown fenced 同步为 coreCode。
  if (coreCode && fenced && coreCode !== fenced) {
    variants.push({
      direction: 'markdown-fenced ← coreCode',
      item: {
        ...item,
        content: {
          ...content,
          markdown: markdown.replace(FIRST_FENCED_RE, (_m, open, _body, close) =>
            [open, coreCode, '\n', close].join('')
          ),
        },
      },
    });
    // 方向 2：markdown fenced 为真 → coreCode 同步为 fenced。
    variants.push({ direction: 'coreCode ← markdown-fenced', item: { ...item, coreCode: fenced } });
  }

  // 方向 3（F4d 自动对齐）：coreCode / fenced 都不匹配（或缺失）时，用模型【自己引用】的
  // sourceRef 范围原文替换全部代码位。四轮真机(21 提交 0 过)证明 DeepSeek 不执行「逐字照抄」
  // 动作——所有教育路线(证据/锚点/答案反馈)到顶后，这是把候选诚实化的确定性收敛：ref 是模型
  // 声称的知识来源；候选进入待人审 candidates，语义一致性由 Dashboard 审核兜底。
  const refRange = readRefRangeCode(item.sourceRefs, opts.projectRoot);
  if (refRange) {
    const alignedMarkdown = markdown.match(FIRST_FENCED_RE)
      ? markdown.replace(FIRST_FENCED_RE, (_m, open, _body, close) =>
          [open, refRange.code, '\n', close].join('')
        )
      : markdown;
    variants.push({
      direction: `all ← sourceRef(${refRange.refText})`,
      item: {
        ...item,
        coreCode: refRange.code,
        content: { ...content, markdown: alignedMarkdown },
      },
    });
  }

  for (const variant of variants) {
    const violations = runInProcessRecipeAuthoringGate(variant.item, {
      projectRoot: opts.projectRoot,
      dimensionId: opts.dimensionId,
    });
    // 采纳条件：SNIPPET_MISMATCH 消失即可（不要求零违规）——真机拒绝常与 GRAPH/DO_CLAUSE
    // 复合，若强求全过则规范化几乎永不生效。剩余文本层违规交回模型修（那是它能修的）。
    if (!violations.some((v) => v.code === 'SNIPPET_MISMATCH')) {
      return { ...variant, violations };
    }
  }
  return null;
}

/**
 * F4b：SNIPPET_MISMATCH 拒绝时，读取第一个可解析 sourceRef 的真实行范围，把逐字代码
 * 附进拒绝消息——模型下一轮把 coreCode / markdown 代码块替换为该内容即可通过
 * snippet-match（判据 = 去空白子串包含）。只读、projectRoot 内限定、失败静默返回空串。
 */
function buildSnippetRepairHint(sourceRefs: unknown, projectRoot: string | undefined): string {
  const range = readRefRangeCode(sourceRefs, projectRoot);
  if (!range) {
    return '';
  }
  const rangeNote = range.outOfRange
    ? `你引用的行号 ${range.rawStart} 超出该文件（共 ${range.fileLines} 行）。请改用 ${range.refText}，`
    : `引用范围 ${range.refText} `;
  return ` 📎 修复提示：${rangeNote}其真实代码如下。请【先按此答案重试本条一次】（把 sourceRefs、coreCode 与 markdown 代码块逐字替换为它，不要改写），带答案的拒绝不算连续失败；重试后仍被拒才换下一条:\n${range.code}`;
}

export async function handle(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  switch (action) {
    case 'search':
      return handleSearch(params, ctx);
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
    const item = {
      ...params,
      title: params.title as string,
      description,
      content,
      kind: params.kind as string,
      trigger: params.trigger as string,
      whenClause: params.whenClause as string,
      doClause: params.doClause as string,
      dontClause: params.dontClause as string | undefined,
      coreCode: pickString(params.coreCode) ?? pickString(content.pattern) ?? '',
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

    // P1.4b in-process flatten (CG-4)：在 gateway.create（Core stage-3）之前，把 in-process 提交
    // 接到与 host-agent 路径同一套权威门禁 validateAgainst。档位由 resolveAuthoringProfile 从上下文
    // 解析：携带 bootstrap dimension 的冷启动提交 → cold-start（完整门禁，含 3-file 证据下限）；
    // 运行期机会式 in-process AI 开发（无 session / 无 dimension）→ opportunistic（保留全部内容门禁
    // + 廉价 fs 来源接地，但不强制 3-file 下限与 session-scope）。上面的 validateSubmitParams 仅作
    // 廉价 presence/length fast-fail，本门禁是被其 supersede 的权威裁决；命中即按既有 in-process 拒绝
    // 信封形状（fail 字符串）返回，门禁输出字节不变、只改 in-process AI 看到的门槛。
    // F4f 预处理：裸路径 sourceRefs（无行号）用 Analyst 真实接地范围规范化——裸路径候选
    // 此前没有任何自动化通路（F4b/F4d 都需要可解析行号）。范围来自 evidenceMap 投影
    // （sharedState._analystGroundedRanges），即 Analyst 真实读过/锚点补齐过的行，非任意指派。
    let effectiveItem: Record<string, unknown> = normalizeBareSourceRefs(
      item,
      (ctx.runtime?.sharedState ?? null) as Record<string, unknown> | null
    );
    let gateViolations = runInProcessRecipeAuthoringGate(effectiveItem, {
      projectRoot: ctx.projectRoot,
      dimensionId: effectiveDimensionId,
    });
    // F4c：SNIPPET_MISMATCH 先尝试 handler 内规范化重验（三处代码位对齐到已验证的真实代码），
    // 成功则零轮次消化形式不一致；失败才走拒绝反馈路径。
    if (gateViolations.some((v) => v.code === 'SNIPPET_MISMATCH')) {
      const normalized = tryNormalizeSnippetEvidence(effectiveItem, {
        projectRoot: ctx.projectRoot,
        dimensionId: effectiveDimensionId,
      });
      if (normalized) {
        Logger.getInstance().info(
          `[knowledge.submit] snippet evidence normalized (${normalized.direction}) for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}), remaining violations=${normalized.violations.length}`
        );
        effectiveItem = normalized.item;
        // 剩余文本层违规（graph/doClause 等）照常走拒绝反馈——但 snippet 维度已确定性消化。
        gateViolations = normalized.violations;
      }
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
          Logger.getInstance().info(
            `[knowledge.submit] graph refs injected from analyst evidence (${analystGraphEvidence.length} refs) for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}), remaining violations=${reVerified.length}`
          );
          effectiveItem = withGraphRefs;
          gateViolations = reVerified;
        }
      }
    }
    if (gateViolations.length > 0) {
      const detail = formatRecipeAuthoringViolations(gateViolations);
      // F4b 自愈反馈：SNIPPET_MISMATCH 时把「引用范围的真实代码」直接附进拒绝消息——
      // 模型下一轮逐字照抄即可通过 snippet-match（去空白子串包含）。这把照抄链从
      // 「预先给对证据」升级为「错了就给正确答案」，不依赖第一轮依从性。
      // 代码/引用类违规都给答案（否则第一拒无提示、第二拒才有、第三次已被止损——答案永远晚一步）。
      const snippetRepair = gateViolations.some((v) =>
        ['SNIPPET_MISMATCH', 'SOURCE_REF_LINE_OUT_OF_RANGE', 'SOURCE_REF_LINE_MISSING'].includes(
          v.code
        )
      )
        ? buildSnippetRepairHint(effectiveItem.sourceRefs, ctx.projectRoot)
        : '';
      // 可见化:门禁拒绝是冷启动候选不落库的最可能真因(如冷启动档位的 3-file 证据下限、祈使动词、
      // snippet 匹配、source-ref 接地)。打日志带标题+违规明细，便于定位是 DeepSeek 候选质量还是门禁校准。
      Logger.getInstance().warn(
        `[knowledge.submit] rejected "${String((item as { title?: unknown }).title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): ${detail}`
      );
      // F3 拒绝止损：真机 ts-js-module 曾因「拒绝→重试」循环烧穿 produce 阶段 900s（stage_timeout
      // 连坐 session abort 下游 8 维度）。在 runtime 上维护连续/累计拒绝计数，按档位在拒绝消息里
      // 附加 STOP 指令，让模型跳过修不动的候选、及时收束——预算换覆盖，而不是死磕单条。
      const runtimeState = ctx.runtime as Record<string, unknown> | undefined;
      let stopDirective = '';
      if (runtimeState) {
        const streak = (Number(runtimeState._gateRejectStreak) || 0) + 1;
        const total = (Number(runtimeState._gateRejectTotal) || 0) + 1;
        runtimeState._gateRejectStreak = streak;
        runtimeState._gateRejectTotal = total;
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
      return fail(`Validation failed: ${detail}${snippetRepair}${stopDirective}`);
    }
    // 门禁通过即中断连续拒绝计数（提交成败由下游 gateway 判定，与门禁止损无关）。
    if (ctx.runtime) {
      (ctx.runtime as Record<string, unknown>)._gateRejectStreak = 0;
    }

    const result = await gateway.create({
      source: AGENT_RUNTIME_SOURCE,
      items: [effectiveItem],
      options: {
        supersedes: pickString(params.supersedes),
        existingTitles: ctx.runtime?.submittedTitles ?? undefined,
        existingTriggers: ctx.runtime?.submittedTriggers ?? undefined,
        existingFingerprints: ctx.runtime?.submittedPatterns ?? undefined,
        systemInjectedFields: isBootstrap ? getSystemInjectedFields() : undefined,
        userId: AGENT_RUNTIME_SOURCE,
        bootstrapDedup: isBootstrap ? ctx.runtime?.bootstrapDedup : undefined,
      },
    });

    if (result.created.length > 0) {
      if (ctx.sessionStore) {
        ctx.sessionStore.save(
          `submit:${item.title}`,
          JSON.stringify({ title: item.title, kind: item.kind }),
          { tags: ['submission'] }
        );
      }
      return ok({
        status: 'created',
        id: result.created[0].id,
        title: result.created[0].title,
      });
    }

    if (result.duplicates.length > 0) {
      return ok({
        status: 'duplicate_blocked',
        similar: result.duplicates.map((d) => ({
          title: d.title,
          similarity: d.score ?? d.similarTo?.[0]?.similarity ?? 0,
          similarTo: d.similarTo ?? [],
        })),
      });
    }

    if (result.rejected.length > 0) {
      const rejected = result.rejected[0];
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
      return fail(
        `Blocked by consolidation: ${(result.blocked[0] as { title?: string }).title ?? 'unknown'}`
      );
    }

    return ok({ status: 'processed', result });
  } catch (err: unknown) {
    return fail(`Submit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
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

  if (!title || title.length < 3 || title.length > 200) {
    errors.push('title must be 3-200 characters');
  }
  if (!description || description.length < 10) {
    errors.push('description must be ≥10 characters');
  }
  if (!content || typeof content !== 'object') {
    errors.push('content must be an object');
  } else {
    const md = content.markdown as string | undefined;
    if (!md || md.length < 200) {
      errors.push('content.markdown must be ≥200 characters');
    }
    const rat = content.rationale as string | undefined;
    if (!rat || rat.length < 50) {
      errors.push('content.rationale must be ≥50 characters');
    }
  }
  if (!kind || !['rule', 'pattern', 'fact'].includes(kind)) {
    errors.push('kind must be rule/pattern/fact');
  }
  if (!trigger || trigger.length < 3) {
    errors.push('trigger is required (≥3 chars)');
  }
  if (!whenClause || whenClause.length < 10) {
    errors.push('whenClause is required (≥10 chars)');
  }
  if (!doClause || doClause.length < 10) {
    errors.push('doClause is required (≥10 chars)');
  }
  const sources = reasoning?.sources;
  if (
    !reasoning ||
    !Array.isArray(sources) ||
    sources.filter((source) => typeof source === 'string' && source.trim().length > 0).length === 0
  ) {
    errors.push('reasoning.sources must be a non-empty array');
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
  | 'skip_evolution';

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

interface EvolutionGatewayLike {
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
  if (!id) {
    return fail('knowledge.manage requires id');
  }

  const reason = stringValue(params.reason);
  const data = recordValue(params.data);

  if (operation === 'evolve' || operation === 'deprecate' || operation === 'skip_evolution') {
    return handleEvolutionManage(operation, id, reason, data, params, ctx);
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
  const gateway = ctx.evolutionGateway as EvolutionGatewayLike | undefined;
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

interface RecipeGatewayLike {
  create(request: {
    source: string;
    items: Record<string, unknown>[];
    options?: Record<string, unknown>;
  }): Promise<{
    created: Array<{ id: string; title: string }>;
    rejected: Array<{ reason: string; errors?: string[]; warnings?: string[] }>;
    duplicates: Array<{
      title: string;
      score?: number;
      similarTo?: Array<{ title: string; similarity: number; file?: string }>;
    }>;
    merged: unknown[];
    blocked: unknown[];
  }>;
}

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
