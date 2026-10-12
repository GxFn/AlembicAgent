import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalizeKnowledgeClustersV1,
  canonicalizeObservationPopulationV1,
  createAnalysisReviewContextHashV1,
  createFinalExpandedMiningScheduleReceiptV1,
} from '@alembic/core/production';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFrozenEvidenceProjection } from '../src/agent/evaluation/IndependentValueReviewer.js';
import {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisFixpointV1,
  createStrictProducerExpressionSetV1,
  createStrictProducerLineageReceiptV1,
  type StrictAnalystEpochInputV1,
  validateStrictAnalystEpochV1,
} from '../src/agent/production/StrictProductionPipeline.js';
import { hashCanonical } from '../src/agent/production/strict/primitives.js';
import { prepareRecipeProductionItem } from '../src/tools/runtime/handlers/recipeProductionAdapter.js';
import {
  createExecutionReceipt,
  createReview,
  createSingleHypothesisEpochFixture,
  STRICT_SOURCE_REVISION,
} from './fixtures/strict-semantic-authority.js';

/**
 * 仓内自用规范哈希的区域无关性钉子。
 *
 * 背景：epoch / lineage / expression 等回执哈希在序列化前用 localeCompare 排键。不带
 * locale 参数时它取进程默认区域：英文、中文环境顺序一致，但匈牙利语、丹麦语、立陶宛语等
 * 环境对 ASCII 标识符的排序不同（`cs` 排在 `cz` 之后、`aa` 排在 `z` 之后），同一份内容会
 * 算出不同的哈希。现在五份键排序都固定为 en 排序规则：英文、中文环境下的结果与历史哈希
 * 完全相同，其他区域下也得到同一个值。改成码元序会改变已持久化的哈希，不在本次范围内。
 */

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : target.endsWith('.ts') ? [target] : [];
  });
}

/** 模拟默认区域不同的进程：未显式指定 locale 的比较改用给定区域的排序规则。 */
function simulateDefaultLocale(locale: string) {
  const original = String.prototype.localeCompare;
  vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (
    this: string,
    that: string,
    locales?: Intl.LocalesArgument,
    options?: Intl.CollatorOptions
  ) {
    return original.call(this, that, locales ?? locale, options);
  });
}

describe('agent-internal canonical hashes do not depend on the process locale', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    'hu',
    'da',
    'lt',
  ])('keeps the hash when the process default collation is %s', (locale) => {
    const payload = {
      cs: 1,
      ct: 2,
      cz: 3,
      nested: { aa: 1, ab: 2, z: 3, iz: 4, y: 5, j: 6 },
      rows: [{ ty: 1, tz: 2 }],
    };
    const baseline = hashCanonical(payload);

    simulateDefaultLocale(locale);

    expect(hashCanonical(payload)).toBe(baseline);
  });

  it('keeps the legacy key order, so hashes produced before the pin still verify', () => {
    // 历史顺序把 `clusters` 排在 `clusterSetHash` 之前；码元序相反（大写 S 在前）。
    expect(hashCanonical({ clusterSetHash: 'h', clusters: [], schemaVersion: 1 })).toBe(
      sha256('{"clusters":[],"clusterSetHash":"h","schemaVersion":1}')
    );
  });

  it('pins the collation in every canonical key sorter', () => {
    // 五份 sortCanonical 各属一份回执编码合同，彼此不能互换，因此逐份检查而不是合并实现。
    const sorters = sourceFiles(SRC_ROOT)
      .map((file) => ({ file: path.relative(SRC_ROOT, file), source: readFileSync(file, 'utf8') }))
      .filter(({ source }) => /function sortCanonical\(/u.test(source));

    expect(sorters.map(({ file }) => file).sort()).toEqual([
      'agent/evaluation/IndependentValueReviewer.ts',
      'agent/evaluation/MiningJudge.ts',
      'agent/evaluation/StrictProductionFixtureEvaluation.ts',
      'agent/production/strict/primitives.ts',
      'agent/runs/plan/PlanAgentRun.ts',
    ]);
    for (const { file, source } of sorters) {
      const body = source.slice(source.indexOf('function sortCanonical('));
      const sorter = body.slice(0, body.indexOf('\n}\n'));
      expect(sorter, file).toContain("left.localeCompare(right, 'en')");
      expect(sorter, file).not.toMatch(/localeCompare\(right\)/u);
    }
  });
});

