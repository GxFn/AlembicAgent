/**
 * EvidenceCollector 证据保真回归（2026-07-02 冷启动全链路审计修复）。
 *
 * 审计实锤的采集端断点（修复前）：
 *  B1 code.search 的 data 是 formatSearchOutput 字符串，旧字符串分支直接 return →
 *     search 证据 100% 不进 evidenceMap（INSUFFICIENT_EVIDENCE 的采集端根因）；
 *  B2 SearchMatch 期待 context 字段而 search 实际产出 content → 即使传结构化也提不出，
 *     且先建 entry 后检查会留下「有 filePath 无 snippet」的空壳 entry → Producer 渲染
 *     裸路径 ref → 照抄触发 SOURCE_REF_LINE_MISSING；
 *  B3 范围读 content 每行带 `42|` 前缀 + `... [N lines omitted...]` 后缀 → 毒化照抄链
 *     （SNIPPET_MISMATCH 的直接来源）；
 *  B4 batch clamp 截断标记 + head/tail 拼接不连续、deltaCache unchanged/delta 占位文本
 *     → 非源码内容入库。
 *
 * 本文件钉住：采集端净化保真 + 渲染端空壳降级 + 从工具返回直通 cold-start 门禁的
 * 端到端闭环（工具返回 → EvidenceCollector → buildCodeContextSection → 照抄构造候选 →
 * runInProcessRecipeAuthoringGate 0 违规）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EvidenceCollector,
  type SnippetRangeReader,
} from '../src/agent/domain/EvidenceCollector.js';
import { buildAnalysisArtifact } from '../src/agent/prompts/insightGate.js';
import {
  buildCodeContextSection,
  buildProducerPromptV2,
} from '../src/agent/prompts/insightProducer.js';
import {
  formatRecipeAuthoringViolations,
  runInProcessRecipeAuthoringGate,
} from '../src/tools/runtime/handlers/recipeAuthoringGate.js';

// 与 recipe-authoring-inprocess-flatten 相同的确定性临时项目：行 n 的文本可由公式重建。
let projectRoot: string;

/** 行 n 的源码文本 = `export const <name><n-1> = <n-1>;`（与 beforeAll 写入逐字一致） */
function fileLines(name: 'alpha' | 'beta' | 'gamma', startLine: number, endLine: number): string {
  return Array.from(
    { length: endLine - startLine + 1 },
    (_, i) => `export const ${name}${startLine - 1 + i} = ${startLine - 1 + i};`
  ).join('\n');
}

beforeAll(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'agent-evidence-fidelity-'));
  mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  for (const name of ['alpha', 'beta', 'gamma'] as const) {
    writeFileSync(path.join(projectRoot, 'src', `${name}.ts`), fileLines(name, 1, 20));
  }
});

