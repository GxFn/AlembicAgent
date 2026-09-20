/** 严格阶段工具准入与Core typed gate return适配。 */
import {
  createTypedGateReturnV1,
  type TypedGateReturnInputV1,
  type TypedGateReturnV1,
} from '@alembic/core/production';
import { fail } from './primitives.js';

export function createStrictTypedGateReturnV1(input: TypedGateReturnInputV1): TypedGateReturnV1 {
  return createTypedGateReturnV1(input);
}

export function validateStrictStageToolCallsV1(
  stageName: string,
  toolCalls: readonly Record<string, unknown>[],
  enrolledObligationIds: readonly string[] = []
): void {
  const normalizedStage = stageName.toLowerCase();
  if (normalizedStage === 'produce' || normalizedStage === 'producer') {
    if (toolCalls.length > 0) {
      fail('STRICT_PRODUCER_TOOL_FORBIDDEN', readToolName(toolCalls[0]));
    }
    return;
  }
  const enrolled = new Set(enrolledObligationIds);
  for (const call of toolCalls) {
    const tool = readToolName(call);
    const args = readRecord(call.args ?? call.params);
    const action = String(args.action ?? '');
    if (
      tool === 'knowledge' ||
      action === 'submit' ||
      action === 'persist' ||
      action === 'review'
    ) {
      fail('STRICT_ANALYST_AUTHORITY_FORBIDDEN', `${tool}.${action}`);
    }
    if (action === 'execute_fact_query' || action === 'execute_counterquery') {
      const obligationId = String(readRecord(args.params).obligationId ?? args.obligationId ?? '');
      if (!enrolled.has(obligationId)) {
        fail('STRICT_ANALYSIS_QUERY_UNENROLLED', obligationId || 'missing');
      }
    }
  }
}

function readToolName(call: Record<string, unknown>): string {
  return String(call.tool ?? call.name ?? 'unknown');
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
