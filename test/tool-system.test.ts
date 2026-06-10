import { describe, expect, it } from 'vitest';

import {
  ALEMBIC_AGENT_INTERFACE_CONTRACT,
  CapabilityCatalog,
  isToolResultEnvelope,
  LightweightRouter,
  presentToolResult,
  projectToolResultOrdinaryOutput,
  TOOL_RESULT_FORBIDDEN_ORDINARY_OUTPUT_FIELDS,
  type ToolCallRequest,
  type ToolCapabilityManifest,
  type ToolDefinitionV2,
  type ToolExecutionAdapter,
  type ToolExecutionRequest,
  type ToolResultEnvelope,
  UnifiedToolCatalog,
} from '../src/index.js';

function createManifest(overrides: Partial<ToolCapabilityManifest> = {}): ToolCapabilityManifest {
  const manifest: ToolCapabilityManifest = {
    id: 'demo.echo',
    title: 'Demo Echo',
    kind: 'internal-tool',
    description: 'Echo test input',
    owner: 'agent',
    lifecycle: 'active',
    surfaces: ['runtime'],
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
    },
    risk: {
      sideEffect: false,
      dataAccess: 'none',
      writeScope: 'none',
      network: 'none',
      credentialAccess: 'none',
      requiresHumanConfirmation: 'never',
      owaspTags: [],
    },
    execution: {
      adapter: 'internal',
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      abortMode: 'cooperative',
      cachePolicy: 'none',
      concurrency: 'parallel-safe',
      artifactMode: 'inline',
    },
    governance: {
      policyProfile: 'read',
      auditLevel: 'checkOnly',
      approvalPolicy: 'auto',
      allowedRoles: ['developer'],
      allowInComposer: true,
      allowInRemoteMcp: false,
      allowInNonInteractive: true,
    },
    evals: {
      required: false,
      cases: [],
    },
  };

  return {
    ...manifest,
    ...overrides,
    risk: { ...manifest.risk, ...overrides.risk },
    execution: { ...manifest.execution, ...overrides.execution },
    governance: { ...manifest.governance, ...overrides.governance },
    evals: { ...manifest.evals, ...overrides.evals },
  };
}

function createRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    toolId: 'demo.echo',
    args: { value: 'hello' },
    surface: 'runtime',
    actor: { role: 'developer', user: 'tester' },
    source: { kind: 'runtime', name: 'unit-test' },
    ...overrides,
  };
}

function createSuccessEnvelope(
  request: ToolExecutionRequest,
  text = 'echo complete'
): ToolResultEnvelope<{ echo: unknown }> {
  return {
    ok: true,
    toolId: request.manifest.id,
    callId: request.context.callId,
    ...(request.context.parentCallId ? { parentCallId: request.context.parentCallId } : {}),
    startedAt: new Date().toISOString(),
    durationMs: 1,
    status: 'success',
    text,
    structuredContent: { echo: request.args.value },
    artifacts: [
      {
        id: 'artifact-1',
        kind: 'stdout',
        uri: 'memory://stdout/1',
        mimeType: 'text/plain',
      },
    ],
    diagnostics: {
      degraded: false,
      fallbackUsed: false,
      warnings: [{ code: 'partial', message: 'partial output preserved', stage: 'execute' }],
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
    nextActionHint: 'continue',
  };
}

function createAdapter(
  execute: (request: ToolExecutionRequest) => Promise<ToolResultEnvelope>
): ToolExecutionAdapter {
  return {
    kind: 'internal-tool',
    preview: (request) => ({
      kind: request.manifest.kind,
      summary: `Run ${request.manifest.id}`,
      risk: 'low',
      details: { args: request.args },
    }),
    execute,
  };
}

function collectObjectKeys(value: unknown, prefix: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectObjectKeys(item, prefix));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) => {
    const path = [...prefix, key];
    return [key, path.join('.'), ...collectObjectKeys(child, path)];
  });
}

