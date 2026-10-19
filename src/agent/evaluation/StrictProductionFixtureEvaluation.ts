import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import {
  createStrictAnalysisContextProjectionV1,
  createStrictAnalysisEpochSnapshotV1,
  createStrictAnalysisExpansionPortV1,
  createStrictAnalysisGateOutcomeV1,
} from '../production/StrictProductionPipeline.js';
import type { StrictProductionRuntimePortV1 } from '../production/StrictProductionStages.js';
import type { LLMResult } from '../runtime/AgentRuntimeTypes.js';

// 惰性取 Logger 单例：模块导入期不做任何工作，与 evaluation 目录其他模块同一写法。
const logger = () => Logger.getInstance();

/**
 * 冻结 provider 的身份名，同时也是 eval 脚本 `--provider` 选择冻结 provider 的 CLI 取值。
 * 类字段与严格 golden 预检共用这一处，避免两边各写一份字面量后漂移。
 */
const FROZEN_STRICT_FIXTURE_PROVIDER_NAME = 'frozen-fixture';

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
  readonly name = FROZEN_STRICT_FIXTURE_PROVIDER_NAME;
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

/**
 * 严格 golden 预检（eval 脚本在解析任何真实 provider 之前调用）。
 *
 * 带 expectedDisposition 的 case 会被注入冻结 runtime port：候选由源码标记预先决定、与模型无关，
 * 只有冻结 provider 的 FrozenStrictStageReplyV1 回复能通过阶段校验。若让真实 provider 跑这些 case，
 * 正例会被未编码的解析错误拒绝，负例按 candidateCount=0 记为 passed，回执却带着真实 provider 身份。
 * 因此只要 golden 里有这类 case，`--provider` 必须显式选择冻结 provider；不含这类 case 的普通挖掘
 * golden 不受影响，真实 provider 仍可评估。
 *
 * requestedProvider 是 CLI `--provider` 的原值：未传为 undefined（脚本会走自动探测），裸 flag 为 true。
 * 判定条件与脚本注入冻结 runtime 的条件一致（expectedDisposition 为真值）。
 */
export function assertStrictFixtureGoldenProviderV1(input: {
  readonly cases: readonly unknown[];
  readonly requestedProvider: unknown;
}): void {
  const strictCaseIds = input.cases.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const record = entry as { readonly id?: unknown; readonly expectedDisposition?: unknown };
    if (!record.expectedDisposition) {
      return [];
    }
    return [typeof record.id === 'string' && record.id ? record.id : `#${index}`];
  });
  if (
    strictCaseIds.length === 0 ||
    input.requestedProvider === FROZEN_STRICT_FIXTURE_PROVIDER_NAME
  ) {
    return;
  }
  const requested =
    input.requestedProvider === undefined
      ? '<auto-detect>'
      : typeof input.requestedProvider === 'string'
        ? input.requestedProvider
        : `<invalid:${typeof input.requestedProvider}>`;
  throw new Error(
    `STRICT_FIXTURE_PROVIDER_NOT_FROZEN:requested=${requested} required=${FROZEN_STRICT_FIXTURE_PROVIDER_NAME} strictCases=${strictCaseIds.join(',')}`
  );
}

