import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFrozenEvidenceProjection,
  IndependentValueReviewer,
  type IndependentValueReviewInputV1,
  type ReviewerIdentityV1,
} from '../src/agent/evaluation/IndependentValueReviewer.js';
import {
  assertFrozenJudgeModelLoadReceiptV1,
  createFrozenJudgeModelLoadReceiptV1,
  type FrozenJudgeModelLoadReceiptInputV1,
} from '../src/agent/evaluation/MiningJudge.js';
import {
  createStrictProductionSourceFixtureRuntimeV1,
  FrozenStrictProductionEvaluationProviderV1,
  type StrictProductionSourceFixtureV1,
} from '../src/agent/evaluation/StrictProductionFixtureEvaluation.js';
import { hashCanonical } from '../src/agent/production/strict/primitives.js';
import {
  type PlanContextProjectionV1,
  runStrictPlanAgent,
} from '../src/agent/runs/plan/PlanAgentRun.js';
import type { AgentRunResult } from '../src/agent/service/AgentRunContracts.js';

/**
 * 仓内规范哈希副本收敛的逐字节 golden（W1-10，L7-P27 C46；事项⑥已答复：只收敛副本、不改排序）。
 *
 * 收敛前仓内有五份 sortCanonical/hashCanonical：IndependentValueReviewer、MiningJudge、
 * StrictProductionFixtureEvaluation、runs/plan/PlanAgentRun 与 production/strict/primitives。
 * 下面的常量全部在收敛前（HEAD 4476c6f）录制：
 * - SHARED_GOLDEN：从五份副本逐份抽取实现，在同一组挑战输入上计算，五份结果逐字节相同
 *   （SPFE 副本只多 `sha256:` 前缀）。挑战输入覆盖 hu/da/lt 区域敏感键、嵌套数组、undefined
 *   成员、clusters/clusterSetHash 键对、整数键、`__proto__` 键、大小写与非 ASCII 键。
 * - 调用点 golden：经各副本所在模块的公开入口计算，覆盖 IVR decisionHash（裸 hex）、MiningJudge
 *   receiptHash（`sha256:` 前缀）、SPFE fixture 报告哈希（`sha256:` 前缀）、PlanAgentRun receiptId
 *   （`plan-cognition-receipt-` 前缀）。
 *
 * 收敛后四个调用点都复用 primitives 的 hashCanonical，各自保留前缀语义，同一组常量必须全部通过。
 * 任何字节差异都会让冻结回执被误判篡改、golden 报告哈希漂移：此时应停止并回报，不得改常量。
 * PlanAgentRun 的 receiptId 还经过 prompt 的 inputHash 与 Core hashStrictPlanIntentV1，那两者
 * 有意变化时须单独说明理由后重录，规范哈希本身的常量（SHARED_GOLDEN）不随之改动。
 */

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const PAYLOADS = {
  locale: {
    cs: 1,
    ct: 2,
    cz: 3,
    nested: { aa: 1, ab: 2, z: 3, iz: 4, y: 5, j: 6 },
    rows: [{ ty: 1, tz: 2 }],
  },
  nestedArrays: {
    matrix: [[{ b: 1, a: 2 }, [3, { z: [], y: {} }]], []],
    list: ['x', null, true, 0, -0, 1.5],
  },
  undefinedMembers: {
    keep: 1,
    drop: undefined,
    nested: { gone: undefined, here: null },
    list: [undefined, 1, { u: undefined, v: 2 }],
  },
  clusters: { clusterSetHash: 'h', clusters: [], schemaVersion: 1 },
  // JSON.parse 才能把 `__proto__` 写成自有数据键；整数键在序列化时总是排在最前（引擎属性序）。
  mixedKeys: JSON.parse(
    '{"Zeta":1,"alpha":2,"Alpha":3,"beta":4,"_under":5,"10":6,"9":7,"é":8,"z":9,"错误":10,"result":11,"__proto__":{"b":1,"a":2}}'
  ) as unknown,
  topArray: [{ refs: 1, refSet: 2 }, [{ B: 1, a: 2 }]],
  scalar: 'plain-string',
} as const;

