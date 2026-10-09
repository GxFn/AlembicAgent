/**
 * L4-P29 回归（router 路径）：evolution_analysis 能力下 knowledge.manage 只开放
 * evolve/deprecate/skip_evolution；approve/publish/update/reject/score/validate/review/review-queue
 * 必须在 ToolRouter.explain 就以 blocked 拒绝，拒绝原因可定位 capability/operation/id，
 * 且 recipeGateway/knowledgeManagement/stagingManager/proposalGateway 零调用。
 * 未登记内部 allowlist 的能力与无能力路由保持原状，避免误伤宿主 MCP/Dashboard 路径。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  describeToolParameterDenial,
  findDeniedToolParameter,
} from '../src/tools/kernel/toolSelection.js';
import type { ToolContext } from '../src/tools/runtime/index.js';
import { Evolution, ToolRouter } from '../src/tools/runtime/index.js';

const DENIED_OPERATIONS = [
  'approve',
  'publish',
  'update',
  'reject',
  'score',
  'validate',
  'review',
  'review-queue',
] as const;

const ALLOWED_OPERATIONS = ['evolve', 'deprecate', 'skip_evolution'] as const;

function makePorts() {
  const recipeGateway = {
    evaluateReadiness: vi.fn(async () => ({ ready: true })),
    publish: vi.fn(async (id: string) => ({ id, lifecycle: 'active' })),
  };
  const knowledgeManagement = {
    update: vi.fn(async () => ({})),
    reject: vi.fn(async () => ({})),
    score: vi.fn(async () => ({})),
    validate: vi.fn(async () => ({ valid: true })),
  };
  const stagingManager = {
    listReviewQueue: vi.fn(async () => []),
    recordReview: vi.fn(async () => true),
  };
  const proposalGateway = {
    submit: vi.fn(async () => ({ outcome: 'proposal-created', proposalId: 'proposal-1' })),
  };
  return { recipeGateway, knowledgeManagement, stagingManager, proposalGateway };
}

type Ports = ReturnType<typeof makePorts>;

function makeContext(ports: Ports, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    projectRoot: process.cwd(),
    tokenBudget: 8000,
    ...ports,
    ...overrides,
  };
}

function expectNoPortCalls(ports: Ports) {
  expect(ports.recipeGateway.evaluateReadiness).not.toHaveBeenCalled();
  expect(ports.recipeGateway.publish).not.toHaveBeenCalled();
  expect(ports.knowledgeManagement.update).not.toHaveBeenCalled();
  expect(ports.knowledgeManagement.reject).not.toHaveBeenCalled();
  expect(ports.knowledgeManagement.score).not.toHaveBeenCalled();
  expect(ports.knowledgeManagement.validate).not.toHaveBeenCalled();
  expect(ports.stagingManager.listReviewQueue).not.toHaveBeenCalled();
  expect(ports.stagingManager.recordReview).not.toHaveBeenCalled();
  expect(ports.proposalGateway.submit).not.toHaveBeenCalled();
}

/** 每个 operation 都给出能通过 schema 校验的参数，确保拒绝来自能力 allowlist 而不是参数校验。 */
function manageParams(operation: string): Record<string, unknown> {
  switch (operation) {
    case 'review-queue':
      return { operation, limit: 5 };
    case 'review':
      return { operation, id: 'staging-1', outcome: 'pass' };
    case 'update':
      return { operation, id: 'active-1', data: { description: 'rewritten by model' } };
    case 'score':
      return { operation, id: 'active-1', data: { score: 1 } };
    default:
      return { operation, id: 'pending-1' };
  }
}