/** Reads and hash-verifies source bytes before constructing the strict runtime port. */
export function createStrictProductionSourceFixtureRuntimeV1(input: {
  readonly fixture: StrictProductionSourceFixtureV1;
  readonly projectRoot: string;
  readonly provider: FrozenStrictProductionEvaluationProviderV1;
}) {
  // 参数类型只在编译期生效，.mjs 调用方（eval 脚本）可以把真实 provider 传进来。冻结 runtime 的
  // 候选与模型无关，真实 provider 只会让正例因回复形状不符被拒、负例空洞通过，并把真实身份写进
  // providerIdentity。因此在读取任何 fixture 字节之前按类身份拒绝；只抄 name/model 的鸭子类型
  // 冒充者同样拒绝，因为它的回复不受冻结 provider 约束。
  assertFrozenStrictFixtureProvider(input.provider);
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
  const baselineScheduleHash = hashCanonical({ fixture: input.fixture.id, schedule: 'baseline' });
  const factQueryObligationIds = sourceManifest.map((source) => `inspect:${source.sha256}`);
  const expansionPort = createStrictAnalysisExpansionPortV1({
    baselineScheduleHash,
    baselineObligationIds: factQueryObligationIds,
    knownFactFamilies: [],
    knownSubjectRefs: [],
    obligationCap: Math.max(1, factQueryObligationIds.length),
  });
  const finalExpandedScheduleHash = expansionPort.seal().finalExpandedScheduleHash;
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
    baselineScheduleHash,
    expansionHeadHash: null,
    currentExpandedScheduleHash: hashCanonical({ fixture: input.fixture.id, schedule: 'current' }),
    finalExpandedScheduleHash,
    analysisFixpointHash: hashCanonical({ fixture: input.fixture.id, fixpoint: sourceManifest }),
    privateCorpusRevision: null,
    hypothesisExpressionSetHash: null,
    lensBindingsHash: hashCanonical({ lens: 'structure-and-boundary', sourceManifest }),
    sourceArtifactHash: hashCanonical({ fixture: input.fixture.id, sourceManifest }),
    sourceRevisionVectorHash,
    questionIds: [`fixture-question-${input.fixture.id}`],
    factQueryObligationIds,
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
  const analysisEpoch = createStrictAnalysisEpochSnapshotV1({
    epoch: 1,
    context,
    populations: createFrozenSourcePopulations(sourceRevisionVectorHash, loadedSources),
    terminalObligationIds: context.factQueryObligationIds,
    outstandingObligationIds: [],
  });
  const runtimePort = createFrozenFixtureRuntimePort({
    analysisEpoch,
    expansionPort,
    sourceDisposition,
    sourceRevisionVectorHash,
    sourceManifest,
    candidate,
    capturedCandidates,
  });
  return Object.freeze({
    runtimePort,
    loadedSources,
    sourceRevisionVectorHash,
    providerIdentity,
    capturedCandidates,
    expectedCandidateCount: candidate ? 1 : 0,
  });
}

function createFrozenSourcePopulations(
  sourceRevisionVectorHash: string,
  sources: readonly (LoadedStrictProductionSourceV1 & { readonly evidenceEntryId: string })[]
) {
  return [
    {
      kind: 'FrozenSourcePopulationV1',
      sourceRevisionVectorHash,
      observations: sources.map((source) => ({
        evidenceEntryId: source.evidenceEntryId,
        relativePath: source.path,
        contentHash: source.sha256,
        lineCount: source.lineCount,
        content: source.content,
      })),
    },
  ];
}

