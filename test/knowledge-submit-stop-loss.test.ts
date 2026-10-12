/**
 * I39（L4-P25）：knowledge.submit 拒绝止损与修复层计量统一。
 *
 * 止损（F3）此前只在最终门禁拒绝分支累加 gateRejectStreak/Total：expansion 失败与
 * EVIDENCE_REFS_REQUIRED 直接 return，换标题即可绕过同标题硬止损，模型可一直重试到
 * stage_timeout。这里锁定统一后的口径：
 *   - expansion 失败、EVIDENCE_REFS_REQUIRED、最终门禁：计入 streak 与 total，附 3/12 两档 STOP；
 *   - 同标题硬止损与必填项拒绝（validateSubmitParams 前检）：只计入 total、不计 streak；
 *   - 门禁通过照旧把 streak 归零。
 * 计量：F4f 裸路径规范化必须计入 submitRepairStats.bare_refs_normalized，计数键单源登记。
 *
 * 所有调用都按生产形态构造：每次工具调用一个新的 runtime 投影 + sharedState 浅拷贝，
 * 只有 _sessionCounters 嵌套盒跨调用共享（PipelineStrategy.execute 入口预建）。
 */
import fs from 'node:fs';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import { describe, expect, test, vi } from 'vitest';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import * as sessionState from '../src/tools/runtime/handlers/knowledge/sessionState.js';
import { normalizeBareSourceRefs } from '../src/tools/runtime/handlers/knowledge/sources.js';
import { handle as handleKnowledge } from '../src/tools/runtime/handlers/knowledge.js';
import { createTempProject } from './helpers/tempProject.js';

const STREAK_STOP = '已连续多次被拒';
const BUDGET_STOP = '预算上限';

