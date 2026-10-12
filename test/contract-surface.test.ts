import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Logger from '@alembic/core/logging';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as domain from '../src/agent/domain/index.js';
import * as profiles from '../src/agent/profiles/index.js';
import * as prompts from '../src/agent/prompts/index.js';
import * as runtime from '../src/agent/runtime/index.js';
import * as service from '../src/agent/service/index.js';
import * as tasks from '../src/agent/tasks/index.js';
import { PROVIDER_CONFIGS } from '../src/ai/registry/ProviderConfig.js';
import {
  AGENT_INTERFACE_CONTRACT_REQUIRED_BRANCHES,
  AGENT_INTERFACE_CONTRACT_REQUIRED_ROWS,
  AGENT_INTERFACE_D23_ORDINARY_OUTPUT_POLICY,
  AGENT_INTERFACE_D25_FAILURE_TAXONOMY_POLICY,
  AGENT_INTERFACE_FORBIDDEN_ORDINARY_OUTPUT_FIELDS,
  ALEMBIC_AGENT_INTERFACE_CONTRACT,
  ALEMBIC_AGENT_RUNTIME_BOUNDARY,
  alembicAgentPackage,
  allowToolDecision,
  createToolRoutingServiceContract,
  denyToolDecision,
  getAgentInterfaceContractBranch,
  getAgentInterfaceFailureTaxonomyEntry,
  projectToolResultOrdinaryOutput,
  resolveToolRouterFromContext,
  supportsAgentRuntimeRoute,
  type ToolCallContext,
  type ToolResultEnvelope,
  ToolRouterAdapter,
  type ToolRouterContract,
  type ToolServiceContracts,
  validateAgentInterfaceContract,
} from '../src/index.js';

