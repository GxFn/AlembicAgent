/**
 * Internal tool handler contract — handler signature, handler context, and the
 * internal tool handler store. Canonical home (formerly
 * src/tools/core/InternalToolHandler.ts).
 *
 * 兼容层登记（L3-C08，2026-10 核对的当前事实）：
 *   - 消费者：本文件的 InternalToolHandler* 类型只被 UnifiedToolCatalog 的兼容方法
 *     getInternalTool（只有测试调用）使用；contextFromToolCall 在 src 与宿主中都没有调用方。
 *     生产工具执行只走 ToolRouterAdapter → ToolRouter → ActionHandler，不经过本层。
 *   - 保留原因：这些名字经 src/tools/index.ts 进入根 facade，属于冻结的公开签名清单
 *     （config/agent-public-api-signatures.json）；是否收窄公开面属于待决事项②，决定前不删除。
 *   - 移除条件：②确认收窄后，与 UnifiedToolCatalog.getInternalTool/InternalToolHandlerStore
 *     一起删除，并同步更新签名清单；若②决定保留，本登记继续有效。
 *   - 回落诊断：contextFromToolCall 在 projectRoot 为空时仍回落到 process.cwd()（保持兼容），
 *     但会经 Logger.warn 报告回落字段、工具与调用标识，避免在错误目录静默读写。
 */

import Logger from '@alembic/core/logging';
import type { ToolCallContext, ToolServiceContracts, ToolServiceLocator } from './context.js';

export interface InternalToolLogger {
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error?(msg: string, ...args: unknown[]): void;
}

export interface InternalToolSharedState {
  _searchCache?: unknown;
  _readCache?: unknown;
  _searchCallCount?: number;
}

export interface InternalToolHandlerContext {
  container: ToolServiceLocator;
  serviceContracts?: ToolServiceContracts;
  projectRoot: string;
  dataRoot?: string;
  logger?: InternalToolLogger;
  abortSignal?: AbortSignal | null;
  source?: string;
  toolCallContext?: ToolCallContext;
  aiProvider?: unknown;
  safetyPolicy?: unknown;
  fileCache?: unknown;
  _sharedState?: InternalToolSharedState;
  _dimensionMeta?: unknown;
  _projectLanguage?: string;
  _validator?: unknown;
  _submittedTitles?: Set<string>;
  _submittedPatterns?: Set<string>;
  /**
   * @deprecated 不再由 contextFromToolCall 填充（L5-P47 / I45）：没有任何 handler 读取，
   * runtimeBridge 也不再投影 runtime.sessionToolCalls。字段删除属于公开类型收窄，随待决事项②处理。
   */
  _sessionToolCalls?: Array<{ tool: string; params?: Record<string, unknown> }>;
  _bootstrapDedup?: unknown;
  _memoryCoordinator?: unknown;
  /**
   * @deprecated 不再由 contextFromToolCall 填充（L5-P47 / I45）：没有读取者，轮次请用
   * toolCallContext.runtime.iteration。字段删除属于公开类型收窄，随待决事项②处理。
   */
  _currentRound?: number;
  _dimensionScopeId?: string;
}

export type InternalToolHandler = (
  params: Record<string, unknown>,
  context: InternalToolHandlerContext
) => Promise<unknown> | unknown;

export interface InternalToolHandlerEntry {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  metadata: Record<string, unknown>;
  handler: InternalToolHandler;
}

export interface InternalToolHandlerStore {
  getInternalTool(name: string): InternalToolHandlerEntry | null;
}

