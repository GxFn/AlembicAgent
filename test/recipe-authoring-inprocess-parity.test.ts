/**
 * P4 wave 2 — AlembicAgent in-process WRAPPER parity tripwire (§12.5 two-paths-tie, in-process side).
 *
 * 证明：in-process 提交包装器 runInProcessRecipeAuthoringGate（src/tools/runtime/handlers/
 * recipeAuthoringGate.ts）的裁决，与「直接调用 Core validateAgainst（path:'in-process' + 匹配的
 * profile + 相同注入端口）」逐字节一致 —— 即包装器不改写 / 不增删 Core 裁决，in-process 提交面对的
 * 就是 Core 同一道门禁。配合 Plugin 侧 host-path parity（host 包装器 == 同一 Core validateAgainst），
 * transitively 闭合 host-vs-in-process tie：两个真实提交路径的包装器都等于同一个 Core validateAgainst。
 *
 * 消费 AlembicCore @ 47391c6（经 @alembic/core/knowledge facade）。
 *
 * ADDITIVE TEST ONLY：不改 recipeAuthoringGate.ts 包装器、不改任何门禁、门禁不放松。若断言暴露
 * 包装器与 Core 背离，正确修法是让包装器调用统一的 Core validateAgainst，而非放松任何门禁。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type RecipeAuthoringProfile,
  type RecipeAuthoringViolation,
  validateAgainst,
} from '@alembic/core/knowledge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createInProcessSourceRefResolver,
  runInProcessRecipeAuthoringGate,
} from '../src/tools/runtime/handlers/recipeAuthoringGate.js';

// 真实临时项目：让 in-process fs resolver 的来源接地（存在 / 越界 / 缺失）确定性触发。
let projectRoot: string;

beforeAll(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'agent-inproc-parity-'));
  mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  for (const name of ['alpha', 'beta', 'gamma']) {
    writeFileSync(
      path.join(projectRoot, 'src', `${name}.ts`),
      Array.from({ length: 20 }, (_, i) => `export const ${name}${i} = ${i};`).join('\n')
    );
  }
});

afterAll(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

/**
 * Direct Core validateAgainst call mirroring exactly what the wrapper composes internally:
 * single item, stage:'all', path:'in-process', the SAME fs resolver factory + projectRoot, and the
 * profile + dimensionId the wrapper would resolve/pass. The wrapper must return THIS, unmutated.
 */
function directCoreVerdict(
  item: Record<string, unknown>,
  profile: RecipeAuthoringProfile,
  dimensionId?: string
): RecipeAuthoringViolation[] {
  return validateAgainst([item], {
    stage: 'all',
    path: 'in-process',
    profile,
    sourceRefResolver: createInProcessSourceRefResolver(),
    projectRoot,
    dimensionId,
  });
}

/**
 * Fixture corpus (no dimensionId → the wrapper resolves opportunistic). Mixes a gate-clean candidate
 * with stage-1 / stage-2 / stage-3 / fs-port (NOT_FOUND, LINE_OUT_OF_RANGE) violations so the parity
 * assertion is exercised across pass AND fail and through the injected fs resolver.
 */
