/**
 * 证据采集测试（Wave A E2）。
 * 覆盖：证据工具识别、read/search 结构化归一、文本回退、失败零采集、
 * 标注格式、evidenceCapture 中间件端到端（真实台账落盘 + envelope.text 标注）。
 *
 * I25（L5-P21）：带证据的 knowledge.submit 走到 Core gateway 之后，submitted* Set 只能由
 * submitDedup 在确认创建后登记；gateway 拒绝/阻断/合并/判重时宿主共享 Set 不变；
 * producer 台账只保留有读取者的字段；指纹算法以固定样例向量锁定并与 Core 公开校验器对拍。
 */
import fs from 'node:fs';
import path from 'node:path';
import { UnifiedValidator } from '@alembic/core/knowledge';
import Logger from '@alembic/core/logging';
import { describe, expect, test, vi } from 'vitest';
import {
  appendEvidenceAnnotation,
  captureEvidenceFromEnvelope,
  resolveEvidenceAction,
} from '../src/agent/evidence/EvidenceCapture.js';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import { evidenceCapture, submitDedup } from '../src/agent/runtime/ToolExecutionPipeline.js';
import { handle as handleKnowledge } from '../src/tools/runtime/handlers/knowledge.js';
import { createTempProject } from './helpers/tempProject.js';

function makeLedger() {
  const dataRoot = createTempProject('evidence-capture-');
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

describe('run-13 EVIDENCE_STALE 事故回归钉（判据×形态交叉）', () => {
  test('带 N| 前缀的 full 模式 batch 项：原文入账+range{1..lineCount}+freshness=fresh', () => {
    const dataRoot = createTempProject('stale-pin-');
    const ledger = new EvidenceLedgerStore({
      dataRoot,
      jobId: 'jp',
      sessionId: 'sp',
      dimensionId: 'architecture',
    });
    const rawFile = '{\n  "name": "x",\n  "type": "module"\n}';
    const numbered = rawFile
      .split('\n')
      .map((l, i) => `${i + 1}|${l}`)
      .join('\n');
    const entries = captureEvidenceFromEnvelope(
      ledger,
      { id: 'c-b', name: 'code', args: { action: 'read', filePaths: ['pkg.json'] } } as never,
      {
        ok: true,
        text: 'batch summary',
        structuredContent: {
          mode: 'batch',
          files: [{ ok: true, path: 'pkg.json', content: numbered, lineCount: 4, mode: 'full' }],
        },
      } as never
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].range).toEqual({ start: 1, end: 4 });
    // 台账存原文（剥显示前缀）——freshness 原文重切与存储哈希同尺，永不假 stale
    expect(entries[0].content).toBe(rawFile);
    expect(ledger.checkFreshness(entries[0].id, rawFile)).toBe('fresh');
    // range 模式：坐标取项自带 startLine/endLine，omitted 尾行剥除
    const ranged = captureEvidenceFromEnvelope(
      ledger,
      { id: 'c-r', name: 'code', args: { action: 'read', filePaths: ['pkg.json'] } } as never,
      {
        ok: true,
        text: 't',
        structuredContent: {
          mode: 'batch',
          files: [
            {
              ok: true,
              path: 'pkg.json',
              content:
                '2|  "name": "x",\n3|  "type": "module"\n... [1 lines omitted; use startLine/endLine for more]',
              lineCount: 4,
              mode: 'range',
              startLine: 2,
              endLine: 3,
            },
          ],
        },
      } as never
    );
    expect(ranged[0].range).toEqual({ start: 2, end: 3 });
    expect(ledger.checkFreshness(ranged[0].id, rawFile)).toBe('fresh');
    // outline/delta 派生视图：诚实降级 file-only（不参与 freshness）
    const outline = captureEvidenceFromEnvelope(
      ledger,
      { id: 'c-o', name: 'code', args: { action: 'read', filePaths: ['big.ts'] } } as never,
      {
        ok: true,
        text: 't',
        structuredContent: {
          mode: 'batch',
          files: [
            {
              ok: true,
              path: 'big.ts',
              content: '## Outline\n- fn a()',
              lineCount: 900,
              mode: 'outline',
            },
          ],
        },
      } as never
    );
    expect(outline[0].file).toBe('big.ts');
    expect(outline[0].range).toBeUndefined();
  });
});

