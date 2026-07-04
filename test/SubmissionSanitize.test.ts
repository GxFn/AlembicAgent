/**
 * E7 接受率治理测试：手写路径自动矫正（basename 唯一匹配台账真实形态）、
 * 证据驱动 scope 收窄、逐违规修复模板。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import {
  buildViolationRepairTemplates,
  sanitizeSubmissionEvidence,
} from '../src/tools/runtime/handlers/submitEvidenceExpansion.js';

function makeWorkspace() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-proj-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-data-'));
  // 多仓形态：真实文件在 AlembicAgent/config/ 下（模型常漏写仓库前缀）
  fs.mkdirSync(path.join(projectRoot, 'AlembicAgent/config'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'AlembicAgent/config/agent-public-api-boundary.json'),
    '{}',
    'utf8'
  );
  const ledger = new EvidenceLedgerStore({
    dataRoot,
    jobId: 'job_1',
    sessionId: 'sess_1',
    dimensionId: 'ts-js-module',
  });
  ledger.append({
    tool: 'code.read',
    callId: 'c1',
    file: 'AlembicAgent/config/agent-public-api-boundary.json',
    range: { start: 1, end: 1 },
    content: '{}',
  });
  ledger.append({
    tool: 'code.read',
    callId: 'c2',
    file: 'AlembicAgent/src/index.ts',
    content: 'export {};',
  });
  return { projectRoot, ledger };
}

describe('sanitizeSubmissionEvidence（E7）', () => {
  test('漏仓库前缀的手写路径按 basename 唯一匹配自动矫正（含行号后缀保留）', () => {
    const { projectRoot, ledger } = makeWorkspace();
    const result = sanitizeSubmissionEvidence(
      {
        kind: 'fact',
        sourceRefs: ['config/agent-public-api-boundary.json:1-1'],
        reasoning: { sources: ['config/agent-public-api-boundary.json:1-1'] },
      },
      { ledger, projectRoot }
    );
    const reasoning = result.item.reasoning as { sources: string[] };
    expect(reasoning.sources).toEqual(['AlembicAgent/config/agent-public-api-boundary.json:1-1']);
    expect(result.item.sourceRefs).toEqual([
      'AlembicAgent/config/agent-public-api-boundary.json:1-1',
    ]);
    expect(result.corrected).toHaveLength(2);
  });

  test('无法唯一匹配的坏引用：有其它可解析引用时丢弃，否则整列表保留交门禁', () => {
    const { projectRoot, ledger } = makeWorkspace();
    const withGood = sanitizeSubmissionEvidence(
      {
        kind: 'fact',
        sourceRefs: [],
        reasoning: {
          sources: ['AlembicAgent/src/index.ts:1', 'Never/Existed/agent.ts:1-7'],
        },
      },
      { ledger, projectRoot }
    );
    expect((withGood.item.reasoning as { sources: string[] }).sources).toEqual([
      'AlembicAgent/src/index.ts:1',
    ]);
    expect(withGood.dropped).toEqual(['Never/Existed/agent.ts:1-7']);

    const allBad = sanitizeSubmissionEvidence(
      {
        kind: 'fact',
        sourceRefs: [],
        reasoning: { sources: ['Never/Existed/zzz.ts:1'] },
      },
      { ledger, projectRoot }
    );
    expect((allBad.item.reasoning as { sources: string[] }).sources).toEqual([
      'Never/Existed/zzz.ts:1',
    ]);
  });

  test('证据驱动 scope 收窄：rule 证据 <3 文件自动 narrow；已声明/fact/≥3 不动', () => {
    const { projectRoot, ledger } = makeWorkspace();
    const narrowed = sanitizeSubmissionEvidence(
      {
        kind: 'rule',
        sourceRefs: [],
        reasoning: { sources: ['AlembicAgent/src/index.ts:1'] },
      },
      { ledger, projectRoot }
    );
    expect(narrowed.scopedNarrow).toBe(true);
    expect(narrowed.item.scope).toBe('narrow');

    const declared = sanitizeSubmissionEvidence(
      {
        kind: 'rule',
        scope: 'file-local',
        sourceRefs: [],
        reasoning: { sources: ['AlembicAgent/src/index.ts:1'] },
      },
      { ledger, projectRoot }
    );
    expect(declared.scopedNarrow).toBe(false);
    expect(declared.item.scope).toBe('file-local');

    const fact = sanitizeSubmissionEvidence(
      { kind: 'fact', sourceRefs: [], reasoning: { sources: ['AlembicAgent/src/index.ts:1'] } },
      { ledger, projectRoot }
    );
    expect(fact.scopedNarrow).toBe(false);
  });

  test('无台账：零行为直通', () => {
    const item = { kind: 'rule', reasoning: { sources: ['x.ts:1'] } };
    const result = sanitizeSubmissionEvidence(item, { ledger: null, projectRoot: '/tmp' });
    expect(result.item).toBe(item);
    expect(result.corrected).toEqual([]);
  });
});

describe('repairStyleViolations（E7-R 修复子调用）', () => {
  const allowlist = { positive: ['使用', '统一'], negative: ['避免'] };
  const item = {
    title: 'T',
    doClause: '所有类型导入必须 import type',
    content: { markdown: '正文', rationale: 'r' },
  };

  test('provider 返回窄 JSON→仅合并给定字段', async () => {
    const { repairStyleViolations } = await import(
      '../src/tools/runtime/handlers/submitEvidenceExpansion.js'
    );
    const provider = {
      chat: async () => '前置说明 {"doClause":"使用 import type 隔离类型导入"} 后缀',
    };
    const repaired = await repairStyleViolations(
      item,
      [{ code: 'DO_CLAUSE_NON_IMPERATIVE' }],
      provider,
      allowlist
    );
    expect(repaired?.doClause).toBe('使用 import type 隔离类型导入');
    expect(repaired?.title).toBe('T');
    expect((repaired?.content as { rationale: string }).rationale).toBe('r');
  });

  test('provider 缺席/返回垃圾/抛错→null（零影响原拒绝路径）', async () => {
    const { repairStyleViolations } = await import(
      '../src/tools/runtime/handlers/submitEvidenceExpansion.js'
    );
    expect(
      await repairStyleViolations(item, [{ code: 'DO_CLAUSE_NON_IMPERATIVE' }], null, allowlist)
    ).toBeNull();
    expect(
      await repairStyleViolations(
        item,
        [{ code: 'DO_CLAUSE_NON_IMPERATIVE' }],
        { chat: async () => 'no json here' },
        allowlist
      )
    ).toBeNull();
    expect(
      await repairStyleViolations(
        item,
        [{ code: 'DO_CLAUSE_NON_IMPERATIVE' }],
        {
          chat: async () => {
            throw new Error('boom');
          },
        },
        allowlist
      )
    ).toBeNull();
  });

  test('isStyleRepairable：纯风格类 true，混证据类 false', async () => {
    const { isStyleRepairable } = await import(
      '../src/tools/runtime/handlers/submitEvidenceExpansion.js'
    );
    expect(
      isStyleRepairable([
        { code: 'DO_CLAUSE_NON_IMPERATIVE' },
        { code: 'CONTENT_CONTRAST_MISSING' },
      ])
    ).toBe(true);
    expect(
      isStyleRepairable([{ code: 'DO_CLAUSE_NON_IMPERATIVE' }, { code: 'SOURCE_REF_NOT_FOUND' }])
    ).toBe(false);
    expect(isStyleRepairable([])).toBe(false);
  });
});

describe('buildViolationRepairTemplates（E7）', () => {
  test('风格/措辞类违规给出照抄即过模板；无命中返回空串', () => {
    const allowlist = { positive: ['使用', '统一', '禁止'], negative: ['避免', '不要'] };
    const text = buildViolationRepairTemplates(
      [
        { code: 'DO_CLAUSE_NON_IMPERATIVE' },
        { code: 'CONTENT_CONTRAST_MISSING' },
        { code: 'GRAPH_REF_INVALID' },
      ],
      allowlist
    );
    expect(text).toContain('修复模板[doClause]');
    expect(text).toContain('使用/统一/禁止');
    expect(text).toContain('✅ 正确');
    expect(text).toContain('调用链');
    expect(buildViolationRepairTemplates([{ code: 'SNIPPET_MISMATCH' }], allowlist)).toBe('');
  });
});

describe('replaceCoreCodeFromSources（E7-D SNIPPET 确定性替换）', () => {
  test('首个可解析带区间 source 的真实内容覆盖 coreCode；无区间/越界返回 null', async () => {
    const { replaceCoreCodeFromSources } = await import(
      '../src/tools/runtime/handlers/submitEvidenceExpansion.js'
    );
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corecode-'));
    fs.mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'lib/a.ts'), 'L1\nconst real = 1;\nL3', 'utf8');
    const replaced = replaceCoreCodeFromSources(
      {
        coreCode: 'model-paraphrased',
        content: { pattern: 'stale', rationale: 'r' },
        reasoning: { sources: ['lib/a.ts:2-2'] },
      },
      projectRoot
    );
    expect(replaced?.coreCode).toBe('const real = 1;');
    expect((replaced?.content as { pattern: string }).pattern).toBe('const real = 1;');
    expect((replaced?.content as { rationale: string }).rationale).toBe('r');

    expect(
      replaceCoreCodeFromSources({ reasoning: { sources: ['lib/a.ts'] } }, projectRoot)
    ).toBeNull();
    expect(
      replaceCoreCodeFromSources({ reasoning: { sources: ['lib/a.ts:99-100'] } }, projectRoot)
    ).toBeNull();
  });
});

describe('门禁分层 v2（2026-07-04 用户裁定：证据硬门+风格 advisory 不阻断）', () => {
  async function submitFixture(overrides: Record<string, unknown>) {
    const { handle: handleKnowledge } = await import('../src/tools/runtime/handlers/knowledge.js');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-tier-'));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-tier-data-'));
    fs.mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, 'lib/a.ts'),
      "import type { X } from './x.js';\nexport const a = 1;\nexport const b = 2;",
      'utf8'
    );
    const ledger = new EvidenceLedgerStore({
      dataRoot,
      jobId: 'j1',
      sessionId: 's1',
      dimensionId: 'ts-js-module',
    });
    ledger.append({
      tool: 'code.read',
      callId: 'c1',
      file: 'lib/a.ts',
      range: { start: 1, end: 3 },
      content: "import type { X } from './x.js';\nexport const a = 1;\nexport const b = 2;",
    });
    const created: Record<string, unknown>[] = [];
    const gateway = {
      create: async (req: { items: Record<string, unknown>[] }) => {
        created.push(req.items[0]);
        return {
          created: [{ id: 'id-1', title: String(req.items[0].title) }],
          duplicates: [],
          rejected: [],
          blocked: [],
        };
      },
    };
    const params = {
      title: '类型导入使用 ImportType 严格隔离',
      description: '模块使用 import type 声明类型级导入，编译后擦除。',
      content: {
        markdown:
          "## 类型导入隔离\n\n模块统一使用 import type 声明类型级导入，TypeScript 编译后完全擦除，不产生任何运行时引用。这样做保证了类型安全与打包体积解耦，消费方不会因为引用类型而意外引入运行时依赖，打包器也能对纯类型模块做彻底的摇树优化。项目中所有仅消费类型的模块都遵循这一约定，形成一致的导入风格与可审计的依赖关系。\n\n```typescript\nimport type { X } from './x.js';\n```\n(来源: lib/a.ts:1-3)\n\n适用于所有仅类型消费场景；运行时需要值时改用普通 import 并显式声明依赖。违反该约定会让类型依赖悄悄变成运行时依赖，增大产物体积并引入不必要的模块加载开销。",
        rationale:
          '类型与运行时依赖解耦：import type 编译期完全擦除保证零运行时引用，打包体积可控，且消费方的依赖关系清晰可审计、便于长期维护。',
      },
      kind: 'fact',
      trigger: 'typescript type import',
      whenClause: '当模块只消费类型不消费运行时值时',
      doClause: '所有类型级导入都应该用 import type 声明',
      dontClause: '不要在仅类型消费场景用普通 import 引入类型',
      reasoning: {
        whyStandard: '类型导入不产生运行时引用。',
        sources: ['lib/a.ts:1-3'],
        confidence: 0.9,
        evidenceRefs: ['E-1'],
      },
      ...overrides,
    };
    const ctx = {
      recipeGateway: gateway,
      projectRoot,
      runtime: { evidenceLedger: ledger },
      sessionStore: null,
    } as unknown as Parameters<typeof handleKnowledge>[2];
    const result = await handleKnowledge('submit', params, ctx);
    return { result, created };
  }

  test('软违规（非祈使 doClause）不再阻断：advisory 随候选入库', async () => {
    const { result, created } = await submitFixture({});
    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
    const reasoning = created[0].reasoning as { styleAdvisories?: string[] };
    // 修复子调用无 provider（ctx.runtime.aiProvider 缺席）→ 直接降级 advisory
    expect(reasoning.styleAdvisories?.length).toBeGreaterThan(0);
    // 中文 doClause → DO_CLAUSE_NON_ENGLISH（软）；对比块缺失 CONTENT_CONTRAST_MISSING（软）
    expect(reasoning.styleAdvisories?.join(' ')).toContain('DO_CLAUSE_NON_ENGLISH');
  });

  test('维度运行缺 evidenceRefs：EVIDENCE_REFS_REQUIRED 硬拒（核心保证）', async () => {
    const { result, created } = await submitFixture({
      reasoning: {
        whyStandard: 'w',
        sources: ['lib/a.ts:1-3'],
        confidence: 0.9,
      },
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('EVIDENCE_REFS_REQUIRED');
    expect(created).toHaveLength(0);
  });

  test('硬违规（捏造引用）仍全力度拒绝', async () => {
    const { result, created } = await submitFixture({
      reasoning: {
        whyStandard: 'w',
        sources: ['lib/a.ts:1-3'],
        confidence: 0.9,
        evidenceRefs: ['E-99'],
      },
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('无法解析');
    expect(created).toHaveLength(0);
  });
});

describe('EVIDENCE_REFS_REQUIRED 以 resolvedRefs 判定（run-6 无 file 条目误杀回归钉）', () => {
  test('引用有效但全为无 file 条目（search 类）：不触发 EVIDENCE_REFS_REQUIRED，手写 sources 走门禁', async () => {
    const { expandEvidenceRefsForSubmit } = await import(
      '../src/tools/runtime/handlers/submitEvidenceExpansion.js'
    );
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'labelless-'));
    const ledger = new EvidenceLedgerStore({
      dataRoot,
      jobId: 'j2',
      sessionId: 's2',
      dimensionId: 'ts-js-module',
    });
    // 模拟 run-6 实况：code.search 采集条目无 file/range（原样多文件命中文本）
    ledger.append({
      tool: 'code.search',
      callId: 'c-search',
      content: '3 matches\nlib/a.ts:1: import type { X }\nlib/b.ts:2: export const y',
    });
    const expansion = expandEvidenceRefsForSubmit(
      { title: 't', reasoning: { evidenceRefs: ['E-1'], sources: ['lib/a.ts:1-1'] } },
      { ledger, projectRoot: '/nonexistent-root-not-touched' }
    );
    expect(expansion.ok).toBe(true);
    if (expansion.ok) {
      // 关键分离：引用解析成功（证据在场）但展不出 file:line 标签
      expect(expansion.resolvedRefs).toBe(1);
      expect(expansion.expandedSources).toHaveLength(0);
    }
  });

  test('refs 缺席时 resolvedRefs=0（EVIDENCE_REFS_REQUIRED 仍拦截该形态）', async () => {
    const { expandEvidenceRefsForSubmit } = await import(
      '../src/tools/runtime/handlers/submitEvidenceExpansion.js'
    );
    const expansion = expandEvidenceRefsForSubmit(
      { title: 't', reasoning: { sources: ['lib/a.ts:1-1'] } },
      { ledger: null, projectRoot: '/tmp' }
    );
    expect(expansion.ok).toBe(true);
    if (expansion.ok) {
      expect(expansion.resolvedRefs).toBe(0);
    }
  });
});
