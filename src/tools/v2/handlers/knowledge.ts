/**
 * @module tools/v2/handlers/knowledge
 *
 * 知识管理工具 — Agent 与 Alembic 知识库交互的统一入口。
 * Actions: search, submit, detail, manage
 *
 * 后端: SearchEngine (BM25 + 向量), RecipeProductionGateway, KnowledgeRepository
 */

import fs from 'node:fs';
import path from 'node:path';
import { dimensionTags } from '@alembic/core/dimensions';
import { getSystemInjectedFields } from '@alembic/core/knowledge';
import { estimateTokens, fail, ok, type ToolContext, type ToolResult } from '../types.js';

const AGENT_RUNTIME_SOURCE = 'alembic-agent';
const LEGACY_IDE_AGENT_SOURCE = 'ide-agent';

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
    const sourceRefPolicy = resolveSourceRefPolicy(ctx);
    const normalizedSources = groundSourceRefs(
      normalizeStringArray(reasoning?.sources ?? params.sourceRefs ?? params.filePaths),
      ctx,
      sourceRefPolicy
    );
    const normalizedSourceRefs = groundSourceRefs(
      normalizeStringArray(params.sourceRefs ?? params.filePaths ?? normalizedSources.refs),
      ctx,
      sourceRefPolicy
    );
    const sourceRefValidation = buildSourceRefValidation(
      sourceRefPolicy,
      normalizedSources,
      normalizedSourceRefs
    );
    if (sourceRefPolicy.mode === 'strict' && sourceRefValidation.rejectedSourceRefs.length > 0) {
      return failSourceRefValidation(sourceRefValidation);
    }
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
      sources: normalizedSources.refs,
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
      sourceRefs: normalizedSourceRefs.refs,
      dimensionId: effectiveDimensionId,
      knowledgeType: effectiveKnowledgeType,
      category: effectiveCategory,
      language: effectiveLanguage,
      source: isBootstrap ? 'bootstrap' : AGENT_RUNTIME_SOURCE,
      sourceRefValidation,
      agentNotes: buildAgentNotes(dimMeta, normalizedSources, normalizedSourceRefs),
    };

    const result = await gateway.create({
      source: AGENT_RUNTIME_SOURCE,
      items: [item],
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

interface SourceRefGrounding {
  originalRefs: string[];
  refs: string[];
  normalized: Array<{ from: string; to: string; reason: string }>;
  rejected: SourceRefRejected[];
  warnings: Array<{ ref: string; reason: string }>;
}

type SourceRefValidationStatus = 'valid' | 'repaired' | 'rejected' | 'invalid';

type SourceRefRejectReason =
  | 'ambiguous-basename'
  | 'entity-not-file'
  | 'file-not-found'
  | 'outside-project-root'
  | 'package-path-mismatch';

interface SourceRefRejected {
  candidates?: string[];
  reason: SourceRefRejectReason;
  ref: string;
  suggestedRef?: string;
}

interface SourceRefPolicy {
  allowEntityOnlyRefs: boolean;
  allowGuessedPaths: boolean;
  mode: 'compat' | 'strict';
  sourceRefsMustComeFrom: 'project-files-or-canonical-source-ref-index';
}

interface SourceRefValidationSummary {
  invalidSourceRefCount: number;
  mode: SourceRefPolicy['mode'];
  policy: SourceRefPolicy;
  rejectedSourceRefs: SourceRefRejected[];
  repairedSourceRefs: Array<{ from: string; reason: string; to: string }>;
  status: SourceRefValidationStatus;
  warnings: Array<{ ref: string; reason: string }>;
}

function buildAgentNotes(
  dimMeta: DimensionMetaLike | null,
  normalizedSources: SourceRefGrounding,
  normalizedSourceRefs: SourceRefGrounding
): Record<string, unknown> | null {
  const grounding = {
    reasoningSources: compactGroundingNotes(normalizedSources),
    sourceRefs: compactGroundingNotes(normalizedSourceRefs),
  };
  const hasGroundingNotes =
    grounding.reasoningSources.normalized.length > 0 ||
    grounding.reasoningSources.warnings.length > 0 ||
    grounding.reasoningSources.rejected.length > 0 ||
    grounding.sourceRefs.normalized.length > 0 ||
    grounding.sourceRefs.warnings.length > 0 ||
    grounding.sourceRefs.rejected.length > 0;
  const base = dimMeta
    ? { dimensionId: dimMeta.id, outputType: pickString(dimMeta.outputType) ?? 'candidate' }
    : null;
  if (!hasGroundingNotes) {
    return base;
  }
  return {
    ...(base ?? {}),
    sourceRefGrounding: grounding,
  };
}

function compactGroundingNotes(grounding: SourceRefGrounding) {
  return {
    originalRefs: grounding.originalRefs,
    normalized: grounding.normalized,
    rejected: grounding.rejected,
    warnings: grounding.warnings,
  };
}

function groundSourceRefs(
  refs: string[],
  ctx: ToolContext,
  policy: SourceRefPolicy
): SourceRefGrounding {
  const trustedRefs = collectTrustedSourceRefs(ctx);
  const normalized: SourceRefGrounding['normalized'] = [];
  const rejected: SourceRefGrounding['rejected'] = [];
  const warnings: SourceRefGrounding['warnings'] = [];
  const grounded: string[] = [];
  for (const ref of refs) {
    const result = groundSingleSourceRef(ref, ctx.projectRoot, trustedRefs);
    if (result.normalizedFrom) {
      normalized.push({ from: result.normalizedFrom, to: result.ref, reason: result.reason });
    }
    if (result.rejected) {
      if (policy.mode === 'strict') {
        rejected.push(result.rejected);
        continue;
      }
    }
    if (result.warning) {
      warnings.push({ ref: result.ref, reason: result.warning });
    }
    grounded.push(result.ref);
  }
  return {
    originalRefs: refs,
    refs: uniqueStrings(grounded),
    normalized,
    rejected,
    warnings,
  };
}

function collectTrustedSourceRefs(ctx: ToolContext): string[] {
  const sharedState =
    ctx.runtime?.sharedState && typeof ctx.runtime.sharedState === 'object'
      ? ctx.runtime.sharedState
      : {};
  return uniqueStrings([
    ...normalizeSourceRefIndex(sharedState._canonicalSourceRefIndex),
    ...normalizeSourceRefIndex(sharedState.canonicalSourceRefIndex),
    ...normalizeStringArray(sharedState._recordRepairEvidencePaths),
    ...normalizeStringArray(sharedState._producerReferencedFiles),
    ...normalizeStringArray(sharedState._referencedFiles),
    ...normalizeStringArray(sharedState.referencedFiles),
  ]).map((ref) => stripSourceRefLine(ref).pathOnly);
}

function normalizeSourceRefIndex(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const refs: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      refs.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const ref = pickString(record.path) ?? pickString(record.filePath) ?? pickString(record.ref);
    if (ref) {
      refs.push(ref);
    }
  }
  return refs;
}

function groundSingleSourceRef(
  ref: string,
  projectRoot: string,
  trustedRefs: string[]
): {
  ref: string;
  normalizedFrom?: string;
  reason: string;
  rejected?: SourceRefRejected;
  warning?: string;
} {
  const trimmed = normalizePathText(ref);
  const { pathOnly, suffix } = stripSourceRefLine(trimmed);
  if (isOutsideProjectRef(pathOnly, projectRoot)) {
    return {
      ref: trimmed,
      reason: 'outside-project-root',
      rejected: { ref: trimmed, reason: 'outside-project-root' },
    };
  }
  const projectRelative = normalizeProjectRelativePath(pathOnly, projectRoot);
  const withSuffix = (base: string) => `${base}${suffix}`;

  if (projectRelative && fileExists(projectRoot, projectRelative)) {
    const grounded = withSuffix(projectRelative);
    return {
      ref: grounded,
      normalizedFrom: grounded === trimmed ? undefined : ref,
      reason: 'project-file-exists',
    };
  }

  const exactTrusted = trustedRefs.find((candidate) => candidate === projectRelative);
  if (exactTrusted) {
    return {
      ref: withSuffix(exactTrusted),
      normalizedFrom: withSuffix(exactTrusted) === trimmed ? undefined : ref,
      reason: 'trusted-analysis-ref',
    };
  }

  const basename = path.posix.basename(projectRelative || pathOnly);
  const basenameMatches = trustedRefs.filter(
    (candidate) => path.posix.basename(candidate) === basename
  );
  const hasDirectory = pathOnly.includes('/');
  if (basename && basenameMatches.length > 1) {
    return {
      ref: trimmed,
      reason: 'ambiguous-basename',
      rejected: {
        candidates: basenameMatches.slice(0, 8),
        ref: trimmed,
        reason: 'ambiguous-basename',
      },
    };
  }
  if (basename && basenameMatches.length === 1) {
    if (hasDirectory && basenameMatches[0] !== projectRelative) {
      return {
        ref: trimmed,
        reason: 'package-path-mismatch',
        rejected: {
          ref: trimmed,
          reason: 'package-path-mismatch',
          suggestedRef: withSuffix(basenameMatches[0]),
        },
      };
    }
    return {
      ref: withSuffix(basenameMatches[0]),
      normalizedFrom: ref,
      reason: 'missing-prefix-unique-basename',
    };
  }

  const wrongExtensionMatches = findWrongExtensionMatches(
    projectRoot,
    projectRelative,
    trustedRefs
  );
  if (wrongExtensionMatches.length === 1) {
    return {
      ref: withSuffix(wrongExtensionMatches[0]),
      normalizedFrom: ref,
      reason: 'wrong-extension-unique-sibling',
    };
  }
  if (wrongExtensionMatches.length > 1) {
    return {
      ref: trimmed,
      reason: 'ambiguous-basename',
      rejected: {
        candidates: wrongExtensionMatches.slice(0, 8),
        ref: trimmed,
        reason: 'ambiguous-basename',
      },
    };
  }

  const rejectReason: SourceRefRejectReason =
    !hasDirectory && path.posix.extname(basename) ? 'entity-not-file' : 'file-not-found';
  return {
    ref: trimmed,
    reason: rejectReason,
    rejected: { ref: trimmed, reason: rejectReason },
    warning:
      trustedRefs.length > 0
        ? 'sourceRef was not found in projectRoot or trusted analysis refs; preserved for downstream N11 scorecard'
        : 'no trusted analysis refs were available; sourceRef preserved for downstream N11 scorecard',
  };
}

function resolveSourceRefPolicy(ctx: ToolContext): SourceRefPolicy {
  const sharedState =
    ctx.runtime?.sharedState && typeof ctx.runtime.sharedState === 'object'
      ? ctx.runtime.sharedState
      : {};
  const policy =
    sharedState._sourceRefPolicy && typeof sharedState._sourceRefPolicy === 'object'
      ? (sharedState._sourceRefPolicy as Record<string, unknown>)
      : sharedState.sourceRefPolicy && typeof sharedState.sourceRefPolicy === 'object'
        ? (sharedState.sourceRefPolicy as Record<string, unknown>)
        : {};
  const mode =
    pickString(policy.mode) === 'strict' ||
    sharedState._strictSourceRefs === true ||
    sharedState.strictSourceRefs === true
      ? 'strict'
      : 'compat';
  return {
    allowEntityOnlyRefs: policy.allowEntityOnlyRefs === true,
    allowGuessedPaths: policy.allowGuessedPaths === true,
    mode,
    sourceRefsMustComeFrom: 'project-files-or-canonical-source-ref-index',
  };
}

function buildSourceRefValidation(
  policy: SourceRefPolicy,
  normalizedSources: SourceRefGrounding,
  normalizedSourceRefs: SourceRefGrounding
): SourceRefValidationSummary {
  const repairedSourceRefs = dedupeRepairs([
    ...normalizedSources.normalized,
    ...normalizedSourceRefs.normalized,
  ]);
  const rejectedSourceRefs = dedupeRejected([
    ...normalizedSources.rejected,
    ...normalizedSourceRefs.rejected,
  ]);
  const warnings = dedupeWarnings([
    ...normalizedSources.warnings,
    ...normalizedSourceRefs.warnings,
  ]);
  const status: SourceRefValidationStatus =
    rejectedSourceRefs.length > 0
      ? 'rejected'
      : warnings.length > 0
        ? 'invalid'
        : repairedSourceRefs.length > 0
          ? 'repaired'
          : 'valid';
  return {
    invalidSourceRefCount: rejectedSourceRefs.length + warnings.length,
    mode: policy.mode,
    policy,
    rejectedSourceRefs,
    repairedSourceRefs,
    status,
    warnings,
  };
}

function failSourceRefValidation(validation: SourceRefValidationSummary): ToolResult {
  const reasonText = validation.rejectedSourceRefs
    .map((entry) =>
      [
        `${entry.ref}: ${entry.reason}`,
        entry.suggestedRef ? `suggested=${entry.suggestedRef}` : null,
        entry.candidates?.length ? `candidates=${entry.candidates.join(',')}` : null,
      ]
        .filter(Boolean)
        .join(' ')
    )
    .join('; ');
  return {
    ok: false,
    data: {
      sourceRefValidation: validation,
      status: 'source_ref_validation_failed',
    },
    error: `sourceRef strict validation failed: ${reasonText}`,
  };
}

function dedupeRepairs(
  repairs: Array<{ from: string; reason: string; to: string }>
): Array<{ from: string; reason: string; to: string }> {
  const seen = new Set<string>();
  return repairs.filter((repair) => {
    const key = `${repair.from}\0${repair.to}\0${repair.reason}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeRejected(rejected: SourceRefRejected[]): SourceRefRejected[] {
  const seen = new Set<string>();
  return rejected.filter((entry) => {
    const key = `${entry.ref}\0${entry.reason}\0${entry.suggestedRef || ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeWarnings(
  warnings: Array<{ ref: string; reason: string }>
): Array<{ ref: string; reason: string }> {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.ref}\0${warning.reason}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function normalizePathText(ref: string): string {
  return ref.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

function isOutsideProjectRef(ref: string, projectRoot: string): boolean {
  if (!ref) {
    return false;
  }
  if (path.isAbsolute(ref)) {
    const relative = path.relative(projectRoot, ref);
    return relative.startsWith('..') || path.isAbsolute(relative);
  }
  const normalized = path.posix.normalize(normalizePathText(ref));
  return normalized === '..' || normalized.startsWith('../');
}

function stripSourceRefLine(ref: string): { pathOnly: string; suffix: string } {
  const match = ref.match(/(?<path>.*?)(?<suffix>:\d+(?:-\d+)?)?$/);
  return {
    pathOnly: normalizePathText(match?.groups?.path ?? ref),
    suffix: match?.groups?.suffix ?? '',
  };
}

function normalizeProjectRelativePath(ref: string, projectRoot: string): string {
  if (!ref) {
    return ref;
  }
  if (!path.isAbsolute(ref)) {
    return normalizePathText(ref);
  }
  const relative = path.relative(projectRoot, ref);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return normalizePathText(ref);
  }
  return normalizePathText(relative);
}

function findWrongExtensionMatches(
  projectRoot: string,
  ref: string,
  trustedRefs: string[]
): string[] {
  const parsed = path.posix.parse(ref);
  if (!parsed.ext || !parsed.name) {
    return [];
  }
  const trustedMatches = trustedRefs.filter((candidate) => {
    const parsedCandidate = path.posix.parse(candidate);
    return parsedCandidate.dir === parsed.dir && parsedCandidate.name === parsed.name;
  });
  const siblingMatches = listSiblingFiles(projectRoot, parsed.dir).filter((candidate) => {
    const parsedCandidate = path.posix.parse(candidate);
    return parsedCandidate.name === parsed.name;
  });
  return uniqueStrings([...trustedMatches, ...siblingMatches]).filter(
    (candidate) => candidate !== ref
  );
}

function listSiblingFiles(projectRoot: string, dir: string): string[] {
  if (!projectRoot) {
    return [];
  }
  const relativeDir = dir && dir !== '.' ? dir : '';
  if (isOutsideProjectRef(relativeDir || '.', projectRoot)) {
    return [];
  }
  const absoluteDir = path.join(projectRoot, relativeDir);
  try {
    return fs
      .readdirSync(absoluteDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => normalizePathText(path.posix.join(relativeDir, entry.name)));
  } catch {
    return [];
  }
}

function fileExists(projectRoot: string, ref: string): boolean {
  if (!projectRoot || !ref || path.isAbsolute(ref)) {
    return false;
  }
  try {
    return fs.existsSync(path.join(projectRoot, ref));
  } catch {
    return false;
  }
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
