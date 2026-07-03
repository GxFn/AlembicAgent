/**
 * P4/C9+C10 — in-process 深度接地 retry + note_finding 深度槽序列化。
 *
 * 锁死两条关键口径：
 *  1) C9 深度-retry 只压在「尝试了深度却接地不足」的分析上；没尝试深度的旧式分析绝不被 retry(防回归)。
 *     接地 = 引用了 analyst 真读过的文件(referencedFiles)——与 host 侧 resolver 解析成功同义。
 *  2) C9 的 retry 提示是「回 Analyst 段重挖」，绝不提示补写具体内容(防诱导编造)。
 *  3) C10 note_finding 把深度槽序列化成 `## <label>` markdown 分节(即 reviewRecipeDepth 输入格式)。
 */
import { describe, expect, it } from 'vitest';

import { applyDepthRetryGate } from '../src/agent/evaluation/qualityGates.js';
import { buildRetryPrompt } from '../src/agent/prompts/insightGate.js';
import { handle as handleMemory } from '../src/tools/runtime/handlers/memory.js';

const PASS = { pass: true } as const;

// 一条挂在真实文件上的深度分节文本。
function depthMarkdown(dims: Array<[string, string]>): string {
  return dims.map(([label, ref]) => `## ${label}\n见 ${ref}。`).join('\n');
}

describe('applyDepthRetryGate (C9) — 深度接地 retry 口径', () => {
  it('非候选生成 → 原样放行(不介入纯分析)', () => {
    const gate = applyDepthRetryGate(
      PASS,
      { analysisText: '', findings: [], referencedFiles: [] },
      false
    );
    expect(gate).toEqual(PASS);
  });

  it('基础门未过 → 原样放行(不在失败分析上叠加)', () => {
    const base = { pass: false, action: 'analysis_retry' as const, reason: 'too short' };
    const gate = applyDepthRetryGate(
      base,
      { analysisText: '', findings: [], referencedFiles: [] },
      true
    );
    expect(gate).toEqual(base);
  });

  it('没尝试深度(无深度分节) → 放行，不制造回归', () => {
    const gate = applyDepthRetryGate(
      PASS,
      {
        analysisText: '普通分析，无深度分节。见 src/a.ts:1。',
        findings: [],
        referencedFiles: ['src/a.ts'],
      },
      true
    );
    expect(gate.pass).toBe(true);
  });

  it('尝试了深度但接地不足(<2 维) → analysis_retry，reason 带缺口维度', () => {
    // 只有「设计意图」挂在真读过的文件上；其余维度缺失。
    const artifact = {
      analysisText: depthMarkdown([['设计意图', 'src/a.ts:5']]),
      findings: [],
      referencedFiles: ['src/a.ts'],
    };
    const gate = applyDepthRetryGate(PASS, artifact, true);
    expect(gate.pass).toBe(false);
    expect(gate.action).toBe('analysis_retry');
    expect(gate.reason).toContain('Depth dimensions lack grounded evidence');
  });

  it('防编造：深度分节塞了引用但文件没被真读过 → 不算接地 → retry', () => {
    const artifact = {
      analysisText: depthMarkdown([
        ['设计意图', 'src/ghost.ts:5'],
        ['边界与前置条件', 'src/ghost.ts:9'],
      ]),
      findings: [],
      referencedFiles: [], // 没读过任何文件 → 引用无法接地
    };
    const gate = applyDepthRetryGate(PASS, artifact, true);
    expect(gate.pass).toBe(false);
    expect(gate.action).toBe('analysis_retry');
  });

  it('接地 ≥2 个深度维度 → 放行', () => {
    const artifact = {
      analysisText: depthMarkdown([
        ['设计意图', 'src/a.ts:5'],
        ['边界与前置条件', 'src/b.ts:3'],
      ]),
      findings: [],
      referencedFiles: ['src/a.ts', 'src/b.ts'],
    };
    const gate = applyDepthRetryGate(PASS, artifact, true);
    expect(gate.pass).toBe(true);
  });
});

describe('buildRetryPrompt (C9) — 深度缺口分支只叫「回代码重挖」，不诱导编造', () => {
  it('深度缺口 reason → 回 Analyst 段重挖，明确禁止凭空补写', () => {
    const prompt = buildRetryPrompt('Depth dimensions lack grounded evidence: 失败模式 / 权衡');
    expect(prompt).toContain('失败模式 / 权衡');
    expect(prompt).toContain('不要凭空补写');
    expect(prompt).toContain('note_finding');
    expect(prompt).toContain('file:line');
  });
});

describe('note_finding 深度槽序列化 (C10)', () => {
  it('填了深度槽 → 序列化成 `## <label>` 分节并入 evidence(即 reviewRecipeDepth 输入格式)', async () => {
    let capturedEvidence = '';
    const ctx = {
      memoryCoordinator: {
        noteFinding: (_finding: string, evidence: string) => {
          capturedEvidence = evidence;
          return { recorded: true, target: 'activeContext', importance: 8, scratchpadSize: 1 };
        },
      },
      runtime: {},
    } as unknown as Parameters<typeof handleMemory>[2];

    await handleMemory(
      'note_finding',
      {
        finding: 'UserService 用 @Injectable',
        evidence: 'src/services/UserService.ts:5',
        importance: 8,
        designIntent: '显式标注而非扫描，见 src/services/UserService.ts:5。',
        failureModes: '缺失即启动期抛错，见 src/services/UserService.ts:5。',
      },
      ctx
    );

    expect(capturedEvidence).toContain('src/services/UserService.ts:5');
    expect(capturedEvidence).toContain('## 设计意图');
    expect(capturedEvidence).toContain('## 失败模式');
  });
});
