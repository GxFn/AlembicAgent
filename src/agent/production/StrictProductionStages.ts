import {
  createStrictAnalysisContextProjectionV1,
  type StrictAnalysisContextProjectionV1,
} from './StrictProductionPipeline.js';
import { buildStrictAnalystPrompt, buildStrictProducerPrompt } from './StrictProductionPrompts.js';

export interface StrictProductionGateResultV1 {
  readonly action?: string;
  readonly pass?: boolean;
  readonly reason?: string;
  readonly artifact?: unknown;
}

export interface StrictProductionRuntimePortV1 {
  readonly enabled: true;
  readonly context: StrictAnalysisContextProjectionV1;
  readonly populations: readonly unknown[];
  readonly buildProducerInput: (analysisArtifact: unknown) => Readonly<Record<string, unknown>>;
  readonly validateAnalystResult: (
    source: unknown
  ) => StrictProductionGateResultV1 | Promise<StrictProductionGateResultV1>;
  readonly reviewProducerResult: (
    source: unknown
  ) => StrictProductionGateResultV1 | Promise<StrictProductionGateResultV1>;
}

/**
 * 严格生产路径复用既有 PipelineStrategy。调用方提供经验证的 Agent/Core 端口；端口缺失时
 * 失败关闭，且任何阶段都不获得工具权限。
 */
export function buildStrictProductionPipelineStagesV1() {
  return [
    {
      name: 'analyze',
      capabilities: [],
      additionalTools: [],
      disableTracker: true,
      toolChoiceOverride: 'none',
      promptBuilder: (ctx: Record<string, unknown>) => {
        const strict = readStrictPort(ctx);
        return buildStrictAnalystPrompt({
          context: strict.context,
          populations: strict.populations,
        });
      },
    },
    {
      name: 'analyst_fixpoint_gate',
      gate: {
        evaluator: async (
          source: unknown,
          _phaseResults: Record<string, unknown>,
          strategyContext: Record<string, unknown>
        ) => invokeGatePort(() => readStrictPort(strategyContext).validateAnalystResult(source)),
        strictGate: {
          gate: 'G1',
          reasonCode: 'analyst-fixpoint-failed',
          owner: 'strict-analyst',
          resumePoint: 'analysis-fixpoint',
          permittedMutation: 'append-enrolled-analysis-epoch',
          passReasonCode: 'analyst-fixpoint-passed',
        },
      },
    },
    {
      name: 'produce',
      capabilities: [],
      additionalTools: [],
      disableTracker: true,
      toolChoiceOverride: 'none',
      promptBuilder: (ctx: Record<string, unknown>) => {
        const strict = readStrictPort(ctx);
        return buildStrictProducerPrompt(strict.buildProducerInput(ctx.gateArtifact));
      },
    },
    {
      name: 'independent_review_gate',
      gate: {
        evaluator: async (
          source: unknown,
          _phaseResults: Record<string, unknown>,
          strategyContext: Record<string, unknown>
        ) => invokeGatePort(() => readStrictPort(strategyContext).reviewProducerResult(source)),
        strictGate: {
          gate: 'G2',
          reasonCode: 'independent-review-failed',
          owner: 'independent-reviewer',
          resumePoint: 'review-frozen-evidence',
          permittedMutation: 'causal-authoring-repair',
          passReasonCode: 'independent-review-passed',
        },
      },
    },
  ];
}

async function invokeGatePort(
  operation: () => StrictProductionGateResultV1 | Promise<StrictProductionGateResultV1>
): Promise<StrictProductionGateResultV1> {
  try {
    return await operation();
  } catch (error: unknown) {
    return {
      action: 'reject',
      pass: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function readStrictPort(context: Record<string, unknown>): StrictProductionRuntimePortV1 {
  const value = context.strictProduction;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('STRICT_PRODUCTION_RUNTIME_PORT_REQUIRED');
  }
  const port = value as Partial<StrictProductionRuntimePortV1>;
  if (
    port.enabled !== true ||
    !port.context ||
    !Array.isArray(port.populations) ||
    typeof port.buildProducerInput !== 'function' ||
    typeof port.validateAnalystResult !== 'function' ||
    typeof port.reviewProducerResult !== 'function'
  ) {
    throw new Error('STRICT_PRODUCTION_RUNTIME_PORT_INVALID');
  }
  const { schemaVersion, contextHash, ...contextInput } = port.context;
  if (schemaVersion !== 1) {
    throw new Error('STRICT_ANALYSIS_CONTEXT_INVALID');
  }
  const normalizedContext = createStrictAnalysisContextProjectionV1(contextInput);
  if (normalizedContext.contextHash !== contextHash) {
    throw new Error('STRICT_ANALYSIS_CONTEXT_HASH_MISMATCH');
  }
  return { ...port, context: normalizedContext } as StrictProductionRuntimePortV1;
}
