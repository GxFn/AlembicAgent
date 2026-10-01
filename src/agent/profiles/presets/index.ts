/**
 * Presets —— 命名的 Agent 运行时基块组合(W6-e 方案甲:presets.ts 拆三文件+本组装件)。
 *
 * 语义降级声明:preset 不是第二套 profile——它是 profile 的「运行时默认块」
 * (Capability+Strategy+Policy 命名组合,含工厂/闭包,受 AgentProfileRegistry 的声明快照
 * 序列化门约束不可内联进 profile);profile 是可序列化声明层,经 basePreset 回指到
 * 这里展开。PRESETS/getPreset/resolveStrategy 符号与三 preset id
 * ('chat'/'insight'/'evolution')是冻结面(主体 HTTP 投影 ai.ts:716+
 * process events preset 字段消费)。
 */
import { FanOutStrategy, SingleStrategy, type Strategy } from '../../strategies/index.js';
import { PipelineStrategy } from '../../strategies/PipelineStrategy.js';
import { CHAT_PRESET } from './chatPreset.js';
import { EVOLUTION_PRESET } from './evolutionPreset.js';
import { INSIGHT_PRESET } from './insightPreset.js';
import type { StrategyConfig } from './types.js';

// ─── Preset 定义(对象身份=各 preset 文件的字面量;阶段工厂按阶段名取 insight/evolution stages)──

/** 所有内置 Preset */
export const PRESETS = Object.freeze({
  chat: CHAT_PRESET,
  insight: INSIGHT_PRESET,
  evolution: EVOLUTION_PRESET,
});

// ─── Preset 解析器 ────────────────────────────

/**
 * 将 Preset 配置中的 strategy 声明式配置转换为实际 Strategy 实例
 *
 * @param strategyConfig { type: 'single'|'pipeline'|'fan_out', ...opts }
 */
export function resolveStrategy(strategyConfig: StrategyConfig | null | undefined): Strategy {
  if (!strategyConfig) {
    return new SingleStrategy();
  }

  switch (strategyConfig.type) {
    case 'single':
      return new SingleStrategy();

    case 'pipeline':
      return new PipelineStrategy({
        stages: strategyConfig.stages || [],
        maxRetries: strategyConfig.maxRetries,
      });

    case 'fan_out': {
      const itemStrategy: Strategy = strategyConfig.itemStrategy
        ? resolveStrategy(strategyConfig.itemStrategy)
        : new SingleStrategy();
      return new FanOutStrategy({
        itemStrategy,
        tiers: strategyConfig.tiers,
        merge: strategyConfig.merge,
      });
    }

    default:
      throw new Error(`Unknown strategy type: ${strategyConfig.type}`);
  }
}

/**
 * 获取 Preset 并展开为可用配置
 *
 * @param [overrides] 覆盖 preset 中的特定字段
 * @returns }
 */
export function getPreset(presetName: string, overrides: Record<string, unknown> = {}) {
  const preset = Object.hasOwn(PRESETS, presetName)
    ? (PRESETS as Record<string, Record<string, unknown>>)[presetName]
    : undefined;
  if (!preset) {
    throw new Error(
      `Unknown preset: "${presetName}". Available: ${Object.keys(PRESETS).join(', ')}`
    );
  }

  const merged: Record<string, unknown> = cloneRuntimeConfig({
    ...preset,
    ...overrides,
    capabilities: overrides.capabilities || preset.capabilities,
    policies: overrides.policies || preset.policies,
    strategy: overrides.strategy || preset.strategy,
    persona: {
      ...(preset.persona as Record<string, unknown>),
      ...(overrides.persona as Record<string, unknown>),
    },
    memory: {
      ...(preset.memory as Record<string, unknown>),
      ...(overrides.memory as Record<string, unknown>),
    },
  });

  // Strategy 同样消费本次快照；闭包和注入的 Policy/端口实例保留身份。
  const strategyConfig = merged.strategy as StrategyConfig | undefined;
  merged.strategyInstance = resolveStrategy(strategyConfig);

  return merged;
}

/** 内部配置快照：复制普通数据容器，保留函数与非数据实例；可变宿主端口仍由context/闭包注入；不从包 facade 导出。 */
export function cloneRuntimeConfig<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (!value || typeof value !== 'object') {
    return value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  if (seen.has(value)) {
    return seen.get(value) as T;
  }
  const copy = Array.isArray(value) ? [] : Object.create(prototype);
  seen.set(value, copy);
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      value: cloneRuntimeConfig(child, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy as T;
}

export default { PRESETS, resolveStrategy, getPreset };
