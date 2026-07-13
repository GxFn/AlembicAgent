import type { AgentDiagnostics, ToolCallEntry } from '../../runtime/AgentRuntimeTypes.js';
import type { AgentRunResult } from '../../service/AgentRunContracts.js';

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
  const toolCalls = result.toolCalls || [];
  const recipes = extractCreatedRecipes(toolCalls);
  if (recipes.length > 0) {
    const diagnostics = buildScanDiagnostics({ label, task, result, recipesFound: recipes.length });
    if (task === 'summarize') {
      const first = recipes[0];
      return {
        ...first,
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
    return { targetName: label, extracted: recipes.length, recipes, diagnostics };
  }

  const phases = result.phases as Record<string, PhaseSummary> | undefined;
  const produceReply = phases?.produce?.reply || result.reply;
  const fallbackValue = fallback(label || '');
  // 生产扫描的 Recipe 身份只能来自 knowledge.submit 的 persisted created envelope。
  // provider 回复仅保留为 runtime 诊断来源，零 submit 与失败 submit 都不能把它投影为 Recipe。
  const ignoredUnpersistedOutput = Boolean(produceReply?.trim());
  return {
    ...fallbackValue,
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
  return toolCalls
    .filter(isKnowledgeSubmitCall)
    .map((tc) => {
      const res = tc.result as Record<string, unknown> | null;
      if (!res || typeof res !== 'object' || res.status !== 'created') {
        return null;
      }
      const id = typeof res.id === 'string' ? res.id.trim() : '';
      const lifecycle = res.lifecycle;
      if (!id || (lifecycle !== 'pending' && lifecycle !== 'staging')) {
        return null;
      }
      return {
        ...res,
        id,
        candidateId: id,
        status: 'created' as const,
        lifecycle,
      };
    })
    .filter((recipe): recipe is ScanRecipe => Boolean(recipe));
}

function isKnowledgeSubmitCall(toolCall: ToolCallEntry): boolean {
  return (
    (toolCall.tool || toolCall.name) === 'knowledge' &&
    String(toolCall.args?.action || '') === 'submit'
  );
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
  const submitCalls = toolCalls.filter(isKnowledgeSubmitCall);
  const persistenceOutcome =
    recipesFound > 0
      ? 'created'
      : submitCalls.length > 0
        ? 'submit-without-created-recipe'
        : 'no-submit-attempt';
  return {
    label: label || '',
    task,
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
