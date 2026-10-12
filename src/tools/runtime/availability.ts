/** 结构化宿主接线检查；不执行服务、不分配运行状态，也不替代 Core/actor 的业务权限。 */
import type {
  ToolAvailabilityContext,
  ToolAvailabilitySnapshot,
  ToolUnavailableReason,
} from '#tools/kernel/availability.js';
import { GRAPH_QUERY_HOST_READERS, TOOL_REGISTRY } from './registry.js';

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
  /**
   * 按注册枚举逐分支收窄：被剔除的分支各推一条 operation 级 unavailable，全缺时移除整个动作。
   * reasons 允许调用方说明“为什么缺”（例如宿主声明的 supportedKinds），默认按“未绑定宿主能力”描述。
   */
  const branches = (
    tool: string,
    action: string,
    parameter: string,
    supported: Record<string, boolean>,
    reasons: { branch?: (value: string) => string; none?: (values: string[]) => string } = {}
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
          reason:
            reasons.branch?.(value) ??
            `${tool}.${action} ${parameter}=${value} has no bound host capability`,
        });
      }
    }
    check(
      tool,
      action,
      available.length > 0,
      reasons.none?.(values) ?? `${tool}.${action} has no available ${parameter} branch`
    );
  };

  // read 的 AST 是可选增强（缺端口时退回头尾预览），outline 则必须有宿主绑定的 outlineFile 端口；
  // 不误删可降级的文件读取。I16：只按 kernel 的 outlineFile 端口判定。旧 astAnalyzer.analyzeFile
  // 鸭子类型只能证明“有这个方法名”，证明不了签名——按 Core analyzeFile(source, lang) 接线时它
  // 会被判为可用却恒失败——所以即使在场也不广告，原因里点名这一跳过，便于宿主排查。
  check(
    'code',
    'outline',
    typeof ctx.outlineFile === 'function',
    hasMethod(ctx.astAnalyzer, 'analyzeFile')
      ? 'outlineFile is unavailable; legacy astAnalyzer.analyzeFile is bound but not advertised (its signature cannot be verified)'
      : 'outlineFile is unavailable'
  );
  check(
    'graph',
    'overview',
    hasMethod(ctx.projectGraph, 'getOverview'),
    'projectGraph.getOverview is unavailable'
  );
  // graph.query 的 type 分支与 graph handler 共用 GRAPH_QUERY_HOST_READERS：任一读取器的方法在场即可用，
  // 不再在这里手抄方法名。legacy 条目（旧宿主兼容入口，已弃用）照常参与判定，唯一生产宿主不提供它们，
  // 所以生产快照会收窄掉 overrides/extensions；删除这些条目等待决事项③，消费者与移除条件见该常量。
  branches(
    'graph',
    'query',
    'type',
    Object.fromEntries(
      Object.entries(GRAPH_QUERY_HOST_READERS).map(([type, readers]) => [
        type,
        readers.some((reader) => hasMethod(ctx[reader.port], reader.method)),
      ])
    )
  );

  const reader = ctx.knowledgeRead !== undefined ? ctx.knowledgeRead : ctx.knowledgeRepo;
  const manager =
    ctx.knowledgeManagement !== undefined ? ctx.knowledgeManagement : ctx.knowledgeRepo;
  const canRead = hasMethod(reader, 'getById');
  const canSearch = hasMethod(ctx.searchEngine, 'search');
  const declaredKinds = (ctx.searchEngine as { supportedKinds?: unknown } | null)?.supportedKinds;
  const kinds = Array.isArray(declaredKinds)
    ? enumValues('knowledge', 'search', 'kind').filter((kind) => declaredKinds.includes(kind))
    : null;
  if (!canSearch) {
    // 没有 search 方法时整个动作不可用；不再逐个 kind 列分支，避免把接线缺口误报成 kind 不支持。
    check('knowledge', 'search', false, 'searchEngine.search is unavailable');
  } else if (kinds !== null) {
    // 宿主声明了 supportedKinds：复用 branches() 为每个被剔除的 kind 推 operation 级条目，
    // 让运行诊断与系统提示都能看到（生产宿主固定 ['all']，recipe/candidate 不再被静默剔除）。
    // 全不相交时原因写明是 supportedKinds 与注册枚举不相交，而不是 search 方法缺失。
    branches('knowledge', 'search', 'kind', Object.fromEntries(kinds.map((kind) => [kind, true])), {
      branch: (kind) => `knowledge.search kind=${kind} is not in searchEngine.supportedKinds`,
      none: (values) =>
        `searchEngine.supportedKinds does not intersect knowledge.search kind (${values.join(', ')})`,
    });
  } else {
    // 未声明 supportedKinds：沿用“全部 kind 可用”的旧语义，不写 parameters 收窄，也不推分支条目。
    initialize('knowledge');
  }
  // prime 的“未注入任何读取端口也可用”是 search-only 旧宿主兼容分支（已弃用，handler 侧带
  // KNOWLEDGE_PRIME_SEARCH_ONLY 诊断）。待决事项③确认单宿主后改为要求 knowledgeRead，与 handler 同步收窄。
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
  // meta.review 只读 sessionStore.recall 汇总本会话提交；与 memory.recall 同一事实，缺失时不再广告。
  // handler 侧仍保留 degraded + META_REVIEW_STORE_MISSING 兜底，覆盖宿主声明与实际注入不一致的情况。
  check('meta', 'review', sessionMethod('recall'), 'sessionStore.recall is unavailable');
  // terminal handler 在无可调用 exec 且宿主未显式许可时 fail-closed（terminal_sandbox_required）；
  // 快照按同一条件收窄，避免模型对必然被拒绝的 terminal.exec 白耗一轮。许可只认字面量 true。
  check(
    'terminal',
    'exec',
    hasMethod(ctx.sandboxExecutor, 'exec') || ctx.allowUnsandboxedTerminal === true,
    'sandboxExecutor.exec is unavailable and allowUnsandboxedTerminal is not true'
  );
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
  // memory.get_previous_evidence 的“无前序证据”分支属于单次调用结果，继续由 handler 负责；
  // allowUnsandboxedTerminal 许可下的普通子进程降级也由 terminal handler 在结果中记录诊断。
  return { actions, parameters, unavailable };
}
