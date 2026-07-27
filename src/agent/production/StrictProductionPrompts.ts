import type {
  StrictAnalysisEpochSnapshotV1,
  StrictAnalysisLoopLimitsV1,
  StrictProducerExpressionSetV1,
} from './StrictProductionPipeline.js';

/** 严格 Analyst 不接收数量目标；它消费冻结语义投影与完整 population，并通过登记端口扩展。 */
export function buildStrictAnalystPrompt(input: {
  readonly epoch: StrictAnalysisEpochSnapshotV1;
  readonly limits: StrictAnalysisLoopLimitsV1;
}): string {
  return [
    'You are the strict cold-start Analyst operating on immutable Core receipts.',
    'Consume the complete multiscale observation populations and preserve denominators, variants, and outliers.',
    'Own clustering, induction, falsification, narrowing, and refutation. Never invent a fact or infer one from prose.',
    'Every discard, zero-hypothesis, and falsification disposition must carry an independently bound Core KnowledgeDispositionReview receipt for the current analysis review context; reviewer strings are not authority.',
    'Exploration and every counterquery must be enrolled through the validated analysis expansion port before execution.',
    'Advance append-only epochs to a fixpoint. At fixpoint every observation and hypothesis needs a terminal disposition with owner/resume data for non-pass gates.',
    'There is no candidate floor, filler, top-N shortcut, fixed count, skip-on-fail, or degrade-to-success path.',
    `Analysis epoch: ${input.epoch.epoch} of ${input.limits.maxEpochs}`,
    `Obligation bound: ${input.epoch.context.factQueryObligationIds.length} of ${input.limits.maxObligations}`,
    `Terminal obligations: ${JSON.stringify(input.epoch.terminalObligationIds)}`,
    `Outstanding obligations: ${JSON.stringify(input.epoch.outstandingObligationIds)}`,
    `Strict context: ${JSON.stringify(input.epoch.context)}`,
    `Complete populations: ${JSON.stringify(input.epoch.populations)}`,
  ].join('\n');
}

/** 严格 Producer 只起草 typed proposals；持久化与复核属于下游独立阶段。 */
export function buildStrictProducerPrompt(
  expressionSet: StrictProducerExpressionSetV1 | Readonly<Record<string, unknown>>
): string {
  return [
    'You are the strict cold-start Producer.',
    'Author proposal expressions only from the survived or narrowed hypothesis and its immutable analysis fixpoint.',
    'Return the typed expression set exactly as 0, 1, or N evidence-grounded proposals. Per-hypothesis zero requires a Core producer-non-draft review and complete authored projection; whole-run investigated-empty is a separate Core execution-denominator decision.',
    'The downstream terminal consumer must conserve every expression identity and Agent-derived authored fingerprint into a Core HypothesisExpressionSet receipt.',
    'Do not call tools, execute fact queries, persist data, perform admission, or review your own work.',
    'Do not add filler, quota padding, duplicated wording, or claims outside cited evidence.',
    'Every expression must include the full authoring projection: title, kind, do/dont clauses, markdown, usage guide, retrieval profile, negative intent, scope, and evidence entry IDs.',
    `Expression set input: ${JSON.stringify(expressionSet)}`,
  ].join('\n');
}
