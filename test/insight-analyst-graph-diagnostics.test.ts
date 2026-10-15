/**
 * Analyst 代码实体图谱段（§9）与 abort 短路的诊断（模块审阅 L6-P26 / C56）。
 *
 * 背景：generateContextForAgent 在 Agent、Core、宿主中都没有实现，宿主只把 codeEntityGraph 作为
 * graph 工具端口传入，所以 §9 在生产中不可达。§9 删除还是接线取决于待决事项①；决定之前本轮只补诊断，
 * 不删除段落、不改系统提示、不改函数签名：
 *   - 图谱读取抛错不再被静默吞掉；
 *   - 端口缺少 generateContextForAgent、或返回非字符串时报告 invalid，且不把它注入提示；
 *   - 因取消跳过 §9、以及 §6 之前的 abort 短路都留下 aborted 诊断。
 * 生产形状（不传图谱端口）必须保持零诊断，避免每个维度都向 DiagnosticsCollector 灌噪声。
 */
import { describe, expect, it, vi } from 'vitest';
import type { MemoryReadDiagnostic } from '../src/agent/memory/MemoryReadPolicy.js';
import { buildAnalystPrompt } from '../src/agent/prompts/insightAnalyst.js';

type GraphArg = Parameters<typeof buildAnalystPrompt>[5];
type SemanticArg = Parameters<typeof buildAnalystPrompt>[4];

const DIM = { id: 'architecture', label: 'Architecture' };
const PROJECT = { name: 'FixtureProject', lang: 'typescript', fileCount: 2 };

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
    graph as GraphArg,
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

function graphDiagnostics(diagnostics: MemoryReadDiagnostic[]): MemoryReadDiagnostic[] {
  return diagnostics.filter((d) => d.reason.startsWith('code-entity-graph'));
}

describe('insight analyst §9 code entity graph diagnostics (C56)', () => {
  it('stays silent in the production shape where no graph port is injected', async () => {
    const { prompt, diagnostics } = await build(undefined);

    expect(diagnostics).toEqual([]);
    expect(prompt).not.toContain('graph({ action: "query" }) 工具可以查询更详细的继承链');
  });

  it('injects a string graph context with its follow-up hint and no diagnostics', async () => {
    const generateContextForAgent = vi.fn(async () => '## Code Entity Graph\nGraphCtxMarker');
    const { prompt, diagnostics } = await build({ generateContextForAgent });

    expect(generateContextForAgent).toHaveBeenCalledWith({ maxEntities: 20, maxEdges: 40 });
    expect(prompt).toContain('GraphCtxMarker');
    expect(prompt).toContain('graph({ action: "query" }) 工具可以查询更详细的继承链');
    expect(graphDiagnostics(diagnostics)).toEqual([]);
  });

  it('reports a thrown graph read as an error instead of swallowing it', async () => {
    const { prompt, diagnostics } = await build({
      generateContextForAgent: async () => {
        throw new RangeError('graph store unavailable');
      },
    });

    expect(graphDiagnostics(diagnostics)).toEqual([
      { phase: 'session', status: 'error', reason: 'code-entity-graph-error:RangeError' },
    ]);
    // 诊断只带错误名，不带 provider 原始消息，避免观测链泄漏图谱内容。
    expect(JSON.stringify(diagnostics)).not.toContain('graph store unavailable');
    expect(prompt).not.toContain('graph({ action: "query" }) 工具可以查询更详细的继承链');
  });

  it('reports a synchronous throw from the port as an error', async () => {
    const { diagnostics } = await build({
      generateContextForAgent: () => {
        throw new Error('sync failure');
      },
    });

    expect(graphDiagnostics(diagnostics)).toEqual([
      { phase: 'session', status: 'error', reason: 'code-entity-graph-error:Error' },
    ]);
  });

  it('reports a graph tool port without generateContextForAgent as invalid', async () => {
    // 宿主真实的 codeEntityGraph 是 graph 工具端口（queryEntity / impactAnalysis / search），没有本方法；
    // 误传进提示构建器时过去是 TypeError 被吞掉，现在要能定位到端口形状不符。
    const toolPort = { queryEntity: vi.fn(), impactAnalysis: vi.fn(), search: vi.fn() };
    const { prompt, diagnostics } = await build(toolPort);

    expect(graphDiagnostics(diagnostics)).toEqual([
      { phase: 'session', status: 'invalid', reason: 'code-entity-graph-port-invalid' },
    ]);
    expect(toolPort.queryEntity).not.toHaveBeenCalled();
    expect(prompt).not.toContain('graph({ action: "query" }) 工具可以查询更详细的继承链');
  });

  it('reports a non-string graph result as invalid and does not inject it', async () => {
    const { prompt, diagnostics } = await build({
      generateContextForAgent: async () => ({ entities: [] }) as unknown as string,
    });

    expect(graphDiagnostics(diagnostics)).toEqual([
      { phase: 'session', status: 'invalid', reason: 'code-entity-graph-result-invalid' },
    ]);
    expect(prompt).not.toContain('[object Object]');
    expect(prompt).not.toContain('graph({ action: "query" }) 工具可以查询更详细的继承链');
  });

  it('treats a null graph result as "no context" without diagnostics', async () => {
    const { prompt, diagnostics } = await build({ generateContextForAgent: async () => null });

    expect(graphDiagnostics(diagnostics)).toEqual([]);
    expect(prompt).not.toContain('graph({ action: "query" }) 工具可以查询更详细的继承链');
  });

  it('reports the graph section skipped when the run aborts during earlier memory reads', async () => {
    const controller = new AbortController();
    const generateContextForAgent = vi.fn(async () => 'GraphCtxMarker');
    const semanticMemory = {
      toPromptSection: () => {
        // 在 §8 持久记忆读取期间取消：§9 读取前看到 aborted，必须跳过并留诊断。
        controller.abort();
        return 'semantic';
      },
    };
    const { prompt, diagnostics } = await build(
      { generateContextForAgent },
      { abortSignal: controller.signal, semanticMemory }
    );

    expect(generateContextForAgent).not.toHaveBeenCalled();
    expect(prompt).not.toContain('GraphCtxMarker');
    expect(graphDiagnostics(diagnostics)).toEqual([
      { phase: 'session', status: 'aborted', reason: 'code-entity-graph-aborted' },
    ]);
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