function makeFixture(options: { ledger?: boolean; sharedExtras?: Record<string, unknown> } = {}) {
  const projectRoot = createTempProject('submit-stop-loss-');
  const dataRoot = createTempProject('submit-stop-loss-data-');
  fs.mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'lib/a.ts'),
    "import type { X } from './x.js';\nexport const a = 1;\nexport const b = 2;",
    'utf8'
  );
  const ledger =
    options.ledger === false
      ? undefined
      : new EvidenceLedgerStore({
          dataRoot,
          jobId: 'job_stop_loss',
          sessionId: 'sess_stop_loss',
          dimensionId: 'ts-js-module',
        });
  ledger?.append({
    tool: 'code.read',
    callId: 'c1',
    file: 'lib/a.ts',
    range: { start: 1, end: 3 },
    content: "import type { X } from './x.js';\nexport const a = 1;\nexport const b = 2;",
  });
  const counters: Record<string, unknown> = {};
  // 宿主侧的基础 sharedState：盒先于任何阶段拷贝预建，与 PipelineStrategy.execute 一致。
  const baseShared: Record<string, unknown> = {
    _sessionCounters: counters,
    ...options.sharedExtras,
  };
  const created: Record<string, unknown>[] = [];
  const gateway = {
    createOrStage: async (req: { items: Record<string, unknown>[] }) => {
      created.push(req.items[0]);
      return {
        created: [
          {
            id: `id-${created.length}`,
            title: String(req.items[0].title),
            lifecycle: 'pending',
            raw: req.items[0],
          },
        ],
        duplicates: [],
        rejected: [],
        merged: [],
        blocked: [],
        supersedeProposal: null,
        production: { capability: 'knowledge-submit', source: 'alembic-agent' },
      };
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
  const submit = async (params: Record<string, unknown>) => {
    // 每次调用：新的 runtime 投影 + sharedState 浅拷贝（阶段拷贝形态），盒引用保持不变。
    const runtime: Record<string, unknown> = { sharedState: { ...baseShared } };
    if (ledger) {
      runtime.evidenceLedger = ledger;
    }
    const result = (await handleKnowledge('submit', params, {
      recipeGateway: gateway,
      projectRoot,
      runtime,
      sessionStore: null,
    } as never)) as { ok: boolean; error?: unknown };
    return { ok: result.ok, error: String(result.error ?? '') };
  };
  return { projectRoot, counters, created, submit };
}

function validParams(title: string, reasoning?: Record<string, unknown>) {
  return {
    title,
    description: '模块使用 import type 声明类型级导入，编译后擦除。',
    content: {
      markdown:
        "## 类型导入隔离\n\n模块统一使用 import type 声明类型级导入，TypeScript 编译后完全擦除，不产生任何运行时引用。这样做保证了类型安全与打包体积解耦，消费方不会因为引用类型而意外引入运行时依赖，打包器也能对纯类型模块做彻底的摇树优化。项目中所有仅消费类型的模块都遵循这一约定，形成一致的导入风格与可审计的依赖关系。\n\n```typescript\nimport type { X } from './x.js';\n```\n(来源: lib/a.ts:1-3)\n\n适用于所有仅类型消费场景；运行时需要值时改用普通 import 并显式声明依赖。违反该约定会让类型依赖悄悄变成运行时依赖，增大产物体积并引入不必要的模块加载开销。",
      rationale:
        '类型与运行时依赖解耦：import type 编译期完全擦除保证零运行时引用，打包体积可控，且消费方的依赖关系清晰可审计、便于长期维护。',
    },
    kind: 'fact',
    trigger: 'typescript type import',
    whenClause: '当模块只消费类型不消费运行时值时',
    doClause: '所有类型级导入都应该用 import type 声明',
    dontClause: '不要在仅类型消费场景用普通 import 引入类型',
    reasoning: reasoning ?? {
      whyStandard: '类型导入不产生运行时引用。',
      sources: ['lib/a.ts:1-3'],
      confidence: 0.9,
      evidenceRefs: ['E-1'],
    },
  };
}

/** 台账在场、refs 缺席、手写 sources 不在台账 → EVIDENCE_REFS_REQUIRED。 */
function refsRequiredParams(title: string) {
  return validParams(title, {
    whyStandard: 'w',
    sources: ['lib/zzz-not-captured.ts:1-3'],
    confidence: 0.9,
  });
}

/** evidenceRefs 引用不存在的台账条目 → expansion 失败（无法解析）。 */
function unresolvableRefParams(title: string) {
  return validParams(title, {
    whyStandard: 'w',
    sources: ['lib/a.ts:1-3'],
    confidence: 0.9,
    evidenceRefs: ['E-99'],
  });
}

/** 缺 trigger → validateSubmitParams 前检的必填项拒绝。 */
function missingTriggerParams(title: string) {
  const params: Record<string, unknown> = { ...validParams(title) };
  delete params.trigger;
  return params;
}

describe('knowledge.submit 拒绝止损覆盖全部模型可修的拒绝分支（I39）', () => {
  test('连续 3 次 EVIDENCE_REFS_REQUIRED（每次换标题）后第 3 条附 STOP，streak/total 累加', async () => {
    const { counters, submit } = makeFixture();
    const errors: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await submit(refsRequiredParams(`换标题候选 ${index}`));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('EVIDENCE_REFS_REQUIRED');
      errors.push(result.error);
    }
    expect(errors[0]).not.toContain('STOP');
    expect(errors[1]).not.toContain('STOP');
    expect(errors[2]).toContain('🛑 STOP');
    expect(errors[2]).toContain(STREAK_STOP);
    expect(counters.gateRejectStreak).toBe(3);
    expect(counters.gateRejectTotal).toBe(3);
  });

  test('expansion 失败（evidenceRefs 无法解析）同样计入 streak/total 并在第 3 次附 STOP', async () => {
    const { counters, submit } = makeFixture();
    const logger = Logger.getInstance();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      const errors: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const result = await submit(unresolvableRefParams(`无效引用候选 ${index}`));
        expect(result.ok).toBe(false);
        expect(result.error).toContain('无法解析');
        errors.push(result.error);
      }
      expect(errors[1]).not.toContain('STOP');
      expect(errors[2]).toContain(STREAK_STOP);
      expect(counters.gateRejectStreak).toBe(3);
      expect(counters.gateRejectTotal).toBe(3);
      // 止损生效必须可观测：日志带拒绝种类、streak 与 total。
      expect(
        warn.mock.calls.some(([message]) => {
          const text = String(message);
          return (
            text.includes('reject stop-loss engaged') &&
            text.includes('kind=evidence-expansion') &&
            text.includes('streak=3') &&
            text.includes('total=3')
          );
        })
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('第 12 次任意拒绝（此处为必填项前检拒绝）附会话预算上限指令', async () => {
    const { counters, submit } = makeFixture();
    const errors: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const params =
        index % 2 === 0
          ? refsRequiredParams(`预算候选 ${index}`)
          : unresolvableRefParams(`预算候选 ${index}`);
      const result = await submit(params);
      expect(result.ok).toBe(false);
      errors.push(result.error);
    }
    // 前 11 次都没触到总预算；streak ≥3 后给的是“换候选”档。
    expect(errors.some((error) => error.includes(BUDGET_STOP))).toBe(false);
    expect(errors[10]).toContain(STREAK_STOP);
    const twelfth = await submit(missingTriggerParams('预算候选 11'));
    expect(twelfth.ok).toBe(false);
    expect(twelfth.error).toContain('trigger is required');
    expect(twelfth.error).toContain('🛑 STOP');
    expect(twelfth.error).toContain(BUDGET_STOP);
    expect(counters.gateRejectTotal).toBe(12);
    // 必填项拒绝不计 streak：仍停在 11。
    expect(counters.gateRejectStreak).toBe(11);
  });

  test('同标题硬止损计入 total、不计 streak；total 到 12 时附预算上限指令', async () => {
    const title = '同标题硬止损候选';
    const { counters, submit } = makeFixture();
    counters._submitTitleAttempts = { [title]: 3 };
    counters.gateRejectStreak = 1;
    counters.gateRejectTotal = 4;
    const first = await submit(validParams(title));
    expect(first.ok).toBe(false);
    expect(first.error).toContain('已尝试 3 次');
    expect(first.error).not.toContain('STOP');
    expect(counters.gateRejectTotal).toBe(5);
    expect(counters.gateRejectStreak).toBe(1);

    counters.gateRejectTotal = 11;
    const twelfth = await submit(validParams(title));
    expect(twelfth.ok).toBe(false);
    expect(twelfth.error).toContain('已尝试 3 次');
    expect(twelfth.error).toContain(BUDGET_STOP);
    expect(counters.gateRejectTotal).toBe(12);
    expect(counters.gateRejectStreak).toBe(1);
  });

  test('必填项前检拒绝计入 total、不计 streak，也不附“换候选”档 STOP', async () => {
    const { counters, submit } = makeFixture();
    counters.gateRejectStreak = 2;
    counters.gateRejectTotal = 2;
    const result = await submit(missingTriggerParams('缺 trigger 候选'));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Validation failed: trigger is required');
    expect(result.error).not.toContain('STOP');
    expect(counters.gateRejectStreak).toBe(2);
    expect(counters.gateRejectTotal).toBe(3);
  });

  test('门禁通过把证据类拒绝累出的 streak 归零，total 保持累计', async () => {
    const { counters, created, submit } = makeFixture();
    for (let index = 0; index < 2; index += 1) {
      expect((await submit(refsRequiredParams(`归零前候选 ${index}`))).ok).toBe(false);
    }
    expect(counters.gateRejectStreak).toBe(2);
    const passed = await submit(validParams('类型导入使用 ImportType 严格隔离'));
    expect(passed.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(counters.gateRejectStreak).toBe(0);
    const after = await submit(refsRequiredParams('归零后候选'));
    expect(after.ok).toBe(false);
    expect(after.error).not.toContain('STOP');
    expect(counters.gateRejectStreak).toBe(1);
    expect(counters.gateRejectTotal).toBe(3);
  });

  test('无 sharedState 的直接调用：拒绝原样返回、不附 STOP，跳过计数留 debug 诊断', async () => {
    const { projectRoot } = makeFixture();
    const logger = Logger.getInstance();
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
    try {
      const result = (await handleKnowledge('submit', missingTriggerParams('无会话候选'), {
        recipeGateway: { createOrStage: async () => ({}) },
        projectRoot,
        runtime: {},
        sessionStore: null,
      } as never)) as { ok: boolean; error?: unknown };
      expect(result.ok).toBe(false);
      expect(String(result.error)).toBe('Validation failed: trigger is required');
      expect(
        debug.mock.calls.some(([message]) => {
          const text = String(message);
          return text.includes('reject stop-loss skipped') && text.includes('kind=required-fields');
        })
      ).toBe(true);
    } finally {
      debug.mockRestore();
    }
  });
});

describe('F4f 裸路径规范化计入修复层计量（I39）', () => {
  test('normalizeBareSourceRefs 返回 {item, changed}：改写时 changed=true，未改写时原样返回', () => {
    const ranges = { _analystGroundedRanges: { 'lib/a.ts': [{ start: 2, end: 3 }] } };
    const item = {
      title: 'bare',
      sourceRefs: ['lib/a.ts', 'lib/b.ts:1-2'],
      reasoning: { sources: ['lib/a.ts'] },
    };
    const normalized = normalizeBareSourceRefs(item, ranges);
    expect(normalized.changed).toBe(true);
    expect(normalized.item.sourceRefs).toEqual(['lib/a.ts:2-3', 'lib/b.ts:1-2']);
    expect((normalized.item.reasoning as { sources: string[] }).sources).toEqual(['lib/a.ts:2-3']);

    // 没有接地范围的裸路径不猜范围：保持原样且不计为修复。
    const noRangeItem = {
      ...item,
      sourceRefs: ['lib/c.ts'],
      reasoning: { sources: ['lib/c.ts'] },
    };
    const untouched = normalizeBareSourceRefs(noRangeItem, ranges);
    expect(untouched.changed).toBe(false);
    expect(untouched.item).toBe(noRangeItem);
    const noRanges = normalizeBareSourceRefs(item, null);
    expect(noRanges.changed).toBe(false);
    expect(noRanges.item).toBe(item);
  });

  test('handler 内裸路径被规范化后 submitRepairStats.bare_refs_normalized=1', async () => {
    const { counters, submit } = makeFixture({
      ledger: false,
      sharedExtras: { _analystGroundedRanges: { 'lib/a.ts': [{ start: 1, end: 3 }] } },
    });
    await submit(
      validParams('裸路径规范化候选', {
        whyStandard: '类型导入不产生运行时引用。',
        sources: ['lib/a.ts'],
        confidence: 0.9,
      })
    );
    const stats = counters.submitRepairStats as Record<string, number> | undefined;
    expect(stats?.bare_refs_normalized).toBe(1);
  });

  test('修复层计数键单源：src 中每个 bumpSubmitRepairStat 字面键都已登记，登记键都有写入点', () => {
    const keys = (sessionState as { SUBMIT_REPAIR_STAT_KEYS?: readonly string[] })
      .SUBMIT_REPAIR_STAT_KEYS;
    expect(Array.isArray(keys)).toBe(true);
    const registered = new Set(keys ?? []);
    const srcRoot = path.resolve(import.meta.dirname, '../src');
    const bumped = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const text = fs.readFileSync(full, 'utf8');
          for (const match of text.matchAll(/bumpSubmitRepairStat\([^,]+,\s*'([a-z_]+)'\)/g)) {
            bumped.add(match[1]);
          }
        }
      }
    };
    walk(srcRoot);
    expect(bumped.size).toBeGreaterThan(0);
    expect([...bumped].sort()).toEqual([...registered].sort());
    expect(registered.has('bare_refs_normalized')).toBe(true);
  });
});
