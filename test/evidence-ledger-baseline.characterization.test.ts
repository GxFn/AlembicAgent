/**
 * E0 基线表征 — 证据台账（Evidence Ledger）改造前的现状钉（Wave A）。
 *
 * 设计文档：../Design/docs/current/alembic-coldstart-evidence-ledger-redesign-2026-07-04.md §15.E0
 * 钉住 2026-07-04 真机低产事故（job bootstrap_mr5ckv5p_211536ea）暴露的机制现状：
 *   1) note_finding 对 evidence 字符串零校验 —— 捏造引用录入即成功（E3 落地后此钉反转为拒收）；
 *   2) produce 工具面无任何 code/evidence 读取能力 —— 候选被拒后无自救通道（E4 后扩 evidence.get/search）；
 *   3) RECORD 配额公式 = max(3, ceil(evidenceToolCallCount/2)) —— 与真实证据支撑量脱钩（E4 改绑台账）；
 *   4) analyst 五相序列 —— VERIFY 相已存在但无台账审计契约（Wave C 强化）；
 *   5) 真机 baseline 数据冻结 —— E6 与 U-2 的唯一对照基准。
 * 断言全部落在可导出 seam（ActiveContext / GenerateProduce / ExplorationStrategies），不触内部私有实现。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  STRATEGY_ANALYST,
  targetMemoryFindingCount,
} from '../src/agent/context/exploration/ExplorationStrategies.js';
import { ActiveContext } from '../src/agent/memory/ActiveContext.js';
import { GenerateProduce } from '../src/tools/runtime/toolsets/GenerateProduce.js';

const baseline = JSON.parse(
  readFileSync(new URL('./fixtures/coldstart-baseline-2026-07-04.json', import.meta.url), 'utf8')
) as {
  tsJsModule: { submitted: number; accepted: number };
  architecture: { submitted: number; accepted: number };
  cacheHitRatio: number;
};

describe('E0 冷启动证据保真基线表征', () => {
  test('1) ActiveContext 存储层保持宽容（引用校验已上移 memory handler——E3 反转见 NoteFindingEvidenceRefs 测试）', () => {
    const ctx = new ActiveContext();
    // E3 后契约：拒收捏造引用发生在 handleNoteFinding（录入校验+近期候选提示）；
    // 存储层是内部信任层，保持宽容（handler 校验通过后写入的是台账机械展开的标签）。
    ctx.noteKeyFinding('类型导入使用 import type 严格隔离', 'E-1=lib/types/agent.d.ts:1-7', 8);
    expect(ctx.scratchpadSize).toBe(1);
  });

  test('2) produce 工具面已含 evidence 只读自救通道（E4 反转：被拒后可取 verbatim 修正引用）', () => {
    const tools = new GenerateProduce().allowedTools;
    expect(Object.keys(tools).sort()).toEqual(['evidence', 'knowledge', 'memory', 'meta']);
    expect(tools.knowledge).toEqual(['submit']);
    expect(tools.evidence).toEqual(['get', 'search']);
  });

  test('3) RECORD 配额公式与真实证据支撑量脱钩', () => {
    // 真机事故参数：37 次证据工具调用 → 配额逼 19 条发现（扎实验证的只有 ~10 条）
    expect(targetMemoryFindingCount({ evidenceToolCallCount: 37 })).toBe(19);
    expect(targetMemoryFindingCount({ evidenceToolCallCount: 0 })).toBe(3);
  });

  test('4) analyst 五相序列（VERIFY 相存在，现状无台账审计契约）', () => {
    expect(STRATEGY_ANALYST.phases).toEqual(['SCAN', 'EXPLORE', 'VERIFY', 'RECORD', 'SUMMARIZE']);
  });

  test('5) 真机 baseline fixture 冻结（E6/U-2 对照基准）', () => {
    expect(baseline.tsJsModule).toEqual({ submitted: 15, accepted: 1 });
    expect(baseline.architecture).toEqual({ submitted: 8, accepted: 2 });
    expect(baseline.cacheHitRatio).toBeCloseTo(0.64, 2);
  });
});
