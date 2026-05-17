import { describe, expect, it } from 'vitest';

import * as forge from '../src/agent/forge/index.js';
import * as profiles from '../src/agent/profiles/index.js';
import * as tasks from '../src/agent/tasks/index.js';

describe('remaining host contract subpaths', () => {
  it('exposes forge contract classes', () => {
    expect(typeof forge.ToolForge).toBe('function');
    expect(typeof forge.DynamicComposer).toBe('function');
    expect(typeof forge.SandboxRunner).toBe('function');
    expect(typeof forge.TemporaryToolRegistry).toBe('function');
    expect(typeof forge.ToolRequirementAnalyzer).toBe('function');
  });

  it('exposes task handlers used by host AI routes', () => {
    expect(typeof tasks.taskCheckAndSubmit).toBe('function');
    expect(typeof tasks.taskDiscoverAllRelations).toBe('function');
    expect(typeof tasks.taskFullEnrich).toBe('function');
    expect(typeof tasks.taskQualityAudit).toBe('function');
    expect(typeof tasks.taskGuardFullScan).toBe('function');
  });

  it('exposes profile presets and registries', () => {
    expect(typeof profiles.AgentProfileCompiler).toBe('function');
    expect(typeof profiles.AgentProfileRegistry).toBe('function');
    expect(typeof profiles.AgentStageFactoryRegistry).toBe('function');
    expect(typeof profiles.getPreset).toBe('function');
    expect(typeof profiles.resolveStrategy).toBe('function');
    expect(Object.keys(profiles.PRESETS).length).toBeGreaterThan(0);
    expect(profiles.BUILTIN_PROFILES.length).toBeGreaterThan(0);
  });
});