describe('explicit AlembicAgent contract subpaths', () => {
  it('keeps explicit allow verdict and stage authoritative over conflicting extras', () => {
    expect(
      allowToolDecision('execute', { allowed: false, stage: 'discover', requestId: 'fixture' })
    ).toEqual({ allowed: true, stage: 'execute', requestId: 'fixture' });
  });

  it('keeps explicit denial and reason authoritative while preserving confirmation metadata', () => {
    expect(
      denyToolDecision('approve', 'permission denied', {
        allowed: true,
        stage: 'execute',
        reason: 'overridden',
        requiresConfirmation: true,
        resultStatus: 'needs-confirmation',
      })
    ).toEqual({
      allowed: false,
      stage: 'approve',
      reason: 'permission denied',
      requiresConfirmation: true,
      resultStatus: 'needs-confirmation',
    });
  });

  it('exposes the service orchestration surface', () => {
    expect(typeof service.AgentService).toBe('function');
    expect(typeof service.AgentRuntimeBuilder).toBe('function');
    expect(typeof service.SystemRunContextFactory).toBe('function');
    expect(typeof service.AgentRunCoordinator).toBe('function');
    expect(typeof service.AgentProfileCompiler).toBe('function');
    expect(typeof service.AgentProfileRegistry).toBe('function');
    expect(typeof service.AgentStageFactoryRegistry).toBe('function');
    expect(typeof service.runPlanAgent).toBe('function');
    expect(typeof service.runModuleMining).toBe('function');
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
      publicSubpath: '@alembic/agent/tools/runtime',
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
    // 前 5 项是既有公开名单（次序不变）；其后是 I42 补齐的、src 中实际读取的开关。
    expect(responsibility.featureFlags.map((flag) => flag.name)).toEqual([
      'ALEMBIC_AI_PROVIDER',
      'ALEMBIC_AI_MODEL',
      'ALEMBIC_AI_MAX_CONCURRENCY',
      'ALEMBIC_EMBED_PROVIDER',
      'ALEMBIC_DEEPSEEK_REASONING_EFFORT',
      'ALEMBIC_EMBED_MODEL',
      'ALEMBIC_OPENAI_API_STYLE',
      'ALEMBIC_GEMINI_MAX_CONCURRENCY',
      'ALEMBIC_AI_PROXY',
      'ALEMBIC_GOOGLE_PROXY_HTTPS',
      'ALEMBIC_GOOGLE_PROXY_HTTP',
      'ALEMBIC_OPENAI_PROXY_HTTPS',
      'ALEMBIC_OPENAI_PROXY_HTTP',
      'ALEMBIC_DEEPSEEK_PROXY_HTTPS',
      'ALEMBIC_DEEPSEEK_PROXY_HTTP',
      'ALEMBIC_CLAUDE_PROXY_HTTPS',
      'ALEMBIC_CLAUDE_PROXY_HTTP',
      'ALEMBIC_OLLAMA_PROXY_HTTPS',
      'ALEMBIC_OLLAMA_PROXY_HTTP',
      'ALEMBIC_AGENT_ENABLE_L4_COMPACTION',
      'ALEMBIC_MCP_MODE',
      'ALEMBIC_BOOTSTRAP_CONCURRENCY',
      'ALEMBIC_MODULE_MINING_CONCURRENCY',
    ]);
    expect(
      responsibility.featureFlags.find((flag) => flag.name === 'ALEMBIC_AGENT_ENABLE_L4_COMPACTION')
    ).toMatchObject({
      owner: 'agent-runtime',
      productionRelevant: true,
      defaultValue: 'unset',
      allowedValues: ['1'],
    });
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

  it('describes the frozen tool-v2 area as the single unified tool runtime', () => {
    // area id 'tool-v2' 是冻结的公开标识（见仓库 CLAUDE.md），只有 summary 文本随事实更新。
    const entry = runtime.getAgentRuntimeBoundaryEntry('tool-v2');

    expect(entry).toMatchObject({
      area: 'tool-v2',
      owner: 'agent',
      publicSubpath: '@alembic/agent/tools/runtime',
    });
    expect(entry?.summary).toMatch(/unified tool runtime/i);
    expect(entry?.summary).not.toMatch(/v2/i);
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

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 用真实编译器检查一段只做类型赋值的探针源码，返回该探针文件自身的诊断文本。 */
function typecheckRouterContractProbes(probes: Record<string, string>): Record<string, string[]> {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  // 探针放在 test/ 下的虚拟路径，按仓库自己的 package.json（type: module）走 NodeNext 解析。
  const virtualFiles = new Map(
    Object.entries(probes).map(([name, text]) => [path.join(REPO_ROOT, 'test', name), text])
  );
  const host = ts.createCompilerHost(options);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);
  host.fileExists = (fileName) => virtualFiles.has(fileName) || baseFileExists(fileName);
  host.readFile = (fileName) => virtualFiles.get(fileName) ?? baseReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = virtualFiles.get(fileName);
    return text === undefined
      ? baseGetSourceFile(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  const program = ts.createProgram([...virtualFiles.keys()], options, host);
  const result: Record<string, string[]> = {};
  for (const [name] of Object.entries(probes)) {
    const sourceFile = program.getSourceFile(path.join(REPO_ROOT, 'test', name));
    expect(sourceFile).toBeDefined();
    result[name] = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ].map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  }
  return result;
}

function routingContext(serviceContracts?: ToolServiceContracts): ToolCallContext {
  return {
    callId: 'fixture-call',
    toolId: 'fixture-tool',
    surface: 'runtime',
    actor: { role: 'fixture' },
    source: { kind: 'runtime', name: 'fixture' },
    projectRoot: 'fixture-project',
    services: {
      get: () => {
        throw new Error('fixture service locator is not used by routing resolution');
      },
    },
    ...(serviceContracts ? { serviceContracts } : {}),
  };
}

function blockedEnvelope(): ToolResultEnvelope {
  return {
    ok: false,
    toolId: 'fixture-tool',
    callId: 'fixture-call',
    startedAt: new Date(0).toISOString(),
    durationMs: 0,
    status: 'blocked',
    text: 'fixture',
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [],
      timedOutStages: [],
      blockedTools: [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: 0,
      gateFailures: [],
    },
    trust: {
      source: 'internal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}

describe('tool router contract seam (L3-C09)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets a router that only implements execute satisfy ToolRouterContract', () => {
    const diagnostics = typecheckRouterContractProbes({
      '__router-contract-execute-only.probe.ts': [
        "import type { ToolRouterContract } from '../src/tools/kernel/request.js';",
        'export const minimal: ToolRouterContract = {',
        "  execute: async () => { throw new Error('probe'); },",
        '};',
        '',
      ].join('\n'),
      // 负对照：可选不等于放开形状，explain 给了就必须是正确签名的方法。
      '__router-contract-wrong-explain.probe.ts': [
        "import type { ToolRouterContract } from '../src/tools/kernel/request.js';",
        'export const wrong: ToolRouterContract = {',
        "  execute: async () => { throw new Error('probe'); },",
        '  explain: 42,',
        '};',
        '',
      ].join('\n'),
    });
    expect(diagnostics['__router-contract-execute-only.probe.ts']).toEqual([]);
    expect(diagnostics['__router-contract-wrong-explain.probe.ts']).toEqual([
      "Type 'number' is not assignable to type '(request: ToolCallRequest) => Promise<ToolDecision>'.",
    ]);
  }, 60000);

  it('resolves a routing service contract whose router only implements execute', async () => {
    const execute = vi.fn(async () => blockedEnvelope());
    const minimal: ToolRouterContract = { execute };
    const resolved = resolveToolRouterFromContext(
      routingContext({ toolRouting: createToolRoutingServiceContract(minimal) })
    );
    expect(resolved).toBe(minimal);
    await resolved?.execute({
      toolId: 'fixture-tool',
      args: {},
      surface: 'runtime',
      actor: {},
      source: { kind: 'runtime' },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('still resolves the full ToolRouterAdapter implementation', () => {
    const adapter = new ToolRouterAdapter({
      contextFactory: {
        create: () => {
          throw new Error('fixture context factory is not used by routing resolution');
        },
      },
    });
    expect(
      resolveToolRouterFromContext(
        routingContext({ toolRouting: createToolRoutingServiceContract(adapter) })
      )
    ).toBe(adapter);
  });

  it('returns null without a shape warning when no routing service contract is configured', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger.getInstance(), 'debug').mockImplementation(() => undefined);
    expect(resolveToolRouterFromContext(routingContext())).toBeNull();
    expect(
      resolveToolRouterFromContext(
        routingContext({ toolRouting: createToolRoutingServiceContract(null) })
      )
    ).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('not configured'));
  });

  it('rejects and warns about a configured router value that lacks execute', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    // 旧的三方法守卫要求 explain/executeChildCall；现在只有 execute 是必需的执行入口。
    const withoutExecute = {
      explain: async () => ({ allowed: true, stage: 'execute' as const }),
      executeChildCall: async () => blockedEnvelope(),
    };
    expect(
      resolveToolRouterFromContext(routingContext({ toolRouting: { toolRouter: withoutExecute } }))
    ).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/execute is not a function/);
    expect(String(warn.mock.calls[0]?.[0])).toContain('callId=fixture-call');
  });
});

describe('alembicAgentPackage', () => {
  it('exposes the stable package descriptor', () => {
    expect(alembicAgentPackage).toEqual({
      packageName: '@alembic/agent',
    });
  });
});

describe('remaining host contract subpaths', () => {
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

describe('AlembicAgent public interface contract', () => {
  it('covers every D1 Agent-owned row and canonical result branch', () => {
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.rows).toEqual(AGENT_INTERFACE_CONTRACT_REQUIRED_ROWS);
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.branches.map((fixture) => fixture.branch)).toEqual(
      AGENT_INTERFACE_CONTRACT_REQUIRED_BRANCHES
    );
    expect(validateAgentInterfaceContract()).toEqual([]);
  });

  it('keeps provider internals out of public provider-error fixtures', () => {
    const fixture = getAgentInterfaceContractBranch('provider-error');

    expect(fixture).toMatchObject({
      boundaryArea: 'ai-provider',
      errorKind: 'internal-provider-error',
      toolStatus: 'error',
    });
    expect(fixture?.providerPublicFields).toContain('errorClass');
    expect(fixture?.providerPublicFields).not.toContain('rawProviderResponse');
    expect(fixture?.hiddenProviderFields).toEqual(
      expect.arrayContaining(['apiKey', 'rawProviderRequest', 'rawProviderResponse'])
    );
  });

  it('treats partial results as a first-class successful envelope branch', () => {
    const fixture = getAgentInterfaceContractBranch('partial-result');

    expect(fixture).toMatchObject({
      toolStatus: 'partial',
      ok: true,
      errorKind: 'none',
    });
  });

  it('keeps confirmation requests and host failures as distinct non-success branches', () => {
    const confirmation = getAgentInterfaceContractBranch('needs-confirmation');
    const hostFailure = getAgentInterfaceContractBranch('host-failure');

    expect(confirmation).toMatchObject({
      toolStatus: 'needs-confirmation',
      ok: false,
      errorKind: 'confirmation-required',
      hostAdapterPath: 'approval-ui-required',
    });
    expect(confirmation?.providerPublicFields).toEqual(
      expect.arrayContaining(['confirmationMessage', 'requestId'])
    );
    expect(confirmation?.hiddenProviderFields).toEqual(
      expect.arrayContaining(['rawPolicyContext', 'hostCredential', 'threadId'])
    );

    expect(hostFailure).toMatchObject({
      boundaryArea: 'host-agent-route',
      toolStatus: 'error',
      ok: false,
      errorKind: 'host-failure',
      hostAdapterPath: 'host-adapter-exception',
    });
    expect(hostFailure?.providerPublicFields).toEqual(
      expect.arrayContaining(['hostAction', 'errorClass'])
    );
    expect(hostFailure?.hiddenProviderFields).toEqual(
      expect.arrayContaining(['threadId', 'hostCredential', 'rawHostError'])
    );
  });

  it('keeps legacy compatibility audit fields out of the public contract', () => {
    const publicFixtureFields = ALEMBIC_AGENT_INTERFACE_CONTRACT.branches.flatMap((fixture) => [
      ...fixture.providerPublicFields,
      ...fixture.observabilityKeys,
    ]);

    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.forbiddenOrdinaryOutputFields).toEqual(
      AGENT_INTERFACE_FORBIDDEN_ORDINARY_OUTPUT_FIELDS
    );
    for (const field of AGENT_INTERFACE_FORBIDDEN_ORDINARY_OUTPUT_FIELDS) {
      expect(publicFixtureFields).not.toContain(field);
    }

    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT).not.toHaveProperty('activeRewriteDemandKey');
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT).not.toHaveProperty('legacyRewriteCandidates');
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT).not.toHaveProperty('alembicConsumerImpactNotes');
  });

  it('exposes the D23 ordinary output policy for diagnostic cleanup', () => {
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.ordinaryOutputPolicy).toBe(
      AGENT_INTERFACE_D23_ORDINARY_OUTPUT_POLICY
    );
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.ordinaryOutputPolicy).toMatchObject({
      demandKey:
        'alembic-interface-contract-d23-agent-result-diagnostic-content-cleanup-2026-06-10',
      forbiddenFields: AGENT_INTERFACE_FORBIDDEN_ORDINARY_OUTPUT_FIELDS,
      refFields: ['artifacts', 'resources'],
    });
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.ordinaryOutputPolicy.diagnosticSummaryKeys).toEqual(
      expect.arrayContaining([
        'warningCodes',
        'timedOutStages',
        'blockedToolIds',
        'gateFailureStages',
        'redactedFieldCount',
      ])
    );
  });

  it('fixes the D23 split: private fields at any depth, legacy envelope fields only at the root', () => {
    // 导出常量的值与次序不变（公开常量）；变化的是匹配语义（L3-C02 决策）。
    expect([...AGENT_INTERFACE_FORBIDDEN_ORDINARY_OUTPUT_FIELDS]).toEqual([
      'success',
      'errorCode',
      'message',
      'data.result',
      'legacyCompatibility',
      'rawProviderRequest',
      'rawProviderResponse',
      'reasoningContent',
      'reasoning_content',
      'thoughtSignature',
      'hiddenReasoning',
      'apiKey',
      'hostCredential',
      'threadId',
    ]);
    const envelope: ToolResultEnvelope = {
      ok: false,
      toolId: 'contract.d23',
      callId: 'contract-d23',
      startedAt: '2026-10-11T00:00:00.000Z',
      durationMs: 1,
      status: 'error',
      text: '{"error":{"code":403,"message":"permission denied","thread_id":"contract-private"}}',
      structuredContent: {
        success: false,
        message: 'legacy root message',
        error: { message: 'nested business message', apiKey: 'contract-private' },
        items: [{ message: 'item message', 'x-api-key': 'contract-private' }],
      },
      diagnostics: {
        degraded: false,
        fallbackUsed: false,
        warnings: [],
        timedOutStages: [],
        blockedTools: [],
        truncatedToolCalls: 0,
        emptyResponses: 0,
        aiErrorCount: 0,
        gateFailures: [],
      },
      trust: {
        source: 'internal',
        sanitized: true,
        containsUntrustedText: false,
        containsSecrets: false,
      },
    };

    const projected = projectToolResultOrdinaryOutput(envelope);

    expect(projected.structuredContent).toEqual({
      error: { message: 'nested business message' },
      items: [{ message: 'item message' }],
    });
    expect(projected.text).toContain('permission denied');
    expect(JSON.stringify(projected)).not.toContain('contract-private');
  });

  it('exposes the D25 Core-derived failure taxonomy policy', () => {
    const requiredKinds = [
      'invalid-input',
      'not-found',
      'conflict',
      'permission-denied',
      'timeout',
      'cancelled',
      'unavailable',
      'degraded',
      'partial',
      'capability-mismatch',
      'provider-error',
      'host-failure',
      'internal-error',
    ];

    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.failureTaxonomyPolicy).toBe(
      AGENT_INTERFACE_D25_FAILURE_TAXONOMY_POLICY
    );
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.failureTaxonomyPolicy).toMatchObject({
      demandKey: 'alembic-interface-contract-d25-error-problem-taxonomy-2026-06-10',
      coreTaxonomyVersion: 1,
      ordinaryOutputField: 'failureTaxonomy',
      privateDataSafe: true,
    });
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.failureTaxonomyPolicy.requiredFailureKinds).toEqual(
      requiredKinds
    );

    const policyKinds = ALEMBIC_AGENT_INTERFACE_CONTRACT.failureTaxonomyPolicy.entries.map(
      (entry) => entry.kind
    );
    expect(policyKinds).toEqual(expect.arrayContaining(requiredKinds));
    for (const kind of requiredKinds) {
      const entry = getAgentInterfaceFailureTaxonomyEntry(kind);
      expect(entry).toMatchObject({
        kind,
        stableId: `core.failure.${kind}`,
        privateDataSafe: true,
      });
      expect(entry?.toolStatus).not.toBeNull();
    }
  });

  it('maps key Agent branches to stable D25 failure taxonomy without collapsing them', () => {
    expect(getAgentInterfaceContractBranch('success')).toMatchObject({
      failureKind: 'none',
      failureTaxonomy: null,
    });
    expect(getAgentInterfaceContractBranch('partial-result')).toMatchObject({
      toolStatus: 'partial',
      failureKind: 'partial',
      failureTaxonomy: {
        stableId: 'core.failure.partial',
        agentBranch: 'partial-result',
        problemClass: 'partial-result',
      },
    });
    expect(getAgentInterfaceContractBranch('needs-confirmation')).toMatchObject({
      toolStatus: 'needs-confirmation',
      errorKind: 'confirmation-required',
      failureKind: 'needs-confirmation',
      failureTaxonomy: {
        stableId: 'core.failure.needs-confirmation',
        agentBranch: 'needs-confirmation',
        problemClass: 'confirmation-required',
      },
    });
    expect(getAgentInterfaceContractBranch('provider-error')).toMatchObject({
      toolStatus: 'error',
      errorKind: 'internal-provider-error',
      failureKind: 'provider-error',
      failureTaxonomy: {
        stableId: 'core.failure.provider-error',
        agentBranch: 'provider-error',
        problemClass: 'provider-problem',
      },
    });
    expect(getAgentInterfaceContractBranch('host-failure')).toMatchObject({
      toolStatus: 'error',
      errorKind: 'host-failure',
      failureKind: 'host-failure',
      failureTaxonomy: {
        stableId: 'core.failure.host-failure',
        agentBranch: 'host-failure',
        problemClass: 'host-problem',
      },
    });
  });

  it('maps host adapter paths to runtime boundary ownership instead of Plugin routes', () => {
    const fixture = getAgentInterfaceContractBranch('host-adapter');
    const hostRoute = ALEMBIC_AGENT_RUNTIME_BOUNDARY.entries.find(
      (entry) => entry.area === 'host-agent-route'
    );

    expect(fixture).toMatchObject({
      boundaryArea: 'host-agent-route',
      errorKind: 'capability-mismatch',
      hostAdapterPath: 'alembic-api-ai',
    });
    expect(supportsAgentRuntimeRoute('alembic-api-ai')).toBe(true);
    expect(supportsAgentRuntimeRoute('plugin-host-agent-route')).toBe(false);
    expect(hostRoute).toMatchObject({
      owner: 'host',
      publicSubpath: null,
    });
  });

  it('attaches failureTaxonomy to ordinary output only when the caller passes it explicitly', () => {
    // D25 分支 fixture 是静态契约清单：生产投影调用点都不传 failureTaxonomy，
    // 普通输出因此不带该字段；只有调用方显式传入时才附带（I42 注释所述事实）。
    const envelope: ToolResultEnvelope = { ...blockedEnvelope(), ok: false, status: 'error' };
    const fixtureTaxonomy = getAgentInterfaceContractBranch('failure')?.failureTaxonomy ?? null;

    expect(fixtureTaxonomy).not.toBeNull();
    expect(projectToolResultOrdinaryOutput(envelope)).not.toHaveProperty('failureTaxonomy');
    expect(
      projectToolResultOrdinaryOutput(envelope, { failureTaxonomy: fixtureTaxonomy })
        .failureTaxonomy
    ).toEqual(fixtureTaxonomy);
  });
});