function createEnvelopeForStatus(status: ToolResultEnvelope['status']): ToolResultEnvelope {
  const ok = status === 'success' || status === 'partial';
  return {
    ok,
    toolId: `demo.${status}`,
    callId: `call-${status}`,
    startedAt: '2026-06-10T00:00:00.000Z',
    durationMs: 3,
    status,
    text: `branch ${status}`,
    structuredContent: {
      branch: status,
      publicValue: 'kept',
      rawProviderResponse: { token: 'hidden' },
      data: { result: { rawProviderRequest: { prompt: 'hidden' } }, kept: true },
      nested: { threadId: 'host-thread', visible: true },
    },
    artifacts: [{ id: `artifact-${status}`, kind: 'log', uri: `memory://artifact/${status}` }],
    resources: [{ uri: `memory://resource/${status}`, title: `${status} resource` }],
    diagnostics: {
      degraded: !ok,
      fallbackUsed: false,
      warnings: [{ code: `${status}-warning`, message: 'raw warning kept out of projection' }],
      timedOutStages: status === 'timeout' ? ['execute'] : [],
      blockedTools: status === 'blocked' ? [{ tool: `demo.${status}`, reason: 'policy' }] : [],
      truncatedToolCalls: 0,
      emptyResponses: 0,
      aiErrorCount: status === 'error' ? 1 : 0,
      gateFailures:
        status === 'needs-confirmation'
          ? [{ stage: 'approve', action: 'needs-confirmation', reason: 'approval' }]
          : [],
    },
    trust: {
      source: 'internal',
      sanitized: true,
      containsUntrustedText: false,
      containsSecrets: false,
    },
  };
}

describe('UnifiedToolCatalog', () => {
  it('projects tool schemas and preserves internal handler access', () => {
    const definition: ToolDefinitionV2 = {
      id: 'demo.echo',
      title: 'Demo Echo',
      description: 'Full echo schema',
      kind: 'internal-tool',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      handler: async (args) => ({ echoed: args.value }),
      risk: createManifest().risk,
      governance: createManifest().governance,
      execution: createManifest().execution,
      modelOverrides: {
        'gpt-*': {
          description: 'Model-specific echo schema',
          inputSchema: { type: 'object', properties: { compact: { type: 'boolean' } } },
        },
      },
    };
    const catalog = new UnifiedToolCatalog([definition]);

    expect(catalog.getManifest('demo.echo')).toMatchObject({
      id: 'demo.echo',
      kind: 'internal-tool',
    });
    expect(catalog.getInternalTool('demo.echo')).toMatchObject({
      name: 'demo.echo',
      description: 'Full echo schema',
    });
    expect(catalog.toLightweightSchemas()[0]).toMatchObject({
      name: 'demo.echo',
      parameters: { type: 'object', properties: {} },
    });

    catalog.markExpanded('demo.echo');

    expect(catalog.toMixedSchemas(null, 'gpt-5', false)[0]).toMatchObject({
      description: 'Model-specific echo schema',
      parameters: { type: 'object', properties: { compact: { type: 'boolean' } } },
    });
  });
});

