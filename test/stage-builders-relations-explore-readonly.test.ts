import { describe, expect, it, vi } from 'vitest';
import { buildRelationsPipelineStages } from '../src/agent/evaluation/stageBuilders.js';
import { createDefaultProfileCompiler } from '../src/agent/profiles/AgentProfileCompiler.js';
import { AgentStageFactoryRegistry } from '../src/agent/profiles/AgentStageFactoryRegistry.js';
import { RELATION_PROFILES } from '../src/agent/profiles/definitions/relation.profile.js';
import { AgentRuntime } from '../src/agent/runtime/AgentRuntime.js';
import type { ToolCallRequest } from '../src/tools/kernel/request.js';
import { isToolActionAllowed } from '../src/tools/kernel/toolSelection.js';
import { RuntimeCapabilityCatalog } from '../src/tools/runtime/adapter/RuntimeCapabilityCatalog.js';
import { ToolRouter } from '../src/tools/runtime/router.js';
import { CapabilityRegistry } from '../src/tools/runtime/toolsets/CapabilityRegistry.js';

/**
 * relations explore 阶段只读能力的钉子（L7-P19 / C04、C55）。
 *
 * 背景：buildRelationsPipelineStages 的默认 exploreCaps 曾是 ['knowledge_production','code_analysis']，
 * 两者并集里 knowledge 只有 submit——RELATIONS_EXPLORE_PROMPT 第 1 步硬性要求的 knowledge.search
 * 在运行时准入就被拒，模型只能凭代码臆造关系；同时这个“只读发现”阶段却拿到 knowledge.submit、
 * terminal.exec 与 memory.save/note_finding 等写权限。现在 explore 阶段改用专用只读能力
 * relation_exploration（knowledge:[search,detail]、code:[read,search,outline]、graph:[query]），
 * relation.profile 的 skills 同步收敛。
 */

const EXPLORE_CAPABILITY = 'relation_exploration';

const READONLY_ALLOWLIST = {
  knowledge: ['search', 'detail'],
  code: ['read', 'search', 'outline'],
  graph: ['query'],
};

type NamedStage = {
  name: string;
  capabilities?: string[];
  systemPrompt?: string;
};

/** 与 AgentRuntime.#collectToolContract 同口径：按能力名求 allowedTools 的 tool → action 并集。 */
function unionAllowedTools(capabilityNames: string[]): Record<string, string[]> {
  const union: Record<string, Set<string>> = {};
  for (const name of capabilityNames) {
    const capability = CapabilityRegistry.create(name) as { allowedTools?: unknown };
    const allowed = (capability.allowedTools ?? {}) as Record<string, readonly string[]>;
    for (const [tool, actions] of Object.entries(allowed)) {
      union[tool] ??= new Set();
      for (const action of actions) {
        union[tool].add(action);
      }
    }
  }
  return Object.fromEntries(Object.entries(union).map(([tool, set]) => [tool, [...set]]));
}

function buildRelationsStages(): NamedStage[] {
  return new AgentStageFactoryRegistry().build('relationsPipeline', {
    params: {},
    context: {},
  }) as NamedStage[];
}

function requireStage(stages: NamedStage[], name: string): NamedStage {
  const stage = stages.find((candidate) => candidate.name === name);
  if (!stage) {
    throw new Error(`relationsPipeline has no stage named "${name}"`);
  }
  return stage;
}