afterAll(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

/** 模拟范围读展示态：每行 `N|code`，可选省略后缀（复刻 code.ts readSingleFile 渲染） */
function rangeReadDisplay(
  name: 'alpha' | 'beta' | 'gamma',
  start: number,
  end: number,
  omittedSuffix = false
): string {
  const body = fileLines(name, start, end)
    .split('\n')
    .map((line, i) => `${start + i}|${line}`)
    .join('\n');
  return omittedSuffix
    ? `${body}\n... [${20 - end} lines omitted; use startLine/endLine for more]`
    : body;
}

describe('EvidenceCollector 采集端保真 (B1-B4)', () => {
  it('B1: code.search 字符串输出被解析进 evidenceMap（file/line/单行内容逐字对齐）', () => {
    const collector = new EvidenceCollector();
    collector.processToolCall({
      tool: 'code',
      args: { action: 'search', pattern: 'beta1' },
      result: `1 matches (showing 1)\n\nsrc/beta.ts:2: ${fileLines('beta', 2, 2)}`,
    });
    const { evidenceMap, negativeSignals } = collector.build();
    const entry = evidenceMap.get('src/beta.ts');
    expect(entry).toBeDefined();
    expect(entry?.codeSnippets).toHaveLength(1);
    expect(entry?.codeSnippets[0]).toMatchObject({
      startLine: 2,
      endLine: 2,
      content: fileLines('beta', 2, 2),
    });
    expect(negativeSignals).toHaveLength(0);
  });

  it('B1: 0 matches 字符串输出记为负空间信号，不产生任何 entry', () => {
    const collector = new EvidenceCollector();
    collector.processToolCall({
      tool: 'code',
      args: { action: 'search', pattern: 'nonexistent_symbol' },
      result: '0 matches (showing 0)\n\n',
    });
    const { evidenceMap, negativeSignals } = collector.build();
    expect(evidenceMap.size).toBe(0);
    expect(negativeSignals.map((n) => n.searchPattern)).toContain('nonexistent_symbol');
  });

  it('B2: 结构化 matches 的 content 字段可提取；无内容的 match 不留空壳 entry', () => {
    const collector = new EvidenceCollector();
    collector.processToolCall({
      tool: 'code',
      args: { action: 'search', pattern: 'alpha3' },
      result: {
        matches: [
          { file: 'src/alpha.ts', line: 4, content: fileLines('alpha', 4, 4) },
          { file: 'src/gamma.ts', line: 7 }, // 无 content/context → 必须不留空壳
        ],
      },
    });
    const { evidenceMap } = collector.build();
    expect(evidenceMap.get('src/alpha.ts')?.codeSnippets[0]).toMatchObject({
      startLine: 4,
      endLine: 4,
    });
    // 空壳 entry 是裸路径 ref 的源头：无内容的 match 不得创建 entry。
    expect(evidenceMap.has('src/gamma.ts')).toBe(false);
  });

  it('B3: 范围读行号前缀被剥除、startLine 以前缀校准、省略后缀被剔除', () => {
    const collector = new EvidenceCollector();
    collector.processToolCall({
      tool: 'code',
      args: { action: 'read', path: 'src/alpha.ts', startLine: 999 }, // 故意给错的参数行号
      result: {
        path: 'src/alpha.ts',
        content: rangeReadDisplay('alpha', 5, 8, true),
        lineCount: 20,
      },
    });
    const { evidenceMap } = collector.build();
    const snippet = evidenceMap.get('src/alpha.ts')?.codeSnippets[0];
    expect(snippet).toBeDefined();
    // 前缀行号(5)胜过错误的参数行号(999)；内容为纯源码，无 `N|` 前缀、无省略标记。
    expect(snippet?.startLine).toBe(5);
    expect(snippet?.endLine).toBe(8);
    expect(snippet?.content).toBe(fileLines('alpha', 5, 8));
    expect(snippet?.content).not.toMatch(/^\d+\|/m);
    expect(snippet?.content).not.toContain('omitted');
  });

  it('B4: clamp 截断标记后的 tail 被丢弃，只保留逐字前缀 head；unchanged/delta 模式跳过采集', () => {
    const collector = new EvidenceCollector();
    const full = fileLines('gamma', 1, 20);
    const head = fileLines('gamma', 1, 6);
    collector.processToolCall({
      tool: 'code',
      args: { action: 'read', filePaths: ['src/gamma.ts', 'src/beta.ts'] },
      result: {
        mode: 'batch',
        files: [
          {
            path: 'src/gamma.ts',
            content: `${head}\n\n... [999 chars truncated for batch read budget] ...\n\n${fileLines('gamma', 15, 20)}`,
            truncated: true,
          },
          { path: 'src/beta.ts', content: 'stale placeholder', mode: 'unchanged' },
        ],
      },
    });
    const { evidenceMap } = collector.build();
    const gamma = evidenceMap.get('src/gamma.ts')?.codeSnippets[0];
    expect(gamma?.content).toBe(head);
    expect(gamma?.content).not.toContain('truncated');
    // head 必须是原文件全文的逐字前缀（保真判据）。
    expect(full.startsWith(gamma?.content ?? '__missing__')).toBe(true);
    // deltaCache 占位文本不可作照抄证据。
    expect(evidenceMap.has('src/beta.ts')).toBe(false);
  });
});

describe('端到端保真闭环：工具返回 → 采集 → 渲染 → 照抄候选 → cold-start 门禁', () => {
  it('三文件证据（范围读+search+批量读）照抄构造的候选过完整门禁零违规', () => {
    // ① 模拟 Analyst 的三次真实工具返回（展示态，含全部杂质形态）。
    const collector = new EvidenceCollector();
    collector.processToolCall({
      tool: 'code',
      args: { action: 'read', path: 'src/alpha.ts' },
      result: {
        path: 'src/alpha.ts',
        content: rangeReadDisplay('alpha', 1, 3, true),
        lineCount: 20,
      },
    });
    collector.processToolCall({
      tool: 'code',
      args: { action: 'search', pattern: 'beta1' },
      result: `1 matches (showing 1)\n\nsrc/beta.ts:2: ${fileLines('beta', 2, 2)}`,
    });
    collector.processToolCall({
      tool: 'code',
      args: { action: 'read', filePaths: ['src/gamma.ts'] },
      result: {
        mode: 'batch',
        files: [{ path: 'src/gamma.ts', content: fileLines('gamma', 1, 20) }],
      },
    });
    const { evidenceMap } = collector.build();

    // ② Producer 渲染 copy-ready 证据段。
    const section = buildCodeContextSection(evidenceMap) ?? '';
    expect(section).toContain('src/alpha.ts:1-3');
    expect(section).toContain('src/beta.ts:2-2');
    expect(section).toContain('src/gamma.ts:1-20');
    const marker = '可复制 coreCode(来源 src/alpha.ts:1-3): ';
    expect(section).toContain(marker);

    // ③ 严格「照抄」：refs 与 coreCode 都从渲染段逐字提取（模拟模型复制行为）。
    const refs = ['src/alpha.ts:1-3', 'src/beta.ts:2-2', 'src/gamma.ts:1-20'];
    const afterMarker = section.slice(section.indexOf(marker) + marker.length);
    const copiedCoreCode = afterMarker.split('\n- ')[0]?.split('\n背景文件')[0] ?? '';
    expect(copiedCoreCode.trim().length).toBeGreaterThan(0);

    const candidate: Record<string, unknown> = {
      title: 'Alpha constants follow sequential export convention',
      description: '中文简述：alpha/beta/gamma 常量按序号导出，保持可预测的模块形状。',
      content: {
        markdown: [
          '## 常量导出约定',
          '模块常量按 `export const <name><n> = <n>;` 序号导出，新增常量沿用同一序列，',
          '保持三个模块形状一致、可脚本化重建 (来源: src/alpha.ts:1-3)。',
          '✅ Keep exported constants sequential per module.',
          '❌ Do not introduce gaps or duplicate indices in the constant sequence.',
        ].join('\n'),
        rationale: '序号化导出让生成脚本与测试可以按公式重建期望内容，避免手工漂移。',
      },
      kind: 'rule',
      trigger: '@sequential-constant-export',
      whenClause: 'When adding exported constants to the alpha, beta, or gamma modules.',
      doClause: 'Keep exported constants sequential per module.',
      dontClause: 'Do not introduce gaps or duplicate indices in the constant sequence.',
      coreCode: copiedCoreCode.trim(),
      sourceRefs: refs,
      reasoning: { sources: refs, confidence: 0.85 },
    };

    // ④ cold-start 完整门禁（3-file 下限 + fs 接地 + snippet-match）零违规。
    const violations = runInProcessRecipeAuthoringGate(candidate, {
      projectRoot,
      dimensionId: 'architecture',
    });
    expect(formatRecipeAuthoringViolations(violations)).toBe('');
    expect(violations).toEqual([]);
  });

  it('空壳 entry 渲染为背景文件并明示不可作 sourceRefs（不再是裸路径可复制 ref）', () => {
    const evidenceMap = new Map([
      [
        'src/alpha.ts',
        { filePath: 'src/alpha.ts', summary: '只有摘要没有行号证据', codeSnippets: [] },
      ],
    ]);
    const section = buildCodeContextSection(evidenceMap) ?? '';
    expect(section).toContain('背景文件');
    expect(section).toContain('绝不可用作 sourceRefs');
    expect(section).not.toMatch(/^- src\/alpha\.ts/m);
  });
});

describe('R1 锚点驱动证据补齐（真机根因：头部窗口盖不住 findings 锚点）', () => {
  /** 与临时项目文件逐字一致的行范围读取端口（模拟 insightGate 的 fs 端口语义） */
  function makeReader(): SnippetRangeReader {
    return (filePath, startLine, endLine) => {
      const m = filePath.match(/^src\/(alpha|beta|gamma)\.ts$/);
      if (!m) {
        return null;
      }
      const name = m[1] as 'alpha' | 'beta' | 'gamma';
      if (startLine < 1 || startLine > 20) {
        return null;
      }
      const effectiveEnd = Math.min(endLine, 20);
      return { content: fileLines(name, startLine, effectiveEnd), endLine: effectiveEnd };
    };
  }

  it('窗口外锚点被补成精确片段；已覆盖锚点与无效锚点不动', () => {
    const collector = new EvidenceCollector();
    // 全文读只留头 3 行窗口（模拟 MAX_SNIPPET_LINES 窗口效应的缩小版）。
    collector.processToolCall({
      tool: 'code',
      args: { action: 'read', path: 'src/alpha.ts' },
      result: { path: 'src/alpha.ts', content: fileLines('alpha', 1, 3), lineCount: 20 },
    });
    collector.groundFindingRefs(
      [
        { finding: '窗口外锚点', evidence: '深层导出见 src/alpha.ts:15-17', importance: 9 },
        { finding: '已覆盖锚点', evidence: '头部导出见 src/alpha.ts:2', importance: 8 },
        { finding: '缺失文件锚点', evidence: '见 src/missing.ts:4', importance: 7 },
        { finding: '越界锚点', evidence: '见 src/beta.ts:999', importance: 7 },
      ],
      makeReader()
    );
    const { evidenceMap } = collector.build();
    const alpha = evidenceMap.get('src/alpha.ts');
    // 头部窗口 1 片 + 窗口外锚点补 1 片；已覆盖的 :2 不重复补。
    expect(alpha?.codeSnippets).toHaveLength(2);
    expect(alpha?.codeSnippets[1]).toMatchObject({
      startLine: 15,
      endLine: 17,
      content: fileLines('alpha', 15, 17),
    });
    // 端口 null（缺文件/越界）静默跳过，不留空壳。
    expect(evidenceMap.has('src/missing.ts')).toBe(false);
    expect(evidenceMap.has('src/beta.ts')).toBe(false);
  });

  it('单行锚点向下扩上下文；文件末尾自然收缩且内容行号仍逐字对齐', () => {
    const collector = new EvidenceCollector();
    collector.groundFindingRefs(
      [{ finding: '尾部锚点', evidence: '见 src/gamma.ts:18', importance: 9 }],
      makeReader()
    );
    const snippet = collector.build().evidenceMap.get('src/gamma.ts')?.codeSnippets[0];
    // 18 + 8 行上下文越过 20 行文件末尾 → 收缩到 18-20，内容与行号逐字对齐。
    expect(snippet).toMatchObject({
      startLine: 18,
      endLine: 20,
      content: fileLines('gamma', 18, 20),
    });
  });

  it('端到端：buildAnalysisArtifact(projectRoot) 补齐窗口外锚点 → 照抄候选过 cold-start 门禁', () => {
    // Analyst 只全文读了 alpha（头窗口）+ search 命中 beta/gamma 单行；finding 锚定 alpha 深处 12-14。
    const analystResult = {
      reply: 'Alpha deep exports follow the sequential constant convention. '.repeat(4),
      toolCalls: [
        {
          tool: 'code',
          args: { action: 'read', path: 'src/alpha.ts' },
          result: { path: 'src/alpha.ts', content: fileLines('alpha', 1, 3), lineCount: 20 },
        },
        {
          tool: 'code',
          args: { action: 'search', pattern: 'beta1' },
          result: `1 matches (showing 1)\n\nsrc/beta.ts:2: ${fileLines('beta', 2, 2)}`,
        },
        {
          tool: 'code',
          args: { action: 'search', pattern: 'gamma5' },
          result: `1 matches (showing 1)\n\nsrc/gamma.ts:6: ${fileLines('gamma', 6, 6)}`,
        },
      ],
    };
    const activeContext = {
      distill: () => ({
        keyFindings: [
          {
            finding: 'Alpha 深层常量沿用序号导出约定',
            evidence: '深层区段 src/alpha.ts:12-14 与头部一致',
            importance: 9,
          },
        ],
        toolCallSummary: [],
      }),
    };
    const artifact = buildAnalysisArtifact(analystResult, 'architecture', null, activeContext, {
      projectRoot,
    });

    // 锚点 12-14 在头部窗口(1-3)之外 → 必须被补成精确片段并渲染为可复制证据。
    const section = buildCodeContextSection(
      artifact.evidenceMap as Map<
        string,
        { filePath: string; codeSnippets: never[]; summary: string }
      >
    );
    expect(section).toContain('src/alpha.ts:12-14');
    expect(section).toContain(fileLines('alpha', 12, 14));

    const refs = ['src/alpha.ts:12-14', 'src/beta.ts:2-2', 'src/gamma.ts:6-6'];
    const candidate: Record<string, unknown> = {
      title: 'Deep constants keep the sequential export convention',
      description: '中文简述：深层常量沿用与头部一致的序号导出约定，保持模块形状可预测。',
      content: {
        markdown: [
          '## 深层常量导出约定',
          '深层区段的常量与头部同构，按序号连续导出，跨模块保持同一形状，',
          '便于脚本化校验与重建 (来源: src/alpha.ts:12-14)。',
          '✅ Keep deep constant exports sequential and uniform across modules.',
          '❌ Do not diverge deep sections from the established export shape.',
        ].join('\n'),
        rationale: '深浅区段同构让按公式重建期望内容的测试可以覆盖整个文件，避免深层漂移。',
      },
      kind: 'rule',
      trigger: '@deep-sequential-export',
      whenClause: 'When adding constants to deep sections of the alpha, beta, or gamma modules.',
      doClause: 'Keep deep constant exports sequential and uniform across modules.',
      dontClause: 'Do not diverge deep sections from the established export shape.',
      coreCode: fileLines('alpha', 12, 14),
      sourceRefs: refs,
      reasoning: { sources: refs, confidence: 0.85 },
    };
    const violations = runInProcessRecipeAuthoringGate(candidate, {
      projectRoot,
      dimensionId: 'architecture',
    });
    expect(formatRecipeAuthoringViolations(violations)).toBe('');
    expect(violations).toEqual([]);
  });
});

describe('F1/F2 证据源约束（md 是线索不是证据）+ 路径截断修复', () => {
  it('F1c: groundFindingRefs 跳过 .md 锚点（文档行不是代码接地）', () => {
    const collector = new EvidenceCollector();
    collector.groundFindingRefs(
      [
        {
          finding: '文档锚点不补',
          evidence: '设计详见 wakeflow-ledger/designs/arch-findings.md:23',
          importance: 9,
        },
        { finding: '代码锚点照补', evidence: '实现见 src/alpha.ts:15-16', importance: 9 },
      ],
      (filePath, startLine, endLine) => {
        if (filePath === 'src/alpha.ts') {
          return { content: fileLines('alpha', startLine, Math.min(endLine, 20)), endLine };
        }
        // md 若被请求，端口也能返回——用于证明「没请求」而不是「读不到」。
        return { content: '- **doc line**', endLine: startLine };
      }
    );
    const { evidenceMap } = collector.build();
    expect(evidenceMap.has('wakeflow-ledger/designs/arch-findings.md')).toBe(false);
    expect(evidenceMap.get('src/alpha.ts')?.codeSnippets[0]?.startLine).toBe(15);
  });

  it('F1b: md 文件的 evidence entry 渲染为背景文件，绝不进可复制 ref 列表', () => {
    const section =
      buildCodeContextSection(
        new Map([
          [
            'wakeflow-ledger/designs/arch-findings.md',
            {
              filePath: 'wakeflow-ledger/designs/arch-findings.md',
              summary: '架构审计结论文档',
              codeSnippets: [{ startLine: 23, endLine: 23, content: '- **audit finding**' }],
            },
          ],
          evidenceEntryForFidelity('alpha', 2, 4),
        ])
      ) ?? '';
    // md 有 snippet 也降级背景；代码文件正常渲染。
    expect(section).toContain('背景文件');
    expect(section).toContain('wakeflow-ledger/designs/arch-findings.md');
    expect(section).not.toContain('arch-findings.md:23-23');
    expect(section).not.toContain('audit finding');
    expect(section).toContain('src/alpha.ts:2-4');
  });

  it('F2: search 结果里的 .md 路径完整提取进 referencedFiles（不再截成 .m）', () => {
    const artifact = buildAnalysisArtifact(
      {
        reply: 'Architecture analysis referencing design docs and code.',
        toolCalls: [
          {
            tool: 'code',
            args: { action: 'search', pattern: 'architecture' },
            result:
              '2 matches (showing 2)\n\nwakeflow-ledger/designs/space-seam-findings-2026-06-12.md:120: some doc line\nsrc/alpha.ts:3: export const alpha2 = 2;',
          },
        ],
      },
      'architecture'
    );
    const refs = artifact.referencedFiles as string[];
    expect(refs).toContain('wakeflow-ledger/designs/space-seam-findings-2026-06-12.md');
    expect(refs.some((r) => r.endsWith('.m'))).toBe(false);
  });
});

/** 便捷构造：与临时项目一致的代码文件 entry */
function evidenceEntryForFidelity(
  name: 'alpha' | 'beta' | 'gamma',
  startLine: number,
  endLine: number
): [string, { filePath: string; codeSnippets: object[]; summary: string }] {
  const filePath = `src/${name}.ts`;
  return [
    filePath,
    {
      filePath,
      summary: `${name} 常量导出`,
      codeSnippets: [{ startLine, endLine, content: fileLines(name, startLine, endLine) }],
    },
  ];
}

describe('R2 graph 证据流（关系声明不再被迫在阉割表述与编造 ref 间二选一）', () => {
  it('Analyst 真实 graph 调用物化为 graphEvidence，Producer 渲染可复制 graphRefs 段', () => {
    const collector = new EvidenceCollector();
    collector.processToolCall({
      tool: 'graph',
      args: { action: 'query', className: 'AlphaService' },
      result: {
        className: 'AlphaService',
        filePath: 'src/alpha.ts',
        superClass: 'BaseService',
        methods: ['start', 'stop'],
      },
    });
    const { graphEvidence } = collector.build();
    expect(graphEvidence).toHaveLength(1);
    expect(graphEvidence[0]).toContain('graph:class AlphaService (src/alpha.ts)');

    const prompt = buildProducerPromptV2(
      {
        analysisText: 'AlphaService extends BaseService.',
        evidenceMap: new Map(),
        graphEvidence,
        findings: [{ finding: 'AlphaService 继承结构', importance: 8 }],
        negativeSignals: [],
        referencedFiles: ['src/alpha.ts'],
      },
      { id: 'architecture', label: 'Architecture' },
      { name: 'Demo' }
    );
    expect(prompt).toContain('可复制 graphRefs');
    expect(prompt).toContain('graph:class AlphaService (src/alpha.ts)');
  });

  it('无 graph 调用时不渲染 graphRefs 段（不给编造留口子）', () => {
    const prompt = buildProducerPromptV2(
      {
        analysisText: 'No graph calls happened.',
        evidenceMap: new Map(),
        findings: [{ finding: '普通发现', importance: 7 }],
        negativeSignals: [],
        referencedFiles: [],
      },
      { id: 'architecture', label: 'Architecture' },
      { name: 'Demo' }
    );
    expect(prompt).not.toContain('可复制 graphRefs');
  });
});