// ─── P1-A F3：单 path read 的 file 归属(此前兜底只查 args.path，运行时形态是 args.params.path) ───
describe('P1-A F3 单 path read 采集', () => {
  test('records actual nested range coordinates and excludes derived-view ranges', () => {
    const ledger = makeLedger();
    const call = {
      name: 'code',
      args: { action: 'read', params: { path: 'src/a.ts', startLine: 10, endLine: 100 } },
      id: 'range',
    };
    const entries = captureEvidenceFromEnvelope(
      ledger,
      call,
      makeEnvelope({ text: '10|const a = 1;\n11|export default a;' })
    );
    expect(entries[0].range).toEqual({ start: 10, end: 11 });
    expect(entries[0].content).toBe('const a = 1;\nexport default a;');
    const derived = captureEvidenceFromEnvelope(
      ledger,
      call,
      makeEnvelope({ text: '[unchanged since last read]' })
    );
    expect(derived[0].range).toBeUndefined();
  });

  test('args.params.path + N| 文本 → 带 file+range 的 verbatim 条目(不再 unverified 折价)', () => {
    const ledger = makeLedger();
    const entries = captureEvidenceFromEnvelope(
      ledger,
      { name: 'code', args: { action: 'read', params: { path: 'src/a.ts' } }, id: 'call_sp' },
      makeEnvelope({ text: '1|const a = 1;\n2|export default a;\n' })
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].file).toBe('src/a.ts');
    expect(entries[0].range).toEqual({ start: 1, end: 2 });
    // verbatim 原文(剥 N| 前缀)——freshness 重切同尺。
    expect(entries[0].content).toBe('const a = 1;\nexport default a;');
  });

  test('派生视图(非 N| 形态)诚实降级 file-only(仍带 file，verified 判据放行)', () => {
    const ledger = makeLedger();
    const entries = captureEvidenceFromEnvelope(
      ledger,
      { name: 'code', args: { action: 'read', params: { path: 'src/big.ts' } }, id: 'call_ol' },
      makeEnvelope({ text: '[outline] 12 functions, 3 classes' })
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].file).toBe('src/big.ts');
    expect(entries[0].range).toBeUndefined();
  });
});

test('capture keeps only successful batch members, preserving legitimate partial successes', async () => {
  const store = makeLedger();
  const entries = captureEvidenceFromEnvelope(
    store,
    {
      name: 'code',
      args: { action: 'read', params: { filePaths: ['src/ok.ts', 'src/failed.ts'] } },
      id: 'partial-batch',
    },
    {
      ok: true,
      text: 'partial batch',
      structuredContent: {
        files: [
          {
            ok: true,
            path: 'src/ok.ts',
            mode: 'range',
            content: '7|confirmed line one\n8|confirmed line two',
          },
          {
            ok: false,
            path: 'src/failed.ts',
            error: 'read denied',
            content: '1|unconfirmed stale payload',
          },
        ],
      },
    }
  );
  expect(entries.map((e) => e.file)).toEqual(['src/ok.ts']);
  expect(entries[0]).toMatchObject({
    range: { start: 7, end: 8 },
    content: 'confirmed line one\nconfirmed line two',
  });
});
test('capture preserves exact multiline and an empty final source line for a successful batch member', async () => {
  const store = makeLedger();
  const entries = captureEvidenceFromEnvelope(
    store,
    {
      name: 'code',
      args: { action: 'read', params: { filePaths: ['src/a.ts', 'src/failed.ts'] } },
      id: 'multiline',
    },
    {
      ok: true,
      text: 'partial batch',
      structuredContent: {
        files: [
          {
            ok: true,
            path: 'src/a.ts',
            mode: 'full',
            content: '1|function keep() {\n2|\n3|  return "7|literal";\n4|}\n5|',
          },
          { ok: false, path: 'src/failed.ts', error: 'read denied' },
        ],
      },
    }
  );
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    range: { start: 1, end: 5 },
    content: 'function keep() {\n\n  return "7|literal";\n}\n',
  });
});
test('capture never assigns a contiguous range to a discontinuous display projection', async () => {
  const store = makeLedger();
  const entries = captureEvidenceFromEnvelope(
    store,
    {
      name: 'code',
      args: { action: 'read', params: { filePaths: ['src/a.ts'] } },
      id: 'discontinuous',
    },
    {
      ok: true,
      text: 'preview',
      structuredContent: {
        files: [{ ok: true, path: 'src/a.ts', mode: 'full', content: '1|start\n80|distant' }],
      },
    }
  );
  expect(entries).toHaveLength(1);
  expect(entries[0].range).toBeUndefined();
  expect(entries[0].content).toBe('1|start\n80|distant');
});

