import type { EvolutionCandidateReason } from '@alembic/core/evolution';
import type { ToolCallEntry } from '../../runtime/AgentRuntimeTypes.js';
import type { AgentService } from '../../service/AgentService.js';
import { collectSuccessfulEvolutionIds, evolutionOutcome } from '../../utils/toolOutcomes.js';

export interface EvolutionAuditRecipe {
  id: string;
  title: string;
  trigger: string;
  content?: { markdown?: string; rationale?: string; coreCode?: string };
  sourceRefs?: string[];
  auditHint?: {
    relevanceScore: number;
    verdict: string;
    evidence: {
      triggerStillMatches: boolean;
      symbolsAlive: number;
      depsIntact: boolean;
      codeFilesExist: number;
    };
    decayReasons: string[];
  } | null;
  /** diff-based 影响证据（增量 rescan 管线提供） */
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
}: {
  agentService: AgentService;
  recipes: EvolutionAuditRecipe[];
  projectOverview: EvolutionAuditProjectOverview;
  dimensionId?: string;
  dimensionLabel?: string;
  /** 传给 evolution-tools 的 source 字段（通过 sharedState 透传） */
  proposalSource?: string;
}): Promise<EvolutionAuditResult> {
  if (recipes.length === 0) {
    return { proposed: 0, deprecated: 0, skipped: 0, toolCalls: 0, iterations: 0, reply: '' };
  }

  const sharedState: Record<string, unknown> = {};
  if (proposalSource) {
    sharedState.evolutionProposalSource = proposalSource;
  }

  const strategyContext = {
    existingRecipes: recipes,
    dimensionId,
    dimensionLabel,
    projectOverview,
    sharedState,
  };
  const result = await agentService.run({
    profile: { id: 'evolution-audit' },
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
    presentation: { responseShape: 'system-task-result' },
  });

  const audit = projectEvolutionAuditResult({
    reply: result.reply,
    toolCalls: result.toolCalls,
    iterations: result.usage.iterations,
  });
  const decisionIds = collectEvolutionDecisionIds(
    result.toolCalls,
    recipes.map((r) => r.id)
  );
  if (decisionIds.size < recipes.length) {
    const pending = recipes.map((r) => r.id).filter((id) => !decisionIds.has(id));
    throw new Error(
      `Evolution audit incomplete: decisions ${decisionIds.size}/${recipes.length}; pending=${pending.join(', ')}`
    );
  }
  return audit;
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
    proposed: toolCalls.filter((call) => evolutionOutcome(call) === 'proposal').length,
    deprecated: toolCalls.filter((call) => evolutionOutcome(call) === 'deprecated').length,
    skipped: toolCalls.filter((call) => evolutionOutcome(call) === 'verified').length,
    iterations,
    toolCalls: toolCalls.length,
    reply: reply || '',
  };
}

/** 公开兼容入口；Gate 与结果投影共享同一业务结果判定。 */
export function collectEvolutionDecisionIds(
  toolCalls: ToolCallEntry[],
  expectedIds: string[] = []
): Set<string> {
  return collectSuccessfulEvolutionIds(toolCalls, expectedIds);
}
