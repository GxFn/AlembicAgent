import type { AgentRunResult } from '../../service/AgentRunContracts.js';
import type { AgentService } from '../../service/AgentService.js';
import { runFailure } from '../result.js';

export interface RelationDiscoveryResult extends Record<string, unknown> {
  analyzed: number;
  relations: Array<{ from: string; to: string; type: string; evidence?: string }>;
}

export async function runRelationDiscovery({
  agentService,
  batchSize = 20,
}: {
  agentService: AgentService;
  batchSize?: number;
}): Promise<RelationDiscoveryResult> {
  const result = await agentService.run({
    profile: { id: 'relation-discovery' },
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
    presentation: { responseShape: 'system-task-result' },
  });

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
  const synthesizeReply = phases?.synthesize?.reply || result.reply;
  const value = parseJsonResponse(synthesizeReply, { analyzed: 0, relations: [] });
  const parsed =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
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
    },
  };
}

function parseJsonResponse(
  text: string | null | undefined,
  fallback: RelationDiscoveryResult
): unknown {
  if (!text) {
    return fallback;
  }
  try {
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return JSON.parse(codeBlockMatch[1].trim());
    }
    const objMatch = text.match(/(\{[\s\S]*\})/);
    if (objMatch) {
      return JSON.parse(objMatch[1].trim());
    }
    return JSON.parse(text.trim());
  } catch {
    return fallback;
  }
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
