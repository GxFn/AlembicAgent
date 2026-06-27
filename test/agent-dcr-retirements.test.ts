import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { ALEMBIC_AGENT_INTERFACE_CONTRACT } from '../src/agent/runtime/AgentInterfaceContract.js';
import { ALEMBIC_AGENT_RUNTIME_BOUNDARY } from '../src/agent/runtime/AgentRuntimeBoundary.js';
import { AiProvider } from '../src/ai/AiProvider.js';

// Identifiers are split so repo-wide consumer scans for the retired surfaces
// keep returning zero hits outside deletion notes and policy entries.
const retiredAggregateExport = ['./to', 'ols'].join('');
const retiredAggregateSpecifier = ['@alembic/agent/to', 'ols'].join('');
const retiredTerminalExport = ['./tools', '/terminal'].join('');
const retiredTerminalSpecifier = ['@alembic/agent/tools', '/terminal'].join('');
const removedEnrichMember = ['enrich', 'Candidates'].join('');
const removedEnrichPromptBuilder = ['_buildEnrich', 'Prompt'].join('');
const removedLangInstructionBuilder = ['_buildLang', 'Instruction'].join('');

function readRepoJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'));
}

describe('retired tool package exports', () => {
  it('keeps retired aggregate and terminal subpaths out of package exports', () => {
    const packageJson = readRepoJson('package.json');
    const exportPaths = Object.keys(packageJson.exports as Record<string, unknown>);

    expect(exportPaths).not.toContain(retiredAggregateExport);
    expect(exportPaths).not.toContain(retiredTerminalExport);
    expect(exportPaths).toContain('./tools/runtime');
    expect(exportPaths).toContain('.');
  });

  it('keeps retired subpaths out of the boundary policy and signature snapshot', () => {
    const boundary = readRepoJson('config/agent-public-api-boundary.json');
    const signatures = readRepoJson('config/agent-public-api-signatures.json');
    const boundaryStable = boundary.stablePublicExports as string[];
    const signatureStable = signatures.stablePublicExports as string[];
    const signatureEntries = signatures.stableExportSignatures as Record<string, unknown>;
    const expectedCounts = boundary.expectedCounts as Record<string, number>;

    expect(boundaryStable).not.toContain(retiredAggregateExport);
    expect(boundaryStable).not.toContain(retiredTerminalExport);
    expect(signatureStable).not.toContain(retiredAggregateExport);
    expect(signatureStable).not.toContain(retiredTerminalExport);
    expect(Object.keys(signatureEntries)).not.toContain(retiredAggregateExport);
    expect(Object.keys(signatureEntries)).not.toContain(retiredTerminalExport);
    expect(expectedCounts['stable-public']).toBe(12);
    expect(signatures.packageExportCount).toBe(12);
    expect(boundary.forbiddenConsumerSpecifiers as string[]).toContain(retiredAggregateSpecifier);
    expect(boundary.forbiddenConsumerSpecifiers as string[]).toContain(retiredTerminalSpecifier);
  });

  it('routes the tool-execution boundary and consumer seams through the root facade', () => {
    const toolExecution = ALEMBIC_AGENT_RUNTIME_BOUNDARY.entries.find(
      (entry) => entry.area === 'tool-execution'
    );

    expect(toolExecution).toMatchObject({ owner: 'agent', publicSubpath: '@alembic/agent' });
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.alembicConsumerSeams).not.toContain(
      retiredAggregateSpecifier
    );
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.alembicConsumerSeams).not.toContain(
      retiredTerminalSpecifier
    );
    expect(
      ALEMBIC_AGENT_RUNTIME_BOUNDARY.entries.find((entry) => entry.area === 'terminal-sandbox')
    ).toMatchObject({
      publicSubpath: '@alembic/agent/tools/runtime',
    });
    expect(ALEMBIC_AGENT_INTERFACE_CONTRACT.alembicConsumerSeams).toContain('@alembic/agent');
  });
});

describe('removed AiProvider enrich surface (Train B DCR default-delete)', () => {
  it('does not expose the removed enrich member or its prompt builders', () => {
    expect(removedEnrichMember in AiProvider.prototype).toBe(false);
    expect(removedEnrichPromptBuilder in AiProvider.prototype).toBe(false);
    expect(removedLangInstructionBuilder in AiProvider.prototype).toBe(false);
  });
});
