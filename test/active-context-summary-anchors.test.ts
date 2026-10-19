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
import type { ToolResultEnvelope } from '../src/tools/kernel/index.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';
import { createTempProject } from './helpers/tempProject.js';

/**
 * AUD-sweep-c（审计 L6-P10a 第 1、2 条）：ActiveContext 摘要的两处残留。
 *
 * 夹具与 active-context-runtime-envelope.test.ts 同一思路：信封经 runtimeBridge 与
 * ToolRouterAdapter 真实路由产出，再交给 recordToolCall，断言 distill() 的摘要行。
 *   1. maxLines 省略后缀只认 handler 写出的独立一行（`\n... [N lines omitted; …]`）；
 *      全文读的最后一行源码恰好以这段字面量结尾时，不能被当成范围读并编造文件总行数。
 *   2. graph.overview 的投影没有 { type, entity, result } 包装，不能落到类模板写成“类 ?”；
 *      宿主图为空时的 message 也要保留；无法识别的形状退回类模板或通用截断时要留下诊断。
 */

const OMISSION_LITERAL = '... [7 lines omitted; use startLine/endLine for more]';

function createBridge(root: string, graph: unknown) {
  const adapter = new ToolRouterAdapter({
    contextFactory: {
      create: () => ({ projectRoot: root, tokenBudget: 8000, projectGraph: graph }),
    },
  });
  const context = {
    runtime: {
      id: 'summary-anchor-runtime',
      presetName: 'summary-anchor-preset',
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
    return metadata.envelope;
  };
}

async function distillCalls(
  root: string,
  graph: unknown,
  calls: Array<{ name: string; args: Record<string, unknown> }>
): Promise<{ summaries: string[]; envelopes: ToolResultEnvelope[] }> {
  const bridge = createBridge(root, graph);
  const context = new ActiveContext({ maxRecentRounds: 0 });
  context.startRound(1);
  const envelopes: ToolResultEnvelope[] = [];
  for (const call of calls) {
    const envelope = await bridge(call.name, call.args);
    envelopes.push(envelope);
    context.recordToolCall(call.name, call.args, envelope, true);
  }
  context.endRound();
  return { summaries: context.distill().toolCallSummary, envelopes };
}

function warnLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(([entry]) => String(entry));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ActiveContext read summary only trusts an omission suffix on its own line', () => {
  it('keeps a full read whose last source line ends with the omission literal as a full read', async () => {
    const root = createTempProject('active-context-anchor-');
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(
      path.join(root, 'docs', 'tricky.md'),
      ['a', 'b', `see: ${OMISSION_LITERAL}`].join('\n')
    );
    // 对照：真实的 maxLines 范围读，后缀由 handler 单独成行写出。
    writeFileSync(
      path.join(root, 'docs', 'nine.md'),
      Array.from({ length: 9 }, (_, i) => `l${i}`).join('\n')
    );
    const fullArgs = { action: 'read', params: { path: 'docs/tricky.md' } };
    const rangeArgs = { action: 'read', params: { path: 'docs/nine.md', maxLines: 2 } };

    const { summaries, envelopes } = await distillCalls(root, {}, [
      { name: 'code', args: fullArgs },
      { name: 'code', args: rangeArgs },
    ]);

    // 载荷事实：全文读的末行是带行号前缀的源码行，不是 handler 的省略标记行。
    expect(envelopes[0].structuredContent).toBe(`1|a\n2|b\n3|see: ${OMISSION_LITERAL}`);
    expect(envelopes[1].structuredContent).toBe(
      '1|l0\n2|l1\n... [7 lines omitted; use startLine/endLine for more]'
    );
    expect(summaries).toEqual([
      '[code] 文件 docs/tricky.md (3 行)',
      '[code] 文件 docs/nine.md L1-2 (范围读取，展示 2 行，文件共 9 行)',
    ]);
  });
});