test('keeps confirmed evidence annotations when the next batch append fails', () => {
  const ledger = makeLedger();
  const append = ledger.append.bind(ledger);
  vi.spyOn(ledger, 'append')
    .mockImplementationOnce(append)
    .mockImplementationOnce(() => {
      throw new Error('simulated storage failure');
    });
  const envelope = makeEnvelope({
    text: 'batch read',
    structuredContent: {
      files: [
        { path: 'src/first.ts', content: 'confirmed' },
        { path: 'src/second.ts', content: 'not persisted' },
      ],
    },
  });
  const warn = vi.fn();
  const noteLedgerStats = vi.fn();
  type AfterParams = Parameters<typeof evidenceCapture.after>;
  evidenceCapture.after(
    { name: 'code', args: { action: 'read' }, id: 'partial-capture' },
    null,
    {
      loopCtx: { evidenceLedger: ledger, diagnostics: { warn }, tracker: { noteLedgerStats } },
    } as unknown as AfterParams[2],
    { envelope } as unknown as AfterParams[3]
  );
  expect(ledger.stats().entries).toBe(1);
  expect(envelope.text).toContain('[evidence] E-1=src/first.ts');
  expect(envelope.text).not.toContain('E-2');
  expect(noteLedgerStats).toHaveBeenCalledWith({ entries: 1, distinctFiles: 1 });
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({
      code: 'EVIDENCE_CAPTURE_FAILED',
      message: expect.stringContaining('persisted=1'),
    })
  );
});

