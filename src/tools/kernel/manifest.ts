/**
 * 工具能力元数据的共用合同；只定义可序列化描述，不依赖目录、router 或宿主实现。
 *
 * 字段是否真的被执行，以读取方为准（2026-10 核对 Agent 与宿主源码）。
 *
 * 当前有读取方的字段：
 * - id、description、inputSchema：CapabilityCatalog 投影模型 schema。
 * - lifecycle、surfaces：CapabilityCatalog.list 过滤。宿主 HTTP 直通入口的守卫代码也读取
 *   surfaces（risk.sideEffect 只用于拒绝原因文案），但它查询的 capabilityCatalog 是
 *   RuntimeCapabilityCatalog，其 getManifest 恒返回 null，所以这条守卫目前不会命中。
 * - risk.sideEffect/writeScope/network/credentialAccess、governance.policyProfile、
 *   execution.concurrency/cachePolicy：duplicateCache 判断能否复用只读结果。它从 toolRegistry
 *   查 manifest，而运行时工具不在那里注册，所以这条判断目前在生产中查不到 manifest。
 * - governance.allowInRemoteMcp、risk.sideEffect、governance.policyProfile：
 *   UnifiedToolCatalog 由 ToolDefinition 推导 surfaces 与 evals.required 时读取。
 *
 * 仅描述性的字段（Agent 与宿主都不读取，声明了也不会生效，需要的执行方必须自行实现）：
 * - execution.adapter/timeoutMs/maxOutputBytes/abortMode/artifactMode：没有任何执行器按它们
 *   加超时、取消或输出上限。运行时工具的并发、缓存与输出 token 上限来自 runtime/registry.ts
 *   的 ToolAction 声明，不来自这里。
 * - governance.approvalPolicy/allowedRoles/allowInComposer/allowInNonInteractive/
 *   gatewayAction/gatewayResource：没有审批、角色或网关门禁读取它们。
 * - governance.auditLevel：只被兼容方法 UnifiedToolCatalog.getInternalTool 复制进元数据，
 *   该方法没有生产调用方。
 * - risk.dataAccess/requiresHumanConfirmation/owaspTags：没有确认流程或策略读取它们。
 *
 * 宿主 dashboard 操作是否落实 timeoutMs/abortMode/approvalPolicy 属于宿主仓库的事项，
 * 不在 Agent 侧执行。
 */

export type CapabilityKind =
  | 'internal-tool'
  | 'dashboard-operation'
  | 'workflow'
  | 'terminal-profile'
  | 'skill'
  | 'mcp-tool'
  | 'macos-adapter';

export type CapabilityLifecycle = 'experimental' | 'active' | 'deprecated' | 'disabled';

export type CapabilitySurface = 'runtime' | 'http' | 'mcp' | 'dashboard' | 'skill' | 'internal';

export type CapabilityPolicyProfile = 'read' | 'analysis' | 'write' | 'system' | 'admin';

export type CapabilityAuditLevel = 'none' | 'checkOnly' | 'full';

export type CapabilityAbortMode = 'none' | 'preStart' | 'cooperative' | 'hardTimeout';

export interface ToolExample {
  title: string;
  input: Record<string, unknown>;
  output?: unknown;
}

export interface ToolFailureMode {
  code: string;
  description: string;
  retryable?: boolean;
}

/** 风险声明；dataAccess/requiresHumanConfirmation/owaspTags 仅描述性，读取方见文件头。 */
export interface ToolRiskProfile {
  sideEffect: boolean;
  dataAccess: 'none' | 'project' | 'workspace' | 'user-home' | 'network' | 'secrets';
  writeScope: 'none' | 'project' | 'data-root' | 'workspace' | 'system';
  network: 'none' | 'allowlisted' | 'open';
  credentialAccess: 'none' | 'masked' | 'scoped-token' | 'raw-secret';
  requiresHumanConfirmation: 'never' | 'on-risk' | 'always';
  owaspTags: Array<
    | 'prompt-injection'
    | 'sensitive-info'
    | 'supply-chain'
    | 'excessive-agency'
    | 'unbounded-consumption'
  >;
}

/** 执行声明；只有 concurrency/cachePolicy 有读取方，其余仅描述性，不会被任何执行器执行。 */
export interface ToolExecutionProfile {
  adapter: 'internal' | 'dashboard' | 'terminal' | 'skill' | 'mcp' | 'macos' | 'workflow';
  timeoutMs: number;
  maxOutputBytes: number;
  abortMode: CapabilityAbortMode;
  cachePolicy: 'none' | 'session' | 'scope' | 'persistent';
  concurrency: 'single' | 'parallel-safe' | 'exclusive';
  artifactMode: 'inline' | 'file-ref' | 'resource-link';
}

/** 治理声明；只有 policyProfile/allowInRemoteMcp 有读取方，其余仅描述性，不构成门禁（auditLevel 见文件头）。 */
export interface ToolGovernanceProfile {
  gatewayAction?: string;
  gatewayResource?: string;
  auditLevel: CapabilityAuditLevel;
  policyProfile: CapabilityPolicyProfile;
  approvalPolicy: 'auto' | 'explain-then-run' | 'confirm-once' | 'confirm-every-time';
  allowedRoles: string[];
  allowInComposer: boolean;
  allowInRemoteMcp: boolean;
  allowInNonInteractive: boolean;
}

export interface ToolEvalProfile {
  required: boolean;
  cases: string[];
}

export interface ToolExternalTrustProfile {
  source: 'mcp-server' | 'skill' | 'macos';
  serverId?: string;
  trusted: boolean;
  reason: string;
  outputContainsUntrustedText: boolean;
  allowlisted?: boolean;
  registration?: {
    source: 'bundled' | 'workspace-config' | 'user-config' | 'runtime' | 'unknown';
    configPath?: string;
    declaredBy?: string;
  };
}

export interface ToolCapabilityManifest {
  id: string;
  title: string;
  kind: CapabilityKind;
  description: string;
  owner: string;
  lifecycle: CapabilityLifecycle;
  surfaces: CapabilitySurface[];
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  examples?: ToolExample[];
  failureModes?: ToolFailureMode[];
  risk: ToolRiskProfile;
  execution: ToolExecutionProfile;
  governance: ToolGovernanceProfile;
  externalTrust?: ToolExternalTrustProfile;
  evals: ToolEvalProfile;
}