type PayloadName = keyof typeof PAYLOADS;

/** text 是副本序列化出的规范 JSON，hash 是它的裸 sha256；两者都在收敛前从五份副本录得。 */
const SHARED_GOLDEN: Record<PayloadName, { readonly text: string; readonly hash: string }> = {
  locale: {
    text: '{"cs":1,"ct":2,"cz":3,"nested":{"aa":1,"ab":2,"iz":4,"j":6,"y":5,"z":3},"rows":[{"ty":1,"tz":2}]}',
    hash: '1df90ca154c17971ac9005a1fe9814ae4716fdf3d76051e67410beead13fcd7c',
  },
  nestedArrays: {
    text: '{"list":["x",null,true,0,0,1.5],"matrix":[[{"a":2,"b":1},[3,{"y":{},"z":[]}]],[]]}',
    hash: 'f371f2004584a05fa4c53d19ec86ef48bb2a00d082f4e14e2b8adba7e9161125',
  },
  undefinedMembers: {
    text: '{"keep":1,"list":[null,1,{"v":2}],"nested":{"here":null}}',
    hash: '633206934f0bf01b96f35604261000328a03f8be7c0a509945383fb32dc2fb2e',
  },
  clusters: {
    text: '{"clusters":[],"clusterSetHash":"h","schemaVersion":1}',
    hash: 'efdbbd0cfd14c1d192c1fa13ce8ad4b8586ec610396284599056d317097d8ede',
  },
  mixedKeys: {
    text: '{"9":7,"10":6,"__proto__":{"a":2,"b":1},"_under":5,"alpha":2,"Alpha":3,"beta":4,"é":8,"result":11,"z":9,"Zeta":1,"错误":10}',
    hash: '061e5f4d6da8b021e22901758b2604c4260ce24101aff6eccf0149dea01953a2',
  },
  topArray: {
    text: '[{"refs":1,"refSet":2},[{"a":2,"B":1}]]',
    hash: '62b5be5ab30bebd437402b4e52017aa438ed225d03943d6e1b6fbe23b4d84fde',
  },
  scalar: {
    text: '"plain-string"',
    hash: '69a35681d46c434bb666f849e810ab79aece20eb130665d6fdf0d9b433c8b842',
  },
};

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

/** 去掉回执自身的哈希字段，得到进入规范哈希的语义部分。 */
function withoutField<T extends object, K extends keyof T>(value: T, field: K): Omit<T, K> {
  const { [field]: _removed, ...rest } = value;
  return rest;
}

describe('agent-internal canonical hash golden (shared hashCanonical)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(
    Object.keys(SHARED_GOLDEN) as PayloadName[]
  )('keeps the %s payload byte-identical to the pre-convergence copies', (name) => {
    const golden = SHARED_GOLDEN[name];
    expect(sha256(golden.text)).toBe(golden.hash);
    expect(hashCanonical(PAYLOADS[name])).toBe(golden.hash);
  });

  it.each([
    'hu',
    'da',
    'lt',
  ])('keeps every golden payload when the process default collation is %s', (locale) => {
    simulateDefaultLocale(locale);
    for (const name of Object.keys(SHARED_GOLDEN) as PayloadName[]) {
      expect(hashCanonical(PAYLOADS[name]), name).toBe(SHARED_GOLDEN[name].hash);
    }
  });
});

/* ── IndependentValueReviewer：decisionHash 是裸 64 位 hex ─────────────────────────────────── */

const IVR_GOLDEN = {
  pass: '45af62daa3ec7b6ce5836cbdd3553585a9f663ac31f5ce3fb21e070a952541ec',
  sourceDriftReject: 'a3fe11f6f3dbd3cd0b42b81772d0489f9ddd32f7aa7419fd1cbe3d923c3cb5fd',
  identityCarrier: 'fecfa0f62411227fb165122a94cc35d4e9560d52e2c12564d17e4678a3dff12b',
} as const;

