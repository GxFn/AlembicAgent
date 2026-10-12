import Logger from '@alembic/core/logging';

// 惰性取 Core 日志单例：本模块是回执语义单源，导入时不做任何初始化工作。
const logger = () => Logger.getInstance();

/** 工具请求、传输结果与业务结果分开归一；请求被执行不等于候选已入库。 */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const FAILURE_STATUSES = new Set(['error', 'blocked', 'aborted', 'timeout', 'needs-confirmation']);

export function readToolObservation(call: unknown) {
  const input = record(call);
  const args = record(input.args ?? input.params);
  const { params: nested, ...outer } = args;
  const params = { ...outer, ...record(nested) };
  const envelope = record(input.envelope);
  let payload = record(envelope.structuredContent ?? input.result);
  let ok =
    input.result != null ||
    envelope.structuredContent != null ||
    (envelope.ok === true && typeof envelope.text === 'string');
  const seen = new Set<unknown>();
  for (const wrapper of [envelope, record(input.result), payload]) {
    if (
      wrapper.ok === false ||
      wrapper.error !== undefined ||
      FAILURE_STATUSES.has(String(wrapper.status ?? ''))
    ) {
      ok = false;
    }
  }
  while (!seen.has(payload)) {
    seen.add(payload);
    const child =
      payload.structuredContent ??
      (payload.status === undefined || typeof payload.ok === 'boolean' ? payload.data : undefined);
    if (!child || typeof child !== 'object' || Array.isArray(child)) {
      break;
    }
    payload = record(child);
    if (
      payload.ok === false ||
      payload.error !== undefined ||
      FAILURE_STATUSES.has(String(payload.status ?? ''))
    ) {
      ok = false;
    }
  }
  return {
    tool: String(input.tool ?? input.name ?? ''),
    action: String(args.action ?? params.action ?? ''),
    params,
    result: payload,
    ok,
  };
}

export function isKnowledgeSubmit(call: unknown): boolean {
  const observation = readToolObservation(call);
  return observation.tool === 'knowledge' && observation.action === 'submit';
}

export function isPersistedSubmission(call: unknown): boolean {
  return isKnowledgeSubmit(call) && hasPersistedCandidate(call);
}

export function hasPersistedCandidate(call: unknown): boolean {
  const observation = readToolObservation(call);
  const result = observation.result;
  return (
    observation.ok &&
    result.status === 'created' &&
    typeof result.id === 'string' &&
    result.id.trim().length > 0 &&
    (result.lifecycle === 'pending' || result.lifecycle === 'staging')
  );
}

type EvolutionOperation = 'evolve' | 'deprecate' | 'skip_evolution';
type EvolutionOutcome = 'proposal' | 'deprecated' | 'verified';

/**
 * 旧进化工具名 → 操作。registry、宿主与 Core 当前都没有这些工具的生产者，只为外部传入的旧形状
 * toolCalls 保留；只有命中这张表的回执才允许走下面的 status 兼容回退。
 */
const LEGACY_EVOLUTION_TOOLS: Readonly<Record<string, EvolutionOperation>> = {
  propose_evolution: 'evolve',
  confirm_deprecation: 'deprecate',
  skip_evolution: 'skip_evolution',
};

function isEvolutionOperation(value: unknown): value is EvolutionOperation {
  return value === 'evolve' || value === 'deprecate' || value === 'skip_evolution';
}

/** 旧工具名回执的 status 兼容转译；新形状的 knowledge.manage 回执不得使用。 */
function legacyStatusOutcome(status: unknown): EvolutionOutcome | null {
  const value = String(status);
  if (
    ['evolution_proposed', 'evolution_proposal_upgraded', 'deprecation_proposed'].includes(value)
  ) {
    return 'proposal';
  }
  if (value === 'deprecated') {
    return 'deprecated';
  }
  return ['evolution_verified', 'evolution_skipped', 'verified'].includes(value)
    ? 'verified'
    : null;
}

