import {
  CORE_D25_REQUIRED_FAILURE_KINDS,
  CORE_FAILURE_TAXONOMY,
  CORE_FAILURE_TAXONOMY_VERSION,
  type CoreFailureTaxonomyEntry,
  type CoreFieldFailureKind,
} from '@alembic/core/shared';
import {
  TOOL_RESULT_FORBIDDEN_ORDINARY_OUTPUT_FIELDS,
  type ToolResultDiagnosticSummary,
  type ToolResultFailureTaxonomy,
  type ToolResultStatus,
} from '#tools/runtime/ToolRuntimeBridge.js';
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

export type AgentInterfaceContractFailureKind = CoreFieldFailureKind | 'none';

export interface AgentInterfaceOrdinaryOutputPolicy {
  readonly demandKey: 'alembic-interface-contract-d23-agent-result-diagnostic-content-cleanup-2026-06-10';
  readonly forbiddenFields: readonly string[];
  readonly diagnosticSummaryKeys: readonly (keyof ToolResultDiagnosticSummary)[];
  readonly refFields: readonly string[];
}

export interface AgentInterfaceFailureTaxonomyEntry extends ToolResultFailureTaxonomy {
  readonly dashboardState: CoreFieldFailureKind;
  readonly detailExposureClass: string;
  readonly httpStatus: number;
  readonly mcpErrorCode: `core.failure.${CoreFieldFailureKind}`;
  readonly mcpStatus: CoreFieldFailureKind;
  readonly publicMessage: string;
  readonly toolStatus: ToolResultStatus | null;
}

export interface AgentInterfaceFailureTaxonomyPolicy {
  readonly demandKey: 'alembic-interface-contract-d25-error-problem-taxonomy-2026-06-10';
  readonly coreTaxonomyVersion: typeof CORE_FAILURE_TAXONOMY_VERSION;
  readonly requiredFailureKinds: readonly CoreFieldFailureKind[];
  readonly ordinaryOutputField: 'failureTaxonomy';
  readonly entries: readonly AgentInterfaceFailureTaxonomyEntry[];
  readonly privateDataSafe: true;
  readonly upstreamEvidence: readonly string[];
}

export interface AgentInterfaceContractBranchFixture {
  readonly branch: AgentInterfaceContractBranch;
  readonly title: string;
  readonly registryRows: readonly AgentInterfaceContractRowId[];
  readonly boundaryArea: AgentRuntimeBoundaryArea;
  readonly toolStatus: ToolResultStatus | null;
  readonly ok: boolean;
  readonly errorKind: AgentInterfaceContractErrorKind;
  readonly failureKind: AgentInterfaceContractFailureKind;
  readonly failureTaxonomy: ToolResultFailureTaxonomy | null;
  readonly providerPublicFields: readonly string[];
  readonly hiddenProviderFields: readonly string[];
  readonly hostAdapterPath: string | null;
  readonly evidenceKinds: readonly string[];
  readonly observabilityKeys: readonly string[];
}