const REVIEW_CONTENT = '1|export function handler() {\n2|  return wrapResult(run);\n3|}';
const REVIEW_AXES = [
  'entailment',
  'contradiction-free',
  'project-specificity',
  'actionability',
  'scope-correctness',
  'retrieval-fitness',
] as const;
const PASS_REVIEW = JSON.stringify({
  axes: REVIEW_AXES.map((axis) => ({
    axis,
    verdict: 'pass',
    score: 2,
    reasonCode: 'supported',
    evidenceEntryIds: ['E-1'],
  })),
  noveltyDecision: 'novel-project-specific',
  duplicateDecision: 'no-match',
  citedLines: ['src/handler.ts:1', 'src/handler.ts:2-3'],
});
const REVIEWER_IDENTITY: ReviewerIdentityV1 = {
  provider: 'reviewer',
  model: 'independent',
  method: 'review',
};

function reviewInput(
  overrides: Partial<IndependentValueReviewInputV1> = {}
): IndependentValueReviewInputV1 {
  return {
    authored: {
      title: 'Preserve Result envelopes at handler boundaries',
      kind: 'rule',
      doClause: 'Return Result<T> from every handler',
      dontClause: 'Do not leak raw exceptions',
      markdown: 'Use the project Result envelope.',
      usageGuide: 'Apply when adding a handler.',
      retrievalProfile: { intents: ['handler error contract'] },
      negativeIntent: ['internal helper'],
      scope: { moduleIds: ['handlers'], dimensionIds: ['error-resilience'] },
      evidenceEntryIds: ['E-1'],
    },
    evidence: createFrozenEvidenceProjection({
      sourceRevisionVectorHash: 'vector-golden',
      entries: [
        {
          evidenceEntryId: 'E-1',
          relativePath: 'src/handler.ts',
          blobHash: 'blob-1',
          contentHash: sha256(REVIEW_CONTENT),
          startLine: 1,
          endLine: 3,
          content: REVIEW_CONTENT,
        },
      ],
    }),
    expectedSourceRevisionVectorHash: 'vector-golden',
    producerIdentity: 'producer/golden',
    admissionReceiptId: 'admission-golden',
    calibrationReceiptHash: 'calibration-golden',
    repairAttempt: 0,
    ...overrides,
  };
}

describe('IndependentValueReviewer decisionHash golden', () => {
  it('keeps the pass decision hash byte-identical', async () => {
    const reviewer = new IndependentValueReviewer({
      identity: REVIEWER_IDENTITY,
      chat: async () => PASS_REVIEW,
    });
    const decision = await reviewer.review(reviewInput());
    expect(decision.verdict).toBe('pass');
    expect(decision.decisionHash).toBe(IVR_GOLDEN.pass);
    expect(decision.decisionHash).toBe(hashCanonical(withoutField(decision, 'decisionHash')));
  });

  it('keeps the source-drift reject decision hash byte-identical', async () => {
    const reviewer = new IndependentValueReviewer({
      identity: REVIEWER_IDENTITY,
      chat: async () => PASS_REVIEW,
    });
    const decision = await reviewer.review(
      reviewInput({ expectedSourceRevisionVectorHash: 'vector-other' })
    );
    expect(decision.reasonCode).toBe('source-drift');
    expect(decision.decisionHash).toBe(IVR_GOLDEN.sourceDriftReject);
  });

  it('keeps locale-sensitive, nested and undefined identity members byte-identical', async () => {
    // reviewerIdentity 以展开拷贝原样进入 decision 语义；JS 调用方多带的成员会一并进入哈希。
    // 这里借它把挑战输入推过该调用点的规范哈希，钉住收敛前后同一字节。
    const carrierMembers = {
      ...PAYLOADS.clusters,
      probe: PAYLOADS.locale,
      arrays: PAYLOADS.nestedArrays,
      holes: PAYLOADS.undefinedMembers,
    };
    const carrierIdentity: ReviewerIdentityV1 = { ...REVIEWER_IDENTITY, ...carrierMembers };
    const decision = await new IndependentValueReviewer({
      identity: carrierIdentity,
      chat: async () => PASS_REVIEW,
    }).review(reviewInput({ expectedSourceRevisionVectorHash: 'vector-other' }));
    expect(decision.decisionHash).toBe(IVR_GOLDEN.identityCarrier);
  });
});

