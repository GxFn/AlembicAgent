import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
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
  /**
   * 未持久化回退告警（L8-C08 方案 a）。投影只认 knowledge.submit 的 created 回执、不再解析 provider 文本，
   * 因此“解析失败”在这里的含义是：本次扫描没有可投影的已持久化 Recipe、只能返回任务 fallback。
   * 此时经 observeSafely 调用一次，传入描述原因的 Error；有 created 回执时不调用。
   */
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
  onParseError,
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
  const diagnostics = buildScanDiagnostics({
    label,
    task,
    result,
    recipesFound: 0,
    usedFallback: true,
    ignoredUnpersistedOutput,
  });
  reportScanFallback(diagnostics, onParseError);
  return {
    ...fallbackValue,
    ...failure,
    diagnostics,
  };
}

/**
 * 回退通知（L8-C08 方案 a）：零 submit、submit 未产出 created 回执（被拒/失败），以及中止/超时后
 * 没有回执的扫描都走到这里。warn 与 onParseError 只携带 label、task、runStatus、persistenceOutcome
 * 和计数，不记录 provider 回复正文；两者各自经 observeSafely 隔离，任何一方抛错都不能让扫描 reject。
 */
function reportScanFallback(
  diagnostics: ScanRunDiagnostics,
  onParseError: ((err: unknown) => void) | undefined
): void {
  const { label, task, runStatus, persistenceOutcome } = diagnostics;
  const reason = `scan_fallback: no persisted knowledge.submit created receipt (label=${label}, task=${task}, runStatus=${runStatus}, persistenceOutcome=${persistenceOutcome})`;
  observeSafely(
    () =>
      Logger.getInstance().warn(`[ScanRun] ${reason}; returning task fallback`, {
        reasonCode: 'scan-unpersisted-fallback',
        label,
        task,
        runStatus,
        persistenceOutcome,
        knowledgeSubmitCallCount: diagnostics.knowledgeSubmitCallCount,
        ignoredUnpersistedOutput: diagnostics.ignoredUnpersistedOutput,
        resolution: 'task-fallback',
      }),
    () => undefined
  );
  observeSafely(
    () => onParseError?.(new Error(reason)),
    () => undefined
  );
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

/**
 * 扫描投影诊断形状（随结果 JSON 返回给宿主，不是公开导出类型）。
 * 已删除恒为 null 的 parseError（L8-C08）：投影不再解析 provider 文本，该字段没有真实来源。
 */
interface ScanRunDiagnostics {
  label: string;
  task: 'extract' | 'summarize';
  runStatus: AgentRunResult['status'];
  recipesFound: number;
  persistenceOutcome: 'created' | 'submit-without-created-recipe' | 'no-submit-attempt';
  projectionAuthority: 'persisted-knowledge-submit-results-only';
  usedFallback: boolean;
  ignoredUnpersistedOutput: boolean;
  toolCallCount: number;
  /** 全部 knowledge 工具调用次数（search/get/submit 等所有动作），不只是提交。 */
  knowledgeCallCount: number;
  /**
   * @deprecated 改用 knowledgeCallCount。旧名沿用已删除的 collect_scan_recipe 语义，值与
   * knowledgeCallCount 相同；仅为诊断 JSON 的外部读者保留一个过渡期（宿主当前不读取该键），
   * 下一次扫描诊断形状变更时由 AlembicAgent 删除。
   */
  collectScanRecipeCallCount: number;
  knowledgeSubmitCallCount: number;
  iterations: number;
  durationMs: number;
  runtimeDiagnostics: AgentDiagnostics | null;
  phases: Record<string, { replyLength: number; toolCallCount: number }>;
}

function buildScanDiagnostics({
  label,
  task,
  result,
  recipesFound,
  usedFallback = false,
  ignoredUnpersistedOutput = false,
}: {
  label?: string;
  task: 'extract' | 'summarize';
  result: AgentRunResult;
  recipesFound: number;
  usedFallback?: boolean;
  ignoredUnpersistedOutput?: boolean;
}): ScanRunDiagnostics {
  const phases = result.phases as Record<string, PhaseSummary> | undefined;
  const toolCalls = result.toolCalls || [];
  const knowledgeCalls = toolCalls.filter((tc) => (tc.tool || tc.name) === 'knowledge');
  const submitCalls = toolCalls.filter(isKnowledgeSubmit);
  const persistenceOutcome: ScanRunDiagnostics['persistenceOutcome'] =
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
    toolCallCount: toolCalls.length,
    knowledgeCallCount: knowledgeCalls.length,
    collectScanRecipeCallCount: knowledgeCalls.length,
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
