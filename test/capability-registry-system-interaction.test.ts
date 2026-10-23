import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentProfileCompiler,
  createDefaultProfileCompiler,
} from '../src/agent/profiles/AgentProfileCompiler.js';
import { AgentProfileRegistry } from '../src/agent/profiles/AgentProfileRegistry.js';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';
import { PRESETS } from '../src/agent/profiles/presets/index.js';
import { AgentRuntimeBuilder } from '../src/agent/service/AgentRuntimeBuilder.js';
import { UnifiedToolCatalog } from '../src/tools/catalog/UnifiedToolCatalog.js';
import { CapabilityRegistry } from '../src/tools/runtime/toolsets/CapabilityRegistry.js';

/**
 * system_interaction 能力收口的守护（L4-P33 / I06）。
 *
 * 背景：System 能力开放 code.write 与没有 commandAllowlist 的 terminal.exec。它曾以
 * 'system_interaction' 注册在 CapabilityRegistry 里，于是任何 profile 只要在 skills
 * 里写上这个名字，编译后的 runtimeOverrides.capabilities 就会经 getPreset →
 * AgentRuntimeBuilder.build → CapabilityRegistry.create 解析成 System 实例，直接拿到
 * 写文件与不受限终端权限。宿主生产与测试代码都没有引用这个名称，先从注册表移除；
 * 随后按待决事项②（W2a-03）删除了 System 类与两处 barrel 导出，并把注册表改为模块私有：
 * 名字表是模块级常量，不再有可变的 register/_registry，create/names 也不依赖 this。
 * 撤下原因表（RETIRED_CAPABILITY_REASONS）保留，误配 profile 仍能看到被拒的原因。
 */

const RETIRED_CAPABILITY = 'system_interaction';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function createBuilder() {
  return new AgentRuntimeBuilder({
    container: {},
    toolRegistry: new UnifiedToolCatalog(),
    toolRouter: { execute: vi.fn() },
    aiProvider: { name: 'fixture', model: 'fixture', chatWithTools: vi.fn() },
  });
}

describe('CapabilityRegistry without system_interaction', () => {
  it('does not register system_interaction by name', () => {
    expect(CapabilityRegistry.names).not.toContain(RETIRED_CAPABILITY);
    expect(() => CapabilityRegistry.create(RETIRED_CAPABILITY)).toThrow(
      `Unknown capability: ${RETIRED_CAPABILITY}`
    );
    // 撤下的名字在报错里带原因，误配 profile 的人能直接看到为什么被拒。
    expect(() => CapabilityRegistry.create(RETIRED_CAPABILITY)).toThrow(/code\.write/);
    // 普通未知名字保持原有报错，不附带撤下原因。
    expect(() => CapabilityRegistry.create('not_a_capability')).toThrow(
      /^Unknown capability: not_a_capability$/
    );
  });

  it('no registered capability grants code.write after System left the registry', () => {
    // System 曾是唯一声明 code.write 的能力；它退出注册表（W2a-03 起类也删除）后，按名解析出的能力都不能再写文件。
    for (const name of CapabilityRegistry.names) {
      const capability = CapabilityRegistry.create(name) as {
        allowedTools?: Record<string, readonly string[]> | null;
      };
      expect(capability.allowedTools?.code ?? [], name).not.toContain('write');
    }
  });

  it('a compiled override profile cannot resolve system_interaction into a runtime', () => {
    const compiled = createDefaultProfileCompiler().compile({
      id: 'misconfigured-override',
      basePreset: 'chat',
      skills: ['conversation', RETIRED_CAPABILITY],
    });
    // 编译层只透传声明；真正的准入发生在构建 runtime 时按名解析能力。
    expect(compiled.runtimeOverrides?.capabilities).toEqual(['conversation', RETIRED_CAPABILITY]);
    expect(() => createBuilder().build(compiled)).toThrow(
      `Unknown capability: ${RETIRED_CAPABILITY}`
    );
  });

  it('a compiled registered profile cannot resolve system_interaction into a runtime', () => {
    const compiler = new AgentProfileCompiler({
      profileRegistry: new AgentProfileRegistry([
        {
          id: 'misconfigured-definition',
          title: 'Misconfigured definition',
          serviceKind: 'system-analysis',
          lifecycle: 'active',
          basePreset: 'chat',
          defaults: {
            skills: [RETIRED_CAPABILITY],
            actionSpace: { mode: 'listed', toolIds: [] },
          },
          strategy: { type: 'single' },
        },
      ]),
      stageFactoryRegistry: new AgentStageFactoryRegistry(),
    });
    const compiled = compiler.compile({ id: 'misconfigured-definition' });
    expect(compiled.runtimeOverrides?.capabilities).toEqual([RETIRED_CAPABILITY]);
    expect(compiled.skills).toEqual([RETIRED_CAPABILITY]);
    expect(() => createBuilder().build(compiled)).toThrow(
      `Unknown capability: ${RETIRED_CAPABILITY}`
    );
  });

  it('built-in presets and profiles never reference system_interaction and still build', () => {
    for (const [presetName, preset] of Object.entries(PRESETS)) {
      const capabilities = (preset as { capabilities?: string[] }).capabilities ?? [];
      expect(capabilities, presetName).not.toContain(RETIRED_CAPABILITY);
      for (const name of capabilities) {
        expect(CapabilityRegistry.names, `${presetName}:${name}`).toContain(name);
      }
    }
    for (const definition of new AgentProfileRegistry().list()) {
      const skills = definition.defaults?.skills ?? [];
      expect(skills, definition.id).not.toContain(RETIRED_CAPABILITY);
      for (const name of skills) {
        expect(CapabilityRegistry.names, `${definition.id}:${name}`).toContain(name);
      }
    }
    // 内置 chat preset 走同一条 build 解析链，确认移除注册不影响正常 profile。
    expect(() => createBuilder().build({ id: 'chat' })).not.toThrow();
  });

  it('deletes the System class file while scan_analyze stays registered (W2a-03)', () => {
    expect(existsSync(`${REPO_ROOT}src/tools/runtime/toolsets/System.ts`)).toBe(false);
    // ScanAnalyze 只撤回公开导出，类文件与 scan_analyze 注册保留（tool-availability-prompt 按名解析它）。
    expect(existsSync(`${REPO_ROOT}src/tools/runtime/toolsets/ScanAnalyze.ts`)).toBe(true);
    expect(CapabilityRegistry.names).toContain('scan_analyze');
    expect(CapabilityRegistry.create('scan_analyze').name).toBe('scan_analyze');
  });

  it('keeps the name table module-private and create/names independent of this (W2a-03)', () => {
    // 可变全局（register/_registry）删除后，对象上只剩 create 与只读的 names。
    expect(Object.keys(CapabilityRegistry).sort()).toEqual(['create', 'names']);
    expect('_registry' in CapabilityRegistry).toBe(false);
    expect('register' in CapabilityRegistry).toBe(false);
    // 解构出的 create 不再依赖 this，仍按名解析并保留撤下原因。
    const { create } = CapabilityRegistry;
    expect(create('conversation').name).toBe('conversation');
    expect(() => create(RETIRED_CAPABILITY)).toThrow(/code\.write/);
    const namesGetter = Object.getOwnPropertyDescriptor(CapabilityRegistry, 'names')?.get;
    expect(namesGetter?.call(undefined)).toEqual(CapabilityRegistry.names);
    // names 每次返回副本：改动返回值不会把名字写回注册表。
    CapabilityRegistry.names.push(RETIRED_CAPABILITY);
    expect(CapabilityRegistry.names).not.toContain(RETIRED_CAPABILITY);
  });
});
