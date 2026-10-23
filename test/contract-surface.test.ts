import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as domain from '../src/agent/domain/index.js';
import * as agentEntry from '../src/agent/index.js';
import * as profiles from '../src/agent/profiles/index.js';
import * as prompts from '../src/agent/prompts/index.js';
import * as runtime from '../src/agent/runtime/index.js';
import * as toolPipelineEntry from '../src/agent/runtime/ToolExecutionPipeline.js';
import * as toolPipelineObservations from '../src/agent/runtime/toolPipeline/observations.js';
import * as service from '../src/agent/service/index.js';
import * as tasks from '../src/agent/tasks/index.js';
import * as aiEntry from '../src/ai/index.js';
import { PROVIDER_CONFIGS } from '../src/ai/registry/ProviderConfig.js';
import * as evaluationEntry from '../src/evaluation.js';
import * as agentRoot from '../src/index.js';
import {
  AGENT_INTERFACE_CONTRACT_REQUIRED_BRANCHES,
  AGENT_INTERFACE_CONTRACT_REQUIRED_ROWS,
  AGENT_INTERFACE_D23_ORDINARY_OUTPUT_POLICY,
  AGENT_INTERFACE_D25_FAILURE_TAXONOMY_POLICY,
  AGENT_INTERFACE_FORBIDDEN_ORDINARY_OUTPUT_FIELDS,
  ALEMBIC_AGENT_INTERFACE_CONTRACT,
  ALEMBIC_AGENT_RUNTIME_BOUNDARY,
  alembicAgentPackage,
  getAgentInterfaceContractBranch,
  getAgentInterfaceFailureTaxonomyEntry,
  projectToolResultOrdinaryOutput,
  supportsAgentRuntimeRoute,
  type ToolResultEnvelope,
  validateAgentInterfaceContract,
} from '../src/index.js';
import * as toolsRuntime from '../src/tools/runtime/index.js';

