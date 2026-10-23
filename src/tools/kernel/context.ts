/**
 * Tool call context contract — surface/actor/source identity, runtime call
 * context, and the service-locator seam shared by the router and host adapters.
 * Canonical home (formerly src/tools/core/ToolCallContext.ts).
 *
 * 收窄记录（W2a-02，审阅包 L3-P08 / L3-P10 / L5-P47，按事项②执行；路由契约的唯一实现仍是
 * ToolRouterAdapter）：
 * - 删除 ToolCallContext.serviceContracts 与 6 个 *ServiceContract 接缝类型：从未被赋值，
 *   唯一读取方 kernel/routing.ts 同批删除。
 * - ToolRuntimeCallContext 按读写对账删除没有读取方的字段：diagnostics 端口（逐调用诊断由
 *   runtimeBridge 直接写入 loopCtx.diagnostics）、policyValidator、sessionToolCalls、currentRound、
 *   validator、fileCache、dataRoot、logger。safetyPolicy、memoryCoordinator 等有宿主
 *   ToolContextFactory 或 handler 读取的字段保留；ToolCallContext 顶层 dataRoot 保留。
 * - ToolPolicyValidator / ToolPolicyDecision 在 policyValidator 删除后没有字段引用，但不在本批
 *   批准清单内，按总控裁定保留为公开类型（观察项）。
 */

import type { ToolDecisionResultStatus } from './decision.js';
import type { TerminalCommandAllowlist } from './registry.js';
import type { ToolActionAllowlist } from './toolSchema.js';

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

/**
 * 证据台账只读端口（Wave A E3/E4）——结构化 LIKE 型，避免 kernel→agent 反向依赖
 * （同 MemoryCoordinatorLike 先例）。note_finding 录入校验、近似候选提示与
 * evidence.get/search 只读取回共用。
 *
 * 条目上的可选 `tool` 是采集来源的证据工具 id（如 'code.search'、'terminal.exec'），
 * EvidenceLedgerStore 条目本就携带。提交侧展开只对 code.search 条目把内容里的 `NN:`
 * 前缀当作文件行号；不提供 tool 的实现一律按「来源未知」保守处理（只给裸文件标签）。
 * listRecent/searchByFile 按采集序（旧→新）返回，调用方据此取最新条目。
 */
export interface EvidenceLedgerLike {
  get(ref: string): {
    id: string;
    tool?: string;
    file?: string;
    range?: { start: number; end: number };
    content: string;
  } | null;
  search(
    query: string,
    limit?: number
  ): Array<{
    id: string;
    tool?: string;
    file?: string;
    range?: { start: number; end: number };
    content: string;
  }>;
  listRecent(
    limit?: number
  ): Array<{ id: string; tool?: string; file?: string; range?: { start: number; end: number } }>;
  /** 按文件路径片段（子串）检索（refs 机械自推断用）；可选——旧实现缺席时推断静默跳过 */
  searchByFile?(
    fragment: string,
    limit?: number
  ): Array<{ id: string; file?: string; range?: { start: number; end: number } }>;
  stats(): { entries: number; distinctFiles: number };
  /** E5 新鲜度终检：同区间重切+同截断+同脱敏后比对采集哈希；无法复核的条目返回 'unknown' */
  checkFreshness(ref: string, currentFileContent: string): 'fresh' | 'stale' | 'unknown';
}

/** 宿主状态的生命周期身份；由运行时生成，不能从模型工具参数推导。 */
export interface ToolResourceScope {
  runId: string;
  /** 一次 reactLoop 的读取视图；同一 run 可并行持有多个视图。 */
  viewId: string;
  /** 有损压缩/重置后递增，旧视图的全文可见性不能被继续借用。 */
  revision: number;
}

/** 缺省 viewId 释放整个 run；指定时只释放该读取视图，保留运行记忆。 */
export interface ToolScopeRelease {
  runId: string;
  viewId?: string;
}

export interface ToolRuntimeCallContext {
  /** 当前阶段允许集合，由 runtime 投影；仅可收窄宿主/router 配置，不来自模型参数。 */
  allowedTools?: ToolActionAllowlist;
  /**
   * 当前能力声明的终端隔离意图（L4-P38 / I47），由 runtimeBridge 只为 terminal 调用从
   * loopCtx.capabilities 投影（mergeTerminalIntents 按维度取最严格值），不来自模型参数。
   * 生产宿主的 ToolRouterAdapter 不带 capability，这是 intent 到达 terminal handler 的唯一生产
   * 入口；handler 再与 ToolContext.commandAllowlist.intent 合并，作为 sandboxExecutor.exec 的
   * opts.intent 交给宿主。只能追加限制、不能放宽；未声明时不出现该键。
   */
  terminalIntent?: TerminalCommandAllowlist['intent'];
  agentId?: string;
  resourceScope?: ToolResourceScope;
  presetName?: string;
  iteration?: number;
  /** 证据台账（Wave A E3）；缺席=非维度场景，note_finding 降级为不校验直存 */
  evidenceLedger?: EvidenceLedgerLike | null;
  aiProvider?: unknown;
  /** 宿主 ToolContextFactory 读取并转交为 ToolContext.safetyPolicy，供 handler 使用。 */
  safetyPolicy?: unknown;
  lang?: string | null;
  sharedState?: Record<string, unknown> | null;
  dimensionMeta?: unknown;
  projectLanguage?: string | null;
  submittedTitles?: Set<string> | null;
  submittedPatterns?: Set<string> | null;
  submittedTriggers?: Set<string> | null;
  bootstrapDedup?: unknown;
  /** 记忆协调器：宿主 ToolContextFactory 转交为 ToolContext.memoryCoordinator，可用性检查也读取它。 */
  memoryCoordinator?: unknown;
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
}