/** 一个源文件里的 ALEMBIC_* 环境变量读取：静态可解析的名字，以及模板拼装名字的动态站点原文。 */
interface AlembicEnvReadScan {
  readonly staticNames: ReadonlySet<string>;
  readonly dynamicSites: readonly string[];
}

const ALEMBIC_ENV_NAME = /^ALEMBIC_[A-Z0-9_]+$/;

/** 读取接收方：process.env，或 configuration/concurrency 注入的 env 参数（默认值就是 process.env）。 */
function isEnvReceiver(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) {
    return expression.text === 'env';
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === 'env';
  }
  return false;
}

/**
 * 用 TypeScript 解析器（只看语法、天然跳过注释）找出环境变量读取点。识别的形态：
 * - `process.env.ALEMBIC_X` / `env.ALEMBIC_X`；
 * - `process.env['ALEMBIC_X']` / `env['ALEMBIC_X']`；
 * - profile 并发声明 `{ env: 'ALEMBIC_X' }`（AgentRunCoordinator 以 process.env[concurrency.env] 读取）；
 * - 以 `ALEMBIC_` 开头的模板字符串：名字在运行时拼装，记为动态站点，必须在下方展开表登记。
 * 经常量变量间接传入的新读取不在识别范围内，新增时需要同步扩展这里。
 */