describe('explicit AlembicAgent contract subpaths', () => {
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
    // L2-P21 删除宽松的 ApiResponse 公开类型后，未归一的厂商响应体只在 transport 层出现；
    // 清单字段结构不变，只更新访问点与说明。
    expect(responsibility.apiResponseBoundary).toMatchObject({
      owner: 'transport-private',
      forbiddenOwner: 'agent-runtime',
      allowedAccessRefs: ['src/ai/transport/LLMTransport.ts', 'src/ai/transport/sdkProtocol.ts'],
    });
    expect(responsibility.apiResponseBoundary.summary).not.toMatch(/ApiResponse typing/);
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
  // routing service-contract 接缝（routing.ts 的两个 helper 与 serviceContracts）已在 W2a-02 删除；
  // 这里只保留契约本身的形状探针：只实现 execute 的路由同样满足 ToolRouterContract。
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
  // W2a-06（L8-P17）：durable 语义评审运行时只经 ./production 公开，./evaluation 删除重复的 2 个运行时绑定。
  './evaluation': {
    import: './dist/evaluation.js',
    types: './dist/evaluation.d.ts',
    runtime: [
      { name: 'IndependentValueReviewer', kind: 'class' },
      { name: 'InvestigatedEmptyReviewer', kind: 'class' },
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

  it('records 415 runtime bindings across the 15 stable package exports', () => {
    const signatures = readRepoJson('config/agent-public-api-signatures.json');
    const all = signatures.stableExportSignatures as Record<string, { exportCount: number }>;
    expect(Object.keys(all)).toHaveLength(15);
    expect(signatures.packageExportCount).toBe(15);
    const total = Object.values(all).reduce((sum, entry) => sum + entry.exportCount, 0);
    // W2a-01 后为 440；W2a-02 从根出口再撤回 5 个 kernel 运行时绑定（440 → 435）；
    // W2a-03 从 `.` 与 `./tools/runtime` 各撤回 System、ScanAnalyze（435 → 431）；
    // W2a-06 撤回 `.`/`./agent` 的 FanOutStrategy 与 `./evaluation` 的两个 durable 运行时绑定（431 → 427）；
    // W2a-09 撤回 `.` 3 个、`./context` 2 个、`./memory` 1 个、`./prompts` 2 个上下文与提示绑定（427 → 419）；
    // W2a-11 撤回 `.` 与 `./ai` 的 getLLMGateway、resetLLMGateway（419 → 415）。
    expect(total).toBe(415);
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

/** W2a-02（审阅包 L3-P09 / L3-P10）从根出口撤回的 5 个运行时绑定（`.` 157 → 152）。 */
const WITHDRAWN_ROOT_KERNEL_BINDINGS = [
  'allowToolDecision',
  'contextFromToolCall',
  'createToolRoutingServiceContract',
  'denyToolDecision',
  'resolveToolRouterFromContext',
] as const;

/** 同批删除的纯类型：只改变根出口 d.ts，不在运行时签名快照里。 */
const WITHDRAWN_ROOT_KERNEL_TYPES = [
  'InternalToolHandler',
  'InternalToolHandlerContext',
  'InternalToolHandlerEntry',
  'InternalToolHandlerStore',
  'InternalToolLogger',
  'InternalToolSharedState',
  'ToolDefinition',
  'ToolDiagnosticsRecorder',
  'ToolExecutionAdapter',
  'ToolExecutionPreviewRequest',
  'ToolGuardServiceContract',
  'ToolHandler',
  'ToolInfraServiceContract',
  'ToolKnowledgeServiceContract',
  'ToolLifecycleServiceContract',
  'ToolQualityServiceContract',
  'ToolRoutingServiceContract',
  'ToolServiceContracts',
] as const;

describe('tool catalog, kernel contract and handler layer retirement (W2a-02 / L3-P09, L3-P08, L3-P10, L3-P13)', () => {
  it('withdraws the five handler/routing/decision bindings from the root entry and matches the snapshot', () => {
    const exported = agentRoot as Record<string, unknown>;
    for (const name of WITHDRAWN_ROOT_KERNEL_BINDINGS) {
      expect({ name, exported: name in exported }).toEqual({ name, exported: false });
    }
    // 宿主只用 new UnifiedToolCatalog() 与 register：类本身仍在根出口上，种类不变。
    expect(runtimeKind(exported.UnifiedToolCatalog)).toBe('class');
    const expected = snapshotEntries('.');
    // W2a-02 后为 152；W2a-03 再撤回 System、ScanAnalyze（152 → 150）；W2a-06 撤回 FanOutStrategy（150 → 149）；
    // W2a-09 撤回 SEARCH_TOOLS、createGenerateStrategy、extractHighPriorityFindings（149 → 146）；
    // W2a-11 撤回 getLLMGateway、resetLLMGateway（146 → 144）。
    expect(expected.exportCount).toBe(144);
    const snapshotNames = expected.entries.map((entry) => entry.name);
    for (const name of WITHDRAWN_ROOT_KERNEL_BINDINGS) {
      expect({ name, inSnapshot: snapshotNames.includes(name) }).toEqual({
        name,
        inSnapshot: false,
      });
    }
    const entries = Object.keys(exported)
      .sort()
      .map((name) => ({ name, kind: runtimeKind(exported[name]) }));
    const expectedSorted = [...expected.entries].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    expect(entries).toEqual(expectedSorted);
    expect(entries).toHaveLength(expected.exportCount);
    expect(createHash('sha256').update(JSON.stringify(entries)).digest('hex')).toBe(
      expected.signatureHash
    );
  });

  it('narrows the kernel types, the runtime call context and the registry port (compiler probes)', () => {
    // tsconfig 只含 src、vitest 不做类型检查，所有类型收窄都用真实编译器判定（一次建 Program）。
    const removedNames = [...WITHDRAWN_ROOT_KERNEL_BINDINGS, ...WITHDRAWN_ROOT_KERNEL_TYPES];
    const diagnostics = typecheckRouterContractProbes({
      '__w2a02-removed-root-exports.probe.ts': removedNames
        .map((name) => `import type { ${name} } from '../src/index.js';`)
        .join('\n'),
      // 正对照：保留的请求/裁决/上下文类型与 ToolPolicyValidator/ToolPolicyDecision（总控裁定不删）仍可导入。
      '__w2a02-retained-root-exports.probe.ts': [
        'import type {',
        '  ToolCallContext, ToolCallRequest, ToolDecision, ToolExecutionPreview, ToolExecutionRequest,',
        '  ToolPolicyDecision, ToolPolicyValidator, ToolRouterContract, ToolRuntimeCallContext,',
        '  ToolServiceLocator,',
        "} from '../src/index.js';",
        "import { CapabilityCatalog, UnifiedToolCatalog } from '../src/index.js';",
        'export type Retained = [ToolCallContext, ToolCallRequest, ToolDecision, ToolExecutionPreview,',
        '  ToolExecutionRequest, ToolPolicyDecision, ToolPolicyValidator, ToolRouterContract,',
        '  ToolRuntimeCallContext, ToolServiceLocator];',
        'export const catalogs = [new CapabilityCatalog(), new UnifiedToolCatalog()];',
        '',
      ].join('\n'),
      '__w2a02-excess-fields.probe.ts': [
        "import type { ToolCallContext, ToolCallRequest, ToolRuntimeCallContext } from '../src/tools/kernel/index.js';",
        'export const diagnostics: ToolRuntimeCallContext = { diagnostics: null };',
        'export const policyValidator: ToolRuntimeCallContext = { policyValidator: null };',
        'export const sessionToolCalls: ToolRuntimeCallContext = { sessionToolCalls: null };',
        'export const currentRound: ToolRuntimeCallContext = { currentRound: 1 };',
        'export const validator: ToolRuntimeCallContext = { validator: {} };',
        'export const fileCache: ToolRuntimeCallContext = { fileCache: [] };',
        "export const dataRoot: ToolRuntimeCallContext = { dataRoot: 'data' };",
        'export const logger: ToolRuntimeCallContext = { logger: null };',
        'export const governance: ToolCallRequest = {',
        "  toolId: 't', args: {}, surface: 'runtime', actor: {}, source: { kind: 'runtime' },",
        "  governance: { gatewayAction: 'dashboard:probe' },",
        '};',
        'export const serviceContracts: ToolCallContext = {',
        "  callId: 'c', toolId: 't', surface: 'runtime', actor: {}, source: { kind: 'runtime' },",
        "  projectRoot: 'p', services: { get: () => { throw new Error('probe'); } },",
        '  serviceContracts: {},',
        '};',
        '',
      ].join('\n'),
      // 正对照：有宿主读取方的 runtime 字段（safetyPolicy、memoryCoordinator 等）与顶层 dataRoot 保留。
      '__w2a02-retained-fields.probe.ts': [
        "import type { ToolCallContext, ToolRuntimeCallContext } from '../src/tools/kernel/index.js';",
        'export const kept: ToolRuntimeCallContext = {',
        "  allowedTools: {}, agentId: 'a', resourceScope: { runId: 'r', viewId: 'v', revision: 0 },",
        "  presetName: 'p', iteration: 1, evidenceLedger: null, aiProvider: null, safetyPolicy: null,",
        '  lang: null, sharedState: null, dimensionMeta: null, projectLanguage: null,',
        '  submittedTitles: null, submittedPatterns: null, submittedTriggers: null,',
        '  bootstrapDedup: null, memoryCoordinator: null, dimensionScopeId: null,',
        '};',
        'export const context: ToolCallContext = {',
        "  callId: 'c', toolId: 't', surface: 'runtime', actor: {}, source: { kind: 'runtime' },",
        "  projectRoot: 'p', dataRoot: 'data', services: { get: () => { throw new Error('probe'); } },",
        '};',
        '',
      ].join('\n'),
      '__w2a02-member-sets.probe.ts': [
        "import type { ToolResultMeta } from '../src/tools/kernel/registry.js';",
        "import type { ToolRuntimePort } from '../src/agent/runtime/toolPipeline/contracts.js';",
        'type MetaKeys = keyof ToolResultMeta;',
        'type PortKeys = keyof ToolRuntimePort;',
        "export const compression: 'compression' extends MetaKeys ? 'present' : 'absent' = 'absent';",
        "export const portRegistry: 'toolRegistry' extends PortKeys ? 'picked' : 'narrowed' = 'narrowed';",
        "export const portDataRoot: 'dataRoot' extends PortKeys ? 'picked' : 'narrowed' = 'narrowed';",
        "export const portFileCache: 'fileCache' extends PortKeys ? 'picked' : 'narrowed' = 'narrowed';",
        "export const portRouter: 'toolRouter' extends PortKeys ? 'picked' : 'missing' = 'picked';",
        "export const portLogger: 'logger' extends PortKeys ? 'picked' : 'missing' = 'picked';",
        '',
      ].join('\n'),
      // RuntimeConfig.toolRegistry 收窄为最小端口：两种目录实例都能传入，builder 选项与之同源。
      '__w2a02-registry-port.probe.ts': [
        "import type { RuntimeConfig } from '../src/agent/runtime/AgentRuntimeTypes.js';",
        "import { AgentRuntimeBuilder } from '../src/agent/service/AgentRuntimeBuilder.js';",
        "import { UnifiedToolCatalog } from '../src/tools/catalog/UnifiedToolCatalog.js';",
        "import { RuntimeCapabilityCatalog } from '../src/tools/runtime/index.js';",
        "type Port = RuntimeConfig['toolRegistry'];",
        'export const unified: Port = new UnifiedToolCatalog();',
        'export const runtimeCatalog: Port = new RuntimeCapabilityCatalog();',
        'export const builder = new AgentRuntimeBuilder({',
        '  container: {}, toolRegistry: new RuntimeCapabilityCatalog(), aiProvider: null,',
        '});',
        '',
      ].join('\n'),
      // 负对照：只挂 router 的旧目录形状不满足端口；构造器不再接受定义数组。
      '__w2a02-registry-port-negative.probe.ts': [
        "import type { RuntimeConfig } from '../src/agent/runtime/AgentRuntimeTypes.js';",
        "import { UnifiedToolCatalog } from '../src/tools/catalog/UnifiedToolCatalog.js';",
        "export const legacy: RuntimeConfig['toolRegistry'] = { getRouter: () => null };",
        'export const legacyCatalog = new UnifiedToolCatalog([]);',
        '',
      ].join('\n'),
    });

    const missingExports = diagnostics['__w2a02-removed-root-exports.probe.ts']
      // 名字与现存导出相近时 TS 会改用 “has no exported member named 'X'. Did you mean …” 的措辞。
      .map((message) => /has no exported member (?:named )?'([^']+)'/.exec(message)?.[1] ?? message)
      .sort();
    expect(missingExports).toEqual([...removedNames].sort());
    expect(diagnostics['__w2a02-retained-root-exports.probe.ts']).toEqual([]);

    const excess = diagnostics['__w2a02-excess-fields.probe.ts']
      .map((message) => {
        const match = /'(\w+)' does not exist in type '(\w+)'/.exec(message);
        return match ? `${match[2]}.${match[1]}` : message;
      })
      .sort();
    expect(excess).toEqual(
      [
        'ToolCallContext.serviceContracts',
        'ToolCallRequest.governance',
        'ToolRuntimeCallContext.currentRound',
        'ToolRuntimeCallContext.dataRoot',
        'ToolRuntimeCallContext.diagnostics',
        'ToolRuntimeCallContext.fileCache',
        'ToolRuntimeCallContext.logger',
        'ToolRuntimeCallContext.policyValidator',
        'ToolRuntimeCallContext.sessionToolCalls',
        'ToolRuntimeCallContext.validator',
      ].sort()
    );
    expect(diagnostics['__w2a02-retained-fields.probe.ts']).toEqual([]);
    expect(diagnostics['__w2a02-member-sets.probe.ts']).toEqual([]);
    expect(diagnostics['__w2a02-registry-port.probe.ts']).toEqual([]);

    const negative = diagnostics['__w2a02-registry-port-negative.probe.ts'];
    expect(negative).toHaveLength(2);
    expect(negative[0]).toContain('getRouter');
    expect(negative[1]).toContain("parameter of type 'never'");
  }, 120000);
});

/** W2a-03（审阅包 L4-P33）从 `.` 与 `./tools/runtime` 撤回的两个能力类导出。 */
const WITHDRAWN_TOOLSET_BINDINGS = ['ScanAnalyze', 'System'] as const;

function sortedEntries(moduleExports: Record<string, unknown>): SignatureEntry[] {
  return Object.keys(moduleExports)
    .sort()
    .map((name) => ({ name, kind: runtimeKind(moduleExports[name]) }));
}

describe('toolset and search cache narrowing (W2a-03 / L4-P33)', () => {
  it('withdraws System and ScanAnalyze from both entries and matches the snapshot', () => {
    const subpaths = [
      // W2a-06 再撤回 FanOutStrategy（150 → 149）；W2a-09 再撤回 3 个上下文与记忆绑定（149 → 146）；
      // W2a-11 再撤回 Gateway 单例的两个函数（146 → 144）。
      { exportPath: '.', moduleExports: agentRoot as Record<string, unknown>, count: 144 },
      {
        exportPath: './tools/runtime',
        moduleExports: toolsRuntime as Record<string, unknown>,
        count: 29,
      },
    ] as const;
    for (const { exportPath, moduleExports, count } of subpaths) {
      for (const name of WITHDRAWN_TOOLSET_BINDINGS) {
        expect({ exportPath, name, exported: name in moduleExports }).toEqual({
          exportPath,
          name,
          exported: false,
        });
      }
      // 其余能力类照常公开（ScanProduce 等不在本包范围内）。
      expect(runtimeKind(moduleExports.ScanProduce)).toBe('class');
      expect(runtimeKind(moduleExports.SearchCache)).toBe('class');
      expect(runtimeKind(moduleExports.ToolRouter)).toBe('class');
      const expected = snapshotEntries(exportPath);
      expect({ exportPath, exportCount: expected.exportCount }).toEqual({
        exportPath,
        exportCount: count,
      });
      const snapshotNames = expected.entries.map((entry) => entry.name);
      for (const name of WITHDRAWN_TOOLSET_BINDINGS) {
        expect({ exportPath, name, inSnapshot: snapshotNames.includes(name) }).toEqual({
          exportPath,
          name,
          inSnapshot: false,
        });
      }
      const entries = sortedEntries(moduleExports);
      const expectedSorted = [...expected.entries].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      );
      expect({ exportPath, entries }).toEqual({ exportPath, entries: expectedSorted });
      expect(createHash('sha256').update(JSON.stringify(entries)).digest('hex')).toBe(
        expected.signatureHash
      );
    }
  });

  it('removes getSchemas, makeKey, has and the mutable registry members at runtime', () => {
    expect('getSchemas' in toolsRuntime.ToolRouter.prototype).toBe(false);
    expect('makeKey' in toolsRuntime.SearchCache).toBe(false);
    expect('has' in toolsRuntime.SearchCache.prototype).toBe(false);
    const registry = agentRoot.CapabilityRegistry as unknown as Record<string, unknown>;
    expect('_registry' in registry).toBe(false);
    expect('register' in registry).toBe(false);
    // 保留面：路由入口、缓存构造/读写/清理与能力解析不变。
    for (const member of ['execute', 'explain', 'parseToolCall', 'getToolSpec']) {
      expect({
        member,
        kind: typeof Reflect.get(toolsRuntime.ToolRouter.prototype, member),
      }).toEqual({ member, kind: 'function' });
    }
    for (const member of ['get', 'set', 'clear']) {
      expect({
        member,
        kind: typeof Reflect.get(toolsRuntime.SearchCache.prototype, member),
      }).toEqual({ member, kind: 'function' });
    }
    expect(agentRoot.CapabilityRegistry.names).toContain('scan_analyze');
  });

  it('narrows the removed members and the SearchCacheEntry type (compiler probes)', () => {
    // tsconfig 只含 src、vitest 不做类型检查，所以收窄用真实编译器判定。
    const diagnostics = typecheckRouterContractProbes({
      '__w2a03-removed-exports.probe.ts': [
        "import type { ScanAnalyze as RootScanAnalyze, System as RootSystem } from '../src/index.js';",
        "import type { ScanAnalyze, System } from '../src/tools/runtime/index.js';",
        'export type Removed = [RootScanAnalyze, RootSystem, ScanAnalyze, System];',
        '',
      ].join('\n'),
      '__w2a03-removed-members.probe.ts': [
        "import { CapabilityRegistry } from '../src/agent/index.js';",
        "import { SearchCache, ToolRouter } from '../src/tools/runtime/index.js';",
        'export const schemas = new ToolRouter().getSchemas();',
        "export const key = SearchCache.makeKey('pattern');",
        "export const present = new SearchCache().has('key');",
        'export const table = CapabilityRegistry._registry;',
        "export const registered = CapabilityRegistry.register('custom', class {} as never);",
        '',
      ].join('\n'),
      '__w2a03-cache-entry.probe.ts': [
        "import type { SearchCacheEntry } from '../src/tools/runtime/index.js';",
        'export const entry: SearchCacheEntry = { result: 1, createdAt: 0 };',
        '',
      ].join('\n'),
      // 正对照：保留的构造、读写、能力解析与解构调用都能通过编译。
      '__w2a03-retained.probe.ts': [
        "import { CapabilityRegistry } from '../src/agent/index.js';",
        "import type { SearchCacheEntry } from '../src/tools/runtime/index.js';",
        "import { ScanProduce, SearchCache, ToolRouter } from '../src/tools/runtime/index.js';",
        'const cache = new SearchCache(1);',
        "cache.set('key', { matches: 1 });",
        "export const cached: unknown = cache.get('key');",
        'cache.clear();',
        'export const size: number = cache.size;',
        'export const entry: SearchCacheEntry = { result: 1 };',
        "export const parsed = new ToolRouter().parseToolCall('meta', { action: 'tools' });",
        'const { create } = CapabilityRegistry;',
        "export const capability = create('scan_analyze');",
        'export const names: string[] = CapabilityRegistry.names;',
        'export const produce = new ScanProduce();',
        '',
      ].join('\n'),
    });

    const missingExports = diagnostics['__w2a03-removed-exports.probe.ts']
      .map((message) => /has no exported member (?:named )?'([^']+)'/.exec(message)?.[1] ?? message)
      .sort();
    expect(missingExports).toEqual(['ScanAnalyze', 'ScanAnalyze', 'System', 'System']);

    const missingMembers = diagnostics['__w2a03-removed-members.probe.ts']
      .map((message) => /Property '(\w+)' does not exist on type/.exec(message)?.[1] ?? message)
      .sort();
    expect(missingMembers).toEqual(['_registry', 'getSchemas', 'has', 'makeKey', 'register']);

    const excess = diagnostics['__w2a03-cache-entry.probe.ts'].map((message) => {
      const match = /'(\w+)' does not exist in type '(\w+)'/.exec(message);
      return match ? `${match[2]}.${match[1]}` : message;
    });
    expect(excess).toEqual(['SearchCacheEntry.createdAt']);
    expect(diagnostics['__w2a03-retained.probe.ts']).toEqual([]);
  }, 120000);
});

/** W2a-06（审阅包 L5-P39 / L8-P17）从 `./evaluation` 删除的 11 个与 `./production` 重复的绑定。 */
const WITHDRAWN_EVALUATION_DURABLE_BINDINGS = [
  'DurableSemanticReviewRuntimeError',
  'createDurableSemanticReviewRuntime',
] as const;
const WITHDRAWN_EVALUATION_DURABLE_TYPES = [
  'DurableSemanticReviewExecuteInputV1',
  'DurableSemanticReviewRuntimeBootstrapV1',
  'DurableSemanticReviewRuntimeErrorCode',
  'DurableSemanticReviewRuntimeV1',
  'SemanticReviewProviderV1',
  'SemanticReviewSigningKeyProviderV1',
  'SemanticReviewWitnessAuthorityBundleV1',
  'SemanticReviewWitnessAuthorityLookupV1',
  'SemanticReviewWitnessAuthorityPortV1',
] as const;

describe('profile compilation and strategy declaration narrowing (W2a-06 / L8-P01, L5-P39, L8-P17, L5-P37)', () => {
  it('withdraws FanOutStrategy from `.` and `./agent` and the durable runtime from `./evaluation`', () => {
    const subpaths = [
      {
        exportPath: '.',
        moduleExports: agentRoot as Record<string, unknown>,
        // W2a-09 再撤回 3 个上下文与记忆绑定（149 → 146）；W2a-11 再撤回 Gateway 单例（146 → 144）。
        count: 144,
        withdrawn: ['FanOutStrategy'],
      },
      {
        exportPath: './agent',
        moduleExports: agentEntry as Record<string, unknown>,
        count: 50,
        withdrawn: ['FanOutStrategy'],
      },
      {
        exportPath: './evaluation',
        moduleExports: evaluationEntry as Record<string, unknown>,
        count: 3,
        withdrawn: [...WITHDRAWN_EVALUATION_DURABLE_BINDINGS],
      },
    ];
    for (const { exportPath, moduleExports, count, withdrawn } of subpaths) {
      const expected = snapshotEntries(exportPath);
      expect({ exportPath, exportCount: expected.exportCount }).toEqual({
        exportPath,
        exportCount: count,
      });
      const snapshotNames = expected.entries.map((entry) => entry.name);
      for (const name of withdrawn) {
        expect({ exportPath, name, exported: name in moduleExports }).toEqual({
          exportPath,
          name,
          exported: false,
        });
        expect({ exportPath, name, inSnapshot: snapshotNames.includes(name) }).toEqual({
          exportPath,
          name,
          inSnapshot: false,
        });
      }
      const entries = sortedEntries(moduleExports);
      const expectedSorted = [...expected.entries].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      );
      expect({ exportPath, entries }).toEqual({ exportPath, entries: expectedSorted });
      expect(createHash('sha256').update(JSON.stringify(entries)).digest('hex')).toBe(
        expected.signatureHash
      );
    }
    // 保留面：PipelineStrategy / SingleStrategy / Strategy 与 durable 运行时（经 ./production）不变。
    expect(runtimeKind(agentEntry.PipelineStrategy)).toBe('class');
    expect(runtimeKind(agentEntry.SingleStrategy)).toBe('class');
    expect(runtimeKind(agentEntry.Strategy)).toBe('class');
    const production = snapshotEntries('./production').entries.map((entry) => entry.name);
    for (const name of WITHDRAWN_EVALUATION_DURABLE_BINDINGS) {
      expect({ name, inProduction: production.includes(name) }).toEqual({
        name,
        inProduction: true,
      });
    }
  });

  it('narrows the removed types and fields (compiler probes)', () => {
    // tsconfig 只含 src、vitest 不做类型检查，类型收窄一律用真实编译器判定（一次建 Program）。
    const diagnostics = typecheckRouterContractProbes({
      '__w2a06-removed-exports.probe.ts': [
        "import type { AgentProfile as RootAgentProfile } from '../src/index.js';",
        "import type { AgentProfile as AgentEntryAgentProfile } from '../src/agent/index.js';",
        "import type { AgentProfile as ServiceAgentProfile } from '../src/agent/service/index.js';",
        "import type { StrategyMergeResult } from '../src/agent/profiles/presets/types.js';",
        "import type { FanOutItem, ItemResult } from '../src/agent/strategies/index.js';",
        "import { FanOutStrategy as RootFanOut } from '../src/index.js';",
        "import { FanOutStrategy as AgentFanOut } from '../src/agent/index.js';",
        ...[...WITHDRAWN_EVALUATION_DURABLE_BINDINGS, ...WITHDRAWN_EVALUATION_DURABLE_TYPES].map(
          (name) => `import type { ${name} } from '../src/evaluation.js';`
        ),
        'export type Removed = [RootAgentProfile, AgentEntryAgentProfile, ServiceAgentProfile,',
        '  StrategyMergeResult, FanOutItem, ItemResult];',
        'export const removedClasses = [RootFanOut, AgentFanOut];',
        '',
      ].join('\n'),
      '__w2a06-narrowed-fields.probe.ts': [
        "import type { AgentConcurrencyPlan, AgentStrategyTemplate } from '../src/agent/service/AgentRunContracts.js';",
        "import type { StrategyConfig } from '../src/agent/profiles/presets/types.js';",
        "import type { RuntimeConfig } from '../src/agent/runtime/AgentRuntimeTypes.js';",
        "import type { SystemPromptBuilder } from '../src/agent/runtime/SystemPromptBuilder.js';",
        "type FanoutTemplate = Extract<AgentStrategyTemplate, { type: 'fanout' }>;",
        'type PromptOptions = NonNullable<ConstructorParameters<typeof SystemPromptBuilder>[0]>;',
        "export const fanoutTemplate: [Exclude<keyof FanoutTemplate, 'type'>] extends [never] ? 'marker-only' : 'has-fields' = 'marker-only';",
        "export const abortPolicy: 'abortPolicy' extends keyof AgentConcurrencyPlan ? 'present' : 'absent' = 'absent';",
        "export const runtimeMemory: 'memory' extends keyof RuntimeConfig ? 'present' : 'absent' = 'absent';",
        "export const promptMemory: 'memoryConfig' extends keyof PromptOptions ? 'present' : 'absent' = 'absent';",
        "type DeadStrategyKeys = 'itemStrategy' | 'tiers' | 'merge' | 'single' | 'pipeline' | 'fanOut';",
        "export const strategyConfig: [Extract<keyof StrategyConfig, DeadStrategyKeys>] extends [never] ? 'narrowed' : 'dead-fields' = 'narrowed';",
        '',
      ].join('\n'),
      // 正对照：保留的声明形状、运行时词汇与 ./evaluation 的 3 个运行时绑定照常可用。
      '__w2a06-retained.probe.ts': [
        "import type { AgentConcurrencyPlan, AgentStrategyTemplate, CompiledAgentProfile } from '../src/index.js';",
        "import type { StrategyConfig } from '../src/agent/profiles/presets/types.js';",
        "import { PipelineStrategy, SingleStrategy, Strategy } from '../src/agent/index.js';",
        "import { createFrozenEvidenceProjection, IndependentValueReviewer, InvestigatedEmptyReviewer, type FrozenEvidenceProjectionV1, type ReviewerIdentityV1 } from '../src/evaluation.js';",
        "import { createDurableSemanticReviewRuntime, DurableSemanticReviewRuntimeError, type SemanticReviewProviderV1 } from '../src/production.js';",
        "export const marker: AgentStrategyTemplate = { type: 'fanout' };",
        "export const pipelineTemplate: AgentStrategyTemplate = { type: 'pipeline', factory: 'scanPipeline' };",
        "export const plan: AgentConcurrencyPlan = { mode: 'tiered', concurrency: { env: 'E', default: 2 },",
        "  partitioner: 'generateSessionDimensions', childProfile: 'generate-dimension', merge: 'generateSessionResults' };",
        "export const strategy: StrategyConfig = { type: 'pipeline', stages: [{ name: 'analyze' }], maxRetries: 1 };",
        'export type Retained = [CompiledAgentProfile, FrozenEvidenceProjectionV1, ReviewerIdentityV1, SemanticReviewProviderV1];',
        'export const runtime = [PipelineStrategy, SingleStrategy, Strategy, createFrozenEvidenceProjection,',
        '  IndependentValueReviewer, InvestigatedEmptyReviewer, createDurableSemanticReviewRuntime,',
        '  DurableSemanticReviewRuntimeError];',
        '',
      ].join('\n'),
    });

    const missingExports = diagnostics['__w2a06-removed-exports.probe.ts']
      // 名字与现存导出相近时 TS 会改用 “has no exported member named 'X'. Did you mean …” 的措辞。
      .map((message) => /has no exported member (?:named )?'([^']+)'/.exec(message)?.[1] ?? message)
      .sort();
    expect(missingExports).toEqual(
      [
        'AgentProfile',
        'AgentProfile',
        'AgentProfile',
        'FanOutItem',
        'FanOutStrategy',
        'FanOutStrategy',
        'ItemResult',
        'StrategyMergeResult',
        ...WITHDRAWN_EVALUATION_DURABLE_BINDINGS,
        ...WITHDRAWN_EVALUATION_DURABLE_TYPES,
      ].sort()
    );
    expect(diagnostics['__w2a06-narrowed-fields.probe.ts']).toEqual([]);
    expect(diagnostics['__w2a06-retained.probe.ts']).toEqual([]);
  }, 120000);
});

/* ── W2a-09：上下文、提示与对话存储公开面收窄（L6-P25 第一组、L6-P16 getQualityMetrics 耦合项） ──────
 * 用户 2026-10-20 按推荐批准事项②“公开面收窄”。本包删除的运行时绑定：`.`/`./context` 的 SEARCH_TOOLS、
 * createGenerateStrategy，`.`/`./memory` 的 extractHighPriorityFindings，`./prompts` 的 ANALYST_TOOLS、
 * PRODUCER_TOOLS；纯类型 DimensionFlushManifest（`.`、`./memory`）；成员 ConversationStore 的
 * list/delete/cleanup/estimateTokens/summarize、PlanTracker 与 ExplorationTracker 的 getQualityMetrics、
 * BudgetInput.signalBus。createGenerateStrategy 的函数本体仍留在源文件，供 ExplorationTracker.resolve
 * 的 bootstrap 回退使用，只是不再经 `./context` 公开。签名：`.` 149→146、`./context` 21→19、
 * `./memory` 14→13、`./prompts` 30→28，总数 427→419，出口仍为 15。
 */

const WITHDRAWN_W2A09_BINDINGS = {
  '.': ['SEARCH_TOOLS', 'createGenerateStrategy', 'extractHighPriorityFindings'],
  './context': ['SEARCH_TOOLS', 'createGenerateStrategy'],
  './memory': ['extractHighPriorityFindings'],
  './prompts': ['ANALYST_TOOLS', 'PRODUCER_TOOLS'],
} as const;

/** `./context` 收窄后的完整名集（运行时绑定与纯类型）：除被删的两个名字外与收窄前逐一相同。 */
const RETAINED_CONTEXT_EXPORT_NAMES = [
  'ContextWindow',
  'ConversationStore',
  'DEFAULT_REFLECTION_INTERVAL',
  'DEFAULT_REPLAN_INTERVAL',
  'ExplorationBudget',
  'ExplorationMetrics',
  'ExplorationPhase',
  'ExplorationStrategy',
  'ExplorationTrace',
  'ExplorationTracker',
  'FullExplorationMetrics',
  'L4MemoryPackage',
  'L4MemoryPackageInput',
  'NudgeGenerator',
  'PipelineType',
  'PlanTracker',
  'STRATEGY_ANALYST',
  'STRATEGY_PRODUCER',
  'SignalDetector',
  'TransitionEntry',
  'TransitionRule',
  'buildL4MemoryPackage',
  'effectiveMemoryFindingCount',
  'formatL4MemorySummary',
  'isSearchAction',
  'limitToolResult',
  'renderL4MemoryPackage',
  'targetMemoryFindingCount',
  'targetProducerSubmitCount',
  'validateL4Summary',
] as const;

const WITHDRAWN_CONVERSATION_STORE_MEMBERS = [
  'cleanup',
  'delete',
  'estimateTokens',
  'list',
  'summarize',
] as const;

describe('context, prompts and conversation store narrowing (W2a-09 / L6-P25, L6-P16)', () => {
  it('withdraws the bindings from `.`, `./context`, `./memory` and `./prompts` and matches the snapshot', async () => {
    const contextEntry = (await import('../src/agent/context/index.js')) as Record<string, unknown>;
    const memoryEntry = (await import('../src/agent/memory/index.js')) as Record<string, unknown>;
    const subpaths = [
      // W2a-11 再撤回 getLLMGateway、resetLLMGateway（146 → 144）。
      { exportPath: '.', moduleExports: agentRoot as Record<string, unknown>, count: 144 },
      { exportPath: './context', moduleExports: contextEntry, count: 19 },
      { exportPath: './memory', moduleExports: memoryEntry, count: 13 },
      { exportPath: './prompts', moduleExports: prompts as Record<string, unknown>, count: 28 },
    ] as const;
    for (const { exportPath, moduleExports, count } of subpaths) {
      const expected = snapshotEntries(exportPath);
      expect({ exportPath, exportCount: expected.exportCount }).toEqual({
        exportPath,
        exportCount: count,
      });
      const snapshotNames = expected.entries.map((entry) => entry.name);
      for (const name of WITHDRAWN_W2A09_BINDINGS[exportPath]) {
        expect({ exportPath, name, exported: name in moduleExports }).toEqual({
          exportPath,
          name,
          exported: false,
        });
        expect({ exportPath, name, inSnapshot: snapshotNames.includes(name) }).toEqual({
          exportPath,
          name,
          inSnapshot: false,
        });
      }
      const entries = sortedEntries(moduleExports);
      const expectedSorted = [...expected.entries].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      );
      expect({ exportPath, entries }).toEqual({ exportPath, entries: expectedSorted });
      expect(createHash('sha256').update(JSON.stringify(entries)).digest('hex')).toBe(
        expected.signatureHash
      );
    }
    // 搜索轮次判定入口与 bootstrap 回退所在的追踪器照常公开，种类不变。
    expect(runtimeKind(contextEntry.isSearchAction)).toBe('function');
    expect(runtimeKind(contextEntry.ExplorationTracker)).toBe('class');
    // `./context` 其余名字与类型（含 ExplorationStrategies 的全部类型）一个不少。
    expect([...exportNamesOf('./context')].sort()).toEqual([...RETAINED_CONTEXT_EXPORT_NAMES]);
  });

  it('drops the withdrawn names and members from the deprecation registry', () => {
    const record = readDeprecationRecord();
    const bindings = record.bindings.map((binding) => binding.name);
    for (const name of [
      'SEARCH_TOOLS',
      'createGenerateStrategy',
      'extractHighPriorityFindings',
      'ANALYST_TOOLS',
      'PRODUCER_TOOLS',
    ]) {
      expect({ name, registered: bindings.includes(name) }).toEqual({ name, registered: false });
    }
    // EVOLVER_TOOLS 与 v1 buildProducerPrompt 属于 W2b（D5），仍留在登记中。
    expect(bindings).toEqual(expect.arrayContaining(['EVOLVER_TOOLS', 'buildProducerPrompt']));
    expect(record.types.map((type) => type.name)).not.toContain('DimensionFlushManifest');
    const owners = record.members.map((entry) => entry.owner);
    for (const owner of ['ConversationStore', 'PlanTracker', 'ExplorationTracker', 'BudgetInput']) {
      expect({ owner, registered: owners.includes(owner) }).toEqual({ owner, registered: false });
    }
  });

  it('removes the withdrawn tracker and conversation store members at runtime', async () => {
    const { ConversationStore, ExplorationTracker, PlanTracker } = await import(
      '../src/agent/context/index.js'
    );
    const storePrototype = ConversationStore.prototype as unknown as Record<string, unknown>;
    for (const member of WITHDRAWN_CONVERSATION_STORE_MEMBERS) {
      expect({ member, present: member in storePrototype }).toEqual({ member, present: false });
    }
    // 宿主只用 new / create / append / load，这些保持不变。
    for (const member of ['create', 'append', 'load']) {
      expect({ member, kind: typeof storePrototype[member] }).toEqual({ member, kind: 'function' });
    }
    expect('getQualityMetrics' in PlanTracker.prototype).toBe(false);
    expect('getQualityMetrics' in ExplorationTracker.prototype).toBe(false);
  });

  it('narrows the removed exports, members and the signalBus budget field (compiler probes)', () => {
    // tsconfig 只含 src、vitest 不做类型检查，类型收窄一律用真实编译器判定（一次建 Program）。
    const diagnostics = typecheckRouterContractProbes({
      '__w2a09-removed-exports.probe.ts': [
        "import { SEARCH_TOOLS as ContextSearchTools, createGenerateStrategy as ContextGenerate } from '../src/agent/context/index.js';",
        "import { SEARCH_TOOLS as RootSearchTools, createGenerateStrategy as RootGenerate, extractHighPriorityFindings as RootExtract, type DimensionFlushManifest as RootManifest } from '../src/index.js';",
        "import { extractHighPriorityFindings as MemoryExtract, type DimensionFlushManifest as MemoryManifest } from '../src/agent/memory/index.js';",
        "import { ANALYST_TOOLS, PRODUCER_TOOLS } from '../src/agent/prompts/index.js';",
        'export type Removed = [RootManifest, MemoryManifest];',
        'export const removed = [ContextSearchTools, ContextGenerate, RootSearchTools, RootGenerate,',
        '  RootExtract, MemoryExtract, ANALYST_TOOLS, PRODUCER_TOOLS];',
        '',
      ].join('\n'),
      '__w2a09-removed-members.probe.ts': [
        "import type { ConversationStore, ExplorationTracker, PlanTracker } from '../src/agent/context/index.js';",
        'type BudgetInput = ConstructorParameters<typeof ExplorationTracker>[1];',
        `type RemovedStoreMembers = Extract<keyof ConversationStore, ${WITHDRAWN_CONVERSATION_STORE_MEMBERS.map((member) => `'${member}'`).join(' | ')}>;`,
        "export const storeMembers: [RemovedStoreMembers] extends [never] ? 'narrowed' : 'present' = 'narrowed';",
        "export const planQuality: 'getQualityMetrics' extends keyof PlanTracker ? 'present' : 'absent' = 'absent';",
        "export const trackerQuality: 'getQualityMetrics' extends keyof ExplorationTracker ? 'present' : 'absent' = 'absent';",
        "export const budgetSignalBus: 'signalBus' extends keyof BudgetInput ? 'present' : 'absent' = 'absent';",
        '',
      ].join('\n'),
      // 构造参数对象字面量里再带 signalBus 应报多余属性，而不是被静默接受。
      '__w2a09-signal-bus-excess.probe.ts': [
        "import { ExplorationTracker, STRATEGY_ANALYST } from '../src/agent/context/index.js';",
        'export const tracker = new ExplorationTracker(STRATEGY_ANALYST, { maxIterations: 4, signalBus: null });',
        '',
      ].join('\n'),
      // 正对照：`./context` 保留的运行时名字与全部类型、memory 的 DistilledContext、宿主使用的
      // ConversationStore 入口与 W2b 才处理的 prompts 名字照常可用。
      '__w2a09-retained.probe.ts': [
        'import {',
        '  ContextWindow, ConversationStore, DEFAULT_REFLECTION_INTERVAL, DEFAULT_REPLAN_INTERVAL,',
        '  ExplorationTracker, NudgeGenerator, PlanTracker, STRATEGY_ANALYST, STRATEGY_PRODUCER, SignalDetector,',
        '  buildL4MemoryPackage, effectiveMemoryFindingCount, formatL4MemorySummary, isSearchAction,',
        '  limitToolResult, renderL4MemoryPackage, targetMemoryFindingCount, targetProducerSubmitCount,',
        '  validateL4Summary, type ExplorationBudget, type ExplorationMetrics, type ExplorationPhase,',
        '  type ExplorationStrategy, type ExplorationTrace, type FullExplorationMetrics, type L4MemoryPackage,',
        '  type L4MemoryPackageInput, type PipelineType, type TransitionEntry, type TransitionRule,',
        "} from '../src/agent/context/index.js';",
        "import type { DistilledContext } from '../src/agent/memory/index.js';",
        "import type { DistilledContext as RootDistilled, ExplorationStrategy as RootStrategy } from '../src/index.js';",
        "import { ANALYST_BUDGET, EVOLVER_TOOLS, PRODUCER_BUDGET, buildProducerPrompt } from '../src/agent/prompts/index.js';",
        'declare const store: ConversationStore;',
        "const id: string = store.create({ category: 'user', title: 'probe' });",
        "store.append(id, { role: 'user', content: 'probe' });",
        'export const history: Array<{ role: string; content: string }> = store.load(id, { tokenBudget: 100 });',
        "export const tracker = ExplorationTracker.resolve({ source: 'system', strategy: 'analyst' }, { maxIterations: 4 });",
        "export const search: boolean = isSearchAction('code', { action: 'search' });",
        'export type Retained = [ExplorationBudget, ExplorationMetrics, ExplorationPhase, ExplorationStrategy,',
        '  ExplorationTrace, FullExplorationMetrics, L4MemoryPackage, L4MemoryPackageInput, PipelineType,',
        '  TransitionEntry, TransitionRule, DistilledContext, RootDistilled, RootStrategy];',
        'export const runtime = [ContextWindow, DEFAULT_REFLECTION_INTERVAL, DEFAULT_REPLAN_INTERVAL, NudgeGenerator,',
        '  PlanTracker, STRATEGY_ANALYST, STRATEGY_PRODUCER, SignalDetector, buildL4MemoryPackage,',
        '  effectiveMemoryFindingCount, formatL4MemorySummary, limitToolResult, renderL4MemoryPackage,',
        '  targetMemoryFindingCount, targetProducerSubmitCount, validateL4Summary, ANALYST_BUDGET, EVOLVER_TOOLS,',
        '  PRODUCER_BUDGET, buildProducerPrompt];',
        '',
      ].join('\n'),
    });

    const missingExports = diagnostics['__w2a09-removed-exports.probe.ts']
      // 名字与现存导出相近时 TS 会改用 “has no exported member named 'X'. Did you mean …” 的措辞。
      .map((message) => /has no exported member (?:named )?'([^']+)'/.exec(message)?.[1] ?? message)
      .sort();
    expect(missingExports).toEqual(
      [
        'ANALYST_TOOLS',
        'DimensionFlushManifest',
        'DimensionFlushManifest',
        'PRODUCER_TOOLS',
        'SEARCH_TOOLS',
        'SEARCH_TOOLS',
        'createGenerateStrategy',
        'createGenerateStrategy',
        'extractHighPriorityFindings',
        'extractHighPriorityFindings',
      ].sort()
    );
    expect(diagnostics['__w2a09-removed-members.probe.ts']).toEqual([]);
    expect(diagnostics['__w2a09-signal-bus-excess.probe.ts']).toEqual([
      "Object literal may only specify known properties, and 'signalBus' does not exist in type 'BudgetInput'.",
    ]);
    expect(diagnostics['__w2a09-retained.probe.ts']).toEqual([]);
  }, 120000);
});

