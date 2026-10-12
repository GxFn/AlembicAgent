/**
 * AgentTaskHandlers — predefined task flows for /api/v1/ai/agent/task.
 *
 * These handlers are not chat runtime logic. They orchestrate direct ToolRouter
 * calls and, for relation discovery, delegate to AgentService.run().
 */

import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import {
  projectToolResultOrdinaryOutput,
  type ToolResultEnvelope,
  toolResultInternals,
} from '#tools/kernel/index.js';
import { type AgentService, runRelationDiscovery } from '../service/index.js';

export interface TaskAiProvider {
  chat(prompt: string, opts?: Record<string, unknown>): Promise<string>;
  chatWithStructuredOutput(prompt: string, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface TaskContext {
  invokeToolEnvelope(
    toolName: string,
    params: Record<string, unknown>
  ): Promise<ToolResultEnvelope>;
  aiProvider?: TaskAiProvider;
  container: { get(name: string): unknown };
  logger?: unknown;
  /**
   * 宿主可选的任务取消信号（L8-C01，例如 HTTP 请求断开）。传入时转给关系发现 run 的
   * execution.abortSignal 与 AI 直调的 abortSignal；未传时各调用参数与旧版一致。
   * 工具调用（invokeToolEnvelope）不经过这里，其取消由宿主自己的路由负责。
   */
  signal?: AbortSignal;
}

export interface CandidateInput {
  title?: string;
  code?: string;
  [key: string]: unknown;
}

export interface DuplicateEntry {
  title?: string;
  similarity: number;
  [key: string]: unknown;
}

export interface KnowledgeItem {
  id: string;
  title?: string;
  metadata?: {
    rationale?: string;
    knowledgeType?: string;
    complexity?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface KnowledgeServiceLike {
  list(
    filter: Record<string, unknown>,
    pagination: { page: number; pageSize: number }
  ): Promise<{ items?: KnowledgeItem[]; data?: KnowledgeItem[] }>;
}

export interface GuardViolation {
  severity?: string;
  message?: string;
  ruleName?: string;
  line?: number;
  matches?: Array<{ line?: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface DuplicateCheckResult {
  similar: DuplicateEntry[];
}

interface QualityScoreResult {
  score: number;
  grade: string;
  dimensions: unknown;
}

interface GuardCheckResult {
  violationCount: number;
  violations?: GuardViolation[];
}

export async function taskCheckAndSubmit(
  context: TaskContext,
  { candidate, projectRoot }: { candidate: CandidateInput; projectRoot?: string }
) {
  const { aiProvider } = context;

  const duplicates = await invokeTaskTool<DuplicateCheckResult>(
    context,
    'check_duplicate',
    {
      candidate,
      projectRoot,
      threshold: 0.5,
    },
    isDuplicateCheckResult
  );

  const highSim = duplicates.similar.filter((d: DuplicateEntry) => d.similarity >= 0.7);
  let aiVerdict: string | null = null;
  if (highSim.length > 0 && aiProvider) {
    const verdictPrompt = `以下新候选代码与已有 Recipe 高度相似，请判断是否真正重复。

新候选:
- Title: ${candidate.title || '(未命名)'}
- Code: ${(candidate.code || '').substring(0, 1000)}

相似 Recipe:
${highSim.map((s: DuplicateEntry) => `- ${s.title} (相似度: ${s.similarity})`).join('\n')}

请回答: DUPLICATE（真正重复）/ SIMILAR（相似但不同，建议保留并标注关系）/ UNIQUE（误判，可放心提交）
只回答一个词。`;
    try {
      const raw = await aiProvider.chat(
        verdictPrompt,
        withTaskSignal(context, { temperature: 0, maxTokens: 20 })
      );
      aiVerdict = (raw || '').trim().toUpperCase().split(/\s/)[0];
    } catch (err: unknown) {
      // 宿主取消不是“可选 AI 判定失败”：不能降级成 review_suggested 冒充检查完成。
      if (context.signal?.aborted) {
        throw taskAbortedError(context, 'check_and_submit', 'ai-verdict', err);
      }
      /* optional AI verdict */
    }
  }

  return {
    duplicates: duplicates.similar,
    highSimilarity: highSim,
    aiVerdict,
    recommendation:
      highSim.length === 0
        ? 'safe_to_submit'
        : aiVerdict === 'DUPLICATE'
          ? 'block_duplicate'
          : 'review_suggested',
  };
}

export async function taskDiscoverAllRelations(context: TaskContext, { batchSize = 20 } = {}) {
  const { container } = context;
  const agentService = container.get('agentService') as AgentService;

  const aiManager = (container as unknown as { singletons?: Record<string, unknown> }).singletons
    ?._aiProviderManager as { isMock?: boolean } | undefined;
  if (aiManager?.isMock) {
    return { discovered: 0, message: 'AI Provider 未配置（Mock 模式），跳过关系发现。' };
  }

  // 中止后的关系发现 run 由 runRelationDiscovery 以 runFailure 抛出，不会返回可写图的 relations。
  return runRelationDiscovery({ agentService, batchSize, abortSignal: context.signal });
}

export async function taskFullEnrich(
  context: TaskContext,
  { status = 'pending', maxCount = 50 } = {}
) {
  const { container } = context;
  const knowledgeService = container.get('knowledgeService') as KnowledgeServiceLike;

  const { items = [], data = [] } = await knowledgeService.list(
    { lifecycle: status },
    { page: 1, pageSize: maxCount }
  );
  const candidates = items.length > 0 ? items : data;
  if (candidates.length === 0) {
    return { enriched: 0, message: 'No candidates to enrich' };
  }

  const needEnrich = candidates.filter((candidate: KnowledgeItem) => {
    const metadata = candidate.metadata || {};
    return !metadata.rationale || !metadata.knowledgeType || !metadata.complexity;
  });

  if (needEnrich.length === 0) {
    return { enriched: 0, message: 'All candidates already enriched' };
  }

  return invokeTaskTool(context, 'enrich_candidate', {
    candidateIds: needEnrich.map((candidate: KnowledgeItem) => candidate.id).slice(0, 20),
  });
}

export async function taskQualityAudit(
  context: TaskContext,
  { threshold = 0.6, maxCount = 100 } = {}
) {
  const { container } = context;
  const knowledgeService = container.get('knowledgeService') as KnowledgeServiceLike;

  const { items = [], data = [] } = await knowledgeService.list(
    { lifecycle: 'active' },
    { page: 1, pageSize: maxCount }
  );
  const recipes = items.length > 0 ? items : data;
  if (recipes.length === 0) {
    return { total: 0, lowQuality: [], message: 'No active recipes' };
  }

  const lowQuality: {
    id: string;
    title: string | undefined;
    score: number;
    grade: string;
    dimensions: unknown;
  }[] = [];
  const gradeDistribution = { A: 0, B: 0, C: 0, D: 0, F: 0 };

  for (const recipe of recipes) {
    const scoreResult = await invokeTaskTool<QualityScoreResult>(
      context,
      'quality_score',
      { recipe },
      isQualityScoreResult
    );
    if (scoreResult.grade) {
      (gradeDistribution as Record<string, number>)[scoreResult.grade] =
        ((gradeDistribution as Record<string, number>)[scoreResult.grade] || 0) + 1;
    }
    if (scoreResult.score < threshold) {
      lowQuality.push({
        id: recipe.id,
        title: recipe.title,
        score: scoreResult.score,
        grade: scoreResult.grade,
        dimensions: scoreResult.dimensions,
      });
    }
  }

  lowQuality.sort((a, b) => a.score - b.score);

  return {
    total: recipes.length,
    threshold,
    gradeDistribution,
    lowQualityCount: lowQuality.length,
    lowQuality,
  };
}

export async function taskGuardFullScan(
  context: TaskContext,
  { code, language, filePath }: { code?: string; language?: string; filePath?: string } = {}
) {
  const { aiProvider } = context;
  if (!code) {
    return { error: 'code is required' };
  }

  const checkResult = await invokeTaskTool<GuardCheckResult>(
    context,
    'guard_check_code',
    {
      code,
      language: language || 'unknown',
      scope: 'project',
    },
    isGuardCheckResult
  );

  let suggestions: unknown = null;
  if (checkResult.violationCount > 0 && aiProvider) {
    try {
      const violationSummary = (checkResult.violations || [])
        .slice(0, 5)
        .map(
          (violation: GuardViolation) =>
            `- [${violation.severity}] ${violation.message || violation.ruleName} (line ${violation.line || violation.matches?.[0]?.line || '?'})`
        )
        .join('\n');

      const prompt = `以下代码存在 Guard 规则违规。请为每个违规提供修复建议。

违规列表:
${violationSummary}

代码片段:
\`\`\`${language || ''}
${code.substring(0, 3000)}
\`\`\`

请用 JSON 数组格式返回建议: [{"violation": "...", "suggestion": "...", "fixExample": "..."}]`;

      suggestions =
        (await aiProvider.chatWithStructuredOutput(
          prompt,
          withTaskSignal(context, {
            openChar: '[',
            closeChar: ']',
            temperature: 0.3,
          })
        )) || [];
    } catch (err: unknown) {
      // 宿主取消时整个扫描失败，不能返回 suggestions=null 的“已完成”结果。
      if (context.signal?.aborted) {
        throw taskAbortedError(context, 'guard_full_scan', 'ai-suggestions', err);
      }
      /* AI suggestions are optional */
    }
  }

  return {
    filePath: filePath || '(inline)',
    language,
    violationCount: checkResult.violationCount,
    violations: checkResult.violations,
    suggestions,
  };
}

/**
 * 只在宿主传入 signal 时追加 abortSignal，保证未传信号的 AI 调用选项与旧版逐项一致。
 */
function withTaskSignal(
  context: TaskContext,
  opts: Record<string, unknown>
): Record<string, unknown> {
  return context.signal ? { ...opts, abortSignal: context.signal } : opts;
}

/**
 * 任务被宿主信号取消时的统一出口：记录取消诊断（任务、步骤、取消原因、底层错误），
 * 再返回带 cause 的 Error 由调用方抛出。日志器选择与 redactTaskToolEnvelope 一致：
 * 优先宿主注入的 warn 日志器，失败或缺失时退回 Core 共享 Logger。
 */
function taskAbortedError(context: TaskContext, task: string, step: string, err: unknown): Error {
  const reason: unknown = context.signal?.reason;
  const meta = {
    code: 'AGENT_TASK_ABORTED',
    task,
    step,
    reason: reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : null,
    error: err instanceof Error ? err.message : String(err),
  };
  const coreLogger = Logger.getInstance();
  const logger = isTaskWarnLogger(context.logger) ? context.logger : coreLogger;
  observeSafely(
    () => logger.warn(`[AgentTask] ${task} aborted by task signal during ${step}`, meta),
    () =>
      logger === coreLogger
        ? undefined
        : coreLogger.warn(
            `[AgentTask] ${task} aborted by task signal during ${step} (host logger failed)`,
            meta
          )
  );
  return new Error(`Agent task ${task} aborted during ${step}`, { cause: err });
}

async function invokeTaskTool<T = Record<string, unknown>>(
  context: TaskContext,
  toolName: string,
  params: Record<string, unknown>,
  validateResult?: (result: unknown) => result is T
): Promise<T> {
  const envelope = redactTaskToolEnvelope(
    context,
    toolName,
    await context.invokeToolEnvelope(toolName, params)
  );
  // 仅完整成功回执能进入任务推断。partial/取消/拒绝都不是“检查通过”；错误保留
  // envelope（有私有字段时是清理后的副本，否则是宿主原信封）供宿主诊断，不新增
  // recommendation值或把错误投影成空候选/零违规。
  if (envelope.ok !== true || envelope.status !== 'success') {
    throw new Error(
      `Task tool ${toolName} did not complete successfully (${envelope.status}): ${envelope.text}`,
      { cause: envelope }
    );
  }
  const result = projectTaskToolEnvelope(envelope);
  if (validateResult && !validateResult(result)) {
    throw new Error(
      `Task tool ${toolName} returned an invalid structured result: ${envelope.text}`,
      {
        cause: envelope,
      }
    );
  }
  return result as T;
}

function isResultRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDuplicateCheckResult(value: unknown): value is DuplicateCheckResult {
  if (!isResultRecord(value) || !Array.isArray(value.similar)) {
    return false;
  }
  for (const entry of value.similar) {
    if (
      !isResultRecord(entry) ||
      typeof entry.similarity !== 'number' ||
      !Number.isFinite(entry.similarity)
    ) {
      return false;
    }
  }
  return true;
}

function isQualityScoreResult(value: unknown): value is QualityScoreResult {
  return (
    isResultRecord(value) &&
    typeof value.score === 'number' &&
    Number.isFinite(value.score) &&
    typeof value.grade === 'string' &&
    value.grade.trim().length > 0
  );
}

function isGuardCheckResult(value: unknown): value is GuardCheckResult {
  return (
    isResultRecord(value) &&
    typeof value.violationCount === 'number' &&
    Number.isInteger(value.violationCount) &&
    value.violationCount >= 0 &&
    (value.violations === undefined ||
      (Array.isArray(value.violations) && value.violations.every(isResultRecord)))
  );
}

/**
 * 传入的信封已经过 redactTaskToolEnvelope：structuredContent 已删除 D23 秘密/私有字段，
 * 业务字段（违规 message 等）原样保留；纯文本信封走默认普通输出投影。
 */
function projectTaskToolEnvelope(envelope: ToolResultEnvelope): unknown {
  if (envelope.structuredContent !== undefined) {
    return envelope.structuredContent;
  }
  return projectToolResultOrdinaryOutput(envelope);
}

/** 诊断里最多列出的私有字段路径数与单条长度；路径只含键名，不含任何值。 */
const MAX_REPORTED_PRIVATE_FIELD_PATHS = 10;
const MAX_REPORTED_PRIVATE_FIELD_PATH_LENGTH = 120;

interface TaskWarnLogger {
  warn(message: string, meta?: Record<string, unknown>): unknown;
}

function isTaskWarnLogger(value: unknown): value is TaskWarnLogger {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { warn?: unknown }).warn === 'function'
  );
}

/**
 * D23 任务出口（L3-C02/L3-P07）。宿主路由返回的规范信封带完整 structuredContent；它会成为
 * 任务输出、AI 提示和错误消息/错误 cause，所以先删除秘密/私有字段（任意深度）。没有私有
 * 字段时返回同一信封对象（错误 cause 仍是宿主原信封）；有改写时记录告警，只含字段路径。
 * 宿主未注入可用日志器时降级到 Core 共享 Logger，保证清理路径可定位。
 */
function redactTaskToolEnvelope(
  context: TaskContext,
  toolName: string,
  envelope: ToolResultEnvelope
): ToolResultEnvelope {
  const redaction = toolResultInternals.redactPrivateFields(envelope);
  if (redaction.envelope === envelope) {
    return envelope;
  }
  const { redactedFields, warningCodes } = redaction;
  const shownPaths = redactedFields
    .slice(0, MAX_REPORTED_PRIVATE_FIELD_PATHS)
    .map((path) => path.slice(0, MAX_REPORTED_PRIVATE_FIELD_PATH_LENGTH));
  const code =
    redactedFields.length > 0
      ? 'TOOL_RESULT_PRIVATE_FIELDS_REDACTED'
      : 'TOOL_RESULT_PRIVATE_FIELD_SCAN_NORMALIZED';
  const coreLogger = Logger.getInstance();
  const logger = isTaskWarnLogger(context.logger) ? context.logger : coreLogger;
  const meta = {
    code,
    tool: toolName,
    redactedFieldCount: redactedFields.length,
    redactedFields: shownPaths,
    warningCodes,
  };
  // 宿主日志器同步抛错或异步拒绝都不能改变任务结果；清理本身已经完成。宿主日志器失败时
  // 改记到 Core 共享 Logger（只记字段路径与计数，不记日志器错误内容），保证清理路径可定位。
  observeSafely(
    () => logger.warn(`[AgentTask] ${code}: ${toolName} result rewritten before task use`, meta),
    () =>
      logger === coreLogger
        ? undefined
        : coreLogger.warn(
            `[AgentTask] ${code}: ${toolName} result rewritten before task use (host logger failed)`,
            meta
          )
  );
  return redaction.envelope;
}
