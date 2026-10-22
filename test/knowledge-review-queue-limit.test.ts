/**
 * L3-P6d（L3-P06 后续包，2026-10-20 用户决定）：knowledge.manage(review-queue) 是无上界查询，
 * 宿主 /agent/tool 直通且未传 limit 时会返回 staging 全部待复核条目。本用例固定三条规则：
 * 1. 未传 limit → 只返回默认条数（按 stagingDeadline 升序选取），结果带内标注 total/truncated/limit/message，
 *    并记 debug 诊断；
 * 2. 显式 limit（≤ 上限）→ 原样直通 Core，结果结构与之前完全一致；
 * 3. 显式 limit 超过上限 → 按上限截断、带内标注 requestedLimit，并记 warn 诊断。
 * 三条路径都保持 status=success（不 degraded、无 diagnosticWarnings），取消/失败语义不变。
 *
 * L3-P6e（第五轮审计补修）：Core 无界读不带 ORDER BY，返回 SQLite 物理行序，所以「最旧 N 条」的说法
 * 不成立；同时缺省截断提示把调用方引向「先取 limit 条再剔除已复核条目」的显式路径。下方第二组用例用
 * 忠实复刻 Core 语义的端口（无界读=物理行序；显式 limit=createdAt 升序取前 limit 条后才剔除已复核）
 * 固定修复后的行为：缺省/超上限路径本地按 stagingDeadline 排序后切片，提示改为「复核写回后再取」。
 *
 * L3-P6f（第六轮审计补修，只补测试）：L3-P6e 的用例里 deadline 两两不同、无 deadline 条目的物理行序恰好
 * 就是 id 序，V8 的稳定排序让「有没有同 deadline 按 id 打破并列」得到同样结果；负 deadline 与日志里的
 * undated=N 计数也没有断言。第三组用例让物理行序与 id 序相反、引入负 deadline，并精确断言 undated 计数。
 */
import { readFileSync } from 'node:fs';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handle as handleKnowledge } from '../src/tools/runtime/handlers/knowledge.js';
import type { ToolContext } from '../src/tools/runtime/index.js';
import { ToolRouterAdapter } from '../src/tools/runtime/index.js';
import { TOOL_REGISTRY } from '../src/tools/runtime/registry.js';

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

/**
 * 简化端口：传了 limit 就只返回前 limit 条，不传则无界返回。makeQueue 的下标顺序同时就是 deadline 升序，
 * 所以它不能暴露「物理行序 ≠ 时间顺序」的问题——那类断言见下方 L3-P6e 组的 coreFaithfulPort。
 */
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
    expect(data.message).toContain(`default limit ${DEFAULT_LIMIT}`);
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

/* ------------------------------------------------------------------ */
/*  L3-P6e：按 Core 真实语义固定排序与提示文案                         */
/* ------------------------------------------------------------------ */

interface FakeStagingEntry {
  id: string;
  createdAt: number;
  stagingDeadline: number;
}

const FAKE_BASE_TIME = 1_700_000_000_000;
const FAKE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** 第 index 个条目：index 越小 createdAt 越早、deadline 越早；id 补零便于按字典序核对。 */
function fakeEntry(index: number): FakeStagingEntry {
  const createdAt = FAKE_BASE_TIME + index * 1000;
  return {
    id: `entry-${String(index).padStart(3, '0')}`,
    createdAt,
    stagingDeadline: createdAt + FAKE_GRACE_MS,
  };
}

function fakeEntries(size: number): FakeStagingEntry[] {
  return Array.from({ length: size }, (_, index) => fakeEntry(index));
}

