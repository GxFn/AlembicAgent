import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStrictAnalysisContextProjectionV1 } from '../production/StrictProductionPipeline.js';
import type { StrictProductionRuntimePortV1 } from '../production/StrictProductionStages.js';
import type { LLMResult } from '../runtime/AgentRuntimeTypes.js';

export interface StrictProductionSourceFixtureFileV1 {
  readonly path: string;
  readonly originRelativePath: string;
  readonly sha256: string;
}

export interface StrictProductionSourceFixtureV1 {
  readonly id: string;
  readonly project: string;
  readonly expectedDisposition: 'single-file-value' | 'three-file-generic';
  readonly sourceFiles: readonly StrictProductionSourceFixtureFileV1[];
}

export interface LoadedStrictProductionSourceV1 {
  readonly path: string;
  readonly originRelativePath: string;
  readonly sha256: string;
  readonly lineCount: number;
  readonly content: string;
}

export interface StrictProductionEvaluationCandidateV1 {
  readonly title: string;
  readonly kind: 'rule';
  readonly doClause: string;
  readonly dontClause: string;
  readonly content: {
    readonly markdown: string;
    readonly rationale: string;
  };
  readonly reasoning: {
    readonly sources: readonly string[];
    readonly evidenceRefs: readonly string[];
  };
}

/**
 * Network-free provider used by the executable evaluation entrypoints. It still traverses the
 * real Agent runtime and production judge; only the external model transport is frozen.
 */
export class FrozenStrictProductionEvaluationProviderV1 {
  readonly name = 'frozen-fixture';
  readonly model = 'strict-production-fixture-v1';
  readonly networkRequestCount = 0;
  readonly apiKeyReadCount = 0;
  #requestCount = 0;

  get requestCount(): number {
    return this.#requestCount;
  }

