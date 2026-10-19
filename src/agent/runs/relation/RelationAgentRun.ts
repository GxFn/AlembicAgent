import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import type { AgentRunResult } from '../../service/AgentRunContracts.js';
import type { AgentService } from '../../service/AgentService.js';
import {
  type JsonObjectParseOutcome,
  parseJsonObjectWithDiagnostics,
} from '../../utils/jsonReply.js';
import { runFailure } from '../result.js';
import { buildSystemTaskRunInput, type SystemTaskRunSignals } from '../systemTaskRunInput.js';

export interface RelationDiscoveryResult extends Record<string, unknown> {
  analyzed: number;
  relations: Array<{ from: string; to: string; type: string; evidence?: string }>;
}

export async function runRelationDiscovery({
  agentService,
  batchSize = 20,
  abortSignal,
  shouldAbort,
  timeoutMs,
}: {
  agentService: AgentService;
  batchSize?: number;
} & SystemTaskRunSignals): Promise<RelationDiscoveryResult> {
  // 宿主取消/期限信号（L8-C01）只在传入时并入 execution；中止后的 run 由投影抛出，不会写图。
  const result = await agentService.run(
    buildSystemTaskRunInput({
      profileId: 'relation-discovery',
      params: { batchSize },
      message: {
        role: 'internal',
        content: `探索知识库中所有知识条目之间的语义关系。每批分析约 ${batchSize} 条知识。`,
        metadata: { task: 'relation-discovery', batchSize },
      },
      context: {
        source: 'system-workflow',
        runtimeSource: 'system',
      },
      signals: { abortSignal, shouldAbort, timeoutMs },
    })
  );

  return projectRelationDiscoveryResult(result);
}

export function projectRelationDiscoveryResult(result: AgentRunResult): RelationDiscoveryResult {
  // 宿主会持久化返回的 relations；失败/取消的阶段文本只能留在错误回执，不能进入写图。
  if (result.status !== 'success') {
    throw runFailure(
      result,
      `Relation discovery failed with status ${result.status}: ${result.reply || 'empty reply'}`
    );
  }
  const phases = result.phases as Record<string, { reply?: string }> | undefined;
  const synthesizeReply = phases?.synthesize?.reply;
  const replySource = synthesizeReply ? 'synthesize-phase' : 'run-reply';
  const outcome = parseJsonObjectWithDiagnostics(synthesizeReply || result.reply);
  // 解析失败仍回退为 0 条关系（L8-P10 决策：不改为 runFailure，宿主后台任务状态不翻转），
  // 但必须留下 usedFallback/parseError 诊断和 warn，运维才能区分“确实没有关系”和“解析失败”。
  const usedFallback = outcome.value === null;
  if (usedFallback) {
    reportRelationParseFallback(outcome, replySource);
  } else if (outcome.recoveredFrom !== undefined) {
    reportRelationParseRecovery(outcome, replySource);
  }
  const parsed = outcome.value ?? {};
  const relations = Array.isArray(parsed.relations) ? parsed.relations.filter(isRelation) : [];
  return {
    analyzed:
      typeof parsed.analyzed === 'number' &&
      Number.isSafeInteger(parsed.analyzed) &&
      parsed.analyzed >= 0
        ? parsed.analyzed
        : 0,
    relations,
    diagnostics: {
      toolCallCount: result.toolCalls.length,
      iterations: result.usage.iterations,
      durationMs: result.usage.durationMs,
      runtimeDiagnostics: result.diagnostics || null,
      invalidRelationCount: Array.isArray(parsed.relations)
        ? parsed.relations.length - relations.length
        : 0,
      usedFallback,
      ...(outcome.parseError !== undefined ? { parseError: outcome.parseError } : {}),
    },
  };
}

/** 回退诊断：只记录回复来源、长度、策略与错误类别，不记录回复正文（可能含项目代码片段）。 */
function reportRelationParseFallback(
  outcome: JsonObjectParseOutcome,
  replySource: 'synthesize-phase' | 'run-reply'
): void {
  const parseError = outcome.parseError ?? 'unknown';
  // 日志通道失败不能把已经确定的回退结果升级为投影失败，所以经 observeSafely 隔离。
  observeSafely(
    () =>
      Logger.getInstance().warn(
        `[RelationDiscovery] reply is not a JSON object; falling back to 0 relations (source=${replySource}, replyLength=${outcome.replyLength}, strategy=${outcome.strategy}, parseError=${parseError})`,
        {
          reasonCode: 'relation-discovery-json-fallback',
          replySource,
          replyLength: outcome.replyLength,
          strategy: outcome.strategy,
          parseError,
          resolution: 'fallback-zero-relations',
        }
      ),
    () => undefined
  );
}

/** 级联回退命中（前序策略失败、后续策略取得对象）：结果可用，只记 info 便于回查模型输出格式漂移。 */
function reportRelationParseRecovery(
  outcome: JsonObjectParseOutcome,
  replySource: 'synthesize-phase' | 'run-reply'
): void {
  observeSafely(
    () =>
      Logger.getInstance().info(
        `[RelationDiscovery] reply JSON recovered by parser fallback (source=${replySource}, replyLength=${outcome.replyLength}, strategy=${outcome.strategy}, recoveredFrom=${outcome.recoveredFrom})`,
        {
          reasonCode: 'relation-discovery-json-recovered',
          replySource,
          replyLength: outcome.replyLength,
          strategy: outcome.strategy,
          recoveredFrom: outcome.recoveredFrom,
          resolution: 'use-recovered-object',
        }
      ),
    () => undefined
  );
}

function isRelation(value: unknown): value is RelationDiscoveryResult['relations'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const relation = value as Record<string, unknown>;
  return (
    ['from', 'to', 'type'].every(
      (key) => typeof relation[key] === 'string' && String(relation[key]).trim().length > 0
    ) &&
    (relation.evidence === undefined || typeof relation.evidence === 'string')
  );
}
