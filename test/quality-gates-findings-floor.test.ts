/**
 * C48(L7-P17)：note_finding 条数下限与 Core DIMENSION_COMPLETION_FLOOR 单源。
 *
 * 背景：qualityGates 里 summary_rewrite 分流已取 Core floor，而 buildQualityScores 的
 * 「INSUFFICIENT」建议仍写死 `< 3`、文案写死 “At least 3”。Core 调高 minKeyFindings 时
 * 三处口径会静默分裂：record_repair/summary_rewrite 要求补到新底线，质量门却放过 3..floor-1
 * 条 findings 的工件。这里把 Core floor 模拟成 5，锁住质量门跟随 Core 单源变化，
 * 且 suggestion 文本(也是 buildRetryPrompt 的路由键)由同一 floor 生成、两侧仍能命中。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  analysisQualityGate,
  buildQualityScores,
  INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION,
  REQUIRED_MEMORY_FINDING_SUGGESTION,
} from '../src/agent/evaluation/qualityGates.js';
import { buildRetryPrompt } from '../src/agent/prompts/insightGate.js';

// vi.mock 会提升到 import 之前：只抬高 minKeyFindings，其余 Core 导出保持真实实现(reviewRecipeDepth 等)。
vi.mock('@alembic/core/knowledge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alembic/core/knowledge')>();
  return {
    ...actual,
    DIMENSION_COMPLETION_FLOOR: { ...actual.DIMENSION_COMPLETION_FLOOR, minKeyFindings: 5 },
  };
});

type EvidenceArg = Parameters<typeof buildQualityScores>[2];

const EMPTY_EVIDENCE = {
  evidenceMap: new Map(),
  explorationLog: [],
  negativeSignals: [],
  graphEvidence: [],
} as EvidenceArg;

const suggestionsFor = (memoryFindingCount: number) =>
  buildQualityScores('analysis text', [], EMPTY_EVIDENCE, { memoryFindingCount }).suggestions;

describe('quality gate note_finding floor follows Core DIMENSION_COMPLETION_FLOOR', () => {
  it('derives the insufficient-findings suggestion text from the Core floor', () => {
    expect(INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION).toBe(
      'At least 5 note_finding calls are required'
    );
  });

  it.each([1, 3, 4])('flags %i recorded findings as insufficient when the floor is 5', (count) => {
    const suggestions = suggestionsFor(count);
    expect(suggestions).toContain(INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION);
    expect(suggestions).not.toContain(REQUIRED_MEMORY_FINDING_SUGGESTION);
  });

  it.each([5, 8])('accepts %i recorded findings at or above the floor', (count) => {
    const suggestions = suggestionsFor(count);
    expect(suggestions).not.toContain(INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION);
    expect(suggestions).not.toContain(REQUIRED_MEMORY_FINDING_SUGGESTION);
  });

  it('keeps zero findings on the required-findings route', () => {
    expect(suggestionsFor(0)).toEqual(expect.arrayContaining([REQUIRED_MEMORY_FINDING_SUGGESTION]));
    expect(suggestionsFor(0)).not.toContain(INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION);
  });

  it('routes the floor-derived suggestion through the candidate gate and retry prompt', () => {
    const { scores, totalScore, suggestions } = buildQualityScores(
      'analysis text',
      [],
      EMPTY_EVIDENCE,
      { memoryFindingCount: 4 }
    );
    const gate = analysisQualityGate(
      {
        analysisText: 'analysis text',
        referencedFiles: [],
        qualityReport: { scores, totalScore, suggestions },
      },
      { outputType: 'candidate', memoryFindingCount: 4 }
    );
    expect(gate).toMatchObject({ pass: false, reason: INSUFFICIENT_MEMORY_FINDINGS_SUGGESTION });
    // 路由键与门产出同一符号：buildRetryPrompt 必须命中专用提示，而不是退回通用兜底文本。
    expect(buildRetryPrompt(gate.reason ?? '')).toContain('结构化发现数量不足');
  });
});