/**
 * 配方检索 profile 的 provenance 排序同样进入哈希：evidenceRefs / sourceFieldRefs 原样写进
 * Core retrievalProfile，Core 的 profileHash / documentSetHash 依赖它们的顺序。排序器不固定
 * 区域时，同一配方在不同默认区域的进程（守护进程与交互进程）里重新撰写会得到不同哈希，向量
 * 索引把未变化的配方判为过期。这里与 sortCanonical 一样固定为 en 排序规则；是否改为码元序
 * 以及已持久化哈希的迁移另行决定。
 */
describe('recipe production provenance order does not depend on the process locale', () => {
  const ADAPTER_FILE = 'tools/runtime/handlers/recipeProductionAdapter.ts';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pins the collation in every localeCompare of the recipe production adapter', () => {
    const source = readFileSync(path.join(SRC_ROOT, ADAPTER_FILE), 'utf8');
    const calls = source.match(/\.localeCompare\([^)]*\)/gu) ?? [];

    // 至少要有 distinctSorted 这一处；每一处都必须显式传 'en'，不允许回落进程默认区域。
    expect(calls.length, ADAPTER_FILE).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, ADAPTER_FILE).toMatch(/,\s*'en'\s*\)$/u);
    }
  });

  it.each([
    'hu',
    'da',
    'lt',
  ])('keeps the sourceFieldRefs order when the process default collation is %s', (locale) => {
    // 这些键在 hu/da/lt 下与 en 的相对顺序不同（`cs`/`cz`、`aa`/`z`、`iz`/`y`），足以暴露未固定区域的排序。
    const rawItem = {
      title: 'Locale pinned provenance',
      retrievalProfile: {
        primaryLanguage: 'en',
        summary: { primary: 'p', technicalEnglish: 't' },
        provenance: {
          sourceFieldRefs: ['field:cz', 'field:cs', 'field:z', 'field:aa', 'field:y', 'field:iz'],
        },
      },
    };
    const sourceFieldRefs = () =>
      prepareRecipeProductionItem(rawItem, SRC_ROOT).item.retrievalProfile?.provenance
        .sourceFieldRefs;
    const baseline = sourceFieldRefs();
    expect(baseline).toEqual([
      'field:aa',
      'field:cs',
      'field:cz',
      'field:iz',
      'field:y',
      'field:z',
    ]);

    simulateDefaultLocale(locale);

    expect(sourceFieldRefs()).toEqual(baseline);
  });
});

/**
 * 进入持久化哈希的数组元素顺序同样不能随进程默认区域变化。
 *
 * hashCanonical / hashCoreCanonical 只排对象键、不排数组，数组元素顺序由 strict 原语自己的
 * 比较器决定，直接进入 epochHash、setHash/authoredFingerprintHash/setId 与 projectionHash。
 * 这些比较器与键排序一样固定为 en 排序规则：英文、中文环境下 ASCII 标识符顺序与历史结果
 * 相同，无需迁移；码元序迁移另行决定。
 *
 * 下面的夹具都在默认区域（en）下构造，再在模拟的 hu/da/lt 默认区域下重算或跨进程复核：
 * - `aa` 在 da 下按 å 排到 z 之后；`cs` 在 hu 下是独立字母，排在 `cz` 之后；`y` 在 lt 下与 i
 *   同组、排在 `iz` 之前。
 * - Core 自身的比较器不在本仓范围内；epoch 夹具把两个假设放进两个 bounded-singleton 归纳，
 *   让 Core 不会互相比较这两个假设 ID，只有 Agent 侧的数组排序会暴露区域差异。
 */
