/** 结构化宿主接线检查；不执行服务、不分配运行状态，也不替代 Core/actor 的业务权限。 */
import type {
  ToolAvailabilityContext,
  ToolAvailabilitySnapshot,
  ToolUnavailableReason,
} from '#tools/kernel/availability.js';
import { TOOL_REGISTRY } from './registry.js';

function hasMethod(value: unknown, method: string): boolean {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as Record<string, unknown>)[method] === 'function'
  );
}

function enumValues(tool: string, action: string, parameter: string): string[] {
  const properties = TOOL_REGISTRY[tool]?.actions[action]?.params.properties as
    | Record<string, { enum?: unknown }>
    | undefined;
  const values = properties?.[parameter]?.enum;
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === 'string')
    : [];
}

export function describeToolAvailability(ctx: ToolAvailabilityContext): ToolAvailabilitySnapshot {
  const actions: Record<string, string[]> = {};
  const parameters: Record<string, Record<string, Record<string, string[]>>> = {};
  const unavailable: ToolUnavailableReason[] = [];
  const initialize = (tool: string) => {
    actions[tool] ??= Object.keys(TOOL_REGISTRY[tool].actions);
  };
  const check = (tool: string, action: string, available: boolean, reason: string) => {
    initialize(tool);
    if (!available) {
      actions[tool] = actions[tool].filter((name) => name !== action);
      unavailable.push({ tool, action, reason });
    }
  };
  const branches = (
    tool: string,
    action: string,
    parameter: string,
    supported: Record<string, boolean>
  ) => {
    const values = enumValues(tool, action, parameter);
    const available = values.filter((value) => supported[value] === true);
    (parameters[tool] ??= {})[action] = { [parameter]: available };
    for (const value of values) {
      if (!available.includes(value)) {
        unavailable.push({
          tool,
          action,
          operation: value,
          reason: `${tool}.${action} ${parameter}=${value} has no bound host capability`,
        });
      }
    }
    check(
      tool,
      action,
      available.length > 0,
      `${tool}.${action} has no available ${parameter} branch`
    );
  };

  // read 的 AST 是可选增强，outline 则必须有真实 analyzer；不误删可降级的文件读取。
  check(
    'code',
    'outline',
    hasMethod(ctx.astAnalyzer, 'analyzeFile'),
    'astAnalyzer.analyzeFile is unavailable'
  );
  check(
    'graph',
    'overview',
    hasMethod(ctx.projectGraph, 'getOverview'),
    'projectGraph.getOverview is unavailable'
  );
  branches('graph', 'query', 'type', {
    class:
      hasMethod(ctx.projectGraph, 'getClassInfo') || hasMethod(ctx.codeEntityGraph, 'queryEntity'),
    protocol: hasMethod(ctx.projectGraph, 'getProtocolInfo'),
    hierarchy: hasMethod(ctx.projectGraph, 'getClassHierarchy'),
    callers:
      hasMethod(ctx.projectGraph, 'getCallers') || hasMethod(ctx.codeEntityGraph, 'queryCallGraph'),
    callees:
      hasMethod(ctx.projectGraph, 'getCallees') || hasMethod(ctx.codeEntityGraph, 'queryCallGraph'),
    overrides: hasMethod(ctx.projectGraph, 'getMethodOverrides'),
    extensions: hasMethod(ctx.projectGraph, 'getCategoryMap'),
    impact: hasMethod(ctx.codeEntityGraph, 'impactAnalysis'),
    search:
      hasMethod(ctx.codeEntityGraph, 'search') || hasMethod(ctx.projectGraph, 'searchEntities'),
  });

  const reader = ctx.knowledgeRead !== undefined ? ctx.knowledgeRead : ctx.knowledgeRepo;
  const manager =
    ctx.knowledgeManagement !== undefined ? ctx.knowledgeManagement : ctx.knowledgeRepo;
  const canRead = hasMethod(reader, 'getById');
  const canSearch = hasMethod(ctx.searchEngine, 'search');
  const declaredKinds = (ctx.searchEngine as { supportedKinds?: unknown } | null)?.supportedKinds;
  const kinds = Array.isArray(declaredKinds)
    ? enumValues('knowledge', 'search', 'kind').filter((kind) => declaredKinds.includes(kind))
    : null;
  check(
    'knowledge',
    'search',
    canSearch && (kinds === null || kinds.length > 0),
    'searchEngine.search is unavailable'
  );
  if (kinds) {
    (parameters.knowledge ??= {}).search = { kind: kinds };
  }
  check(
    'knowledge',
    'prime',
    canSearch &&
      (kinds === null || kinds.includes('all')) &&
      (canRead || (ctx.knowledgeRead === undefined && ctx.knowledgeRepo == null)),
    'knowledge.prime requires all-kind search and a valid reader when one is supplied'
  );
  check('knowledge', 'detail', canRead, 'knowledgeRead.getById is unavailable');
  check(
    'knowledge',
    'submit',
    hasMethod(ctx.recipeGateway, 'createOrStage'),
    'recipeGateway.createOrStage is unavailable'
  );
  const canPublish =
    hasMethod(ctx.recipeGateway, 'evaluateReadiness') && hasMethod(ctx.recipeGateway, 'publish');
  const canPropose = hasMethod(ctx.proposalGateway, 'submit');
  branches('knowledge', 'manage', 'operation', {
    update: hasMethod(manager, 'update'),
    reject: hasMethod(manager, 'reject'),
    score: hasMethod(manager, 'score'),
    validate: hasMethod(manager, 'validate'),
    approve: canPublish,
    publish: canPublish,
    review: hasMethod(ctx.stagingManager, 'recordReview'),
    'review-queue': hasMethod(ctx.stagingManager, 'listReviewQueue'),
    evolve: canPropose,
    deprecate: canPropose,
    skip_evolution: canPropose,
  });

  const sessionMethod = (method: string) =>
    ctx.sessionStoreAvailable ?? hasMethod(ctx.sessionStore, method);
  check('memory', 'save', sessionMethod('save'), 'sessionStore.save is unavailable');
  check('memory', 'recall', sessionMethod('recall'), 'sessionStore.recall is unavailable');
  if (ctx.runtime !== undefined) {
    // 静态目录不能把“还未创建的 loop 资源”说成缺失；当前运行提供 metadata 时才能判断。
    const coordinator = ctx.memoryCoordinator ?? ctx.runtime.memoryCoordinator;
    check(
      'memory',
      'note_finding',
      hasMethod(coordinator, 'noteFinding'),
      'MemoryCoordinator.noteFinding is unavailable for this run'
    );
    const ledger = ctx.runtime.evidenceLedger;
    check(
      'evidence',
      'get',
      hasMethod(ledger, 'get') && hasMethod(ledger, 'listRecent'),
      'EvidenceLedger.get/listRecent is unavailable for this run'
    );
    check(
      'evidence',
      'search',
      hasMethod(ledger, 'search'),
      'EvidenceLedger.search is unavailable for this run'
    );
  }
  // terminal.exec 的原生/fallback、memory.get_previous_evidence 的无前序证据分支继续由 handler 负责。
  return { actions, parameters, unavailable };
}