function scanAlembicEnvReads(fileName: string, sourceText: string): AlembicEnvReadScan {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  );
  const staticNames = new Set<string>();
  const dynamicSites: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      isEnvReceiver(node.expression) &&
      ALEMBIC_ENV_NAME.test(node.name.text)
    ) {
      staticNames.add(node.name.text);
    } else if (
      ts.isElementAccessExpression(node) &&
      isEnvReceiver(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      ALEMBIC_ENV_NAME.test(node.argumentExpression.text)
    ) {
      staticNames.add(node.argumentExpression.text);
    } else if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'env' &&
      ts.isStringLiteralLike(node.initializer) &&
      ALEMBIC_ENV_NAME.test(node.initializer.text)
    ) {
      staticNames.add(node.initializer.text);
    } else if (
      ts.isTemplateExpression(node) &&
      /^ALEMBIC_[A-Z0-9_]*$/.test(node.head.text) &&
      node.templateSpans.every((span) => /^[A-Z0-9_]*$/.test(span.literal.text))
    ) {
      // 只有字面部分全是变量名字符的模板才像在拼装变量名；`ALEMBIC_X_INVALID: ${message}`
      // 这类错误码消息不算读取点。
      dynamicSites.push(node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { staticNames, dynamicSites };
}

/** provider 维度变量的标签：与 LLMTransport.resolveProxyUrl 一样取 providerId 的大写。 */
const PROVIDER_ENV_TAGS = PROVIDER_CONFIGS.map((config) => config.id.toUpperCase());

/**
 * 动态站点展开表：文件 → 模板原文 → 实际可能读取的变量名。未登记的动态站点让校验失败，
 * 避免运行时拼装的新开关绕过清单。
 */
const DYNAMIC_ALEMBIC_ENV_EXPANSIONS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  'src/ai/configuration.ts': {
    // scopedModel(env, owner)：owner 的类型是 'AI' | 'EMBED'。
    '`ALEMBIC_${owner}_PROVIDER`': ['ALEMBIC_AI_PROVIDER', 'ALEMBIC_EMBED_PROVIDER'],
    '`ALEMBIC_${owner}_MODEL`': ['ALEMBIC_AI_MODEL', 'ALEMBIC_EMBED_MODEL'],
    // providerKeyEnv 只拼装缺凭据错误提示里的变量名，不读取环境变量。
    '`ALEMBIC_${providerId.toUpperCase()}_API_KEY`': [],
  },
  'src/ai/transport/LLMTransport.ts': {
    '`ALEMBIC_${tag}_PROXY_HTTPS`': PROVIDER_ENV_TAGS.map((tag) => `ALEMBIC_${tag}_PROXY_HTTPS`),
    '`ALEMBIC_${tag}_PROXY_HTTP`': PROVIDER_ENV_TAGS.map((tag) => `ALEMBIC_${tag}_PROXY_HTTP`),
  },
};

