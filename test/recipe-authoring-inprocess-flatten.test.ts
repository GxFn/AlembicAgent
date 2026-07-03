/**
 * P1.4b in-process flatten (CG-4) acceptance suite.
 *
 * 覆盖四块（与任务卡接受口径对应）：
 *  1. producer-prompt-renders-from-module —— Producer 提示由 renderGuidance('in-process') 渲染，
 *     与 validateAgainst 读取同一 gateRules() 表（producer-prompt-first，规则同源不漂移）。
 *  2. in-process gate re-point —— runInProcessRecipeAuthoringGate 用 validateAgainst(stage:'all',
 *     path:'in-process') + 注入 in-process fs resolver；profile 由上下文解析（cold-start vs
 *     opportunistic 差异：3-file 证据下限 / session-scope 仅 cold-start）。
 *  3. currently-passing-corpus regression (§C.4) —— 旧 length-only 门槛下能过的候选，过新的
 *     opportunistic 门禁后只新增「内容质量 + 廉价来源接地」类拒绝，绝不出现 3-file 证据下限
 *     (INSUFFICIENT_EVIDENCE) 或 session-scope (SESSION_NOT_FOUND/WRONG_SCOPE) —— 证明收紧是
 *     有界的。
 *  4. host-vs-in-process parity (§12.5 standing tripwire) —— 同一 corpus / 同一 profile / 同一
 *     resolver 下，host-agent 路径与 in-process 路径的 validateAgainst 裁决逐字节一致（path 标签
 *     不得改变裁决）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type RecipeAuthoringProfile,
  type RecipeAuthoringViolation,
  renderGuidance,
  validateAgainst,
} from '@alembic/core/knowledge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvidenceEntry } from '../src/agent/evidence/EvidenceCollector.js';
import {
  buildCodeContextSection,
  buildProducerPromptV2,
  PRODUCER_SYSTEM_PROMPT,
} from '../src/agent/prompts/insightProducer.js';
import {
  createInProcessSourceRefResolver,
  formatRecipeAuthoringViolations,
  runInProcessRecipeAuthoringGate,
} from '../src/tools/runtime/handlers/recipeAuthoringGate.js';

// 真实临时项目，让 in-process fs resolver 的来源接地（存在/越界）可确定性触发，不依赖仓库文件行数。
let projectRoot: string;

beforeAll(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'agent-inproc-flatten-'));
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

function codesOf(violations: RecipeAuthoringViolation[]): string[] {
  return violations.map((violation) => violation.code).sort();
}

/**
 * Gate-clean 候选：三处不同来源文件 + 行范围（满足 cold-start 3-file 证据下限）、祈使
 * doClause/dontClause、✅❌ 对比、markdown ≥200 含文件引用、无 placeholder/无 relationship 主张。
 * 在 opportunistic 与 cold-start 两档下都应零违规。
 */
function cleanRecipe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    sourceRefs: ['src/alpha.ts:1-3', 'src/beta.ts:1-3', 'src/gamma.ts:1-3'],
    reasoning: {
      sources: ['src/alpha.ts:1-3', 'src/beta.ts:1-3', 'src/gamma.ts:1-3'],
      confidence: 0.8,
    },
    ...overrides,
  };
}

