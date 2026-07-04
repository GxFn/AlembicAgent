/**
 * E7 接受率治理测试：手写路径自动矫正（basename 唯一匹配台账真实形态）、
 * 证据驱动 scope 收窄、逐违规修复模板。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import {
  buildViolationRepairTemplates,
  sanitizeSubmissionEvidence,
} from '../src/tools/runtime/handlers/submitEvidenceExpansion.js';

function makeWorkspace() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-proj-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-data-'));
  // 多仓形态：真实文件在 AlembicAgent/config/ 下（模型常漏写仓库前缀）
  fs.mkdirSync(path.join(projectRoot, 'AlembicAgent/config'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'AlembicAgent/config/agent-public-api-boundary.json'),
    '{}',
    'utf8'
  );
  const ledger = new EvidenceLedgerStore({
    dataRoot,
    jobId: 'job_1',
    sessionId: 'sess_1',
    dimensionId: 'ts-js-module',
  });
  ledger.append({
    tool: 'code.read',
    callId: 'c1',
    file: 'AlembicAgent/config/agent-public-api-boundary.json',
    range: { start: 1, end: 1 },
    content: '{}',
  });
  ledger.append({
    tool: 'code.read',
    callId: 'c2',
    file: 'AlembicAgent/src/index.ts',
    content: 'export {};',
  });
  return { projectRoot, ledger };
}

describe('sanitizeSubmissionEvidence（E7）', () => {
  test('漏仓库前缀的手写路径按 basename 唯一匹配自动矫正（含行号后缀保留）', () => {
    const { projectRoot, ledger } = makeWorkspace();
    const result = sanitizeSubmissionEvidence(
      {
        kind: 'fact',
        sourceRefs: ['config/agent-public-api-boundary.json:1-1'],
        reasoning: { sources: ['config/agent-public-api-boundary.json:1-1'] },
      },
      { ledger, projectRoot }
    );
    const reasoning = result.item.reasoning as { sources: string[] };
    expect(reasoning.sources).toEqual(['AlembicAgent/config/agent-public-api-boundary.json:1-1']);
    expect(result.item.sourceRefs).toEqual([
      'AlembicAgent/config/agent-public-api-boundary.json:1-1',
    ]);
    expect(result.corrected).toHaveLength(2);
  });

  test('无法唯一匹配的坏引用：有其它可解析引用时丢弃，否则整列表保留交门禁', () => {
    const { projectRoot, ledger } = makeWorkspace();
    const withGood = sanitizeSubmissionEvidence(
      {
        kind: 'fact',
        sourceRefs: [],
        reasoning: {
          sources: ['AlembicAgent/src/index.ts:1', 'Never/Existed/agent.ts:1-7'],
        },
      },
      { ledger, projectRoot }
    );
    expect((withGood.item.reasoning as { sources: string[] }).sources).toEqual([
      'AlembicAgent/src/index.ts:1',
    ]);
    expect(withGood.dropped).toEqual(['Never/Existed/agent.ts:1-7']);

    const allBad = sanitizeSubmissionEvidence(
      {
        kind: 'fact',
        sourceRefs: [],
        reasoning: { sources: ['Never/Existed/zzz.ts:1'] },
      },
      { ledger, projectRoot }
    );
    expect((allBad.item.reasoning as { sources: string[] }).sources).toEqual([
      'Never/Existed/zzz.ts:1',
    ]);
  });

  test('证据驱动 scope 收窄：rule 证据 <3 文件自动 narrow；已声明/fact/≥3 不动', () => {
    const { projectRoot, ledger } = makeWorkspace();
    const narrowed = sanitizeSubmissionEvidence(
      {
        kind: 'rule',
        sourceRefs: [],
        reasoning: { sources: ['AlembicAgent/src/index.ts:1'] },
      },
      { ledger, projectRoot }
    );
    expect(narrowed.scopedNarrow).toBe(true);
    expect(narrowed.item.scope).toBe('narrow');

    const declared = sanitizeSubmissionEvidence(
      {
        kind: 'rule',
        scope: 'file-local',
        sourceRefs: [],
        reasoning: { sources: ['AlembicAgent/src/index.ts:1'] },
      },
      { ledger, projectRoot }
    );
    expect(declared.scopedNarrow).toBe(false);
    expect(declared.item.scope).toBe('file-local');

    const fact = sanitizeSubmissionEvidence(
      { kind: 'fact', sourceRefs: [], reasoning: { sources: ['AlembicAgent/src/index.ts:1'] } },
      { ledger, projectRoot }
    );
    expect(fact.scopedNarrow).toBe(false);
  });

  test('无台账：零行为直通', () => {
    const item = { kind: 'rule', reasoning: { sources: ['x.ts:1'] } };
    const result = sanitizeSubmissionEvidence(item, { ledger: null, projectRoot: '/tmp' });
    expect(result.item).toBe(item);
    expect(result.corrected).toEqual([]);
  });
});

describe('repairStyleViolations（E7-R 修复子调用）', () => {
  const allowlist = { positive: ['使用', '统一'], negative: ['避免'] };
  const item = {
    title: 'T',
    doClause: '所有类型导入必须 import type',
    content: { markdown: '正文', rationale: 'r' },
  };

  test('provider 返回窄 JSON→仅合并给定字段', async () => {
    const { repairStyleViolations } = await import(
      '../src/tools/runtime/handlers/submitEvidenceExpansion.js'
    );
    const provider = {
      chat: async () => '前置说明 {"doClause":"使用 import type 隔离类型导入"} 后缀',
    };
    const repaired = await repairStyleViolations(
      item,
      [{ code: 'DO_CLAUSE_NON_IMPERATIVE' }],
      provider,
      allowlist
    );
    expect(repaired?.doClause).toBe('使用 import type 隔离类型导入');
    expect(repaired?.title).toBe('T');
    expect((repaired?.content as { rationale: string }).rationale).toBe('r');
  });

  test('provider 缺席/返回垃圾/抛错→null（零影响原拒绝路径）', async () => {
    const { repairStyleViolations } = await import(
      '../src/tools/runtime/handlers/submitEvidenceExpansion.js'
    );
    expect(
      await repairStyleViolations(item, [{ code: 'DO_CLAUSE_NON_IMPERATIVE' }], null, allowlist)
    ).toBeNull();
    expect(
      await repairStyleViolations(
        item,
        [{ code: 'DO_CLAUSE_NON_IMPERATIVE' }],
        { chat: async () => 'no json here' },
        allowlist
      )
    ).toBeNull();
    expect(
      await repairStyleViolations(
        item,
        [{ code: 'DO_CLAUSE_NON_IMPERATIVE' }],
        {
          chat: async () => {
            throw new Error('boom');
          },
        },
        allowlist
      )
    ).toBeNull();
  });

  test('isStyleRepairable：纯风格类 true，混证据类 false', async () => {
    const { isStyleRepairable } = await import(
      '../src/tools/runtime/handlers/submitEvidenceExpansion.js'
    );
    expect(
      isStyleRepairable([
        { code: 'DO_CLAUSE_NON_IMPERATIVE' },
        { code: 'CONTENT_CONTRAST_MISSING' },
      ])
    ).toBe(true);
    expect(
      isStyleRepairable([{ code: 'DO_CLAUSE_NON_IMPERATIVE' }, { code: 'SOURCE_REF_NOT_FOUND' }])
    ).toBe(false);
    expect(isStyleRepairable([])).toBe(false);
  });
});

describe('buildViolationRepairTemplates（E7）', () => {
  test('风格/措辞类违规给出照抄即过模板；无命中返回空串', () => {
    const allowlist = { positive: ['使用', '统一', '禁止'], negative: ['避免', '不要'] };
    const text = buildViolationRepairTemplates(
      [
        { code: 'DO_CLAUSE_NON_IMPERATIVE' },
        { code: 'CONTENT_CONTRAST_MISSING' },
        { code: 'GRAPH_REF_INVALID' },
      ],
      allowlist
    );
    expect(text).toContain('修复模板[doClause]');
    expect(text).toContain('使用/统一/禁止');
    expect(text).toContain('✅ 正确');
    expect(text).toContain('调用链');
    expect(buildViolationRepairTemplates([{ code: 'SNIPPET_MISMATCH' }], allowlist)).toBe('');
  });
});
