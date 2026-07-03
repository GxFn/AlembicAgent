/**
 * 证据采集测试（Wave A E2）。
 * 覆盖：证据工具识别、read/search 结构化归一、文本回退、失败零采集、
 * 标注格式、evidenceCapture 中间件端到端（真实台账落盘 + envelope.text 标注）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  appendEvidenceAnnotation,
  captureEvidenceFromEnvelope,
  resolveEvidenceAction,
} from '../src/agent/evidence/EvidenceCapture.js';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import { evidenceCapture } from '../src/agent/runtime/ToolExecutionPipeline.js';

function makeLedger() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-capture-'));
  return new EvidenceLedgerStore({
    dataRoot,
    jobId: 'job_1',
    sessionId: 'sess_1',
    dimensionId: 'ts-js-module',
  });
}

// 采集只读 ok/text/structuredContent 三字段；测试用最小运行时形态（完整 envelope 字段与采集无关）
function makeEnvelope(overrides: { ok?: boolean; text?: string; structuredContent?: unknown }) {
  return { ok: overrides.ok ?? true, text: overrides.text ?? '', ...overrides };
}

describe('EvidenceCapture（E2 采集即落盘）', () => {
  test('工具族名+action 合成证据工具 id；非证据类返回 null', () => {
    expect(resolveEvidenceAction({ name: 'code', args: { action: 'search' }, id: 'c1' })).toBe(
      'code.search'
    );
    expect(resolveEvidenceAction({ name: 'terminal', args: { action: 'exec' }, id: 'c2' })).toBe(
      'terminal.exec'
    );
    expect(
      resolveEvidenceAction({ name: 'memory', args: { action: 'note_finding' }, id: 'c3' })
    ).toBeNull();
    expect(
      resolveEvidenceAction({ name: 'knowledge', args: { action: 'submit' }, id: 'c4' })
    ).toBeNull();
    expect(resolveEvidenceAction({ name: 'code', args: {}, id: 'c5' })).toBeNull();
  });

  test('code.read 结构化归一：每文件一条，range 取请求区间', () => {
    const ledger = makeLedger();
    const entries = captureEvidenceFromEnvelope(
      ledger,
      { name: 'code', args: { action: 'read', startLine: 5, endLine: 7 }, id: 'call_r' },
      makeEnvelope({
        structuredContent: {
          files: [
            { path: 'lib/a.ts', content: 'L5\nL6\nL7' },
            { path: 'lib/b.ts', content: 'B5\nB6\nB7' },
          ],
        },
      })
    );
    expect(entries.map((e) => e.id)).toEqual(['E-1', 'E-2']);
    expect(entries[0]).toMatchObject({
      tool: 'code.read',
      callId: 'call_r',
      file: 'lib/a.ts',
      range: { start: 5, end: 7 },
    });
    // 落盘后可按绝对行号子区间取回
    expect(ledger.get('E-1@6-6')?.content).toBe('L6');
  });

  test('code.search 按文件分组，行号内嵌自描述，不设 range', () => {
    const ledger = makeLedger();
    const entries = captureEvidenceFromEnvelope(
      ledger,
      { name: 'code', args: { action: 'search', query: 'import type' }, id: 'call_s' },
      makeEnvelope({
        structuredContent: {
          matches: [
            { file: 'lib/a.ts', line: 3, content: "import type { X } from './x.js';" },
            { file: 'lib/a.ts', line: 9, content: "import type { Y } from './y.js';" },
            { file: 'lib/b.ts', line: 1, content: "import type { Z } from './z.js';" },
          ],
        },
      })
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].file).toBe('lib/a.ts');
    expect(entries[0].range).toBeUndefined();
    expect(entries[0].content).toBe(
      "3: import type { X } from './x.js';\n9: import type { Y } from './y.js';"
    );
    expect(entries[1].file).toBe('lib/b.ts');
  });

  test('结构缺席回退模型可见文本；失败返回与非证据工具零采集', () => {
    const ledger = makeLedger();
    const fromText = captureEvidenceFromEnvelope(
      ledger,
      { name: 'terminal', args: { action: 'exec' }, id: 'call_t' },
      makeEnvelope({ text: 'total 8\n-rw-r--r-- package.json' })
    );
    expect(fromText).toHaveLength(1);
    expect(fromText[0].content).toContain('package.json');

    expect(
      captureEvidenceFromEnvelope(
        ledger,
        { name: 'code', args: { action: 'read' }, id: 'call_f' },
        makeEnvelope({ ok: false, text: 'boom' })
      )
    ).toEqual([]);
    expect(
      captureEvidenceFromEnvelope(
        ledger,
        { name: 'memory', args: { action: 'recall' }, id: 'call_m' },
        makeEnvelope({ text: 'anything' })
      )
    ).toEqual([]);
    expect(ledger.stats().entries).toBe(1);
  });

  test('标注格式：id=file:range / id=file / 裸 id；追加于文本尾', () => {
    const ledger = makeLedger();
    const withRange = ledger.append({
      tool: 'code.read',
      callId: 'c1',
      file: 'lib/a.ts',
      range: { start: 5, end: 7 },
      content: 'L5\nL6\nL7',
    });
    const noRange = ledger.append({ tool: 'graph.query', callId: 'c2', content: '{}' });
    expect(appendEvidenceAnnotation('3 matches', [withRange, noRange])).toBe(
      '3 matches\n\n[evidence] E-1=lib/a.ts:5-7; E-2'
    );
    expect(appendEvidenceAnnotation('', [noRange])).toBe('[evidence] E-2');
    expect(appendEvidenceAnnotation('text', [])).toBe('text');
  });

  test('evidenceCapture 中间件端到端：落账+envelope.text 标注；无台账时零行为', () => {
    const ledger = makeLedger();
    const call = { name: 'code', args: { action: 'read' }, id: 'call_mw' };
    const envelope = makeEnvelope({
      text: 'file content here',
      structuredContent: { files: [{ path: 'lib/mw.ts', content: 'const x = 1;' }] },
    });
    type AfterParams = Parameters<typeof evidenceCapture.after>;
    // 中间件仅读 loopCtx.evidenceLedger/diagnostics 与 meta.envelope 的 ok/text/structuredContent——
    // 最小运行时形态经 unknown 收窄（完整 ToolExecContext 与本用例无关）
    evidenceCapture.after(
      call as AfterParams[0],
      null,
      { loopCtx: { evidenceLedger: ledger, diagnostics: null } } as unknown as AfterParams[2],
      { envelope } as unknown as AfterParams[3]
    );
    expect(ledger.stats().entries).toBe(1);
    expect(envelope.text).toBe('file content here\n\n[evidence] E-1=lib/mw.ts');

    // 无台账（非维度场景）：零行为
    const envelope2 = makeEnvelope({ text: 'plain' });
    evidenceCapture.after(
      call as AfterParams[0],
      null,
      { loopCtx: { evidenceLedger: null, diagnostics: null } } as unknown as AfterParams[2],
      { envelope: envelope2 } as unknown as AfterParams[3]
    );
    expect(envelope2.text).toBe('plain');
  });
});
