/**
 * @module tools/runtime/handlers/searchCacheGeneration
 *
 * code.search 缓存的失效代数（L4-P15 / I05）。内部模块：只给 handlers/code.ts 与 handlers/terminal.ts
 * 共用，不经任何公开子路径（@alembic/agent/tools/runtime 等）导出，也不给 SearchCache / SearchCacheLike
 * 新增 clear/invalidate 合同。
 *
 * 机制：宿主按读取视图复用同一个 SearchCache 实例；code.search 把“该实例当前代数”写进缓存 key，
 * 失效只需把代数加一，旧条目自然不再命中（旧 get/set-only 端口也适用），容量回收仍由宿主的缓存实现负责。
 * 代数按缓存实例存放在 WeakMap 里，视图结束、实例被回收时代数随之消失。
 *
 * 推进时机由调用方决定，本模块只负责计数与日志：
 * - code.write：真正开始写盘时推进（写失败也可能已经改过磁盘）；
 * - terminal.exec：执行器被调用之后推进，无论成功、非零退出、强杀、超时还是抛错（进程可能已部分写盘）；
 *   被安全规则、allowlist、缺沙箱或 cwd 越界拦截、进程从未启动的不推进。
 * 按 mtime 或 TTL 失效属于待决事项①，这里不实现。
 */

import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import type { SearchCacheLike } from '#tools/kernel/registry.js';

/** 推进代数的来源；写进日志，便于区分是哪类写盘动作让搜索缓存失效。 */
export type SearchCacheInvalidationSource = 'code.write' | 'terminal.exec';

const generations = new WeakMap<SearchCacheLike, number>();

/** 当前代数；没有注入搜索缓存时为 0（此时搜索也不会读写缓存）。 */
export function currentSearchCacheGeneration(cache: SearchCacheLike | undefined): number {
  return cache ? (generations.get(cache) ?? 0) : 0;
}

/**
 * 推进一次失效代数并记录 `search cache invalidated` 日志。
 * outcome 只能是调用方给出的受限描述（退出码、状态码、错误类名），不得包含命令原文、路径或文件内容。
 * 没有注入搜索缓存时无物可失效：记 debug 并返回 undefined，不影响调用方的执行结果。
 */
export function invalidateSearchCache(
  cache: SearchCacheLike | undefined,
  source: SearchCacheInvalidationSource,
  outcome: string
): number | undefined {
  if (!cache) {
    observeSafely(
      () =>
        Logger.getInstance().debug(
          `[${source}] search cache invalidation skipped; reason=no-search-cache; outcome=${outcome}`
        ),
      () => undefined
    );
    return undefined;
  }
  const generation = (generations.get(cache) ?? 0) + 1;
  generations.set(cache, generation);
  observeSafely(
    () =>
      Logger.getInstance().info(
        `[${source}] search cache invalidated; source=${source}; generation=${generation}; outcome=${outcome}`
      ),
    () => undefined
  );
  return generation;
}
