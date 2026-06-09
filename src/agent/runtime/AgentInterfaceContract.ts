import type { ToolResultStatus } from '#tools/core/ToolResultEnvelope.js';
import type { AgentRuntimeBoundaryArea } from './AgentRuntimeBoundary.js';

export type AgentInterfaceContractRowId = 'I02' | 'I16' | 'I17' | 'I18';

export type AgentInterfaceContractBranch =
  | 'success'
  | 'failure'
  | 'cancellation'
  | 'timeout'
  | 'permission-denial'
  | 'needs-confirmation'
  | 'partial-result'
  | 'provider-error'
  | 'host-failure'
  | 'host-adapter';

export type AgentInterfaceContractErrorKind =
  | 'none'
  | 'invalid-input'
  | 'permission-denied'
  | 'confirmation-required'
  | 'timeout'
  | 'cancelled'
  | 'unavailable'
  | 'host-failure'
  | 'internal-error'
  | 'internal-provider-error'
  | 'capability-mismatch'
  | 'not-found';

export type AgentInterfaceLegacyCandidateId = 'D10-A01' | 'D10-A02' | 'D10-A03' | 'D10-A04';

export type AgentInterfaceFieldDisposition =
  | 'public-contract'
  | 'diagnostic-only'
  | 'provider-private'
  | 'compatibility-private'
  | 'artifact-ref-only'
  | 'preserve-with-cleanup-trigger';

export interface AgentInterfaceFieldDispositionRule {
  readonly field: string;
  readonly disposition: AgentInterfaceFieldDisposition;
  readonly publicSurface: boolean;
  readonly reason: string;
}

export interface AgentInterfaceLegacyRewriteCandidate {
  readonly id: AgentInterfaceLegacyCandidateId;
  readonly oldEntrypoint: string;
  readonly currentCompatibilityOwner: string;
  readonly replacementContract: string;
  readonly fieldDispositions: readonly AgentInterfaceFieldDispositionRule[];
  readonly validationRefs: readonly string[];
  readonly cleanupTrigger: string;
}

export interface AgentInterfaceConsumerImpactNote {
  readonly consumer: 'Alembic';
  readonly seam: string;
  readonly expects: string;
  readonly invalidLegacyShape: string;
  readonly agentEvidence: string;
  readonly downstreamAction: string;
}

export interface AgentInterfaceContractBranchFixture {
  readonly branch: AgentInterfaceContractBranch;
  readonly title: string;
  readonly registryRows: readonly AgentInterfaceContractRowId[];
  readonly boundaryArea: AgentRuntimeBoundaryArea;
  readonly toolStatus: ToolResultStatus | null;
  readonly ok: boolean;
  readonly errorKind: AgentInterfaceContractErrorKind;
  readonly providerPublicFields: readonly string[];
  readonly hiddenProviderFields: readonly string[];
  readonly hostAdapterPath: string | null;
  readonly evidenceKinds: readonly string[];
  readonly observabilityKeys: readonly string[];
}

export interface AgentInterfaceContractManifest {
  readonly contractId: 'alembic-agent-d5-runtime-tools';
  readonly demandKey: 'alembic-interface-contract-d5-agent-runtime-tools-2026-06-09';
  readonly activeRewriteDemandKey: 'alembic-interface-contract-d10-agent-runtime-legacy-rewrite-2026-06-10';
  readonly rows: readonly AgentInterfaceContractRowId[];
  readonly branches: readonly AgentInterfaceContractBranchFixture[];
  readonly alembicConsumerSeams: readonly string[];
  readonly forbiddenOrdinaryOutputFields: readonly string[];
  readonly legacyRewriteCandidates: readonly AgentInterfaceLegacyRewriteCandidate[];
  readonly alembicConsumerImpactNotes: readonly AgentInterfaceConsumerImpactNote[];
}

export const AGENT_INTERFACE_CONTRACT_REQUIRED_BRANCHES = Object.freeze([
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
] as const satisfies readonly AgentInterfaceContractBranch[]);

export const AGENT_INTERFACE_CONTRACT_REQUIRED_ROWS = Object.freeze([
  'I02',
  'I16',
  'I17',
  'I18',
] as const satisfies readonly AgentInterfaceContractRowId[]);

export const AGENT_INTERFACE_FORBIDDEN_ORDINARY_OUTPUT_FIELDS = Object.freeze([
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
] as const satisfies readonly string[]);

