/** 候选提交编排：输入、证据、修复、Core 写入依次执行。 */

import { getSystemInjectedFields } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import { fail, type ToolContext, type ToolResult } from '#tools/kernel/registry.js';
import { prepareSubmission, recordRejectAndDirective } from './authoring.js';
import { AGENT_RUNTIME_SOURCE, type RecipeGatewayLike } from './contracts.js';
import { pickString, uniqueStrings, validateSubmitParams } from './input.js';
import { abortedKnowledgeResult, completedMutationMeta } from './operation.js';
import {
  classifyProductionOutcome,
  completeCreatedSubmission,
  consolidationBlockedResult,
  duplicateBlockedResult,
  gatewayRejectedResult,
  mergedIntoProposalResult,
  pendingSemanticReviewOf,
  type SubmissionTrace,
  unrecognizedOutcomeResult,
} from './submissionResult.js';

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
    // I39：必填项拒绝也消耗提交回合——计入会话 total（不计 streak），到顶时附预算上限指令。
    const stopDirective = recordRejectAndDirective(
      ctx.runtime,
      pickString(params.dimensionId) ?? pickString(ctx.runtime?.dimensionScopeId),
      'required-fields'
    );
    return fail(`Validation failed: ${validationError}${stopDirective}`);
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
          // I25：submitted* 是宿主注入、跨维度共享的去重状态，只能由 submitDedup 在确认创建后登记。
          // Core UnifiedValidator 持有传入 Set 的引用，并在字段校验通过后立即 recordSubmission，
          // 早于判重/合并/阻断与真实写入；若交出共享 Set，create_failed/blocked/merged/duplicates
          // 也会占位，导致同标题重试与其他维度同 trigger 被误判重复。这里只交副本：Core 读到同样
          // 的已登记内容做跨调用去重，批内登记落在副本上随调用丢弃（本调用每次只提交单条）。
          existingTitles: gatewayDedupSnapshot(ctx.runtime?.submittedTitles),
          existingTriggers: gatewayDedupSnapshot(ctx.runtime?.submittedTriggers),
          existingFingerprints: gatewayDedupSnapshot(ctx.runtime?.submittedPatterns),
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

    const trace: SubmissionTrace = {
      title: String(item.title ?? ''),
      dimensionId: String(effectiveDimensionId ?? ''),
      codeEvidence: preparedProduction.codeEvidence,
    };
    const pendingSemanticReview = pendingSemanticReviewOf(result, trace);

    // 以 Core 去向键集中映射（映射与穷举检查在 submissionResult.ts）：gateway 层四类非 created
    // 去向（查重/整合提案/拒绝/blocked）都要留痕（run-8 复盘缺口：非 created 结果全静默，报告
    // rejected 计数与日志拒因对不上号——饱和 KB 下 duplicate 是主要暗拒来源）；没有可识别去向时
    // 走降级兜底。Core 确认写入（created/merged）时若回执到达前已取消，按 knowledge.manage 同口径
    // 附 KNOWLEDGE_MUTATION_COMPLETED_AFTER_ABORT；只在这两类分支计算，避免给未写入的去向误记。
    const outcome = classifyProductionOutcome(result);
    switch (outcome) {
      case 'created':
        return await completeCreatedSubmission(
          {
            created: result.created[0],
            production: result.production,
            item,
            codeEvidence: preparedProduction.codeEvidence,
            pendingSemanticReview,
            mutationAbortWarnings: completedMutationMeta(ctx, 'submit')?.diagnosticWarnings,
          },
          gateway,
          ctx
        );
      case 'duplicates':
        return duplicateBlockedResult(result.duplicates, trace);
      case 'merged':
        return mergedIntoProposalResult(
          result.merged[0],
          trace,
          pendingSemanticReview,
          completedMutationMeta(ctx, 'submit')?.diagnosticWarnings
        );
      case 'rejected':
        return gatewayRejectedResult(result.rejected[0], trace);
      case 'blocked':
        return consolidationBlockedResult(result.blocked[0], trace);
      case null:
        return unrecognizedOutcomeResult(result, trace);
    }
  } catch (err: unknown) {
    Logger.getInstance().warn(
      `[knowledge.submit] rejected "${String(params.title ?? '')}" (exception): ${err instanceof Error ? err.message : String(err)}`
    );
    return fail(`Submit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 给 Core gateway 的去重快照：复制宿主共享 Set，Core 的写入不回流到调用方状态。
 * 宿主未注入（非维度场景）时保持 undefined，由 Core 自建空集合，与修复前一致。
 */
function gatewayDedupSnapshot(shared: Set<string> | null | undefined): Set<string> | undefined {
  return shared ? new Set(shared) : undefined;
}
