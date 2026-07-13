import { describe, expect, test } from 'vitest';
import { projectScanRunResult } from '../src/agent/runs/scan/ScanRunProjection.js';
import type { ToolCallEntry } from '../src/agent/runtime/AgentRuntimeTypes.js';
import type { AgentRunResult } from '../src/agent/service/AgentRunContracts.js';

function knowledgeCall(result: unknown): ToolCallEntry {
  return {
    tool: 'knowledge',
    args: { action: 'submit', params: {} },
    result,
    durationMs: 1,
  };
}

function runResult(toolCalls: ToolCallEntry[]): AgentRunResult {
  return {
    runId: 'scan-run-1',
    profileId: 'scan-extract',
    reply: '{"recipes":[]}',
    status: 'success',
    toolCalls,
    usage: { inputTokens: 1, outputTokens: 1, iterations: 1, durationMs: 1 },
    diagnostics: null,
  };
}

describe('ScanRunProjection persisted Recipe identity', () => {
  test('projects a knowledge.submit created envelope as an existing staging Recipe', () => {
    const readiness = {
      ready: false,
      schemaVersion: 'recipe-retrieval-readiness-v1',
      profileHash: 'profile-hash',
      documentSetHash: 'document-set-hash',
      violations: [{ code: 'retrieval.profile.fact-ungrounded' }],
      warnings: [],
    };

    const projection = projectScanRunResult({
      label: 'RecipeModule',
      task: 'extract',
      result: runResult([
        knowledgeCall({
          status: 'created',
          id: 'recipe-persisted-1',
          title: 'Persisted module Recipe',
          lifecycle: 'staging',
          readiness,
        }),
      ]),
      fallback: (label) => ({ targetName: label, recipes: [] }),
    });

    expect(projection).toMatchObject({
      targetName: 'RecipeModule',
      extracted: 1,
      recipes: [
        {
          status: 'created',
          id: 'recipe-persisted-1',
          candidateId: 'recipe-persisted-1',
          title: 'Persisted module Recipe',
          lifecycle: 'staging',
          readiness,
        },
      ],
    });
  });

  test('keeps only persisted pending or staging created envelopes from a mixed batch', () => {
    const projection = projectScanRunResult({
      label: 'MixedModule',
      task: 'extract',
      result: runResult([
        knowledgeCall({ status: 'rejected', id: 'rejected-id', lifecycle: 'pending' }),
        knowledgeCall({ status: 'failed', id: 'failed-id', lifecycle: 'pending' }),
        knowledgeCall({ status: 'duplicate_blocked', id: 'duplicate-id', lifecycle: 'pending' }),
        knowledgeCall({ error: 'gateway failed before persistence' }),
        knowledgeCall({ status: 'collected', recipe: { id: 'legacy-fake-id' } }),
        knowledgeCall({ status: 'created', id: 'active-id', lifecycle: 'active' }),
        knowledgeCall({ status: 'created', id: '', lifecycle: 'pending' }),
        knowledgeCall({
          status: 'created',
          id: 'pending-id',
          candidateId: 'provider-spoofed-id',
          title: 'Pending persisted Recipe',
          lifecycle: 'pending',
          readiness: { ready: false, violations: [], warnings: [] },
        }),
        knowledgeCall({
          status: 'created',
          id: 'staging-id',
          title: 'Staging persisted Recipe',
          lifecycle: 'staging',
          readiness: { ready: true, violations: [], warnings: [] },
        }),
      ]),
      fallback: (label) => ({ targetName: label, extracted: 0, recipes: [] }),
    });

    expect(projection).toMatchObject({
      extracted: 2,
      recipes: [
        { id: 'pending-id', candidateId: 'pending-id', lifecycle: 'pending' },
        { id: 'staging-id', candidateId: 'staging-id', lifecycle: 'staging' },
      ],
    });
  });

  test('preserves the explicit no-submit preview mode for scan callers that do not persist', () => {
    const result = runResult([]);
    result.reply = JSON.stringify({
      targetName: 'PreviewModule',
      extracted: 1,
      recipes: [{ title: 'Preview-only candidate' }],
    });

    const projection = projectScanRunResult({
      label: 'PreviewModule',
      task: 'extract',
      result,
      fallback: (label) => ({ targetName: label, extracted: 0, recipes: [] }),
    });

    expect(projection).toMatchObject({
      targetName: 'PreviewModule',
      extracted: 1,
      recipes: [{ title: 'Preview-only candidate' }],
      diagnostics: { ignoredUnpersistedOutput: false, usedFallback: false },
    });
  });

  test('does not manufacture a Recipe from provider text after rejected or failed submits', () => {
    const result = runResult([
      knowledgeCall({ status: 'rejected', reason: 'invalid profile' }),
      knowledgeCall({ error: 'gateway unavailable' }),
    ]);
    result.reply = JSON.stringify({
      targetName: 'RejectedModule',
      extracted: 1,
      recipes: [{ id: 'provider-invented-id', lifecycle: 'staging' }],
    });

    const projection = projectScanRunResult({
      label: 'RejectedModule',
      task: 'extract',
      result,
      fallback: (label) => ({ targetName: label, extracted: 0, recipes: [] }),
    });

    expect(projection).toMatchObject({
      targetName: 'RejectedModule',
      extracted: 0,
      recipes: [],
    });
  });

  test('summarize projection retains the persisted Recipe identity and readiness', () => {
    const projection = projectScanRunResult({
      label: 'SummaryModule',
      task: 'summarize',
      result: runResult([
        knowledgeCall({
          status: 'created',
          id: 'summary-recipe-id',
          title: 'Summary persisted Recipe',
          lifecycle: 'pending',
          readiness: {
            ready: false,
            violations: [{ code: 'retrieval.profile.missing' }],
            warnings: [],
          },
        }),
      ]),
      fallback: (label) => ({ targetName: label, extracted: 0, recipes: [] }),
    });

    expect(projection).toMatchObject({
      status: 'created',
      id: 'summary-recipe-id',
      candidateId: 'summary-recipe-id',
      lifecycle: 'pending',
      readiness: {
        ready: false,
        violations: [{ code: 'retrieval.profile.missing' }],
      },
      recipes: [{ id: 'summary-recipe-id', candidateId: 'summary-recipe-id' }],
      extracted: 1,
    });
  });
});
