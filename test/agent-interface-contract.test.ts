import { describe, expect, it } from 'vitest';

import {
  AGENT_INTERFACE_CONTRACT_REQUIRED_BRANCHES,
  AGENT_INTERFACE_CONTRACT_REQUIRED_ROWS,
  AGENT_INTERFACE_D23_ORDINARY_OUTPUT_POLICY,
  AGENT_INTERFACE_FORBIDDEN_ORDINARY_OUTPUT_FIELDS,
  ALEMBIC_AGENT_INTERFACE_CONTRACT,
  ALEMBIC_AGENT_RUNTIME_BOUNDARY,
  getAgentInterfaceContractBranch,
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

describe('AlembicAgent D10 interface contract rewrite', () => {
  it('covers every D1 Agent-owned row and D10 result branch', () => {
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.rows).toEqual(AGENT_INTERFACE_CONTRACT_REQUIRED_ROWS);
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.branches.map((fixture) => fixture.branch)).toEqual(
      AGENT_INTERFACE_CONTRACT_REQUIRED_BRANCHES
    );
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.activeRewriteDemandKey).toBe(
      'alembic-interface-contract-d10-agent-runtime-legacy-rewrite-2026-06-10'
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

  it('documents D10 legacy rewrite candidates without making old fields ordinary output', () => {
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

    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.legacyRewriteCandidates.map((item) => item.id)).toEqual(
      ['D10-A01', 'D10-A02', 'D10-A03', 'D10-A04']
    );
    for (const candidate of ALEMBIC_AGENT_INTERFACE_CONTRACT.legacyRewriteCandidates) {
      expect(candidate.cleanupTrigger.length).toBeGreaterThan(20);
      expect(candidate.fieldDispositions.length).toBeGreaterThan(0);
      expect(candidate.validationRefs.length).toBeGreaterThan(0);
    }

    const publicDispositions = ALEMBIC_AGENT_INTERFACE_CONTRACT.legacyRewriteCandidates.flatMap(
      (candidate) => candidate.fieldDispositions.filter((rule) => rule.publicSurface)
    );
    expect(publicDispositions.map((rule) => rule.field)).toEqual(
      expect.arrayContaining(['errorClass', 'reasoningContentOmitted'])
    );
    expect(publicDispositions.map((rule) => rule.field)).not.toContain('rawProviderResponse');
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

  it('records Alembic consumer impact notes while leaving consumer edits downstream', () => {
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.alembicConsumerImpactNotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consumer: 'Alembic',
          seam: '@alembic/agent/runtime',
          invalidLegacyShape: expect.stringContaining('success'),
          downstreamAction: expect.stringContaining('D10 does not edit Alembic'),
        }),
        expect.objectContaining({
          consumer: 'Alembic',
          seam: '@alembic/agent/ai',
          invalidLegacyShape: expect.stringContaining('rawProviderResponse'),
        }),
      ])
    );
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
