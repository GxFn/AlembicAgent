import { describe, expect, it } from 'vitest';

import {
  AGENT_INTERFACE_CONTRACT_REQUIRED_BRANCHES,
  AGENT_INTERFACE_CONTRACT_REQUIRED_ROWS,
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

describe('AlembicAgent D5 interface contract', () => {
  it('covers every D1 Agent-owned row and D5 result branch', () => {
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