/* ── MiningJudge：receiptHash 是 `sha256:` + 裸 hex，undefined 成员与 JSON.stringify 省略一致 ── */

const MINING_JUDGE_GOLDEN = {
  explicit: 'sha256:38f38912472cef7b1fae1554dbd24b7d7b3addcd2323e86d88f7f6bef84ea36c',
  missingSelectionMode: 'sha256:8d47d671c693c928484a3680b4ae8d7fd9125049b0a0413edc113208c362f149',
  selectionModeCarrier: 'sha256:3a79c8dc810b7166e73c070f887bdc47cbe82c571f29dfdf6a1df8954bb8622c',
} as const;

const JUDGE_INPUT: FrozenJudgeModelLoadReceiptInputV1 = {
  selectionMode: 'explicit',
  requestedProvider: 'judge-provider',
  requestedModel: 'judge-model',
  resolvedProvider: 'judge-provider',
  resolvedModel: 'judge-model',
  temperature: 0,
  maxTokens: 1024,
  implementationModuleSha256: 'a'.repeat(64),
};

/** 只在运行时成立的输入（JS 调用方）：类型层面不允许，但回执函数不校验，这里原样转交。 */
function untypedJudgeInput(input: Record<string, unknown>): FrozenJudgeModelLoadReceiptInputV1 {
  return input as unknown as FrozenJudgeModelLoadReceiptInputV1;
}

describe('MiningJudge receiptHash golden', () => {
  it('keeps the explicit receipt hash byte-identical and still verifies it', () => {
    const receipt = createFrozenJudgeModelLoadReceiptV1(JUDGE_INPUT);
    expect(receipt.receiptHash).toBe(MINING_JUDGE_GOLDEN.explicit);
    expect(receipt.receiptHash).toBe(
      `sha256:${hashCanonical(withoutField(receipt, 'receiptHash'))}`
    );
    expect(() =>
      assertFrozenJudgeModelLoadReceiptV1(receipt, {
        resolvedProvider: 'judge-provider',
        resolvedModel: 'judge-model',
      })
    ).not.toThrow();
  });

  it('drops an undefined selectionMode member exactly as the old explicit filter did', () => {
    // 旧副本在排序前显式丢弃值为 undefined 的键；共享实现保留该键再由 JSON.stringify 省略，字节相同。
    const { selectionMode: _omitted, ...withoutMode } = JUDGE_INPUT;
    const receipt = createFrozenJudgeModelLoadReceiptV1(untypedJudgeInput(withoutMode));
    expect(receipt.selectionMode).toBeUndefined();
    expect(receipt.receiptHash).toBe(MINING_JUDGE_GOLDEN.missingSelectionMode);
  });

  it('keeps locale-sensitive, nested and undefined members byte-identical', () => {
    // selectionMode 只做相等比较，对象值会原样进入回执语义；借它把挑战输入推过该调用点的规范哈希。
    const receipt = createFrozenJudgeModelLoadReceiptV1(
      untypedJudgeInput({
        ...JUDGE_INPUT,
        selectionMode: {
          ...PAYLOADS.locale,
          ...PAYLOADS.clusters,
          arrays: PAYLOADS.nestedArrays,
          holes: PAYLOADS.undefinedMembers,
        },
      })
    );
    expect(receipt.receiptHash).toBe(MINING_JUDGE_GOLDEN.selectionModeCarrier);
  });
});