describe('relation_exploration capability', () => {
  it('is registered as a read-only capability without submit, terminal or memory writes', () => {
    expect(CapabilityRegistry.names).toContain(EXPLORE_CAPABILITY);

    const capability = CapabilityRegistry.create(EXPLORE_CAPABILITY) as {
      name: string;
      allowedTools: Record<string, string[]>;
      tools: string[];
      promptFragment: string;
      toDef(): { name: string; allowedTools: unknown; commandAllowlist?: unknown };
    };

    expect(capability.name).toBe(EXPLORE_CAPABILITY);
    expect(capability.allowedTools).toEqual(READONLY_ALLOWLIST);
    expect([...capability.tools].sort()).toEqual(['code', 'graph', 'knowledge']);
    // 没有 terminal.exec，也就没有命令 allowlist 可声明。
    expect(capability.toDef().commandAllowlist).toBeUndefined();
    expect(capability.toDef().allowedTools).toEqual(READONLY_ALLOWLIST);

    // 提示片段只描述只读探索；不得带进 scan_analyze 那套 note_finding / 提交配额要求。
    expect(capability.promptFragment).toContain('## Capability Tool Permissions');
    expect(capability.promptFragment).toContain('**knowledge**');
    expect(capability.promptFragment).not.toContain('note_finding');
    expect(capability.promptFragment).not.toContain('submit');
  });

  it('is enforced by ToolRouter.explain: search passes, write-like actions are blocked', () => {
    const capability = CapabilityRegistry.create(EXPLORE_CAPABILITY);
    const router = new ToolRouter({ capability: capability as never });

    const search = router.explain({
      tool: 'knowledge',
      action: 'search',
      params: { query: 'layout' },
    } as never);
    expect(search.allowed).toBe(true);

    const detail = router.explain({
      tool: 'knowledge',
      action: 'detail',
      params: { id: 'a1b2c3d4' },
    } as never);
    expect(detail.allowed).toBe(true);

    // 每个调用都给齐 schema 必填参数，确保拒绝发生在能力准入（approve）而不是参数校验（discover）。
    for (const call of [
      { tool: 'knowledge', action: 'manage', params: { operation: 'evolve', id: 'x' } },
      { tool: 'terminal', action: 'exec', params: { command: 'ls' } },
      { tool: 'memory', action: 'save', params: { key: 'k', content: 'x' } },
      { tool: 'code', action: 'write', params: { path: 'a.ts', content: '' } },
    ]) {
      const decision = router.explain(call as never);
      expect(decision.allowed).toBe(false);
      expect(decision.stage).toBe('approve');
      expect(decision.reason).toContain(
        `Action "${call.tool}.${call.action}" not allowed in capability "${EXPLORE_CAPABILITY}"`
      );
    }

    // knowledge.submit 的参数校验先于能力准入；这里直接核对 allowlist 本身不含 submit。
    const allowlist = (capability as { allowedTools: Record<string, string[]> }).allowedTools;
    expect(isToolActionAllowed(allowlist, 'knowledge', 'submit')).toBe(false);
    expect(isToolActionAllowed(allowlist, 'knowledge', 'search')).toBe(true);
  });
});

