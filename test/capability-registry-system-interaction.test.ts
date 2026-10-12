import { describe, expect, it, vi } from 'vitest';
import {
  AgentProfileCompiler,
  createDefaultProfileCompiler,
} from '../src/agent/profiles/AgentProfileCompiler.js';
import { AgentProfileRegistry } from '../src/agent/profiles/AgentProfileRegistry.js';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';
import { PRESETS } from '../src/agent/profiles/presets/index.js';
import { AgentRuntimeBuilder } from '../src/agent/service/AgentRuntimeBuilder.js';
import { CapabilityRegistry } from '../src/tools/runtime/toolsets/CapabilityRegistry.js';

/**
 * system_interaction 能力收口的守护（L4-P33 / I06）。
 *
 * 背景：System 能力开放 code.write 与没有 commandAllowlist 的 terminal.exec。它曾以
 * 'system_interaction' 注册在 CapabilityRegistry 里，于是任何 profile 只要在 skills
 * 里写上这个名字，编译后的 runtimeOverrides.capabilities 就会经 getPreset →
 * AgentRuntimeBuilder.build → CapabilityRegistry.create 解析成 System 实例，直接拿到
 * 写文件与不受限终端权限。宿主生产与测试代码都没有引用这个名称，因此先从注册表移除；
 * System 类与 barrel 导出是否删除随待决事项②处理，不在本守护范围内。
 */

const RETIRED_CAPABILITY = 'system_interaction';

function createBuilder() {
  return new AgentRuntimeBuilder({
    container: {},
    toolRegistry: { getRouter: () => ({ execute: vi.fn() }) as never },
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
    // System 是唯一声明 code.write 的能力；它退出注册表后，按名解析出的能力都不能再写文件。
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
});