// ─── L7-P12 / C14：空读（越界 range、剥前缀后为空）不落账，通用兜底不把空串序列化成 '""' ───
describe('L7-P12 C14 空读不落账', () => {
  type AfterParams = Parameters<typeof evidenceCapture.after>;

  /** 走真实 evidenceCapture 中间件：观察标注、台账统计与 tracker 刷新三者是否保持不变。 */
  function runMiddleware(
    ledger: EvidenceLedgerStore,
    call: { name: string; args: Record<string, unknown>; id: string },
    envelope: { ok: boolean; text: string; structuredContent?: unknown }
  ) {
    const noteLedgerStats = vi.fn();
    const warn = vi.fn();
    evidenceCapture.after(
      call as AfterParams[0],
      null,
      {
        loopCtx: { evidenceLedger: ledger, diagnostics: { warn }, tracker: { noteLedgerStats } },
      } as unknown as AfterParams[2],
      { envelope } as unknown as AfterParams[3]
    );
    return { noteLedgerStats, warn };
  }

  /** 预置一条真实条目：断言“stats 不变”而不是“stats 为零”，排除空台账的偶然通过。 */
  function seededLedger() {
    const ledger = makeLedger();
    ledger.append({
      tool: 'code.read',
      callId: 'seed',
      file: 'src/seed.ts',
      range: { start: 1, end: 1 },
      content: 'seed',
    });
    return ledger;
  }

  function debugMessages(spy: { mock: { calls: unknown[][] } }): string[] {
    return spy.mock.calls.map((args) => String(args[0]));
  }

  test('单 path 越界 range（适配器信封 text 与 structuredContent 均为空串）不落账、不标注、stats 不变并记 debug', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    try {
      const ledger = seededLedger();
      const before = ledger.stats();
      const call = {
        name: 'code',
        args: { action: 'read', params: { path: 'src/a.ts', startLine: 900, endLine: 950 } },
        id: 'eof-single',
      };
      // ToolRouterAdapter 对 handler 返回的 '' 设 structuredContent=''、text=''、ok=true。
      expect(
        captureEvidenceFromEnvelope(ledger, call, makeEnvelope({ text: '', structuredContent: '' }))
      ).toEqual([]);
      const envelope = makeEnvelope({ text: '', structuredContent: '' });
      const { noteLedgerStats, warn } = runMiddleware(ledger, call, envelope);
      expect(envelope.text).toBe('');
      expect(envelope.text).not.toContain('[evidence]');
      expect(noteLedgerStats).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(ledger.stats()).toEqual(before);
      const messages = debugMessages(debug);
      expect(
        messages.some(
          (m) =>
            m.includes('empty read not recorded') &&
            m.includes('src/a.ts') &&
            m.includes('900') &&
            m.includes('950')
        )
      ).toBe(true);
    } finally {
      debug.mockRestore();
    }
  });

  test('单 path 剥 N| 前缀后为空（空文件 `1|`）同样不落账并记 debug', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    try {
      const ledger = seededLedger();
      const before = ledger.stats();
      const entries = captureEvidenceFromEnvelope(
        ledger,
        { name: 'code', args: { action: 'read', params: { path: 'src/empty.ts' } }, id: 'empty-1' },
        makeEnvelope({ text: '1|\n', structuredContent: '1|\n' })
      );
      expect(entries).toEqual([]);
      expect(ledger.stats()).toEqual(before);
      expect(
        debugMessages(debug).some(
          (m) => m.includes('empty read not recorded') && m.includes('src/empty.ts')
        )
      ).toBe(true);
    } finally {
      debug.mockRestore();
    }
  });

  test('批量越界 range 成员跳过，同批非空成员照常落账（range 取项坐标）', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    try {
      const ledger = seededLedger();
      const entries = captureEvidenceFromEnvelope(
        ledger,
        {
          name: 'code',
          args: {
            action: 'read',
            params: { filePaths: ['src/big.ts', 'src/ok.ts'], startLine: 3 },
          },
          id: 'eof-batch-mixed',
        },
        makeEnvelope({
          text: 'batch',
          structuredContent: {
            files: [
              {
                ok: true,
                path: 'src/big.ts',
                content: '',
                lineCount: 2,
                startLine: 3,
                endLine: 2,
                mode: 'range',
              },
              {
                ok: true,
                path: 'src/ok.ts',
                content: '3|kept line',
                lineCount: 9,
                startLine: 3,
                endLine: 3,
                mode: 'range',
              },
            ],
          },
        })
      );
      expect(entries.map((e) => e.file)).toEqual(['src/ok.ts']);
      expect(entries[0]).toMatchObject({ range: { start: 3, end: 3 }, content: 'kept line' });
      expect(ledger.stats()).toEqual({ entries: 2, distinctFiles: 2 });
      expect(
        debugMessages(debug).some(
          (m) =>
            m.includes('empty read not recorded') &&
            m.includes('src/big.ts') &&
            !m.includes('src/ok.ts')
        )
      ).toBe(true);
    } finally {
      debug.mockRestore();
    }
  });

  test('批量成员全部为空（越界 range、剥前缀后为空）：不落账、不标注、stats 不变', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    try {
      const ledger = seededLedger();
      const before = ledger.stats();
      const envelope = makeEnvelope({
        text: 'batch',
        structuredContent: {
          files: [
            {
              ok: true,
              path: 'src/big.ts',
              content: '',
              lineCount: 20,
              startLine: 30,
              endLine: 20,
              mode: 'range',
            },
            { ok: true, path: 'src/empty.ts', content: '1|', lineCount: 1, mode: 'full' },
          ],
        },
      });
      const { noteLedgerStats } = runMiddleware(
        ledger,
        {
          name: 'code',
          args: { action: 'read', params: { filePaths: ['src/big.ts', 'src/empty.ts'] } },
          id: 'eof-batch-all',
        },
        envelope
      );
      expect(envelope.text).toBe('batch');
      expect(noteLedgerStats).not.toHaveBeenCalled();
      expect(ledger.stats()).toEqual(before);
      const messages = debugMessages(debug);
      expect(
        messages.some(
          (m) =>
            m.includes('empty read not recorded') &&
            m.includes('src/big.ts') &&
            m.includes('src/empty.ts')
        )
      ).toBe(true);
    } finally {
      debug.mockRestore();
    }
  });

  test('通用兜底：字符串 structuredContent 用原串（不 JSON 加引号）；空串不落账并记 debug', () => {
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    try {
      const ledger = seededLedger();
      const raw = captureEvidenceFromEnvelope(
        ledger,
        { name: 'terminal', args: { action: 'exec', params: { command: 'ls' } }, id: 'str-sc' },
        makeEnvelope({ text: '', structuredContent: 'total 8\npackage.json' })
      );
      expect(raw).toHaveLength(1);
      expect(raw[0].content).toBe('total 8\npackage.json');
      const before = ledger.stats();

      const emptyEnvelope = makeEnvelope({ text: '', structuredContent: '' });
      const { noteLedgerStats } = runMiddleware(
        ledger,
        { name: 'terminal', args: { action: 'exec', params: { command: 'true' } }, id: 'empty-sc' },
        emptyEnvelope
      );
      expect(emptyEnvelope.text).toBe('');
      expect(noteLedgerStats).not.toHaveBeenCalled();
      expect(ledger.stats()).toEqual(before);
      expect(
        debugMessages(debug).some(
          (m) => m.includes('empty result not recorded') && m.includes('terminal.exec')
        )
      ).toBe(true);
    } finally {
      debug.mockRestore();
    }
  });
});

// ─── I25（L5-P21）：submitted* Set 所有权——只有 submitDedup 在确认创建后登记 ───
type DedupAfterParams = Parameters<typeof submitDedup.after>;
type ScriptedGatewayOutcome = 'created' | 'create_failed' | 'blocked' | 'merged' | 'duplicates';

