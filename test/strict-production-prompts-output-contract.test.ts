import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFrozenEvidenceProjection } from '../src/agent/evaluation/IndependentValueReviewer.js';
import {
  type CreateStrictProducerExpressionSetInputV1,
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisFixpointV1,
  createStrictProducerExpressionSetV1,
  createStrictProducerLineageReceiptV1,
  type FullAuthoredProjectionV1,
  type StrictAnalystEpochInputV1,
  type StrictFalsificationInputV1,
  type StrictHypothesisDispositionV1,
  type StrictInductionInputV1,
  type StrictProducerProposalInputV1,
  validateStrictAnalystEpochV1,
} from '../src/agent/production/StrictProductionPipeline.js';
import {
  buildStrictAnalystPrompt,
  buildStrictProducerPrompt,
} from '../src/agent/production/StrictProductionPrompts.js';
import {
  createSingleHypothesisEpochFixture,
  STRICT_SOURCE_REVISION,
} from './fixtures/strict-semantic-authority.js';

/**
 * 契约测试：严格链模型可见提示必须渲染宿主解析器（parseAnalystEnvelope / parseExpansion /
 * parseProducerOutput）与 Agent 输入类型要求的全部输出键，并如实写明审查回执由宿主注入、
 * 模型只输出处置提案。
 *
 * 宿主键名按 ../Alembic strict 运行时解析代码只读抄录；Agent 侧用 Record<keyof T, KeyOwner> 做
 * 编译期穷举，输入类型增删字段时本测试会先在 tsc 阶段失败，而不是静默漂移。渲染出的契约
 * 再被解析回 JSON，逐键核对归属标记，并用真实 fixture 证明“提案 + 宿主注入 = 可通过校验”。
 */

type KeyOwner = 'model' | 'host-owned' | 'host-sealed';
type ContractJson = string | ContractJson[] | { [key: string]: ContractJson };

const HOST_OWNED_PREFIX = 'HOST-OWNED:';
const HOST_SEALED_PREFIX = 'HOST-SEALED:';

// 宿主 parseAnalystEnvelope 读取的信封键与 parseExpansion 校验的扩展行键。
const HOST_ANALYST_ENVELOPE_KEYS = ['epoch', 'expansions'] as const;
const HOST_EXPANSION_ROW_KEYS = [
  'purpose',
  'factFamilyId',
  'capabilityId',
  'canonicalSubjectRef',
  'analysisScale',
  'reasonCode',
] as const;
const HOST_EXPANSION_PURPOSES = "'exploration' | 'counterexample'";
const HOST_EXPANSION_SCALES =
  "'source-range' | 'symbol' | 'file' | 'module' | 'package' | 'repository' | 'project'";
// 宿主 parseProducerOutput 读取的 Producer 顶层键与每行键。
const HOST_PRODUCER_OUTPUT_KEYS = [
  'expressionSets',
  'hypothesisId',
  'proposals',
  'zeroDisposition',
] as const;

// Agent 输入类型键（编译期穷举）。host-owned 由宿主覆盖，host-sealed 由宿主审查会话注入。
const ANALYST_EPOCH_INPUT_KEYS: Record<keyof StrictAnalystEpochInputV1, KeyOwner> = {
  currentAnalysisFixpointHash: 'host-sealed',
  knownFactIds: 'host-owned',
  enrolledObligationIds: 'host-owned',
  population: 'host-owned',
  clusterInputs: 'model',
  nonClusteredDispositions: 'model',
  inductionInputs: 'model',
  falsificationInputs: 'model',
  hypothesisDispositions: 'model',
  dispositionReviews: 'host-sealed',
};
const CLUSTER_INPUT_KEYS: Record<
  keyof StrictAnalystEpochInputV1['clusterInputs'][number],
  KeyOwner
> = {
  mechanismKey: 'model',
  mechanism: 'model',
  observationIds: 'model',
  mechanismEvidenceFactIds: 'model',
  anatomyLensIds: 'model',
};
const NON_CLUSTERED_DISPOSITION_KEYS: Record<
  keyof StrictAnalystEpochInputV1['nonClusteredDispositions'][number],
  KeyOwner
