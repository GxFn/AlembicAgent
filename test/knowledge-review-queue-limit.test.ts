/**
 * L3-P6d（L3-P06 后续包，2026-10-20 用户决定）：knowledge.manage(review-queue) 是无上界查询，
 * 宿主 /agent/tool 直通且未传 limit 时会返回 staging 全部待复核条目。本用例固定三条规则：
 * 1. 未传 limit → 只返回默认条数（最旧优先），结果带内标注 total/truncated/limit/message，并记 debug 诊断；
 * 2. 显式 limit（≤ 上限）→ 原样直通 Core，结果结构与之前完全一致；
 * 3. 显式 limit 超过上限 → 按上限截断、带内标注 requestedLimit，并记 warn 诊断。
 * 三条路径都保持 status=success（不 degraded、无 diagnosticWarnings），取消/失败语义不变。
 */
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handle as handleKnowledge } from '../src/tools/runtime/handlers/knowledge.js';
import type { ToolContext } from '../src/tools/runtime/index.js';
import { ToolRouterAdapter } from '../src/tools/runtime/index.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function reviewQueueItem(index: number) {
  return {
    id: `staging-${index}`,
    title: `Staged recipe ${index}`,
    whenClause: 'When reviewing staged knowledge',
    doClause: 'Use the shared fixture port',
    dontClause: 'Do not bypass the port',
    coreCode: `const value = ${index};`,
    sources: [`src/fixture-${index}.ts:1`],
    stagingDeadline: 1_000_000 + index,
  };
}

function makeQueue(size: number) {
  return Array.from({ length: size }, (_, index) => reviewQueueItem(index));
}

/** 模拟 Core 语义：传了 limit 就只返回最旧的 limit 条，不传则无界返回。 */
function coreLikeList(queue: ReturnType<typeof makeQueue>) {
  return vi.fn(async (limit?: number) => (limit === undefined ? queue : queue.slice(0, limit)));
}

function makeContext(
  listReviewQueue: (limit?: number) => Promise<unknown[]>,
  overrides: Partial<ToolContext> = {}
): ToolContext {
  return {
    projectRoot: process.cwd(),
    tokenBudget: 8000,
    stagingManager: { listReviewQueue, recordReview: vi.fn(async () => true) },
    ...overrides,
  };
}

function spyLogs() {
  return {
    debug: vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined),
    warn: vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined),
  };
}

type ReviewQueueData = {
  queue: unknown[];
  count: number;
  total?: number;
  truncated?: boolean;
  limit?: number;
  requestedLimit?: number;
  message?: string;
};

