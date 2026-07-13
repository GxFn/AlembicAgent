import fs from 'node:fs';
import path from 'node:path';
import {
  type CreateRecipeItem,
  computeRecipeSourceContentHash,
  RECIPE_RETRIEVAL_PROFILE_SCHEMA_VERSION,
} from '@alembic/core';

type RecipeRetrievalProfile = NonNullable<CreateRecipeItem['retrievalProfile']>;

const PROFILE_GENERATOR = 'alembic-agent-recipe-profile-v1';
const MAX_CORE_CODE_LINES = 120;
const MAX_CORE_CODE_CHARS = 12_000;
const MAX_EVIDENCE_RANGE_LINES = 160;
const DOCUMENT_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.txt']);
const DOCUMENT_DIRECTORIES = new Set(['design', 'docs', 'wakeflow-ledger']);

interface BoundedSourceEvidence {
  ref: string;
  content: string;
}

export interface PreparedRecipeProductionItem {
  item: CreateRecipeItem;
  codeEvidence: {
    accepted: boolean;
    reason: 'absent' | 'bounded-match' | 'unbounded-or-unrelated';
    provenanceRef?: string;
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(text)
    .filter(Boolean);
}

function distinctSorted(values: string[]): string[] {
  return [...new Set(values.map(text).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function sourceRefsFromItem(item: CreateRecipeItem): string[] {
  const reasoning = record(item.reasoning);
  return distinctSorted([...stringArray(item.sourceRefs), ...stringArray(reasoning?.sources)]);
}

function logicalLines(content: string): string[] {
  const lines = content.split('\n');
  if (content.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

function isDocumentationPath(file: string): boolean {
  const normalized = file.replaceAll('\\', '/').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  return (
    DOCUMENT_EXTENSIONS.has(path.posix.extname(normalized)) ||
    segments.some((segment) => DOCUMENT_DIRECTORIES.has(segment))
  );
}

function readBoundedSourceEvidence(ref: string, projectRoot: string): BoundedSourceEvidence | null {
  const match = /^(.+?):(\d+)(?:-(\d+))?$/.exec(ref.trim());
  if (!match) {
    return null;
  }
  const relative = path.posix.normalize(match[1].replaceAll('\\', '/'));
  if (
    !relative ||
    path.posix.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith('../') ||
    isDocumentationPath(relative)
  ) {
    return null;
  }
  const start = Number(match[2]);
  const end = match[3] ? Number(match[3]) : start;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start ||
    end - start + 1 > MAX_EVIDENCE_RANGE_LINES
  ) {
    return null;
  }
  const absoluteRoot = path.resolve(projectRoot);
  const absolute = path.resolve(absoluteRoot, relative);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
    return null;
  }
  try {
    const realRoot = fs.realpathSync(absoluteRoot);
    const realFile = fs.realpathSync(absolute);
    if (
      (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) ||
      !fs.statSync(realFile).isFile()
    ) {
      return null;
    }
    const lines = logicalLines(fs.readFileSync(realFile, 'utf8'));
    if (end > lines.length || (start === 1 && end === lines.length)) {
      return null;
    }
    const content = lines.slice(start - 1, end).join('\n');
    return content.trim() ? { ref: `${relative}:${start}-${end}`, content } : null;
  } catch {
    return null;
  }
}

function factProvenanceRefs(profile: Record<string, unknown>): string[] {
  const refs: string[] = [];
  for (const bucket of ['concepts', 'scenarios', 'exclusions']) {
    const facts = profile[bucket];
    if (!Array.isArray(facts)) {
      continue;
    }
    for (const fact of facts) {
      const factRecord = record(fact);
      refs.push(...stringArray(factRecord?.provenanceRefs));
    }
  }
  return refs;
}

function buildRetrievalProfile(
  authored: Record<string, unknown>,
  item: CreateRecipeItem,
  evidenceRefs: string[]
): RecipeRetrievalProfile {
  const summary = record(authored.summary);
  const authoredProvenance = record(authored.provenance);
  const sourceFieldRefs = distinctSorted([
    ...stringArray(authoredProvenance?.sourceFieldRefs),
    ...factProvenanceRefs(authored).filter((ref) => ref.startsWith('field:')),
  ]);
  const sourceWithoutProfile: CreateRecipeItem = { ...item, retrievalProfile: null };
  return {
    schemaVersion: RECIPE_RETRIEVAL_PROFILE_SCHEMA_VERSION,
    primaryLanguage: text(authored.primaryLanguage),
    summary: {
      primary: text(summary?.primary),
      technicalEnglish: text(summary?.technicalEnglish),
    },
    concepts: (Array.isArray(authored.concepts)
      ? authored.concepts
      : []) as RecipeRetrievalProfile['concepts'],
    scenarios: (Array.isArray(authored.scenarios)
      ? authored.scenarios
      : []) as RecipeRetrievalProfile['scenarios'],
    exclusions: (Array.isArray(authored.exclusions)
      ? authored.exclusions
      : []) as RecipeRetrievalProfile['exclusions'],
    provenance: {
      evidenceRefs,
      sourceFieldRefs,
      sourceContentHash: computeRecipeSourceContentHash(sourceWithoutProfile),
      generator: PROFILE_GENERATOR,
    },
  };
}

/**
 * Convert the Agent-authored profile draft into Core's public wire contract and
 * admit coreCode only when an explicit, project-local, non-document, non-whole-file
 * bounded range contains the submitted snippet. No source snippet is ever copied
 * into the candidate by this adapter.
 */
export function prepareRecipeProductionItem(
  rawItem: Record<string, unknown>,
  projectRoot: string
): PreparedRecipeProductionItem {
  const authoredProfile = record(rawItem.retrievalProfile);
  const requestedCoreCode = text(rawItem.coreCode);
  const boundedEvidence = sourceRefsFromItem(rawItem as CreateRecipeItem)
    .map((ref) => readBoundedSourceEvidence(ref, projectRoot))
    .filter((entry): entry is BoundedSourceEvidence => entry !== null);

  const codeFitsBudget =
    requestedCoreCode.length <= MAX_CORE_CODE_CHARS &&
    logicalLines(requestedCoreCode).length <= MAX_CORE_CODE_LINES;
  const matchingEvidence = requestedCoreCode
    ? boundedEvidence.find((entry) => entry.content.includes(requestedCoreCode))
    : undefined;
  const codeAccepted = !requestedCoreCode || (codeFitsBudget && matchingEvidence !== undefined);
  const item: CreateRecipeItem = {
    ...(rawItem as CreateRecipeItem),
    coreCode: codeAccepted ? requestedCoreCode : '',
    retrievalProfile: null,
  };
  if (authoredProfile && boundedEvidence.length > 0 && codeAccepted) {
    item.retrievalProfile = buildRetrievalProfile(
      authoredProfile,
      item,
      distinctSorted(boundedEvidence.map((entry) => entry.ref))
    );
  }

  return {
    item,
    codeEvidence: requestedCoreCode
      ? matchingEvidence && codeFitsBudget
        ? { accepted: true, reason: 'bounded-match', provenanceRef: matchingEvidence.ref }
        : { accepted: false, reason: 'unbounded-or-unrelated' }
      : { accepted: true, reason: 'absent' },
  };
}