function createFrozenFixtureRuntimePort(input: {
  readonly analysisEpoch: ReturnType<typeof createStrictAnalysisEpochSnapshotV1>;
  readonly expansionPort: ReturnType<typeof createStrictAnalysisExpansionPortV1>;
  readonly sourceDisposition: StrictProductionSourceFixtureV1['expectedDisposition'];
  readonly sourceRevisionVectorHash: string;
  readonly sourceManifest: readonly unknown[];
  readonly candidate: StrictProductionEvaluationCandidateV1 | null;
  readonly capturedCandidates: StrictProductionEvaluationCandidateV1[];
}): StrictProductionRuntimePortV1 {
  let analystValidated = false;
  return {
    enabled: true,
    analysisLimits: {
      maxEpochs: 1,
      maxObligations: input.analysisEpoch.context.factQueryObligationIds.length,
    },
    expansionPort: input.expansionPort,
    readAnalysisEpoch: () => input.analysisEpoch,
    buildProducerInput: (analysisArtifact) => ({
      kind: 'StrictSourceProducerInputV1',
      analysisArtifact,
      sourceRevisionVectorHash: input.sourceRevisionVectorHash,
    }),
    validateAnalystResult: (source, observedEpoch) => {
      assertFrozenStageReply(source, 'analyst', input.sourceDisposition);
      analystValidated = true;
      return createStrictAnalysisGateOutcomeV1({
        action: 'pass',
        reasonCode: 'frozen-fixture-fixpoint-stable',
        observedEpochHash: observedEpoch.snapshotHash,
        artifact: {
          kind: 'StrictSourceAnalysisArtifactV1',
          sourceRevisionVectorHash: input.sourceRevisionVectorHash,
          sourceManifest: input.sourceManifest,
          disposition: input.sourceDisposition,
        },
      });
    },
    reviewProducerResult: (source) => {
      if (!analystValidated) {
        throw new Error('STRICT_FIXTURE_ANALYST_NOT_VALIDATED');
      }
      assertFrozenStageReply(source, 'producer', input.sourceDisposition);
      if (input.candidate) {
        input.capturedCandidates.push(input.candidate);
      }
      return {
        action: 'pass',
        pass: true,
        artifact: {
          kind: 'StrictSourceReviewDecisionV1',
          verdict: input.candidate ? 'uphold' : 'investigated-empty',
          candidateCount: input.candidate ? 1 : 0,
          sourceRevisionVectorHash: input.sourceRevisionVectorHash,
        },
      };
    },
  };
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

function assertFrozenStrictFixtureProvider(provider: unknown): void {
  if (provider instanceof FrozenStrictProductionEvaluationProviderV1) {
    return;
  }
  throw new Error(`STRICT_FIXTURE_PROVIDER_NOT_FROZEN:${describeProviderIdentity(provider)}`);
}

function describeProviderIdentity(provider: unknown): string {
  if (!provider || typeof provider !== 'object') {
    return 'provider=<missing>';
  }
  const { name, model } = provider as { readonly name?: unknown; readonly model?: unknown };
  return `provider=${typeof name === 'string' ? name : '<unnamed>'} model=${typeof model === 'string' ? model : '<unknown>'}`;
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
  // 冻结 provider 的回复必然是 FrozenStrictStageReplyV1 JSON；解析失败或不是对象说明回复来自
  // 别处（例如被换成真实模型）。统一归为带阶段码的 REPLY_INVALID，而不是让原生 SyntaxError /
  // TypeError 以无码文本流进 strict gate 的拒绝原因里。
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch (err: unknown) {
    throw rejectFrozenStageReply({
      phase: expectedPhase,
      reason: 'not-json',
      replyLength: reply.length,
      detail: err instanceof Error ? err.message : String(err),
      cause: err,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw rejectFrozenStageReply({
      phase: expectedPhase,
      reason: 'not-object',
      replyLength: reply.length,
      detail: `json-type=${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}`,
    });
  }
  const fields = parsed as { kind?: unknown; phase?: unknown; disposition?: unknown };
  if (
    fields.kind !== 'FrozenStrictStageReplyV1' ||
    fields.phase !== expectedPhase ||
    fields.disposition !== expectedDisposition
  ) {
    throw rejectFrozenStageReply({
      phase: expectedPhase,
      reason: 'shape-mismatch',
      replyLength: reply.length,
      detail: `kind=${describeReplyField(fields.kind)} phase=${describeReplyField(fields.phase)} disposition=${describeReplyField(fields.disposition)} expectedDisposition=${expectedDisposition}`,
    });
  }
}

/**
 * 冻结阶段回复的拒绝出口：先打一条 warn 诊断（阶段、原因码、回复长度、解析细节），再返回带码的
 * Error 交给调用方抛出。strict gate 会把它转成 reject，诊断行让“回复不是冻结形状”与真实语义拒绝
 * 可以区分。不整段记录回复正文：只记长度，以及 JSON 解析错误自带的短片段或截断到 40 字符的字段值。
 */
function rejectFrozenStageReply(input: {
  readonly phase: 'analyst' | 'producer';
  readonly reason: 'not-json' | 'not-object' | 'shape-mismatch';
  readonly replyLength: number;
  readonly detail: string;
  readonly cause?: unknown;
}): Error {
  const code = `STRICT_FIXTURE_${input.phase.toUpperCase()}_REPLY_INVALID`;
  observeSafely(
    () =>
      logger().warn(
        `[StrictFixtureEvaluation] phase=${input.phase} action=reject reason=${input.reason} ` +
          `code=${code} replyLength=${input.replyLength} detail="${input.detail}"`
      ),
    () => undefined
  );
  const message = `${code}:${input.reason} (${input.detail})`;
  return input.cause === undefined
    ? new Error(message)
    : new Error(message, { cause: input.cause });
}

function describeReplyField(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  }
  return `<${value === null ? 'null' : typeof value}>`;
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

/**
 * 本副本直接输出带 `sha256:` 前缀的哈希，fixture 报告与 golden 记录按此前缀格式比对。
 *
 * 规范哈希副本登记（L7-P27/C46）：仓内共五份 sortCanonical/hashCanonical，分别在
 * IndependentValueReviewer、MiningJudge、StrictProductionFixtureEvaluation、
 * production/strict/primitives 与 runs/plan/PlanAgentRun；各自是一份独立回执编码合同，
 * 键排序统一固定为 en 排序规则，由 test/strict-canonical-locale.test.ts 逐份钉住。
 * 收敛为 agent 内部共享工具（不进公开子路径）与改用码元序都待决定⑥：在那之前不得单独
 * 修改任何一份的排序规则或输出形状，否则冻结回执会被误判篡改、golden 报告哈希漂移。
 */
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
      // 固定 en 排序规则：与历史哈希逐字节一致，且不随进程默认区域变化。
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, child]) => [key, sortCanonical(child)])
  );
}
