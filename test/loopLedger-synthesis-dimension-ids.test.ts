/**
 * openLoopEvidence 的合成维度识别与打开日志。
 * 合成维度集合以 Core 公开的 SYNTHESIS_DIM_IDS 为单源：这里把一个夹具 id 并入该集合，
 * 断言新增的合成维度同样会 seed 兄弟台账，而普通维度不会。打开日志只陈述台账事实
 * （job、维度、条目数），不再声称 submit schema 变体已生效。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import { openLoopEvidence } from '../src/agent/evidence/loopLedger.js';

// vi.mock 工厂会被提升到模块顶部执行，夹具 id 必须经 vi.hoisted 声明，不能引用普通常量。
const { FIXTURE_SYNTHESIS_DIMENSION } = vi.hoisted(() => ({
  FIXTURE_SYNTHESIS_DIMENSION: 'fixture-synthesis',
}));

vi.mock('@alembic/core/dimensions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alembic/core/dimensions')>();
  return {
    ...actual,
    SYNTHESIS_DIM_IDS: Object.freeze([...actual.SYNTHESIS_DIM_IDS, FIXTURE_SYNTHESIS_DIMENSION]),
  };
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function seedSibling(dataRoot: string, jobId: string): void {
  new EvidenceLedgerStore({
    dataRoot,
    jobId,
    sessionId: 'analyst-session',
    dimensionId: 'source-dimension',
  }).append({ tool: 'code.read', callId: 'source-read', content: 'sibling evidence' });
}

function open(dimensionId: string) {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'alembic-loop-ledger-synthesis-'));
  roots.push(dataRoot);
  const jobId = 'job-synthesis-ids';
  seedSibling(dataRoot, jobId);
  const info = vi.fn();
  const warn = vi.fn();
  const store = openLoopEvidence({
    dataRoot,
    defaultJobId: 'runtime-fallback-job',
    sessionId: 'synthesis-session',
    sharedState: { _bootstrapSessionId: jobId, _dimensionMeta: { id: dimensionId } },
    logger: { info, warn },
  });
  return { store, info, warn, jobId };
}

describe('openLoopEvidence synthesis dimension ids', () => {
  it('seeds sibling evidence for every Core synthesis dimension id', () => {
    const { store, info, warn } = open(FIXTURE_SYNTHESIS_DIMENSION);

    expect(store?.listRecent(5).map((entry) => entry.callId)).toEqual([
      'seed:source-dimension:E-1',
    ]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('synthesis seeded 1 sibling'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not seed sibling evidence for an ordinary analysis dimension', () => {
    const { store, info } = open('ordinary-dimension');

    expect(store?.stats().entries).toBe(0);
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('synthesis seeded'));
  });

  it('logs the opened ledger facts without claiming the submit schema variant is active', () => {
    const { info, jobId } = open('ordinary-dimension');

    expect(info).toHaveBeenCalledWith('[EvidenceLedger] production ledger opened', {
      jobId,
      dimensionId: 'ordinary-dimension',
      entries: 0,
    });
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('schema variant'));
  });
});