describe('P1.4b producer-prompt-first (renders from RecipeAuthoringSpec module)', () => {
  function buildPrompt(): string {
    return buildProducerPromptV2(
      {
        analysisText: 'Alpha module imports flow one direction only.',
        evidenceMap: new Map(),
        findings: [{ finding: 'Alpha module boundary', importance: 8 }],
        negativeSignals: [],
        referencedFiles: ['src/alpha.ts'],
      },
      { id: 'architecture', label: 'Architecture' },
      { name: 'Demo' }
    );
  }

  it('surfaces the authoritative gate rules from renderGuidance (not hand-written drift)', () => {
    const prompt = buildPrompt();
    const guidance = renderGuidance('in-process', undefined, 'cold-start');

    // 门禁规则区块与祈使动词白名单只可能来自 renderGuidance —— 旧手写 STYLE_GUIDE/字段契约没有它们。
    expect(prompt).toContain('提交校验规则（与门禁完全一致）');
    expect(prompt).toContain('doClause 允许的祈使动词');

    // 关键证明：逐条门禁规则文本与 Core gateRules() 同源 —— 任一规则措辞改动会同时反映在两侧。
    const imperativeRule = guidance.rules.find((rule) => rule.id === 'clause-imperative');
    const contrastRule = guidance.rules.find((rule) => rule.id === 'content-contrast');
    expect(imperativeRule).toBeDefined();
    expect(contrastRule).toBeDefined();
    expect(prompt).toContain(imperativeRule?.guidance ?? '__rule_text_missing__');
    expect(prompt).toContain(contrastRule?.guidance ?? '__rule_text_missing__');
  });

  it('renders the cold-start evidence floor the bootstrap Producer actually faces', () => {
    const prompt = buildPrompt();
    // Producer 运行于 bootstrap 冷启动语境（提交携带 dimensionId → cold-start），故提示必须展示
    // 3-file 证据下限，否则 Producer 会在不知情下被 floor 拒绝。
    expect(prompt).toContain('证据下限');
  });

  it('still surfaces the spec-sourced required-field checklist', () => {
    const prompt = buildPrompt();
    expect(prompt).toContain('knowledge.submit 必填字段');
    for (const field of ['title', 'content.markdown', 'reasoning.sources', 'doClause']) {
      expect(prompt).toContain(`- ${field}:`);
    }
  });
});

