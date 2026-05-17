import { describe, expect, it } from 'vitest';

import * as domain from '../src/agent/domain/index.js';
import * as prompts from '../src/agent/prompts/index.js';
import * as runtime from '../src/agent/runtime/index.js';
import * as service from '../src/agent/service/index.js';

describe('explicit AlembicAgent contract subpaths', () => {
  it('exposes the service orchestration surface', () => {
    expect(typeof service.AgentService).toBe('function');
    expect(typeof service.AgentRuntimeBuilder).toBe('function');
    expect(typeof service.SystemRunContextFactory).toBe('function');
    expect(typeof service.AgentRunCoordinator).toBe('function');
    expect(typeof service.AgentProfileCompiler).toBe('function');
    expect(typeof service.AgentProfileRegistry).toBe('function');
    expect(typeof service.AgentStageFactoryRegistry).toBe('function');
    expect(typeof service.runScanAgentTask).toBe('function');
  });

  it('exposes the runtime execution surface', () => {
    expect(typeof runtime.AgentRuntime).toBe('function');
    expect(typeof runtime.ToolExecutionPipeline).toBe('function');
    expect(typeof runtime.BudgetController).toBe('function');
    expect(typeof runtime.DiagnosticsCollector).toBe('function');
    expect(typeof runtime.createSystemRunContext).toBe('function');
    expect(typeof runtime.cleanFinalAnswer).toBe('function');
    expect(typeof runtime.produceForcedSummary).toBe('function');
    expect(runtime.MAX_TOOL_CALLS_PER_ITER).toBeGreaterThan(0);
  });

  it('exposes prompt builders and budget helpers', () => {
    expect(typeof prompts.computeAnalystBudget).toBe('function');
    expect(typeof prompts.buildAnalystPrompt).toBe('function');
    expect(typeof prompts.buildEvolverPrompt).toBe('function');
    expect(typeof prompts.buildProducerPrompt).toBe('function');
    expect(typeof prompts.buildScanPipelineStages).toBe('function');
    expect(typeof prompts.buildRelationsPipelineStages).toBe('function');
  });

  it('exposes domain consolidation helpers', () => {
    expect(typeof domain.EpisodicConsolidator).toBe('function');
    expect(typeof domain.EvidenceCollector).toBe('function');
    expect(typeof domain.buildConsolidationGatePrompt).toBe('function');
    expect(domain.CONSOLIDATION_GATE_TOOLS.length).toBeGreaterThan(0);
  });
});
