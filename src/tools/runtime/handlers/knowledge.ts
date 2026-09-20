/** 知识工具统一路由；原 handle 与 Core 风格规则重导出入口保持兼容。 */
import { fail, type ToolContext, type ToolResult } from '#tools/kernel/registry.js';
import { handleManage } from './knowledge/management.js';
import { abortedKnowledgeResult } from './knowledge/operation.js';
import { handleDetail, handlePrime, handleSearch } from './knowledge/queries.js';
import { handleSubmit } from './knowledge/submission.js';

export { applyStyleWaiver, isSoftAuthoringViolation } from '@alembic/core/knowledge';

export async function handle(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const aborted = abortedKnowledgeResult(ctx, action);
  if (aborted) {
    return aborted;
  }
  switch (action) {
    case 'search':
      return handleSearch(params, ctx);
    case 'prime':
      return handlePrime(params, ctx);
    case 'submit':
      return handleSubmit(params, ctx);
    case 'detail':
      return handleDetail(params, ctx);
    case 'manage':
      return handleManage(params, ctx);
    default:
      return fail(`Unknown knowledge action: ${action}`);
  }
}