const OWNERSHIP_SOURCE =
  "import type { X } from './x.js';\nexport const a = 1;\nexport const b = 2;";
/** ≥30 字符且去注释/空白后 ≥20 字符：Core 与 submitDedup 都会为它登记代码指纹。 */
const OWNERSHIP_PATTERN = "import type { X } from './x.js';\nexport const a = 1;";
const OWNERSHIP_PATTERN_FINGERPRINT = "importtype{x}from'./x.js';exportconsta=1;";

function ownershipParams(title: string) {
  return {
    title,
    description: '模块使用 import type 声明类型级导入，编译后擦除。',
    content: {
      markdown:
        "## 类型导入隔离\n\n模块统一使用 import type 声明类型级导入，TypeScript 编译后完全擦除，不产生任何运行时引用。这样做保证了类型安全与打包体积解耦，消费方不会因为引用类型而意外引入运行时依赖，打包器也能对纯类型模块做彻底的摇树优化。项目中所有仅消费类型的模块都遵循这一约定，形成一致的导入风格与可审计的依赖关系。\n\n```typescript\nimport type { X } from './x.js';\n```\n(来源: lib/a.ts:1-3)\n\n适用于所有仅类型消费场景；运行时需要值时改用普通 import 并显式声明依赖。违反该约定会让类型依赖悄悄变成运行时依赖，增大产物体积并引入不必要的模块加载开销。",
      rationale:
        '类型与运行时依赖解耦：import type 编译期完全擦除保证零运行时引用，打包体积可控，且消费方的依赖关系清晰可审计、便于长期维护。',
      pattern: OWNERSHIP_PATTERN,
    },
    kind: 'fact',
    trigger: '@Type-Import',
    whenClause: '当模块只消费类型不消费运行时值时',
    doClause: '所有类型级导入都应该用 import type 声明',
    dontClause: '不要在仅类型消费场景用普通 import 引入类型',
    reasoning: {
      whyStandard: '类型导入不产生运行时引用。',
      sources: ['lib/a.ts:1-3'],
      confidence: 0.9,
      evidenceRefs: ['E-1'],
    },
  };
}

/**
 * 生产形态夹具：宿主注入跨维度共享的 submitted* Set（预置一条此前真实创建的候选），
 * runtimeBridge 把同一引用投影到 ctx.runtime；gateway 按 Core RecipeProductionGateway Step 1
 * 的真实做法，用真实 UnifiedValidator 持有传入 Set 的引用、校验通过后立即 recordSubmission，
 * 再按脚本返回去向。这样 Core 对传入 Set 的写入与修复前完全一致，测试只观察 Agent 侧是否把
 * 宿主共享 Set 交出去。
 */
