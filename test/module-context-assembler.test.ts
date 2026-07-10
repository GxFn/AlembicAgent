/**
 * P1-B-1/2/4(挖掘质量升级)：确定性模块上下文装配 + 模块预算 + 覆盖度门。
 * 全部纯函数直测；fan-out 接线由 module-mining-agent-run/mining-e2e 既有测试覆盖。
 */
import { describe, expect, it } from 'vitest';
import { applyModuleCoverageGate } from '../src/agent/evaluation/gateEvaluators.js';
import { computeModuleAnalystBudget } from '../src/agent/prompts/insightAnalyst.js';
import {
  buildModuleContextMap,
  splitOversizedModule,
} from '../src/agent/runs/module-mining/ModuleContextAssembler.js';
import { runModuleMining } from '../src/agent/runs/module-mining/ScopedModuleMiningAgentRun.js';
import type {
  AgentRuntimeBuildOptions,
  AgentRuntimeLike,
  CompiledAgentProfile,
} from '../src/agent/service/AgentRunContracts.js';
import { AgentService } from '../src/agent/service/AgentService.js';

describe('buildModuleContextMap — 静态图谱(P1-B-1)', () => {
  it('目录分组 + 兄弟模块 + read-before-cite 提示；facts 无 relations 时诚实缺席', () => {
    const map = buildModuleContextMap(
      {
        moduleId: 'core',
        ownedFiles: ['src/a.ts', 'src/b.ts', 'lib/util.ts', 'README.md'],
      },
      [
        { moduleId: 'core', ownedFiles: ['src/a.ts'] },
        { moduleId: 'ui', ownedFiles: ['ui/x.ts', 'ui/y.ts'] },
      ]
    );
    expect(map).toContain('- src/ (2 文件):');
    expect(map).toContain('  - src/a.ts');
    expect(map).toContain('- (root)/ (1 文件):');
    expect(map).toContain('兄弟模块: ui(2)');
    expect(map).toContain('read-before-cite');
    expect(map).not.toContain('依赖/关联模块');
  });

  it('facts 携带 dependencies 时列出(字符串与对象两形态)', () => {
    const map = buildModuleContextMap(
      {
        moduleId: 'core',
        ownedFiles: ['src/a.ts'],
        dependencies: ['shared', { target: 'infra' }],
      },
      []
    );
    expect(map).toContain('依赖/关联模块: shared, infra');
  });
});

describe('splitOversizedModule — 超大模块目录拆分(P1-B-2)', () => {
  it('≤阈值不拆(原对象直返)', () => {
    const module = { moduleId: 'm', ownedFiles: ['a/x.ts'] };
    expect(splitOversizedModule(module, 60)).toEqual([module]);
  });

  it('>阈值按顶层目录贪心装箱,id 加 #<group> 后缀,文件不丢不重', () => {
    const files = [
      ...Array.from({ length: 40 }, (_, i) => `alpha/f${i}.ts`),
      ...Array.from({ length: 30 }, (_, i) => `beta/f${i}.ts`),
      ...Array.from({ length: 10 }, (_, i) => `gamma/f${i}.ts`),
    ];
    const parts = splitOversizedModule(
      { moduleId: 'big', moduleName: 'Big', ownedFiles: files },
      60
    );
    expect(parts.length).toBeGreaterThan(1);
    const allFiles = parts.flatMap((part) => part.ownedFiles as string[]);
    expect(allFiles.sort()).toEqual([...files].sort());
    for (const part of parts) {
      expect((part.moduleId as string).startsWith('big#')).toBe(true);
      // 目录内聚：单目录不被拆散
      const groups = new Set((part.ownedFiles as string[]).map((f) => f.split('/')[0]));
      for (const group of groups) {
        const total = files.filter((f) => f.startsWith(`${group}/`)).length;
        const inPart = (part.ownedFiles as string[]).filter((f) =>
          f.startsWith(`${group}/`)
        ).length;
        expect(inPart).toBe(total);
      }
    }
  });
});

