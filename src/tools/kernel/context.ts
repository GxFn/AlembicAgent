/**
 * Tool call context contract — surface/actor/source identity, runtime call
 * context, and the service-locator/service-contract seams shared by the router
 * and host adapters. Canonical home (formerly src/tools/core/ToolCallContext.ts).
 */

import type { ToolDecisionResultStatus } from './decision.js';
import type { ToolResultEnvelope } from './result.js';

export type ToolSurface = 'runtime' | 'http' | 'mcp' | 'dashboard' | 'composer' | 'system';

export interface ToolActor {
  role?: string;
  user?: string;
  sessionId?: string;
}

export interface ToolCallSource {
  kind: 'runtime' | 'http' | 'mcp' | 'dashboard' | 'composer' | 'system';
  name?: string;
}

export interface ToolServiceLocator {
  get<T = unknown>(name: string): T;
}

export interface ToolRoutingServiceContract {
  toolRouter?: unknown | null;
}

export interface ToolKnowledgeServiceContract {
  getKnowledgeService(): unknown | null;
  getSearchEngine(): unknown | null;
  getKnowledgeGraphService(): unknown | null;
}

export interface ToolGuardServiceContract {
  getGuardService(): unknown | null;
  getGuardCheckEngine(): unknown | null;
  getViolationsStore(): unknown | null;
}

export interface ToolLifecycleServiceContract {
  getKnowledgeLifecycleService(): unknown | null;
  getProposalRepository(): unknown | null;
  getProposalGateway(): unknown | null;
  getConsolidationAdvisor(): unknown | null;
}

export interface ToolInfraServiceContract {
  getKnowledgeGraphService(): unknown | null;
  getIndexingPipeline(): unknown | null;
  getAuditLogger(): unknown | null;
}

export interface ToolQualityServiceContract {
  getQualityScorer(): unknown | null;
  getRecipeCandidateValidator(): unknown | null;
  getFeedbackCollector(): unknown | null;
}

export interface ToolServiceContracts {
  toolRouting?: ToolRoutingServiceContract;
  knowledge?: ToolKnowledgeServiceContract;
  guard?: ToolGuardServiceContract;
  lifecycle?: ToolLifecycleServiceContract;
  infra?: ToolInfraServiceContract;
  quality?: ToolQualityServiceContract;
}

export interface ToolPolicyDecision {
  ok: boolean;
  reason?: string;
  resultStatus?: ToolDecisionResultStatus;
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
  requestId?: string;
}

export interface ToolPolicyValidator {
  validateToolCall(toolName: string, args: Record<string, unknown>): ToolPolicyDecision;
}

export interface ToolResultCacheProvider {
  getCachedResult(toolName: string, args: Record<string, unknown>): unknown | null | undefined;
  cacheToolResult?(toolName: string, args: Record<string, unknown>, result: unknown): void;
}

export interface ToolDiagnosticsRecorder {
  recordToolCallEnvelope(
    envelope: ToolResultEnvelope,
    context?: {
      kind?: string;
      surface?: ToolSurface;
      source?: string;
    }
  ): void;
}

/**
 * 证据台账只读端口（Wave A E3/E4）——结构化 LIKE 型，避免 kernel→agent 反向依赖
 * （同 MemoryCoordinatorLike 先例）。note_finding 录入校验、近似候选提示与
 * evidence.get/search 只读取回共用。
 */
export interface EvidenceLedgerLike {
  get(ref: string): {
    id: string;
    file?: string;
    range?: { start: number; end: number };
    content: string;
  } | null;
  search(
    query: string,
    limit?: number
  ): Array<{
    id: string;
    file?: string;
    range?: { start: number; end: number };
    content: string;
  }>;
  listRecent(
    limit?: number
  ): Array<{ id: string; file?: string; range?: { start: number; end: number } }>;
  stats(): { entries: number; distinctFiles: number };
  /** E5 新鲜度终检：同区间重切+同截断+同脱敏后比对采集哈希；无法复核的条目返回 'unknown' */
  checkFreshness(ref: string, currentFileContent: string): 'fresh' | 'stale' | 'unknown';
}

export interface ToolRuntimeCallContext {
  agentId?: string;
  presetName?: string;
  iteration?: number;
  /** 证据台账（Wave A E3）；缺席=非维度场景，note_finding 降级为不校验直存 */
  evidenceLedger?: EvidenceLedgerLike | null;
  policyValidator?: ToolPolicyValidator | null;
  cache?: ToolResultCacheProvider | null;
  diagnostics?: ToolDiagnosticsRecorder | null;
  logger?: unknown;
  aiProvider?: unknown;
  safetyPolicy?: unknown;
  fileCache?: unknown;
  dataRoot?: string | null;
  lang?: string | null;
  sharedState?: Record<string, unknown> | null;
  dimensionMeta?: unknown;
  projectLanguage?: string | null;
  validator?: unknown;
  submittedTitles?: Set<string> | null;
  submittedPatterns?: Set<string> | null;
  submittedTriggers?: Set<string> | null;
  sessionToolCalls?: Array<{ tool: string; params?: Record<string, unknown> }> | null;
  bootstrapDedup?: unknown;
  memoryCoordinator?: unknown;
  currentRound?: number;
  dimensionScopeId?: string | null;
}

export interface ToolCallContext {
  callId: string;
  parentCallId?: string;
  toolId: string;
  surface: ToolSurface;
  actor: ToolActor;
  source: ToolCallSource;
  runtime?: ToolRuntimeCallContext;
  systemRunContext?: unknown;
  abortSignal?: AbortSignal | null;
  projectRoot: string;
  dataRoot?: string | null;
  services: ToolServiceLocator;
  serviceContracts?: ToolServiceContracts;
}
