/**
 * L8-P17 第一步（L8-C09 / L8-C11 / L8-C12 / L8-C13）：无读取声明的就地清理与可见化。
 *
 * 事项②（公开类型字段、PRESETS 值形状、重复出口的删除）尚未答复，这里只锁定不改变公开面的部分：
 *   - override 路径的 serviceKind 与 preset 引用路径同口径（serviceKindForPreset），
 *     {basePreset:'chat'} 不再与 {preset:'chat'} 得到不同的描述性分类；
 *   - lifecycle=deprecated 的声明在编译时发 Logger 警告，而不是被静默复制；
 *   - module-mining 的 persona.system 没有任何读取者，已删除；合并后 persona.description 仍取 insight
 *     preset 原值（没有被改写成 description），无 systemPrompt 阶段的“# 角色”提示不变；
 *   - runs/index 不再冗余再导出严格 Plan 入口，SystemRunContextFactory 不再有 default 导出
 *     （二者都不在公开子路径上，公开 ./runs 与 ./service 出口不变）；
 *   - collectEvolutionDecisionIds 不在任何公开子路径上，注释不再自称“公开兼容入口”；
 *   - signal-analysis 的 auto 特判被宿主测试引用，保留取值，但编译时必须发出“工具不存在”的警告。
 * 同层排队 child 被中止的 stop-new 语义由 test/agent-run-coordinator-abort-policy.test.ts 锁定。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentProfileCompiler } from '../src/agent/profiles/AgentProfileCompiler.js';
import { AgentProfileRegistry } from '../src/agent/profiles/AgentProfileRegistry.js';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';
import { SCOPED_MODULE_MINING_PROFILES } from '../src/agent/profiles/definitions/module-mining/ScopedModuleMiningProfile.js';
import { getPreset, PRESETS } from '../src/agent/profiles/presets/index.js';
import type { AgentProfileDefinition } from '../src/agent/service/AgentRunContracts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function createCompiler(definitions?: AgentProfileDefinition[]) {
  return new AgentProfileCompiler({
    profileRegistry: new AgentProfileRegistry(definitions),
    stageFactoryRegistry: new AgentStageFactoryRegistry(),
  });
}

function warnMessages(warn: ReturnType<typeof vi.spyOn>, marker: string) {
  return warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes(marker));
}

function lifecycleFixture(lifecycle: AgentProfileDefinition['lifecycle']): AgentProfileDefinition {
  return {
    id: `fixture-${lifecycle}`,
    title: `Fixture ${lifecycle}`,
    serviceKind: 'system-analysis',
    lifecycle,
    basePreset: 'chat',
    defaults: { actionSpace: { mode: 'none' } },
    strategy: { type: 'single' },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('L8-C11 serviceKind 三条编译路径同口径', () => {
  it.each([
    ['chat', 'conversation'],
    ['insight', 'knowledge-production'],
    ['evolution', 'system-analysis'],
  ] as const)('%s：{basePreset} 与 {preset} 都编译为 %s', (preset, expected) => {
    const compiler = createCompiler([]);
    const fromOverride = compiler.compile({ basePreset: preset });
    const fromRef = compiler.compile({ preset });
    expect(fromRef.serviceKind).toBe(expected);
    expect(fromOverride.serviceKind).toBe(fromRef.serviceKind);
  });

  it('带 id 的 override 也按 basePreset 推导 serviceKind，id 不参与分类', () => {
    const compiled = createCompiler([]).compile({ id: 'custom-chat', basePreset: 'chat' });
    expect(compiled.id).toBe('custom-chat');
    expect(compiled.serviceKind).toBe('conversation');
  });
});

describe('L8-C11 lifecycle=deprecated 编译告警', () => {
  it('deprecated 声明编译成功并发一条带 profile id 的 warn', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const compiled = createCompiler([lifecycleFixture('deprecated')]).compile({
      id: 'fixture-deprecated',
    });
    expect(compiled.lifecycle).toBe('deprecated');
    const messages = warnMessages(warn, 'profile_lifecycle_deprecated');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('fixture-deprecated');
  });

  it.each(['active', 'experimental'] as const)('%s 声明不发 deprecated 警告', (lifecycle) => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    createCompiler([lifecycleFixture(lifecycle)]).compile({ id: `fixture-${lifecycle}` });
    expect(warnMessages(warn, 'profile_lifecycle_deprecated')).toEqual([]);
  });
});

describe('L8-C11 module-mining persona.system 删除', () => {
  it('两个 module-mining profile 的 defaults 不再声明 persona.system', () => {
    for (const definition of SCOPED_MODULE_MINING_PROFILES) {
      const persona = definition.defaults?.persona as Record<string, unknown> | undefined;
      expect(persona?.system, definition.id).toBeUndefined();
      // 不得把 system 文案改写进 description：那会改变无 systemPrompt 阶段的“# 角色”提示。
      expect(persona?.description, definition.id).toBeUndefined();
    }
  });

  it('编译后的 persona 合并结果仍等于 insight preset 原值', () => {
    const compiler = createCompiler();
    for (const id of ['module-mining-session', 'module-mining-dimension']) {
      const compiled = compiler.compile({ id });
      const merged = getPreset(compiled.basePreset, compiled.runtimeOverrides);
      expect(merged.persona, id).toEqual(PRESETS.insight.persona);
      expect((merged.persona as Record<string, unknown>).system, id).toBeUndefined();
    }
  });
});

describe('L8-C12 signal-analysis auto 特判可见化（宿主测试仍引用，暂不删除）', () => {
  it('auto 模式保留宿主断言的 actionSpace，但发出工具不存在的 warn', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const compiled = createCompiler().compile(
      { id: 'signal-analysis' },
      { params: { mode: 'auto' } }
    );
    expect(compiled.actionSpace).toEqual({
      mode: 'listed',
      toolIds: ['suggest_skills', 'create_skill'],
    });
    const messages = warnMessages(warn, 'signal_analysis_auto_tools_unregistered');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('suggest_skills');
    expect(messages[0]).toContain('create_skill');
  });

  it('非 auto 模式走声明的 actionSpace，不发该警告', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const compiled = createCompiler().compile(
      { id: 'signal-analysis' },
      { params: { mode: 'suggest' } }
    );
    expect(compiled.actionSpace).toEqual({ mode: 'none' });
    expect(warnMessages(warn, 'signal_analysis_auto_tools_unregistered')).toEqual([]);
  });
});

describe('L8-C13 内部冗余出口清理', () => {
  it('runs/index 不再再导出严格 Plan 入口，公开 ./runs 入口仍提供 runStrictPlanAgent', async () => {
    const runsIndex: Record<string, unknown> = await import('../src/agent/runs/index.js');
    expect(Object.hasOwn(runsIndex, 'runStrictPlanAgent')).toBe(false);
    expect(typeof runsIndex.runPlanAgent).toBe('function');
    const publicRuns: Record<string, unknown> = await import('../src/runs.js');
    expect(typeof publicRuns.runStrictPlanAgent).toBe('function');
    // 类型出口在运行时不可见，按源码的 export 语句检查（注释里提到名字不算）。
    const exportStatements = readSource('src/agent/runs/index.ts')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    expect(exportStatements).not.toContain('PlanContextProjectionV1');
    expect(exportStatements).not.toContain('runStrictPlanAgent');
  });

  it('SystemRunContextFactory 模块只保留具名导出', async () => {
    const factoryModule: Record<string, unknown> = await import(
      '../src/agent/service/SystemRunContextFactory.js'
    );
    expect(Object.hasOwn(factoryModule, 'default')).toBe(false);
    expect(typeof factoryModule.SystemRunContextFactory).toBe('function');
  });

  it('collectEvolutionDecisionIds 不在公开子路径上，注释不再自称公开兼容入口', async () => {
    const publicEntries = [
      '../src/index.js',
      '../src/agent/index.js',
      '../src/agent/service/index.js',
      '../src/runs.js',
    ];
    for (const entry of publicEntries) {
      const loaded: Record<string, unknown> = await import(entry);
      expect(Object.hasOwn(loaded, 'collectEvolutionDecisionIds'), entry).toBe(false);
    }
    const source = readSource('src/agent/runs/evolution/EvolutionAgentRun.ts');
    const anchor = source.indexOf('export function collectEvolutionDecisionIds');
    expect(anchor).toBeGreaterThan(0);
    const docStart = source.lastIndexOf('/**', anchor);
    const doc = source.slice(docStart, anchor);
    expect(doc).not.toContain('公开兼容入口');
    expect(doc).toContain('内部');
  });
});