describe('strict array orders inside canonical hashes do not depend on the process locale', () => {
  const LOCALE_SENSITIVE_SUFFIXES = ['z', 'cz', 'cs', 'aa', 'y', 'iz'] as const;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pins the collation in every localeCompare of the strict and evaluation hash modules', () => {
    // 判定“参与规范哈希”的口径：模块自身定义或调用 hashCanonical / sortCanonical / hashCoreCanonical。
    // 这类模块里的任何 localeCompare 都可能决定进入哈希的顺序，因此每一处都必须显式传 'en'。
    const hashModules = [
      path.join(SRC_ROOT, 'agent/production/strict'),
      path.join(SRC_ROOT, 'agent/evaluation'),
    ]
      .flatMap((directory) => sourceFiles(directory))
      .map((file) => ({ file: path.relative(SRC_ROOT, file), source: readFileSync(file, 'utf8') }))
      .filter(({ source }) =>
        /\b(?:hashCanonical|sortCanonical|hashCoreCanonical)\(/u.test(source)
      );

    expect(hashModules.map(({ file }) => file)).toEqual(
      expect.arrayContaining([
        'agent/evaluation/IndependentValueReviewer.ts',
        'agent/production/strict/analyst.ts',
        'agent/production/strict/expressions.ts',
        'agent/production/strict/lineage.ts',
        'agent/production/strict/primitives.ts',
      ])
    );
    for (const { file, source } of hashModules) {
      const calls = source.match(/\.localeCompare\(/gu) ?? [];
      // [^()]* 允许跨行参数；带嵌套括号的调用不会被计入 pinned，从而让计数不一致而失败。
      const pinned = source.match(/\.localeCompare\([^()]*,\s*'en'\s*\)/gu) ?? [];
      expect(pinned.length, file).toBe(calls.length);
    }
  });

  it.each([
    'hu',
    'da',
    'lt',
  ])('keeps the frozen evidence projection when the default collation is %s', (locale) => {
    const entries = evidenceEntries(LOCALE_SENSITIVE_SUFFIXES.map((suffix) => `E-${suffix}`));
    const baseline = createFrozenEvidenceProjection({
      sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
      entries,
    });
    expect(baseline.entries.map((entry) => entry.evidenceEntryId)).toEqual([
      'E-aa',
      'E-cs',
      'E-cz',
      'E-iz',
      'E-y',
      'E-z',
    ]);

    simulateDefaultLocale(locale);

    const projection = createFrozenEvidenceProjection({
      sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
      entries,
    });
    expect(projection.entries.map((entry) => entry.evidenceEntryId)).toEqual(
      baseline.entries.map((entry) => entry.evidenceEntryId)
    );
    expect(projection.projectionHash).toBe(baseline.projectionHash);
  });

  it.each([
    'hu',
    'da',
    'lt',
  ])('verifies an en-built evidence projection in a %s lineage process', (locale) => {
    // 跨进程复核：评审进程（en）冻结投影，Producer lineage 进程（另一默认区域）重算 projectionHash。
    const inputs = createLineageInputs(LOCALE_SENSITIVE_SUFFIXES.map((suffix) => `E-${suffix}`));
    const baseline = createStrictProducerLineageReceiptV1(inputs);

    simulateDefaultLocale(locale);

    const lineage = createStrictProducerLineageReceiptV1(inputs);
    expect(lineage.evidenceProjectionHash).toBe(inputs.evidence.projectionHash);
    expect(lineage.lineageHash).toBe(baseline.lineageHash);
  });

  it('keeps the analyst epoch hash when the default collation is da', () => {
    const input = createTwoHypothesisEpochInput();
    const baseline = validateStrictAnalystEpochV1(input);
    expect(baseline.hypothesisDispositions.map((row) => row.hypothesisId)).toEqual([
      'hypothesis-aa',
      'hypothesis-handler',
    ]);

    simulateDefaultLocale('da');

    const epoch = validateStrictAnalystEpochV1(input);
    expect(epoch.hypothesisDispositions.map((row) => row.hypothesisId)).toEqual(
      baseline.hypothesisDispositions.map((row) => row.hypothesisId)
    );
    expect(epoch.producerEligibleHypotheses.map((row) => row.hypothesisId)).toEqual(
      baseline.producerEligibleHypotheses.map((row) => row.hypothesisId)
    );
    expect(epoch.epochHash).toBe(baseline.epochHash);
  });

  it.each([
    'hu',
    'da',
    'lt',
  ])('keeps the producer expression set hashes when the default collation is %s', (locale) => {
    const { evidence: _evidence, ...lineageInputs } = createLineageInputs(['E-1']);
    const lineage = createStrictProducerLineageReceiptV1({
      ...lineageInputs,
      evidence: createFrozenEvidenceProjection({
        sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
        entries: evidenceEntries(['E-1']),
      }),
    });
    const input = {
      lineage,
      parentSet: null,
      proposals: LOCALE_SENSITIVE_SUFFIXES.map((suffix) => ({
        expressionId: `expression-${suffix}`,
        kind: 'draft' as const,
        authored: { ...AUTHORED, title: `${AUTHORED.title} ${suffix}` },
      })),
      zeroDisposition: null,
      modelHash: 'producer-model-v1',
      reasonHash: 'locale-pinned-expression-order',
    };
    const baseline = createStrictProducerExpressionSetV1(input);
    expect(baseline.proposals.map((proposal) => proposal.expressionId)).toEqual([
      'expression-aa',
      'expression-cs',
      'expression-cz',
      'expression-iz',
      'expression-y',
      'expression-z',
    ]);

    simulateDefaultLocale(locale);

    const set = createStrictProducerExpressionSetV1(input);
    expect(set.proposals.map((proposal) => proposal.expressionId)).toEqual(
      baseline.proposals.map((proposal) => proposal.expressionId)
    );
    expect(set.authoredFingerprintHash).toBe(baseline.authoredFingerprintHash);
    expect(set.setId).toBe(baseline.setId);
    expect(set.setHash).toBe(baseline.setHash);
  });
});

