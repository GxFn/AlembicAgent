import { SYNTHESIS_DIM_IDS } from '@alembic/core/dimensions';
import { observeSafely } from '#shared/observers.js';
import {
  type EvidenceLedgerStore,
  type EvidenceSourceDigestTable,
  seedLedgerFromJobSiblings,
} from './EvidenceLedgerStore.js';
import {
  openProductionEvidenceLedgerAuthority,
  resolveProductionEvidenceLedgerStore,
} from './ProductionEvidenceLedgerAuthority.js';

/**
 * 每个循环只准备证据资源，不持有 Runtime 或循环状态。
 * 同一 bootstrap job 的各维度共享目录；无维度身份时才返回 null。
 * 坐标、持久化或 seed 的真实失败必须原样终止初始化，日志仅作旁路观察。
 *
 * 原文摘要表（RED-P2b）由调用方（AgentRuntime 实例）持有并原样交给本次新建的 store：每次 reactLoop 都会
 * 新建 store，摘要若只是 store 实例状态，跨 reactLoop 回读的条目只能退回脱敏哈希（假 fresh 盲区仍在）。
 * 这里不创建、不缓存摘要表，也不把它放进模块级状态。某个条目走原文摘要还是退回脱敏哈希，由 store 在每次
 * checkFreshness 的诊断里写明（basis、reason、sourceDigestScope）。
 */
export function openLoopEvidence(options: {
  dataRoot: string;
  defaultJobId: string;
  sessionId: string;
  sharedState: Record<string, unknown> | null;
  logger: Pick<Console, 'info' | 'warn'>;
  sourceDigests: EvidenceSourceDigestTable;
}): EvidenceLedgerStore | null {
  const shared = options.sharedState;
  const sharedSessionKey = shared?._bootstrapSessionId;
  const jobId =
    typeof sharedSessionKey === 'string' && sharedSessionKey
      ? sharedSessionKey
      : options.defaultJobId;
  const metaId = (shared?._dimensionMeta as { id?: unknown } | undefined)?.id;
  const scopeId = shared?._dimensionScopeId;
  const dimensionId =
    typeof metaId === 'string' && metaId
      ? metaId
      : typeof scopeId === 'string' && scopeId
        ? scopeId.split(':')[0]
        : null;
  if (!dimensionId) {
    return null;
  }
  const observe = (phase: string, operation: () => unknown) =>
    observeSafely(operation, () =>
      options.logger.warn(
        '[EvidenceLedger] initialization observer failed; authority result retained',
        {
          phase,
          dimensionId,
        }
      )
    );

  try {
    const authority = openProductionEvidenceLedgerAuthority(
      {
        dataRoot: options.dataRoot,
        jobId,
        sessionId: options.sessionId,
        dimensionId,
      },
      { sourceDigests: options.sourceDigests }
    );
    const store = resolveProductionEvidenceLedgerStore(authority);
    // 仅合成维度空台账 seed 兄弟证据；后续循环 hydrate 到非空台账后不重复写入。
    // 合成维度集合以 Core 公开的 SYNTHESIS_DIM_IDS 为单源，Core 新增或改名合成维度时这里同步生效。
    const isSynthesisDimension = SYNTHESIS_DIM_IDS.some((id) => id === dimensionId);
    if (isSynthesisDimension && store.stats().entries === 0) {
      const seeded = seedLedgerFromJobSiblings(store, {
        dataRoot: options.dataRoot,
        jobId,
        selfDimensionId: dimensionId,
        logger: options.logger,
      });
      observe('seeded', () =>
        options.logger.info(
          `[EvidenceLedger] synthesis seeded ${seeded} sibling entries (job=${jobId})`
        )
      );
    }
    // 这里只陈述台账事实。submit schema 变体是否生效取决于之后的 schema 投影，
    // 由 AgentRuntime 在投影完成后按实际结果记录，不能在打开台账时提前断言。
    observe('opened', () =>
      options.logger.info('[EvidenceLedger] production ledger opened', {
        jobId,
        dimensionId,
        entries: store.stats().entries,
      })
    );
    return store;
  } catch (err: unknown) {
    observe('failed', () =>
      options.logger.warn('[EvidenceLedger] production authority initialization failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    );
    throw err instanceof Error ? err : new Error(String(err));
  }
}
