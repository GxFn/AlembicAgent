import { createHash } from 'node:crypto';
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
import * as toolPipelineEntry from '../src/agent/runtime/ToolExecutionPipeline.js';
import * as toolPipelineObservations from '../src/agent/runtime/toolPipeline/observations.js';
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
    expect(String(warn.mock.calls[0]?.[0])).toContain('invalidMembers=execute;');
    expect(String(warn.mock.calls[0]?.[0])).toContain('callId=fixture-call');
  });

  it('rejects and warns about optional explain/executeChildCall members that are not functions', async () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    // explain/executeChildCall 可选但不放开形状：给了就必须是函数，否则调用方先判存在再调用会抛 TypeError。
    const execute = vi.fn(async () => blockedEnvelope());
    const bogus = { execute, explain: 42, executeChildCall: 'nope' };
    expect(
      resolveToolRouterFromContext(routingContext({ toolRouting: { toolRouter: bogus } }))
    ).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('invalidMembers=explain,executeChildCall;');
    expect(message).toContain(
      'memberTypes=execute:function,explain:number,executeChildCall:string'
    );
    expect(message).toContain('callId=fixture-call');
    expect(message).not.toMatch(/execute is not a function/);
    expect(execute).not.toHaveBeenCalled();

    // 只有一个可选成员不合法时，也只点名那一个。
    warn.mockClear();
    const nullChildCall = { execute, executeChildCall: null };
    expect(
      resolveToolRouterFromContext(routingContext({ toolRouting: { toolRouter: nullChildCall } }))
    ).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain('invalidMembers=executeChildCall;');
  });

  it('still resolves an execute-only router whose optional members are explicitly undefined', () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const minimal = {
      execute: async () => blockedEnvelope(),
      explain: undefined,
      executeChildCall: undefined,
    };
    expect(
      resolveToolRouterFromContext(routingContext({ toolRouting: { toolRouter: minimal } }))
    ).toBe(minimal);
    expect(warn).not.toHaveBeenCalled();
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

/* ── L6-P25：公开面废弃登记与签名快照同步（C63 / C15 / C48 / C66） ─────────────────────────
 * 用户决策（待决事项②④尚未答复）：C63 清单中无生产消费者的公开 API 本轮只加 @deprecated，
 * 删除留到事项②“公开面收窄”批次（每项删除前附 src/test/宿主生产/宿主测试零引用扫描）；
 * memory 子路径新增 SessionStore 数据类型的纯类型导出。这里锁住：
 *   - 运行时名字与种类不变：context/memory/prompts 源码入口与签名快照逐项一致（含 signatureHash）；
 *   - 签名文件 deprecatedPendingNarrowing 登记与源码 JSDoc 双向一致（不多标、不漏标）；
 *   - 新增的类型导出只在类型层可见，可直接用于 SessionStore 的写入方法。
 */

interface DeprecatedBindingRecord {
  readonly name: string;
  readonly kind: string;
  readonly exports: readonly string[];
  readonly deprecatedAt: string;
}

interface DeprecatedTypeRecord {
  readonly name: string;
  readonly exports: readonly string[];
  readonly deprecatedAt: string;
}

interface DeprecatedMembersRecord {
  readonly owner: string;
  readonly source: string;
  readonly members: readonly string[];
}

interface DeprecationRecord {
  readonly description: string;
  readonly removalPrecondition: string;
  readonly bindings: readonly DeprecatedBindingRecord[];
  readonly types: readonly DeprecatedTypeRecord[];
  readonly members: readonly DeprecatedMembersRecord[];
}

interface SignatureEntry {
  readonly name: string;
  readonly kind: string;
}

const PUBLIC_ENTRY_SOURCES = {
  '.': 'src/index.ts',
  './context': 'src/agent/context/index.ts',
  './memory': 'src/agent/memory/index.ts',
  './prompts': 'src/agent/prompts/index.ts',
} as const;

type PublicEntry = keyof typeof PUBLIC_ENTRY_SOURCES;
const NARROWED_SUBPATHS = ['./context', './memory', './prompts'] as const;

function readDeprecationRecord(): DeprecationRecord {
  const signatures = readRepoJson('config/agent-public-api-signatures.json');
  return signatures.deprecatedPendingNarrowing as DeprecationRecord;
}

function snapshotEntries(exportPath: string): {
  exportCount: number;
  signatureHash: string;
  entries: SignatureEntry[];
} {
  const signatures = readRepoJson('config/agent-public-api-signatures.json');
  const all = signatures.stableExportSignatures as Record<
    string,
    { exportCount: number; signatureHash: string; entries: SignatureEntry[] }
  >;
  const entry = all[exportPath];
  if (!entry) {
    throw new Error(`signature snapshot missing ${exportPath}`);
  }
  return entry;
}

/** 与 scripts/smoke-agent-public-signatures.mjs 相同的种类判定，保证 hash 口径一致。 */
function runtimeKind(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'function') {
    return /^class\s/u.test(Function.prototype.toString.call(value)) ? 'class' : 'function';
  }
  return typeof value;
}