> = {
  observationId: 'model',
  status: 'model',
  reasonCode: 'model',
  dispositionReview: 'host-sealed',
  owner: 'model',
  resumePoint: 'model',
};
const INDUCTION_INPUT_KEYS: Record<keyof StrictInductionInputV1, KeyOwner> = {
  mechanismKey: 'model',
  mode: 'model',
  hypotheses: 'model',
  zeroHypothesisReason: 'model',
  zeroHypothesisDispositionReview: 'host-sealed',
};
const HYPOTHESIS_KEYS: Record<keyof StrictInductionInputV1['hypotheses'][number], KeyOwner> = {
  hypothesisId: 'model',
  statement: 'model',
  premiseFactIds: 'model',
};
const FALSIFICATION_INPUT_KEYS: Record<keyof StrictFalsificationInputV1, KeyOwner> = {
  hypothesisId: 'model',
  enrolledCounterqueryIds: 'model',
  executions: 'model',
  counterqueryApplicability: 'model',
  dispositionReview: 'host-sealed',
};
const COUNTERQUERY_EXECUTION_KEYS: Record<
  keyof StrictFalsificationInputV1['executions'][number],
  KeyOwner
> = {
  counterqueryId: 'model',
  obligationId: 'model',
  executionReceipt: 'model',
  counterexampleFactIds: 'model',
};
const COUNTERQUERY_APPLICABILITY_KEYS: Record<
  keyof StrictFalsificationInputV1['counterqueryApplicability'],
  KeyOwner
> = {
  status: 'model',
  reasonCode: 'model',
};
const HYPOTHESIS_DISPOSITION_KEYS: Record<keyof StrictHypothesisDispositionV1, KeyOwner> = {
  hypothesisId: 'model',
  status: 'model',
  causalParentHypothesisId: 'model',
};
const PRODUCER_INPUT_KEYS: Record<keyof CreateStrictProducerExpressionSetInputV1, KeyOwner> = {
  lineage: 'host-owned',
  parentSet: 'host-owned',
  proposals: 'model',
  zeroDisposition: 'model',
  modelHash: 'host-owned',
  reasonHash: 'host-owned',
};
const PROPOSAL_INPUT_KEYS: Record<keyof StrictProducerProposalInputV1, KeyOwner> = {
  expressionId: 'model',
  kind: 'model',
  authored: 'model',
  matchingRepresentativeId: 'model',
};
const AUTHORED_PROJECTION_KEYS: Record<keyof FullAuthoredProjectionV1, KeyOwner> = {
  title: 'model',
  kind: 'model',
  doClause: 'model',
  dontClause: 'model',
  markdown: 'model',
  usageGuide: 'model',
  retrievalProfile: 'model',
  negativeIntent: 'model',
  scope: 'model',
  evidenceEntryIds: 'model',
};
const ZERO_DISPOSITION_KEYS: Record<
  keyof NonNullable<CreateStrictProducerExpressionSetInputV1['zeroDisposition']>,
  KeyOwner
> = {
  reasonCode: 'model',
  authored: 'model',
  dispositionReview: 'host-sealed',
};

const ANALYST_OWNERSHIP_MAPS = [
  ANALYST_EPOCH_INPUT_KEYS,
  CLUSTER_INPUT_KEYS,
  NON_CLUSTERED_DISPOSITION_KEYS,
  INDUCTION_INPUT_KEYS,
  HYPOTHESIS_KEYS,
  FALSIFICATION_INPUT_KEYS,
  COUNTERQUERY_EXECUTION_KEYS,
  COUNTERQUERY_APPLICABILITY_KEYS,
  HYPOTHESIS_DISPOSITION_KEYS,
] as const;
const PRODUCER_OWNERSHIP_MAPS = [
  PRODUCER_INPUT_KEYS,
  PROPOSAL_INPUT_KEYS,
  AUTHORED_PROJECTION_KEYS,
  ZERO_DISPOSITION_KEYS,
] as const;

