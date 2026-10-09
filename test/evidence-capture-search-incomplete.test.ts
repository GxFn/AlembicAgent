/**
 * L4-P13（module-review-2026-10-01 I13）配套：code.search 的 incomplete 回执在采集端的边界。
 *
 * - partial（某个 pattern 输出超限 / 引擎部分失败）回执里的 matches 仍是真实观察到的原文，照常落账；
 *   漏搜的 pattern 由 code_search_incomplete 诊断说明，不由台账推断“不存在”。
 * - timeout / aborted 是失败状态，采集入口整体拒绝，即使回执带着已观察到的命中也不落账。
 */
import { describe, expect, it } from 'vitest';
import { captureEvidenceFromEnvelope } from '../src/agent/evidence/EvidenceCapture.js';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import { createTempProject } from './helpers/tempProject.js';

function makeLedger() {
  return new EvidenceLedgerStore({
    dataRoot: createTempProject('evidence-capture-p13-'),
    jobId: 'job_p13',
    sessionId: 'sess_p13',
    dimensionId: 'ts-js-module',
  });
}

const call = {
  name: 'code',
  args: { action: 'search', params: { patterns: ['overflowing', 'needle'] } },
  id: 'call_p13',
};

const observed = {
  total: 4,
  shown: 3,
  incomplete: true as const,
  matches: [
    { file: 'src/a.ts', line: 1, content: 'overflowing one' },
    { file: 'src/b.ts', line: 2, content: 'needle here' },
    { file: 'src/a.ts', line: 5, content: 'overflowing two' },
  ],
};

describe('EvidenceCapture × code.search incomplete receipts (L4-P13)', () => {
  it('ledgers every observed match of a partial multi-pattern search verbatim, grouped by file', () => {
    const envelope = {
      ok: true,
      status: 'partial',
      text: JSON.stringify(observed, null, 2),
      structuredContent: observed,
    };
    const entries = captureEvidenceFromEnvelope(makeLedger(), call, envelope);
    expect(entries.map((entry) => [entry.file, entry.range, entry.content])).toEqual([
      ['src/a.ts', undefined, '1: overflowing one\n5: overflowing two'],
      ['src/b.ts', undefined, '2: needle here'],
    ]);
  });

  it.each([
    'timeout',
    'aborted',
  ])('ledgers nothing from a %s search even with observed matches', (status) => {
    const envelope = {
      ok: true,
      status,
      text: JSON.stringify(observed, null, 2),
      structuredContent: observed,
    };
    expect(captureEvidenceFromEnvelope(makeLedger(), call, envelope)).toEqual([]);
  });
});