export function contextFromToolCall(requestContext: ToolCallContext): InternalToolHandlerContext {
  const runtime = requestContext.runtime;
  reportCwdFallback(requestContext);
  return {
    container: toServiceLocator(requestContext.services),
    serviceContracts: requestContext.serviceContracts,
    projectRoot: requestContext.projectRoot || process.cwd(),
    dataRoot: requestContext.dataRoot || requestContext.projectRoot || process.cwd(),
    ...(runtime && isLogger(runtime.logger) ? { logger: runtime.logger } : {}),
    ...(requestContext.abortSignal ? { abortSignal: requestContext.abortSignal } : {}),
    ...(requestContext.source?.name ? { source: requestContext.source.name } : {}),
    toolCallContext: requestContext,
    ...(runtime?.aiProvider ? { aiProvider: runtime.aiProvider } : {}),
    ...(runtime?.safetyPolicy ? { safetyPolicy: runtime.safetyPolicy } : {}),
    ...(runtime?.fileCache ? { fileCache: runtime.fileCache } : {}),
    ...(typeof runtime?.dataRoot === 'string' ? { dataRoot: runtime.dataRoot } : {}),
    ...(isSharedState(runtime?.sharedState) ? { _sharedState: runtime.sharedState } : {}),
    ...(runtime?.dimensionMeta ? { _dimensionMeta: runtime.dimensionMeta } : {}),
    ...(typeof runtime?.projectLanguage === 'string'
      ? { _projectLanguage: runtime.projectLanguage }
      : {}),
    ...(runtime?.validator ? { _validator: runtime.validator } : {}),
    ...(runtime?.submittedTitles instanceof Set
      ? { _submittedTitles: runtime.submittedTitles }
      : {}),
    ...(runtime?.submittedPatterns instanceof Set
      ? { _submittedPatterns: runtime.submittedPatterns }
      : {}),
    // _sessionToolCalls / _currentRound 不再映射（L5-P47 / I45）：handler 中没有读取者，
    // runtimeBridge 也不再投影对应的 runtime 字段。
    ...(runtime?.bootstrapDedup ? { _bootstrapDedup: runtime.bootstrapDedup } : {}),
    ...(runtime?.memoryCoordinator ? { _memoryCoordinator: runtime.memoryCoordinator } : {}),
    ...(typeof runtime?.dimensionScopeId === 'string'
      ? { _dimensionScopeId: runtime.dimensionScopeId }
      : {}),
  };
}

/**
 * process.cwd() 回落诊断：返回值保持旧行为（兼容公开函数），只补一条可定位的 warn。
 *
 * 判定与 contextFromToolCall 的取值顺序一致：
 *   - projectRoot：请求上下文的 projectRoot 为空时回落到 cwd；
 *   - dataRoot：runtime.dataRoot 是字符串时优先使用它（不回落）；否则依次取请求的 dataRoot、
 *     projectRoot，两者都为空时才回落到 cwd。
 * daemon 的 cwd 不一定是项目根，回落后 handler 可能在错误目录读写，所以必须留痕。
 * 日志只写字段名、工具 id、调用 id 与来源名，不写解析出的绝对路径。
 */
function reportCwdFallback(requestContext: ToolCallContext): void {
  if (requestContext.projectRoot) {
    return;
  }
  const runtimeDataRoot = requestContext.runtime?.dataRoot;
  const dataRootFallsBack = typeof runtimeDataRoot !== 'string' && !requestContext.dataRoot;
  const fields = dataRootFallsBack ? 'projectRoot,dataRoot' : 'projectRoot';
  Logger.getInstance().warn(
    `[contextFromToolCall] legacy handler context fallback: ToolCallContext.projectRoot is empty; ` +
      `fields=${fields}; resolved=process.cwd(); tool=${requestContext.toolId || '(unknown)'}; ` +
      `callId=${requestContext.callId || '(unknown)'}; source=${requestContext.source?.name || requestContext.source?.kind || '(unknown)'}; ` +
      'pass an explicit projectRoot so handlers do not read or write relative to the process directory'
  );
}

function toServiceLocator(container: unknown): ToolServiceLocator {
  if (
    container &&
    typeof container === 'object' &&
    typeof (container as ToolServiceLocator).get === 'function'
  ) {
    return container as ToolServiceLocator;
  }
  return {
    get(name: string) {
      throw new Error(`Service '${name}' is not available in internal tool context`);
    },
  };
}

function isLogger(value: unknown): value is InternalToolLogger {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as InternalToolLogger).info === 'function' &&
    typeof (value as InternalToolLogger).debug === 'function' &&
    typeof (value as InternalToolLogger).warn === 'function'
  );
}

function isSharedState(value: unknown): value is InternalToolSharedState {
  return !!value && typeof value === 'object';
}