// 模型绝不能自行产出的 Agent/Core 派生字段：Analyst 校验器显式拒绝的字符串回执权威与回执标识。
const ANALYST_NEVER_MODEL_AUTHORED_KEYS = [
  'reviewerReceiptId',
  'zeroHypothesisReviewReceiptId',
  'reviewReceiptId',
  'receiptHash',
] as const;
// Producer 建集函数显式拒绝的 lineage 字段与 Agent 派生的指纹、回执、终态字段。
const PRODUCER_NEVER_MODEL_AUTHORED_KEYS = [
  'authoredFingerprint',
  'authoredFingerprintHash',
  'reviewerReceiptId',
  'reviewReceiptId',
  'receiptHash',
  'terminalFate',
  'setId',
  'version',
  'parentSetId',
  'hypothesis',
  'analysisFixpointHash',
  'repairNode',
] as const;

const authored: FullAuthoredProjectionV1 = {
  title: 'Preserve typed Result envelopes',
  kind: 'rule',
  doClause: 'Return the typed Result envelope',
  dontClause: 'Do not leak raw exceptions',
  markdown: 'Handlers preserve the project Result contract.',
  usageGuide: 'Apply at every handler boundary.',
  retrievalProfile: { intents: ['handler result contract'] },
  negativeIntent: ['internal helper'],
  scope: { moduleIds: ['handlers'], dimensionIds: ['error-resilience'] },
  evidenceEntryIds: ['E-1'],
};

/** 空 population 与空 lineage 输入：输出键只能来自契约渲染，不能来自回显的数据。 */
function buildEmptyAnalystPrompt(): string {
  const context = createStrictAnalysisContextProjectionV1({
    runId: 'run-contract',
    journalId: 'journal-contract',
    manifestHash: 'manifest-contract',
    planCognitionHash: 'plan-cognition-contract',
    planHash: 'plan-contract',
    requiredUniverseHash: 'universe-contract',
    baselineScheduleHash: 'schedule-contract',
    expansionHeadHash: null,
    currentExpandedScheduleHash: 'schedule-contract',
    finalExpandedScheduleHash: null,
    analysisFixpointHash: null,
    privateCorpusRevision: null,
    hypothesisExpressionSetHash: null,
    lensBindingsHash: 'lens-contract',
    sourceArtifactHash: 'artifact-contract',
    sourceRevisionVectorHash: 'vector-contract',
    questionIds: [],
    factQueryObligationIds: [],
    analysisUnitIds: [],
    factIds: [],
    witnessIds: [],
    populationHashes: [],
    clusterSetHashes: [],
    inductionReceiptHashes: [],
    hypothesisIds: [],
    falsificationReceiptHashes: [],
    dispositionReviewIds: [],
    evidenceEntryIds: [],
    derivedFindingCount: 0,
  });
  return buildStrictAnalystPrompt({
    epoch: createStrictAnalysisEpochSnapshotV1({
      epoch: 1,
      context,
      populations: [],
      terminalObligationIds: [],
      outstandingObligationIds: [],
    }),
    limits: { maxEpochs: 8, maxObligations: 4 },
  });
}

function buildEmptyProducerPrompt(): string {
  return buildStrictProducerPrompt({
    schemaVersion: 1,
    lineages: [],
    cardinalityPolicy: 'zero-one-many-no-floor',
    semanticRepairLimit: 2,
  });
}

