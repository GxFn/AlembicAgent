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
  let ok = input.result != null || envelope.structuredContent != null;
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

export function evolutionOutcome(call: unknown): 'proposal' | 'deprecated' | 'verified' | null {
  const { tool, action, params, result, ok } = readToolObservation(call);
  const legacy: Record<string, string> = {
    propose_evolution: 'evolve',
    confirm_deprecation: 'deprecate',
    skip_evolution: 'skip_evolution',
  };
  const operation = tool === 'knowledge' && action === 'manage' ? params.operation : legacy[tool];
  const target = params.id ?? params.recipeId;
  if (
    !ok ||
    typeof target !== 'string' ||
    !target ||
    !['evolve', 'deprecate', 'skip_evolution'].includes(String(operation))
  ) {
    return null;
  }
  // Core outcome 是事实；不得让兼容 status 把 skipped 重新提升成成功提案。
  if (typeof result.outcome === 'string' && result.outcome) {
    if (result.outcome === 'proposal-created' || result.outcome === 'proposal-upgraded') {
      return 'proposal';
    }
    if (result.outcome === 'immediately-executed') {
      return 'deprecated';
    }
    return result.outcome === 'verified' ? 'verified' : null;
  }
  if (
    ['evolution_proposed', 'evolution_proposal_upgraded', 'deprecation_proposed'].includes(
      String(result.status)
    )
  ) {
    return 'proposal';
  }
  if (result.status === 'deprecated') {
    return 'deprecated';
  }
  return ['evolution_verified', 'evolution_skipped', 'verified'].includes(String(result.status))
    ? 'verified'
    : null;
}

export function collectSuccessfulEvolutionIds(
  toolCalls: readonly unknown[],
  expectedIds: readonly string[] = []
): Set<string> {
  const ids = new Set<string>();
  const expected = new Set(expectedIds);
  for (const call of toolCalls) {
    const observation = readToolObservation(call);
    const id = isPersistedSubmission(call)
      ? observation.params.supersedes
      : evolutionOutcome(call)
        ? (observation.params.id ?? observation.params.recipeId)
        : null;
    if (typeof id === 'string' && id && (expected.size === 0 || expected.has(id))) {
      ids.add(id);
    }
  }
  return ids;
}
