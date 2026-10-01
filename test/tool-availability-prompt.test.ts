import { describe, expect, it, vi } from 'vitest';
import { BudgetPolicy } from '../src/agent/policies/index.js';
import { PolicyEngine } from '../src/agent/policies/PolicyEngine.js';
import { ANALYST_SYSTEM_PROMPT } from '../src/agent/prompts/insightAnalyst.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import { SystemPromptBuilder } from '../src/agent/runtime/SystemPromptBuilder.js';
import type { ToolAvailabilityContext } from '../src/tools/kernel/availability.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';
import { ToolRouterAdapter } from '../src/tools/runtime/adapter/ToolRouterAdapter.js';
import { ToolRouter } from '../src/tools/runtime/router.js';
import { CapabilityRegistry } from '../src/tools/runtime/toolsets/CapabilityRegistry.js';

/**
 * 工具可用性 → 系统提示 的钉子。
 *
 * 背景：工具 schema 已经按宿主接线事实裁剪（没接图谱服务就不下发 graph），但分析类提示
 * 是静态文本，仍然写着「调用关系优先用 graph.query」。模型照提示去调一个 schema 里没有的
 * 工具，只会得到被拒绝的工具调用。现在运行时在循环初始化时用同一份可用性快照生成一段
 * 「本次运行不可用的工具」说明，追加到系统提示末尾——提示和 schema 读同一个事实。
 */

const NOTICE_HEADING = '## 本次运行不可用的工具';

/** 只接 AST 分析器；图谱按参数决定是否接线。其余宿主服务与本用例无关。 */
function hostServices(graph: 'none' | 'partial' | 'full'): ToolAvailabilityContext {
  const projectGraph =
    graph === 'none'
      ? null
      : graph === 'partial'
        ? { getOverview: () => ({}), getClassInfo: () => null, getCallers: () => [] }
        : {
            getOverview: () => ({}),
            getClassInfo: () => null,
            getProtocolInfo: () => null,
            getClassHierarchy: () => [],
            getCallers: () => [],
            getCallees: () => [],
            getMethodOverrides: () => [],
            getCategoryMap: () => ({}),
            searchEntities: () => [],
          };
  const codeEntityGraph =
    graph === 'full' ? { impactAnalysis: () => ({}), search: () => [] } : undefined;
  return {
    projectRoot: process.cwd(),
    astAnalyzer: { analyzeFile: () => null },
    projectGraph,
    ...(codeEntityGraph ? { codeEntityGraph } : {}),
    sessionStoreAvailable: true,
  };
}

async function captureLlmInput(
  graph: 'none' | 'partial' | 'full',
  loopOptions: Record<string, unknown> = {}
) {
  const services = hostServices(graph);
  const availability = (runtime?: unknown) =>
    ToolRouter.describeAvailability({ ...services, runtime: runtime as never });
  const catalog = new RuntimeCapabilityCatalog({ availability });
  const chatWithTools = vi.fn(async () => ({ text: 'analysis complete' }));
  const runtime = new AgentRuntime({
    aiProvider: { name: 'mock', model: 'mock', chatWithTools } as never,
    toolRegistry: catalog,
    container: { get: () => catalog },
    toolRouter: new ToolRouterAdapter({
      contextFactory: {
        create: () => ({ projectRoot: process.cwd(), tokenBudget: 8000 }),
        getAvailability: availability,
      },
    }),
    capabilities: [CapabilityRegistry.create('code_analysis')],
    policies: new PolicyEngine([new BudgetPolicy({ maxIterations: 3, timeoutMs: 5000 })]),
  });
  const result = await runtime.reactLoop('analyze the project', loopOptions);
  const [, options] = chatWithTools.mock.calls[0] as unknown as [
    string,
    { systemPrompt: string; toolSchemas?: Array<{ name: string }> },
  ];
  return {
    systemPrompt: options.systemPrompt,
    toolNames: (options.toolSchemas ?? []).map((schema) => schema.name),
    diagnostics: result.diagnostics,
  };
}

