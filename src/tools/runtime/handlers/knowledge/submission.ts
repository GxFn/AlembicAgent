/** 候选提交编排：输入、证据、修复、Core 写入依次执行。 */

import { getSystemInjectedFields } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import { fail, ok, type ToolContext, type ToolResult } from '#tools/kernel/registry.js';
import { prepareSubmission } from './authoring.js';
import { AGENT_RUNTIME_SOURCE, type RecipeGatewayLike } from './contracts.js';
import { pickString, uniqueStrings, validateSubmitParams } from './input.js';
import { abortedKnowledgeResult } from './operation.js';
import { completeCreatedSubmission } from './submissionResult.js';

export async function handleSubmit(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const gateway = ctx.recipeGateway as RecipeGatewayLike | undefined;
  if (!gateway) {
    // 可见化:提交失败经 fail(...) 折叠成 null 结果，记账侧看不到原因；这里显式打日志，使冷启动
    // 「候选一条没落库」的真因(gateway 未接线)能在 combined.log 里被定位。
    Logger.getInstance().warn('[knowledge.submit] rejected: Recipe gateway not available');
    return fail('Recipe gateway not available');
  }

  const validationError = validateSubmitParams(params);
  if (validationError) {
    // run-14 复盘：本路径此前静默——报告计拒但日志零迹，复盘不可归因
    Logger.getInstance().warn(
      `[knowledge.submit] rejected "${String(params.title ?? '')}" (pre-check): ${validationError}`
    );
    return fail(`Validation failed: ${validationError}`);
  }

  try {
    const preparation = await prepareSubmission(params, ctx);
    if (preparation.status === 'rejected') {
      return preparation.result;
    }
    const { item, effectiveItem, preparedProduction, effectiveDimensionId, isBootstrap } =
      preparation;
    // prepareSubmission 的 await 是一次让出点；最终取消检查必须贴着真实写入边界。
    const aborted = abortedKnowledgeResult(ctx, 'submit');
    if (aborted) {
      return aborted;
    }

    // Core port 暂无取消参数；一旦调用就等待真实回执，不把中途取消当作写入已回滚。
    const result = await gateway.createOrStage(
      {
        items: [effectiveItem],
        options: {
          supersedes: pickString(params.supersedes),
          existingTitles: ctx.runtime?.submittedTitles ?? undefined,
          existingTriggers: ctx.runtime?.submittedTriggers ?? undefined,
          existingFingerprints: ctx.runtime?.submittedPatterns ?? undefined,
          systemInjectedFields: uniqueStrings([
            ...(isBootstrap ? getSystemInjectedFields() : []),
            'coreCode',
          ]),
          bootstrapDedup: isBootstrap ? (ctx.runtime?.bootstrapDedup as never) : undefined,
        },
      },
      {
        source: AGENT_RUNTIME_SOURCE,
        userId: AGENT_RUNTIME_SOURCE,
        capability: 'knowledge-submit',
      }
    );

    if (result.created.length > 0) {
      return await completeCreatedSubmission(
        {
          created: result.created[0],
          production: result.production,
          item,
          codeEvidence: preparedProduction.codeEvidence,
        },
        gateway,
        ctx
      );
    }

    // gateway 层三类非 created 结果统一留痕（run-8 复盘缺口：查重/拒绝/blocked 全静默，
    // 报告 rejected 计数与日志拒因对不上号——饱和 KB 下 duplicate 是主要暗拒来源）。
    if (result.duplicates.length > 0) {
      Logger.getInstance().warn(
        `[knowledge.submit] gateway duplicate for "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): similar to ${result.duplicates
          .map((d) => `"${d.title}"`)
          .slice(0, 3)
          .join(', ')}`
      );
      return ok({
        status: 'duplicate_blocked',
        codeEvidence: preparedProduction.codeEvidence,
        similar: result.duplicates.map((d) => ({
          title: d.title,
          similarity: d.similarTo?.[0]?.similarity ?? 0,
          similarTo: d.similarTo ?? [],
        })),
      });
    }

    if (result.rejected.length > 0) {
      const rejected = result.rejected[0];
      const firstErrors = Array.isArray(rejected.errors) ? rejected.errors.slice(0, 2) : [];
      Logger.getInstance().warn(
        `[knowledge.submit] gateway rejected "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')}): ${String(rejected.reason ?? '')}${firstErrors.length > 0 ? ` — ${firstErrors.join(' | ').slice(0, 220)}` : ''}`
      );
      const details = [
        `Rejected: ${rejected.reason}`,
        ...(Array.isArray(rejected.errors) ? rejected.errors : []),
        ...(Array.isArray(rejected.warnings)
          ? rejected.warnings.map((warning) => `warning: ${warning}`)
          : []),
      ].join('\n');
      return preparedProduction.codeEvidence.accepted
        ? fail(details)
        : {
            ok: false,
            data: {
              status: 'rejected',
              reason: 'unsafe-core-code-removed',
              message: details,
              codeEvidence: preparedProduction.codeEvidence,
            },
            error: details,
          };
    }

    if (result.blocked.length > 0) {
      Logger.getInstance().warn(
        `[knowledge.submit] gateway blocked by consolidation "${String(item.title ?? '')}" (dim=${String(effectiveDimensionId ?? '')})`
      );
      const message = `Blocked by consolidation: ${(result.blocked[0] as { title?: string }).title ?? 'unknown'}`;
      return preparedProduction.codeEvidence.accepted
        ? fail(message)
        : {
            ok: false,
            data: {
              status: 'consolidation-blocked',
              reason: 'unsafe-core-code-removed',
              message,
              codeEvidence: preparedProduction.codeEvidence,
            },
            error: message,
          };
    }

    return ok({ status: 'processed', result, codeEvidence: preparedProduction.codeEvidence });
  } catch (err: unknown) {
    Logger.getInstance().warn(
      `[knowledge.submit] rejected "${String(params.title ?? '')}" (exception): ${err instanceof Error ? err.message : String(err)}`
    );
    return fail(`Submit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