describe('P1.4b in-process gate re-point (validateAgainst, profile-resolved)', () => {
  it('passes a gate-clean opportunistic candidate (content + cheap grounding satisfied)', () => {
    const violations = runInProcessRecipeAuthoringGate(cleanRecipe(), { projectRoot });
    expect(violations).toEqual([]);
  });

  it('enforces content gates in-process: non-imperative doClause + missing contrast + missing dontClause', () => {
    const violations = runInProcessRecipeAuthoringGate(
      cleanRecipe({
        doClause: 'Persist the alpha mapping for compatibility reasons.',
        dontClause: undefined,
        content: {
          markdown: `Alpha module guidance without any contrast marker (来源: src/alpha.ts:1). ${'pad '.repeat(50)}`,
          rationale: '单向 import 保持分层边界清晰，避免成环，便于独立测试与未来替换实现。',
        },
      }),
      { projectRoot }
    );
    const codes = codesOf(violations);
    expect(codes).toContain('DO_CLAUSE_NON_IMPERATIVE');
    expect(codes).toContain('DONT_CLAUSE_REQUIRED');
    expect(codes).toContain('CONTENT_CONTRAST_MISSING');
  });

  it('runs the in-process fs grounding: SOURCE_REF_NOT_FOUND + LINE_OUT_OF_RANGE actually fire', () => {
    const notFound = runInProcessRecipeAuthoringGate(
      cleanRecipe({
        sourceRefs: ['src/missing.ts:1-3'],
        reasoning: { sources: ['src/missing.ts:1-3'], confidence: 0.8 },
      }),
      { projectRoot }
    );
    expect(codesOf(notFound)).toContain('SOURCE_REF_NOT_FOUND');

    const outOfRange = runInProcessRecipeAuthoringGate(
      cleanRecipe({
        sourceRefs: ['src/alpha.ts:1-999'],
        reasoning: { sources: ['src/alpha.ts:1-999'], confidence: 0.8 },
      }),
      { projectRoot }
    );
    expect(codesOf(outOfRange)).toContain('SOURCE_REF_LINE_OUT_OF_RANGE');
  });

  it('opportunistic profile drops the 3-file floor + session-scope; cold-start keeps the floor', () => {
    // 单一来源文件的 rule 候选：opportunistic 不强制 3-file 下限 → 无 INSUFFICIENT_EVIDENCE；
    // 携带 dimensionId 的 cold-start 强制下限 → 有 INSUFFICIENT_EVIDENCE。两档都不注入 session 端口，
    // 故都不会出现 SESSION_NOT_FOUND（与 P1-Plugin「session-scope 留 host 前置」一致）。
    const singleFile = {
      sourceRefs: ['src/alpha.ts:1-3'],
      reasoning: { sources: ['src/alpha.ts:1-3'], confidence: 0.8 },
    };

    const opportunistic = runInProcessRecipeAuthoringGate(cleanRecipe(singleFile), { projectRoot });
    expect(codesOf(opportunistic)).not.toContain('INSUFFICIENT_EVIDENCE');
    expect(codesOf(opportunistic)).not.toContain('SESSION_NOT_FOUND');

    const coldStart = runInProcessRecipeAuthoringGate(cleanRecipe(singleFile), {
      projectRoot,
      dimensionId: 'architecture',
    });
    expect(codesOf(coldStart)).toContain('INSUFFICIENT_EVIDENCE');
    expect(codesOf(coldStart)).not.toContain('SESSION_NOT_FOUND');
  });

  it('formats violations into a readable in-process reject string', () => {
    const violations = runInProcessRecipeAuthoringGate(
      cleanRecipe({ doClause: 'Persist the alpha mapping for compatibility reasons.' }),
      { projectRoot }
    );
    const text = formatRecipeAuthoringViolations(violations);
    expect(text).toContain('DO_CLAUSE_NON_IMPERATIVE');
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('P1.4b currently-passing-corpus regression (§C.4 bounded tightening)', () => {
  /**
   * 三个「旧 length-only 门槛下能过」的候选（都满足 validateSubmitParams 的 presence/length：
   * title 3-200 / description ≥10 / markdown ≥200 / rationale ≥50 / kind 合法 / trigger ≥3 /
   * whenClause ≥10 / doClause ≥10 / reasoning.sources 非空），但不是 gate-clean。
   */
  const todayPassingCorpus: Array<Record<string, unknown>> = [
    {
      title: 'Legacy candidate with non-imperative clause and no contrast',
      description: '中文简述：仅满足长度门槛的旧候选之一。',
      content: {
        markdown: `Legacy body paragraph. ${'pad '.repeat(60)}`,
        rationale: 'r'.repeat(60),
      },
      kind: 'pattern',
      trigger: 'legacy-one',
      whenClause: 'When the legacy candidate applies in this project.',
      doClause: 'Persist the legacy mapping for backward compatibility.',
      reasoning: { sources: ['src/alpha.ts'], confidence: 0.8 },
    },
    {
      title: 'Legacy candidate missing markdown code or file reference',
      description: '中文简述：仅满足长度门槛的旧候选之二。',
      content: { markdown: 'x'.repeat(240), rationale: 'r'.repeat(60) },
      kind: 'fact',
      trigger: 'legacy-two',
      whenClause: 'When the second legacy candidate applies in this project.',
      doClause: 'Keep the legacy fact recorded for downstream lookups.',
      dontClause: 'Do not delete the legacy fact without review.',
      reasoning: { sources: ['src/alpha.ts:1-3'], confidence: 0.8 },
    },
    {
      title: 'Legacy candidate with a bare source ref and Chinese do clause',
      description: '中文简述：仅满足长度门槛的旧候选之三。',
      content: {
        markdown: `合法长度但缺少对比标记的正文。${'补'.repeat(120)}`,
        rationale: 'r'.repeat(60),
      },
      kind: 'pattern',
      trigger: 'legacy-three',
      whenClause: 'When the third legacy candidate applies in this project.',
      doClause: '使用单向依赖以保持分层。',
      reasoning: { sources: ['src/beta.ts'], confidence: 0.8 },
    },
  ];

  // §C.4 收紧只允许这些「内容质量 + 廉价来源接地」类拒绝出现；其余（尤其证据下限 / session-scope）禁止。
  const BOUNDED_NEW_REJECT_CODES = new Set([
    'DO_CLAUSE_REQUIRED',
    'DO_CLAUSE_NON_ENGLISH',
    'DO_CLAUSE_NON_IMPERATIVE',
    'DONT_CLAUSE_REQUIRED',
    'DONT_CLAUSE_NON_ENGLISH',
    'DONT_CLAUSE_NON_IMPERATIVE',
    'CONTENT_MARKDOWN_REQUIRED',
    'CONTENT_CONTRAST_MISSING',
    'SOURCE_REFS_MISSING',
    'SOURCE_REF_LINE_MISSING',
    'SOURCE_REF_INVALID',
    'SOURCE_REF_NOT_FOUND',
    'SOURCE_REF_LINE_OUT_OF_RANGE',
    'PLACEHOLDER_EVIDENCE',
    'SNIPPET_MISMATCH',
    'GRAPH_REF_INVALID',
    'STALE_GRAPH',
    'STAGE3_MARKDOWN_TOO_SHORT',
    'STAGE3_MARKDOWN_NEEDS_CODE_OR_FILEREF',
    'STAGE3_CORECODE_INCOMPLETE',
    'STAGE3_TITLE_TOO_GENERIC',
  ]);

  it('every new opportunistic reject is a content/cheap-grounding code — never the evidence floor or session-scope', () => {
    const observed = new Set<string>();
    for (const recipe of todayPassingCorpus) {
      const violations = runInProcessRecipeAuthoringGate(recipe, { projectRoot });
      // 旧门槛下能过的候选，过新门禁后必然新增至少一条内容类拒绝（收紧是真实存在的，不是 no-op）。
      expect(violations.length).toBeGreaterThan(0);
      for (const violation of violations) {
        observed.add(violation.code);
      }
    }

    // 有界证明①：观测到的新拒绝集合 ⊆ 内容/廉价接地白名单。
    for (const code of observed) {
      expect(BOUNDED_NEW_REJECT_CODES.has(code)).toBe(true);
    }
    // 有界证明②：opportunistic 绝不触发 3-file 证据下限或 session-scope。
    expect(observed.has('INSUFFICIENT_EVIDENCE')).toBe(false);
    expect(observed.has('SESSION_NOT_FOUND')).toBe(false);
    expect(observed.has('WRONG_SCOPE')).toBe(false);

    // 文档化新拒绝集合（test 即文档）：至少覆盖这些代表性内容类拒绝。
    expect(observed).toContain('DO_CLAUSE_NON_IMPERATIVE');
    expect(observed).toContain('DONT_CLAUSE_REQUIRED');
    expect(observed).toContain('CONTENT_CONTRAST_MISSING');
    expect(observed).toContain('SOURCE_REF_LINE_MISSING');
  });
});

describe('P1.4b host-vs-in-process parity (§12.5 standing tripwire)', () => {
  // 既含 gate-clean、又含触发各类违规的混合 corpus，覆盖 stage-1/2/3 + fs 端口（NOT_FOUND/越界）。
  const parityCorpus: Array<Record<string, unknown>> = [
    cleanRecipe(),
    cleanRecipe({
      doClause: 'Persist the alpha mapping for compatibility reasons.',
      dontClause: undefined,
      content: {
        markdown: 'no contrast markers here at all '.repeat(8),
        rationale: 'r'.repeat(60),
      },
    }),
    cleanRecipe({
      sourceRefs: ['src/missing.ts:1-3'],
      reasoning: { sources: ['src/missing.ts:1-3'], confidence: 0.8 },
    }),
    cleanRecipe({
      sourceRefs: ['src/alpha.ts:1-999'],
      reasoning: { sources: ['src/alpha.ts:1-999'], confidence: 0.8 },
    }),
  ];

  function runPath(
    pathLabel: 'host-cold-start' | 'in-process',
    profile: RecipeAuthoringProfile
  ): RecipeAuthoringViolation[] {
    return validateAgainst(parityCorpus, {
      stage: 'all',
      path: pathLabel,
      profile,
      sourceRefResolver: createInProcessSourceRefResolver(),
      projectRoot,
    });
  }

  for (const profile of ['cold-start', 'opportunistic'] as const) {
    it(`host-cold-start and in-process return byte-identical verdicts under profile=${profile}`, () => {
      const host = runPath('host-cold-start', profile);
      const inProcess = runPath('in-process', profile);
      // path 标签不得改变裁决：同 corpus / 同 profile / 同 resolver → 违规数组逐字节一致。
      expect(inProcess).toEqual(host);
    });
  }

  it('the two profiles actually differ on this corpus (parity is non-trivial)', () => {
    const cold = runPath('in-process', 'cold-start');
    const opportunistic = runPath('in-process', 'opportunistic');
    // cold-start 至少多出证据下限类裁决，证明 parity 不是「两档恒等」的平凡通过。
    expect(cold).not.toEqual(opportunistic);
  });
});

describe('冷启动候选拒绝修复：copy-ready 证据 → cold-start 门禁可过 (options 2+3)', () => {
  /**
   * 修复背景（2026-07-02 真机冷启动 16 条候选全拒）：
   *  - SOURCE_REF_LINE_MISSING(27)：旧 evidence 段渲染 `path [L42-58]`，与门禁 SOURCE_REF_RE
   *    (`path:42-58`) 不符，DeepSeek 复制时丢行号 → option 2a 改为渲染可逐字复制的 `path:起-止`。
   *  - SNIPPET_MISMATCH(16)：refs-first 只给 ref 不给代码，Producer 凭空写 coreCode → option 2b
   *    注入「可复制 coreCode」真实片段（无截断标记的源码逐字前缀）。
   *  - DO_CLAUSE/INSUFFICIENT_EVIDENCE/GRAPH_REF：option 3 在 PRODUCER_SYSTEM_PROMPT 增加
   *    🚨 过门禁硬约束块（逐字复制 refs/code、3 文件下限、祈使动词、关系词规避）。
   * 本块给出确定性证明：按注入证据逐字构造的候选在 cold-start（完整门禁）下零违规 ——
   * 即「模型只要照抄提示里给的证据就能过门禁」，剩余风险只在模型是否照抄（提示硬约束负责收敛）。
   */

  /** 与 beforeAll 写入临时项目逐字一致的行范围原文（行 n 的文本 = `export const <name><n-1> = <n-1>;`）。 */
  function fileLines(name: 'alpha' | 'beta' | 'gamma', startLine: number, endLine: number): string {
    return Array.from(
      { length: endLine - startLine + 1 },
      (_, i) => `export const ${name}${startLine - 1 + i} = ${startLine - 1 + i};`
    ).join('\n');
  }

  function evidenceEntry(
    name: 'alpha' | 'beta' | 'gamma',
    startLine: number,
    endLine: number,
    summary: string
  ): [string, EvidenceEntry] {
    const filePath = `src/${name}.ts`;
    return [
      filePath,
      {
        filePath,
        summary,
        codeSnippets: [{ startLine, endLine, content: fileLines(name, startLine, endLine) }],
      },
    ];
  }

  it('evidence 段渲染门禁格式 path:起-止（旧 [L..] 格式已死）+ 可复制 coreCode 逐字在场', () => {
    const section = buildCodeContextSection(
      new Map([
        evidenceEntry('alpha', 2, 4, 'Alpha 常量导出模式'),
        evidenceEntry('beta', 1, 3, 'Beta 常量导出模式'),
        evidenceEntry('gamma', 5, 7, 'Gamma 常量导出模式'),
      ])
    );
    expect(section).not.toBeNull();
    const text = section ?? '';
    // 门禁可逐字复制的 ref 形态；旧 `path [L42-58]` 渲染绝迹。
    expect(text).toContain('src/alpha.ts:2-4');
    expect(text).toContain('src/beta.ts:1-3');
    expect(text).toContain('src/gamma.ts:5-7');
    expect(text).not.toMatch(/\[L\d+/);
    // 可复制 coreCode：真实源码逐字在场（snippet-match 判据 = 去空白子串包含）。
    expect(text).toContain('可复制 coreCode(来源 src/alpha.ts:2-4)');
    expect(text).toContain(fileLines('alpha', 2, 4));
  });

  it('超预算代码截断仍是源码逐字前缀，绝不追加截断标记（否则照抄反而必挂 SNIPPET_MISMATCH）', () => {
    const fullContent = fileLines('alpha', 1, 20); // ~500 字符 > 220 上限，必触发截断
    const section = buildCodeContextSection(
      new Map([
        [
          'src/alpha.ts',
          {
            filePath: 'src/alpha.ts',
            summary: 'Alpha 全文件',
            codeSnippets: [{ startLine: 1, endLine: 20, content: fullContent }],
          },
        ],
      ])
    );
    const text = section ?? '';
    expect(text).not.toContain('truncated');
    const marker = '可复制 coreCode(来源 src/alpha.ts:1-20): ';
    const markerIndex = text.indexOf(marker);
    expect(markerIndex).toBeGreaterThan(-1);
    const injected = text.slice(markerIndex + marker.length);
    // 注入代码是原始范围的逐字前缀 → 复制后 normalizedCode 子串包含成立，门禁必过。
    expect(injected.length).toBeGreaterThan(0);
    expect(fullContent.startsWith(injected)).toBe(true);
  });

  it('按提示契约逐字构造的候选（refs 照抄 + coreCode 照抄）过 cold-start 完整门禁零违规', () => {
    // cleanRecipe 的 sourceRefs 已是 evidence 段渲染的 `src/*.ts:1-3` 逐字形态（3 文件下限满足）；
    // coreCode = 「可复制 coreCode」注入的 src/alpha.ts:1-3 范围原文。dimensionId 强制 cold-start。
    const violations = runInProcessRecipeAuthoringGate(
      cleanRecipe({ coreCode: fileLines('alpha', 1, 3) }),
      { projectRoot, dimensionId: 'architecture' }
    );
    expect(formatRecipeAuthoringViolations(violations)).toBe('');
    expect(violations).toEqual([]);
  });

  it('凭空编写的 coreCode 在 cold-start 仍被 SNIPPET_MISMATCH 拒绝（门禁未被放松，修复只是喂对证据）', () => {
    const violations = runInProcessRecipeAuthoringGate(
      cleanRecipe({ coreCode: 'const fabricatedHelper = buildSomethingNotInTheCitedRange();' }),
      { projectRoot, dimensionId: 'architecture' }
    );
    expect(codesOf(violations)).toContain('SNIPPET_MISMATCH');
  });

  it('evidence 段随 buildProducerPromptV2 真正进入 Producer 提示（不是孤立辅助函数）', () => {
    const prompt = buildProducerPromptV2(
      {
        analysisText: 'Alpha module exports constants in a fixed pattern.',
        evidenceMap: new Map([
          evidenceEntry('alpha', 2, 4, 'Alpha 常量导出模式'),
          evidenceEntry('beta', 1, 3, 'Beta 常量导出模式'),
        ]),
        findings: [{ finding: 'Alpha export pattern', importance: 8 }],
        negativeSignals: [],
        referencedFiles: ['src/alpha.ts'],
      },
      { id: 'architecture', label: 'Architecture' },
      { name: 'Demo' }
    );
    expect(prompt).toContain('src/alpha.ts:2-4');
    expect(prompt).toContain('可复制 coreCode');
  });

  it('特写契约：真实 coreCode + markdown 范式模板（提炼非原文）直接零违规过完整门禁', () => {
    // 2026-07-02 语义修正：markdown 代码块是「项目特写」的范式模板（提炼物），退出逐字
    // snippet-match（Core 20dae5e 后续修正）；逐字判据保留在 coreCode/pattern 证据位。
    // 此前把 fenced 纳入逐字校验把两宿主都挤压成「粘贴项目原文」，摧毁特写的范式意义
    // （用户验收否决）。
    const realCode = Array.from({ length: 3 }, (_, i) => `export const alpha${i} = ${i};`).join(
      '\n'
    );
    const withTemplate = cleanRecipe({
      coreCode: realCode,
      content: {
        markdown: [
          '## Alpha 模块单向 import 约定',
          'Alpha 模块内的代码只向下引用，保持分层清晰 (来源: src/alpha.ts:1)。',
          '```ts',
          '// 范式模板：新增导出沿用序号化约定',
          'export const alphaNext = NEXT_INDEX;',
          '```',
          '✅ Keep alpha module imports flowing one direction only.',
          '❌ Do not import beta or gamma back into alpha.',
        ].join('\n'),
        rationale: '单向 import 保持分层边界清晰，避免成环，便于独立测试与未来替换实现。',
      },
    });
    expect(
      runInProcessRecipeAuthoringGate(withTemplate, { projectRoot, dimensionId: 'architecture' })
    ).toEqual([]);

    // coreCode 证据位仍逐字：凭空 coreCode 必拒（防伪未松动）。
    const fabricatedCore = cleanRecipe({
      coreCode: 'const fabricated = rewriteFromMemory();',
    });
    expect(
      codesOf(
        runInProcessRecipeAuthoringGate(fabricatedCore, {
          projectRoot,
          dimensionId: 'architecture',
        })
      )
    ).toContain('SNIPPET_MISMATCH');
  });

  it('系统提示携带过门禁硬约束块（option 3：逐字复制 refs/code + 3 文件下限 + 祈使动词 + 关系词规避）', () => {
    expect(PRODUCER_SYSTEM_PROMPT).toContain('过门禁硬约束');
    for (const code of [
      'SOURCE_REF_LINE_MISSING',
      'INSUFFICIENT_EVIDENCE',
      'SNIPPET_MISMATCH',
      'DO_CLAUSE_NON_IMPERATIVE',
      'GRAPH_REF_INVALID',
    ]) {
      expect(PRODUCER_SYSTEM_PROMPT).toContain(code);
    }
  });
});