const BRANCH_FIXTURES = [
  {
    branch: 'success',
    title: 'Tool execution succeeds with public structured content.',
    registryRows: ['I16'],
    boundaryArea: 'tool-execution',
    toolStatus: 'success',
    ok: true,
    errorKind: 'none',
    providerPublicFields: ['text', 'functionCalls', 'usage', 'finishReason'],
    hiddenProviderFields: ['apiKey', 'rawProviderResponse', 'hiddenReasoning'],
    hostAdapterPath: null,
    evidenceKinds: ['tool-router-test', 'result-envelope-fixture'],
    observabilityKeys: ['toolId', 'callId', 'durationMs', 'status'],
  },
  {
    branch: 'failure',
    title: 'Tool adapter exceptions normalize to an error envelope.',
    registryRows: ['I16'],
    boundaryArea: 'tool-execution',
    toolStatus: 'error',
    ok: false,
    errorKind: 'internal-error',
    providerPublicFields: [],
    hiddenProviderFields: ['stack', 'rawProviderResponse'],
    hostAdapterPath: null,
    evidenceKinds: ['tool-router-test', 'result-envelope-fixture'],
    observabilityKeys: ['toolId', 'callId', 'durationMs', 'status'],
  },
  {
    branch: 'cancellation',
    title: 'AbortController cancellation returns an aborted envelope without retry.',
    registryRows: ['I16', 'I17'],
    boundaryArea: 'tool-execution',
    toolStatus: 'aborted',
    ok: false,
    errorKind: 'cancelled',
    providerPublicFields: ['abortReason'],
    hiddenProviderFields: ['apiKey', 'rawProviderResponse'],
    hostAdapterPath: null,
    evidenceKinds: ['tool-router-test', 'provider-mock-test'],
    observabilityKeys: ['toolId', 'callId', 'status', 'abortReason'],
  },
  {
    branch: 'timeout',
    title: 'Tool and provider timeouts remain a distinct timeout branch.',
    registryRows: ['I16', 'I17'],
    boundaryArea: 'tool-execution',
    toolStatus: 'timeout',
    ok: false,
    errorKind: 'timeout',
    providerPublicFields: ['provider', 'model', 'usageSource'],
    hiddenProviderFields: ['apiKey', 'rawProviderResponse'],
    hostAdapterPath: null,
    evidenceKinds: ['tool-router-test', 'provider-mock-test'],
    observabilityKeys: ['toolId', 'callId', 'durationMs', 'status'],
  },
  {
    branch: 'permission-denial',
    title: 'Runtime policy or host approval denial maps to blocked output.',
    registryRows: ['I16', 'I18'],
    boundaryArea: 'tool-execution',
    toolStatus: 'blocked',
    ok: false,
    errorKind: 'permission-denied',
    providerPublicFields: [],
    hiddenProviderFields: ['gatewayData', 'rawPolicyContext'],
    hostAdapterPath: 'approval-ui-denied',
    evidenceKinds: ['tool-router-test', 'host-adapter-fixture'],
    observabilityKeys: ['toolId', 'callId', 'status', 'failureReason'],
  },
  {
    branch: 'needs-confirmation',
    title: 'Runtime policy can request host confirmation without reporting a denial.',
    registryRows: ['I16', 'I18'],
    boundaryArea: 'tool-execution',
    toolStatus: 'needs-confirmation',
    ok: false,
    errorKind: 'confirmation-required',
    providerPublicFields: ['confirmationMessage', 'requestId'],
    hiddenProviderFields: ['rawPolicyContext', 'hostCredential', 'threadId'],
    hostAdapterPath: 'approval-ui-required',
    evidenceKinds: ['tool-router-test', 'host-adapter-fixture'],
    observabilityKeys: ['toolId', 'callId', 'status', 'approvalStage'],
  },
  {
    branch: 'partial-result',
    title: 'Partial tool output stays reachable as a first-class result branch.',
    registryRows: ['I16'],
    boundaryArea: 'tool-execution',
    toolStatus: 'partial',
    ok: true,
    errorKind: 'none',
    providerPublicFields: ['text', 'structuredContent', 'artifacts'],
    hiddenProviderFields: ['rawProviderResponse', 'hiddenReasoning'],
    hostAdapterPath: null,
    evidenceKinds: ['result-envelope-fixture', 'tool-router-test'],
    observabilityKeys: ['toolId', 'callId', 'durationMs', 'status'],
  },
  {
    branch: 'provider-error',
    title: 'Provider errors expose stable classification, not provider internals.',
    registryRows: ['I17'],
    boundaryArea: 'ai-provider',
    toolStatus: 'error',
    ok: false,
    errorKind: 'internal-provider-error',
    providerPublicFields: ['provider', 'model', 'usageSource', 'errorClass'],
    hiddenProviderFields: [
      'apiKey',
      'rawProviderRequest',
      'rawProviderResponse',
      'hiddenReasoning',
    ],
    hostAdapterPath: null,
    evidenceKinds: ['provider-mock-test', 'gateway-test'],
    observabilityKeys: ['provider', 'model', 'usageSource', 'errorClass'],
  },
  {
    branch: 'host-failure',
    title: 'Host adapter failures remain distinct from provider and policy branches.',
    registryRows: ['I02', 'I18'],
    boundaryArea: 'host-agent-route',
    toolStatus: 'error',
    ok: false,
    errorKind: 'host-failure',
    providerPublicFields: ['hostAction', 'errorClass'],
    hiddenProviderFields: ['threadId', 'hostCredential', 'rawHostError'],
    hostAdapterPath: 'host-adapter-exception',
    evidenceKinds: ['runtime-boundary-fixture', 'host-adapter-fixture'],
    observabilityKeys: ['area', 'owner', 'status', 'failureStage'],
  },
  {
    branch: 'host-adapter',
    title: 'Host adapter ownership is explicit and Plugin host-agent routes are unsupported here.',
    registryRows: ['I02', 'I18'],
    boundaryArea: 'host-agent-route',
    toolStatus: null,
    ok: false,
    errorKind: 'capability-mismatch',
    providerPublicFields: [],
    hiddenProviderFields: ['threadId', 'apiKey', 'hostCredential'],
    hostAdapterPath: 'alembic-api-ai',
    evidenceKinds: ['runtime-boundary-fixture', 'public-import-smoke'],
    observabilityKeys: ['area', 'owner', 'packageSubpath', 'unsupportedRoute'],
  },
] as const satisfies readonly AgentInterfaceContractBranchFixture[];