let publicEntryProgram: ts.Program | undefined;

/** 只为公开入口建一次 Program；getExportsOfModule 只做绑定与解析，不做全量类型检查。 */
function publicEntryChecker(): { program: ts.Program; checker: ts.TypeChecker } {
  if (!publicEntryProgram) {
    publicEntryProgram = ts.createProgram(
      Object.values(PUBLIC_ENTRY_SOURCES).map((relative) => path.join(REPO_ROOT, relative)),
      {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      }
    );
  }
  return { program: publicEntryProgram, checker: publicEntryProgram.getTypeChecker() };
}

function hasDeprecatedTag(declaration: ts.Declaration): boolean {
  if (ts.getJSDocDeprecatedTag(declaration)) {
    return true;
  }
  // `export const X = ...` 的 JSDoc 挂在 VariableStatement 上。
  return (
    ts.isVariableDeclaration(declaration) &&
    ts.isVariableStatement(declaration.parent.parent) &&
    ts.getJSDocDeprecatedTag(declaration.parent.parent) !== undefined
  );
}

/**
 * 沿 re-export 别名链找第一个带 @deprecated 的声明，返回其所在文件（仓库相对路径）；
 * 与 TypeScript 的语义一致：入口上的 export specifier 或最终声明任一处标注都会让使用方看到废弃。
 */
function deprecationSite(checker: ts.TypeChecker, symbol: ts.Symbol): string | null {
  const seen = new Set<ts.Symbol>();
  let current: ts.Symbol | undefined = symbol;
  while (current && !seen.has(current)) {
    seen.add(current);
    for (const declaration of current.declarations ?? []) {
      if (hasDeprecatedTag(declaration)) {
        return path
          .relative(REPO_ROOT, declaration.getSourceFile().fileName)
          .split(path.sep)
          .join('/');
      }
    }
    if ((current.flags & ts.SymbolFlags.Alias) === 0) {
      break;
    }
    current = checker.getImmediateAliasedSymbol(current);
  }
  return null;
}

function deprecatedExportsOf(entry: PublicEntry): Map<string, string> {
  const { program, checker } = publicEntryChecker();
  const sourceFile = program.getSourceFile(path.join(REPO_ROOT, PUBLIC_ENTRY_SOURCES[entry]));
  if (!sourceFile) {
    throw new Error(`entry source missing: ${entry}`);
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    throw new Error(`entry module symbol missing: ${entry}`);
  }
  const out = new Map<string, string>();
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const site = deprecationSite(checker, symbol);
    if (site) {
      out.set(symbol.name, site);
    }
  }
  return out;
}

function exportNamesOf(entry: PublicEntry): Set<string> {
  const { program, checker } = publicEntryChecker();
  const sourceFile = program.getSourceFile(path.join(REPO_ROOT, PUBLIC_ENTRY_SOURCES[entry]));
  const moduleSymbol = sourceFile ? checker.getSymbolAtLocation(sourceFile) : undefined;
  if (!moduleSymbol) {
    throw new Error(`entry module symbol missing: ${entry}`);
  }
  return new Set(checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.name));
}

function memberNameOf(member: ts.Node): string | undefined {
  const name = (member as { name?: ts.PropertyName }).name;
  if (!name) {
    return undefined;
  }
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)
    ? name.text
    : undefined;
}

