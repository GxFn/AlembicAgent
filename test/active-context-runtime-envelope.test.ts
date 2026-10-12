import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveContext } from '../src/agent/memory/ActiveContext.js';
import type {
  ToolMetadata,
  ToolPipelineContext,
} from '../src/agent/runtime/toolPipeline/contracts.js';
import { executeRuntimeToolCall } from '../src/agent/runtime/toolPipeline/runtimeBridge.js';
import { estimateTokens } from '../src/shared/tokenUtils.js';
import { isToolResultEnvelope, type ToolResultEnvelope } from '../src/tools/kernel/index.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';
import { DeltaCache } from '../src/tools/runtime/cache/DeltaCache.js';
import { createTempProject } from './helpers/tempProject.js';

/**
 * L6-P10 / L6-P10a 夹具：信封不是手写的，而是经 runtimeBridge.executeRuntimeToolCall 真实路由产出
 * （metadata.envelope 正是 traceRecord 交给 ActiveContext.recordToolCall 的对象）。
 * 目的：证明 kernel 的严格守卫不会误拒生产信封，且摘要/台账拆包后是工具事实而非元数据。
 * 适配器从不产出手写的 { ok, path, content, lineCount } 单文件形状——单文件成功读取的
 * structuredContent 就是 handler 的 content 字符串，摘要必须从调用参数取路径。
 */
function makeProject() {
  const root = createTempProject('active-context-envelope-');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  // 不带结尾换行：lineCount 与断言中的行数一一对应。
  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const alphaNeedle = 1;');
  writeFileSync(
    path.join(root, 'src', 'b.ts'),
    'export const beta = 2;\nexport const betaNeedle = alphaNeedle;'
  );
  return root;
}

const projectGraph = {
  getClassInfo: (entity: string) => ({
    className: entity,
    superClass: 'BaseService',
    protocols: ['Runnable'],
    methods: ['run', 'stop'],
    properties: ['state'],
  }),
};

interface BridgeOptions {
  tokenBudget?: number;
  graph?: unknown;
  codeEntityGraph?: unknown;
  deltaCache?: DeltaCache;
  astAnalyzer?: unknown;
}

/** 同一个适配器服务一组调用：DeltaCache 等跨调用状态与生产会话一致。 */
function createBridge(root: string, options: BridgeOptions = {}) {
  const adapter = new ToolRouterAdapter({
    contextFactory: {
      create: () => ({
        projectRoot: root,
        tokenBudget: options.tokenBudget ?? 8000,
        projectGraph: options.graph ?? projectGraph,
        ...(options.codeEntityGraph ? { codeEntityGraph: options.codeEntityGraph } : {}),
        ...(options.deltaCache ? { deltaCache: options.deltaCache } : {}),
        ...(options.astAnalyzer ? { astAnalyzer: options.astAnalyzer } : {}),
      }),
    },
  });
  const context = {
    runtime: {
      id: 'envelope-runtime',
      presetName: 'envelope-preset',
      policies: {},
      toolRouter: adapter,
    },
    loopCtx: { allowedToolIds: ['code', 'graph'], allowedToolActions: {}, iteration: 1 },
    iteration: 1,
  } as unknown as ToolPipelineContext;
  let sequence = 0;
  return async (name: string, args: Record<string, unknown>): Promise<ToolResultEnvelope> => {
    const metadata: ToolMetadata = { cacheHit: false, blocked: false, isNew: false, durationMs: 0 };
    sequence++;
    await executeRuntimeToolCall({ id: `call-${name}-${sequence}`, name, args }, context, metadata);
    if (!metadata.envelope) {
      throw new Error(`runtime bridge produced no envelope for ${name}`);
    }
    expect(isToolResultEnvelope(metadata.envelope)).toBe(true);
    return metadata.envelope;
  };
}

