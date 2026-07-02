/**
 * 软规则一次申辩制(2026-07-02 用户决策)钉子。
 *
 * 门禁规则分两性：硬=事实与接地(伪造锚点/重复/必填结构，放行即污染知识库)；
 * 软=写作风格判断(祈使动词白名单/对比示例/标题泛化/长度)。软规则全拒时 LLM 只能
 * 反复猜措辞——最长的提交回合尾巴。申辩制：带 ≥20 字 waiverJustification 重交即放行，
 * 理由随 reasoning.styleWaiver 落库交 Dashboard 人工审核终裁。
 */
import { describe, expect, it } from 'vitest';

import {
  applyStyleWaiver,
  isSoftAuthoringViolation,
} from '../src/tools/runtime/handlers/knowledge.js';

const JUSTIFICATION = '本项目 doClause 惯用语即 ensure 开头，历史 Recipe 均如此，保持一致性。';

describe('isSoftAuthoringViolation — 软硬分级', () => {
  it('风格类是软规则(可申辩)', () => {
    for (const code of [
      'DO_CLAUSE_NON_IMPERATIVE',
      'DONT_CLAUSE_NON_ENGLISH',
      'CONTENT_CONTRAST_MISSING',
      'STAGE3_MARKDOWN_TOO_SHORT',
      'STAGE3_TITLE_TOO_GENERIC',
      'STAGE3_CORECODE_INCOMPLETE',
      'STAGE3_MARKDOWN_NEEDS_CODE_OR_FILEREF',
    ]) {
      expect(isSoftAuthoringViolation(code), code).toBe(true);
    }
  });

  it('接地/伪造/重复/必填结构是硬规则(不可申辩)', () => {
    for (const code of [
      'SNIPPET_MISMATCH',
      'SOURCE_REFS_MISSING',
      'SOURCE_REF_LINE_MISSING',
      'SOURCE_REF_LINE_OUT_OF_RANGE',
      'PLACEHOLDER_EVIDENCE',
      'GRAPH_REF_INVALID',
      'STALE_GRAPH',
      'INSUFFICIENT_EVIDENCE',
      'DO_CLAUSE_REQUIRED',
      'CONTENT_MARKDOWN_REQUIRED',
    ]) {
      expect(isSoftAuthoringViolation(code), code).toBe(false);
    }
  });
});

describe('applyStyleWaiver — 一次申辩判定', () => {
  const item = { title: 'T', reasoning: { sources: ['src/a.ts:1-5'] } };

  it('全软违规 + 充分理由 → 放行，理由随 reasoning.styleWaiver 落库', () => {
    const result = applyStyleWaiver({
      violations: [{ code: 'DO_CLAUSE_NON_IMPERATIVE' }, { code: 'STAGE3_TITLE_TOO_GENERIC' }],
      justification: JUSTIFICATION,
      sessionWaiverTotal: 0,
      item,
    });
    expect(result.waived).toBe(true);
    expect(result.waivedCodes).toEqual(['DO_CLAUSE_NON_IMPERATIVE', 'STAGE3_TITLE_TOO_GENERIC']);
    const reasoning = result.item.reasoning as Record<string, unknown>;
    expect(reasoning.styleWaiver).toMatchObject({
      codes: ['DO_CLAUSE_NON_IMPERATIVE', 'STAGE3_TITLE_TOO_GENERIC'],
      justification: JUSTIFICATION,
    });
    // 原 reasoning 字段保留(sources 是必填证据，不能被 waiver 覆盖掉)
    expect(reasoning.sources).toEqual(['src/a.ts:1-5']);
  });

  it('混有硬违规 → 申辩无效(先修事实错误)', () => {
    const result = applyStyleWaiver({
      violations: [{ code: 'DO_CLAUSE_NON_IMPERATIVE' }, { code: 'SNIPPET_MISMATCH' }],
      justification: JUSTIFICATION,
      sessionWaiverTotal: 0,
      item,
    });
    expect(result.waived).toBe(false);
    expect(result.item).toBe(item);
  });

  it('理由不足 20 字 → 视同无理由，不放行', () => {
    const result = applyStyleWaiver({
      violations: [{ code: 'DO_CLAUSE_NON_IMPERATIVE' }],
      justification: '就这样吧',
      sessionWaiverTotal: 0,
      item,
    });
    expect(result.waived).toBe(false);
  });

  it('会话 waiver 已达上限(5) → 不再放行', () => {
    const result = applyStyleWaiver({
      violations: [{ code: 'DO_CLAUSE_NON_IMPERATIVE' }],
      justification: JUSTIFICATION,
      sessionWaiverTotal: 5,
      item,
    });
    expect(result.waived).toBe(false);
  });

  it('零违规或纯硬违规 → 不触发 waiver 语义', () => {
    expect(
      applyStyleWaiver({
        violations: [],
        justification: JUSTIFICATION,
        sessionWaiverTotal: 0,
        item,
      }).waived
    ).toBe(false);
    expect(
      applyStyleWaiver({
        violations: [{ code: 'GRAPH_REF_INVALID' }],
        justification: JUSTIFICATION,
        sessionWaiverTotal: 0,
        item,
      }).waived
    ).toBe(false);
  });
});
