/**
 * M1（挖掘产出升级）契约面对齐钉：
 * - 维度运行的 knowledge.submit schema 变体必须与运行时闸一致（evidenceRefs 必填）——
 *   E4/run-6 两次「广告面≠校验面」教训的永久回归钉；
 * - 深度槽必须同时出现在 registry 面与直呼型 schema 面（run-8 0 使用率根因=直呼面缺席）；
 * - 深度加权 effectiveMemoryFindingCount 语义钉。
 */
import { describe, expect, test } from 'vitest';
import {
  effectiveMemoryFindingCount,
  targetMemoryFindingCount,
} from '../src/agent/context/exploration/ExplorationStrategies.js';
import {
  applyDimensionSubmitSchemaVariant,
  DEPTH_SLOT_KEYS,
  generateLightweightSchemas,
} from '../src/tools/runtime/registry.js';

type R = Record<string, unknown>;

function submitParamsOf(schema: R): R {
  return ((schema.parameters as R).properties as R).params as R;
}

describe('M1a 维度 submit schema 变体（契约面=校验面）', () => {
  test('变体：reasoning.required=[evidenceRefs]、scope 在场、sources 降述；原件不被污染', () => {
    const base = generateLightweightSchemas({ knowledge: ['submit'], memory: ['recall'] });
    const knowledgeBase = base.find((s) => s.name === 'knowledge') as unknown as R;
    const variant = applyDimensionSubmitSchemaVariant(base as unknown as R[]);
    const knowledgeVariant = variant.find((s) => s.name === 'knowledge') as R;

    const vParams = submitParamsOf(knowledgeVariant);
    const vProps = vParams.properties as R;
    const vReasoning = vProps.reasoning as R;
    // 运行时闸 EVIDENCE_REFS_REQUIRED 的广告面
    expect(vReasoning.required).toEqual(['evidenceRefs']);
    // scope 自声明通道（证据驱动收窄 gate 读 item.scope）
    expect((vProps.scope as R).enum).toContain('narrow');
    expect(String(((vReasoning.properties as R).sources as R).description)).toContain(
      'Auto-expanded'
    );
    const profile = vProps.retrievalProfile as R;
    const profileProps = profile.properties as R;
    expect(profile.required).toEqual([
      'primaryLanguage',
      'summary',
      'concepts',
      'scenarios',
      'exclusions',
      'provenance',
    ]);
    expect((profileProps.summary as R).required).toEqual(['primary', 'technicalEnglish']);
    expect(profileProps).not.toHaveProperty('queries');
    expect(profileProps).not.toHaveProperty('expectedIds');
    expect(profileProps).not.toHaveProperty('synonyms');

    // 原件（同一次 generate 的 base 数组元素）不被变体污染——schema 按引用直达 provider
    const bReasoning = (submitParamsOf(knowledgeBase).properties as R).reasoning as R;
    expect(bReasoning.required).toEqual(['sources']);
    expect((submitParamsOf(knowledgeBase).properties as R).retrievalProfile).toEqual(profile);
    expect((submitParamsOf(knowledgeBase).properties as R).scope).toBeUndefined();
    // 非 knowledge 工具原样透传（同引用即可）
    expect(variant.find((s) => s.name === 'memory')).toBe(
      base.find((s) => s.name === 'memory') as unknown as R
    );
  });

  test('多动作摘要形态（无 reasoning 展开）原样返回不崩', () => {
    const summaryShape = [
      {
        name: 'knowledge',
        description: 'x',
        parameters: {
          type: 'object',
          properties: { action: { enum: ['submit', 'search'] }, params: { type: 'object' } },
        },
      },
    ] as unknown as R[];
    expect(applyDimensionSubmitSchemaVariant(summaryShape)[0]).toBe(summaryShape[0]);
  });
});

describe('M1c 深度槽双面在场 + 配额加权', () => {
  test('registry note_finding 面声明全部深度槽', () => {
    const schemas = generateLightweightSchemas({ memory: ['note_finding'] });
    const memory = schemas.find((s) => s.name === 'memory') as unknown as R;
    const props = (submitParamsOf(memory).properties ?? {}) as R;
    for (const key of DEPTH_SLOT_KEYS) {
      expect(props[key], `registry 面缺深度槽 ${key}`).toBeDefined();
    }
    expect(DEPTH_SLOT_KEYS.length).toBeGreaterThan(0);
  });

  test('effectiveMemoryFindingCount：深度槽计 1.5，加权部分不超过发现总数', () => {
    expect(
      effectiveMemoryFindingCount({ memoryFindingCount: 4, depthSlottedFindingCount: 2 })
    ).toBe(5);
    expect(effectiveMemoryFindingCount({ memoryFindingCount: 4 })).toBe(4);
    // 防御：槽计数异常大于发现数时按发现数截断
    expect(
      effectiveMemoryFindingCount({ memoryFindingCount: 2, depthSlottedFindingCount: 99 })
    ).toBe(3);
    // 与 target 组合：6 次证据调用 target=3；2 发现+2 槽 → 3 达标
    const target = targetMemoryFindingCount({ evidenceToolCallCount: 6, ledgerDistinctFiles: 9 });
    expect(target).toBe(3);
    expect(
      effectiveMemoryFindingCount({ memoryFindingCount: 2, depthSlottedFindingCount: 2 })
    ).toBeGreaterThanOrEqual(target);
  });
});
