/** 兼容旧类型入口；能力合同归 kernel，catalog 仅拥有注册、查询和投影行为。 */
export type {
  CapabilityAbortMode,
  CapabilityAuditLevel,
  CapabilityKind,
  CapabilityLifecycle,
  CapabilityPolicyProfile,
  CapabilitySurface,
  ToolCapabilityManifest,
  ToolEvalProfile,
  ToolExample,
  ToolExecutionProfile,
  ToolExternalTrustProfile,
  ToolFailureMode,
  ToolGovernanceProfile,
  ToolRiskProfile,
} from '../kernel/manifest.js';
export type { ToolSchemaProjection } from '../kernel/toolSchema.js';