describe('computeModuleAnalystBudget — 模块档位(P1-B-2)', () => {
  it('分档 18/26/34/40 且 session 数学随迭代数缩放', () => {
    expect(computeModuleAnalystBudget(4).maxIterations).toBe(18);
    expect(computeModuleAnalystBudget(20).maxIterations).toBe(26);
    expect(computeModuleAnalystBudget(50).maxIterations).toBe(34);
    expect(computeModuleAnalystBudget(200).maxIterations).toBe(40);
    const small = computeModuleAnalystBudget(4);
    const large = computeModuleAnalystBudget(200);
    expect(small.maxSessionInputTokens).toBeLessThan(large.maxSessionInputTokens);
    expect(small.timeoutMs).toBeLessThan(large.timeoutMs);
  });
});

describe('applyModuleCoverageGate — provider 中立覆盖度门(P1-B-4,替代 graph-retry)', () => {
  const pass = { pass: true, action: 'pass', reason: '' };

  it('模块小(<8 文件)不触发', () => {
    const gate = applyModuleCoverageGate(
      pass,
      { referencedFiles: [] },
      {
        moduleContext: { ownedFiles: ['a.ts', 'b.ts'] },
      }
    );
    expect(gate.pass).toBe(true);
  });

  it('大模块接地不足 → analysis_retry 且点名未读文件', () => {
    const owned = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
    const gate = applyModuleCoverageGate(
      pass,
      { referencedFiles: ['src/f0.ts'] },
      { moduleContext: { ownedFiles: owned } }
    );
    expect(gate.pass).toBe(false);
    expect(gate.action).toBe('analysis_retry');
    expect(gate.reason).toContain('1/10');
    expect(gate.reason).toContain('src/f1.ts');
  });

  it('接地达标(≥3 owned,宽容路径匹配)放行;基础门未 pass 时不叠加', () => {
    const owned = Array.from({ length: 9 }, (_, i) => `src/f${i}.ts`);
    const gate = applyModuleCoverageGate(
      pass,
      { referencedFiles: ['repo/src/f0.ts', 'src/f1.ts', 'src/f2.ts'] },
      { moduleContext: { ownedFiles: owned } }
    );
    expect(gate.pass).toBe(true);
    const failed = { pass: false, action: 'record_repair', reason: 'no findings' };
    expect(applyModuleCoverageGate(failed, { referencedFiles: [] }, {})).toBe(failed);
  });
});

describe('run 入口接线 — 拆分/图谱/预算随 child 下发(P1-B-1/2)', () => {
  it('超大模块拆成多 child;每 child 元数据带 contextMap 与模块档 _computedBudget', async () => {
    const executions: Array<{
      metadata: Record<string, unknown>;
      options?: Record<string, unknown>;
    }> = [];
    const agentService = new AgentService({
      runtimeBuilder: {
        build(profile: CompiledAgentProfile, _o?: AgentRuntimeBuildOptions): AgentRuntimeLike {
          return {
            id: `rt:${profile.id}`,
            async execute(message, options) {
              executions.push({
                metadata: (message.metadata || {}) as Record<string, unknown>,
                options: options as Record<string, unknown>,
              });
              return {
                reply: 'ok',
                phases: {},
                tokenUsage: { input: 1, output: 1 },
                iterations: 1,
                durationMs: 1,
              };
            },
          };
        },
      },
    });

    const files = [
      ...Array.from({ length: 40 }, (_, i) => `alpha/f${i}.ts`),
      ...Array.from({ length: 30 }, (_, i) => `beta/f${i}.ts`),
    ];
    await runModuleMining({
      agentService,
      modules: [{ moduleId: 'big', moduleName: 'Big', ownedFiles: files }],
      projectFacts: { project: 'p' },
    });

    expect(executions.length).toBeGreaterThan(1);
    for (const execution of executions) {
      expect(String(execution.metadata.moduleId)).toMatch(/^big#/);
      const strategyContext = (execution.options?.strategyContext ?? {}) as Record<string, unknown>;
      const dimConfig = (strategyContext.dimConfig ?? {}) as Record<string, unknown>;
      expect(String(dimConfig.guide ?? '')).toContain('模块图谱');
      const budget = strategyContext._computedBudget as Record<string, unknown> | undefined;
      expect(budget).toBeTruthy();
      expect(typeof budget?.maxIterations).toBe('number');
    }
  });
});