/** 容器（class / interface）中带 @deprecated 的成员名；同名重载合并计算。 */
function deprecatedMembersIn(sourceFile: ts.SourceFile, containerName: string): string[] {
  const out = new Set<string>();
  let found = false;
  for (const statement of sourceFile.statements) {
    if (
      (ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name?.text === containerName
    ) {
      found = true;
      for (const member of statement.members) {
        const name = memberNameOf(member);
        if (name && ts.getJSDocDeprecatedTag(member)) {
          out.add(name);
        }
      }
    }
  }
  if (!found) {
    throw new Error(`container ${containerName} not found in ${sourceFile.fileName}`);
  }
  return [...out].sort();
}

/** 顶层声明不能被整体废弃（文件头注释里的 @deprecated 字样会被解析成紧随其后声明的标签）。 */
function deprecatedTopLevelStatements(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.getJSDocDeprecatedTag(statement) || ts.getJSDocDeprecatedTag(declaration)) {
          names.push(declaration.name.getText(sourceFile));
        }
      }
    } else if (ts.getJSDocDeprecatedTag(statement)) {
      names.push(memberNameOf(statement) ?? ts.SyntaxKind[statement.kind]);
    }
  }
  return names;
}

describe('public surface deprecations pending decision 2 (L6-P25)', () => {
  it('keeps the context/memory/prompts runtime names, kinds and hashes equal to the frozen snapshot', async () => {
    const modules: Record<(typeof NARROWED_SUBPATHS)[number], Record<string, unknown>> = {
      './context': await import('../src/agent/context/index.js'),
      './memory': await import('../src/agent/memory/index.js'),
      './prompts': prompts,
    };
    for (const exportPath of NARROWED_SUBPATHS) {
      const moduleExports = modules[exportPath];
      const entries = Object.keys(moduleExports)
        .sort()
        .map((name) => ({ name, kind: runtimeKind(moduleExports[name]) }));
      const expected = snapshotEntries(exportPath);
      // 快照文件里的 entries 不保证按名排序（历史上有手工插入），hash 由 smoke 按排序后的实际值计算。
      const expectedSorted = [...expected.entries].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      );
      expect({ exportPath, entries }).toEqual({ exportPath, entries: expectedSorted });
      expect(entries).toHaveLength(expected.exportCount);
      expect(createHash('sha256').update(JSON.stringify(entries)).digest('hex')).toBe(
        expected.signatureHash
      );
    }
  });

  it('records every deprecated runtime binding in the snapshot with its frozen kind', () => {
    const record = readDeprecationRecord();
    expect(record.description).toMatch(/②/);
    expect(record.removalPrecondition).toMatch(/零引用/);
    expect(record.bindings.length).toBeGreaterThan(0);
    for (const binding of record.bindings) {
      for (const exportPath of binding.exports) {
        expect({
          exportPath,
          binding: binding.name,
          entries: snapshotEntries(exportPath).entries,
        }).toEqual({
          exportPath,
          binding: binding.name,
          entries: expect.arrayContaining([{ name: binding.name, kind: binding.kind }]),
        });
      }
    }
  });

  it('marks exactly the recorded bindings and types deprecated on the public entries', () => {
    const record = readDeprecationRecord();
    const recorded = [...record.bindings, ...record.types];
    for (const exportPath of NARROWED_SUBPATHS) {
      const actual = deprecatedExportsOf(exportPath);
      const expected = new Map(
        recorded
          .filter((entry) => entry.exports.includes(exportPath))
          .map((entry) => [entry.name, entry.deprecatedAt] as const)
      );
      expect({ exportPath, deprecated: [...actual].sort() }).toEqual({
        exportPath,
        deprecated: [...expected].sort(),
      });
    }
    // 根入口还聚合了 ai/tools 等其它层（其中已有与本包无关的废弃导出），只比较来自
    // context/memory 子路径的名字。
    const scoped = new Set([...exportNamesOf('./context'), ...exportNamesOf('./memory')]);
    const rootDeprecated = [...deprecatedExportsOf('.')].filter(([name]) => scoped.has(name));
    const rootExpected = recorded
      .filter((entry) => entry.exports.includes('.'))
      .map((entry) => [entry.name, entry.deprecatedAt] as const);
    expect(rootDeprecated.sort()).toEqual([...rootExpected].sort());
  });

  it('marks exactly the recorded members deprecated and never a whole top-level declaration', () => {
    const record = readDeprecationRecord();
    const sources = new Set<string>();
    for (const entry of record.members) {
      const file = path.join(REPO_ROOT, entry.source);
      const sourceFile = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );
      expect({
        owner: entry.owner,
        deprecated: deprecatedMembersIn(sourceFile, entry.owner),
      }).toEqual({ owner: entry.owner, deprecated: [...entry.members].sort() });
      sources.add(entry.source);
    }
    for (const source of sources) {
      const file = path.join(REPO_ROOT, source);
      const sourceFile = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );
      expect({ source, deprecatedTopLevel: deprecatedTopLevelStatements(sourceFile) }).toEqual({
        source,
        deprecatedTopLevel: [],
      });
    }
  });

  it('exports SessionStore data types from the memory subpath as types only (C66)', () => {
    const diagnostics = typecheckRouterContractProbes({
      'memory-session-store-types.probe.ts': `
import type {
  DimensionDigest,
  DimensionReportInput,
  Finding,
  SessionStore,
  TierReflection,
} from '../src/agent/memory/index.js';
import type { DimensionDigest as RootDigest, Finding as RootFinding } from '../src/index.js';

declare const store: SessionStore;
const finding: Finding = { finding: 'uses the shared session store', importance: 7 };
const digest: DimensionDigest = { summary: 'digest', keyFindings: [finding], gaps: [] };
const reflection: TierReflection = {
  tierIndex: 0,
  completedDimensions: ['api'],
  topFindings: [finding],
  crossDimensionPatterns: [],
  suggestionsForNextTier: [],
};
const report: DimensionReportInput = { analysisText: 'analysis', findings: [finding], digest };
store.addDimensionDigest('api', digest);
store.addTierReflection(0, reflection);
store.storeDimensionReport('api', report);
const rootDigest: RootDigest = digest;
const rootFinding: RootFinding = finding;
export { rootDigest, rootFinding };
`,
    });
    expect(diagnostics['memory-session-store-types.probe.ts']).toEqual([]);
  });
});

