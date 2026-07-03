/**
 * evidence 工具与配额钳制测试（Wave A E4）。
 * 覆盖：evidence.get（取回/子区间/行数预算/无效引用候选提示/无台账显式失败）、
 * evidence.search（路径+内容匹配、limit 钳制）、RECORD/VERIFY 相位门放行 evidence 只读、
 * 配额受台账 distinctFiles 钳制（P4 收口）、采集中间件刷新 tracker 台账统计。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { targetMemoryFindingCount } from '../src/agent/context/exploration/ExplorationStrategies.js';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import {
  evidenceCapture,
  recordRepairOnlyGate,
} from '../src/agent/runtime/ToolExecutionPipeline.js';
import {
  EVIDENCE_GET_MAX_LINES,
  handle as handleEvidence,
} from '../src/tools/runtime/handlers/evidence.js';

type EvidenceHandlerCtx = Parameters<typeof handleEvidence>[2];

function makeLedger() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-tool-'));
  return new EvidenceLedgerStore({
    dataRoot,
    jobId: 'job_1',
    sessionId: 'sess_1',
    dimensionId: 'ts-js-module',
  });
}

function makeCtx(ledger: EvidenceLedgerStore | null): EvidenceHandlerCtx {
  // handler 仅消费 runtime.evidenceLedger——最小运行时形态经 unknown 收窄
  return { runtime: { evidenceLedger: ledger } } as unknown as EvidenceHandlerCtx;
}

describe('evidence 工具（E4 全链可查）', () => {
  test('get：整条与子区间取回；无效引用附近期候选；无台账显式失败', async () => {
    const ledger = makeLedger();
    ledger.append({
      tool: 'code.read',
      callId: 'c1',
      file: 'lib/a.ts',
      range: { start: 10, end: 12 },
      content: 'L10\nL11\nL12',
    });

    const whole = await handleEvidence('get', { ref: 'E-1' }, makeCtx(ledger));
    expect(whole.ok).toBe(true);
    expect(whole.data).toMatchObject({ id: 'E-1', file: 'lib/a.ts', content: 'L10\nL11\nL12' });

    const sliced = await handleEvidence('get', { ref: 'E-1@11-11' }, makeCtx(ledger));
    expect(sliced.ok).toBe(true);
    expect(sliced.data).toMatchObject({ content: 'L11', range: { start: 11, end: 11 } });

    const bad = await handleEvidence(
      'get',
      { ref: 'Alembic/lib/types/agent.ts:1-7' },
      makeCtx(ledger)
    );
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain('E-1=lib/a.ts');

    const noLedger = await handleEvidence('get', { ref: 'E-1' }, makeCtx(null));
    expect(noLedger.ok).toBe(false);
    expect(String(noLedger.error)).toContain('维度运行');
  });

  test('get：超行数预算保头截断并提示子区间缩小', async () => {
    const ledger = makeLedger();
    const longContent = Array.from({ length: 200 }, (_, i) => `L${i + 1}`).join('\n');
    ledger.append({ tool: 'terminal.exec', callId: 'c1', content: longContent });
    const result = await handleEvidence('get', { ref: 'E-1' }, makeCtx(ledger));
    expect(result.ok).toBe(true);
    const data = result.data as { content: string; capped: boolean; lineCount: number };
    expect(data.capped).toBe(true);
    expect(data.lineCount).toBe(200);
    expect(data.content.split('\n').length).toBeLessThanOrEqual(EVIDENCE_GET_MAX_LINES);
    expect(data.content).toContain('narrow with');
  });

  test('search：路径与内容双匹配，limit 钳制到 8', async () => {
    const ledger = makeLedger();
    ledger.append({ tool: 'code.read', callId: 'c1', file: 'lib/alpha.ts', content: 'const x' });
    ledger.append({
      tool: 'code.search',
      callId: 'c2',
      file: 'lib/beta.ts',
      content: "3: import type { X } from './x.js';",
    });
    for (let i = 0; i < 10; i++) {
      ledger.append({ tool: 'terminal.exec', callId: `t${i}`, content: `noise-${i} import type` });
    }

    const byPath = await handleEvidence('search', { query: 'alpha' }, makeCtx(ledger));
    expect(byPath.ok).toBe(true);
    expect((byPath.data as { count: number }).count).toBe(1);

    const byContent = await handleEvidence(
      'search',
      { query: 'import type', limit: 99 },
      makeCtx(ledger)
    );
    expect((byContent.data as { count: number }).count).toBe(8); // limit 钳制

    const empty = await handleEvidence('search', { query: 'missing-zzz' }, makeCtx(ledger));
    expect((empty.data as { count: number }).count).toBe(0);
  });

  test('RECORD 相位门放行 evidence 只读，仍拦 code.read', () => {
    type BeforeParams = Parameters<typeof recordRepairOnlyGate.before>;
    const ctx = {
      loopCtx: { sharedState: { _recordRepairOnly: true } },
    } as unknown as BeforeParams[1];

    const allowEvidence = recordRepairOnlyGate.before(
      { name: 'evidence', args: { action: 'get', params: { ref: 'E-1' } }, id: 'c1' },
      ctx
    );
    expect(allowEvidence).toBeUndefined();

    const blockCode = recordRepairOnlyGate.before(
      { name: 'code', args: { action: 'read', params: {} }, id: 'c2' },
      ctx
    );
    expect(blockCode?.blocked).toBe(true);
    expect(String((blockCode?.result as { error?: string })?.error)).toContain('evidenceRefs');
  });

  test('配额钳制（P4 收口）：受台账 distinctFiles×2 约束，缺席回退原公式', () => {
    // 真机事故参数：37 次证据调用、扎实覆盖 ~5 个文件 → 钳到 10 而非逼 19
    expect(targetMemoryFindingCount({ evidenceToolCallCount: 37, ledgerDistinctFiles: 5 })).toBe(
      10
    );
    expect(targetMemoryFindingCount({ evidenceToolCallCount: 37, ledgerDistinctFiles: 0 })).toBe(3);
    expect(targetMemoryFindingCount({ evidenceToolCallCount: 37 })).toBe(19); // 无台账回退
    expect(targetMemoryFindingCount({ evidenceToolCallCount: 4, ledgerDistinctFiles: 9 })).toBe(3);
  });

  test('采集中间件刷新 tracker 台账统计（配额数据源接线）', () => {
    const ledger = makeLedger();
    const seen: Array<{ distinctFiles: number }> = [];
    const tracker = {
      noteLedgerStats(stats: { distinctFiles: number }) {
        seen.push(stats);
      },
    };
    type AfterParams = Parameters<typeof evidenceCapture.after>;
    evidenceCapture.after(
      { name: 'code', args: { action: 'read' }, id: 'c1' } as AfterParams[0],
      null,
      {
        loopCtx: { evidenceLedger: ledger, tracker, diagnostics: null },
      } as unknown as AfterParams[2],
      {
        envelope: {
          ok: true,
          text: 'x',
          structuredContent: { files: [{ path: 'lib/a.ts', content: 'const x = 1;' }] },
        },
      } as unknown as AfterParams[3]
    );
    expect(seen).toEqual([{ entries: 1, distinctFiles: 1 }]);
  });
});