describe('knowledge.manage(review-queue) default limit and in-band truncation (L3-P6d)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('caps an omitted limit at the default and annotates the truncation in band', async () => {
    const queue = makeQueue(60);
    const listReviewQueue = coreLikeList(queue);
    const logs = spyLogs();

    const result = await handleKnowledge(
      'manage',
      { operation: 'review-queue' },
      makeContext(listReviewQueue)
    );

    expect(result.ok).toBe(true);
    // 默认路径让 Core 做无界读，再在本地切片，这样 total 才是准确的待复核总数。
    expect(listReviewQueue).toHaveBeenCalledTimes(1);
    expect(listReviewQueue).toHaveBeenCalledWith(undefined);
    expect(result.data).toEqual({
      queue: queue.slice(0, DEFAULT_LIMIT),
      count: DEFAULT_LIMIT,
      total: 60,
      truncated: true,
      limit: DEFAULT_LIMIT,
      message: expect.stringContaining(`${DEFAULT_LIMIT} of 60`),
    });
    const data = result.data as ReviewQueueData;
    expect(data.message).toContain('limit');
    expect(data.message).toContain(String(MAX_LIMIT));
    // status 保持 success：不 degraded，也不抬升 diagnosticWarnings。
    expect(result._meta?.resultStatus).toBeUndefined();
    expect(result._meta?.degraded).toBeUndefined();
    expect(result._meta?.diagnosticWarnings).toBeUndefined();
    // debug 诊断要能看出触发条件（limit 缺省）、默认值、总数、返回数与截断状态。
    expect(logs.debug).toHaveBeenCalledTimes(1);
    const line = String(logs.debug.mock.calls[0]?.[0]);
    expect(line).toContain('review-queue');
    expect(line).toContain(`default=${DEFAULT_LIMIT}`);
    expect(line).toContain('total=60');
    expect(line).toContain(`returned=${DEFAULT_LIMIT}`);
    expect(line).toContain('truncated=true');
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('keeps the legacy shape and stays silent when the pending queue fits the default limit', async () => {
    const queue = makeQueue(DEFAULT_LIMIT);
    const listReviewQueue = coreLikeList(queue);
    const logs = spyLogs();

    const result = await handleKnowledge(
      'manage',
      { operation: 'review-queue' },
      makeContext(listReviewQueue)
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ queue, count: DEFAULT_LIMIT });
    expect(logs.debug).not.toHaveBeenCalled();
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('passes an explicit limit within the ceiling through to Core unchanged', async () => {
    const queue = makeQueue(60);
    const listReviewQueue = coreLikeList(queue);
    const logs = spyLogs();

    const result = await handleKnowledge(
      'manage',
      { operation: 'review-queue', limit: 5 },
      makeContext(listReviewQueue)
    );

    expect(result.ok).toBe(true);
    expect(listReviewQueue).toHaveBeenCalledWith(5);
    expect(result.data).toEqual({ queue: queue.slice(0, 5), count: 5 });
    expect(logs.debug).not.toHaveBeenCalled();
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('passes the ceiling value itself through to Core unchanged', async () => {
    const queue = makeQueue(MAX_LIMIT + 150);
    const listReviewQueue = coreLikeList(queue);
    const logs = spyLogs();

    const result = await handleKnowledge(
      'manage',
      { operation: 'review-queue', limit: MAX_LIMIT },
      makeContext(listReviewQueue)
    );

    expect(result.ok).toBe(true);
    expect(listReviewQueue).toHaveBeenCalledWith(MAX_LIMIT);
    expect(result.data).toEqual({ queue: queue.slice(0, MAX_LIMIT), count: MAX_LIMIT });
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('clamps an explicit limit above the ceiling, truncates at the ceiling and warns', async () => {
    const queue = makeQueue(MAX_LIMIT + 150);
    const listReviewQueue = coreLikeList(queue);
    const logs = spyLogs();

    const result = await handleKnowledge(
      'manage',
      { operation: 'review-queue', limit: 1000 },
      makeContext(listReviewQueue)
    );

    expect(result.ok).toBe(true);
    // 截断路径同样走无界读 + 本地切片，total 才准确；Core 的 limit 作用在过滤已复核条目之前。
    expect(listReviewQueue).toHaveBeenCalledWith(undefined);
    expect(result.data).toEqual({
      queue: queue.slice(0, MAX_LIMIT),
      count: MAX_LIMIT,
      total: MAX_LIMIT + 150,
      truncated: true,
      limit: MAX_LIMIT,
      requestedLimit: 1000,
      message: expect.stringContaining(`${MAX_LIMIT} of ${MAX_LIMIT + 150}`),
    });
    expect((result.data as ReviewQueueData).message).toContain('1000');
    expect(result._meta?.degraded).toBeUndefined();
    expect(result._meta?.diagnosticWarnings).toBeUndefined();
    expect(logs.warn).toHaveBeenCalledTimes(1);
    const line = String(logs.warn.mock.calls[0]?.[0]);
    expect(line).toContain('review-queue');
    expect(line).toContain('requested=1000');
    expect(line).toContain(`ceiling=${MAX_LIMIT}`);
    expect(line).toContain(`total=${MAX_LIMIT + 150}`);
    expect(line).toContain('truncated=true');
    expect(logs.debug).not.toHaveBeenCalled();
  });

  it('still warns about a clamped limit when nothing had to be cut, without annotating the result', async () => {
    const queue = makeQueue(3);
    const listReviewQueue = coreLikeList(queue);
    const logs = spyLogs();

    const result = await handleKnowledge(
      'manage',
      { operation: 'review-queue', limit: 1000 },
      makeContext(listReviewQueue)
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ queue, count: 3 });
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(String(logs.warn.mock.calls[0]?.[0])).toContain('truncated=false');
  });

  it('reports status=success without degraded diagnostics through the adapter when truncated', async () => {
    const queue = makeQueue(60);
    const listReviewQueue = coreLikeList(queue);
    spyLogs();
    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create: () => makeContext(listReviewQueue),
      },
    });

    const envelope = await adapter.execute({
      toolId: 'knowledge',
      args: { action: 'manage', params: { operation: 'review-queue' } },
      surface: 'runtime',
      actor: { role: 'developer', user: 'review-queue-limit-test' },
      source: { kind: 'runtime', name: 'review-queue-limit-test' },
    });

    expect(envelope).toMatchObject({
      ok: true,
      status: 'success',
      diagnostics: { degraded: false, warnings: [] },
    });
    const content = envelope.structuredContent as ReviewQueueData;
    expect(content.queue).toHaveLength(DEFAULT_LIMIT);
    expect(content).toMatchObject({ count: DEFAULT_LIMIT, total: 60, truncated: true });
    expect(JSON.parse(envelope.text)).toMatchObject({ count: DEFAULT_LIMIT, total: 60 });
  });

  it('keeps the truncated result when the diagnostic channel throws', async () => {
    const queue = makeQueue(60);
    const listReviewQueue = coreLikeList(queue);
    vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => {
      throw new Error('log sink down');
    });

    const result = await handleKnowledge(
      'manage',
      { operation: 'review-queue' },
      makeContext(listReviewQueue)
    );

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ count: DEFAULT_LIMIT, total: 60, truncated: true });
  });

  it('still rejects an invalid explicit limit instead of treating it as omitted', async () => {
    const listReviewQueue = coreLikeList(makeQueue(60));

    const result = await handleKnowledge(
      'manage',
      { operation: 'review-queue', limit: 0 },
      makeContext(listReviewQueue)
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('limit must be a positive safe integer');
    expect(listReviewQueue).not.toHaveBeenCalled();
  });

  it('normalizes a Core failure on the default-limit path', async () => {
    const listReviewQueue = vi.fn(async () => {
      throw new Error('staging unavailable');
    });

    const result = await handleKnowledge(
      'manage',
      { operation: 'review-queue' },
      makeContext(listReviewQueue)
    );

    expect(result).toMatchObject({
      ok: false,
      data: { operation: 'review-queue', status: 'failed' },
      error: expect.stringContaining('staging unavailable'),
    });
  });

  it('settles a cancelled default-limit read without surfacing late data', async () => {
    const controller = new AbortController();
    let release!: (queue: unknown[]) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const listReviewQueue = vi.fn(
      () =>
        new Promise<unknown[]>((resolve) => {
          started();
          release = resolve;
        })
    );
    const pending = handleKnowledge(
      'manage',
      { operation: 'review-queue' },
      makeContext(listReviewQueue, { abortSignal: controller.signal })
    );
    try {
      await entered;
      controller.abort();
      const result = await pending;
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/abort/i) });
      expect(result.data).toBeNull();
    } finally {
      release?.(makeQueue(60));
      await pending;
    }
  });
});