/* ── L8-P16：./tasks 子路径退役路线（L8-C10；L8-C20、L8-C21 随退役取消） ──────────────────────
 * 用户决策：整体退役 ./tasks 子路径，执行顺序为宿主先移除 ai.ts 的 DAG 条目、capabilities 广告与
 * AgentTaskHandlers 单测，Agent 再删导出并同步签名冻结文件。待决事项②③与宿主改动之前本轮只加
 * 废弃标注，不删除、不补别名、不做假实现。这里锁住：
 *   - 子路径全部导出（运行时绑定与纯类型）都带废弃标注，标注都落在 AgentTaskHandlers.ts；
 *   - 运行时名字、种类与 signatureHash 仍等于签名快照（本轮没有删除，也没有新增别名）；
 *   - 每个任务函数的废弃说明写明退役原因（缺失的工具名）或替代入口 runRelationDiscovery，
 *     且所写替代入口确实是 service 子路径上的函数。
 */

const TASKS_ENTRY_SOURCE = 'src/agent/tasks/index.ts';
const TASKS_HANDLER_SOURCE = 'src/agent/tasks/AgentTaskHandlers.ts';

/** 4 个死任务各自依赖、但在注册表/宿主/Core 中都不存在的工具名，即退役原因。 */
const RETIRED_TASK_MISSING_TOOLS = {
  taskCheckAndSubmit: 'check_duplicate',
  taskFullEnrich: 'enrich_candidate',
  taskQualityAudit: 'quality_score',
  taskGuardFullScan: 'guard_check_code',
} as const;

let tasksEntryProgram: ts.Program | undefined;

/** ./tasks 入口单独建 Program，避免改动 L6-P25 共享 Program 的根文件集合。 */
function tasksEntryChecker(): { checker: ts.TypeChecker; moduleSymbol: ts.Symbol } {
  if (!tasksEntryProgram) {
    tasksEntryProgram = ts.createProgram([path.join(REPO_ROOT, TASKS_ENTRY_SOURCE)], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    });
  }
  const checker = tasksEntryProgram.getTypeChecker();
  const sourceFile = tasksEntryProgram.getSourceFile(path.join(REPO_ROOT, TASKS_ENTRY_SOURCE));
  const moduleSymbol = sourceFile ? checker.getSymbolAtLocation(sourceFile) : undefined;
  if (!moduleSymbol) {
    throw new Error(`entry module symbol missing: ${TASKS_ENTRY_SOURCE}`);
  }
  return { checker, moduleSymbol };
}