/** 与 strict-production-rework.test.ts 同构的最小 lineage：单假设 epoch → fixpoint → lineage。 */
function createProducerLineageFixture() {
  const semantic = createSingleHypothesisEpochFixture();
  const epoch = validateStrictAnalystEpochV1(semantic.epochInput);
  const analysisFixpoint = createStrictAnalysisFixpointV1({
    finalExpandedSchedule: semantic.finalExpandedSchedule,
    terminalObligations: semantic.terminalObligations,
    epochs: [epoch],
  });
  const context = createStrictAnalysisContextProjectionV1({
    runId: 'run-contract',
    journalId: 'journal-contract',
    manifestHash: 'manifest-contract',
    planCognitionHash: 'plan-cognition-contract',
    planHash: 'plan-contract',
    requiredUniverseHash: 'universe-contract',
    baselineScheduleHash: semantic.finalExpandedSchedule.baselineScheduleHash,
    expansionHeadHash: null,
    currentExpandedScheduleHash: semantic.finalExpandedSchedule.finalExpandedScheduleHash,
    finalExpandedScheduleHash: semantic.finalExpandedSchedule.finalExpandedScheduleHash,
    analysisFixpointHash: analysisFixpoint.fixpointHash,
    privateCorpusRevision: null,
    hypothesisExpressionSetHash: null,
    lensBindingsHash: 'lens-contract',
    sourceArtifactHash: 'artifact-contract',
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    questionIds: ['question-1'],
    factQueryObligationIds: [semantic.executionReceipt.obligationId],
    analysisUnitIds: ['unit-1'],
    factIds: ['fact-handler'],
    witnessIds: ['witness-handler'],
    populationHashes: [epoch.population.populationHash],
    clusterSetHashes: [epoch.clusterSet.clusterSetHash],
    inductionReceiptHashes: epoch.inductions.map((receipt) => receipt.receiptHash),
    hypothesisIds: ['hypothesis-handler'],
    falsificationReceiptHashes: epoch.falsifications.map((receipt) => receipt.receiptHash),
    dispositionReviewIds: [semantic.dispositionReview.reviewReceiptId],
    evidenceEntryIds: ['E-1'],
    derivedFindingCount: 0,
  });
  const content = 'export function handle(): Result<void> { return Result.ok(); }';
  const evidence = createFrozenEvidenceProjection({
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    entries: [
      {
        evidenceEntryId: 'E-1',
        relativePath: 'src/handler.ts',
        blobHash: 'blob-handler',
        contentHash: createHash('sha256').update(content).digest('hex'),
        startLine: 1,
        endLine: 1,
        content,
      },
    ],
  });
  return createStrictProducerLineageReceiptV1({
    context,
    epoch,
    analysisFixpoint,
    hypothesisId: 'hypothesis-handler',
    evidence,
  });
}

function quotedKeys(keys: Readonly<Record<string, KeyOwner>> | readonly string[]): string[] {
  return (Array.isArray(keys) ? keys : Object.keys(keys)).map((key) => `"${key}"`);
}

function expectKeysRendered(prompt: string, keys: readonly string[]): void {
  const missing = keys.filter((key) => !prompt.includes(key));
  expect(missing, `prompt is missing output keys: ${missing.join(', ')}`).toEqual([]);
}

/** 契约必须是提示中唯一一行可解析的 JSON 对象，否则模型拿不到可机读的形状。 */
function readOutputContract(prompt: string): { [key: string]: ContractJson } {
  const lines = prompt.split('\n').filter((line) => line.startsWith('Output contract: '));
  expect(lines, 'exactly one output contract line').toHaveLength(1);
  const parsed: unknown = JSON.parse(lines[0].slice('Output contract: '.length));
  return asRecord(parsed, 'output contract');
}