describe('ToolRouter capability parameter allowlist for knowledge.manage (L4-P29)', () => {
  it.each(
    DENIED_OPERATIONS
  )('blocks knowledge.manage(%s) under evolution_analysis before any port is called', async (operation) => {
    const ports = makePorts();
    const router = new ToolRouter({ capability: new Evolution().toDef() });
    const params = manageParams(operation);
    const call = { tool: 'knowledge', action: 'manage', params };

    const decision = router.explain(call, {});
    expect(decision).toMatchObject({ allowed: false, stage: 'approve', resultStatus: 'blocked' });
    expect(decision.reason).toContain('evolution_analysis');
    expect(decision.reason).toContain(`operation="${operation}"`);
    if (typeof params.id === 'string') {
      expect(decision.reason).toContain(`id=${params.id}`);
    }
    expect(decision.reason).toContain('evolve, deprecate, skip_evolution');

    const result = await router.execute(call, makeContext(ports));
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      code: 'TOOL_ACTION_DENIED',
      status: 'blocked',
      tool: 'knowledge',
      action: 'manage',
      writeState: 'not-started',
    });
    expect(result._meta?.resultStatus).toBe('blocked');
    expect(result._meta?.diagnosticWarnings?.[0]).toMatchObject({
      code: 'tool_preflight_rejected',
      tool: 'knowledge',
    });
    expect(result._meta?.diagnosticWarnings?.[0]?.message).toContain('evolution_analysis');
    expect(result._meta?.diagnosticWarnings?.[0]?.message).toContain(`operation="${operation}"`);
    expectNoPortCalls(ports);
  });

  it.each(
    ALLOWED_OPERATIONS
  )('admits knowledge.manage(%s) under evolution_analysis and reaches the proposal gateway', async (operation) => {
    const ports = makePorts();
    const router = new ToolRouter({ capability: new Evolution().toDef() });
    const call = { tool: 'knowledge', action: 'manage', params: { operation, id: 'recipe-1' } };

    expect(router.explain(call, {})).toEqual({ allowed: true, stage: 'execute' });

    const result = await router.execute(call, makeContext(ports));
    expect(result.ok).toBe(true);
    expect(ports.proposalGateway.submit).toHaveBeenCalledTimes(1);
    expect(ports.proposalGateway.submit.mock.calls[0]?.[0]).toMatchObject({ recipeId: 'recipe-1' });
    expect(ports.recipeGateway.publish).not.toHaveBeenCalled();
    expect(ports.knowledgeManagement.update).not.toHaveBeenCalled();
    expect(ports.knowledgeManagement.reject).not.toHaveBeenCalled();
  });

  it('keeps the capability check ahead of the stage allowlist so the reason names the capability', () => {
    const router = new ToolRouter({ capability: new Evolution().toDef() });
    const decision = router.explain(
      { tool: 'knowledge', action: 'manage', params: { operation: 'approve', id: 'pending-1' } },
      { runtime: { allowedTools: { knowledge: ['manage'] } } }
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('capability "evolution_analysis"');
  });

  it('leaves capabilities without an internal allowlist unchanged', async () => {
    const ports = makePorts();
    const router = new ToolRouter({
      capability: {
        name: 'host-management',
        description: 'host-side management fixture',
        allowedTools: { knowledge: ['manage'] },
      },
    });
    const call = {
      tool: 'knowledge',
      action: 'manage',
      params: { operation: 'approve', id: 'pending-1' },
    };
    expect(router.explain(call, {})).toEqual({ allowed: true, stage: 'execute' });
    const result = await router.execute(call, makeContext(ports));
    expect(result.ok).toBe(true);
    expect(ports.recipeGateway.publish).toHaveBeenCalledTimes(1);
  });

  it('leaves a capability-less router unchanged', async () => {
    const ports = makePorts();
    const router = new ToolRouter();
    const call = {
      tool: 'knowledge',
      action: 'manage',
      params: { operation: 'update', id: 'active-1', data: { description: 'host edit' } },
    };
    expect(router.explain(call, {})).toEqual({ allowed: true, stage: 'execute' });
    const result = await router.execute(call, makeContext(ports));
    expect(result.ok).toBe(true);
    expect(ports.knowledgeManagement.update).toHaveBeenCalledWith('active-1', {
      description: 'host edit',
    });
  });

  it('tells the Evolution model which manage operations are open', () => {
    const prompt = new Evolution().promptFragment;
    expect(prompt).toContain('evolve / deprecate / skip_evolution');
    expect(prompt).toContain('approve/publish/update/reject');
  });
});

describe('findDeniedToolParameter', () => {
  it('returns null for capabilities without an internal allowlist and for other tool actions', () => {
    expect(
      findDeniedToolParameter('conversation', 'knowledge', 'manage', { operation: 'approve' })
    ).toBeNull();
    expect(
      findDeniedToolParameter('evolution_analysis', 'knowledge', 'search', { operation: 'approve' })
    ).toBeNull();
    expect(
      findDeniedToolParameter('evolution_analysis', 'code', 'read', { operation: 'approve' })
    ).toBeNull();
  });

  it('admits listed values and reports the first denied parameter', () => {
    expect(
      findDeniedToolParameter('evolution_analysis', 'knowledge', 'manage', { operation: 'evolve' })
    ).toBeNull();
    expect(
      findDeniedToolParameter('evolution_analysis', 'knowledge', 'manage', { operation: 'approve' })
    ).toEqual({
      capability: 'evolution_analysis',
      tool: 'knowledge',
      action: 'manage',
      parameter: 'operation',
      value: 'approve',
      allowed: ['evolve', 'deprecate', 'skip_evolution'],
    });
  });

  it('compares non-string values by their string form', () => {
    expect(
      findDeniedToolParameter('evolution_analysis', 'knowledge', 'manage', { operation: 42 })
    ).toMatchObject({ parameter: 'operation', value: '42' });
  });

  it('leaves a missing parameter to schema validation unless the schema default is denied', () => {
    expect(findDeniedToolParameter('evolution_analysis', 'knowledge', 'manage', {})).toBeNull();
    expect(
      findDeniedToolParameter(
        'evolution_analysis',
        'knowledge',
        'manage',
        {},
        { operation: { default: 'approve' } }
      )
    ).toMatchObject({ parameter: 'operation', value: 'approve' });
    expect(
      findDeniedToolParameter(
        'evolution_analysis',
        'knowledge',
        'manage',
        {},
        { operation: { default: 'evolve' } }
      )
    ).toBeNull();
  });

  it('describes the denial with capability, operation and id', () => {
    const denial = findDeniedToolParameter('evolution_analysis', 'knowledge', 'manage', {
      operation: 'publish',
      id: 'pending-9',
    });
    expect(denial).not.toBeNull();
    const reason = describeToolParameterDenial(denial as NonNullable<typeof denial>, {
      operation: 'publish',
      id: 'pending-9',
    });
    expect(reason).toContain('knowledge.manage');
    expect(reason).toContain('operation="publish"');
    expect(reason).toContain('capability "evolution_analysis"');
    expect(reason).toContain('id=pending-9');
    expect(reason).toContain('Allowed: evolve, deprecate, skip_evolution');
  });
});
