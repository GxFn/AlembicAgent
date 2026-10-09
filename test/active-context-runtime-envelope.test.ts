import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveContext } from '../src/agent/memory/ActiveContext.js';
import type {
  ToolMetadata,
  ToolPipelineContext,
} from '../src/agent/runtime/toolPipeline/contracts.js';
import { executeRuntimeToolCall } from '../src/agent/runtime/toolPipeline/runtimeBridge.js';
import { isToolResultEnvelope, type ToolResultEnvelope } from '../src/tools/kernel/index.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';
import { createTempProject } from './helpers/tempProject.js';

/**
 * L6-P10 夹具：信封不是手写的，而是经 runtimeBridge.executeRuntimeToolCall 真实路由产出
 * （metadata.envelope 正是 traceRecord 交给 ActiveContext.recordToolCall 的对象）。
 * 目的：证明 kernel 的严格守卫不会误拒生产信封，且摘要/台账拆包后是工具事实而非元数据。
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

async function bridgeEnvelope(
  root: string,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResultEnvelope> {
  const adapter = new ToolRouterAdapter({
    contextFactory: { create: () => ({ projectRoot: root, tokenBudget: 8000, projectGraph }) },
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
  const metadata: ToolMetadata = { cacheHit: false, blocked: false, isNew: false, durationMs: 0 };
  await executeRuntimeToolCall({ id: `call-${name}`, name, args }, context, metadata);
  if (!metadata.envelope) {
    throw new Error(`runtime bridge produced no envelope for ${name}`);
  }
  return metadata.envelope;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ActiveContext with envelopes produced by the runtime bridge', () => {
  it('accepts real envelopes through the strict kernel guard and distills tool facts', async () => {
    vi.stubEnv('RIPGREP_CONFIG_PATH', undefined);
    const root = makeProject();
    const batchArgs = { action: 'read', params: { filePaths: ['src/a.ts', 'src/missing.ts'] } };
    const searchArgs = {
      action: 'search',
      params: { patterns: ['Needle'], maxResults: 10, contextLines: 0 },
    };
    const graphArgs = { action: 'query', params: { type: 'class', entity: 'AlphaService' } };
    const missingArgs = { action: 'read', params: { path: 'src/missing.ts' } };

    const batch = await bridgeEnvelope(root, 'code', batchArgs);
    const search = await bridgeEnvelope(root, 'code', searchArgs);
    const graph = await bridgeEnvelope(root, 'graph', graphArgs);
    const missing = await bridgeEnvelope(root, 'code', missingArgs);

    for (const envelope of [batch, search, graph, missing]) {
      expect(isToolResultEnvelope(envelope)).toBe(true);
    }
    expect(batch.ok).toBe(true);
    expect(search.ok).toBe(true);
    expect(graph.ok).toBe(true);
    expect(missing.ok).toBe(false);

    const context = new ActiveContext({ maxRecentRounds: 1 });
    context.startRound(1);
    context.recordToolCall('code', batchArgs, batch, true);
    context.recordToolCall('code', searchArgs, search, true);
    context.recordToolCall('graph', graphArgs, graph, true);
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

    const meta = ActiveContext.buildObservationMeta('code', searchArgs, search, true);
    expect(meta.resultType).toBe('success');
    expect(meta.keyFacts).toContain('2 matches found');
    expect(meta.resultSize).toBe(search.text.length);
  });
});