const AUTHORED = {
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

/** 每个条目一行内容，contentHash 与行范围自洽；输入顺序故意与 en 排序不同。 */
function evidenceEntries(evidenceEntryIds: readonly string[]) {
  return evidenceEntryIds.map((evidenceEntryId, index) => {
    const content = `export const evidence${index} = '${evidenceEntryId}';`;
    return {
      evidenceEntryId,
      relativePath: `src/evidence-${index}.ts`,
      blobHash: `blob-${index}`,
      contentHash: sha256(content),
      startLine: index + 1,
      endLine: index + 1,
      content,
    };
  });
}

/** 单假设 epoch + fixpoint + context + 冻结证据投影，全部在默认区域（en）下构造。 */
function createLineageInputs(evidenceEntryIds: readonly string[]) {
  const semantic = createSingleHypothesisEpochFixture();
  const epoch = validateStrictAnalystEpochV1(semantic.epochInput);
  const analysisFixpoint = createStrictAnalysisFixpointV1({
    finalExpandedSchedule: semantic.finalExpandedSchedule,
    terminalObligations: semantic.terminalObligations,
    epochs: [epoch],
  });
  const context = createStrictAnalysisContextProjectionV1({
    runId: 'run-1',
    journalId: 'journal-1',
    manifestHash: 'manifest-1',
    planCognitionHash: 'plan-cognition-1',
    planHash: 'plan-1',
    requiredUniverseHash: 'universe-1',
    baselineScheduleHash: semantic.finalExpandedSchedule.baselineScheduleHash,
    expansionHeadHash: null,
    currentExpandedScheduleHash: semantic.finalExpandedSchedule.finalExpandedScheduleHash,
    finalExpandedScheduleHash: semantic.finalExpandedSchedule.finalExpandedScheduleHash,
    analysisFixpointHash: analysisFixpoint.fixpointHash,
    privateCorpusRevision: null,
    hypothesisExpressionSetHash: null,
    lensBindingsHash: 'lens-1',
    sourceArtifactHash: 'artifact-1',
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
    evidenceEntryIds: [...evidenceEntryIds],
    derivedFindingCount: 0,
  });
  const evidence = createFrozenEvidenceProjection({
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    entries: evidenceEntries(evidenceEntryIds),
  });
  return { context, epoch, analysisFixpoint, hypothesisId: 'hypothesis-handler', evidence };
}

/**
 * 两个 bounded-singleton 簇各带一个假设：`hypothesis-aa` 在 en 下排在 `hypothesis-handler`
 * 之前，在 da 下排在之后。Core 只在各自归纳内排序单个假设，不比较这两个 ID。
 */
function createTwoHypothesisEpochInput(): StrictAnalystEpochInputV1 {
  const subjects = [
    {
      name: 'handler',
      factId: 'fact-handler',
      observationId: 'observation-handler',
      mechanismKey: 'handler-envelope',
      hypothesisId: 'hypothesis-handler',
    },
    {
      name: 'reader',
      factId: 'fact-reader',
      observationId: 'observation-reader',
      mechanismKey: 'reader-envelope',
      hypothesisId: 'hypothesis-aa',
    },
  ] as const;
  const receipts = subjects.map((subject) =>
    createExecutionReceipt({ name: subject.name, emittedFactIds: [subject.factId] })
  );
  const populationInput = {
    populationId: 'population-two-hypotheses',
    revision: 1,
    parentPopulationHash: null,
    sourceRevisionVectorHash: STRICT_SOURCE_REVISION,
    denominator: {
      kind: 'frozen-complete-subjects' as const,
      expectedObservationIds: subjects.map((subject) => subject.observationId),
      expectedObligationIds: receipts.map((receipt) => receipt.obligationId),
      executionReceiptHashes: receipts.map((receipt) => receipt.receiptHash),
      outputHashes: receipts.map((receipt) => receipt.outputHash),
      denominatorHashes: receipts.map((receipt) => receipt.denominatorHash),
      complete: true,
      truncated: false,
      continuation: null,
      omittedObservationIds: [],
    },
    executionReceipts: receipts,
    observations: subjects.map((subject, index) => ({
      observationId: subject.observationId,
      factIds: [subject.factId],
      obligationIds: [receipts[index]?.obligationId ?? ''],
      mechanismKey: subject.mechanismKey,
      canonicalSubjectRefs: [receipts[index]?.canonicalSubjectRef ?? ''],
      parentSubjectRefs: ['repo:repo'],
      variantKeys: [subject.name],
      outlierReasonCodes: [],
      negativeControl: false,
    })),
    duplicateObservations: [],
    excludedObservations: [],
    errorObservations: [],
    inspectedNoPatternObservations: [],
  };
  const clusterInputs = subjects.map((subject) => ({
    mechanismKey: subject.mechanismKey,
    mechanism: { invariant: `${subject.name} preserves typed Result envelopes` },
    observationIds: [subject.observationId],
    mechanismEvidenceFactIds: [subject.factId],
    anatomyLensIds: ['error-recovery-concurrency'] as const,
  }));
  const population = canonicalizeObservationPopulationV1(populationInput);
  const clusterSet = canonicalizeKnowledgeClustersV1(population, {
    clusters: clusterInputs,
    nonClusteredDispositions: [],
  });
  const finalExpandedSchedule = createFinalExpandedMiningScheduleReceiptV1({
    baselineScheduleHash: `sha256:${'a'.repeat(64)}`,
    baselineObligationIds: receipts.map((receipt) => receipt.obligationId),
    expansionReceipts: [],
  });
  const terminalObligations = receipts.map((receipt) => ({
    obligationId: receipt.obligationId,
    disposition: receipt.disposition,
    terminalReceiptId: receipt.terminalReceiptId,
  }));
  const currentAnalysisFixpointHash = createAnalysisReviewContextHashV1({
    finalExpandedScheduleHash: finalExpandedSchedule.finalExpandedScheduleHash,
    terminalObligations,
    populationHashes: [population.populationHash],
    clusterSetHashes: [clusterSet.clusterSetHash],
  });
  const applicability = { status: 'not-required' as const, reasonCode: 'bounded-api-contract' };
  const reviews = subjects.map((subject, index) =>
    createReview({
      reviewKind: 'falsification',
      currentAnalysisFixpointHash,
      populationHash: population.populationHash,
      proposal: {
        reviewKind: 'falsification',
        populationHash: population.populationHash,
        hypothesisId: subject.hypothesisId,
        enrolledCounterqueryIds: [],
        executions: [],
        counterqueryApplicability: applicability,
      },
      executionReceipts: receipts.slice(index, index + 1),
      finalExpandedSchedule,
      terminalObligations,
    })
  );
  return {
    currentAnalysisFixpointHash,
    knownFactIds: subjects.map((subject) => subject.factId),
    enrolledObligationIds: receipts.map((receipt) => receipt.obligationId),
    population: populationInput,
    clusterInputs,
    nonClusteredDispositions: [],
    inductionInputs: subjects.map((subject) => ({
      mechanismKey: subject.mechanismKey,
      mode: 'bounded-singleton' as const,
      hypotheses: [
        {
          hypothesisId: subject.hypothesisId,
          statement: `The ${subject.name} preserves the typed Result envelope`,
          premiseFactIds: [subject.factId],
        },
      ],
    })),
    falsificationInputs: subjects.map((subject, index) => {
      const dispositionReview = reviews[index];
      if (!dispositionReview) {
        throw new Error('TEST_TWO_HYPOTHESIS_REVIEW_MISSING');
      }
      return {
        hypothesisId: subject.hypothesisId,
        enrolledCounterqueryIds: [],
        executions: [],
        counterqueryApplicability: applicability,
        dispositionReview,
      };
    }),
    // 输入顺序与 en 排序相反，排序结果完全由 Agent 比较器决定。
    hypothesisDispositions: [...subjects]
      .reverse()
      .map((subject) => ({ hypothesisId: subject.hypothesisId, status: 'survived' as const })),
    dispositionReviews: reviews,
  };
}