/* ── StrictProductionFixtureEvaluation：fixture 报告哈希带 `sha256:` 前缀 ─────────────────────── */

const SPFE_GOLDEN = {
  'alembic-workspace-single-file-value': {
    sourceRevisionVectorHash:
      'sha256:949c082d1ba93a482db0628441a42da5c3972a3e3efddce4ed4759da34604377',
    manifestHash: 'sha256:efe49d417a5a92897611c0da44b2a9c406358cd1959846a13ce8167b8001052f',
    planCognitionHash: 'sha256:b06b0004cb56784e1c49e15869a89b3b0de5f0e55bfb4605737766a0b3f51e1c',
    planHash: 'sha256:1f0a94f7657684ef8ead70e9db3283bf667af12d8c6ed17c9407c5b29bc1c59c',
    requiredUniverseHash: 'sha256:d91e1bc91166ab0e5619d653522b79a7c4425c731bfe7535ec5fe411cc143844',
    baselineScheduleHash: 'sha256:7f311f68106a1737193ca0898b5cfbd8f82b4850fb715ab4a7ebff9ef49ebc4c',
    currentExpandedScheduleHash:
      'sha256:a99c06bad6bdb1e7fdc56a3c63f14f238b62a8b50ee0e75564a5efba167712b4',
    analysisFixpointHash: 'sha256:4e763cf0a673c3873849733aacc410670c9f95bdf9d22d2532c3257146e9fc01',
    lensBindingsHash: 'sha256:ca9755163798174929f6c793954b02c65a0e9a1f6279c9c8b0bb5c51bbf2cbde',
    sourceArtifactHash: 'sha256:2ac16ab1a7aa2b79cff9a3c509feb0bdeaec977d09e5e9c736cae0bcb3c050b9',
    populationHashes: ['sha256:949c082d1ba93a482db0628441a42da5c3972a3e3efddce4ed4759da34604377'],
    clusterSetHashes: ['sha256:d426333deeea57ec9ab162dfe36680f52c4c6d1c2da5b3583d6a79873a4263ca'],
    inductionReceiptHashes: [
      'sha256:0f34a17fbf4ad265a9437566d4a0d40f0d7e608a8d0633396a5e41139f54c56f',
    ],
    hypothesisIds: ['sha256:18a8ea39a29310063ee2296ee9ad88e94b13134db962df279d55b37000328882'],
    falsificationReceiptHashes: [
      'sha256:1748c9fa0026c8f492a3d2c27e016331d9628f31f81a13171dceb4715c9377df',
    ],
    dispositionReviewIds: [
      'sha256:55e7938aaacbdc592c537961768141d9c069f6a96b7b334999d18b96152908af',
    ],
    snapshotHash: 'e2a99c2a311c32f9e3d497e5492f41188574091ebd4f9feca2ab622cc25652b5',
  },
  'bilidili-three-file-generic': {
    sourceRevisionVectorHash:
      'sha256:59e899715350357dbd75a49590396213c0e6cd6eabca91064e86a89394f7c13d',
    manifestHash: 'sha256:1f5f16a7c63650200ab775d089a23ff00db8d833f85d5458292f96255ea39cdf',
    planCognitionHash: 'sha256:1c1c383b1c5eec3487c789b90410a2d9c7a33a466c729129c9525fb26b59ebdb',
    planHash: 'sha256:4e01d3eada30b357adcc282699484657af3a8909b72bcbf974228fef72e41a46',
    requiredUniverseHash: 'sha256:2bdf14c80963c712ee1773f6ee15bee2dd42d2da9dc2df302ee49006de2c8c45',
    baselineScheduleHash: 'sha256:0f58c71eee8c3fec142df6a1419f80993dbac815b04e210f649b31f58e51f371',
    currentExpandedScheduleHash:
      'sha256:0ae28591ca2183f89161a256fe2b0af3ce5987f3efb031a0ab83b644df623607',
    analysisFixpointHash: 'sha256:8a65f2314112cf15ecf007aca98b313422a4fe0257c644e2a9d8e3022cb11fc7',
    lensBindingsHash: 'sha256:c1b9fa28ef57ee7b96d449378c47fe6e3c66a20634c3afe0948489c7e14b1fb5',
    sourceArtifactHash: 'sha256:061c1588845e15b0a3d12645515f577a571211b2962a6284656aab00092de6ca',
    populationHashes: ['sha256:59e899715350357dbd75a49590396213c0e6cd6eabca91064e86a89394f7c13d'],
    clusterSetHashes: ['sha256:2656d5b71d274c1a4c85703d3622c4fa2bc455152de3ef207c0d6e4a16286bd1'],
    inductionReceiptHashes: [],
    hypothesisIds: [],
    falsificationReceiptHashes: [],
    dispositionReviewIds: [
      'sha256:30184ec08f1e02055a6f5f83dde6f78fe413a3438105d2c60945cb50b1b19517',
    ],
    snapshotHash: '9814dd6d592f88c9d677b68af58035f12a06dca23dd94d1e77471a0c8dd292b2',
  },
} as const;

