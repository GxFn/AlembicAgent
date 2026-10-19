import type { EvolutionCandidateReason } from '@alembic/core/evolution';
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import type { AuditHint, ExistingRecipeForEvolution } from '../../prompts/insightEvolver.js';
import type { ToolCallEntry } from '../../runtime/AgentRuntimeTypes.js';
import type { AgentService } from '../../service/AgentService.js';
import {
  collectSuccessfulEvolutionIds,
  evolutionOutcome,
  isPersistedSubmission,
  readToolObservation,
} from '../../utils/toolOutcomes.js';
import { runFailure } from '../result.js';
import { buildSystemTaskRunInput, type SystemTaskRunSignals } from '../systemTaskRunInput.js';

export interface EvolutionAuditRecipe {
  id: string;
  title: string;
  trigger: string;
  content?: { markdown?: string; rationale?: string; coreCode?: string };
  sourceRefs?: string[];
  /**
   * 静态审计 hint，复用 Evolver 提示的 AuditHint：evidence.symbolsAlive / codeFilesExist 是计数
   * （与 Core RelevanceAuditResult.evidence 同义），不是 0..1 比例。
   */
  auditHint?: AuditHint | null;
  /**
   * diff-based 影响证据（增量 rescan 管线提供，此时 auditHint 为 null）。
   * 与 Core EvolutionAuditRecipe.impactEvidence 同形；buildEvolverPrompt 把它渲染为
   * 「变更影响（仅供定位）」。ExistingRecipeForEvolution.impactEvidence 的 reason 放宽为 string，
   * runEvolutionAudit 里的 satisfies 检查保证两份声明不再漂移。
   */
  impactEvidence?: {
    reason: EvolutionCandidateReason;
    affectedFiles: string[];
    impactScore: number;
    matchedTokens: string[];
  };
}

export interface EvolutionAuditProjectOverview {
  primaryLang: string;
  fileCount: number;
  modules: string[];
}

export interface EvolutionAuditResult {
  proposed: number;
  deprecated: number;
  skipped: number;
  iterations: number;
  toolCalls: number;
  reply: string;
}

export async function runEvolutionAudit({
  agentService,
  recipes,
  projectOverview,
  dimensionId = 'all',
  dimensionLabel = '全量进化审计',
  proposalSource,
  abortSignal,
  shouldAbort,
  timeoutMs,
}: {
  agentService: AgentService;
  recipes: EvolutionAuditRecipe[];
  projectOverview: EvolutionAuditProjectOverview;
  dimensionId?: string;
  dimensionLabel?: string;
  /** 传给 evolution-tools 的 source 字段（通过 sharedState 透传） */
  proposalSource?: string;
} & SystemTaskRunSignals): Promise<EvolutionAuditResult> {
  if (recipes.length === 0) {
    return { proposed: 0, deprecated: 0, skipped: 0, toolCalls: 0, iterations: 0, reply: '' };
  }

  // 完整性口径与 evolutionGateEvaluator 一致（L8-C17）：门控按期望 ID 逐个判 pending，
  // 所以下方的分母与 pending 都基于去重后的 ID，而不是可能含重复的 recipes.length。
  // 在 run 之前计算，使重复 ID 的诊断与本次 run 的成败无关。
  const expectedIds = uniqueAuditRecipeIds(recipes);

  const sharedState: Record<string, unknown> = {};
  if (proposalSource) {
    sharedState.evolutionProposalSource = proposalSource;
  }

  const strategyContext = {
    // 编译期对齐：审计输入必须能原样作为 Evolver 提示的 existingRecipes（含 impactEvidence）。
    existingRecipes: recipes satisfies ExistingRecipeForEvolution[],
    dimensionId,
    dimensionLabel,
    projectOverview,
    sharedState,
  };
  // 宿主取消/期限信号（L8-C01）只在传入时并入 execution；中止后的 run 状态不是 success，
  // 由下方 runFailure 原样抛出，不会被计成审计完成。
  const result = await agentService.run(
    buildSystemTaskRunInput({
      profileId: 'evolution-audit',
      params: { recipes, projectOverview, dimensionId, dimensionLabel },
      message: {
        role: 'internal',
        content: `请验证 ${recipes.length} 条 Recipe 的源码真实性并提交进化决策。`,
        metadata: { task: 'evolution-audit', dimensionId, dimensionLabel },
      },
      context: {
        source: 'system-workflow',
        runtimeSource: 'system',
        strategyContext,
      },
      signals: { abortSignal, shouldAbort, timeoutMs },
    })
  );

  if (result.status !== 'success') {
    throw runFailure(
      result,
      `Evolution audit failed with status ${result.status}: ${result.reply || 'empty reply'}`
    );
  }
  const audit = projectEvolutionAuditResult({
    reply: result.reply,
    toolCalls: result.toolCalls,
    iterations: result.usage.iterations,
  });
  const decisionIds = collectEvolutionDecisionIds(result.toolCalls, expectedIds);
  const pending = expectedIds.filter((id) => !decisionIds.has(id));
  if (pending.length > 0) {
    throw runFailure(
      result,
      `Evolution audit incomplete: decisions ${decisionIds.size}/${expectedIds.length}; pending=${pending.join(', ')}`
    );
  }
  return audit;
}