  async chatWithTools(prompt: string): Promise<LLMResult> {
    this.#requestCount += 1;
    if (prompt.includes('independent evidence auditor')) {
      return frozenJudgeReply(prompt);
    }
    const phase = prompt.includes('strict cold-start Producer') ? 'producer' : 'analyst';
    const disposition =
      prompt.includes("strictRoleSurface: 'strict-analyst-v1'") ||
      prompt.includes('"disposition":"single-file-value"')
        ? 'single-file-value'
        : 'three-file-generic';
    return {
      text: JSON.stringify({
        kind: 'FrozenStrictStageReplyV1',
        phase,
        disposition,
        promptHash: sha256(prompt),
      }),
      functionCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

/** Reads and hash-verifies source bytes before constructing the strict runtime port. */
export function createStrictProductionSourceFixtureRuntimeV1(input: {
  readonly fixture: StrictProductionSourceFixtureV1;
  readonly projectRoot: string;
  readonly provider: FrozenStrictProductionEvaluationProviderV1;
}) {
  const providerIdentity = Object.freeze({
    provider: input.provider.name,
    model: input.provider.model,
  });
  const loadedSources = input.fixture.sourceFiles.map((source, index) => {
    const content = readFileSync(join(input.projectRoot, source.path), 'utf8');
    const actualSha256 = sha256(content);
    if (actualSha256 !== source.sha256) {
      throw new Error(`STRICT_FIXTURE_SOURCE_HASH_MISMATCH:${source.path}`);
    }
    return Object.freeze({
      path: source.path,
      originRelativePath: source.originRelativePath,
      sha256: actualSha256,
      lineCount: content.split('\n').length,
      content,
      evidenceEntryId: `fixture-evidence-${index + 1}-${actualSha256.slice(0, 12)}`,
    });
  });
  if (
    (input.fixture.expectedDisposition === 'single-file-value' && loadedSources.length !== 1) ||
    (input.fixture.expectedDisposition === 'three-file-generic' && loadedSources.length !== 3)
  ) {
    throw new Error('STRICT_FIXTURE_SOURCE_CARDINALITY_MISMATCH');
  }
  const sourceDisposition = loadedSources.some(
    (source) =>
      source.content.includes("strictRoleSurface: 'strict-analyst-v1'") &&
      source.content.includes("strictRoleSurface: 'strict-producer-v1'") &&
      source.content.includes('capabilities: []')
  )
    ? 'single-file-value'
    : 'three-file-generic';
  if (sourceDisposition !== input.fixture.expectedDisposition) {
    throw new Error('STRICT_FIXTURE_EXPECTED_DISPOSITION_MISMATCH');
  }
  const sourceManifest = loadedSources.map(({ content: _content, ...source }) => source);
  const sourceRevisionVectorHash = hashCanonical(sourceManifest);
  const candidate =
    sourceDisposition === 'single-file-value'
      ? buildValueCandidate(input.fixture, loadedSources)
      : null;
  const capturedCandidates: StrictProductionEvaluationCandidateV1[] = [];
  const context = createStrictAnalysisContextProjectionV1({
    runId: `fixture-run-${input.fixture.id}`,
    journalId: `fixture-journal-${input.fixture.id}`,
    manifestHash: hashCanonical({ fixture: input.fixture.id, sourceManifest, providerIdentity }),
    planCognitionHash: hashCanonical({
      fixture: input.fixture.id,
      phase: 'plan-cognition',
      providerIdentity,
    }),
    planHash: hashCanonical({ fixture: input.fixture.id, phase: 'plan' }),
    requiredUniverseHash: hashCanonical(sourceManifest.map((source) => source.path)),
    baselineScheduleHash: hashCanonical({ fixture: input.fixture.id, schedule: 'baseline' }),
    expansionHeadHash: null,
    currentExpandedScheduleHash: hashCanonical({ fixture: input.fixture.id, schedule: 'current' }),
    finalExpandedScheduleHash: hashCanonical({ fixture: input.fixture.id, schedule: 'final' }),
    analysisFixpointHash: hashCanonical({ fixture: input.fixture.id, fixpoint: sourceManifest }),
    privateCorpusRevision: null,
    hypothesisExpressionSetHash: null,
    lensBindingsHash: hashCanonical({ lens: 'structure-and-boundary', sourceManifest }),
    sourceArtifactHash: hashCanonical({ fixture: input.fixture.id, sourceManifest }),
    sourceRevisionVectorHash,
    questionIds: [`fixture-question-${input.fixture.id}`],
    factQueryObligationIds: sourceManifest.map((source) => `inspect:${source.sha256}`),
    analysisUnitIds: sourceManifest.map((source) => `unit:${source.sha256}`),
    factIds: sourceManifest.map((source) => `fact:${source.sha256}`),
    witnessIds: sourceManifest.map((source) => `witness:${source.sha256}`),
    populationHashes: [hashCanonical(sourceManifest)],
    clusterSetHashes: [hashCanonical({ clusters: sourceManifest })],
    inductionReceiptHashes: candidate ? [hashCanonical({ induction: candidate.title })] : [],
    hypothesisIds: candidate ? [hashCanonical({ hypothesis: candidate.doClause })] : [],
    falsificationReceiptHashes: candidate ? [hashCanonical({ falsification: 'survived' })] : [],
    dispositionReviewIds: [hashCanonical({ disposition: input.fixture.expectedDisposition })],
    evidenceEntryIds: loadedSources.map((source) => source.evidenceEntryId),
    derivedFindingCount: 0,
  });
  let analystValidated = false;
  const runtimePort: StrictProductionRuntimePortV1 = {
    enabled: true,
    context,
    populations: [
      {
        kind: 'FrozenSourcePopulationV1',
        sourceRevisionVectorHash,
        observations: loadedSources.map((source) => ({
          evidenceEntryId: source.evidenceEntryId,
          relativePath: source.path,
          contentHash: source.sha256,
          lineCount: source.lineCount,
          content: source.content,
        })),
      },
    ],
    buildProducerInput: (analysisArtifact) => ({
      kind: 'StrictSourceProducerInputV1',
      analysisArtifact,
      sourceRevisionVectorHash,
    }),
    validateAnalystResult: (source) => {
      assertFrozenStageReply(source, 'analyst', sourceDisposition);
      analystValidated = true;
      return {
        action: 'pass',
        pass: true,
        artifact: {
          kind: 'StrictSourceAnalysisArtifactV1',
          sourceRevisionVectorHash,
          sourceManifest,
          disposition: sourceDisposition,
        },
      };
    },
    reviewProducerResult: (source) => {
      if (!analystValidated) {
        throw new Error('STRICT_FIXTURE_ANALYST_NOT_VALIDATED');
      }
      assertFrozenStageReply(source, 'producer', sourceDisposition);
      if (candidate) {
        capturedCandidates.push(candidate);
      }
      return {
        action: 'pass',
        pass: true,
        artifact: {
          kind: 'StrictSourceReviewDecisionV1',
          verdict: candidate ? 'uphold' : 'investigated-empty',
          candidateCount: candidate ? 1 : 0,
          sourceRevisionVectorHash,
        },
      };
    },
  };
  return Object.freeze({
    runtimePort,
    loadedSources,
    sourceRevisionVectorHash,
    providerIdentity,
    capturedCandidates,
    expectedCandidateCount: candidate ? 1 : 0,
  });
}

function buildValueCandidate(
  fixture: StrictProductionSourceFixtureV1,
  sources: readonly (LoadedStrictProductionSourceV1 & { readonly evidenceEntryId: string })[]
): StrictProductionEvaluationCandidateV1 {
  const source = sources[0];
  if (!source || !source.content.includes("strictRoleSurface: 'strict-analyst-v1'")) {
    throw new Error('STRICT_FIXTURE_VALUE_MARKER_MISSING');
  }
  return Object.freeze({
    title: 'Route strict Analyst and Producer calls through marked no-tool stages',
    kind: 'rule' as const,
    doClause:
      'Use strictRoleSurface markers and empty capabilities on strict Analyst and Producer stages',
    dontClause: 'Do not route a strict run through the legacy Analyst or Producer stage surface',
    content: {
      markdown:
        'The strict stage factory marks both cognition roles and removes tool authority before PipelineStrategy execution.',
      rationale: `${fixture.project} binds strict role identity and the no-tool boundary in one production factory.`,
    },
    reasoning: {
      sources: [`${source.path}:30-${Math.min(source.lineCount, 91)}`],
      evidenceRefs: [source.evidenceEntryId],
    },
  });
}

function assertFrozenStageReply(
  source: unknown,
  expectedPhase: 'analyst' | 'producer',
  expectedDisposition: StrictProductionSourceFixtureV1['expectedDisposition']
): void {
  const reply =
    source && typeof source === 'object' && !Array.isArray(source)
      ? (source as { reply?: unknown }).reply
      : null;
  if (typeof reply !== 'string') {
    throw new Error(`STRICT_FIXTURE_${expectedPhase.toUpperCase()}_REPLY_MISSING`);
  }
  const parsed = JSON.parse(reply) as { kind?: unknown; phase?: unknown; disposition?: unknown };
  if (
    parsed.kind !== 'FrozenStrictStageReplyV1' ||
    parsed.phase !== expectedPhase ||
    parsed.disposition !== expectedDisposition
  ) {
    throw new Error(`STRICT_FIXTURE_${expectedPhase.toUpperCase()}_REPLY_INVALID`);
  }
}

function frozenJudgeReply(prompt: string): LLMResult {
  const slice = /--- (.+?):(\d+)-(\d+) ---/u.exec(prompt);
  if (!slice) {
    throw new Error('FROZEN_JUDGE_SOURCE_SLICE_REQUIRED');
  }
  const [, file, start] = slice;
  const uphold =
    prompt.includes("strictRoleSurface: 'strict-analyst-v1'") &&
    prompt.includes('capabilities: []');
  return {
    text: JSON.stringify({
      entailment: uphold ? 'entailed' : 'not_entailed',
      trivial: !uphold,
      actionable: uphold,
      scopeCorrect: uphold,
      verdict: uphold ? 'uphold' : 'reject',
      citedLines: [`${file}:${start}`],
      reason: uphold
        ? 'The source slice binds strict role markers to no-tool stage definitions.'
        : 'The asset metadata does not support an actionable project-specific code rule.',
    }),
    functionCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function hashCanonical(value: unknown): string {
  return `sha256:${sha256(JSON.stringify(sortCanonical(value)))}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCanonical);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortCanonical(child)])
  );
}
