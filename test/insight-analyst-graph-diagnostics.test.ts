/**
 * Analyst 代码实体图谱段（§9）删除后的回归（W1-04：审阅包 L6-P26 / C56，决定①）。
 *
 * 背景：generateContextForAgent 在 Agent、Core、宿主中都没有实现，宿主只把 codeEntityGraph 作为
 * graph 工具端口注入工具上下文，所以 §9 在生产中从未渲染；系统提示却要求模型“优先使用注入的
 * codeEntityGraph”，指向一个不存在的注入源。按决定①删除：
 *   - §9 代码块、CodeEntityGraphLike 与 reportCodeEntityGraphRead 删除；
 *   - 系统提示删去 codeEntityGraph（保留 panorama / projectInfo / sessionStore）；
 *   - buildAnalystPrompt 第 6 个参数位置保留、类型放宽为 unknown，传入任何值都不调用、不注入；
 *   - §6 之前的 prompt-build-aborted 取消短路诊断保留。
 * graph 工具的 codeEntityGraph 端口（kernel registry 的 graph.query 读取表）不受影响；W1-05 起它在读取表中
 * 只承担 impact 一条读取路径（生产宿主形态的 impactAnalysis），旧宿主读取器已删除。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryReadDiagnostic } from '../src/agent/memory/MemoryReadPolicy.js';
import { ANALYST_SYSTEM_PROMPT, buildAnalystPrompt } from '../src/agent/prompts/insightAnalyst.js';
import { GRAPH_QUERY_HOST_READERS } from '../src/tools/kernel/registry.js';

type SemanticArg = Parameters<typeof buildAnalystPrompt>[4];

const DIM = { id: 'architecture', label: 'Architecture' };
const PROJECT = { name: 'FixtureProject', lang: 'typescript', fileCount: 2 };
const GRAPH_HINT = 'graph({ action: "query" }) 工具可以查询更详细的继承链';

async function build(
  graph: unknown,
  options: { abortSignal?: AbortSignal; semanticMemory?: SemanticArg } = {}
): Promise<{ prompt: string; diagnostics: MemoryReadDiagnostic[] }> {
  const diagnostics: MemoryReadDiagnostic[] = [];
  const prompt = await buildAnalystPrompt(
    DIM,
    PROJECT,
    null,
    null,
    options.semanticMemory ?? null,
    graph,
    null,
    null,
    null,
    null,
    null,
    {
      abortSignal: options.abortSignal,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }
  );
  return { prompt, diagnostics };
}

describe('insight analyst without the §9 code entity graph section (W1-04 / C56)', () => {
  it('stays silent and graph-free in the production shape where no graph port is injected', async () => {
    const { prompt, diagnostics } = await build(undefined);

    expect(diagnostics).toEqual([]);
    expect(prompt).not.toContain(GRAPH_HINT);
  });

  it('ignores a legacy graph context port: never calls it and never injects its output', async () => {
    const generateContextForAgent = vi.fn(async () => '## Code Entity Graph\nGraphCtxMarker');
    const { prompt, diagnostics } = await build({ generateContextForAgent });

    expect(generateContextForAgent).not.toHaveBeenCalled();
    expect(prompt).not.toContain('GraphCtxMarker');
    expect(prompt).not.toContain(GRAPH_HINT);
    expect(diagnostics.filter((d) => d.reason.startsWith('code-entity-graph'))).toEqual([]);
  });

  it('ignores the host graph tool port passed into the prompt builder', async () => {
    // 生产宿主形态的实体图端口只有 impactAnalysis（W1-05 起读取表只读这一条）。
    const toolPort = { impactAnalysis: vi.fn() };
    const { prompt, diagnostics } = await build(toolPort);

    expect(toolPort.impactAnalysis).not.toHaveBeenCalled();
    expect(prompt).not.toContain(GRAPH_HINT);
    expect(diagnostics).toEqual([]);
  });

  it('no longer tells the model to prefer an injected codeEntityGraph', () => {
    expect(ANALYST_SYSTEM_PROMPT).not.toContain('codeEntityGraph');
    expect(ANALYST_SYSTEM_PROMPT).toContain(
      '优先使用注入的 panorama / projectInfo / sessionStore，再用工具验证关键事实'
    );
  });

  it('removes the §9 port type and its diagnostic helper from the source', () => {
    const source = readFileSync(
      new URL('../src/agent/prompts/insightAnalyst.ts', import.meta.url),
      'utf8'
    );
    for (const retired of [
      'CodeEntityGraphLike',
      'reportCodeEntityGraphRead',
      'generateContextForAgent',
      'code-entity-graph',
    ]) {
      expect({ retired, present: source.includes(retired) }).toEqual({ retired, present: false });
    }
    // 参数位保留：第 6 个参数仍然存在，类型放宽为 unknown。
    expect(source).toMatch(/\n\s+_codeEntityGraph: unknown,\n/);
  });

  it('keeps the graph tool codeEntityGraph host port intact', () => {
    expect(GRAPH_QUERY_HOST_READERS.impact).toMatchObject({
      port: 'codeEntityGraph',
      method: 'impactAnalysis',
    });
  });

  it('reports the prompt-build abort short-circuit before session context', async () => {
    const controller = new AbortController();
    controller.abort();
    const generateContextForAgent = vi.fn(async () => 'GraphCtxMarker');
    const { prompt, diagnostics } = await build(
      { generateContextForAgent },
      { abortSignal: controller.signal }
    );

    expect(diagnostics).toEqual([
      { phase: 'session', status: 'aborted', reason: 'prompt-build-aborted' },
    ]);
    // 短路只返回 §1–§5 的部分提示，不再读取任何上下文端口。
    expect(generateContextForAgent).not.toHaveBeenCalled();
    expect(prompt).toContain('分析项目 FixtureProject');
  });
});