/**
 * 审计的期望 Recipe ID 集合（按首次出现顺序去重）。
 *
 * 当前唯一生产宿主的候选已在 Core RecipeImpactPlanner 按 recipeId 合并，正常不会出现重复；
 * 一旦出现，说明调用方的候选契约漂移了。这里不拒绝也不改写送给 Agent 的 recipes（门控同样
 * 按 ID 判完成，重复项不需要第二次决策），只在完整性判定上去重，并留下可定位的诊断。
 */
function uniqueAuditRecipeIds(recipes: readonly EvolutionAuditRecipe[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { id } of recipes) {
    if (seen.has(id)) {
      duplicates.add(id);
    } else {
      seen.add(id);
    }
  }
  if (duplicates.size > 0) {
    const duplicateIds = [...duplicates];
    // 诊断通道失败不能把一次已完成的审计升级为失败，所以经 observeSafely 隔离。
    observeSafely(
      () =>
        Logger.getInstance().warn(
          `[EvolutionAudit] duplicate recipe ids in audit input; completeness is judged on unique ids (duplicates=${duplicateIds.join(', ')}, recipes=${recipes.length}, unique=${seen.size})`,
          {
            reasonCode: 'evolution-audit-duplicate-recipe-ids',
            duplicateIds,
            recipeCount: recipes.length,
            uniqueRecipeCount: seen.size,
            resolution: 'dedupe-expected-ids',
          }
        ),
      () => undefined
    );
  }
  return [...seen];
}

export function projectEvolutionAuditResult({
  reply,
  toolCalls,
  iterations,
}: {
  reply: string;
  toolCalls: ToolCallEntry[];
  iterations: number;
}): EvolutionAuditResult {
  return {
    proposed: toolCalls.filter(
      (call) =>
        evolutionOutcome(call) === 'proposal' ||
        (isPersistedSubmission(call) &&
          typeof readToolObservation(call).params.supersedes === 'string' &&
          String(readToolObservation(call).params.supersedes).trim().length > 0)
    ).length,
    deprecated: toolCalls.filter((call) => evolutionOutcome(call) === 'deprecated').length,
    skipped: toolCalls.filter((call) => evolutionOutcome(call) === 'verified').length,
    iterations,
    toolCalls: toolCalls.length,
    reply: reply || '',
  };
}

/**
 * 公开兼容入口：返回已有成功决策的 Recipe ID 集合（expectedIds 非空时只含清单内 ID）。
 *
 * 与 evolutionGateEvaluator 共用 collectEvolutionDecisions 的按 Recipe 归并，runEvolutionAudit 的
 * 完整性判定也走这里，所以门控与完整性判定同一口径。注意 projectEvolutionAuditResult 的计数
 * 只共享单条回执的解析（evolutionOutcome），仍按单次工具调用计数，并不走这份归并。
 */
export function collectEvolutionDecisionIds(
  toolCalls: ToolCallEntry[],
  expectedIds: string[] = []
): Set<string> {
  return collectSuccessfulEvolutionIds(toolCalls, expectedIds);
}