describe('ActiveContext graph.overview summary', () => {
  const overviewArgs = { action: 'overview' };

  it('summarizes a host GraphOverview by its module facts instead of the class template', async () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    // 形状对齐主仓宿主 ProjectGraphPorts.getOverview（GraphOverview）：模块与模块依赖是结果数组，
    // graphRefs 只是引用，index 是索引状态对象。
    const graph = {
      getOverview: async () => ({
        index: { freshness: 'fresh', coverageGaps: 0, files: 40, externalEngine: 'none' },
        modules: [
          { name: 'core', kind: 'module', files: 12 },
          { name: 'ui', kind: 'module', files: 8 },
          { name: 'tools', kind: 'module', files: 5 },
          { name: 'extra', kind: 'module', files: 1 },
        ],
        moduleDependencies: [
          { from: 'ui', to: 'core', relations: 9, kinds: { import: 9 } },
          { from: 'tools', to: 'core', relations: 2, kinds: { import: 2 } },
        ],
        unownedFiles: 3,
        truncated: true,
        graphRefs: ['ref-ui-core', 'ref-tools-core'],
      }),
    };
    const root = createTempProject('active-context-anchor-');

    const { summaries, envelopes } = await distillCalls(root, graph, [
      { name: 'graph', args: overviewArgs },
    ]);

    expect(envelopes[0].ok).toBe(true);
    const [overview] = summaries;
    expect(overview).toBe(
      '[graph] 图谱 overview: modules 4 条、moduleDependencies 2 条；unownedFiles 3；结果已截断\n  core\n  ui\n  tools'
    );
    expect(overview).not.toContain('类 ');
    expect(overview).not.toContain('ref-ui-core');
    expect(warnLines(warn).filter((line) => line.includes('[ActiveContext]'))).toEqual([]);
  });

  it('keeps legacy statistics and the empty-graph message of graph.overview', async () => {
    const root = createTempProject('active-context-anchor-');
    const legacy = {
      getOverview: async () => ({ totalFiles: 3, totalClasses: 2, topLevelModules: ['src'] }),
    };
    // 宿主返回 null：handler 投影为 { message }，没有 entity。
    const empty = { getOverview: async () => null };

    const legacyRun = await distillCalls(root, legacy, [{ name: 'graph', args: overviewArgs }]);
    const emptyRun = await distillCalls(root, empty, [{ name: 'graph', args: overviewArgs }]);

    expect(emptyRun.envelopes[0].structuredContent).toEqual({
      message: 'Project graph is empty or not built yet',
    });
    expect(legacyRun.summaries).toEqual([
      '[graph] 图谱 overview: topLevelModules 1 条；totalFiles 3、totalClasses 2\n  src',
    ]);
    expect(emptyRun.summaries).toEqual([
      '[graph] 图谱 overview: Project graph is empty or not built yet',
    ]);
  });

  it('logs a diagnostic instead of silently using the class template for shapes it cannot read', async () => {
    const warn = vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => undefined);
    const root = createTempProject('active-context-anchor-');
    const graph = {
      // overview 只有一个索引状态对象：没有结果数组、数值统计或 message。
      getOverview: async () => ({ index: { freshness: 'stale' } }),
      // 列表型查询却没有任何结果数组：形状漂移，类模板只能给出实体名。
      getCallers: async (entity: string) => ({ entity, direction: 'callers' }),
    };

    const { summaries } = await distillCalls(root, graph, [
      { name: 'graph', args: overviewArgs },
      { name: 'graph', args: { action: 'query', params: { type: 'callers', entity: 'Alpha' } } },
    ]);

    const [overview, callers] = summaries;
    expect(overview).toBe('[graph] 图谱 overview: {"index":{"freshness":"stale"}}');
    expect(callers).toBe('[graph] 类 Alpha');
    const diagnostics = warnLines(warn).filter((line) => line.includes('[ActiveContext] graph'));
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /graph overview summary fell back to JSON truncation: no result arrays, numeric facts or message; keys=index/
        ),
        expect.stringMatching(
          /graph summary fell back to class template: type=callers entity=Alpha .*keys=entity,direction/
        ),
      ])
    );
  });
});