/** 沿 re-export 别名链取第一个 @deprecated 标签的说明文字；没有标签时返回 null。 */
function tasksDeprecationText(checker: ts.TypeChecker, symbol: ts.Symbol): string | null {
  const seen = new Set<ts.Symbol>();
  let current: ts.Symbol | undefined = symbol;
  while (current && !seen.has(current)) {
    seen.add(current);
    for (const declaration of current.declarations ?? []) {
      const tag = ts.getJSDocDeprecatedTag(declaration);
      if (tag) {
        return ts.getTextOfJSDocComment(tag.comment) ?? '';
      }
    }
    if ((current.flags & ts.SymbolFlags.Alias) === 0) {
      break;
    }
    current = checker.getImmediateAliasedSymbol(current);
  }
  return null;
}

describe('tasks subpath retirement route (L8-P16)', () => {
  it('marks every ./tasks export deprecated at its AgentTaskHandlers declaration', () => {
    const { checker, moduleSymbol } = tasksEntryChecker();
    const exported = checker.getExportsOfModule(moduleSymbol);
    // 5 个运行时任务函数 + 7 个纯类型导出；数量变化说明子路径公开面被改动，须先回到退役决策。
    expect(exported.map((symbol) => symbol.name).sort()).toEqual([
      'CandidateInput',
      'DuplicateEntry',
      'GuardViolation',
      'KnowledgeItem',
      'KnowledgeServiceLike',
      'TaskAiProvider',
      'TaskContext',
      'taskCheckAndSubmit',
      'taskDiscoverAllRelations',
      'taskFullEnrich',
      'taskGuardFullScan',
      'taskQualityAudit',
    ]);
    const sites = exported
      .map((symbol) => [symbol.name, deprecationSite(checker, symbol)] as const)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    expect(sites).toEqual(sites.map(([name]) => [name, TASKS_HANDLER_SOURCE] as const));
  });

  it('keeps the ./tasks runtime names, kinds and hash frozen while retirement waits for the host', () => {
    const entries = Object.keys(tasks)
      .sort()
      .map((name) => ({ name, kind: runtimeKind((tasks as Record<string, unknown>)[name]) }));
    const expected = snapshotEntries('./tasks');
    expect(entries).toEqual(expected.entries);
    expect(entries).toHaveLength(expected.exportCount);
    expect(createHash('sha256').update(JSON.stringify(entries)).digest('hex')).toBe(
      expected.signatureHash
    );
  });

  it('names the retirement reason or the runRelationDiscovery replacement in each task deprecation', () => {
    const { checker, moduleSymbol } = tasksEntryChecker();
    const texts = new Map(
      checker
        .getExportsOfModule(moduleSymbol)
        .map((symbol) => [symbol.name, tasksDeprecationText(checker, symbol)] as const)
    );
    for (const [name, text] of texts) {
      expect({ name, mentionsPackage: text?.includes('L8-P16') ?? false }).toEqual({
        name,
        mentionsPackage: true,
      });
    }
    for (const [task, missingTool] of Object.entries(RETIRED_TASK_MISSING_TOOLS)) {
      const text = texts.get(task) ?? '';
      expect({ task, text }).toEqual({
        task,
        text: expect.stringContaining(missingTool),
      });
      expect({ task, text }).toEqual({ task, text: expect.stringContaining('没有替代入口') });
    }
    const relationText = texts.get('taskDiscoverAllRelations') ?? '';
    expect(relationText).toContain('runRelationDiscovery');
    expect(relationText).toContain('@alembic/agent/service');
    // 所写替代入口必须真实存在于 service 子路径，避免废弃说明指向一个不存在的入口。
    expect(typeof service.runRelationDiscovery).toBe('function');
  });
});

/**
 * W2a-01（L5-P47 / I45，决定②）从 ./runtime 撤回的 10 个工具管道构件。8 个中间件的实现仍由
 * createToolPipeline 装配；progressEmitter、eventBusPublisher 不在默认装配，实现一并删除。
 */
