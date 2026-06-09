import type { ToolResultStatus } from '#tools/core/ToolResultEnvelope.js';
import type { AgentRuntimeBoundaryArea } from './AgentRuntimeBoundary.js';

export type AgentInterfaceContractRowId = 'I02' | 'I16' | 'I17' | 'I18';

export type AgentInterfaceContractBranch =
  | 'success'
  | 'failure'
  | 'cancellation'
  | 'timeout'
  | 'permission-denial'
  | 'partial-result'
  | 'provider-error'
  | 'host-adapter';

export type AgentInterfaceContractErrorKind =
  | 'none'
  | 'invalid-input'
  | 'permission-denied'
  | 'timeout'
  | 'cancelled'
  | 'unavailable'
  | 'internal-error'
  | 'internal-provider-error'
  | 'capability-mismatch'
  | 'not-found';

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
  readonly rows: readonly AgentInterfaceContractRowId[];
  readonly branches: readonly AgentInterfaceContractBranchFixture[];
  readonly alembicConsumerSeams: readonly string[];
}

export const AGENT_INTERFACE_CONTRACT_REQUIRED_BRANCHES = Object.freeze([
  'success',
  'failure',
  'cancellation',
  'timeout',
  'permission-denial',
  'partial-result',
  'provider-error',
  'host-adapter',
] as const satisfies readonly AgentInterfaceContractBranch[]);

export const AGENT_INTERFACE_CONTRACT_REQUIRED_ROWS = Object.freeze([
  'I02',
  'I16',
  'I17',
  'I18',
] as const satisfies readonly AgentInterfaceContractRowId[]);

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

export const ALEMBIC_AGENT_INTERFACE_CONTRACT = Object.freeze({
  contractId: 'alembic-agent-d5-runtime-tools',
  demandKey: 'alembic-interface-contract-d5-agent-runtime-tools-2026-06-09',
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

    if (providerPublicFields.some((field) => hiddenProviderFields.includes(field))) {
      failures.push(`branch ${fixture.branch} exposes hidden provider field`);
    }
    if (observabilityKeys.length === 0) {
      failures.push(`branch ${fixture.branch} has no observability keys`);
    }
    if (evidenceKinds.length === 0) {
      failures.push(`branch ${fixture.branch} has no evidence kind`);
    }
  }

  return failures;
}