/**
 * 连接配置不是行为开关，不进入 featureFlags：provider 注册表登记的凭据/端点变量
 * （PROVIDER_CONFIGS.keyEnvVar/baseUrlEnvVar），以及 embedding 专用的凭据/端点变量。
 */
const CONNECTION_SETTING_ENV_NAMES: ReadonlySet<string> = new Set([
  ...PROVIDER_CONFIGS.flatMap((config) => [config.keyEnvVar, config.baseUrlEnvVar]).filter(
    (name): name is string => typeof name === 'string' && name !== ''
  ),
  'ALEMBIC_EMBED_API_KEY',
  'ALEMBIC_EMBED_BASE_URL',
]);

interface SrcAlembicEnvReads {
  /** 仓库相对路径 → 该文件读取的变量名（含动态站点展开）。 */
  readonly byFile: ReadonlyMap<string, ReadonlySet<string>>;
  /** 变量名 → 读取它的文件。 */
  readonly byName: ReadonlyMap<string, readonly string[]>;
  readonly unregisteredDynamicSites: readonly string[];
}

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectSrcAlembicEnvReads(): SrcAlembicEnvReads {
  const byFile = new Map<string, Set<string>>();
  const byName = new Map<string, string[]>();
  const unregisteredDynamicSites: string[] = [];
  for (const fullPath of listSourceFiles(path.join(REPO_ROOT, 'src'))) {
    const relativePath = path.relative(REPO_ROOT, fullPath).split(path.sep).join('/');
    const scan = scanAlembicEnvReads(relativePath, readFileSync(fullPath, 'utf8'));
    const names = new Set(scan.staticNames);
    for (const site of scan.dynamicSites) {
      const expansion = DYNAMIC_ALEMBIC_ENV_EXPANSIONS[relativePath]?.[site];
      if (expansion === undefined) {
        unregisteredDynamicSites.push(`${relativePath}: ${site}`);
        continue;
      }
      for (const name of expansion) {
        names.add(name);
      }
    }
    if (names.size === 0) {
      continue;
    }
    byFile.set(relativePath, names);
    for (const name of names) {
      byName.set(name, [...(byName.get(name) ?? []), relativePath]);
    }
  }
  return { byFile, byName, unregisteredDynamicSites };
}

