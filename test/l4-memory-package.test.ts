import { describe, expect, it } from 'vitest';
import {
  buildL4MemoryPackage,
  renderL4MemoryPackage,
  validateL4Summary,
} from '../src/agent/context/index.js';

describe('L4 memory package', () => {
  it('builds a structured package from ActiveContext distill, phase state, and recent text', () => {
    const pkg = buildL4MemoryPackage({
      goal: 'Analyze host adapter boundaries',
      phase: 'VERIFY',
      stageStatus: 'running',
      activeContext: {
        distill: () => ({
          keyFindings: [
            {
              finding: 'Host adapter owns platform wiring',
              evidence: 'src/host.ts:12',
              importance: 8,
            },
          ],
          toolCallSummary: ['[code] read src/host.ts'],
          plan: {
            text: 'Check adapters',
            steps: [{ status: 'done', description: 'Read host adapter' }],
          },
          totalObservations: 3,
          compressedCount: 1,
        }),
      },
      recentMessages: [
        {
          role: 'tool',
          name: 'code',
          toolCallId: 'orphan',
          content: 'raw result should become text',
        },
      ],
      diagnostics: {
        degraded: true,
        gateFailures: [{ stage: 'quality', action: 'record_repair', reason: 'missing findings' }],
        timedOutStages: ['analyze'],
      },
    });

    expect(pkg).toMatchObject({
      kind: 'l4_memory_package',
      phase: 'VERIFY',
      stageStatus: 'running',
      stats: { totalObservations: 3, compressedCount: 1 },
    });
    expect(pkg.keyFindings[0]).toMatchObject({
      finding: 'Host adapter owns platform wiring',
      evidence: 'src/host.ts:12',
    });
    expect(pkg.evidenceRefs[0]).toMatchObject({ path: 'src/host.ts', line: 12 });
    expect(pkg.recentConversation[0]).toContain('tool-result-as-text');
    expect(pkg.failureState).toEqual(expect.arrayContaining(['timedOutStage=analyze']));

    const rendered = renderL4MemoryPackage(pkg);
    expect(rendered).toContain('L4 Memory Package v1');
    expect(rendered).toContain('src/host.ts:12');
    expect(rendered).not.toContain('role: tool');
  });

  it('validates that summaries retain phase, findings, evidence, and failure state', () => {
    const pkg = buildL4MemoryPackage({
      phase: 'RECORD',
      activeContext: {
        distill: () => ({
          keyFindings: [
            {
              finding: 'Record repair writes validated findings',
              evidence: 'src/repair.ts:20',
              importance: 9,
            },
          ],
        }),
      },
      diagnostics: { efficiency: { cancelReason: 'stage_timeout' } },
    });

    expect(
      validateL4Summary('RECORD 摘要保留 Record repair、src/repair.ts 和 stage_timeout。', pkg)
    ).toEqual({ ok: true, missing: [] });
    expect(validateL4Summary('笼统摘要', pkg)).toMatchObject({
      ok: false,
      missing: expect.arrayContaining(['phase:RECORD', 'key_findings', 'evidence_refs']),
    });
  });
});