/** 新库同步重建：rowid 顺序跟文件 readdir（按 slug 字典序）走，与 createdAt 无关。 */
function lexicalFileOrder(entries: FakeStagingEntry[]): FakeStagingEntry[] {
  return [...entries].sort((left, right) => {
    const a = String(Number(left.id.slice('entry-'.length)));
    const b = String(Number(right.id.slice('entry-'.length)));
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function idsOf(queue: unknown[]): string[] {
  return queue.map((item) => String((item as { id: unknown }).id));
}

/**
 * 忠实复刻 Core 语义的端口（KnowledgeRepositoryImpl.findAllByLifecycles + StagingManager.listReviewQueue）：
 * - 不传 limit：无 ORDER BY，按物理行序（physicalOrder）返回；
 * - 传 limit：createdAt 升序取前 limit 条，之后才剔除已有 pass/fail 结论的条目；
 * - recordReview 只登记结论，条目留在 staging，下一次无界读会把它剔除。
 * 队列项与 Core StagingReviewQueueItem 同形，不含 createdAt。
 */
function coreFaithfulPort(physicalOrder: FakeStagingEntry[]) {
  const reviewed = new Set<string>();
  const toItem = (entry: FakeStagingEntry) => ({
    id: entry.id,
    title: `Staged ${entry.id}`,
    whenClause: 'When reviewing staged knowledge',
    doClause: 'Use the shared fixture port',
    dontClause: 'Do not bypass the port',
    coreCode: '',
    sources: [] as string[],
    stagingDeadline: entry.stagingDeadline,
  });
  const listReviewQueue = vi.fn(async (limit?: number) => {
    const rows =
      limit === undefined
        ? [...physicalOrder]
        : [...physicalOrder].sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
    return rows.filter((entry) => !reviewed.has(entry.id)).map(toItem);
  });
  const recordReview = vi.fn(async (id: string) => {
    if (!physicalOrder.some((entry) => entry.id === id)) {
      return false;
    }
    reviewed.add(id);
    return true;
  });
  return { listReviewQueue, recordReview };
}

function faithfulContext(port: ReturnType<typeof coreFaithfulPort>): ToolContext {
  return { projectRoot: process.cwd(), tokenBudget: 8000, stagingManager: port };
}

describe('knowledge.manage(review-queue) ordering and drain hint against Core semantics (L3-P6e)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['reverse insertion order', (entries: FakeStagingEntry[]) => [...entries].reverse()],
    ['lexical file-name order after a sync rebuild', lexicalFileOrder],
  ])('returns the earliest-deadline entries on the default path when Core returns %s', async (_label, order) => {
    const entries = fakeEntries(60);
    const port = coreFaithfulPort(order(entries));
    const logs = spyLogs();

    const result = await handleKnowledge(
      'manage',
      { operation: 'review-queue' },
      faithfulContext(port)
    );

    expect(result.ok).toBe(true);
    expect(port.listReviewQueue).toHaveBeenCalledWith(undefined);
    const data = result.data as ReviewQueueData;
    // Core 无界读的物理行序不可信：本地按 stagingDeadline 升序排序后才切片。
    expect(idsOf(data.queue)).toEqual(entries.slice(0, DEFAULT_LIMIT).map((entry) => entry.id));
    expect(data).toMatchObject({
      count: DEFAULT_LIMIT,
      total: 60,
      truncated: true,
      limit: DEFAULT_LIMIT,
    });
    // 带内说法必须与实际选取规则一致：不再声称「oldest」，而是按 staging deadline 最早选取。
    expect(data.message).not.toMatch(/oldest/i);
    expect(data.message).toContain('earliest staging deadlines');
    expect(String(logs.debug.mock.calls[0]?.[0])).toContain('stagingDeadline');
  });

  it('sorts entries without a staging deadline after every dated entry', async () => {
    // Core 对缺失 deadline 记 0；checkAndPromote 对 deadline=0 永远 waiting，不会自动晋级，排在最后。
    const dated = fakeEntries(55).map((entry, index) =>
      index < 10 ? { ...entry, stagingDeadline: 0 } : entry
    );
    const port = coreFaithfulPort(dated);
    spyLogs();

    const result = await handleKnowledge(
      'manage',
      { operation: 'review-queue' },
      faithfulContext(port)
    );

    const data = result.data as ReviewQueueData;
    expect(idsOf(data.queue)).toEqual([
      ...dated.slice(10).map((entry) => entry.id),
      'entry-000',
      'entry-001',
      'entry-002',
      'entry-003',
      'entry-004',
    ]);
    expect(data).toMatchObject({ count: DEFAULT_LIMIT, total: 55, truncated: true });
  });

  it('orders the clamped path by staging deadline and words its hint without the leave-staging claim', async () => {
    const entries = fakeEntries(MAX_LIMIT + 150);
    const port = coreFaithfulPort([...entries].reverse());
    const logs = spyLogs();

    const result = await handleKnowledge(
      'manage',
      { operation: 'review-queue', limit: 1000 },
      faithfulContext(port)
    );

    const data = result.data as ReviewQueueData;
    expect(idsOf(data.queue)).toEqual(entries.slice(0, MAX_LIMIT).map((entry) => entry.id));
    expect(data).toMatchObject({
      count: MAX_LIMIT,
      total: MAX_LIMIT + 150,
      truncated: true,
      limit: MAX_LIMIT,
      requestedLimit: 1000,
    });
    expect(data.message).not.toMatch(/oldest/i);
    // 已复核条目在 grace 期内仍留在 staging，但下一次无界读就会被剔除——不需要等它们离开 staging。
    expect(data.message).not.toContain('leave staging');
    expect(data.message).toContain("operation 'review'");
    expect(data.message).toContain('call review-queue again');
    expect(String(logs.warn.mock.calls[0]?.[0])).toContain('stagingDeadline');
  });

  it('points the default truncation hint at a drain path that actually returns the next entries', async () => {
    const entries = fakeEntries(120);
    const port = coreFaithfulPort([...entries].reverse());
    spyLogs();
    const ctx = faithfulContext(port);
    const reviewAll = async (queue: unknown[]) => {
      for (const id of idsOf(queue)) {
        const review = await handleKnowledge(
          'manage',
          { operation: 'review', id, outcome: 'pass' },
          ctx
        );
        expect(review.ok).toBe(true);
      }
    };

    const first = (await handleKnowledge('manage', { operation: 'review-queue' }, ctx))
      .data as ReviewQueueData;
    expect(first).toMatchObject({ count: DEFAULT_LIMIT, total: 120, truncated: true });
    // 不再建议「传 limit（≤500）一次取更多」：显式 limit 由 Core 先取后剔除已复核条目，可能少返回且无 total。
    expect(first.message).not.toMatch(/pass limit/i);
    expect(first.message).not.toContain(`up to ${MAX_LIMIT}`);
    expect(first.message).not.toContain('fetch more in one call');
    expect(first.message).toContain("operation 'review'");
    expect(first.message).toContain('call review-queue again without limit');

    // 照提示做：写回复核结论后不带 limit 再取，拿到的正是下一批待复核条目。
    await reviewAll(first.queue);
    const second = (await handleKnowledge('manage', { operation: 'review-queue' }, ctx))
      .data as ReviewQueueData;
    expect(idsOf(second.queue)).toEqual(entries.slice(50, 100).map((entry) => entry.id));
    expect(second).toMatchObject({ count: DEFAULT_LIMIT, total: 70, truncated: true });

    await reviewAll(second.queue);
    const third = (await handleKnowledge('manage', { operation: 'review-queue' }, ctx))
      .data as ReviewQueueData;
    expect(third).toEqual({
      queue: expect.any(Array),
      count: 20,
    });
    expect(idsOf(third.queue)).toEqual(entries.slice(100).map((entry) => entry.id));
  });

  it('keeps the explicit-limit path unchanged even when Core under-returns after reviews', async () => {
    // 用户决定（第 14 问）：显式 limit 行为不变。这里只把已知的少返回现象钉住，文档如实描述它。
    const entries = fakeEntries(70);
    const port = coreFaithfulPort(entries);
    for (const entry of entries.slice(0, 50)) {
      await port.recordReview(entry.id);
    }
    const logs = spyLogs();

    const result = await handleKnowledge(
      'manage',
      { operation: 'review-queue', limit: 50 },
      faithfulContext(port)
    );

    expect(port.listReviewQueue).toHaveBeenCalledWith(50);
    expect(result.data).toEqual({ queue: [], count: 0 });
    expect(logs.debug).not.toHaveBeenCalled();
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('describes the selection rules truthfully in the schema and the strict-production doc', () => {
    const limitSchema = TOOL_REGISTRY.knowledge?.actions.manage?.params.properties?.limit;
    const description = String(limitSchema?.description);
    expect(description).not.toMatch(/oldest/i);
    expect(description).toContain('stagingDeadline');
    // 显式路径：Core 先取后剔除，可能少返回，且没有带内 total/truncated。
    expect(description).toContain('before excluding reviewed ones');
    expect(description).toContain('no total/truncated');

    const doc = readFileSync(new URL('../docs/strict-production.md', import.meta.url), 'utf8');
    const paragraph = doc.split('\n').find((line) => line.includes('review-queue limit')) ?? '';
    expect(paragraph).not.toContain('最旧');
    expect(paragraph).toContain('stagingDeadline');
    expect(paragraph).toContain('先取后剔除');
  });
});

/* ------------------------------------------------------------------ */
/*  L3-P6f：并列打破、负 deadline 与 undated 计数的守护               */
/* ------------------------------------------------------------------ */

const TIE_DEADLINE = FAKE_BASE_TIME + FAKE_GRACE_MS;

/** 指定 id 与 deadline 的条目；createdAt 只影响显式 limit 路径，这里给确定值即可。 */
function entryWith(id: string, stagingDeadline: number, createdAtOffset = 0): FakeStagingEntry {
  return { id, createdAt: FAKE_BASE_TIME + createdAtOffset, stagingDeadline };
}

/** 从诊断行里取出 undated=N 的 N；没有该字段时返回 undefined，避免子串匹配把 13 误认成 1。 */
function undatedCountOf(line: string): number | undefined {
  const match = /\bundated=(\d+)\b/.exec(line);
  return match ? Number(match[1]) : undefined;
}

describe('knowledge.manage(review-queue) tie-break, negative deadlines and undated count (L3-P6f)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('breaks equal staging deadlines by code-unit id order instead of physical row order', async () => {
    // 物理行序故意打乱且与 id 序不同。同 deadline 的条目必须按 id 的 UTF-16 码元序排（不用 localeCompare：
    // 大写在小写之前，'entry-10' 在 'entry-9' 之前），否则结果会随 Core 物理行序或运行环境 locale 变化。
    // 'z-earliest' 的 deadline 更早，证明 id 只用来打破并列，不压过 deadline。
    const physical = [
      entryWith('b', TIE_DEADLINE),
      entryWith('entry-9', TIE_DEADLINE),
      entryWith('B', TIE_DEADLINE),
      entryWith('z-earliest', TIE_DEADLINE - 1),
      entryWith('a', TIE_DEADLINE),
      entryWith('entry-10', TIE_DEADLINE),
      entryWith('A', TIE_DEADLINE),
    ];
    const port = coreFaithfulPort(physical);
    const logs = spyLogs();

    const result = await handleKnowledge(
      'manage',
      { operation: 'review-queue' },
      faithfulContext(port)
    );

    expect(result.ok).toBe(true);
    // 未截断：仍是旧结构 { queue, count }，但缺省路径同样按 deadline + id 排过序。
    expect(result.data).toEqual({ queue: expect.any(Array), count: physical.length });
    expect(idsOf((result.data as ReviewQueueData).queue)).toEqual([
      'z-earliest',
      'A',
      'B',
      'a',
      'b',
      'entry-10',
      'entry-9',
    ]);
    expect(logs.debug).not.toHaveBeenCalled();
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('breaks ties by id inside a truncated default slice, for dated groups and for the undated tail', async () => {
    // 0..44 三条一组共享 deadline，45..54 没有 deadline（Core 记 0）。物理行序整体倒序：如果只靠稳定排序
    // 保留物理行序，每组内会倒过来，切片尾部也会选到 id 最大的无 deadline 条目。
    const entries = Array.from({ length: 55 }, (_, index) =>
      entryWith(
        `entry-${String(index).padStart(3, '0')}`,
        index < 45 ? TIE_DEADLINE + Math.floor(index / 3) * 1000 : 0,
        index * 1000
      )
    );
    const port = coreFaithfulPort([...entries].reverse());
    spyLogs();

    const result = await handleKnowledge(
      'manage',
      { operation: 'review-queue' },
      faithfulContext(port)
    );

    const data = result.data as ReviewQueueData;
    expect(idsOf(data.queue)).toEqual(entries.slice(0, DEFAULT_LIMIT).map((entry) => entry.id));
    expect(data).toMatchObject({
      count: DEFAULT_LIMIT,
      total: 55,
      truncated: true,
      limit: DEFAULT_LIMIT,
    });
  });

  it('treats negative staging deadlines as undated: they sort after every dated entry and tie with zero by id', async () => {
    // numberValue 只滤掉非有限数，负数会进入 dated 判定；只有 > 0 才算真实 deadline。负值（损坏数据）与 0
    // 一样排在所有有 deadline 的条目之后，并在其间按 id 排序，而不是因为数值最小被排到最前。
    const dated = Array.from({ length: 48 }, (_, index) =>
      entryWith(
        `dated-${String(index).padStart(3, '0')}`,
        TIE_DEADLINE + index * 1000,
        index * 1000
      )
    );
    const undated = [
      entryWith('undated-c', -1),
      entryWith('undated-a', 0),
      entryWith('undated-d', -FAKE_BASE_TIME),
      entryWith('undated-b', -5),
    ];
    const port = coreFaithfulPort([...undated, ...[...dated].reverse()]);
    const logs = spyLogs();

    const result = await handleKnowledge(
      'manage',
      { operation: 'review-queue' },
      faithfulContext(port)
    );

    const data = result.data as ReviewQueueData;
    expect(idsOf(data.queue)).toEqual([
      ...dated.map((entry) => entry.id),
      'undated-a',
      'undated-b',
    ]);
    expect(data).toMatchObject({ count: DEFAULT_LIMIT, total: 52, truncated: true });
    // 负 deadline 与 0 都计入 undated。
    expect(logs.debug).toHaveBeenCalledTimes(1);
    expect(undatedCountOf(String(logs.debug.mock.calls[0]?.[0]))).toBe(4);
  });

  it('logs the exact undated count on the default-path debug line', async () => {
    // 60 条中 10 条 deadline=0、3 条为负数，共 13 条无 deadline；全部有 deadline 时计数为 0。
    const mixed = fakeEntries(60).map((entry, index) => {
      if (index < 10) {
        return { ...entry, stagingDeadline: 0 };
      }
      if (index < 13) {
        return { ...entry, stagingDeadline: -(index + 1) };
      }
      return entry;
    });
    const mixedLogs = spyLogs();
    await handleKnowledge(
      'manage',
      { operation: 'review-queue' },
      faithfulContext(coreFaithfulPort(mixed))
    );
    expect(mixedLogs.debug).toHaveBeenCalledTimes(1);
    expect(undatedCountOf(String(mixedLogs.debug.mock.calls[0]?.[0]))).toBe(13);
    vi.restoreAllMocks();

    const datedLogs = spyLogs();
    await handleKnowledge(
      'manage',
      { operation: 'review-queue' },
      faithfulContext(coreFaithfulPort(fakeEntries(60)))
    );
    expect(datedLogs.debug).toHaveBeenCalledTimes(1);
    expect(undatedCountOf(String(datedLogs.debug.mock.calls[0]?.[0]))).toBe(0);
  });

  it('logs the exact undated count on the clamped-path warn line, including when nothing was cut', async () => {
    // 超上限路径无论是否真的切掉条目都告警；5 条里 1 条 deadline=0、1 条为负数，计数应为 2。
    const entries = fakeEntries(5).map((entry, index) => {
      if (index === 1) {
        return { ...entry, stagingDeadline: 0 };
      }
      if (index === 3) {
        return { ...entry, stagingDeadline: -10 };
      }
      return entry;
    });
    const logs = spyLogs();

    const result = await handleKnowledge(
      'manage',
      { operation: 'review-queue', limit: 1000 },
      faithfulContext(coreFaithfulPort(entries))
    );

    expect(idsOf((result.data as ReviewQueueData).queue)).toEqual([
      'entry-000',
      'entry-002',
      'entry-004',
      'entry-001',
      'entry-003',
    ]);
    expect(logs.warn).toHaveBeenCalledTimes(1);
    const line = String(logs.warn.mock.calls[0]?.[0]);
    expect(line).toContain('truncated=false');
    expect(undatedCountOf(line)).toBe(2);
    expect(logs.debug).not.toHaveBeenCalled();
  });
});
