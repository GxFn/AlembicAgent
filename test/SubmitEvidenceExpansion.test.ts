/**
 * 提交侧证据展开与新鲜度终检测试（Wave A E5）。
 * 覆盖：checkFreshness（fresh/变更 stale/文件变短 stale/无区间 unknown）、
 * expandEvidenceRefsForSubmit（无 refs 直通、无台账拒、无效引用附候选、机械展开合并去重、
 * coreCode 仅空时回填、文件变更 EVIDENCE_STALE）、INSUFFICIENT_EVIDENCE 候选提示、
 * producer 提示词含 evidenceRefs 指引。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import {
  buildEvidenceCandidatesHint,
  expandEvidenceRefsForSubmit,
} from '../src/tools/runtime/handlers/submitEvidenceExpansion.js';
import { GenerateProduce } from '../src/tools/runtime/toolsets/GenerateProduce.js';

/** 建一个真实临时项目：源文件 + 与其行区间严格一致的台账条目 */
function makeProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'expansion-proj-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'expansion-data-'));
  fs.mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
  const fileLines = ['L1', 'L2', 'const x = 1;', 'const y = 2;', 'L5'];
  fs.writeFileSync(path.join(projectRoot, 'lib/a.ts'), fileLines.join('\n'), 'utf8');
  const ledger = new EvidenceLedgerStore({
    dataRoot,
    jobId: 'job_1',
    sessionId: 'sess_1',
    dimensionId: 'ts-js-module',
  });
  ledger.append({
    tool: 'code.read',
    callId: 'c1',
    file: 'lib/a.ts',
    range: { start: 3, end: 4 },
    content: 'const x = 1;\nconst y = 2;',
  });
  return { projectRoot, ledger };
}

describe('checkFreshness（同区间/同截断/同脱敏一把尺）', () => {
  test('未变更 fresh；内容变更 stale；文件变短 stale；无区间条目 unknown', () => {
    const { projectRoot, ledger } = makeProject();
    const current = fs.readFileSync(path.join(projectRoot, 'lib/a.ts'), 'utf8');
    expect(ledger.checkFreshness('E-1', current)).toBe('fresh');

    const changed = current.replace('const x = 1;', 'const x = 999;');
    expect(ledger.checkFreshness('E-1', changed)).toBe('stale');

    expect(ledger.checkFreshness('E-1', 'only-one-line')).toBe('stale'); // 区间越界

    ledger.append({ tool: 'terminal.exec', callId: 'c2', content: 'out' });
    expect(ledger.checkFreshness('E-2', 'anything')).toBe('unknown');
    expect(ledger.checkFreshness('not-a-ref', current)).toBe('unknown');
  });
});

describe('expandEvidenceRefsForSubmit（E5 机械展开）', () => {
  const baseItem = {
    title: 'T',
    coreCode: '',
    sourceRefs: ['lib/manual.ts:1-2'],
    reasoning: { sources: ['lib/manual.ts:1-2'], evidenceRefs: ['E-1'] },
  };

  test('无 refs：路径完全直通（additive 契约）', () => {
    const { projectRoot, ledger } = makeProject();
    const item = { title: 'T', reasoning: { sources: ['a.ts:1'] } };
    const result = expandEvidenceRefsForSubmit(item, { ledger, projectRoot });
    expect(result).toEqual({ ok: true, item, expandedSources: [] });
  });

  test('无台账：显式拒绝提示改填 sources', () => {
    const { projectRoot } = makeProject();
    const result = expandEvidenceRefsForSubmit(baseItem, { ledger: null, projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('证据台账');
    }
  });

  test('无效引用：拒绝并附近期真实候选', () => {
    const { projectRoot, ledger } = makeProject();
    const item = { ...baseItem, reasoning: { evidenceRefs: ['E-99'] } };
    const result = expandEvidenceRefsForSubmit(item, { ledger, projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('无法解析');
      expect(result.error).toContain('E-1=lib/a.ts');
    }
  });

  test('新鲜引用：sources/sourceRefs 程序化合并去重，coreCode 仅空时回填台账 verbatim', () => {
    const { projectRoot, ledger } = makeProject();
    const result = expandEvidenceRefsForSubmit(baseItem, { ledger, projectRoot });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const reasoning = result.item.reasoning as { sources: string[] };
      expect(reasoning.sources).toEqual(['lib/manual.ts:1-2', 'lib/a.ts:3-4']);
      expect(result.item.sourceRefs).toEqual(['lib/manual.ts:1-2', 'lib/a.ts:3-4']);
      expect(result.item.coreCode).toBe('const x = 1;\nconst y = 2;'); // 台账 verbatim 回填
      expect(result.expandedSources).toEqual(['lib/a.ts:3-4']);
    }

    // coreCode 非空时不覆盖（形式不一致由既有 F4c 管线消化）
    const withCode = { ...baseItem, coreCode: 'model-written' };
    const kept = expandEvidenceRefsForSubmit(withCode, { ledger, projectRoot });
    expect(kept.ok && kept.item.coreCode).toBe('model-written');
  });

  test('run 中途文件变更：EVIDENCE_STALE 拒并提示重采', () => {
    const { projectRoot, ledger } = makeProject();
    fs.writeFileSync(
      path.join(projectRoot, 'lib/a.ts'),
      'totally\nnew\ncontent\nnow\nhere',
      'utf8'
    );
    const result = expandEvidenceRefsForSubmit(baseItem, { ledger, projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('EVIDENCE_STALE');
      expect(result.error).toContain('重采');
    }
  });

  test('文件被删除：同判 EVIDENCE_STALE', () => {
    const { projectRoot, ledger } = makeProject();
    fs.rmSync(path.join(projectRoot, 'lib/a.ts'));
    const result = expandEvidenceRefsForSubmit(baseItem, { ledger, projectRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('EVIDENCE_STALE');
    }
  });
});

describe('拒绝反馈增强与提示词（E5）', () => {
  test('INSUFFICIENT_EVIDENCE 候选提示：列台账 distinct 文件（≤5）', () => {
    const { ledger } = makeProject();
    ledger.append({ tool: 'code.read', callId: 'c2', file: 'lib/b.ts', content: 'b' });
    const hint = buildEvidenceCandidatesHint(ledger);
    expect(hint).toContain('lib/a.ts');
    expect(hint).toContain('lib/b.ts');
    expect(hint).toContain('reasoning.evidenceRefs');
    expect(buildEvidenceCandidatesHint(null)).toBe('');
  });

  test('producer 提示词含 evidenceRefs 指引与 evidence.get 自救说明', () => {
    const fragment = new GenerateProduce().promptFragment;
    expect(fragment).toContain('reasoning.evidenceRefs');
    expect(fragment).toContain('evidence.get');
  });
});