describe('LightweightRouter', () => {
  it('routes adapter execution and preserves structured partial outputs', async () => {
    const catalog = new CapabilityCatalog([createManifest()]);
    const calls: ToolExecutionRequest[] = [];
    const adapter = createAdapter(async (request) => {
      calls.push(request);
      return createSuccessEnvelope(request);
    });
    const router = new LightweightRouter({
      catalog,
      adapters: [adapter],
      projectRoot: '/tmp/project',
      dataRoot: '/tmp/data',
    });

    const envelope = await router.execute(createRequest());

    expect(envelope.ok).toBe(true);
    expect(envelope.structuredContent).toEqual({ echo: 'hello' });
    expect(envelope.artifacts?.[0]).toMatchObject({ kind: 'stdout', uri: 'memory://stdout/1' });
    expect(envelope.diagnostics.warnings[0]).toMatchObject({ code: 'partial' });
    expect(envelope.nextActionHint).toBe('continue');
    expect(presentToolResult(envelope)).toBe('echo complete');
    expect(isToolResultEnvelope(envelope)).toBe(true);
    expect(calls[0].context.projectRoot).toBe('/tmp/project');
    expect(calls[0].context.dataRoot).toBe('/tmp/data');
    expect(calls[0].decision.preview).toMatchObject({ kind: 'internal-tool' });
  });

  it('allows adapters to return partial result envelopes as explicit partial success', async () => {
    const catalog = new CapabilityCatalog([createManifest()]);
    const router = new LightweightRouter({
      catalog,
      adapters: [
        createAdapter(async (request) => ({
          ...createSuccessEnvelope(request, 'partial output available'),
          status: 'partial',
          structuredContent: { completed: 1, failed: 1 },
        })),
      ],
    });

    const envelope = await router.execute(createRequest());

    expect(envelope).toMatchObject({
      ok: true,
      status: 'partial',
      structuredContent: { completed: 1, failed: 1 },
    });
    expect(isToolResultEnvelope(envelope)).toBe(true);
  });

  it('projects ordinary result output without diagnostics or forbidden private fields', () => {
    const envelope = createEnvelopeForStatus('success');
    const projected = projectToolResultOrdinaryOutput(envelope);
    const projectedKeys = new Set(collectObjectKeys(projected));

    expect(projected).toMatchObject({
      ok: true,
      status: 'success',
      text: 'branch success',
      structuredContent: {
        branch: 'success',
        publicValue: 'kept',
        data: { kept: true },
        nested: { visible: true },
      },
      artifacts: [{ id: 'artifact-success', kind: 'log', uri: 'memory://artifact/success' }],
      resources: [{ uri: 'memory://resource/success', title: 'success resource' }],
      diagnosticSummary: {
        degraded: false,
        warningCount: 1,
        warningCodes: ['success-warning'],
        redactedFieldCount: 3,
      },
    });
    expect(projected).not.toHaveProperty('diagnostics');
    for (const field of TOOL_RESULT_FORBIDDEN_ORDINARY_OUTPUT_FIELDS) {
      expect(projectedKeys.has(field)).toBe(false);
    }
  });

  it('projects text-only envelopes as canonical ordinary output', () => {
    const envelope: ToolResultEnvelope = { ...createEnvelopeForStatus('success') };
    delete envelope.structuredContent;

    const projected = projectToolResultOrdinaryOutput(envelope);

    expect(projected).toMatchObject({
      ok: true,
      toolId: 'demo.success',
      callId: 'call-success',
      status: 'success',
      text: 'branch success',
      diagnosticSummary: {
        degraded: false,
        warningCodes: ['success-warning'],
        redactedFieldCount: 0,
      },
    });
    expect(projected).not.toHaveProperty('structuredContent');
    expect(projected).not.toHaveProperty('success');
    expect(projected).not.toHaveProperty('message');
    expect(projected).not.toHaveProperty('error');
    expect(projected).not.toHaveProperty('errorCode');
  });

  it('projects D25 failure taxonomy as stable ordinary output metadata', () => {
    const fixture = ALEMBIC_AGENT_INTERFACE_CONTRACT.branches.find(
      (item) => item.branch === 'provider-error'
    );
    const envelope = createEnvelopeForStatus('error');
    const projected = projectToolResultOrdinaryOutput(envelope, {
      failureTaxonomy: fixture?.failureTaxonomy,
    });
    const projectedKeys = new Set(collectObjectKeys(projected));

    expect(projected.failureTaxonomy).toMatchObject({
      kind: 'provider-error',
      stableId: 'core.failure.provider-error',
      agentBranch: 'provider-error',
      problemClass: 'provider-problem',
      privateDataSafe: true,
    });
    expect(projected).not.toHaveProperty('diagnostics');
    expect(projected.structuredContent).toMatchObject({
      branch: 'error',
      publicValue: 'kept',
    });
    for (const field of TOOL_RESULT_FORBIDDEN_ORDINARY_OUTPUT_FIELDS) {
      expect(projectedKeys.has(field)).toBe(false);
    }
  });

  it('projects every Agent contract branch without collapsing result status semantics', () => {
    const projectedStatuses = ALEMBIC_AGENT_INTERFACE_CONTRACT.branches.map((fixture) => {
      const status = fixture.toolStatus ?? 'error';
      const projected = projectToolResultOrdinaryOutput(createEnvelopeForStatus(status));
      const projectedKeys = new Set(collectObjectKeys(projected));

      for (const field of TOOL_RESULT_FORBIDDEN_ORDINARY_OUTPUT_FIELDS) {
        expect(projectedKeys.has(field)).toBe(false);
      }
      expect(projected.diagnosticSummary.warningCodes).toEqual([`${status}-warning`]);
      expect(projected.diagnosticSummary.redactedFieldCount).toBeGreaterThan(0);

      return [fixture.branch, projected.status] as const;
    });

    expect(projectedStatuses).toEqual([
      ['success', 'success'],
      ['failure', 'error'],
      ['cancellation', 'aborted'],
      ['timeout', 'timeout'],
      ['permission-denial', 'blocked'],
      ['needs-confirmation', 'needs-confirmation'],
      ['partial-result', 'partial'],
      ['provider-error', 'error'],
      ['host-failure', 'error'],
      ['host-adapter', 'error'],
    ]);
  });

  it('blocks tool calls denied by runtime policy before adapter execution', async () => {
    const catalog = new CapabilityCatalog([createManifest()]);
    let adapterCalled = false;
    const recorded: ToolResultEnvelope[] = [];
    const router = new LightweightRouter({
      catalog,
      adapters: [
        createAdapter(async (request) => {
          adapterCalled = true;
          return createSuccessEnvelope(request);
        }),
      ],
    });
    const request = createRequest({
      runtime: {
        policyValidator: {
          validateToolCall: () => ({ ok: false, reason: 'blocked by policy' }),
        },
        diagnostics: {
          recordToolCallEnvelope: (envelope) => {
            recorded.push(envelope);
          },
        },
      },
    });

    const explanation = await router.explain(request);
    const envelope = await router.execute(request);

    expect(explanation).toMatchObject({
      allowed: false,
      resultStatus: 'blocked',
      reason: 'blocked by policy',
    });
    expect(envelope).toMatchObject({
      ok: false,
      status: 'blocked',
      text: 'blocked by policy',
    });
    expect(envelope.diagnostics.blockedTools).toEqual([
      { tool: 'demo.echo', reason: 'blocked by policy' },
    ]);
    expect(adapterCalled).toBe(false);
    expect(recorded).toHaveLength(1);
  });

  it('returns needs-confirmation envelopes from runtime policy before adapter execution', async () => {
    const catalog = new CapabilityCatalog([createManifest()]);
    let adapterCalled = false;
    const recorded: ToolResultEnvelope[] = [];
    const router = new LightweightRouter({
      catalog,
      adapters: [
        createAdapter(async (request) => {
          adapterCalled = true;
          return createSuccessEnvelope(request);
        }),
      ],
    });
    const request = createRequest({
      runtime: {
        policyValidator: {
          validateToolCall: () => ({
            ok: false,
            reason: 'requires host approval before write',
            resultStatus: 'needs-confirmation',
            requiresConfirmation: true,
            confirmationMessage: 'Approve demo.echo for unit test',
            requestId: 'approval-1',
          }),
        },
        diagnostics: {
          recordToolCallEnvelope: (envelope) => {
            recorded.push(envelope);
          },
        },
      },
    });

    const explanation = await router.explain(request);
    const envelope = await router.execute(request);

    expect(explanation).toMatchObject({
      allowed: false,
      resultStatus: 'needs-confirmation',
      requiresConfirmation: true,
      confirmationMessage: 'Approve demo.echo for unit test',
      requestId: 'approval-1',
    });
    expect(envelope).toMatchObject({
      ok: false,
      status: 'needs-confirmation',
      text: 'requires host approval before write',
      nextActionHint: 'Approve demo.echo for unit test',
    });
    expect(envelope.diagnostics.blockedTools).toEqual([]);
    expect(envelope.diagnostics.gateFailures).toEqual([
      {
        stage: 'approve',
        action: 'needs-confirmation',
        reason: 'requires host approval before write',
      },
    ]);
    expect(adapterCalled).toBe(false);
    expect(recorded).toHaveLength(1);
  });

  it('blocks tools on unsupported surfaces', async () => {
    const catalog = new CapabilityCatalog([createManifest({ surfaces: ['runtime'] })]);
    const router = new LightweightRouter({ catalog });

    const envelope = await router.execute(
      createRequest({ surface: 'mcp', source: { kind: 'mcp' } })
    );

    expect(envelope).toMatchObject({
      ok: false,
      status: 'blocked',
    });
    expect(envelope.text).toContain("not allowed on surface 'mcp'");
  });

  it('returns timeout envelopes when adapters exceed execution timeout', async () => {
    const catalog = new CapabilityCatalog([
      createManifest({ execution: { timeoutMs: 5, abortMode: 'hardTimeout' } }),
    ]);
    const router = new LightweightRouter({
      catalog,
      adapters: [
        createAdapter(
          () =>
            new Promise<ToolResultEnvelope>(() => {
              /* intentionally never resolves */
            })
        ),
      ],
    });

    const envelope = await router.execute(createRequest());

    expect(envelope).toMatchObject({
      ok: false,
      status: 'timeout',
      text: 'Tool call timed out after 5ms',
    });
    expect(envelope.diagnostics.timedOutStages).toEqual(['execute']);
  });

  it('returns aborted envelopes without starting adapters when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const catalog = new CapabilityCatalog([createManifest()]);
    let adapterCalled = false;
    const router = new LightweightRouter({
      catalog,
      adapters: [
        createAdapter(async (request) => {
          adapterCalled = true;
          return createSuccessEnvelope(request);
        }),
      ],
    });

    const envelope = await router.execute(createRequest({ abortSignal: controller.signal }));

    expect(envelope).toMatchObject({
      ok: false,
      status: 'aborted',
      text: 'Tool call aborted before execution',
    });
    expect(adapterCalled).toBe(false);
  });

  it('normalizes adapter exceptions into error envelopes', async () => {
    const catalog = new CapabilityCatalog([createManifest()]);
    const router = new LightweightRouter({
      catalog,
      adapters: [
        createAdapter(async () => {
          throw new Error('adapter boom');
        }),
      ],
    });

    const envelope = await router.execute(createRequest());

    expect(envelope).toMatchObject({
      ok: false,
      status: 'error',
      text: 'adapter boom',
    });
    expect(isToolResultEnvelope(envelope)).toBe(true);
  });
});
