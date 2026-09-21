/** 并发闸门和容量提示共享同一解析结果；不把无效数字交给队列。 */
import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import type { EmbeddingCapacityHintSource } from '../contracts.js';

export function resolveConcurrency(
  configured: number | string | undefined,
  provider = '',
  env: Readonly<Record<string, string | undefined>> = process.env
): { value: number; source: EmbeddingCapacityHintSource } {
  const explicit = configured !== undefined && configured !== '';
  const environment =
    (provider === 'google' ? env.ALEMBIC_GEMINI_MAX_CONCURRENCY : '') ||
    env.ALEMBIC_AI_MAX_CONCURRENCY;
  const raw = explicit ? configured : environment || (provider === 'google' ? 2 : 4);
  const value = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < 1) {
    // 只记录字段及来源，环境值可能被误填成敏感信息，不输出原值。
    observeSafely(
      () =>
        Logger.getInstance().warn(
          `[ai-config] invalid_max_concurrency source=${explicit ? 'config' : 'environment'}; construction rejected before queueing`
        ),
      () => undefined
    );
    throw Object.assign(new Error('maxConcurrency must be a finite positive integer'), {
      code: 'LLM_INVALID_REQUEST',
    });
  }
  return {
    value,
    source: explicit ? 'provider-config' : environment ? 'environment' : 'conservative-default',
  };
}