function makeOwnershipFixture() {
  const projectRoot = createTempProject('submit-ownership-');
  const dataRoot = createTempProject('submit-ownership-data-');
  fs.mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'lib/a.ts'), OWNERSHIP_SOURCE, 'utf8');
  const ledger = new EvidenceLedgerStore({
    dataRoot,
    jobId: 'job_i25',
    sessionId: 'sess_i25',
    dimensionId: 'ts-js-module',
  });
  ledger.append({
    tool: 'code.read',
    callId: 'c1',
    file: 'lib/a.ts',
    range: { start: 1, end: 3 },
    content: OWNERSHIP_SOURCE,
  });
  const submittedTitles = new Set<string>(['prior candidate']);
  const submittedTriggers = new Set<string>(['@prior']);
  const submittedPatterns = new Set<string>();
  const sharedState: Record<string, unknown> = {
    _sessionCounters: {},
    submittedTitles,
    submittedTriggers,
    submittedPatterns,
  };
  const script: ScriptedGatewayOutcome[] = [];
  const received: Array<{
    titles: Set<string> | undefined;
    triggers: Set<string> | undefined;
    fingerprints: Set<string> | undefined;
  }> = [];
  let createdCount = 0;
  const gateway = {
    createOrStage: async (req: {
      items: Record<string, unknown>[];
      options?: {
        existingTitles?: Set<string>;
        existingTriggers?: Set<string>;
        existingFingerprints?: Set<string>;
      };
    }) => {
      const item = req.items[0];
      const options = req.options ?? {};
      received.push({
        titles: options.existingTitles,
        triggers: options.existingTriggers,
        fingerprints: options.existingFingerprints,
      });
      const base = {
        created: [] as unknown[],
        duplicates: [] as unknown[],
        rejected: [] as unknown[],
        merged: [] as unknown[],
        blocked: [] as unknown[],
        supersedeProposal: null,
        production: { capability: 'knowledge-submit', source: 'alembic-agent' },
      };
      const validator = new UnifiedValidator({
        existingTitles: options.existingTitles,
        existingTriggers: options.existingTriggers,
        existingFingerprints: options.existingFingerprints,
      });
      const report = validator.validateDetailed(item);
      // 只取唯一性层追加的错误（结构层错误与本用例无关）：命中即按 Core 的 validation_failed 拒绝。
      const uniquenessErrors = report.result.errors.slice(report.structural.errors.length);
      if (uniquenessErrors.length > 0) {
        return {
          ...base,
          rejected: [
            {
              index: 0,
              title: String(item.title),
              reason: 'validation_failed',
              errors: uniquenessErrors,
              warnings: [],
            },
          ],
        };
      }
      const content = item.content as Record<string, unknown> | undefined;
      validator.recordSubmission(
        String(item.title),
        typeof content?.pattern === 'string' ? content.pattern : undefined,
        typeof item.trigger === 'string' ? item.trigger : undefined
      );
      const outcome = script.shift() ?? 'created';
      switch (outcome) {
        case 'created':
          createdCount += 1;
          return {
            ...base,
            created: [
              {
                index: 0,
                id: `recipe-${createdCount}`,
                title: String(item.title),
                lifecycle: 'pending',
                raw: item,
              },
            ],
          };
        case 'create_failed':
          return {
            ...base,
            rejected: [
              {
                index: 0,
                title: String(item.title),
                reason: 'create_failed',
                errors: ['db down'],
                warnings: [],
              },
            ],
          };
        case 'blocked':
          return {
            ...base,
            blocked: [{ index: 0, title: String(item.title), consolidation: { action: 'block' } }],
          };
        case 'merged':
          return {
            ...base,
            merged: [
              {
                index: 0,
                proposalId: 'proposal-1',
                type: 'enhance',
                targetRecipeId: 'recipe-existing',
                targetTitle: 'Existing recipe',
                status: 'pending',
                expiresAt: 0,
                message: 'merged into proposal',
              },
            ],
          };
        case 'duplicates':
          return {
            ...base,
            duplicates: [
              {
                index: 0,
                title: String(item.title),
                similarTo: [{ file: 'existing.md', title: 'Existing recipe', similarity: 0.9 }],
              },
            ],
          };
      }
    },
    evaluateReadiness: async () => ({
      ready: true,
      schemaVersion: '1',
      profileHash: null,
      documentSetHash: null,
      violations: [],
      warnings: [],
    }),
  };
  let callIndex = 0;
  /** 工具执行：每次调用新的 runtime 投影，submitted* 与宿主共享 Set 为同一引用（runtimeBridge 形态）。 */
  const runTool = async (params: Record<string, unknown>) =>
    (await handleKnowledge('submit', params, {
      recipeGateway: gateway,
      projectRoot,
      runtime: {
        sharedState: { ...sharedState },
        submittedTitles,
        submittedTriggers,
        submittedPatterns,
        evidenceLedger: ledger,
      },
      sessionStore: null,
    } as never)) as { ok: boolean; data?: Record<string, unknown> | null; error?: unknown };
  /** 工具返回后按 ToolExecutionPipeline 顺序运行 submitDedup（唯一登记者）。 */
  const register = (params: Record<string, unknown>, result: unknown) => {
    callIndex += 1;
    const meta = { blocked: false, cacheHit: false, isNew: true, isSubmit: false, durationMs: 0 };
    submitDedup.after(
      { id: `submit-${callIndex}`, name: 'knowledge', args: { action: 'submit', params } },
      result,
      {
        runtime: {},
        loopCtx: {
          sharedState,
          context: { pipelinePhase: 'produce' },
          budget: { targetSubmits: 3 },
        },
        iteration: callIndex,
      } as unknown as DedupAfterParams[2],
      meta as unknown as DedupAfterParams[3]
    );
    return meta;
  };
  return {
    script,
    received,
    register,
    runTool,
    sharedState,
    submittedTitles,
    submittedTriggers,
    submittedPatterns,
  };
}

