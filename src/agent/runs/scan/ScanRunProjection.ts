import type { AgentDiagnostics, ToolCallEntry } from '../../runtime/AgentRuntimeTypes.js';
import type { AgentRunResult } from '../../service/AgentRunContracts.js';
import {
  isKnowledgeSubmit,
  isPersistedSubmission,
  readToolObservation,
} from '../../utils/toolOutcomes.js';

export interface ScanRecipe extends Record<string, unknown> {
  id: string;
  candidateId: string;
  status: 'created';
  lifecycle: 'pending' | 'staging';
  title?: string;
  description?: string;
  summary?: string;
  usageGuide?: string;
  category?: string;
  headers?: string[];
  tags?: string[];
  trigger?: string;
}

export interface ScanProjectionOptions {
  label?: string;
  task: 'extract' | 'summarize';
  result: AgentRunResult;
  fallback: (label: string) => Record<string, unknown>;
  onParseError?: (err: unknown) => void;
}

export interface ScanKnowledgeProjection extends Record<string, unknown> {
  error?: string;
}

interface PhaseSummary {
  reply?: string;
  toolCalls?: ToolCallEntry[];
}

export function projectScanRunResult({
  label,
  task,
  result,
  fallback,
}: ScanProjectionOptions): ScanKnowledgeProjection {
  const failure =
    result.status === 'success'
      ? {}
      : { error: `Scan failed with status ${result.status}: ${result.reply || 'empty reply'}` };
  const toolCalls = result.toolCalls || [];
  const recipes = extractCreatedRecipes(toolCalls);
  if (recipes.length > 0) {
    const diagnostics = buildScanDiagnostics({ label, task, result, recipesFound: recipes.length });
    if (task === 'summarize') {
      const first = recipes[0];
      return {
        ...first,
        ...failure,
        title: first.title || '',
        summary: first.description || first.summary || '',
        usageGuide: first.usageGuide || '',
        category: first.category || '',
        headers: first.headers || [],
        tags: first.tags || [],
        trigger: first.trigger || '',
        recipes,
        extracted: recipes.length,
        diagnostics,
      };
    }
    return { targetName: label, extracted: recipes.length, recipes, diagnostics, ...failure };
  }

  const phases = result.phases as Record<string, PhaseSummary> | undefined;
  const produceReply = phases?.produce?.reply || result.reply;
  const fallbackValue = fallback(label || '');
  // 生产扫描的 Recipe 身份只能来自 knowledge.submit 的 persisted created envelope。
  // provider 回复仅保留为 runtime 诊断来源，零 submit 与失败 submit 都不能把它投影为 Recipe。
  const ignoredUnpersistedOutput = Boolean(produceReply?.trim());
  return {
    ...fallbackValue,
    ...failure,
    diagnostics: buildScanDiagnostics({
      label,
      task,
      result,
      recipesFound: 0,
      usedFallback: true,
      ignoredUnpersistedOutput,
    }),
  };
}

export function extractCreatedRecipes(toolCalls: ToolCallEntry[]): ScanRecipe[] {
  return toolCalls.filter(isPersistedSubmission).map((call) => {
    // isPersistedSubmission 验证完整 envelope 和业务回执，之后再投影规范化 payload。
    const receipt = readToolObservation(call).result;
    const id = (receipt.id as string).trim();
    return {
      ...receipt,
      id,
      candidateId: id,
      status: 'created' as const,
      lifecycle: receipt.lifecycle as ScanRecipe['lifecycle'],
    };
  });
}

function buildScanDiagnostics({
  label,
  task,
  result,
  recipesFound,
  usedFallback = false,
  parseError = null,
  ignoredUnpersistedOutput = false,
}: {
  label?: string;
  task: 'extract' | 'summarize';
  result: AgentRunResult;
  recipesFound: number;
  usedFallback?: boolean;
  parseError?: string | null;
  ignoredUnpersistedOutput?: boolean;
}) {
  const phases = result.phases as Record<string, PhaseSummary> | undefined;
  const toolCalls = result.toolCalls || [];
  const collectCalls = toolCalls.filter((tc) => (tc.tool || tc.name) === 'knowledge');
  const submitCalls = toolCalls.filter(isKnowledgeSubmit);
  const persistenceOutcome =
    recipesFound > 0
      ? 'created'
      : submitCalls.length > 0
        ? 'submit-without-created-recipe'
        : 'no-submit-attempt';
  return {
    label: label || '',
    task,
    runStatus: result.status,
    recipesFound,
    persistenceOutcome,
    projectionAuthority: 'persisted-knowledge-submit-results-only',
    usedFallback,
    ignoredUnpersistedOutput,
    parseError,
    toolCallCount: toolCalls.length,
    collectScanRecipeCallCount: collectCalls.length,
    knowledgeSubmitCallCount: submitCalls.length,
    iterations: result.usage.iterations || 0,
    durationMs: result.usage.durationMs || 0,
    runtimeDiagnostics: (result.diagnostics as AgentDiagnostics | null) || null,
    phases: Object.fromEntries(
      Object.entries(phases || {}).map(([phaseName, phase]) => [
        phaseName,
        {
          replyLength: phase.reply?.length || 0,
          toolCallCount: phase.toolCalls?.length || 0,
        },
      ])
    ),
  };
}