describe('relationsPipeline explore stage toolset', () => {
  it('defaults the explore stage to relation_exploration and keeps synthesize tool-free', () => {
    const direct = buildRelationsPipelineStages() as NamedStage[];
    expect(requireStage(direct, 'explore').capabilities).toEqual([EXPLORE_CAPABILITY]);
    expect(requireStage(direct, 'synthesize').capabilities).toEqual([]);

    const viaRegistry = buildRelationsStages();
    expect(viaRegistry.map((stage) => stage.name)).toEqual(['explore', 'synthesize']);
    expect(requireStage(viaRegistry, 'explore').capabilities).toEqual([EXPLORE_CAPABILITY]);
    expect(requireStage(viaRegistry, 'synthesize').capabilities).toEqual([]);

    // 显式 exploreCaps 仍然生效，默认值只是把只读能力作为基线。
    const custom = buildRelationsPipelineStages({ exploreCaps: ['code_analysis'] }) as NamedStage[];
    expect(requireStage(custom, 'explore').capabilities).toEqual(['code_analysis']);
  });

  it('resolves explore allowedTools with knowledge.search and without knowledge.submit', () => {
    const explore = requireStage(buildRelationsStages(), 'explore');
    const union = unionAllowedTools(explore.capabilities ?? []);

    // 提示第 1 步要求的检索必须真的在授权集合里。
    expect(explore.systemPrompt).toContain('knowledge({ action: "search" })');
    expect(union.knowledge).toContain('search');
    expect(union.knowledge).toContain('detail');
    expect(union.knowledge).not.toContain('submit');
    expect(union.knowledge).not.toContain('manage');
    expect(union.knowledge).not.toContain('prime');

    // 提示第 3 步要求的代码验证与调用链查询。
    expect(union.code).toEqual(expect.arrayContaining(['read', 'search', 'outline']));
    expect(union.code).not.toContain('write');
    expect(union.graph).toEqual(['query']);

    // 探索阶段不执行命令、不写记忆、不写候选。
    expect(Object.keys(union).sort()).toEqual(['code', 'graph', 'knowledge']);
  });

  it('compiles the relation-discovery profile with the same read-only skill set', () => {
    expect(RELATION_PROFILES.map((profile) => profile.id)).toEqual(['relation-discovery']);
    expect(RELATION_PROFILES[0].defaults?.skills).toEqual([EXPLORE_CAPABILITY]);

    const compiled = createDefaultProfileCompiler().compile({ id: 'relation-discovery' });
    expect(compiled.skills).toEqual([EXPLORE_CAPABILITY]);
    expect(compiled.runtimeOverrides.capabilities).toEqual([EXPLORE_CAPABILITY]);
    // actionSpace 为 none：没有 additionalTools 能把写权限从旁路带回来。
    expect(compiled.additionalTools).toEqual([]);

    const strategy = compiled.strategy as { type: string; stages: NamedStage[] };
    expect(strategy.type).toBe('pipeline');
    expect(requireStage(strategy.stages, 'explore').capabilities).toEqual([EXPLORE_CAPABILITY]);
  });

  it('projects explore schemas at runtime: knowledge.search is offered and forwarded, submit is not', async () => {
    const explore = requireStage(buildRelationsStages(), 'explore');
    const catalog = new RuntimeCapabilityCatalog();
    const execute = vi.fn(async (request: ToolCallRequest) => ({
      ok: true,
      status: 'success',
      toolId: request.toolId,
      callId: 'call',
      startedAt: new Date().toISOString(),
      durationMs: 0,
      text: 'ok',
      structuredContent: {},
    }));
    const capture: { toolSchemas?: Array<Record<string, unknown>> } = {};
    const chatWithTools = vi
      .fn()
      .mockImplementationOnce(async (_prompt: string, opts?: Record<string, unknown>) => {
        capture.toolSchemas = opts?.toolSchemas as Array<Record<string, unknown>>;
        return {
          functionCalls: [
            { id: 's', name: 'knowledge', args: { action: 'search', params: { query: 'x' } } },
            {
              id: 'w',
              name: 'knowledge',
              args: { action: 'submit', params: { title: 'forged relation' } },
            },
            { id: 't', name: 'terminal', args: { action: 'exec', params: { command: 'ls' } } },
          ],
        };
      })
      .mockResolvedValue({ text: 'done' });

    const runtime = new AgentRuntime({
      aiProvider: { name: 'mock', model: 'mock', chatWithTools } as never,
      toolRegistry: catalog as never,
      container: { get: () => catalog },
      toolRouter: { execute } as never,
      capabilities: [],
      strategy: { name: 'unused', execute: vi.fn() } as never,
    });

    await runtime.reactLoop('探索知识库中知识条目之间的语义关系', {
      capabilityOverride: explore.capabilities,
      systemPromptOverride: explore.systemPrompt,
      budgetOverride: { maxIterations: 2, timeoutMs: 5000 },
    });

    const byName = new Map(capture.toolSchemas?.map((schema) => [schema.name, schema]) || []);
    expect([...byName.keys()].sort()).toEqual(['code', 'graph', 'knowledge']);
    const knowledgeParams = byName.get('knowledge')?.parameters as {
      properties?: { action?: { enum?: string[] } };
    };
    expect(knowledgeParams.properties?.action?.enum).toEqual(
      expect.arrayContaining(['search', 'detail'])
    );
    expect(knowledgeParams.properties?.action?.enum).not.toContain('submit');

    // 只有 search 到达 router；submit 与 terminal.exec 在运行时准入就被拦下。
    const forwarded = execute.mock.calls.map(([request]) => {
      const args = (request as { args?: { action?: string } }).args;
      return `${request.toolId}.${args?.action ?? ''}`;
    });
    expect(forwarded).toEqual(['knowledge.search']);
  });
});
