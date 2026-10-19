import Logger from '@alembic/core/logging';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evolutionGateEvaluator } from '../src/agent/evaluation/gateEvaluators.js';

// 背景（module-review L7 / P27，问题 C49）：evolutionGateEvaluator 在 existingRecipes 缺省时回退
// 旧字段 decayedRecipes；Agent、宿主、Core 都没有该字段的写入方。删除别名取决于待决定③，在那之前
// 行为不变，但这条兼容回退必须可观测：一旦有隐藏写入方走到回退，日志能指认它，作为决定③的证据。

const ALIAS_LOG_MESSAGE = '[EvolutionGate] legacy decayedRecipes alias used';

function spyWarn() {
  // winston 的 warn 返回 Logger 本身；mock 返回同一实例以满足签名，不触发真实输出。
  return vi.spyOn(Logger.getInstance(), 'warn').mockImplementation(() => Logger.getInstance());
}

function aliasLogs(warn: ReturnType<typeof spyWarn>) {
  return warn.mock.calls.filter(([msg]) => msg === ALIAS_LOG_MESSAGE);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('evolutionGateEvaluator decayedRecipes alias diagnostics (C49)', () => {
  it('keeps the fallback behavior and reports that the legacy alias was used', () => {
    const warn = spyWarn();
    const result = evolutionGateEvaluator({ toolCalls: [] }, null, {
      decayedRecipes: [{ id: 'recipe-1' }, { id: 'recipe-2' }],
    });

    // 回退行为不变：别名里的 Recipe 仍是期望集合，未决策时要求补写。
    expect(result.action).toBe('retry');
    expect(result.artifact).toMatchObject({
      totalRecipes: 2,
      pendingIds: ['recipe-1', 'recipe-2'],
    });

    const logs = aliasLogs(warn);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.[1]).toMatchObject({
      reasonCode: 'evolution-gate-decayed-recipes-alias',
      recipeCount: 2,
      resolution: 'fallback-to-decayedRecipes',
    });
  });

  it('prefers existingRecipes without reporting the alias, even when both are present', () => {
    const warn = spyWarn();
    const result = evolutionGateEvaluator({ toolCalls: [] }, null, {
      existingRecipes: [{ id: 'recipe-current' }],
      decayedRecipes: [{ id: 'recipe-legacy-1' }, { id: 'recipe-legacy-2' }],
    });
    expect(result.artifact).toMatchObject({ totalRecipes: 1, pendingIds: ['recipe-current'] });
    expect(aliasLogs(warn)).toHaveLength(0);
  });

  it('stays silent when neither field is provided', () => {
    const warn = spyWarn();
    const result = evolutionGateEvaluator({ toolCalls: [] }, null, {});
    expect(result).toMatchObject({ action: 'pass', artifact: { totalRecipes: 0 } });
    expect(aliasLogs(warn)).toHaveLength(0);
  });
});