describe('AG2 runtime responsibility feature flags match real environment reads (I42)', () => {
  const featureFlags = ALEMBIC_AGENT_RUNTIME_BOUNDARY.responsibility.featureFlags;

  it('recognises every supported env read form and ignores comments and non-env strings', () => {
    const scan = scanAlembicEnvReads(
      'probe.ts',
      [
        '// process.env.ALEMBIC_IN_COMMENT',
        '/* env.ALEMBIC_IN_BLOCK_COMMENT */',
        'const a = process.env.ALEMBIC_DIRECT;',
        'const b = env.ALEMBIC_INJECTED;',
        "const c = process.env['ALEMBIC_BRACKET'];",
        "const d = { concurrency: { env: 'ALEMBIC_PROFILE', default: 2 } };",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: 探针源码文本里的模板字面量，不是模板串。
        'const e = env[`ALEMBIC_${owner}_MODEL`];',
        "const f = new Error('ALEMBIC_ERROR_CODE');",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: 探针源码文本里的模板字面量，不是模板串。
        'const h = new Error(`ALEMBIC_ERROR_CODE: ${message}`);',
        'const g = config.ALEMBIC_NOT_ENV;',
      ].join('\n')
    );

    expect([...scan.staticNames].sort()).toEqual([
      'ALEMBIC_BRACKET',
      'ALEMBIC_DIRECT',
      'ALEMBIC_INJECTED',
      'ALEMBIC_PROFILE',
    ]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 期望的是动态站点的源码原文。
    expect(scan.dynamicSites).toEqual(['`ALEMBIC_${owner}_MODEL`']);
  });

  it('points every featureFlag sourceRef at an existing src file that reads the flag', () => {
    const reads = collectSrcAlembicEnvReads();
    const problems: string[] = [];

    for (const flag of featureFlags) {
      if (flag.sourceRefs.length === 0) {
        problems.push(`${flag.name}: no sourceRefs`);
      }
      for (const ref of flag.sourceRefs) {
        if (!existsSync(path.join(REPO_ROOT, ref))) {
          problems.push(`${flag.name}: sourceRef ${ref} does not exist`);
        } else if (!reads.byFile.get(ref)?.has(flag.name)) {
          problems.push(`${flag.name}: sourceRef ${ref} does not read it`);
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('keeps every ALEMBIC_* environment read in src inside the featureFlags manifest', () => {
    const reads = collectSrcAlembicEnvReads();
    const manifestNames = new Set<string>(featureFlags.map((flag) => flag.name));
    const unlisted = [...reads.byName.entries()]
      .filter(([name]) => !manifestNames.has(name) && !CONNECTION_SETTING_ENV_NAMES.has(name))
      .map(([name, files]) => `${name} (${files.join(', ')})`)
      .sort();

    expect(reads.unregisteredDynamicSites).toEqual([]);
    expect(unlisted).toEqual([]);
    // 防空转：扫描器必须真的覆盖到已知的各类读取形态（process.env.X、注入 env.X、
    // profile 并发声明、按 provider 拼装的动态名字）。
    expect(reads.byName.get('ALEMBIC_AGENT_ENABLE_L4_COMPACTION')).toContain(
      'src/agent/runtime/BudgetController.ts'
    );
    expect(reads.byName.get('ALEMBIC_AI_MAX_CONCURRENCY')).toContain(
      'src/ai/shared/concurrency.ts'
    );
    expect(reads.byName.get('ALEMBIC_BOOTSTRAP_CONCURRENCY')).toContain(
      'src/agent/profiles/definitions/generate.profile.ts'
    );
    expect(reads.byName.get('ALEMBIC_OPENAI_PROXY_HTTPS')).toContain(
      'src/ai/transport/LLMTransport.ts'
    );
  });
});

const ORIGINAL_STABLE_EXPORTS = [
  '.',
  './agent',
  './service',
  './runtime',
  './prompts',
  './domain',
  './tasks',
  './profiles',
  './ai',
  './tools/runtime',
  './memory',
  './context',
] as const;

const STRICT_FACADES = {
  './runs': {
    import: './dist/runs.js',
    types: './dist/runs.d.ts',
    runtime: [{ name: 'runStrictPlanAgent', kind: 'function' }],
  },
  './production': {
    import: './dist/production.js',
    types: './dist/production.d.ts',
    runtime: [
      { name: 'DurableSemanticReviewRuntimeError', kind: 'class' },
      { name: 'createDurableSemanticReviewRuntime', kind: 'function' },
      { name: 'createProductionEvidenceLedgerAuthority', kind: 'function' },
      { name: 'createStrictAnalysisContextProjectionV1', kind: 'function' },
      { name: 'createStrictAnalysisEpochSnapshotV1', kind: 'function' },
      { name: 'createStrictAnalysisExpansionPortV1', kind: 'function' },
      { name: 'createStrictAnalysisFixpointV1', kind: 'function' },
      { name: 'createStrictAnalysisGateOutcomeV1', kind: 'function' },
      { name: 'createStrictHypothesisExpressionSetReceiptV1', kind: 'function' },
      { name: 'createStrictProducerExpressionSetV1', kind: 'function' },
      { name: 'createStrictProducerLineageReceiptV1', kind: 'function' },
      { name: 'validateStrictAnalysisEpochTransitionV1', kind: 'function' },
      { name: 'validateStrictAnalystEpochV1', kind: 'function' },
    ],
  },
  './evaluation': {
    import: './dist/evaluation.js',
    types: './dist/evaluation.d.ts',
    runtime: [
      { name: 'DurableSemanticReviewRuntimeError', kind: 'class' },
      { name: 'IndependentValueReviewer', kind: 'class' },
      { name: 'InvestigatedEmptyReviewer', kind: 'class' },
      { name: 'createDurableSemanticReviewRuntime', kind: 'function' },
      { name: 'createFrozenEvidenceProjection', kind: 'function' },
    ],
  },
} as const;

function readRepoJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'));
}

describe('strict production public facades', () => {
  it('declares exactly three new top-level dist package exports', () => {
    const packageJson = readRepoJson('package.json');
    const packageExports = packageJson.exports as Record<
      string,
      { readonly import: string; readonly types: string }
    >;

    for (const [exportPath, expected] of Object.entries(STRICT_FACADES)) {
      expect(packageExports[exportPath]).toEqual({
        types: expected.types,
        import: expected.import,
      });
      expect(expected.import.split('/')).toHaveLength(3);
      expect(expected.types.split('/')).toHaveLength(3);
    }
    expect(Object.keys(packageExports)).toEqual([
      ...ORIGINAL_STABLE_EXPORTS,
      ...Object.keys(STRICT_FACADES),
    ]);
    expect(Object.keys(packageExports).some((exportPath) => exportPath.includes('*'))).toBe(false);
  });

  it('classifies the new facades as stable with exact runtime signatures', () => {
    const boundary = readRepoJson('config/agent-public-api-boundary.json');
    const signatures = readRepoJson('config/agent-public-api-signatures.json');
    const stableExports = [...ORIGINAL_STABLE_EXPORTS, ...Object.keys(STRICT_FACADES)];

    expect(boundary.stablePublicExports).toEqual(stableExports);
    expect((boundary.expectedCounts as Record<string, number>)['stable-public']).toBe(15);
    expect(signatures.stablePublicExports).toEqual(stableExports);
    expect(signatures.packageExportCount).toBe(15);

    const signatureEntries = signatures.stableExportSignatures as Record<
      string,
      { readonly exportCount: number; readonly entries: unknown[] }
    >;
    for (const [exportPath, expected] of Object.entries(STRICT_FACADES)) {
      expect(signatureEntries[exportPath]?.exportCount).toBe(expected.runtime.length);
      expect(signatureEntries[exportPath]?.entries).toEqual(expected.runtime);
    }

    const matrixExports = (boundary.publicContractMatrix as { readonly export: string }[]).map(
      (entry) => entry.export
    );
    expect(matrixExports).toEqual(stableExports);
  });

  it('keeps strict implementation and evaluator internals forbidden', () => {
    const boundary = readRepoJson('config/agent-public-api-boundary.json');
    const samples = boundary.forbiddenConsumerSpecifierSamples as {
      readonly specifier: string;
    }[];
    const specifiers = samples.map((sample) => sample.specifier);

    expect(specifiers).toEqual(
      expect.arrayContaining([
        '@alembic/agent/runs/plan/PlanAgentRun.js',
        '@alembic/agent/production/StrictProductionPipeline.js',
        '@alembic/agent/evaluation/MiningJudge.js',
        '@alembic/agent/evaluation/StrictProductionFixtureEvaluation.js',
      ])
    );
  });
});