const LEGACY_REWRITE_CANDIDATES = [
  {
    id: 'D10-A01',
    oldEntrypoint: 'AiProvider.ApiResponse raw provider response bag',
    currentCompatibilityOwner: 'provider-private adapters and transports',
    replacementContract:
      'Provider public output exposes text, functionCalls, usage, finishReason, provider/model usageSource, and stable errorClass only.',
    fieldDispositions: [
      {
        field: 'rawProviderRequest',
        disposition: 'provider-private',
        publicSurface: false,
        reason: 'Request payloads may contain credentials, prompts, or provider-private options.',
      },
      {
        field: 'rawProviderResponse',
        disposition: 'provider-private',
        publicSurface: false,
        reason: 'Provider payloads stay behind adapter boundaries and are never ordinary output.',
      },
      {
        field: 'errorClass',
        disposition: 'public-contract',
        publicSurface: true,
        reason: 'Consumers need stable failure classification without provider internals.',
      },
    ],
    validationRefs: ['test/agent-interface-contract.test.ts', 'test/ai-provider.test.ts'],
    cleanupTrigger:
      'Delete raw-bag propagation only after provider adapters no longer require private transport payload retention.',
  },
  {
    id: 'D10-A02',
    oldEntrypoint: 'DeepSeek text <function_calls> compatibility parser',
    currentCompatibilityOwner: 'DeepSeek provider compatibility branch',
    replacementContract:
      'Native tool calls and compat text tool calls remain distinguishable by call id prefix and allowed-tool filtering.',
    fieldDispositions: [
      {
        field: 'call_deepseek_compat_*',
        disposition: 'compatibility-private',
        publicSurface: false,
        reason:
          'Compat call ids identify parser-originated calls and must not be reported as native support.',
      },
      {
        field: '<function_calls>',
        disposition: 'compatibility-private',
        publicSurface: false,
        reason: 'Provider text markup is a compatibility input, not ordinary result output.',
      },
    ],
    validationRefs: ['test/DeepSeekTransport.test.ts', 'test/DeepSeekProvider.test.ts'],
    cleanupTrigger:
      'Remove when DeepSeek no longer emits supported text tool-call markup for current Agent transports.',
  },
  {
    id: 'D10-A03',
    oldEntrypoint: 'UnifiedToolCatalog compatibility stores',
    currentCompatibilityOwner: 'Agent runtime tool discovery and internal handler execution',
    replacementContract:
      'Public ToolCapabilityManifest discovery is first-class; handler stores remain internal compatibility routes with current consumers.',
    fieldDispositions: [
      {
        field: 'InternalToolHandlerStore',
        disposition: 'preserve-with-cleanup-trigger',
        publicSurface: false,
        reason: 'Runtime handler lookup still consumes this internal store shape.',
      },
      {
        field: 'ForgedInternalToolStore',
        disposition: 'preserve-with-cleanup-trigger',
        publicSurface: false,
        reason: 'Temporary tool forge still needs an internal projection route.',
      },
    ],
    validationRefs: ['test/tool-system.test.ts', 'test/contract-surface.test.ts'],
    cleanupTrigger:
      'Delete only after runtime tool discovery and forged-tool execution use a replacement public manifest route.',
  },
  {
    id: 'D10-A04',
    oldEntrypoint: 'Hidden reasoning round-trip fields',
    currentCompatibilityOwner: 'DeepSeek transport round-trip and runtime diagnostic metadata',
    replacementContract:
      'Hidden reasoning is retained only for provider round-trip or diagnostic counts; public output exposes omission metadata, not raw reasoning.',
    fieldDispositions: [
      {
        field: 'reasoningContent',
        disposition: 'provider-private',
        publicSurface: false,
        reason:
          'Reasoning content may be required for provider round-trip but must not enter public output text.',
      },
      {
        field: 'reasoning_content',
        disposition: 'provider-private',
        publicSurface: false,
        reason: 'Provider-native reasoning field is transport-private.',
      },
      {
        field: 'reasoningContentOmitted',
        disposition: 'diagnostic-only',
        publicSurface: true,
        reason: 'Consumers can observe omission without receiving hidden reasoning text.',
      },
    ],
    validationRefs: ['test/AgentRuntime.test.ts', 'test/DeepSeekTransport.test.ts'],
    cleanupTrigger:
      'Preserve provider round-trip fields while DeepSeek V4 requires them for complete tool-call rounds.',
  },
] as const satisfies readonly AgentInterfaceLegacyRewriteCandidate[];

