import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ALEMBIC_AGENT_INTERFACE_CONTRACT,
  isToolResultEnvelope,
  presentToolResult,
  projectToolResultOrdinaryOutput,
  TOOL_RESULT_FORBIDDEN_ORDINARY_OUTPUT_FIELDS,
  type ToolCapabilityManifest,
  type ToolDefinitionV2,
  type ToolResultEnvelope,
  UnifiedToolCatalog,
} from '../src/index.js';

function walkSource(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSource(filePath, acc);
    } else if (entry.name.endsWith('.ts')) {
      acc.push(filePath);
    }
  }
  return acc;
}

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

describe('tool kernel contract', () => {
  it('removes the V1 core-contract shims and the runtime bridge from source', () => {
    const removed = [
      'src/tools/core/InternalToolHandler.ts',
      'src/tools/core/ToolCallContext.ts',
      'src/tools/core/ToolContracts.ts',
      'src/tools/core/ToolDecision.ts',
      'src/tools/core/ToolResultEnvelope.ts',
      'src/tools/core/ToolResultPresenter.ts',
      'src/tools/core/ToolRoutingServices.ts',
      'src/tools/runtime/ToolRuntimeBridge.ts',
    ];
    for (const rel of removed) {
      expect(existsSync(path.join(process.cwd(), rel))).toBe(false);
    }

    const stragglers = walkSource(path.join(process.cwd(), 'src'))
      .map((filePath) => ({
        file: path.relative(process.cwd(), filePath),
        text: readFileSync(filePath, 'utf8'),
      }))
      .filter(
        ({ text }) =>
          text.includes('#tools/runtime/ToolRuntimeBridge') ||
          /#tools\/core\/(InternalToolHandler|ToolCallContext|ToolContracts|ToolDecision|ToolResultEnvelope|ToolResultPresenter|ToolRoutingServices)\.js/.test(
            text
          )
      )
      .map(({ file }) => file)
      .sort();

    expect(stragglers).toEqual([]);
  });

  it('re-exports the tool contract from the kernel on the public ./tools surface', () => {
    const toolsIndex = readFileSync(path.join(process.cwd(), 'src/tools/index.ts'), 'utf8');
    const kernelReexports = toolsIndex
      .split('\n')
      .filter((line) => line.startsWith("export * from './kernel/"))
      .map((line) => line.trim())
      .sort();

    expect(kernelReexports).toEqual([
      "export * from './kernel/context.js';",
      "export * from './kernel/decision.js';",
      "export * from './kernel/handler.js';",
      "export * from './kernel/presenter.js';",
      "export * from './kernel/request.js';",
      "export * from './kernel/result.js';",
      "export * from './kernel/routing.js';",
    ]);
    expect(toolsIndex).not.toContain("export * from './core/LightweightRouter.js';");
    expect(toolsIndex).not.toContain("export * from './terminal/index.js';");
  });
});

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

describe('tool result ordinary output', () => {
  it('recognizes and presents result envelopes without a retired router dependency', () => {
    const envelope = createEnvelopeForStatus('success');

    expect(isToolResultEnvelope(envelope)).toBe(true);
    expect(presentToolResult(envelope)).toBe('branch success');
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
});
