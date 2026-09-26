/**
 * Agent 聚合兼容入口：Service 编排 profile、Runtime、策略与工具执行。
 * HTTP/CLI/Workflow 交付壳由宿主提供；Codex host-agent 路由由 AlembicPlugin 提供。
 * Core 的确定性内核通过 @alembic/core 消费，不能从本入口复制为第二套实现。
 * 运行默认值由 profiles/presets 单源维护；公开名集由 public-signature probe 校验。
 */

// ── Capabilities ──
export { Capability } from '../tools/runtime/toolsets/Capability.js';
export { CapabilityRegistry } from '../tools/runtime/toolsets/CapabilityRegistry.js';
export { Conversation } from '../tools/runtime/toolsets/Conversation.js';
// ── Policies ──
export {
  BudgetPolicy,
  Policy,
  PolicyEngine,
  QualityGatePolicy,
  SafetyPolicy,
} from './policies/index.js';
// ── Presets ──
export { getPreset, PRESETS, resolveStrategy } from './profiles/presets/index.js';
export { AgentEventBus, AgentEvents } from './runtime/AgentEventBus.js';
export {
  AGENT_INTERFACE_CONTRACT_REQUIRED_BRANCHES,
  AGENT_INTERFACE_CONTRACT_REQUIRED_ROWS,
  AGENT_INTERFACE_D23_ORDINARY_OUTPUT_POLICY,
  AGENT_INTERFACE_D25_FAILURE_TAXONOMY_POLICY,
  AGENT_INTERFACE_FORBIDDEN_ORDINARY_OUTPUT_FIELDS,
  ALEMBIC_AGENT_INTERFACE_CONTRACT,
  getAgentInterfaceContractBranch,
  getAgentInterfaceFailureTaxonomyEntry,
  validateAgentInterfaceContract,
} from './runtime/AgentInterfaceContract.js';
export { AgentMessage, Channel } from './runtime/AgentMessage.js';
// ── Runtime（Core确定性能力仍由 @alembic/core 提供）──
export { AgentRuntime } from './runtime/AgentRuntime.js';
export {
  ALEMBIC_AGENT_RUNTIME_BOUNDARY,
  getAgentRuntimeBoundaryEntry,
  supportsAgentRuntimeRoute,
} from './runtime/AgentRuntimeBoundary.js';
// ── Infrastructure ──
export { AgentPhase, AgentState } from './runtime/AgentState.js';
export * from './service/index.js';
// ── Strategies ──
export {
  FanOutStrategy,
  SingleStrategy,
  Strategy,
} from './strategies/index.js';
export { PipelineStrategy } from './strategies/PipelineStrategy.js';