export interface AgentInterfaceContractManifest {
  readonly contractId: 'alembic-agent-d5-runtime-tools';
  readonly demandKey: 'alembic-interface-contract-d5-agent-runtime-tools-2026-06-09';
  readonly rows: readonly AgentInterfaceContractRowId[];
  readonly branches: readonly AgentInterfaceContractBranchFixture[];
  readonly alembicConsumerSeams: readonly string[];
  readonly forbiddenOrdinaryOutputFields: readonly string[];
  readonly ordinaryOutputPolicy: AgentInterfaceOrdinaryOutputPolicy;
  readonly failureTaxonomyPolicy: AgentInterfaceFailureTaxonomyPolicy;
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

export const AGENT_INTERFACE_FORBIDDEN_ORDINARY_OUTPUT_FIELDS =
  TOOL_RESULT_FORBIDDEN_ORDINARY_OUTPUT_FIELDS;

export const AGENT_INTERFACE_D23_ORDINARY_OUTPUT_POLICY = Object.freeze({
  demandKey: 'alembic-interface-contract-d23-agent-result-diagnostic-content-cleanup-2026-06-10',
  forbiddenFields: AGENT_INTERFACE_FORBIDDEN_ORDINARY_OUTPUT_FIELDS,
  diagnosticSummaryKeys: [
    'degraded',
    'fallbackUsed',
    'warningCount',
    'warningCodes',
    'timedOutStages',
    'blockedToolCount',
    'blockedToolIds',
    'gateFailureCount',
    'gateFailureStages',
    'aiErrorCount',
    'truncatedToolCalls',
    'emptyResponses',
    'toolCallCount',
    'redactedFieldCount',
    'redactedFields',
  ],
  refFields: ['artifacts', 'resources'],
} as const satisfies AgentInterfaceOrdinaryOutputPolicy);

export const AGENT_INTERFACE_D25_FAILURE_TAXONOMY_POLICY = Object.freeze({
  demandKey: 'alembic-interface-contract-d25-error-problem-taxonomy-2026-06-10',
  coreTaxonomyVersion: CORE_FAILURE_TAXONOMY_VERSION,
  requiredFailureKinds: CORE_D25_REQUIRED_FAILURE_KINDS,
  ordinaryOutputField: 'failureTaxonomy',
  entries: CORE_FAILURE_TAXONOMY.map(projectAgentFailureTaxonomyEntry),
  privateDataSafe: true,
  upstreamEvidence: [
    'AlembicCore commit 8d8000c8c82bec2986e424fd494cfd15171fdafc',
    'Alembic commit 6bfb5ffe94d45ded7a76d8c82a82ecd7db518599',
    'AlembicPlugin commit d999f33c0476a004ec8fdcc3b2842f7ea3ec615f',
  ],
} as const satisfies AgentInterfaceFailureTaxonomyPolicy);

const BRANCH_FIXTURES = [
  {
    branch: 'success',
    title: 'Tool execution succeeds with public structured content.',
    registryRows: ['I16'],
    boundaryArea: 'tool-execution',
    toolStatus: 'success',
    ok: true,
    errorKind: 'none',
    failureKind: 'none',
    failureTaxonomy: null,
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
    failureKind: 'internal-error',
    failureTaxonomy: projectAgentToolFailureTaxonomy('internal-error'),
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
    failureKind: 'cancelled',
    failureTaxonomy: projectAgentToolFailureTaxonomy('cancelled'),
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
    failureKind: 'timeout',
    failureTaxonomy: projectAgentToolFailureTaxonomy('timeout'),
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
    failureKind: 'permission-denied',
    failureTaxonomy: projectAgentToolFailureTaxonomy('permission-denied'),
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
    failureKind: 'needs-confirmation',
    failureTaxonomy: projectAgentToolFailureTaxonomy('needs-confirmation'),
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
    failureKind: 'partial',
    failureTaxonomy: projectAgentToolFailureTaxonomy('partial'),
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
    failureKind: 'provider-error',
    failureTaxonomy: projectAgentToolFailureTaxonomy('provider-error'),
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
    failureKind: 'host-failure',
    failureTaxonomy: projectAgentToolFailureTaxonomy('host-failure'),
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
    failureKind: 'capability-mismatch',
    failureTaxonomy: projectAgentToolFailureTaxonomy('capability-mismatch'),
    providerPublicFields: [],
    hiddenProviderFields: ['threadId', 'apiKey', 'hostCredential'],
    hostAdapterPath: 'alembic-api-ai',
    evidenceKinds: ['runtime-boundary-fixture', 'public-import-smoke'],
    observabilityKeys: ['area', 'owner', 'packageSubpath', 'unsupportedRoute'],
  },
] as const satisfies readonly AgentInterfaceContractBranchFixture[];

export const ALEMBIC_AGENT_INTERFACE_CONTRACT = Object.freeze({
  contractId: 'alembic-agent-d5-runtime-tools',
  demandKey: 'alembic-interface-contract-d5-agent-runtime-tools-2026-06-09',
  rows: AGENT_INTERFACE_CONTRACT_REQUIRED_ROWS,
  branches: BRANCH_FIXTURES,
  alembicConsumerSeams: [
    '@alembic/agent',
    '@alembic/agent/runtime',
    '@alembic/agent/ai',
    '@alembic/agent/tools/v2',
    '@alembic/agent/tools/terminal',
  ],
  forbiddenOrdinaryOutputFields: AGENT_INTERFACE_FORBIDDEN_ORDINARY_OUTPUT_FIELDS,
  ordinaryOutputPolicy: AGENT_INTERFACE_D23_ORDINARY_OUTPUT_POLICY,
  failureTaxonomyPolicy: AGENT_INTERFACE_D25_FAILURE_TAXONOMY_POLICY,
}) satisfies AgentInterfaceContractManifest;

export function getAgentInterfaceFailureTaxonomyEntry(
  kind: CoreFieldFailureKind
): AgentInterfaceFailureTaxonomyEntry | null {
  return (
    ALEMBIC_AGENT_INTERFACE_CONTRACT.failureTaxonomyPolicy.entries.find(
      (entry) => entry.kind === kind
    ) ?? null
  );
}

export function getAgentInterfaceContractBranch(
  branch: AgentInterfaceContractBranch
): AgentInterfaceContractBranchFixture | null {
  return ALEMBIC_AGENT_INTERFACE_CONTRACT.branches.find((item) => item.branch === branch) ?? null;
}

export function validateAgentInterfaceContract(): string[] {
  const failures: string[] = [];
  validateRequiredCoverage(failures);
  validateBranchFixtures(failures);
  validateOrdinaryOutputPolicy(failures);
  validateFailureTaxonomyPolicy(failures);
  return failures;
}

function projectAgentFailureTaxonomyEntry(
  entry: CoreFailureTaxonomyEntry
): AgentInterfaceFailureTaxonomyEntry {
  return {
    ...projectAgentToolFailureTaxonomy(entry.kind),
    dashboardState: entry.dashboardState,
    detailExposureClass: entry.detailExposureClass,
    httpStatus: entry.httpStatus,
    mcpErrorCode: entry.mcpErrorCode,
    mcpStatus: entry.mcpStatus,
    publicMessage: entry.publicMessage,
    toolStatus: toolStatusForCoreFailure(entry),
  };
}

function projectAgentToolFailureTaxonomy(kind: CoreFieldFailureKind): ToolResultFailureTaxonomy {
  const entry = CORE_FAILURE_TAXONOMY.find((candidate) => candidate.kind === kind);
  if (!entry) {
    throw new Error(`Missing Core failure taxonomy entry for ${kind}.`);
  }
  return {
    agentBranch: entry.agentBranch,
    kind: entry.kind,
    privateDataSafe: entry.privateDataSafe,
    problemClass: entry.problemClass,
    refPolicy: entry.refPolicy,
    retryPolicy: entry.retryPolicy,
    retryable: entry.retryable,
    stableId: entry.stableId,
    status: entry.status,
  };
}

function toolStatusForCoreFailure(entry: CoreFailureTaxonomyEntry): ToolResultStatus {
  if (entry.status === 'partial') {
    return 'partial';
  }
  if (entry.status === 'cancelled') {
    return 'aborted';
  }
  if (entry.status === 'needs-confirmation') {
    return 'needs-confirmation';
  }
  if (entry.kind === 'timeout') {
    return 'timeout';
  }
  if (entry.status === 'blocked') {
    return 'blocked';
  }
  return 'error';
}

function validateRequiredCoverage(failures: string[]): void {
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
}

function validateBranchFixtures(failures: string[]): void {
  for (const fixture of ALEMBIC_AGENT_INTERFACE_CONTRACT.branches) {
    const fixtureBranch = fixture.branch;
    const providerPublicFields: readonly string[] = fixture.providerPublicFields;
    const hiddenProviderFields: readonly string[] = fixture.hiddenProviderFields;
    const observabilityKeys: readonly string[] = fixture.observabilityKeys;
    const evidenceKinds: readonly string[] = fixture.evidenceKinds;
    const forbiddenOrdinaryOutputFields: readonly string[] =
      ALEMBIC_AGENT_INTERFACE_CONTRACT.forbiddenOrdinaryOutputFields;
    const publicFixtureFields = [...providerPublicFields, ...observabilityKeys];

    if (providerPublicFields.some((field) => hiddenProviderFields.includes(field))) {
      failures.push(`branch ${fixtureBranch} exposes hidden provider field`);
    }
    if (publicFixtureFields.some((field) => forbiddenOrdinaryOutputFields.includes(field))) {
      failures.push(`branch ${fixtureBranch} exposes a forbidden ordinary output field`);
    }
    if (fixture.branch === 'needs-confirmation' && fixture.toolStatus !== 'needs-confirmation') {
      failures.push('needs-confirmation branch must use the needs-confirmation tool status');
    }
    if (fixture.branch === 'host-failure' && fixture.errorKind !== 'host-failure') {
      failures.push('host-failure branch must keep a distinct host-failure error kind');
    }
    if (fixture.failureKind === 'none' && fixture.failureTaxonomy !== null) {
      failures.push(`branch ${fixtureBranch} must not attach taxonomy to success`);
    } else if (fixture.failureKind !== 'none') {
      if (fixture.failureTaxonomy?.stableId !== `core.failure.${fixture.failureKind}`) {
        failures.push(`branch ${fixtureBranch} must attach matching Core failure taxonomy`);
      }
      if (fixture.failureTaxonomy?.privateDataSafe !== true) {
        failures.push(`branch ${fixtureBranch} failure taxonomy must be private-data safe`);
      }
    }
    if (observabilityKeys.length === 0) {
      failures.push(`branch ${fixtureBranch} has no observability keys`);
    }
    if (evidenceKinds.length === 0) {
      failures.push(`branch ${fixtureBranch} has no evidence kind`);
    }
  }
}

function validateFailureTaxonomyPolicy(failures: string[]): void {
  const policy = ALEMBIC_AGENT_INTERFACE_CONTRACT.failureTaxonomyPolicy;
  if (policy.coreTaxonomyVersion !== CORE_FAILURE_TAXONOMY_VERSION) {
    failures.push('D25 failure taxonomy policy must preserve the Core taxonomy version');
  }
  if (policy.ordinaryOutputField !== 'failureTaxonomy') {
    failures.push('D25 failure taxonomy policy must name the ordinary output taxonomy field');
  }

  const entryKinds = new Set(policy.entries.map((entry) => entry.kind));
  for (const kind of CORE_D25_REQUIRED_FAILURE_KINDS) {
    if (!entryKinds.has(kind)) {
      failures.push(`D25 failure taxonomy policy is missing ${kind}`);
    }
  }

  for (const entry of policy.entries) {
    if (entry.stableId !== `core.failure.${entry.kind}`) {
      failures.push(`D25 failure taxonomy entry ${entry.kind} has unstable id`);
    }
    if (entry.privateDataSafe !== true) {
      failures.push(`D25 failure taxonomy entry ${entry.kind} is not private-data safe`);
    }
    if (entry.toolStatus === null) {
      failures.push(`D25 failure taxonomy entry ${entry.kind} has no tool status projection`);
    }
  }
}

function validateOrdinaryOutputPolicy(failures: string[]): void {
  if (
    ALEMBIC_AGENT_INTERFACE_CONTRACT.ordinaryOutputPolicy.forbiddenFields !==
    ALEMBIC_AGENT_INTERFACE_CONTRACT.forbiddenOrdinaryOutputFields
  ) {
    failures.push('ordinary output policy must use the contract forbidden field list');
  }
  const diagnosticSummaryKeys: readonly (keyof ToolResultDiagnosticSummary)[] =
    ALEMBIC_AGENT_INTERFACE_CONTRACT.ordinaryOutputPolicy.diagnosticSummaryKeys;
  if (diagnosticSummaryKeys.length === 0) {
    failures.push('ordinary output policy must name diagnostic summary keys');
  }
  if (
    !ALEMBIC_AGENT_INTERFACE_CONTRACT.ordinaryOutputPolicy.refFields.includes('artifacts') ||
    !ALEMBIC_AGENT_INTERFACE_CONTRACT.ordinaryOutputPolicy.refFields.includes('resources')
  ) {
    failures.push('ordinary output policy must preserve artifact and resource refs');
  }
}