/* ── W2a-11：AI provider 与 transport 收窄（L2-P21、L2-P22） ──────────────────────────────────────
 * 用户 2026-10-20 按推荐批准事项②③。删除的运行时绑定：`.`/`./ai` 的 getLLMGateway、resetLLMGateway
 * （共享 Gateway 模块级单例）；纯类型 ApiResponse、FileContentEntry、LanguageProfile（`.`、`./ai`）；成员：
 * AiProvider 与 5 个内置 provider 的 supportsNativeToolCalling，AiProvider 的 summarize、summarizeMaxTokens、
 * _detectLanguageProfile、_fallbackFrom，LLMGateway 的 probe、resolveWithFallback、getModelDef，
 * ManagedAiProvider 的 apiKey、_fallbackFrom，AiProviderManager 的 embedding 兼容槽（_bindDiSync 回调收为单参数），
 * LLMTransport 与 4 个 transport 的 chat、chatStructured。签名：`.` 146→144、`./ai` 28→26，总数 419→415，出口 15。
 */

const WITHDRAWN_W2A11_BINDINGS = ['getLLMGateway', 'resetLLMGateway'] as const;

describe('AI provider and transport narrowing (W2a-11 / L2-P21, L2-P22)', () => {
  it('withdraws the Gateway singleton functions from `.` and `./ai` and matches the snapshot', () => {
    const subpaths = [
      { exportPath: '.', moduleExports: agentRoot as Record<string, unknown>, count: 144 },
      { exportPath: './ai', moduleExports: aiEntry as Record<string, unknown>, count: 26 },
    ] as const;
    for (const { exportPath, moduleExports, count } of subpaths) {
      const expected = snapshotEntries(exportPath);
      expect({ exportPath, exportCount: expected.exportCount }).toEqual({
        exportPath,
        exportCount: count,
      });
      const snapshotNames = expected.entries.map((entry) => entry.name);
      for (const name of WITHDRAWN_W2A11_BINDINGS) {
        expect({ exportPath, name, exported: name in moduleExports }).toEqual({
          exportPath,
          name,
          exported: false,
        });
        expect({ exportPath, name, inSnapshot: snapshotNames.includes(name) }).toEqual({
          exportPath,
          name,
          inSnapshot: false,
        });
      }
      const entries = sortedEntries(moduleExports);
      const expectedSorted = [...expected.entries].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      );
      expect({ exportPath, entries }).toEqual({ exportPath, entries: expectedSorted });
      expect(createHash('sha256').update(JSON.stringify(entries)).digest('hex')).toBe(
        expected.signatureHash
      );
    }
    // LLMGateway 类与宿主使用的 AI 入口照常公开，种类不变。
    const ai = aiEntry as Record<string, unknown>;
    expect(runtimeKind(ai.LLMGateway)).toBe('class');
    expect(runtimeKind(ai.AiProviderManager)).toBe('class');
    for (const name of [
      'createProvider',
      'getModelRegistry',
      'autoDetectProvider',
      'getAiConfigInfo',
      'getProviderWithFallback',
    ]) {
      expect({ name, kind: runtimeKind(ai[name]) }).toEqual({ name, kind: 'function' });
    }
  });

  it('narrows the removed types and members while keeping the retained AI surface (compiler probes)', () => {
    // tsconfig 只含 src、vitest 不做类型检查，类型与成员收窄一律用真实编译器判定（一次建 Program）。
    const providerClasses = [
      'AiProvider',
      'OpenAiProvider',
      'ClaudeProvider',
      'DeepSeekProvider',
      'GoogleGeminiProvider',
      'OllamaProvider',
    ];
    const transportClasses = [
      'LLMTransport',
      'OpenAiTransport',
      'ClaudeTransport',
      'DeepSeekTransport',
      'GoogleTransport',
    ];
    const diagnostics = typecheckRouterContractProbes({
      '__w2a11-removed-exports.probe.ts': [
        "import { getLLMGateway as RootGet, resetLLMGateway as RootReset, type ApiResponse as RootApi, type FileContentEntry as RootFile, type LanguageProfile as RootLang } from '../src/index.js';",
        "import { getLLMGateway as AiGet, resetLLMGateway as AiReset, type ApiResponse as AiApi, type FileContentEntry as AiFile, type LanguageProfile as AiLang } from '../src/ai/index.js';",
        'export type Removed = [RootApi, RootFile, RootLang, AiApi, AiFile, AiLang];',
        'export const removed = [RootGet, RootReset, AiGet, AiReset];',
        '',
      ].join('\n'),
      '__w2a11-removed-members.probe.ts': [
        `import type { ${[...providerClasses, ...transportClasses].join(', ')}, AiProviderManager, LLMGateway, ManagedAiProvider } from '../src/ai/index.js';`,
        'type Absent<T, K extends PropertyKey> = [Extract<keyof T, K>] extends [never] ? true : false;',
        `export const providers: [${providerClasses
          .map(
            (name) =>
              `Absent<${name}, 'supportsNativeToolCalling' | 'summarize' | '_detectLanguageProfile' | '_fallbackFrom'>`
          )
          .join(', ')}] = [${providerClasses.map(() => 'true').join(', ')}];`,
        `export const transports: [${transportClasses
          .map((name) => `Absent<${name}, 'chat' | 'chatStructured'>`)
          .join(', ')}] = [${transportClasses.map(() => 'true').join(', ')}];`,
        "export const gateway: Absent<LLMGateway, 'probe' | 'resolveWithFallback' | 'getModelDef'> = true;",
        "export const manager: Absent<AiProviderManager, 'embedProvider' | 'rawEmbedProvider' | 'setEmbedProvider'> = true;",
        "export const managed: Absent<ManagedAiProvider, 'apiKey' | '_fallbackFrom'> = true;",
        "type SyncHook = Parameters<AiProviderManager['_bindDiSync']>[0];",
        "export const syncArity: Parameters<SyncHook>['length'] extends 1 ? 'single' : 'multi' = 'single';",
        '',
      ].join('\n'),
      // 负对照：protected 的 summarizeMaxTokens 不在 keyof 里，只能经子类访问确认已删除；
      // ManagedAiProvider 对象字面量再带 apiKey 应报多余属性，而不是被静默接受。
      '__w2a11-negative.probe.ts': [
        "import { AiProvider, type ManagedAiProvider } from '../src/ai/index.js';",
        'export class SummaryBudgetProbe extends AiProvider {',
        '  read(): number { return this.summarizeMaxTokens; }',
        '}',
        "export const managed: ManagedAiProvider = { name: 'probe', model: 'probe-model', apiKey: 'probe' };",
        '',
      ].join('\n'),
      // 正对照：保留项（AiProvider.probe、chatWithStructuredOutput、supportsEmbedding、
      // LLMGateway.chatStructured、AiProviderManager.isMock 与单参数 _bindDiSync、Transport.chatWithTools、
      // ModelRegistry 查询 API、宿主使用的工厂入口）照常可用。
      '__w2a11-retained.probe.ts': [
        'import {',
        '  type AiProvider, type AiProviderManager, type LLMGateway, type LLMTransport, type ManagedAiProvider,',
        '  type ProviderInfo, PROVIDER_CONFIGS, autoDetectProvider, createProvider, getAiConfigInfo,',
        '  getModelRegistry, getProviderWithFallback,',
        "} from '../src/ai/index.js';",
        'declare const provider: AiProvider;',
        'export const probed: Promise<boolean> = provider.probe();',
        "export const structured: Promise<unknown> = provider.chatWithStructuredOutput('p');",
        'export const embedding: boolean = provider.supportsEmbedding();',
        'declare const gateway: LLMGateway;',
        "export const gatewayStructured: Promise<unknown> = gateway.chatStructured({ modelRef: 'openai:gpt-4o', prompt: 'p' });",
        'declare const manager: AiProviderManager;',
        'export const mock: boolean = manager.isMock;',
        'manager._bindDiSync((next: ManagedAiProvider) => { void next; });',
        'declare const transport: LLMTransport;',
        "export const tools = transport.chatWithTools({ model: 'm', messages: [] });",
        'const registry = getModelRegistry();',
        "export const listed = [registry.listByProvider('openai'), registry.listActive(), registry.size];",
        "export const infoMock: ProviderInfo['isMock'] = false;",
        'export const host = [createProvider, PROVIDER_CONFIGS, autoDetectProvider, getAiConfigInfo, getProviderWithFallback];',
        '',
      ].join('\n'),
    });

    const missingExports = diagnostics['__w2a11-removed-exports.probe.ts']
      // 名字与现存导出相近时 TS 会改用 “has no exported member named 'X'. Did you mean …” 的措辞。
      .map((message) => /has no exported member (?:named )?'([^']+)'/.exec(message)?.[1] ?? message)
      .sort();
    expect(missingExports).toEqual(
      [
        'ApiResponse',
        'ApiResponse',
        'FileContentEntry',
        'FileContentEntry',
        'LanguageProfile',
        'LanguageProfile',
        'getLLMGateway',
        'getLLMGateway',
        'resetLLMGateway',
        'resetLLMGateway',
      ].sort()
    );
    expect(diagnostics['__w2a11-removed-members.probe.ts']).toEqual([]);
    expect(diagnostics['__w2a11-negative.probe.ts']).toEqual([
      "Property 'summarizeMaxTokens' does not exist on type 'SummaryBudgetProbe'.",
      "Object literal may only specify known properties, and 'apiKey' does not exist in type 'ManagedAiProvider'.",
    ]);
    expect(diagnostics['__w2a11-retained.probe.ts']).toEqual([]);
  }, 120000);
});