const ALEMBIC_CONSUMER_IMPACT_NOTES = [
  {
    consumer: 'Alembic',
    seam: '@alembic/agent/runtime',
    expects:
      'ToolResultEnvelope.status distinguishes success, partial, error, blocked, aborted, timeout, and needs-confirmation.',
    invalidLegacyShape: '{ success, errorCode, message, data: { result } }',
    agentEvidence:
      'AGENT_INTERFACE_CONTRACT_REQUIRED_BRANCHES and tool-system tests cover non-success envelopes without collapsing them into generic errors.',
    downstreamAction:
      'D11/D14 may replay Alembic provider consumers against these statuses; D10 does not edit Alembic consumer code.',
  },
  {
    consumer: 'Alembic',
    seam: '@alembic/agent/ai',
    expects:
      'Provider outputs expose public fields and stable errorClass while private payloads remain adapter-local.',
    invalidLegacyShape: '{ rawProviderResponse, reasoningContent, apiKey }',
    agentEvidence:
      'D10 legacy rewrite candidates classify raw provider bags and hidden reasoning as private or diagnostic-only.',
    downstreamAction:
      'Alembic-side provider route cleanup remains downstream and must prove no consumer still expects legacy raw fields.',
  },
] as const satisfies readonly AgentInterfaceConsumerImpactNote[];

export const ALEMBIC_AGENT_INTERFACE_CONTRACT = Object.freeze({
  contractId: 'alembic-agent-d5-runtime-tools',
  demandKey: 'alembic-interface-contract-d5-agent-runtime-tools-2026-06-09',
  activeRewriteDemandKey: 'alembic-interface-contract-d10-agent-runtime-legacy-rewrite-2026-06-10',
  rows: AGENT_INTERFACE_CONTRACT_REQUIRED_ROWS,
  branches: BRANCH_FIXTURES,
  alembicConsumerSeams: [
    '@alembic/agent',
    '@alembic/agent/runtime',
    '@alembic/agent/ai',
    '@alembic/agent/tools',
    '@alembic/agent/tools/v2',
    '@alembic/agent/tools/terminal',
  ],
  forbiddenOrdinaryOutputFields: AGENT_INTERFACE_FORBIDDEN_ORDINARY_OUTPUT_FIELDS,
  legacyRewriteCandidates: LEGACY_REWRITE_CANDIDATES,
  alembicConsumerImpactNotes: ALEMBIC_CONSUMER_IMPACT_NOTES,
}) satisfies AgentInterfaceContractManifest;