function asRecord(value: unknown, path: string): { [key: string]: ContractJson } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object`);
  }
  return value as { [key: string]: ContractJson };
}

function firstRow(value: unknown, path: string): { [key: string]: ContractJson } {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`${path} must be a one-row array skeleton`);
  }
  return asRecord(value[0], `${path}[0]`);
}

function sortedKeys(record: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(record).sort();
}

function keysOwnedBy(
  maps: readonly Readonly<Record<string, KeyOwner>>[],
  owner: KeyOwner
): string[] {
  return [
    ...new Set(
      maps.flatMap((map) =>
        Object.entries(map)
          .filter(([, candidate]) => candidate === owner)
          .map(([key]) => key)
      )
    ),
  ].sort();
}

/** 骨架节点的键集合必须与 Agent 输入类型相同，且每个键的宿主标记与归属一致。 */
function expectShapeMirrors(
  node: { [key: string]: ContractJson },
  ownership: Readonly<Record<string, KeyOwner>>,
  path: string
): void {
  expect(sortedKeys(node), `${path} keys`).toEqual(sortedKeys(ownership));
  for (const [key, owner] of Object.entries(ownership)) {
    const value = node[key];
    const marker =
      owner === 'host-owned'
        ? HOST_OWNED_PREFIX
        : owner === 'host-sealed'
          ? HOST_SEALED_PREFIX
          : null;
    if (marker) {
      expect(typeof value === 'string' && value.startsWith(marker), `${path}.${key} marker`).toBe(
        true
      );
      expect(value, `${path}.${key} must tell the model to omit the key`).toContain(
        'Omit this key'
      );
    } else {
      expect(
        typeof value === 'string' && value.startsWith('HOST-'),
        `${path}.${key} is a model key and must not be host-marked`
      ).toBe(false);
    }
  }
}

/** 模型提案的每个键都必须落在契约骨架的模型键上；宿主标记键出现即视为越权输出。 */
function expectWithinModelContract(value: unknown, shape: ContractJson, path: string): void {
  if (typeof shape === 'string') {
    expect(shape.startsWith('HOST-'), `${path} is host-owned or host-sealed`).toBe(false);
    return;
  }
  if (Array.isArray(shape)) {
    expect(Array.isArray(value), `${path} must be an array`).toBe(true);
    for (const [index, item] of (value as unknown[]).entries()) {
      expectWithinModelContract(item, shape[0], `${path}[${index}]`);
    }
    return;
  }
  // 契约的 cardinality 规则允许 zeroDisposition: null（有 proposals 时）；其他对象节点不允许 null。
  if (value === null && path.endsWith('.zeroDisposition')) {
    return;
  }
  const record = asRecord(value, path);
  for (const [key, item] of Object.entries(record)) {
    expect(Object.hasOwn(shape, key), `${path}.${key} is not a contract key`).toBe(true);
    expectWithinModelContract(item, shape[key], `${path}.${key}`);
  }
}

describe('strict Analyst prompt output contract', () => {
  const prompt = buildEmptyAnalystPrompt();

  it('renders every key the host Analyst envelope parser and the Agent epoch input require', () => {
    expectKeysRendered(prompt, quotedKeys(HOST_ANALYST_ENVELOPE_KEYS));
    expectKeysRendered(prompt, quotedKeys(HOST_EXPANSION_ROW_KEYS));
    for (const map of ANALYST_OWNERSHIP_MAPS) {
      expectKeysRendered(prompt, quotedKeys(map));
    }
  });

  it('renders the exact enum unions the host parser and Agent validator accept', () => {
    expect(prompt).toContain(HOST_EXPANSION_PURPOSES);
    expect(prompt).toContain(HOST_EXPANSION_SCALES);
    expect(prompt).toContain("'discarded' | 'unresolved'");
    expect(prompt).toContain("'recurring' | 'bounded-singleton'");
    expect(prompt).toContain("'refuted' | 'insufficient-evidence' | 'unknown'");
    expect(prompt).toContain("'required' | 'not-required'");
    expect(prompt).toContain("'survived' | 'narrowed' | 'refuted' | 'unknown'");
  });

  it('renders one parseable contract whose epoch skeleton mirrors the Agent input type', () => {
    const contract = readOutputContract(prompt);
    expect(contract.kind).toBe('StrictAnalystEnvelopeV1');
    const shape = asRecord(contract.shape, 'shape');
    expect(sortedKeys(shape)).toEqual([...HOST_ANALYST_ENVELOPE_KEYS].sort());
    const epoch = asRecord(shape.epoch, 'shape.epoch');
    expectShapeMirrors(epoch, ANALYST_EPOCH_INPUT_KEYS, 'epoch');
    const cluster = firstRow(epoch.clusterInputs, 'epoch.clusterInputs');
    expectShapeMirrors(cluster, CLUSTER_INPUT_KEYS, 'epoch.clusterInputs[0]');
    expectShapeMirrors(
      firstRow(epoch.nonClusteredDispositions, 'epoch.nonClusteredDispositions'),
      NON_CLUSTERED_DISPOSITION_KEYS,
      'epoch.nonClusteredDispositions[0]'
    );
    const induction = firstRow(epoch.inductionInputs, 'epoch.inductionInputs');
    expectShapeMirrors(induction, INDUCTION_INPUT_KEYS, 'epoch.inductionInputs[0]');
    expectShapeMirrors(
      firstRow(induction.hypotheses, 'epoch.inductionInputs[0].hypotheses'),
      HYPOTHESIS_KEYS,
      'epoch.inductionInputs[0].hypotheses[0]'
    );
    const falsification = firstRow(epoch.falsificationInputs, 'epoch.falsificationInputs');
    expectShapeMirrors(falsification, FALSIFICATION_INPUT_KEYS, 'epoch.falsificationInputs[0]');
    expectShapeMirrors(
      firstRow(falsification.executions, 'epoch.falsificationInputs[0].executions'),
      COUNTERQUERY_EXECUTION_KEYS,
      'epoch.falsificationInputs[0].executions[0]'
    );
    expectShapeMirrors(
      asRecord(
        falsification.counterqueryApplicability,
        'epoch.falsificationInputs[0].counterqueryApplicability'
      ),
      COUNTERQUERY_APPLICABILITY_KEYS,
      'epoch.falsificationInputs[0].counterqueryApplicability'
    );
    expectShapeMirrors(
      firstRow(epoch.hypothesisDispositions, 'epoch.hypothesisDispositions'),
      HYPOTHESIS_DISPOSITION_KEYS,
      'epoch.hypothesisDispositions[0]'
    );
    expect(sortedKeys(firstRow(shape.expansions, 'shape.expansions'))).toEqual(
      [...HOST_EXPANSION_ROW_KEYS].sort()
    );
    // 宿主键列表由骨架标记派生：列表与标记必须一致，且与 Agent 输入类型的归属一致。
    expect(contract.hostOwnedInputKeys).toEqual(keysOwnedBy(ANALYST_OWNERSHIP_MAPS, 'host-owned'));
    expect(contract.hostSealedKeys).toEqual(keysOwnedBy(ANALYST_OWNERSHIP_MAPS, 'host-sealed'));
    expect(contract.neverEmit).toEqual([...ANALYST_NEVER_MODEL_AUTHORED_KEYS]);
    expect(contract.epochSemantics).toContain('expansions: []');
  });

  it('states that disposition reviews are host-injected proposals-only output, never model-authored', () => {
    expect(prompt).not.toContain(
      'must carry an independently bound Core KnowledgeDispositionReview receipt'
    );
    expect(prompt).toMatch(/host[^\n]*independent semantic review/iu);
    expect(prompt).toMatch(/never (?:author|fabricate)[^\n]*review/iu);
    for (const key of ANALYST_NEVER_MODEL_AUTHORED_KEYS) {
      expect(prompt, `never-model-authored key ${key} must be named`).toContain(`"${key}"`);
    }
    expect(prompt).toContain('"knownFactIds"');
    expect(prompt).toContain('"enrolledObligationIds"');
    expect(prompt).toContain('"population"');
    expect(prompt).toContain('HOST-SEALED');
    expect(prompt).toContain('HOST-OWNED');
  });

  it('accepts a proposal-only reply once the host seals the reviews and fails closed before that', () => {
    const fixture = createSingleHypothesisEpochFixture();
    const {
      currentAnalysisFixpointHash,
      knownFactIds,
      enrolledObligationIds,
      population,
      dispositionReviews,
      ...proposalRows
    } = fixture.epochInput;
    // 模型按契约只输出提案：每行去掉 host-sealed 的审查回执。
    const modelProposal = {
      ...proposalRows,
      nonClusteredDispositions: proposalRows.nonClusteredDispositions.map(
        ({ dispositionReview: _review, ...row }) => row
      ),
      inductionInputs: proposalRows.inductionInputs.map(
        ({ zeroHypothesisDispositionReview: _review, ...row }) => row
      ),
      falsificationInputs: proposalRows.falsificationInputs.map(
        ({ dispositionReview: _review, ...row }) => row
      ),
    };
    const epochShape = asRecord(asRecord(readOutputContract(prompt).shape, 'shape').epoch, 'epoch');
    expectWithinModelContract(modelProposal, epochShape, 'epoch');

    // 宿主像 parseAnalystEnvelope 一样把模型 JSON 强转并覆盖权威键；跨仓第二步落地前没有封印段，
    // 校验必须 fail-closed 而不是放行无审查的处置。
    const hostOwned = { knownFactIds, enrolledObligationIds, population };
    expect(() =>
      validateStrictAnalystEpochV1({
        ...modelProposal,
        ...hostOwned,
      } as unknown as StrictAnalystEpochInputV1)
    ).toThrow('STRICT_ANALYST_REVIEW_CONTEXT_HASH_INVALID');

    // 宿主按提案的 hypothesisId 查找自己生成的审查并注入，再送校验：提案 + 封印段通过。
    const reviewsByHypothesis = new Map(
      fixture.epochInput.falsificationInputs.map((row) => [row.hypothesisId, row.dispositionReview])
    );
    const sealed: StrictAnalystEpochInputV1 = {
      ...modelProposal,
      ...hostOwned,
      currentAnalysisFixpointHash,
      falsificationInputs: modelProposal.falsificationInputs.map((row) => {
        const dispositionReview = reviewsByHypothesis.get(row.hypothesisId);
        if (!dispositionReview) {
          throw new Error(`host review missing for ${row.hypothesisId}`);
        }
        return { ...row, dispositionReview };
      }),
      dispositionReviews,
    };
    const epoch = validateStrictAnalystEpochV1(sealed);
    expect(epoch.producerEligibleHypotheses.map((row) => row.hypothesisId)).toEqual([
      'hypothesis-handler',
    ]);
    expect(epoch.currentAnalysisFixpointHash).toBe(currentAnalysisFixpointHash);
  });

  it('keeps the fixture provider role marker and never leaks fixture disposition literals', () => {
    expect(prompt.startsWith('You are the strict cold-start Analyst')).toBe(true);
    expect(prompt).not.toContain('strict cold-start Producer');
    expect(prompt).toContain('counterquery');
    expect(prompt).not.toContain("strictRoleSurface: 'strict-analyst-v1'");
    expect(prompt).not.toContain('"disposition":"single-file-value"');
    expect(prompt).not.toContain('independent evidence auditor');
    expect(prompt).not.toMatch(/at least\s+\d+\s+(?:candidate|proposal)|targetRecipes/iu);
  });
});

describe('strict Producer prompt output contract', () => {
  const prompt = buildEmptyProducerPrompt();

  it('renders every key the host Producer output parser and the Agent expression-set input require', () => {
    expectKeysRendered(prompt, quotedKeys(HOST_PRODUCER_OUTPUT_KEYS));
    for (const map of PRODUCER_OWNERSHIP_MAPS) {
      expectKeysRendered(prompt, quotedKeys(map));
    }
    expectKeysRendered(prompt, ['"moduleIds"', '"dimensionIds"']);
    expect(prompt).toContain("'draft' | 'merge' | 'duplicate'");
  });

  it('renders one parseable contract whose row skeleton mirrors the Agent expression-set input', () => {
    const contract = readOutputContract(prompt);
    expect(contract.kind).toBe('StrictProducerOutputV1');
    const shape = asRecord(contract.shape, 'shape');
    expect(sortedKeys(shape)).toEqual(['expressionSets']);
    const row = firstRow(shape.expressionSets, 'shape.expressionSets');
    const { hypothesisId, ...inputShape } = row;
    expect(typeof hypothesisId === 'string' && !hypothesisId.startsWith('HOST-')).toBe(true);
    expectShapeMirrors(inputShape, PRODUCER_INPUT_KEYS, 'expressionSets[0]');
    const proposal = firstRow(row.proposals, 'expressionSets[0].proposals');
    expectShapeMirrors(proposal, PROPOSAL_INPUT_KEYS, 'expressionSets[0].proposals[0]');
    expectShapeMirrors(
      asRecord(proposal.authored, 'expressionSets[0].proposals[0].authored'),
      AUTHORED_PROJECTION_KEYS,
      'expressionSets[0].proposals[0].authored'
    );
    const zeroDisposition = asRecord(row.zeroDisposition, 'expressionSets[0].zeroDisposition');
    expectShapeMirrors(zeroDisposition, ZERO_DISPOSITION_KEYS, 'expressionSets[0].zeroDisposition');
    expectShapeMirrors(
      asRecord(zeroDisposition.authored, 'expressionSets[0].zeroDisposition.authored'),
      AUTHORED_PROJECTION_KEYS,
      'expressionSets[0].zeroDisposition.authored'
    );
    expect(contract.hostOwnedInputKeys).toEqual(keysOwnedBy(PRODUCER_OWNERSHIP_MAPS, 'host-owned'));
    expect(contract.hostSealedKeys).toEqual(keysOwnedBy(PRODUCER_OWNERSHIP_MAPS, 'host-sealed'));
    expect(contract.neverEmit).toEqual([...PRODUCER_NEVER_MODEL_AUTHORED_KEYS]);
    expect(contract.cardinality).toContain('never both, never neither');
  });

  it('states that the producer-non-draft review is host-sealed and names the never-authored fields', () => {
    expect(prompt).not.toContain('Per-hypothesis zero requires a Core producer-non-draft review');
    expect(prompt).toMatch(/host[^\n]*independent semantic review/iu);
    expect(prompt).toMatch(/never (?:author|fabricate)[^\n]*review/iu);
    for (const key of PRODUCER_NEVER_MODEL_AUTHORED_KEYS) {
      expect(prompt, `never-model-authored key ${key} must be named`).toContain(`"${key}"`);
    }
    expect(prompt).toContain("'producer-non-draft'");
  });

  it('accepts a contract-shaped row merged with host-owned keys and fails closed on an unsealed zero disposition', () => {
    const lineage = createProducerLineageFixture();
    const rowShape = firstRow(
      asRecord(readOutputContract(prompt).shape, 'shape').expressionSets,
      'shape.expressionSets'
    );
    const draftRow = {
      hypothesisId: 'hypothesis-handler',
      proposals: [{ expressionId: 'expression-1', kind: 'draft' as const, authored }],
      zeroDisposition: null,
    };
    expectWithinModelContract(draftRow, rowShape, 'expressionSets[0]');
    const hostOwned = {
      lineage,
      parentSet: null,
      modelHash: 'producer-model-v1',
      reasonHash: 'reason-initial-strict-authoring',
    };
    const { hypothesisId: _hypothesisId, ...draftInput } = draftRow;
    const set = createStrictProducerExpressionSetV1({ ...draftInput, ...hostOwned });
    expect(set.proposals.map((proposal) => proposal.expressionId)).toEqual(['expression-1']);
    expect(set.cardinality).toBe(1);
    expect(set.zeroDisposition).toBeNull();

    // 零处置提案按契约不带 producer-non-draft 回执；跨仓第二步落地前建集时即要求回执，
    // 所以宿主直接送入会 fail-closed，而不是把无审查的零处置封印。
    const zeroRow = {
      hypothesisId: 'hypothesis-handler',
      proposals: [],
      zeroDisposition: { reasonCode: 'no-durable-expression', authored },
    };
    expectWithinModelContract(zeroRow, rowShape, 'expressionSets[0]');
    expect(() =>
      createStrictProducerExpressionSetV1({
        ...hostOwned,
        proposals: zeroRow.proposals,
        zeroDisposition: zeroRow.zeroDisposition,
      } as unknown as CreateStrictProducerExpressionSetInputV1)
    ).toThrow();
  });

  it('keeps the fixture provider role marker and the proposal-only floor/filler guards', () => {
    expect(prompt.startsWith('You are the strict cold-start Producer')).toBe(true);
    expect(prompt).toMatch(/do not add filler/iu);
    expect(prompt).not.toMatch(/knowledge\.submit|targetRecipes|min(?:imum)?\s*3/iu);
    expect(prompt).not.toMatch(/at least\s+\d+\s+(?:candidate|proposal)/iu);
    expect(prompt).not.toContain("strictRoleSurface: 'strict-producer-v1'");
    expect(prompt).not.toContain('independent evidence auditor');
  });
});
