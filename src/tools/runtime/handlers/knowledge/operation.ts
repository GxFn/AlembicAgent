/** 知识操作的取消检查和已完成写入诊断；不承诺回滚无 signal 的宿主端口。 */

import Logger from '@alembic/core/logging';
import {
  fail,
  type ToolContext,
  type ToolResult,
  type ToolResultMeta,
} from '#tools/kernel/registry.js';

/** 只在尚未开始下一项操作时拒绝；已获 Core 写入回执的路径必须保留真实结果。 */
export function abortedKnowledgeResult(
  ctx: Pick<ToolContext, 'abortSignal'>,
  stage: string
): ToolResult | null {
  if (!ctx.abortSignal?.aborted) {
    return null;
  }
  const message = `Knowledge ${stage} aborted before the next operation`;
  Logger.getInstance().warn(`[knowledge] ${message}`);
  return fail(message);
}

export function completedMutationMeta(
  ctx: Pick<ToolContext, 'abortSignal'>,
  stage: string
): Partial<ToolResultMeta> | undefined {
  if (!ctx.abortSignal?.aborted) {
    return undefined;
  }
  const message = `Knowledge ${stage} completed after cancellation; the confirmed write is retained`;
  Logger.getInstance().warn(`[knowledge] ${message}`);
  return {
    degraded: true,
    diagnosticWarnings: [
      { code: 'KNOWLEDGE_MUTATION_COMPLETED_AFTER_ABORT', message, stage, tool: 'knowledge' },
    ],
  };
}