export function getAgentInterfaceContractBranch(
  branch: AgentInterfaceContractBranch
): AgentInterfaceContractBranchFixture | null {
  return ALEMBIC_AGENT_INTERFACE_CONTRACT.branches.find((item) => item.branch === branch) ?? null;
}

export function validateAgentInterfaceContract(): string[] {
  const failures: string[] = [];
  const branchSet = new Set(ALEMBIC_AGENT_INTERFACE_CONTRACT.branches.map((item) => item.branch));
  const rowSet = new Set(ALEMBIC_AGENT_INTERFACE_CONTRACT.rows);

  for (const branch of AGENT_INTERFACE_CONTRACT_REQUIRED_BRANCHES) {
    if (!branchSet.has(branch)) {
      failures.push(`missing required branch: ${branch}`);
    }
  }

  for (const row of AGENT_INTERFACE_CONTRACT_REQUIRED_ROWS) {
    if (!rowSet.has(row)) {
      failures.push(`missing required D1 row: ${row}`);
    }
  }

  for (const fixture of ALEMBIC_AGENT_INTERFACE_CONTRACT.branches) {
    const providerPublicFields: readonly string[] = fixture.providerPublicFields;
    const hiddenProviderFields: readonly string[] = fixture.hiddenProviderFields;
    const observabilityKeys: readonly string[] = fixture.observabilityKeys;
    const evidenceKinds: readonly string[] = fixture.evidenceKinds;
    const forbiddenOrdinaryOutputFields: readonly string[] =
      ALEMBIC_AGENT_INTERFACE_CONTRACT.forbiddenOrdinaryOutputFields;
    const publicFixtureFields = [...providerPublicFields, ...observabilityKeys];

    if (providerPublicFields.some((field) => hiddenProviderFields.includes(field))) {
      failures.push(`branch ${fixture.branch} exposes hidden provider field`);
    }
    if (publicFixtureFields.some((field) => forbiddenOrdinaryOutputFields.includes(field))) {
      failures.push(`branch ${fixture.branch} exposes a forbidden ordinary output field`);
    }
    if (fixture.branch === 'needs-confirmation' && fixture.toolStatus !== 'needs-confirmation') {
      failures.push('needs-confirmation branch must use the needs-confirmation tool status');
    }
    if (fixture.branch === 'host-failure' && fixture.errorKind !== 'host-failure') {
      failures.push('host-failure branch must keep a distinct host-failure error kind');
    }
    if (observabilityKeys.length === 0) {
      failures.push(`branch ${fixture.branch} has no observability keys`);
    }
    if (evidenceKinds.length === 0) {
      failures.push(`branch ${fixture.branch} has no evidence kind`);
    }
  }

  for (const candidate of ALEMBIC_AGENT_INTERFACE_CONTRACT.legacyRewriteCandidates) {
    const fieldDispositions: readonly AgentInterfaceFieldDispositionRule[] =
      candidate.fieldDispositions;
    const validationRefs: readonly string[] = candidate.validationRefs;

    if (fieldDispositions.length === 0) {
      failures.push(`legacy candidate ${candidate.id} has no field dispositions`);
    }
    if (validationRefs.length === 0) {
      failures.push(`legacy candidate ${candidate.id} has no validation refs`);
    }
    if (candidate.cleanupTrigger.trim().length === 0) {
      failures.push(`legacy candidate ${candidate.id} has no cleanup trigger`);
    }
  }

  for (const note of ALEMBIC_AGENT_INTERFACE_CONTRACT.alembicConsumerImpactNotes) {
    if (!ALEMBIC_AGENT_INTERFACE_CONTRACT.alembicConsumerSeams.includes(note.seam)) {
      failures.push(`Alembic consumer impact note references unknown seam: ${note.seam}`);
    }
  }

  return failures;
}
