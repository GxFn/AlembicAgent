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
    if (dimensionId === 'cross-dimension-synthesis' && store.stats().entries === 0) {
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
    observe('schema-ready', () =>
      options.logger.info(
        '[AgentRuntime] dimension submit schema variant active (evidenceRefs required, per-iteration)'
      )
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