describe('I25 submitted* Set 所有权：只有 submitDedup 在确认创建后登记', () => {
  // create_failed 对应 Core rejected(reason=create_failed)；其余三类是 Core 的 blocked/merged/duplicates 去向。
  test.each([
    'create_failed',
    'blocked',
    'merged',
    'duplicates',
  ] as const)('gateway 返回 %s 时宿主共享 Set 不变，同标题重试不被误判重复', async (outcome) => {
    const fixture = makeOwnershipFixture();
    fixture.script.push(outcome, 'created');
    const params = ownershipParams('Type Import Isolation');

    const first = await fixture.runTool(params);
    const firstMeta = fixture.register(params, first);
    expect(firstMeta.isSubmit).toBe(false);
    // Core 的批内登记只能落在副本上：宿主共享 Set 保持预置内容，没有被未落库候选占位。
    expect([...fixture.submittedTitles]).toEqual(['prior candidate']);
    expect([...fixture.submittedTriggers]).toEqual(['@prior']);
    expect([...fixture.submittedPatterns]).toEqual([]);
    // gateway 拿到的是内容相同的副本：跨调用去重仍能看到此前真实创建的候选。
    const [received] = fixture.received;
    expect(received.titles).not.toBe(fixture.submittedTitles);
    expect(received.triggers).not.toBe(fixture.submittedTriggers);
    expect(received.fingerprints).not.toBe(fixture.submittedPatterns);
    expect(received.titles?.has('prior candidate')).toBe(true);
    expect(received.triggers?.has('@prior')).toBe(true);

    // 模型修正后用同一标题重试：不能再被 Core 以「标题重复/trigger 重复」拒绝。
    const retry = await fixture.runTool(params);
    expect(retry.ok).toBe(true);
    expect(retry.data?.status).toBe('created');
    const retryMeta = fixture.register(params, retry);
    expect(retryMeta.isSubmit).toBe(true);
    expect(fixture.submittedTitles.has('type import isolation')).toBe(true);
    expect(fixture.submittedTriggers.has('@type-import')).toBe(true);
    expect(fixture.submittedPatterns.has(OWNERSHIP_PATTERN_FINGERPRINT)).toBe(true);
  });

  test('确认创建：工具执行不触碰宿主 Set，submitDedup 登记后跨调用去重生效', async () => {
    const fixture = makeOwnershipFixture();
    const params = ownershipParams('Type Import Isolation');

    const created = await fixture.runTool(params);
    expect(created.ok).toBe(true);
    expect(created.data?.status).toBe('created');
    // 登记前：Core 已对副本 recordSubmission，宿主 Set 仍只含预置条目。
    expect([...fixture.submittedTitles]).toEqual(['prior candidate']);
    expect([...fixture.submittedPatterns]).toEqual([]);

    const meta = fixture.register(params, created);
    expect(meta.isSubmit).toBe(true);
    expect([...fixture.submittedTitles].sort()).toEqual([
      'prior candidate',
      'type import isolation',
    ]);
    expect([...fixture.submittedTriggers].sort()).toEqual(['@prior', '@type-import']);
    expect([...fixture.submittedPatterns]).toEqual([OWNERSHIP_PATTERN_FINGERPRINT]);

    // 同一候选再次提交：副本带着已登记内容进入 Core，按标题/trigger/指纹重复拒绝。
    const duplicate = await fixture.runTool(params);
    expect(duplicate.ok).toBe(false);
    expect(String(duplicate.error)).toContain('validation_failed');
    expect(fixture.register(params, duplicate).isSubmit).toBe(false);
  });

  test('producer 台账只保留有读取者的字段，createdCount 等于条目数', async () => {
    const fixture = makeOwnershipFixture();
    const first = ownershipParams('Type Import Isolation');
    fixture.register(first, await fixture.runTool(first));
    const second = {
      ...ownershipParams('Type Import Boundary'),
      trigger: '@type-boundary',
      content: { ...ownershipParams('x').content, pattern: undefined },
    };
    fixture.register(second, await fixture.runTool(second));

    expect(fixture.sharedState._producerSubmitLedger).toEqual({
      createdCount: 2,
      targetSubmits: 3,
      entries: [
        {
          payloadStored: true,
          requiredFieldsComplete: true,
          sourceCount: 1,
          status: 'created',
          title: 'Type Import Isolation',
        },
        {
          payloadStored: true,
          requiredFieldsComplete: true,
          sourceCount: 1,
          status: 'created',
          title: 'Type Import Boundary',
        },
      ],
    });
  });

  test('Core 回执标题与模型标题不同（风格修复改名）时两者都登记，保持修复前的去重覆盖', () => {
    const fixture = makeOwnershipFixture();
    const params = { title: 'Singleton pattern', trigger: '@app-config' };
    const meta = fixture.register(params, {
      ok: true,
      data: {
        status: 'created',
        id: 'recipe-renamed',
        lifecycle: 'pending',
        title: 'AppConfig Singleton Lifecycle',
      },
    });
    expect(meta.isSubmit).toBe(true);
    expect([...fixture.submittedTitles].sort()).toEqual([
      'appconfig singleton lifecycle',
      'prior candidate',
      'singleton pattern',
    ]);
  });
});