interface StrictGoldenCase extends StrictProductionSourceFixtureV1 {
  readonly fixturePath: string;
}

function strictGoldenCases(): StrictGoldenCase[] {
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), 'test/fixtures/strict-production/golden.json'), 'utf8')
  ) as { readonly cases: readonly StrictGoldenCase[] };
  return [...golden.cases];
}

describe('StrictProductionFixtureEvaluation report hash golden', () => {
  it('covers exactly the recorded strict golden cases', () => {
    expect(strictGoldenCases().map((fixture) => fixture.id)).toEqual(Object.keys(SPFE_GOLDEN));
  });

  it.each(
    Object.keys(SPFE_GOLDEN) as (keyof typeof SPFE_GOLDEN)[]
  )('keeps every fixture report hash of %s byte-identical', (caseId) => {
    const fixture = strictGoldenCases().find((candidate) => candidate.id === caseId);
    if (!fixture) {
      throw new Error(`TEST_STRICT_GOLDEN_CASE_MISSING: ${caseId}`);
    }
    const runtime = createStrictProductionSourceFixtureRuntimeV1({
      fixture: {
        id: fixture.id,
        project: fixture.project,
        expectedDisposition: fixture.expectedDisposition,
        sourceFiles: fixture.sourceFiles,
      },
      projectRoot: join(process.cwd(), 'test/fixtures/strict-production', fixture.fixturePath),
      provider: new FrozenStrictProductionEvaluationProviderV1(),
    });
    const epoch = runtime.runtimePort.readAnalysisEpoch();
    const context = epoch.context;
    expect({
      sourceRevisionVectorHash: runtime.sourceRevisionVectorHash,
      manifestHash: context.manifestHash,
      planCognitionHash: context.planCognitionHash,
      planHash: context.planHash,
      requiredUniverseHash: context.requiredUniverseHash,
      baselineScheduleHash: context.baselineScheduleHash,
      currentExpandedScheduleHash: context.currentExpandedScheduleHash,
      analysisFixpointHash: context.analysisFixpointHash,
      lensBindingsHash: context.lensBindingsHash,
      sourceArtifactHash: context.sourceArtifactHash,
      populationHashes: context.populationHashes,
      clusterSetHashes: context.clusterSetHashes,
      inductionReceiptHashes: context.inductionReceiptHashes,
      hypothesisIds: context.hypothesisIds,
      falsificationReceiptHashes: context.falsificationReceiptHashes,
      dispositionReviewIds: context.dispositionReviewIds,
      snapshotHash: epoch.snapshotHash,
    }).toEqual(SPFE_GOLDEN[caseId]);
    // 前缀语义：报告哈希 = `sha256:` + 共享规范哈希（裸 hex）。
    const sourceManifest = runtime.loadedSources.map(({ content: _content, ...source }) => source);
    expect(runtime.sourceRevisionVectorHash).toBe(`sha256:${hashCanonical(sourceManifest)}`);
  });
});

