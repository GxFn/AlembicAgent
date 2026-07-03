/**
 * Alembic Agent 模块 — 统一出口
 *
 * @module agent
 *
 * 统一架构: Surface -> AgentService -> Runtime -> Action Layer
 *
 *   ┌──────── Surface Layer ─────────┐
 *   │  HTTP│CLI│MCP│Workflow         │  ← 宿主表面只构造 AgentRunInput
 *   └──────────────┬─────────────────┘
 *              │     Codex MCP / marketplace / channel 由 AlembicPlugin 承载
 *              │
 *   ┌──────────▼─────────────────────┐
 *   │          AgentService          │  ← 统一服务入口 + profile 编译
 *   └──────────────┬─────────────────┘
 *              │
 *   ┌──────────▼─────────────────────┐
 *   │      AgentRuntimeBuilder       │  ← Profile + DI → Runtime
 *   └──────────────┬─────────────────┘
 *              │
 *   ┌──────────▼────────────────────────────────────────┐
 *   │              AgentRuntime                          │
 *   │                                                    │
 *   │  ┌────────────┐ ┌───────────┐ ┌────────────────┐ │
 *   │  │Agent Skill │ │ Strategy  │ │    Policy       │ │
 *   │  │ 运行时技能 │ │ 工程编排  │ │    约束引擎    │ │
 *   │  └────────────┘ └───────────┘ └────────────────┘ │
 *   │                                                    │
 *   │  ┌─────────────────────────────────────────┐      │
 *   │  │  ReAct Loop  (Thought→Action→Observe)   │      │
 *   │  └─────────────────────────────────────────┘      │
 *   └───────────────────────────────────────────────────┘
 *              │
 *   ┌──────────▼─────────────────────┐
 *   │ Action Layer: ToolRouter        │  ← 执行动作，不选择 Agent profile
 *   └────────────────────────────────┘
 *
 * Preset 配置表(W6-0 校准,真集=chat/insight/evolution):
 *   | Preset       | Capabilities             | Strategy    | Policies         |
 *   |--------------|--------------------------|-------------|------------------|
 *   | chat         | Conv + Analysis          | Single      | Budget(8轮)      |
 *   | insight      | Analysis + Knowledge     | Pipeline    | Budget+Quality   |
 *   | evolution    | Evolution analysis       | Pipeline    | Budget+Quality   |
 */

// ── Capabilities ──
export {
  Capability,
  CapabilityRegistry,
  CodeAnalysis,
  Conversation,
  KnowledgeProduction,
  SystemInteraction,
} from './capabilities/index.js';
// ── Policies ──
export {
  BudgetPolicy,
  Policy,
  PolicyEngine,
  QualityGatePolicy,
  SafetyPolicy,
} from './policies/index.js';
// ── Presets ──
export { getPreset, PRESETS, resolveStrategy } from './profiles/presets.js';
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
// ── Core ──
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
