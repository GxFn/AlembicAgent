/**
 * 证据台账存储测试（Wave A E1）。
 * 覆盖：写读回、JSONL 落盘形态（确定性序列化）、子区间切片（绝对行号/内容相对两型）、
 * 检索与统计、截断上限、脱敏注入、回读续接（hydrate/resume）、非法引用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  EVIDENCE_TRUNCATION_MARKER,
  EvidenceLedgerStore,
  hashEvidenceContent,
} from '../src/agent/evidence/EvidenceLedgerStore.js';
import { redactDeveloperText } from '../src/agent/utils/Redaction.js';

function makeStore(overrides: { redactor?: (t: string) => string } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-ledger-'));
  const store = new EvidenceLedgerStore({
    dataRoot,
    jobId: 'bootstrap_test_1',
    sessionId: 'bs_test_1',
    dimensionId: 'ts-js-module',
    redactor: overrides.redactor,
  });
  return { dataRoot, store };
}

describe('EvidenceLedgerStore', () => {
  test('append→get 写读回，id 单调，JSONL 落盘且 key 排序（确定性序列化）', () => {
    const { store } = makeStore();
    const first = store.append({
      tool: 'code.read',
      callId: 'call_1',
      file: 'lib/types/graph-shared.ts',
      range: { start: 1, end: 3 },
      content:
        "export type { GraphSharedWire } from './graph-shared-types.js';\nexport { toWire } from './to-wire.js';\nexport {};",
    });
    const second = store.append({
      tool: 'code.search',
      callId: 'call_2',
      file: 'package.json',
      content: '9: "module": "NodeNext"',
    });

    expect(first.id).toBe('E-1');
    expect(second.id).toBe('E-2');
    expect(store.get('E-1')?.file).toBe('lib/types/graph-shared.ts');
    expect(store.get('E-1')?.content).toContain('graph-shared-types');
    expect(store.get('E-1')?.contentHash).toBe(hashEvidenceContent(first.content));

    const lines = fs.readFileSync(store.filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const keys = Object.keys(JSON.parse(lines[0]) as Record<string, unknown>);
    expect(keys).toEqual([...keys].sort()); // 顶层 key 字母序=可字节比对
    expect(store.filePath).toContain(path.join('evidence-ledger', 'bootstrap_test_1'));
  });

  test('子区间切片：条目带 range 时按文件绝对行号，越界返回 null', () => {
    const { store } = makeStore();
    store.append({
      tool: 'code.read',
      callId: 'call_1',
      file: 'lib/a.ts',
      range: { start: 10, end: 14 },
      content: 'L10\nL11\nL12\nL13\nL14',
    });
    const sliced = store.get('E-1@11-12');
    expect(sliced?.content).toBe('L11\nL12');
    expect(sliced?.range).toEqual({ start: 11, end: 12 });
    expect(store.get('E-1@9-12')).toBeNull(); // 越下界
    expect(store.get('E-1@13-20')).toBeNull(); // 越上界
    // 派生副本不污染原条目
    expect(store.get('E-1')?.content).toBe('L10\nL11\nL12\nL13\nL14');
  });

  test('子区间切片：条目无 range 时按内容 1-indexed 行号', () => {
    const { store } = makeStore();
    store.append({
      tool: 'terminal.exec',
      callId: 'call_1',
      content: 'out-1\nout-2\nout-3',
    });
    expect(store.get('E-1@2-3')?.content).toBe('out-2\nout-3');
    expect(store.get('E-1@4-5')).toBeNull();
  });

  test('searchByFile 与 stats（distinctFiles 去重）', () => {
    const { store } = makeStore();
    store.append({ tool: 'code.read', callId: 'c1', file: 'lib/a.ts', content: 'a' });
    store.append({ tool: 'code.search', callId: 'c2', file: 'lib/a.ts', content: 'a-hit' });
    store.append({ tool: 'code.read', callId: 'c3', file: 'lib/b.ts', content: 'b' });
    expect(store.searchByFile('a.ts').map((e) => e.id)).toEqual(['E-1', 'E-2']);
    expect(store.searchByFile('lib/').length).toBe(3);
    expect(store.searchByFile('missing.ts')).toEqual([]);
    expect(store.stats()).toEqual({ entries: 3, distinctFiles: 2 });
  });

  test('单条内容超上限保头截断并附显式标记，hash 按截断后内容计', () => {
    const { store } = makeStore();
    const entry = store.append({
      tool: 'code.read',
      callId: 'c1',
      file: 'lib/huge.ts',
      content: 'x'.repeat(20_000),
    });
    expect(entry.content.length).toBeLessThanOrEqual(8_000);
    expect(entry.content.endsWith(EVIDENCE_TRUNCATION_MARKER)).toBe(true);
    expect(entry.contentHash).toBe(hashEvidenceContent(entry.content));
  });

  test('redactor 注入生效（与 LLM 工件同一把尺）', () => {
    const { store } = makeStore({ redactor: redactDeveloperText });
    const entry = store.append({
      tool: 'terminal.exec',
      callId: 'c1',
      content: 'echo api_key: verysecretvalue',
    });
    expect(entry.content).toBe('echo api_key: [redacted]');
  });

  test('hydrate 续接：同路径新实例读回条目且 seq 不重号（中断重建/续跑）', () => {
    const { dataRoot, store } = makeStore();
    store.append({ tool: 'code.read', callId: 'c1', file: 'lib/a.ts', content: 'a' });
    store.append({ tool: 'code.read', callId: 'c2', file: 'lib/b.ts', content: 'b' });

    const resumed = new EvidenceLedgerStore({
      dataRoot,
      jobId: 'bootstrap_test_1',
      sessionId: 'bs_test_1',
      dimensionId: 'ts-js-module',
    });
    expect(resumed.stats().entries).toBe(2);
    expect(resumed.get('E-2')?.file).toBe('lib/b.ts');
    const third = resumed.append({
      tool: 'code.read',
      callId: 'c3',
      file: 'lib/c.ts',
      content: 'c',
    });
    expect(third.id).toBe('E-3');
  });

  test('非法引用一律 null：file:line 形态（捏造典型）/未知 id/坏区间', () => {
    const { store } = makeStore();
    store.append({ tool: 'code.read', callId: 'c1', file: 'lib/a.ts', content: 'a' });
    expect(store.get('Alembic/lib/types/agent.ts:1-7')).toBeNull();
    expect(store.get('E-99')).toBeNull();
    expect(store.get('E-1@3-1')).toBeNull();
    expect(store.has('E-1')).toBe(true);
    expect(store.has('E-99')).toBe(false);
  });
});