const WITHDRAWN_RUNTIME_PIPELINE_BINDINGS = [
  'allowlistGate',
  'analystVerifyOnlyGate',
  'deterministicDuplicateGuard',
  'eventBusPublisher',
  'evolutionDecisionGate',
  'progressEmitter',
  'recordRepairOnlyGate',
  'submitDedup',
  'traceRecord',
  'trackerSignal',
] as const;

describe('runtime subpath after the tool pipeline export narrowing (W2a-01 / L5-P47)', () => {
  it('withdraws the ten pipeline building blocks and keeps names, kinds and hash equal to the snapshot', () => {
    const exported = runtime as Record<string, unknown>;
    // observationRecord 已随缓存层删除（W1-04），继续守护不回流。
    expect('observationRecord' in exported).toBe(false);
    for (const name of WITHDRAWN_RUNTIME_PIPELINE_BINDINGS) {
      expect({ name, exported: name in exported }).toEqual({ name, exported: false });
    }
    // 公开的工具管道入口只剩默认工厂与类（宿主只导入 createToolPipeline，公开消费者夹具用类）。
    expect(typeof runtime.createToolPipeline).toBe('function');
    expect(runtimeKind(runtime.ToolExecutionPipeline)).toBe('class');
    const entries = Object.keys(exported)
      .sort()
      .map((name) => ({ name, kind: runtimeKind(exported[name]) }));
    const expected = snapshotEntries('./runtime');
    // 快照与实际导出逐项一致；本包删除 10 个运行时绑定（68 → 58）。
    expect(expected.exportCount).toBe(58);
    const snapshotNames = expected.entries.map((entry) => entry.name);
    for (const name of [...WITHDRAWN_RUNTIME_PIPELINE_BINDINGS, 'observationRecord']) {
      expect({ name, inSnapshot: snapshotNames.includes(name) }).toEqual({
        name,
        inSnapshot: false,
      });
    }
    expect(entries).toEqual(expected.entries);
    expect(entries).toHaveLength(expected.exportCount);
    expect(createHash('sha256').update(JSON.stringify(entries)).digest('hex')).toBe(
      expected.signatureHash
    );
  });

  it('records 440 runtime bindings across the 15 stable package exports', () => {
    const signatures = readRepoJson('config/agent-public-api-signatures.json');
    const all = signatures.stableExportSignatures as Record<string, { exportCount: number }>;
    expect(Object.keys(all)).toHaveLength(15);
    expect(signatures.packageExportCount).toBe(15);
    const total = Object.values(all).reduce((sum, entry) => sum + entry.exportCount, 0);
    expect(total).toBe(440);
  });

  it('deletes the two optional event middlewares while the internal entry keeps the eight default ones', () => {
    const entry = toolPipelineEntry as Record<string, unknown>;
    const observations = toolPipelineObservations as Record<string, unknown>;
    for (const name of ['progressEmitter', 'eventBusPublisher']) {
      expect({ name, entry: name in entry, observations: name in observations }).toEqual({
        name,
        entry: false,
        observations: false,
      });
    }
    // 8 个默认中间件只撤回 ./runtime 再导出，实现仍可由仓库内测试从入口模块取得。
    for (const name of WITHDRAWN_RUNTIME_PIPELINE_BINDINGS.filter(
      (item) => item !== 'progressEmitter' && item !== 'eventBusPublisher'
    )) {
      expect({ name, kind: typeof entry[name] }).toEqual({ name, kind: 'object' });
    }
  });

  it('drops the unread toolCalls pick from ToolLoopPort (compiler probe)', () => {
    // tsconfig 只含 src、vitest 不做类型检查，类型收窄必须用真实编译器判定。
    const diagnostics = typecheckRouterContractProbes({
      '__tool-loop-port-probe__.ts': [
        "import type { ToolLoopPort } from '../src/agent/runtime/toolPipeline/contracts.js';",
        'type Keys = keyof ToolLoopPort;',
        "export const toolCallsPicked: 'toolCalls' extends Keys ? 'still-picked' : 'narrowed' = 'narrowed';",
        "export const tracePicked: 'trace' extends Keys ? 'picked' : 'missing' = 'picked';",
        "export const trackerPicked: 'tracker' extends Keys ? 'picked' : 'missing' = 'picked';",
        '',
      ].join('\n'),
    });
    expect(diagnostics['__tool-loop-port-probe__.ts']).toEqual([]);
  });
});
