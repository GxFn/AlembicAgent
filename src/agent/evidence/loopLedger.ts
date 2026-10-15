import { SYNTHESIS_DIM_IDS } from '@alembic/core/dimensions';
import { observeSafely } from '#shared/observers.js';
import { type EvidenceLedgerStore, seedLedgerFromJobSiblings } from './EvidenceLedgerStore.js';
import {
  createProductionEvidenceLedgerAuthority,
  resolveProductionEvidenceLedgerStore,
} from './ProductionEvidenceLedgerAuthority.js';

/**
 * 每个循环只准备证据资源，不持有 Runtime 或循环状态。
 * 同一 bootstrap job 的各维度共享目录；无维度身份时才返回 null。
 * 坐标、持久化或 seed 的真实失败必须原样终止初始化，日志仅作旁路观察。
 */
export function openLoopEvidence(options: {
  dataRoot: string;
  defaultJobId: string;
  sessionId: string;
  sharedState: Record<string, unknown> | null;
  logger: Pick<Console, 'info' | 'warn'>;
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
    const authority = createProductionEvidenceLedgerAuthority({
      dataRoot: options.dataRoot,
      jobId,
      sessionId: options.sessionId,
      dimensionId,
    });
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