async function bridgeEnvelope(
  root: string,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResultEnvelope> {
  return createBridge(root)(name, args);
}

const readArgs = (params: Record<string, unknown>) => ({ action: 'read', params });
const searchArgs = (patterns: string[]) => ({
  action: 'search',
  params: { patterns, maxResults: 10, contextLines: 0 },
});
const graphArgs = (type: string, entity: string) => ({
  action: 'query',
  params: { type, entity },
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ActiveContext with envelopes produced by the runtime bridge', () => {
  it('accepts real envelopes through the strict kernel guard and distills tool facts', async () => {
    vi.stubEnv('RIPGREP_CONFIG_PATH', undefined);
    const root = makeProject();
    const batchArgs = readArgs({ filePaths: ['src/a.ts', 'src/missing.ts'] });
    const search = searchArgs(['Needle']);
    const graphQuery = graphArgs('class', 'AlphaService');
    const missingArgs = readArgs({ path: 'src/missing.ts' });

    const batch = await bridgeEnvelope(root, 'code', batchArgs);
    const searchEnvelope = await bridgeEnvelope(root, 'code', search);
    const graph = await bridgeEnvelope(root, 'graph', graphQuery);
    const missing = await bridgeEnvelope(root, 'code', missingArgs);

    for (const envelope of [batch, searchEnvelope, graph, missing]) {
      expect(isToolResultEnvelope(envelope)).toBe(true);
    }
    expect(batch.ok).toBe(true);
    expect(searchEnvelope.ok).toBe(true);
    expect(graph.ok).toBe(true);
    expect(missing.ok).toBe(false);

    const context = new ActiveContext({ maxRecentRounds: 1 });
    context.startRound(1);
    context.recordToolCall('code', batchArgs, batch, true);
    context.recordToolCall('code', search, searchEnvelope, true);
    context.recordToolCall('graph', graphQuery, graph, true);
    context.recordToolCall('code', missingArgs, missing, false);
    context.endRound();

    const actions = context.getStats();
    expect(actions.totalActions).toBe(4);
    const { toolCallSummary } = context.distill();
    expect(toolCallSummary).toHaveLength(4);
    for (const line of toolCallSummary) {
      for (const word of ['callId', 'startedAt', 'toolId', 'durationMs', 'trust', '"ok"']) {
        expect(line, line).not.toContain(word);
      }
    }
    const [readLine, searchLine, graphLine, missingLine] = toolCallSummary;
    expect(readLine).toContain('[code] 读取 2 个文件');
    expect(readLine).toContain('src/a.ts (1 行)');
    expect(readLine).toContain('src/missing.ts (失败:');
    expect(searchLine).toContain('[code] 搜索到 2 个匹配');
    expect(searchLine).toContain('src/a.ts: L1');
    expect(graphLine).toContain('[graph] 类 AlphaService');
    expect(graphLine).toContain('继承: BaseService');
    // 单文件失败的信封载荷就是 handler 的错误文本；蒸馏行按 150 字符截断，只断言状态前缀与原因。
    expect(missingLine).toMatch(/^\[code\] \[error\] Cannot read file/);

    const rendered = context.buildContext(6000);
    expect(rendered).toContain('## Observation Ledger');
    expect(rendered).toContain('- [R1|code] src/a.ts');
    const failureSection = rendered.split('### failureSet')[1]?.split('### nextHints')[0] ?? '';
    expect(failureSection).toContain('src/missing.ts');
    expect(rendered).not.toContain('callId');
    expect(rendered).not.toContain('startedAt');

    const meta = ActiveContext.buildObservationMeta('code', search, searchEnvelope, true);
    expect(meta.resultType).toBe('success');
    expect(meta.keyFacts).toContain('2 matches found');
    expect(meta.resultSize).toBe(searchEnvelope.text.length);
  });
});

describe('ActiveContext summaries of production payload shapes (L6-P10a)', () => {
  it('summarizes a successful single-file read by the call path and line count', async () => {
    const root = makeProject();
    const bridge = createBridge(root);
    const fullArgs = readArgs({ path: 'src/b.ts' });
    const rangeArgs = readArgs({ path: 'src/b.ts', startLine: 2, endLine: 2 });
    const flatArgs = { action: 'read', path: 'src/a.ts' };
    const full = await bridge('code', fullArgs);
    const range = await bridge('code', rangeArgs);
    const flat = await bridge('code', readArgs({ path: 'src/a.ts' }));

    // 生产单文件读取的载荷是带行号的源码字符串，不是 { path, content, lineCount } 对象。
    for (const envelope of [full, range, flat]) {
      expect(envelope.ok).toBe(true);
      expect(typeof envelope.structuredContent).toBe('string');
    }

    // maxRecentRounds=1：前两条走滑出压缩，最后一条走蒸馏时的即时压缩，两条路径都要覆盖。
    const context = new ActiveContext({ maxRecentRounds: 1 });
    context.startRound(1);
    context.recordToolCall('code', fullArgs, full, true);
    context.recordToolCall('code', rangeArgs, range, false);
    // 宿主也可能传入扁平参数（无 params 嵌套）；路径同样从调用参数读取。
    context.recordToolCall('code', flatArgs, flat, true);
    context.endRound();

    // 范围读取只展示了第 2 行：摘要写明展示区间，不能把展示行数冒充文件行数。
    expect(context.distill().toolCallSummary).toEqual([
      '[code] 文件 src/b.ts (2 行)',
      '[code] 文件 src/b.ts L2-2 (范围读取，展示 1 行)',
      '[code] 文件 src/a.ts (1 行)',
    ]);
    const rendered = context.buildContext(6000);
    const readSection = rendered.split('### readSet')[1]?.split('###')[0] ?? '';
    expect(readSection).toContain('src/b.ts');
    expect(rendered).not.toContain('### failureSet');
  });

  it('distills the final observed single-file reads without leaking source text', async () => {
    const root = makeProject();
    writeFileSync(path.join(root, 'src', 'c.ts'), 'export const gamma = 3;');
    const bridge = createBridge(root);
    const context = new ActiveContext();
    context.startRound(1);
    for (const file of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
      const args = readArgs({ path: file });
      context.recordToolCall('code', args, await bridge('code', args), true);
    }
    context.endRound();
    const distilled = context.distill();
    expect(distilled.totalObservations).toBe(3);
    // 蒸馏摘要是宿主直接拼进 analysisText 的人类可读文本：必须是文件事实，不能是源码片段。
    expect(distilled.toolCallSummary).toEqual([
      '[code] 文件 src/a.ts (1 行)',
      '[code] 文件 src/b.ts (2 行)',
      '[code] 文件 src/c.ts (1 行)',
    ]);
    for (const line of distilled.toolCallSummary) {
      expect(line).not.toContain('export const');
    }
  });

  it('marks an unchanged re-read instead of counting the delta-cache placeholder as one line', async () => {
    const root = makeProject();
    const bridge = createBridge(root, { deltaCache: new DeltaCache() });
    const args = readArgs({ path: 'src/b.ts' });
    const first = await bridge('code', args);
    const second = await bridge('code', args);
    expect(second.structuredContent).toBe('[unchanged since last read]');

    const context = new ActiveContext({ maxRecentRounds: 0 });
    context.startRound(1);
    context.recordToolCall('code', args, first, true);
    context.recordToolCall('code', args, second, false);
    context.endRound();
    expect(context.distill().toolCallSummary).toEqual([
      '[code] 文件 src/b.ts (2 行)',
      '[code] 文件 src/b.ts (自上次读取未变化)',
    ]);
  });

  it('takes the total of a large file from the handler marker and labels the outline or head+tail view', async () => {
    const root = makeProject();
    // 800 行、无结尾换行：handler 的 lineCount 正好是 800；>500 行且不带范围时只返回大纲或头尾预览。
    const source = Array.from({ length: 800 }, (_, index) => `export const v${index} = ${index};`);
    writeFileSync(path.join(root, 'src', 'big.ts'), source.join('\n'));
    const args = readArgs({ path: 'src/big.ts' });

    // 宿主没有 AST 分析器：handler 退回头尾预览（约 52 行展示内容）。
    const preview = await createBridge(root)('code', args);
    expect(preview.ok).toBe(true);
    expect(String(preview.structuredContent)).toMatch(
      /^\/\/ src\/big\.ts — 800 lines \(showing head \+ tail\)/
    );
    // 宿主注入 AST 分析器：handler 返回大纲，总行数只出现在结尾标记里。
    const astAnalyzer = {
      analyzeFile: async () => ({
        definitions: [
          { name: 'v0', kind: 'variable', startLine: 1, endLine: 1, depth: 0 },
          { name: 'v799', kind: 'variable', startLine: 800, endLine: 800, depth: 0 },
        ],
      }),
    };
    const outline = await createBridge(root, { astAnalyzer })('code', args);
    expect(outline.ok).toBe(true);
    expect(String(outline.structuredContent)).toMatch(/File has 800 lines\. Showing outline\./);

    const context = new ActiveContext({ maxRecentRounds: 0 });
    context.startRound(1);
    context.recordToolCall('code', args, preview, true);
    context.recordToolCall('code', args, outline, false);
    context.endRound();
    expect(context.distill().toolCallSummary).toEqual([
      '[code] 文件 src/big.ts (共 800 行，头尾预览)',
      '[code] 文件 src/big.ts (共 800 行，大纲)',
    ]);
  });

  it('labels a delta-cache re-read after a modification as an incremental change', async () => {
    const root = makeProject();
    const file = path.join(root, 'src', 'seven.ts');
    writeFileSync(file, ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n'));
    const bridge = createBridge(root, { deltaCache: new DeltaCache() });
    const args = readArgs({ path: 'src/seven.ts' });
    const first = await bridge('code', args);
    writeFileSync(file, ['a', 'b', 'X', 'd', 'e', 'f', 'g'].join('\n'));
    const second = await bridge('code', args);
    // 生产重读的载荷是 diff 文本，不是源码：它的 4 行不是文件行数。
    expect(second.structuredContent).toBe('[delta: 1 hunk(s)]\n@@ line 3 @@\n- c\n+ X');

    const context = new ActiveContext({ maxRecentRounds: 0 });
    context.startRound(1);
    context.recordToolCall('code', args, first, true);
    context.recordToolCall('code', args, second, false);
    context.endRound();
    expect(context.distill().toolCallSummary).toEqual([
      '[code] 文件 src/seven.ts (7 行)',
      '[code] 文件 src/seven.ts (自上次读取有变更，增量 1 处)',
    ]);
  });

  it('states the displayed range of maxLines and line-range reads without counting the omission suffix', async () => {
    const root = makeProject();
    writeFileSync(
      path.join(root, 'src', 'seven.ts'),
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n')
    );
    const bridge = createBridge(root);
    const headArgs = readArgs({ path: 'src/seven.ts', maxLines: 2 });
    const middleArgs = readArgs({ path: 'src/seven.ts', startLine: 3, maxLines: 2 });
    const tailArgs = readArgs({ path: 'src/seven.ts', startLine: 6, maxLines: 5 });
    const pastEndArgs = readArgs({ path: 'src/seven.ts', startLine: 20, endLine: 25 });
    const head = await bridge('code', headArgs);
    const middle = await bridge('code', middleArgs);
    const tail = await bridge('code', tailArgs);
    const pastEnd = await bridge('code', pastEndArgs);
    expect(head.structuredContent).toBe(
      '1|a\n2|b\n... [5 lines omitted; use startLine/endLine for more]'
    );
    for (const envelope of [head, middle, tail, pastEnd]) {
      expect(envelope.ok).toBe(true);
    }

    const context = new ActiveContext({ maxRecentRounds: 0 });
    context.startRound(1);
    context.recordToolCall('code', headArgs, head, true);
    context.recordToolCall('code', middleArgs, middle, true);
    context.recordToolCall('code', tailArgs, tail, true);
    context.recordToolCall('code', pastEndArgs, pastEnd, true);
    context.endRound();
    // 省略后缀给出的是 end 之后的行数：文件总行数 = 展示的末行号 + 省略行数。
    expect(context.distill().toolCallSummary).toEqual([
      '[code] 文件 src/seven.ts L1-2 (范围读取，展示 2 行，文件共 7 行)',
      '[code] 文件 src/seven.ts L3-4 (范围读取，展示 2 行，文件共 7 行)',
      '[code] 文件 src/seven.ts L6-7 (范围读取，展示 2 行)',
      '[code] 文件 src/seven.ts (范围读取 L20-25，无内容)',
    ]);
  });

  it('marks a full read cut by the router output limit instead of counting the visible fragments', async () => {
    const root = makeProject();
    // 450 行（≤500 走全文分支）但约 4 万字符：超过 code.read 的 maxOutputTokens，Router 只保留头尾。
    const source = Array.from(
      { length: 450 },
      (_, index) => `export const value${index} = '${'x'.repeat(70)}';`
    );
    writeFileSync(path.join(root, 'src', 'long.ts'), source.join('\n'));
    const args = readArgs({ path: 'src/long.ts' });
    // 范围读同样可能被 Router 截断：显式区间与带省略后缀的 maxLines（后缀落在截断后的尾部）。
    const rangeArgs = readArgs({ path: 'src/long.ts', startLine: 5, endLine: 440 });
    const maxLinesArgs = readArgs({ path: 'src/long.ts', maxLines: 400 });
    const bridge = createBridge(root);
    const envelopes = [
      await bridge('code', args),
      await bridge('code', rangeArgs),
      await bridge('code', maxLinesArgs),
    ];
    for (const envelope of envelopes) {
      expect(envelope.ok).toBe(true);
      expect(String(envelope.structuredContent)).toMatch(
        /\.\.\. \[\d+ chars truncated, exceeded \d+ token limit\] \.\.\./
      );
    }
    expect(String(envelopes[2].structuredContent)).toMatch(
      /\.\.\. \[50 lines omitted; use startLine\/endLine for more\]$/
    );

    const context = new ActiveContext({ maxRecentRounds: 0 });
    context.startRound(1);
    context.recordToolCall('code', args, envelopes[0], true);
    context.recordToolCall('code', rangeArgs, envelopes[1], true);
    context.recordToolCall('code', maxLinesArgs, envelopes[2], true);
    context.endRound();
    // 截断后可见片段的行数毫无意义：全文读的末行仍在尾部，末行号即总行数；范围读写明区间与截断。
    expect(context.distill().toolCallSummary).toEqual([
      '[code] 文件 src/long.ts (共 450 行，输出超限截断，仅展示头尾)',
      '[code] 文件 src/long.ts L5-440 (范围读取，输出超限截断，仅展示头尾)',
      '[code] 文件 src/long.ts L1-400 (范围读取，输出超限截断，仅展示头尾，文件共 450 行)',
    ]);
  });

  it('reports zero-hit and budget-exhausted searches as match counts instead of raw JSON', async () => {
    vi.stubEnv('RIPGREP_CONFIG_PATH', undefined);
    const root = makeProject();
    const zeroArgs = searchArgs(['NoSuchSymbolAnywhere']);
    const zero = await createBridge(root)('code', zeroArgs);
    expect(zero.ok).toBe(true);
    expect(zero.structuredContent).toMatchObject({ total: 0, shown: 0, matches: [] });

    // 预算只够放下计数：适配器投影为 { total:2, shown:0, matches:[] }，命中全部被省略。
    const starvedArgs = searchArgs(['Needle']);
    const starved = await createBridge(root, { tokenBudget: 45 })('code', starvedArgs);
    expect(starved.ok).toBe(true);
    expect(starved.structuredContent).toMatchObject({ total: 2, shown: 0, matches: [] });

    const context = new ActiveContext({ maxRecentRounds: 0 });
    context.startRound(1);
    context.recordToolCall('code', zeroArgs, zero, true);
    context.recordToolCall('code', starvedArgs, starved, true);
    context.endRound();

    const [zeroLine, starvedLine] = context.distill().toolCallSummary;
    expect(zeroLine).toBe('[code] 搜索到 0 个匹配');
    expect(starvedLine).toBe('[code] 搜索到 2 个匹配（显示 0）');
    const rendered = context.buildContext(6000);
    expect(rendered).not.toContain('"total"');
    expect(rendered).toContain('NoSuchSymbolAnywhere');
  });

  it('summarizes graph array results by query type with counts and leading items', async () => {
    const root = makeProject();
    const arrayGraph = {
      ...projectGraph,
      getCallers: () => [
        { caller: 'AlphaController.handle', file: 'src/a.ts', line: 3 },
        { caller: 'AlphaJob.run', file: 'src/b.ts', line: 7 },
        { caller: 'AlphaCli.main', file: 'src/c.ts', line: 1 },
      ],
      getCallees: () => [],
      searchEntities: () => ['AlphaService', 'AlphaRepository'],
    };
    const bridge = createBridge(root, { graph: arrayGraph });
    const callersArgs = graphArgs('callers', 'AlphaService');
    const calleesArgs = graphArgs('callees', 'AlphaService');
    const searchQueryArgs = graphArgs('search', 'Alpha');
    const callers = await bridge('graph', callersArgs);
    const callees = await bridge('graph', calleesArgs);
    const search = await bridge('graph', searchQueryArgs);
    for (const envelope of [callers, callees, search]) {
      expect(envelope.ok).toBe(true);
      expect(Array.isArray((envelope.structuredContent as { result?: unknown }).result)).toBe(true);
    }

    const context = new ActiveContext({ maxRecentRounds: 0 });
    context.startRound(1);
    context.recordToolCall('graph', callersArgs, callers, true);
    context.recordToolCall('graph', calleesArgs, callees, false);
    context.recordToolCall('graph', searchQueryArgs, search, true);
    context.endRound();

    const [callersLine, calleesLine, searchLine] = context.distill().toolCallSummary;
    expect(callersLine).toContain('[graph] 图谱 callers AlphaService: 3 条结果');
    expect(callersLine).toContain('AlphaController.handle (src/a.ts:3)');
    expect(calleesLine).toBe('[graph] 图谱 callees AlphaService: 0 条结果');
    expect(searchLine).toContain('[graph] 图谱 search Alpha: 2 条结果');
    expect(searchLine).toContain('AlphaRepository');
    for (const line of [callersLine, calleesLine, searchLine]) {
      expect(line).not.toContain('类 ');
    }
  });

  it('summarizes host graph answers that carry their result lists inside an object', async () => {
    const root = makeProject();
    // 形状对齐主仓宿主端口（GraphCallList / GraphSearchResult / GraphImpact / GraphHierarchy /
    // GraphUnresolved）：结果数组在回答对象里，旁边的 graphRefs/candidates 不是结果。
    const symbol = (name: string, location: string) => ({ name, kind: 'method', location });
    const hostGraph = {
      ...projectGraph,
      getCallers: (entity: string) => ({
        entity,
        direction: 'callers',
        calls: [
          { ...symbol('AlphaController.handle', 'src/a.ts:3'), sites: ['src/a.ts:4'], tier: 'x' },
          { ...symbol('AlphaJob.run', 'src/b.ts:7'), sites: ['src/b.ts:9'], tier: 'x' },
        ],
        truncated: false,
        graphRefs: ['ref-1', 'ref-2', 'ref-3'],
        index: { freshness: 'fresh', coverageGaps: 0 },
      }),
      searchEntities: (query: string) => ({
        query,
        results: [symbol('AlphaService', 'src/a.ts:1')],
        index: { freshness: 'fresh', coverageGaps: 0 },
      }),
      getClassHierarchy: (entity: string) => ({
        entity,
        symbol: symbol(entity, 'src/a.ts:1'),
        supertypes: [{ ...symbol('BaseService', 'src/base.ts:1'), distance: 1 }],
        subtypes: [],
        truncated: false,
        graphRefs: [],
        index: { freshness: 'fresh', coverageGaps: 0 },
      }),
      getProtocolInfo: (entity: string) => ({
        entity,
        resolved: false,
        reason: 'ambiguous',
        message: `${entity} matches more than one declaration`,
        candidates: ['src/a.ts#Runnable', 'src/b.ts#Runnable'],
      }),
    };
    const entityGraph = {
      impactAnalysis: (entity: string) => ({
        entity,
        impactedFiles: ['src/b.ts', 'src/c.ts'],
        impactedSymbols: [symbol('AlphaJob.run', 'src/b.ts:7')],
        tests: ['test/alpha.test.ts'],
        depth: 2,
        truncated: false,
        graphRefs: ['ref-1'],
        index: { freshness: 'fresh', coverageGaps: 0 },
      }),
    };
    const bridge = createBridge(root, { graph: hostGraph, codeEntityGraph: entityGraph });
    const queries = [
      graphArgs('callers', 'AlphaService'),
      graphArgs('search', 'Alpha'),
      graphArgs('impact', 'AlphaService'),
      graphArgs('hierarchy', 'AlphaService'),
      graphArgs('protocol', 'Runnable'),
    ];
    const context = new ActiveContext({ maxRecentRounds: 0 });
    context.startRound(1);
    for (const args of queries) {
      const envelope = await bridge('graph', args);
      expect(envelope.ok).toBe(true);
      context.recordToolCall('graph', args, envelope, true);
    }
    context.endRound();

    const [callers, search, impact, hierarchy, unresolved] = context.distill().toolCallSummary;
    expect(callers).toBe(
      '[graph] 图谱 callers AlphaService: 2 条结果\n  AlphaController.handle (src/a.ts:3)\n  AlphaJob.run (src/b.ts:7)'
    );
    expect(search).toBe('[graph] 图谱 search Alpha: 1 条结果\n  AlphaService (src/a.ts:1)');
    expect(impact).toContain(
      '[graph] 图谱 impact AlphaService: impactedFiles 2 条、impactedSymbols 1 条、tests 1 条'
    );
    expect(impact).toContain('  src/b.ts');
    expect(hierarchy).toContain(
      '[graph] 图谱 hierarchy AlphaService: supertypes 1 条、subtypes 0 条'
    );
    expect(hierarchy).toContain('BaseService (src/base.ts:1)');
    expect(unresolved).toBe(
      '[graph] 图谱 protocol Runnable: 未解析 (ambiguous)\n  Runnable matches more than one declaration\n  候选 2 个'
    );
    for (const line of [callers, search, impact, hierarchy, unresolved]) {
      expect(line).not.toContain('类 ');
      expect(line).not.toContain('ref-1');
    }
  });

  it('logs when the observation ledger is skipped or truncated by the budget', async () => {
    const info = vi.spyOn(Logger.getInstance(), 'info').mockImplementation(() => undefined);
    const root = makeProject();
    const bridge = createBridge(root);
    const context = new ActiveContext({ maxRecentRounds: 0 });
    context.noteKeyFinding('finding '.repeat(40), 'E-1=src/a.ts:1', 9);
    context.startRound(1);
    for (let index = 0; index < 12; index++) {
      const dir = path.join(root, 'src', 'modules', `feature-${index}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'implementation-details.ts'), 'x');
      const args = readArgs({ path: `src/modules/feature-${index}/implementation-details.ts` });
      context.recordToolCall('code', args, await bridge('code', args), true);
    }
    context.endRound();
    const full = context.buildContext(Infinity);
    expect(full).toContain('## Observation Ledger');
    const scratchTokens = estimateTokens(full.split('\n## Observation Ledger')[0]);
    const fullTokens = estimateTokens(full);
    expect(fullTokens - scratchTokens).toBeGreaterThan(150);

    // 剩余预算 ≤ 100：整段跳过，且必须留下可定位的降级日志。
    const skipped = context.buildContext(scratchTokens + 90);
    expect(skipped).not.toContain('## Observation Ledger');
    let messages = info.mock.calls.map((call) => String(call[0]));
    expect(messages.some((message) => message.includes('observation ledger skipped'))).toBe(true);
    expect(messages.some((message) => message.includes('reason=budget_exhausted'))).toBe(true);

    // 剩余预算放得下标题但放不下全部条目：按类截断并记录省略条数。
    info.mockClear();
    const truncated = context.buildContext(fullTokens - 20);
    expect(truncated).toContain('## Observation Ledger');
    expect(truncated.length).toBeLessThan(full.length);
    messages = info.mock.calls.map((call) => String(call[0]));
    const truncation = messages.find((message) => message.includes('observation ledger truncated'));
    expect(truncation).toBeDefined();
    expect(truncation).toMatch(/omitted (readSet|evidence)=\d+/);
  });
});
