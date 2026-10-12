/**
 * E7 接受率治理测试：手写路径自动矫正（basename 唯一匹配台账真实形态）、
 * 证据驱动 scope 收窄、逐违规修复模板。
 */
import fs from 'node:fs';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import { describe, expect, test, vi } from 'vitest';
import { EvidenceLedgerStore } from '../src/agent/evidence/EvidenceLedgerStore.js';
import type { EvidenceLedgerLike } from '../src/tools/kernel/context.js';
import { prepareRecipeProductionItem } from '../src/tools/runtime/handlers/recipeProductionAdapter.js';
import {
  buildEvidenceCandidatesHint,
  buildViolationRepairTemplates,
  expandEvidenceRefsForSubmit,
  inferEvidenceRefsFromSources,
  repairStyleViolations,
  sanitizeSubmissionEvidence,
} from '../src/tools/runtime/handlers/submitEvidenceExpansion.js';
import { createTempProject } from './helpers/tempProject.js';

function makeWorkspace() {
  const projectRoot = createTempProject('sanitize-proj-');
  const dataRoot = createTempProject('sanitize-data-');
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
    // 真实丢弃不进 retainedUnresolved
    expect(withGood.retainedUnresolved).toEqual([]);

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

  test('I33 全丢回退：原列表原样交门禁，dropped 为空、retainedUnresolved 记录且同路径不重复', () => {
    const { projectRoot, ledger } = makeWorkspace();
    const allBad = sanitizeSubmissionEvidence(
      {
        kind: 'fact',
        sourceRefs: ['Never/Existed/zzz.ts:1'],
        reasoning: { sources: ['Never/Existed/zzz.ts:1'] },
      },
      { ledger, projectRoot }
    );
    expect((allBad.item.reasoning as { sources: string[] }).sources).toEqual([
      'Never/Existed/zzz.ts:1',
    ]);
    expect(allBad.item.sourceRefs).toEqual(['Never/Existed/zzz.ts:1']);
    // 一条都没丢——不能记成 dropped（日志与 evidence_sanitized 统计据此判定）
    expect(allBad.dropped).toEqual([]);
    expect(allBad.retainedUnresolved).toEqual(['Never/Existed/zzz.ts:1']);
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
  test('preserves braces and code fences inside repaired JSON strings', async () => {
    const { repairStyleViolations } = await import(
      '../src/tools/runtime/handlers/submitEvidenceExpansion.js'
    );
    const markdown = 'Use an opening brace { and a ```ts code fence';
    const result = await repairStyleViolations(
      { content: { markdown: 'before' } },
      [{ code: 'CONTENT_CONTRAST_MISSING' }],
      { chat: async () => JSON.stringify({ markdown }) },
      { positive: ['Use'], negative: ['Avoid'] }
    );
    expect(result?.content).toEqual({ markdown });
  });
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

describe('repairStyleViolations（I32：按违规码限定字段 + markdown 保真）', () => {
  const allowlist = { positive: ['Use'], negative: ['Avoid'] };
  const TAIL_MARKER = 'TAIL-SENTINEL (来源: lib/a.ts:1-3)';
  const CONTRAST_BLOCK =
    '✅ 正确：使用 import type 引入类型 (来源: lib/a.ts:1-3)\n❌ 错误：用普通 import 引入类型\n违反后果：类型依赖变成运行时依赖';

  /** 超过 1800 字符展示窗口的正文，尾部带不可丢失的标记（截断前后对照基准） */
  function longMarkdown(): string {
    return `## 类型导入隔离\n\n${'模块统一使用 import type 声明类型级导入，编译后完全擦除。'.repeat(110)}\n\n${TAIL_MARKER}`;
  }

  /** 从修复提示里取出模型实际看到的 markdown（展示窗口），模拟"照做"的模型 */
  function shownMarkdown(prompt: string): string {
    const line = prompt.split('\n').find((candidate) => candidate.startsWith('候选字段: '));
    if (!line) {
      throw new Error('repair prompt has no 候选字段 line');
    }
    return (JSON.parse(line.slice('候选字段: '.length)) as { markdown: string }).markdown;
  }

  function spyWarn() {
    const logger = Logger.getInstance();
    return vi.spyOn(logger, 'warn').mockImplementation(() => logger);
  }

  function warnedWith(warn: ReturnType<typeof spyWarn>, ...fragments: string[]): boolean {
    return warn.mock.calls.some(([message]) =>
      fragments.every((fragment) => String(message).includes(fragment))
    );
  }

  test('CONTENT_CONTRAST_MISSING：模型只返回 contrastBlock → 程序拼到完整原文末尾', async () => {
    const original = longMarkdown();
    expect(original.length).toBeGreaterThan(1800);
    const repaired = await repairStyleViolations(
      { title: 'T', doClause: 'Use x', content: { markdown: original, rationale: 'r' } },
      [{ code: 'CONTENT_CONTRAST_MISSING' }],
      { chat: async () => JSON.stringify({ contrastBlock: CONTRAST_BLOCK }) },
      allowlist
    );
    const next = repaired?.content as { markdown: string; rationale: string };
    expect(next.markdown.startsWith(original)).toBe(true);
    expect(next.markdown).toContain(TAIL_MARKER);
    expect(next.markdown.endsWith(CONTRAST_BLOCK)).toBe(true);
    expect(next.markdown.length).toBeGreaterThanOrEqual(original.length + CONTRAST_BLOCK.length);
    expect(next.rationale).toBe('r');
    expect(repaired).not.toHaveProperty('contrastBlock');
  });

  test('CONTENT_CONTRAST_MISSING：模型回显展示前缀+对比块 → 未展示尾部拼回，正文不截断', async () => {
    const original = longMarkdown();
    const repaired = await repairStyleViolations(
      { title: 'T', content: { markdown: original } },
      [{ code: 'CONTENT_CONTRAST_MISSING' }],
      {
        chat: async (prompt: string) =>
          JSON.stringify({ markdown: `${shownMarkdown(prompt)}\n\n${CONTRAST_BLOCK}` }),
      },
      allowlist
    );
    const next = (repaired?.content as { markdown: string }).markdown;
    expect(next.startsWith(original)).toBe(true);
    expect(next).toContain(TAIL_MARKER);
    expect(next.endsWith(CONTRAST_BLOCK)).toBe(true);
  });

  test('只报 DO_CLAUSE_NON_IMPERATIVE：模型顺带回显的 markdown 被丢弃并留痕，doClause 照常采纳', async () => {
    const original = longMarkdown();
    const warn = spyWarn();
    try {
      const repaired = await repairStyleViolations(
        {
          title: 'T',
          doClause: 'All types should use import type',
          content: { markdown: original },
        },
        [{ code: 'DO_CLAUSE_NON_IMPERATIVE' }],
        {
          chat: async (prompt: string) =>
            JSON.stringify({
              doClause: 'Use import type for type-only imports',
              markdown: `${shownMarkdown(prompt)}\n\n${CONTRAST_BLOCK}`,
            }),
        },
        allowlist
      );
      expect(repaired?.doClause).toBe('Use import type for type-only imports');
      expect((repaired?.content as { markdown: string }).markdown).toBe(original);
      expect(warnedWith(warn, '[style-repair] dropped field', 'markdown')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('GRAPH_REF_INVALID 长正文：返回值不以展示前缀开头 → markdown 丢弃；无其它字段时返回 null', async () => {
    const original = longMarkdown();
    const warn = spyWarn();
    try {
      const repaired = await repairStyleViolations(
        { title: 'T', content: { markdown: original } },
        [{ code: 'GRAPH_REF_INVALID' }],
        {
          chat: async () =>
            JSON.stringify({
              markdown: '## 改写后的短正文\n\n模块通过导入依赖另一模块。(来源: lib/a.ts:1-3)',
            }),
        },
        allowlist
      );
      expect(repaired).toBeNull();
      expect(warnedWith(warn, '[style-repair] dropped field', 'markdown')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('短正文（未超窗）GRAPH_REF_INVALID：模型看过全文，整体替换照常采纳', async () => {
    const original = '模块 A 的 callers 会 invokes 模块 B。(来源: lib/a.ts:1-3)';
    const rewritten = '模块 A 通过导入依赖模块 B。(来源: lib/a.ts:1-3)';
    const repaired = await repairStyleViolations(
      { title: 'T', content: { markdown: original } },
      [{ code: 'GRAPH_REF_INVALID' }],
      { chat: async () => JSON.stringify({ markdown: rewritten }) },
      allowlist
    );
    expect((repaired?.content as { markdown: string }).markdown).toBe(rewritten);
  });

  test('contrastBlock 缺 ✅/❌ 标记 → 丢弃；STAGE3_TITLE_TOO_GENERIC 只收 title，越界 doClause 丢弃', async () => {
    const warn = spyWarn();
    try {
      const noMarkers = await repairStyleViolations(
        { title: 'T', content: { markdown: '正文' } },
        [{ code: 'CONTENT_CONTRAST_MISSING' }],
        { chat: async () => JSON.stringify({ contrastBlock: '正确：A；错误：B' }) },
        allowlist
      );
      expect(noMarkers).toBeNull();
      expect(warnedWith(warn, '[style-repair] dropped field', 'contrastBlock')).toBe(true);

      const titleOnly = await repairStyleViolations(
        { title: 'Singleton pattern', doClause: 'Keep it', content: { markdown: '正文' } },
        [{ code: 'STAGE3_TITLE_TOO_GENERIC' }],
        {
          chat: async () =>
            JSON.stringify({
              title: 'Config loader Singleton pattern for AlembicAgent',
              doClause: 'Use something else',
            }),
        },
        allowlist
      );
      expect(titleOnly?.title).toBe('Config loader Singleton pattern for AlembicAgent');
      expect(titleOnly?.doClause).toBe('Keep it');
      expect(warnedWith(warn, '[style-repair] dropped field', 'doClause')).toBe(true);
    } finally {
      warn.mockRestore();
    }
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

describe('Recipe production adapter（bounded code only）', () => {
  test('只保留逐字匹配的 bounded snippet，绝不以首个 source 内容覆盖模型代码', () => {
    const projectRoot = createTempProject('corecode-');
    fs.mkdirSync(path.join(projectRoot, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'lib/a.ts'), 'L1\nconst real = 1;\nL3', 'utf8');
    const rejected = prepareRecipeProductionItem(
      {
        coreCode: 'model-paraphrased',
        content: { pattern: 'stale', rationale: 'r' },
        reasoning: { sources: ['lib/a.ts:2-2'] },
      },
      projectRoot
    );
    expect(rejected.item.coreCode).toBe('');
    expect((rejected.item.content as { pattern: string }).pattern).toBe('stale');
    expect(rejected.codeEvidence.accepted).toBe(false);

    const accepted = prepareRecipeProductionItem(
      { coreCode: 'const real = 1;', reasoning: { sources: ['lib/a.ts:2-2'] } },
      projectRoot
    );
    expect(accepted.item.coreCode).toBe('const real = 1;');
    expect(accepted.codeEvidence).toMatchObject({
      accepted: true,
      provenanceRef: 'lib/a.ts:2-2',
    });
  });
});

describe('门禁分层 v2（2026-07-04 用户裁定：证据硬门+风格 advisory 不阻断）', () => {
  async function submitFixture(overrides: Record<string, unknown>) {
    const { handle: handleKnowledge } = await import('../src/tools/runtime/handlers/knowledge.js');
    const projectRoot = createTempProject('gate-tier-');
    const dataRoot = createTempProject('gate-tier-data-');
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
      createOrStage: async (req: { items: Record<string, unknown>[] }) => {
        created.push(req.items[0]);
        return {
          created: [
            {
              id: 'id-1',
              title: String(req.items[0].title),
              lifecycle: 'pending',
              raw: req.items[0],
            },
          ],
          duplicates: [],
          rejected: [],
          merged: [],
          blocked: [],
          supersedeProposal: null,
          production: { capability: 'knowledge-submit', source: 'alembic-agent' },
        };
      },
      evaluateReadiness: async () => ({
        ready: false,
        schemaVersion: '1',
        profileHash: null,
        documentSetHash: null,
        violations: [{ code: 'retrieval.profile.missing', message: 'profile missing' }],
        warnings: [],
      }),
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

  test('refs 缺席但 sources 命中台账文件：机械自推断回填后收录（2026-07-05 拒收治理）', async () => {
    const { result, created } = await submitFixture({
      reasoning: {
        whyStandard: 'w',
        sources: ['lib/a.ts:1-3'],
        confidence: 0.9,
      },
    });
    // 引用了真实采集过的文件——推断只映射真实条目，事实面零发明，应收录而非硬拒
    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
  });

  test('维度运行缺 evidenceRefs 且 sources 均不在台账：EVIDENCE_REFS_REQUIRED 硬拒（核心保证）', async () => {
    const { result, created } = await submitFixture({
      reasoning: {
        whyStandard: 'w',
        sources: ['lib/zzz-not-captured.ts:1-3'],
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
    const dataRoot = createTempProject('labelless-');
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

  test('行号机械回填（run-7 M2）：缺 :line 的手写 source 从引用条目回填真实行号', async () => {
    const { sanitizeSubmissionEvidence } = await import(
      '../src/tools/runtime/handlers/submitEvidenceExpansion.js'
    );
    const dataRoot = createTempProject('backfill-');
    const projectRoot = createTempProject('backfill-root-');
    for (const rel of ['src/tools/index.ts', 'src/agent/index.ts', 'src/other.ts']) {
      fs.mkdirSync(path.dirname(path.join(projectRoot, rel)), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, rel), 'export {};\n', 'utf8');
    }
    const ledger = new EvidenceLedgerStore({
      dataRoot,
      jobId: 'j3',
      sessionId: 's3',
      dimensionId: 'ts-js-module',
    });
    ledger.append({
      tool: 'code.search',
      callId: 'c-s',
      content: '2 matches\nsrc/tools/index.ts:37: export * from "./kernel.js"\nsrc/other.ts:5: x',
    });
    ledger.append({
      tool: 'code.read',
      callId: 'c-r',
      file: 'src/agent/index.ts',
      range: { start: 10, end: 20 },
      content: 'ranged content',
    });
    const out = sanitizeSubmissionEvidence(
      {
        title: 't',
        reasoning: {
          evidenceRefs: ['E-1', 'E-2'],
          // 三形态：search 命中回填 / ranged 条目同文件回填 / 已带行号不动
          sources: ['src/tools/index.ts', 'src/agent/index.ts', 'src/other.ts:5-5'],
        },
      },
      { ledger, projectRoot }
    );
    const sources = (out.item.reasoning as { sources: string[] }).sources;
    expect(sources).toContain('src/tools/index.ts:37-37');
    expect(sources).toContain('src/agent/index.ts:10-20');
    expect(sources).toContain('src/other.ts:5-5');
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

describe('M2 采集形态（search 一等公民 + terminal 归属）', () => {
  test('P1b：file-有-range-无的 search 条目派生首 2 命中行标签', async () => {
    const { expandEvidenceRefsForSubmit } = await import(
      '../src/tools/runtime/handlers/submitEvidenceExpansion.js'
    );
    const dataRoot = createTempProject('m2-derive-');
    const ledger = new EvidenceLedgerStore({
      dataRoot,
      jobId: 'j4',
      sessionId: 's4',
      dimensionId: 'ts-js-module',
    });
    // per-file search 采集形态：file 在场、无 range、content 行首 "NN: text"
    ledger.append({
      tool: 'code.search',
      callId: 'c-pf',
      file: 'lib/a.ts',
      content: '3: export const a = 1;\n17: export const b = 2;\n29: export const c = 3;',
    });
    const out = expandEvidenceRefsForSubmit(
      { title: 't', reasoning: { evidenceRefs: ['E-1'] } },
      { ledger, projectRoot: '/no-fs-touch' }
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.expandedSources).toEqual(['lib/a.ts:3-3', 'lib/a.ts:17-17']);
      expect(out.resolvedRefs).toBe(1);
    }
  });

  test('P1c：terminal.exec 命令内仓相对路径 token 归属为 file', async () => {
    const { captureEvidenceFromEnvelope } = await import(
      '../src/agent/evidence/EvidenceCapture.js'
    );
    const dataRoot = createTempProject('m2-term-');
    const ledger = new EvidenceLedgerStore({
      dataRoot,
      jobId: 'j5',
      sessionId: 's5',
      dimensionId: 'architecture',
    });
    const entries = captureEvidenceFromEnvelope(
      ledger,
      {
        id: 'c-t',
        name: 'terminal',
        args: { action: 'exec', command: 'cat config/layer-contract.json' },
      } as never,
      { ok: true, text: '{ "layers": [] }' } as never
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].file).toBe('config/layer-contract.json');
    // I34：terminal 输出里的数字键（YAML/JSON 的 "404:"）不是源文件行号——
    // 归属到文件的 terminal 条目展开时只产出裸文件标签，不再伪造 file:404-404。
    const yaml = captureEvidenceFromEnvelope(
      ledger,
      {
        id: 'c-t-yaml',
        name: 'terminal',
        args: { action: 'exec', command: 'cat config/http-status.yaml' },
      } as never,
      { ok: true, text: 'statuses:\n  200: OK\n  404: Not Found' } as never
    );
    expect(yaml).toHaveLength(1);
    expect(yaml[0].file).toBe('config/http-status.yaml');
    const expanded = expandEvidenceRefsForSubmit(
      { title: 't', reasoning: { evidenceRefs: [yaml[0].id] } },
      { ledger, projectRoot: '/no-fs-touch' }
    );
    expect(expanded.ok).toBe(true);
    if (expanded.ok) {
      expect(expanded.expandedSources).toEqual(['config/http-status.yaml']);
    }
    // 绝对路径/URL 不归属
    const none = captureEvidenceFromEnvelope(
      ledger,
      {
        id: 'c-t2',
        name: 'terminal',
        args: { action: 'exec', command: 'curl https://x.dev/a.ts' },
      } as never,
      { ok: true, text: 'ok' } as never
    );
    expect(none[0]?.file).toBeUndefined();
  });
});

function makeP19Ledger(prefix: string): EvidenceLedgerStore {
  return new EvidenceLedgerStore({
    dataRoot: createTempProject(prefix),
    jobId: 'j-p19',
    sessionId: 's-p19',
    dimensionId: 'ts-js-module',
  });
}

describe('L4-P19 I33：候选提示与引用推断的台账条目选择', () => {
  test('候选提示：先 search 后 read 同一文件时展示带区间的 read 条目 E-x=file:start-end', () => {
    const ledger = makeP19Ledger('p19-hint-');
    ledger.append({
      tool: 'code.search',
      callId: 's1',
      file: 'lib/a.ts',
      content: '3: const x = 1;',
    });
    ledger.append({
      tool: 'code.read',
      callId: 'r1',
      file: 'lib/a.ts',
      range: { start: 3, end: 4 },
      content: 'const x = 1;\nconst y = 2;',
    });
    const hint = buildEvidenceCandidatesHint(ledger);
    expect(hint).toContain('E-2=lib/a.ts:3-4');
    expect(hint).toContain('台账共 1 个可引用文件');
    // 已有带区间条目的文件不再作为裸文件名重复出现
    expect(hint).not.toContain('其它可引用文件');
    expect(hint).toContain('reasoning.evidenceRefs');
  });

  test('候选提示：超过 5 个带区间文件时展示最新 5 个，其余文件只补裸文件名', () => {
    const ledger = makeP19Ledger('p19-hint-many-');
    for (let i = 0; i < 8; i += 1) {
      ledger.append({
        tool: 'code.read',
        callId: `r${i}`,
        file: `lib/f${i}.ts`,
        range: { start: 1, end: 2 },
        content: 'a\nb',
      });
    }
    const hint = buildEvidenceCandidatesHint(ledger);
    for (let i = 3; i < 8; i += 1) {
      expect(hint).toContain(`E-${i + 1}=lib/f${i}.ts:1-2`);
    }
    for (let i = 0; i < 3; i += 1) {
      expect(hint).not.toContain(`E-${i + 1}=lib/f${i}.ts`);
      expect(hint).toContain(`lib/f${i}.ts`);
    }
    expect(hint).toContain('台账共 8 个可引用文件');
    // 最新优先：f7 排在 f3 之前
    expect(hint.indexOf('lib/f7.ts')).toBeLessThan(hint.indexOf('lib/f3.ts'));
  });

  test('引用推断：台账先有 5 条子串命中时仍推断出精确的 src/app.ts', () => {
    const ledger = makeP19Ledger('p19-infer-');
    for (const file of [
      'src/app.tsx',
      'packages/web/src/app.ts',
      'apps/admin/src/app.ts',
      'legacy/src/app.tsx',
      'src/app.ts.orig',
    ]) {
      ledger.append({
        tool: 'code.read',
        callId: file,
        file,
        range: { start: 1, end: 1 },
        content: 'x',
      });
    }
    ledger.append({
      tool: 'code.read',
      callId: 'exact',
      file: 'src/app.ts',
      range: { start: 1, end: 2 },
      content: 'a\nb',
    });
    expect(
      inferEvidenceRefsFromSources({ reasoning: { sources: ['src/app.ts:1-2'] } }, ledger)
    ).toEqual(['E-6']);
  });

  test('引用推断：同文件多条目优先最新带区间条目，其次最新 file-only 条目', () => {
    const ledger = makeP19Ledger('p19-infer-latest-');
    ledger.append({ tool: 'code.search', callId: 's1', file: 'lib/a.ts', content: '3: x' }); // E-1
    ledger.append({
      tool: 'code.read',
      callId: 'r1',
      file: 'lib/a.ts',
      range: { start: 1, end: 3 },
      content: 'a\nb\nc',
    }); // E-2
    ledger.append({
      tool: 'code.read',
      callId: 'r2',
      file: 'lib/a.ts',
      range: { start: 5, end: 6 },
      content: 'e\nf',
    }); // E-3：最新带区间条目
    ledger.append({ tool: 'code.search', callId: 's2', file: 'lib/a.ts', content: '9: y' }); // E-4：更新但无区间
    ledger.append({ tool: 'code.search', callId: 's3', file: 'lib/b.ts', content: '1: p' }); // E-5
    ledger.append({ tool: 'code.search', callId: 's4', file: 'lib/b.ts', content: '2: q' }); // E-6：最新 file-only
    expect(
      inferEvidenceRefsFromSources(
        { reasoning: { sources: ['lib/a.ts:5-6', 'lib/b.ts', 'lib/a.ts:1-3'] } },
        ledger
      )
    ).toEqual(['E-3', 'E-6']);
  });

  test('引用推断：每文件一条、总数上限 5', () => {
    const ledger = makeP19Ledger('p19-infer-cap-');
    const sources: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      ledger.append({
        tool: 'code.read',
        callId: `r${i}`,
        file: `lib/g${i}.ts`,
        range: { start: 1, end: 1 },
        content: 'x',
      });
      sources.push(`lib/g${i}.ts:1-1`);
    }
    expect(inferEvidenceRefsFromSources({ reasoning: { sources } }, ledger)).toEqual([
      'E-1',
      'E-2',
      'E-3',
      'E-4',
      'E-5',
    ]);
  });
});

describe('L4-P19 I33：全丢回退在 authoring 单独留痕，不计 evidence_sanitized', () => {
  test('引用有效但手写 sources 全部无法解析：日志写 retainedUnresolved，不写 dropped，不计数', async () => {
    const { handle: handleKnowledge } = await import('../src/tools/runtime/handlers/knowledge.js');
    const projectRoot = createTempProject('p19-auth-');
    const ledger = makeP19Ledger('p19-auth-data-');
    // 无 file 的 terminal 条目：引用可解析（resolvedRefs=1）但展不出 source 标签
    ledger.append({ tool: 'terminal.exec', callId: 't1', content: 'npm ls output' });
    const sharedState: Record<string, unknown> = {};
    const logger = Logger.getInstance();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      const ctx = {
        recipeGateway: {
          createOrStage: async () => {
            throw new Error('gateway must not be reached in this fixture');
          },
        },
        projectRoot,
        runtime: { evidenceLedger: ledger, sharedState },
        sessionStore: null,
      } as unknown as Parameters<typeof handleKnowledge>[2];
      await handleKnowledge(
        'submit',
        {
          title: '终端输出证据候选',
          description: '模块使用 import type 声明类型级导入，编译后擦除。',
          content: {
            markdown: '## 类型导入隔离\n\n模块统一使用 import type 声明类型级导入。',
            rationale: '类型与运行时依赖解耦。',
          },
          kind: 'fact',
          trigger: 'typescript type import',
          whenClause: '当模块只消费类型不消费运行时值时',
          doClause: 'Use import type for type-only imports',
          dontClause: 'Do not use a value import for type-only usage',
          reasoning: {
            whyStandard: 'w',
            sources: ['Never/Existed/zzz.ts:1'],
            confidence: 0.9,
            evidenceRefs: ['E-1'],
          },
        },
        ctx
      );
      const messages = [...info.mock.calls, ...warn.mock.calls].map(([message]) => String(message));
      expect(
        messages.some(
          (message) =>
            message.includes('retainedUnresolved=[Never/Existed/zzz.ts:1]') &&
            message.includes('终端输出证据候选')
        )
      ).toBe(true);
      expect(messages.some((message) => message.includes('evidence sanitized for'))).toBe(false);
      const counters = sharedState._sessionCounters as
        | { submitRepairStats?: Record<string, number> }
        | undefined;
      expect(counters?.submitRepairStats?.evidence_sanitized).toBeUndefined();
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('L4-P19 I34：file-only 条目只有 code.search 派生命中行标签', () => {
  test('terminal.exec 条目内容含 "404:" 时只产出裸文件标签，并留 debug 诊断', () => {
    const ledger = makeP19Ledger('p19-term-');
    ledger.append({
      tool: 'terminal.exec',
      callId: 't1',
      file: 'src/http/statusText.ts',
      content: "export const statusText = {\n  200: 'OK',\n  404: 'Not Found',\n};",
    });
    const logger = Logger.getInstance();
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
    try {
      const out = expandEvidenceRefsForSubmit(
        { title: 't', reasoning: { evidenceRefs: ['E-1'] } },
        { ledger, projectRoot: '/no-fs-touch' }
      );
      expect(out.ok).toBe(true);
      if (out.ok) {
        expect(out.expandedSources).toEqual(['src/http/statusText.ts']);
        expect(out.resolvedRefs).toBe(1);
      }
      expect(
        debug.mock.calls.some(([message]) => {
          const text = String(message);
          return (
            text.includes('E-1') &&
            text.includes('terminal.exec') &&
            text.includes('bare file label')
          );
        })
      ).toBe(true);
    } finally {
      debug.mockRestore();
    }
  });

  test('code.read 降级视图（file-only）同样不按 "NN:" 派生行号', () => {
    const ledger = makeP19Ledger('p19-read-view-');
    ledger.append({
      tool: 'code.read',
      callId: 'r1',
      file: 'lib/a.ts',
      content: '12: function a() {}\n40: function b() {}',
    });
    const out = expandEvidenceRefsForSubmit(
      { title: 't', reasoning: { evidenceRefs: ['E-1'] } },
      { ledger, projectRoot: '/no-fs-touch' }
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.expandedSources).toEqual(['lib/a.ts']);
    }
  });

  test('台账实现不提供 tool 字段时保守退化为裸文件标签', () => {
    const entry = { id: 'E-1', file: 'lib/a.ts', content: '3: export const a = 1;' };
    const ledger: EvidenceLedgerLike = {
      get: (ref) => (ref === 'E-1' ? entry : null),
      search: () => [entry],
      listRecent: () => [entry],
      stats: () => ({ entries: 1, distinctFiles: 1 }),
      checkFreshness: () => 'unknown',
    };
    const out = expandEvidenceRefsForSubmit(
      { title: 't', reasoning: { evidenceRefs: ['E-1'] } },
      { ledger, projectRoot: '/no-fs-touch' }
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.expandedSources).toEqual(['lib/a.ts']);
    }
  });
});