/** 一次成功的进化决策回执：目标 Recipe、Agent 选择的操作、Core 确认的结果。 */
function readEvolutionReceipt(
  call: unknown
): { target: string; operation: EvolutionOperation; outcome: EvolutionOutcome } | null {
  const { tool, action, params, result, ok } = readToolObservation(call);
  const isManage = tool === 'knowledge' && action === 'manage';
  // Object.hasOwn 防止 'constructor' 之类的原型键被当成旧工具名。
  const legacyOperation = Object.hasOwn(LEGACY_EVOLUTION_TOOLS, tool)
    ? LEGACY_EVOLUTION_TOOLS[tool]
    : undefined;
  const operation = isManage ? params.operation : legacyOperation;
  const target = params.id ?? params.recipeId;
  if (!ok || typeof target !== 'string' || !target || !isEvolutionOperation(operation)) {
    return null;
  }
  // Core outcome 是事实；不得让兼容 status 把 skipped 重新提升成成功提案。
  if (typeof result.outcome === 'string' && result.outcome) {
    let outcome: EvolutionOutcome | null;
    if (result.outcome === 'proposal-created' || result.outcome === 'proposal-upgraded') {
      outcome = 'proposal';
    } else if (result.outcome === 'immediately-executed') {
      outcome = 'deprecated';
    } else {
      outcome = result.outcome === 'verified' ? 'verified' : null;
    }
    return outcome ? { target, operation, outcome } : null;
  }
  const status = typeof result.status === 'string' ? result.status : null;
  if (isManage) {
    // knowledge.manage 的生产 handler 总会写 outcome；缺 outcome 说明回执来自外部或契约漂移。
    // status 不能代替 outcome：evolve 遇到 Core skipped（重复提案）时 status 正是 evolution_skipped，
    // 若按旧表转译会被记成“验证仍有效”。这里短路为无结论，由门禁把该 Recipe 留在待决清单里。
    logger().warn(
      `[toolOutcomes] evolution receipt rejected: knowledge.manage receipt has no Core outcome (operation=${operation}, target=${target}, status=${status ?? 'none'}); status compatibility is limited to legacy tool names, decision left undecided`,
      {
        path: 'knowledge-manage-missing-outcome',
        tool,
        action,
        operation,
        target,
        status,
        outcome: null,
      }
    );
    return null;
  }
  // 只有旧工具名走到这里：按旧 status 兼容转译，并记录走了兼容路径，便于确认是否仍有旧形状来源。
  const outcome = legacyStatusOutcome(result.status);
  logger().info(
    `[toolOutcomes] legacy evolution tool status translated (tool=${tool}, operation=${operation}, target=${target}, status=${status ?? 'none'}, outcome=${outcome ?? 'none'})`,
    {
      path: 'legacy-tool-status',
      tool,
      action,
      operation,
      target,
      status,
      outcome,
    }
  );
  return outcome ? { target, operation, outcome } : null;
}

export function evolutionOutcome(call: unknown): EvolutionOutcome | null {
  return readEvolutionReceipt(call)?.outcome ?? null;
}

/** 每个 Recipe 的最终进化决策：进化（含替代提交）、废弃（含废弃提案）、跳过（验证仍有效）。 */
export type EvolutionDecision = 'evolved' | 'deprecated' | 'skipped';

/**
 * 把工具回执按 Recipe 归并成决策表，同一 Recipe 只计一次。
 *
 * - 只认成功回执：请求被执行不等于决策已落库。
 * - 提案分两类：Agent 选 deprecate 而 Core 降级为提案时仍属「废弃」，其余提案属「进化」。
 * - 进化/废弃是已落库的变更，后到的「跳过」不能把它盖回「仍然有效」；两个变更之间后者生效。
 * - expectedIds 非空时只统计清单内的 Recipe，防止无关 ID 冒充本维度的决策。
 */
