import { describe, expect, it } from 'vitest';

import {
  AGENT_INTERFACE_CONTRACT_REQUIRED_BRANCHES,
  AGENT_INTERFACE_CONTRACT_REQUIRED_ROWS,
  AGENT_INTERFACE_D23_ORDINARY_OUTPUT_POLICY,
  AGENT_INTERFACE_D25_FAILURE_TAXONOMY_POLICY,
  AGENT_INTERFACE_FORBIDDEN_ORDINARY_OUTPUT_FIELDS,
  ALEMBIC_AGENT_INTERFACE_CONTRACT,
  ALEMBIC_AGENT_RUNTIME_BOUNDARY,
  getAgentInterfaceContractBranch,
  getAgentInterfaceFailureTaxonomyEntry,
  supportsAgentRuntimeRoute,
  type ToolResultEnvelope,
  validateAgentInterfaceContract,
} from '../src/index.js';

function createPartialEnvelope(): ToolResultEnvelope<{ completed: number; failed: number }> {
  return {
    ok: true,
    toolId: 'demo.partial',
    callId: 'call-partial',
    startedAt: '2026-06-10T00:00:00.000Z',
    durationMs: 7,
    status: 'partial',
    text: 'Tool produced partial output',
    structuredContent: { completed: 1, failed: 1 },
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [{ code: 'partial-result', message: 'one item failed', stage: 'execute' }],
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
    const envelope = createPartialEnvelope();

    expect(fixture).toMatchObject({
      toolStatus: 'partial',
      ok: true,
      errorKind: 'none',
    });
    expect(envelope.ok).toBe(true);
    expect(envelope.status).toBe('partial');
    expect(envelope.structuredContent).toEqual({ completed: 1, failed: 1 });
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
});