describe('system prompt reflects host tool availability', () => {
  it('tells the model that graph is not wired when the prompt still recommends it', async () => {
    const { systemPrompt, toolNames } = await captureLlmInput('none');

    // schema 已经按接线事实裁掉 graph；提示里的静态指引仍然提到它。
    expect(toolNames).not.toContain('graph');
    expect(toolNames).toContain('code');
    expect(systemPrompt).toContain('graph.query');

    const notice = systemPrompt.slice(systemPrompt.indexOf(NOTICE_HEADING));
    expect(systemPrompt).toContain(NOTICE_HEADING);
    expect(notice).toContain('- graph（整个工具不可用）');
    expect(notice).toContain('不要调用');
    // 说明只出现一次，且位于系统提示末尾，保持同一循环内系统提示稳定。
    expect(systemPrompt.split(NOTICE_HEADING)).toHaveLength(2);
  });

  it('adds the same notice to a stage system prompt override', async () => {
    const { systemPrompt } = await captureLlmInput('none', {
      systemPromptOverride: ANALYST_SYSTEM_PROMPT,
    });

    expect(systemPrompt.startsWith(ANALYST_SYSTEM_PROMPT)).toBe(true);
    expect(systemPrompt).toContain(NOTICE_HEADING);
    expect(systemPrompt).toContain('- graph（整个工具不可用）');
  });

  it('lists only the unavailable branches when a tool is partially wired', async () => {
    const { systemPrompt, toolNames } = await captureLlmInput('partial');

    expect(toolNames).toContain('graph');
    const notice = systemPrompt.slice(systemPrompt.indexOf(NOTICE_HEADING));
    expect(notice).not.toContain('- graph（整个工具不可用）');
    expect(notice).not.toContain('- graph.overview');
    expect(notice).toMatch(/- graph\.query：以下分支不可用——[^\n]*impact/u);
    expect(notice).toMatch(/- graph\.query：以下分支不可用——[^\n]*hierarchy/u);
    expect(notice).not.toMatch(/- graph\.query：以下分支不可用——[^\n]*callers/u);
  });

  it('says nothing about a tool whose requested actions are all wired', async () => {
    const { systemPrompt, toolNames } = await captureLlmInput('full');

    expect(toolNames).toContain('graph');
    // 本夹具没有证据台账和记忆协调器，说明里仍会列出它们；图谱已全部接线，不应出现。
    const notice = systemPrompt.includes(NOTICE_HEADING)
      ? systemPrompt.slice(systemPrompt.indexOf(NOTICE_HEADING))
      : '';
    expect(notice).not.toContain('graph');
  });
});

describe('SystemPromptBuilder.injectToolAvailability', () => {
  it('returns the prompt unchanged without unavailable entries', () => {
    expect(SystemPromptBuilder.injectToolAvailability('base', { allowedTools: {} })).toBe('base');
    expect(
      SystemPromptBuilder.injectToolAvailability('base', { allowedTools: {}, unavailable: [] })
    ).toBe('base');
  });

  it('groups whole tools, whole actions and branches, and is idempotent', () => {
    const projection = {
      allowedTools: { code: ['search', 'read'], knowledge: ['search', 'manage'] },
      unavailable: [
        { tool: 'graph', action: 'overview', reason: 'projectGraph.getOverview is unavailable' },
        { tool: 'graph', action: 'query', operation: 'class', reason: 'no bound host capability' },
        { tool: 'graph', action: 'query', reason: 'graph.query has no available type branch' },
        { tool: 'code', action: 'outline', reason: 'astAnalyzer.analyzeFile is unavailable' },
        { tool: 'knowledge', action: 'manage', operation: 'publish', reason: 'no publisher' },
        { tool: 'knowledge', action: 'manage', operation: 'approve', reason: 'no publisher' },
      ],
    };
    const once = SystemPromptBuilder.injectToolAvailability('base', projection);

    expect(once.startsWith('base\n\n')).toBe(true);
    expect(once).toContain('- graph（整个工具不可用）');
    expect(once).toContain('- code.outline');
    expect(once).toContain('- knowledge.manage：以下分支不可用——approve、publish');
    // 整个工具不可用时不再逐条列它的动作和分支。
    expect(once).not.toContain('graph.query');
    expect(once).not.toContain('graph.overview');
    expect(SystemPromptBuilder.injectToolAvailability(once, projection)).toBe(once);
  });
});
