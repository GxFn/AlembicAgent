/** 工具输入的结构校验与字段归一化；不执行查询、AI 或持久化。 */
import path from 'node:path';
import { dimensionTags } from '@alembic/core/dimensions';
import type { ToolContext } from '#tools/kernel/registry.js';
import { AGENT_RUNTIME_SOURCE, type DimensionMetaLike } from './contracts.js';

export function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
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

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function buildDefaultUsageGuide(params: Record<string, unknown>) {
  const whenClause = pickString(params.whenClause) ?? 'When this project pattern applies.';
  const doClause = pickString(params.doClause) ?? 'Follow the documented project pattern.';
  const dontClause = pickString(params.dontClause) ?? 'Avoid contradicting the documented pattern.';
  return `### When\n${whenClause}\n\n### Do\n${doClause}\n\n### Don't\n${dontClause}`;
}

export function validateSubmitParams(params: Record<string, unknown>): string | null {
  const errors: string[] = [];
  // handle 也是直接调用入口，不能依赖 ToolRouter 已做过 schema 检查。
  const title = params.title;
  const description = params.description;
  const content = recordValue(params.content);
  const kind = params.kind;
  const trigger = params.trigger;
  const whenClause = params.whenClause;
  const doClause = params.doClause;
  const reasoning = recordValue(params.reasoning);
  const retrievalProfile = params.retrievalProfile;

  // 拒收治理（2026-07-05 用户裁定"证据足够尽量收"）：长度阈值属风格类——权威门禁已把
  // 长度类violation 分层为 advisory，本廉价前检若先硬拒即旁路分层（run-14 四拒全为此路径
  // 且静默）。前检只留存在性与结构性；上限保护防垃圾输入。
  if (typeof title !== 'string' || !title.trim() || title.length > 200) {
    errors.push('title is required (≤200 characters)');
  }
  if (typeof description !== 'string' || !description.trim()) {
    errors.push('description is required');
  }
  if (!content) {
    errors.push('content must be an object');
  } else {
    const md = content.markdown;
    if (typeof md !== 'string' || !md.trim()) {
      errors.push('content.markdown is required');
    }
    const rat = content.rationale;
    if (typeof rat !== 'string' || !rat.trim()) {
      errors.push('content.rationale is required');
    }
  }
  if (typeof kind !== 'string' || !['rule', 'pattern', 'fact'].includes(kind)) {
    errors.push('kind must be rule/pattern/fact');
  }
  if (typeof trigger !== 'string' || !trigger.trim()) {
    errors.push('trigger is required');
  }
  if (typeof whenClause !== 'string' || !whenClause.trim()) {
    errors.push('whenClause is required');
  }
  if (typeof doClause !== 'string' || !doClause.trim()) {
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

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 归一化候选字段；只消费维度/语言上下文，不读取文件或执行 Core 写入。 */
export function buildSubmissionInput(
  params: Record<string, unknown>,
  ctx: Pick<ToolContext, 'projectRoot' | 'runtime'>
) {
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
  return { item, effectiveDimensionId, isBootstrap };
}
