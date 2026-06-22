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
    expect(typeof runtime.validateAgentInterfaceContract).toBe('function');
    expect(typeof runtime.createSystemRunContext).toBe('function');
    expect(typeof runtime.cleanFinalAnswer).toBe('function');
    expect(typeof runtime.produceForcedSummary).toBe('function');
    expect(runtime.ALEMBIC_AGENT_INTERFACE_CONTRACT.branches.map((item) => item.branch)).toEqual([
      'success',
      'failure',
      'cancellation',
      'timeout',
      'permission-denial',
      'needs-confirmation',
      'partial-result',
      'provider-error',
      'host-failure',
      'host-adapter',
    ]);
    expect(runtime.MAX_TOOL_CALLS_PER_ITER).toBeGreaterThan(0);
  });

  it('exposes the internal runtime boundary without owning Plugin host-agent routes', () => {
    expect(runtime.ALEMBIC_AGENT_RUNTIME_BOUNDARY).toMatchObject({
      packageName: '@alembic/agent',
      runtimeLine: 'alembic-api-ai',
      hostAgentRouteSupported: false,
    });
    expect(runtime.supportsAgentRuntimeRoute('alembic-api-ai')).toBe(true);
    expect(runtime.supportsAgentRuntimeRoute('alembic-internal-ai')).toBe(false);
    expect(runtime.supportsAgentRuntimeRoute('plugin-host-agent-route')).toBe(false);
    expect(runtime.ALEMBIC_AGENT_RUNTIME_BOUNDARY.unsupportedHostRoutes).toContain(
      'plugin-host-agent-route'
    );

    const areas = runtime.ALEMBIC_AGENT_RUNTIME_BOUNDARY.entries.map((entry) => entry.area);
    expect(areas).toEqual([
      'ai-provider',
      'tool-execution',
      'terminal-sandbox',
      'context-memory',
      'prompt-runtime',
      'tool-v2',
      'host-agent-route',
    ]);

    expect(runtime.getAgentRuntimeBoundaryEntry('terminal-sandbox')).toMatchObject({
      owner: 'agent',
      publicSubpath: '@alembic/agent/tools/terminal',
      coreContracts: ['@alembic/core/host-agent-workflows'],
    });
    expect(runtime.getAgentRuntimeBoundaryEntry('host-agent-route')).toMatchObject({
      owner: 'host',
      publicSubpath: null,
    });
  });

  it('records AG2 runtime responsibility semantics without changing package subpaths', () => {
    const responsibility = runtime.ALEMBIC_AGENT_RUNTIME_BOUNDARY.responsibility;

    expect(responsibility.decompositionSeams.map((seam) => seam.id)).toEqual([
      'event-bus',
      'diagnostics',
      'budget',
      'llm-input-assembly',
      'tool-execution',
      'memory-context',
      'phase-state',
    ]);
    expect(responsibility.decompositionSeams.every((seam) => !seam.behaviorChangeAllowed)).toBe(
      true
    );
    expect(responsibility.semanticGlossary.map((entry) => entry.term).sort()).toEqual([
      'agent',
      'memory',
      'session',
      'tool',
    ]);
    expect(responsibility.featureFlags.map((flag) => flag.name)).toEqual([
      'ALEMBIC_AI_PROVIDER',
      'ALEMBIC_AI_MODEL',
      'ALEMBIC_AI_MAX_CONCURRENCY',
      'ALEMBIC_EMBED_PROVIDER',
      'ALEMBIC_DEEPSEEK_REASONING_EFFORT',
    ]);
    expect(
      responsibility.featureFlags.find((flag) => flag.name === 'ALEMBIC_AI_MAX_CONCURRENCY')
    ).toMatchObject({
      defaultValue: '4',
      owner: 'agent-ai-boundary',
      productionRelevant: true,
    });
    expect(responsibility.modelRegistryBoundary).toMatchObject({
      owner: 'agent-ai-boundary',
      forbiddenOwner: 'tool-system',
    });
    expect(responsibility.apiResponseBoundary).toMatchObject({
      owner: 'transport-private',
      forbiddenOwner: 'agent-runtime',
      allowedAccessRefs: ['src/ai/AiProvider.ts'],
    });
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
  });
});