function fixtureCorpus(): Array<Record<string, unknown>> {
  const cleanRefs = ['src/alpha.ts:1-3', 'src/beta.ts:1-3', 'src/gamma.ts:1-3'];
  const clean: Record<string, unknown> = {
    title: 'Alpha module keeps imports one direction only',
    description: '中文简述：Alpha 模块保持单向 import，禁止反向引用。',
    content: {
      markdown: [
        '## Alpha 模块单向 import 约定',
        'Alpha 模块内的代码只向下引用，禁止把 beta / gamma 反向 import 回 alpha，',
        '保持分层清晰、便于替换与测试 (来源: src/alpha.ts:1)。新代码沿用同一方向即可。',
        '✅ Keep alpha module imports flowing one direction only.',
        '❌ Do not import beta or gamma back into alpha.',
      ].join('\n'),
      rationale: '单向 import 保持分层边界清晰，避免成环，便于独立测试与未来替换实现。',
    },
    kind: 'rule',
    trigger: '@alpha-one-direction-import',
    whenClause: 'When code inside the alpha module imports from another module.',
    doClause: 'Keep alpha module imports flowing one direction only.',
    dontClause: 'Do not import beta or gamma back into the alpha module.',
    sourceRefs: cleanRefs,
    reasoning: { sources: cleanRefs, confidence: 0.8 },
  };

  return [
    // 0: gate-clean → zero violations (tie must hold on the pass path).
    clean,
    // 1: stage-1 content — non-imperative doClause + missing dontClause + no ✅/❌ contrast.
    {
      ...clean,
      doClause: 'Persist the alpha mapping for compatibility reasons.',
      dontClause: undefined,
      content: {
        markdown: `Alpha module guidance without any contrast marker (来源: src/alpha.ts:1). ${'pad '.repeat(50)}`,
        rationale: '单向 import 保持分层边界清晰，避免成环，便于独立测试与未来替换实现。',
      },
    },
    // 2: stage-2 cheap grounding — bare source ref (no line range).
    {
      ...clean,
      sourceRefs: ['src/alpha.ts'],
      reasoning: { sources: ['src/alpha.ts'], confidence: 0.8 },
    },
    // 3: fs port — source ref file does not exist (SOURCE_REF_NOT_FOUND).
    {
      ...clean,
      sourceRefs: ['src/missing.ts:1-3'],
      reasoning: { sources: ['src/missing.ts:1-3'], confidence: 0.8 },
    },
    // 4: fs port — line range outside the file (SOURCE_REF_LINE_OUT_OF_RANGE).
    {
      ...clean,
      sourceRefs: ['src/alpha.ts:1-999'],
      reasoning: { sources: ['src/alpha.ts:1-999'], confidence: 0.8 },
    },
  ];
}

describe('P4 in-process wrapper parity — runInProcessRecipeAuthoringGate == direct Core validateAgainst', () => {
  it('opportunistic: wrapper verdict is byte-identical to direct Core validateAgainst (per item, full corpus)', () => {
    const corpus = fixtureCorpus();
    let totalViolations = 0;
    let cleanItems = 0;

    for (const item of corpus) {
      // wrapper resolves opportunistic for a dimensionless item and returns Core's verdict unmutated.
      const wrapperVerdict = runInProcessRecipeAuthoringGate(item, { projectRoot });
      const coreVerdict = directCoreVerdict(item, 'opportunistic', undefined);
      expect(wrapperVerdict).toEqual(coreVerdict);

      totalViolations += wrapperVerdict.length;
      if (wrapperVerdict.length === 0) {
        cleanItems += 1;
      }
    }

    // Non-vacuous tie: the tripwire must cover both a passing item and real violations.
    expect(totalViolations).toBeGreaterThan(0);
    expect(cleanItems).toBeGreaterThan(0);
  });

  it('the wrapper actually selects the opportunistic profile (dimensionless) — it never silently runs cold-start', () => {
    // 反平凡：opportunistic 与 cold-start 在含单文件 rule 候选时裁决不同（cold-start 多出 3-file 证据
    // 下限）。包装器无 dimensionId 时必须等于 opportunistic、不等于 cold-start。
    const singleFileItem = {
      ...fixtureCorpus()[0],
      sourceRefs: ['src/alpha.ts:1-3'],
      reasoning: { sources: ['src/alpha.ts:1-3'], confidence: 0.8 },
    };
    const wrapperVerdict = runInProcessRecipeAuthoringGate(singleFileItem, { projectRoot });
    expect(wrapperVerdict).toEqual(directCoreVerdict(singleFileItem, 'opportunistic', undefined));
    expect(wrapperVerdict).not.toEqual(directCoreVerdict(singleFileItem, 'cold-start', undefined));
  });

  it('cold-start (dimension-bearing): wrapper verdict equals direct Core validateAgainst with the cold-start profile', () => {
    // 携带 dimensionId 时包装器解析为 cold-start，仍是 Core validateAgainst 的忠实透传（含 3-file
    // 证据下限），证明 profile-resolution 分支也不改写裁决。
    const dimensionId = 'architecture';
    for (const item of fixtureCorpus()) {
      const wrapperVerdict = runInProcessRecipeAuthoringGate(item, { projectRoot, dimensionId });
      const coreVerdict = directCoreVerdict(item, 'cold-start', dimensionId);
      expect(wrapperVerdict).toEqual(coreVerdict);
    }
  });
});