/**
 * 指纹样例向量：submitDedup 的代码指纹与 Core gateRules.codeFingerprint（经
 * UnifiedValidator.recordSubmission / #checkUniqueness 使用）同源。Core 稳定门面尚未导出
 * codeFingerprint，这里用固定向量锁定算法与 30/20 阈值，并经 Core 公开的 UnifiedValidator
 * 对拍：Agent 登记的指纹必须被 Core 识别为「代码模式重复」，Core 不登记的输入 Agent 也不登记。
 */
describe('I25 submitDedup 代码指纹与 Core 同源（固定样例向量 + 公开校验器对拍）', () => {
  const vectors: Array<{ name: string; pattern: string; fingerprint: string | null }> = [
    {
      name: '去行注释/块注释/空白并转小写',
      pattern:
        '// Leading comment\nconst Client = new FooClient({ Retries: 3 }); /* block */\nexport default Client;',
      fingerprint: 'constclient=newfooclient({retries:3});exportdefaultclient;',
    },
    {
      name: '超长片段截断到 200 字符',
      pattern: `export function Register(Bus: EventBus) {\n  ${"Bus.On('Topic', Handler);\n  ".repeat(10)}}`,
      fingerprint:
        "exportfunctionregister(bus:eventbus){bus.on('topic',handler);bus.on('topic',handler);bus.on('topic',handler);bus.on('topic',handler);bus.on('topic',handler);bus.on('topic',handler);bus.on('topic',hand",
    },
    {
      name: '原文恰好 31 字符、指纹 24 字符：登记',
      pattern: 'const shortCode = 1; let b = 2;',
      fingerprint: 'constshortcode=1;letb=2;',
    },
    {
      name: '原文 29 字符（低于 30 下限）：不登记',
      pattern: 'export const total=sum(a,b);x',
      fingerprint: null,
    },
    {
      name: '原文达标但指纹 3 字符（低于 20 下限）：不登记',
      pattern: '// only a comment line here\nx=1',
      fingerprint: null,
    },
    {
      name: 'URL 中的 // 与 Core 同样按行注释剥除：不登记',
      pattern: "const url = 'https://example.com/api/v1/items';",
      fingerprint: null,
    },
  ];

  function agentFingerprints(pattern: string): Set<string> {
    const sharedState = {
      submittedTitles: new Set<string>(),
      submittedTriggers: new Set<string>(),
      submittedPatterns: new Set<string>(),
    };
    const meta = { blocked: false, cacheHit: false, isNew: true, isSubmit: false, durationMs: 0 };
    submitDedup.after(
      {
        id: 'fp',
        name: 'knowledge',
        args: { action: 'submit', params: { title: 'Fingerprint', content: { pattern } } },
      },
      { ok: true, data: { status: 'created', id: 'recipe-fp', lifecycle: 'pending' } },
      { runtime: {}, loopCtx: { sharedState }, iteration: 1 } as unknown as DedupAfterParams[2],
      meta as unknown as DedupAfterParams[3]
    );
    expect(meta.isSubmit).toBe(true);
    return sharedState.submittedPatterns;
  }

  /** 候选只带 content.pattern：标题/trigger 为空，唯一性层新增的错误只可能来自代码指纹。 */
  function coreFlagsFingerprintDuplicate(validator: UnifiedValidator, pattern: string): boolean {
    const report = validator.validateDetailed({ content: { pattern } });
    return report.result.errors.length > report.structural.errors.length;
  }

  test.each(vectors)('$name', ({ pattern, fingerprint }) => {
    const agentSet = agentFingerprints(pattern);
    expect([...agentSet]).toEqual(fingerprint === null ? [] : [fingerprint]);

    // 对拍一：Agent 登记的指纹交给 Core 校验器（副本），同一片段必须被判为代码重复。
    const fromAgent = new UnifiedValidator({ existingFingerprints: new Set(agentSet) });
    // 对拍二：Core 自己登记同一片段后是否判重，决定 Agent 是否也应登记（阈值与算法一致）。
    const coreSelf = new UnifiedValidator();
    coreSelf.recordSubmission(null, pattern, null);
    const coreRegisters = coreFlagsFingerprintDuplicate(coreSelf, pattern);
    expect(coreRegisters).toBe(fingerprint !== null);
    expect(coreFlagsFingerprintDuplicate(fromAgent, pattern)).toBe(coreRegisters);
  });
});