export function collectEvolutionDecisions(
  toolCalls: readonly unknown[],
  expectedIds: readonly string[] = []
): Map<string, EvolutionDecision> {
  const decisions = new Map<string, EvolutionDecision>();
  const expected = new Set(expectedIds);
  for (const call of toolCalls) {
    let id: unknown;
    let decision: EvolutionDecision;
    if (isPersistedSubmission(call)) {
      id = readToolObservation(call).params.supersedes;
      decision = 'evolved';
    } else {
      const receipt = readEvolutionReceipt(call);
      if (!receipt) {
        continue;
      }
      id = receipt.target;
      decision =
        receipt.outcome === 'verified'
          ? 'skipped'
          : receipt.outcome === 'deprecated' || receipt.operation === 'deprecate'
            ? 'deprecated'
            : 'evolved';
    }
    if (typeof id !== 'string' || !id || (expected.size > 0 && !expected.has(id))) {
      continue;
    }
    if (decision === 'skipped' && decisions.has(id) && decisions.get(id) !== 'skipped') {
      continue;
    }
    decisions.set(id, decision);
  }
  return decisions;
}

export function collectSuccessfulEvolutionIds(
  toolCalls: readonly unknown[],
  expectedIds: readonly string[] = []
): Set<string> {
  return new Set(collectEvolutionDecisions(toolCalls, expectedIds).keys());
}

/** code.read 的实际成功路径；批量成员状态优先于请求列表，部分结果不能把失败成员标成已读。 */
export function successfulReadPaths(call: unknown): string[] {
  const observation = readToolObservation(call);
  if (!observation.ok || observation.tool !== 'code' || observation.action !== 'read') {
    return [];
  }
  const payload = observation.result;
  const paths = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value) {
      paths.add(value);
    }
  };
  if (Array.isArray(payload.files)) {
    for (const file of payload.files) {
      if (readToolObservation({ result: file }).ok) {
        const entry = record(file);
        add(entry.path ?? entry.filePath);
      }
    }
  } else if (payload.batchResults && typeof payload.batchResults === 'object') {
    for (const [file, value] of Object.entries(record(payload.batchResults))) {
      if (readToolObservation({ result: value }).ok) {
        add(file);
      }
    }
  } else {
    add(payload.path ?? payload.filePath);
    if (paths.size === 0) {
      const params = observation.params;
      for (const file of Array.isArray(params.filePaths)
        ? params.filePaths
        : [params.path ?? params.filePath]) {
        add(file);
      }
    }
  }
  return [...paths];
}

/**
 * code.read 中真实失败的成员，与 successfulReadPaths 对称：只看批量成员自身的 ok/error，
 * 不看整体 ok——批量读取部分失败时整体仍是成功回执，失败文件不能被成功路径吞掉。
 * 单文件读取失败由调用整体失败表达，这里不重复；非 read 调用返回空。
 */
export function failedReadPaths(call: unknown): Array<{ path: string; reason: string }> {
  const observation = readToolObservation(call);
  if (observation.tool !== 'code' || observation.action !== 'read') {
    return [];
  }
  const payload = observation.result;
  const failures: Array<{ path: string; reason: string }> = [];
  const seen = new Set<string>();
  const add = (path: unknown, entry: Record<string, unknown>) => {
    if (typeof path !== 'string' || !path || seen.has(path)) {
      return;
    }
    seen.add(path);
    const reason =
      typeof entry.error === 'string' && entry.error.trim()
        ? entry.error.trim()
        : typeof entry.status === 'string' && entry.status.trim()
          ? entry.status.trim()
          : 'read failed';
    failures.push({ path, reason });
  };
  if (Array.isArray(payload.files)) {
    for (const file of payload.files) {
      if (!readToolObservation({ result: file }).ok) {
        const entry = record(file);
        add(entry.path ?? entry.filePath, entry);
      }
    }
  } else if (payload.batchResults && typeof payload.batchResults === 'object') {
    for (const [file, value] of Object.entries(record(payload.batchResults))) {
      if (!readToolObservation({ result: value }).ok) {
        add(file, record(value));
      }
    }
  }
  return failures;
}