/* ── PlanAgentRun：receiptId 是 `plan-cognition-receipt-` + 裸 hex ───────────────────────────── */

const PLAN_GOLDEN = {
  initial:
    'plan-cognition-receipt-3722e3da61379c1bc2106716e43cfce2a08f52669705ab51c2b576b997687d6a',
  repaired:
    'plan-cognition-receipt-5432e9394b8e076e67a5b3bb99da90a590f5d34c9d9c3c009e03af960d033fc2',
  intentCarrier:
    'plan-cognition-receipt-18777019cd80aaff46df4fc04aa983d249997c3f406fee944babe27fb0975622',
} as const;

const QUESTION_BUDGET = {
  initialBreadth: 1,
  expansionReserve: 1,
  counterqueryReserve: 1,
  starvationGuard: 1,
};

const STRICT_INTENT = {
  generationStage: 'coldStart',
  projectProfile: { projectType: 'workspace', moduleCount: 2, fileCount: 2 },
  dimensions: [
    {
      dimensionId: 'architecture',
      priority: 1,
      rationale: 'trace real boundaries',
      targetRecipes: 0,
    },
  ],
  scale: { totalRecipeBudget: 0, depthLevels: ['project'] },
  moduleBindings: [],
  plannedNextActions: [
    {
      tool: 'facts.syntax',
      reason: 'inspect every required scope',
      order: 1,
      questionId: 'q-root',
      anatomyLensIds: ['structure-and-boundary'],
      subjectRefs: ['scope:workspace'],
      analysisScales: ['project'],
      capabilityId: 'facts.syntax',
      queryFamilyId: 'syntax-patterns',
      expectedSupport: ['boundary declarations'],
      expectedCounterevidence: ['unowned entrypoint'],
      priority: 'critical',
      budget: QUESTION_BUDGET,
    },
  ],
  evidenceRefs: [{ kind: 'project-context', ref: 'artifact:pcf' }],
  investigationDecomposition: {
    schemaVersion: 1,
    questions: [
      {
        questionId: 'q-root',
        subquestionIds: [],
        anatomyLensIds: ['structure-and-boundary'],
        subjectRefs: ['scope:workspace'],
        analysisScales: ['project'],
        capabilityIds: ['facts.syntax'],
        queryFamilyIds: ['syntax-patterns'],
        expectedSupport: ['boundary declarations'],
        expectedCounterevidence: ['unowned entrypoint'],
        synthesisTarget: 'workspace boundaries',
        uncertainty: 'cross-package ownership',
        stopCondition: 'all required scopes terminal',
        escalationCondition: 'backend unavailable',
        priority: 'critical',
        budget: QUESTION_BUDGET,
      },
    ],
  },
  budgetStrategy: {
    schemaVersion: 1,
    providerRequests: 3,
    detailRequests: 3,
    tokens: 10_000,
    timeMs: 10_000,
    costMicrousd: 0,
  },
};

function planContext(): PlanContextProjectionV1 {
  return {
    schemaVersion: 1,
    generationStage: 'coldStart',
    factsHash: 'facts-golden',
    catalogHash: 'catalog-golden',
    sourceRevisionVectorHash: 'source-vector-golden',
    sourceArtifactHash: 'artifact-golden',
    modelHash: 'frozen-plan-model',
    promptHash: 'frozen-plan-prompt',
    projectContextFacts: { scopes: [{ scopeId: 'scope:workspace', modulePath: 'src' }] },
    frozenCapabilityIds: ['facts.syntax'],
    frozenQueryFamilyIds: ['syntax-patterns'],
    hardCaps: { semanticRepairLimit: 2 },
  };
}

