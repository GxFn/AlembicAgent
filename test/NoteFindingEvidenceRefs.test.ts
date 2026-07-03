/**
 * note_finding evidenceRefs 硬切测试（Wave A E3）——E0 表征钉 1 的反转。
 * 覆盖：捏造引用拒收+近期真实候选提示、有效引用由台账机械展开为标签（模型不再手写 file:line）、
 * 旧 evidence 自由文本迁移拒绝、无台账场景降级直存（显式 unverified 标注）、
 * refs 流转 scratchpad→distill 投影。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import { ActiveContext } from '../src/agent/memory/ActiveContext.js';
import { handle as handleMemory } from '../src/tools/runtime/handlers/memory.js';

type MemoryHandlerCtx = Parameters<typeof handleMemory>[2];

function makeLedger() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-refs-'));
  return new EvidenceLedgerStore({
    dataRoot,
    jobId: 'job_1',
    sessionId: 'sess_1',
    dimensionId: 'ts-js-module',
  });
}

interface RecordedNote {
  finding: string;
  evidence: string;
  importance: number;
  round: number;
  scopeId?: string;
  evidenceRefs?: string[];
}

function makeCtx(ledger: EvidenceLedgerStore | null) {
  const recorded: RecordedNote[] = [];
  const coordinator = {
    noteFinding(
      finding: string,
      evidence: string,
      importance: number,
      round: number,
      scopeId?: string,
      evidenceRefs?: string[]
    ) {
      recorded.push({ finding, evidence, importance, round, scopeId, evidenceRefs });
      return {
        recorded: true,
        target: 'activeContext' as const,
        importance,
        message: `📌 已记录发现 [${importance}/10]`,
        scratchpadSize: recorded.length,
      };
    },
  };
  // handler 仅消费 memoryCoordinator 与 runtime.evidenceLedger/dimensionScopeId——最小运行时形态经 unknown 收窄
  const ctx = {
    memoryCoordinator: coordinator,
    runtime: {
      evidenceLedger: ledger,
      dimensionScopeId: 'ts-js-module:analyst',
    },
  } as unknown as MemoryHandlerCtx;
  return { ctx, recorded };
}

describe('note_finding evidenceRefs 硬切（E3，E0 钉 1 反转）', () => {
  test('有效引用：台账机械展开为标签，refs 透传 coordinator', async () => {
    const ledger = makeLedger();
    ledger.append({
      tool: 'code.read',
      callId: 'c1',
      file: 'lib/a.ts',
      range: { start: 5, end: 7 },
      content: 'L5\nL6\nL7',
    });
    const { ctx, recorded } = makeCtx(ledger);
    const result = await handleMemory(
      'note_finding',
      {
        finding: '类型导入使用 import type 严格隔离',
        evidenceRefs: ['E-1', 'E-1@6-6'],
        excerpt: 'L6',
        importance: 8,
      },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].evidence).toBe('E-1=lib/a.ts:5-7; E-1=lib/a.ts:6-6 — L6');
    expect(recorded[0].evidenceRefs).toEqual(['E-1', 'E-1@6-6']);
    expect(recorded[0].scopeId).toBe('ts-js-module:analyst');
  });

  test('捏造引用（file:line 形态）整条拒收，附近期真实候选', async () => {
    const ledger = makeLedger();
    ledger.append({ tool: 'code.read', callId: 'c1', file: 'lib/real.ts', content: 'x' });
    const { ctx, recorded } = makeCtx(ledger);
    const result = await handleMemory(
      'note_finding',
      {
        finding: '捏造样本',
        evidenceRefs: ['Alembic/lib/types/agent.ts:1-7'],
      },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('无法解析');
    expect(String(result.error)).toContain('E-1=lib/real.ts');
    expect(recorded).toHaveLength(0);
  });

  test('旧 evidence 自由文本参数：迁移拒绝并提示已退役', async () => {
    const { ctx, recorded } = makeCtx(makeLedger());
    const result = await handleMemory(
      'note_finding',
      { finding: '旧形态', evidence: 'src/App.tsx:42', importance: 7 },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('evidenceRefs');
    expect(String(result.error)).toContain('已退役');
    expect(recorded).toHaveLength(0);
  });

  test('无台账场景（非维度 run）：降级直存并显式标注 unverified', async () => {
    const { ctx, recorded } = makeCtx(null);
    const result = await handleMemory(
      'note_finding',
      { finding: '降级场景', evidenceRefs: ['E-3'] },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(recorded[0].evidence).toContain('E-3');
    expect(recorded[0].evidence).toContain('unverified: no evidence ledger');
  });

  test('refs 流转：scratchpad 条目与 distill 投影携带 evidenceRefs（防御性拷贝）', () => {
    const ac = new ActiveContext();
    const refs = ['E-9'];
    ac.noteKeyFinding('发现', 'E-9=lib/z.ts', 8, 1, refs);
    refs.push('E-10'); // 外部数组后续变更不得污染已存条目
    const distilled = ac.distill();
    expect(distilled.keyFindings[0].evidenceRefs).toEqual(['E-9']);
    expect(distilled.keyFindings[0].evidence).toBe('E-9=lib/z.ts');
  });
});