function planResult(reply: string): AgentRunResult {
  return {
    runId: 'strict-plan-golden-run',
    profileId: 'plan-selection',
    reply,
    status: 'success',
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
    diagnostics: null,
  };
}

/** failFirst=true 时首轮以白名单 PLAN_* 拒绝，得到带一次因果修复的 lineage。 */
async function strictPlanReceipt(intent: unknown, failFirst: boolean) {
  let validations = 0;
  return runStrictPlanAgent({
    agentService: { run: async () => planResult(JSON.stringify(intent)) },
    contextProjection: planContext(),
    validateReceipt: () => {
      validations += 1;
      if (failFirst && validations === 1) {
        throw new Error('PLAN_REQUIRED_LENS_UNSCHEDULED: golden repair');
      }
    },
  });
}

describe('PlanAgentRun receiptId golden', () => {
  it('keeps the initial receipt id byte-identical', async () => {
    const receipt = await strictPlanReceipt(STRICT_INTENT, false);
    expect(receipt.lineage.repairs).toHaveLength(0);
    expect(receipt.receiptId).toBe(PLAN_GOLDEN.initial);
    expect(receipt.receiptId).toBe(
      `plan-cognition-receipt-${hashCanonical(withoutField(receipt, 'receiptId'))}`
    );
  });

  it('keeps the repaired receipt id byte-identical', async () => {
    const receipt = await strictPlanReceipt(STRICT_INTENT, true);
    expect(receipt.lineage.repairs).toHaveLength(1);
    expect(receipt.receiptId).toBe(PLAN_GOLDEN.repaired);
  });

  it('keeps locale-sensitive, nested and special keys inside the intent byte-identical', async () => {
    // intent 以模型回复解析出的原对象进入回执语义，未知字段不被剔除；借它把挑战输入推过该调用点。
    const receipt = await strictPlanReceipt(
      {
        ...STRICT_INTENT,
        localeProbe: PAYLOADS.locale,
        arrayProbe: PAYLOADS.nestedArrays,
        clusterProbe: PAYLOADS.clusters,
        keyProbe: PAYLOADS.mixedKeys,
      },
      false
    );
    expect(receipt.receiptId).toBe(PLAN_GOLDEN.intentCarrier);
  });
});

/* ── 收敛守护：四个调用点只复用 primitives 的 hashCanonical，不再自带副本 ─────────────────── */

const CONVERGED_CALLERS = [
  'agent/evaluation/IndependentValueReviewer.ts',
  'agent/evaluation/MiningJudge.ts',
  'agent/evaluation/StrictProductionFixtureEvaluation.ts',
  'agent/runs/plan/PlanAgentRun.ts',
] as const;

interface CanonicalSurface {
  readonly declaredFunctions: readonly string[];
  readonly primitivesImports: readonly string[];
}

/** 用 TypeScript AST 读取文件内声明的规范哈希函数与从 primitives 导入的名字，注释与字符串不计入。 */
function readCanonicalSurface(relativeFile: string): CanonicalSurface {
  const absolute = path.join(SRC_ROOT, relativeFile);
  const source = ts.createSourceFile(
    absolute,
    readFileSync(absolute, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const declaredFunctions: string[] = [];
  const primitivesImports: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      ['hashCanonical', 'sortCanonical'].includes(node.name.text)
    ) {
      declaredFunctions.push(node.name.text);
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.endsWith('/production/strict/primitives.js') &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        primitivesImports.push((element.propertyName ?? element.name).text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { declaredFunctions, primitivesImports };
}

describe('canonical hash copies are converged into primitives', () => {
  it.each(
    CONVERGED_CALLERS
  )('%s reuses the shared hashCanonical without a private copy', (file) => {
    const surface = readCanonicalSurface(file);
    expect(surface.declaredFunctions, file).toEqual([]);
    expect(surface.primitivesImports, file).toContain('hashCanonical');
  });
});
