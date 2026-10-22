import type { ContextWindow } from '../context/ContextWindow.js';
import type { ExplorationTracker } from '../context/ExplorationTracker.js';
import type { PipelineType } from '../context/exploration/ExplorationStrategies.js';
import type { ActiveContext } from '../memory/ActiveContext.js';
import type { MemoryCoordinator } from '../memory/MemoryCoordinator.js';

export interface SystemRunDimensionMeta extends Record<string, unknown> {
  id: string;
  outputType?: string;
  allowedKnowledgeTypes?: unknown[];
}

export interface SystemRunSharedState extends Record<string, unknown> {
  submittedTitles?: Set<unknown>;
  submittedPatterns?: Set<unknown>;
  submittedTriggers?: Set<unknown>;
  _bootstrapDedup?: unknown;
  _dimensionMeta?: SystemRunDimensionMeta;
  _projectLanguage?: string | null;
  _dimensionScopeId: string;
}

export interface SystemRunContext extends Record<string, unknown> {
  scopeId: string;
  contextWindow?: ContextWindow | null;
  tracker?: ExplorationTracker | null;
  /**
   * activeContext 的别名：经 createSystemRunContext 构造时二者恒为同一对象（不同即构造期抛错，
   * L5-P48 已删除放行选项）。字段本身仍被宿主投影与 PipelineStrategy 读取，去留另行决定。
   */
  trace: ActiveContext | null;
  activeContext: ActiveContext | null;
  memoryCoordinator: MemoryCoordinator;
  sharedState: SystemRunSharedState;
  source: string;
  outputType?: string;
  dimId?: string;
  dimensionId?: string;
  dimensionLabel?: string;
  projectLanguage?: string | null;
  submitToolName?: string;
  pipelineType?: PipelineType;
}

/**
 * projectSystemRunContext 的返回形状：SystemRunContext 的全部字段展平在顶层，另带指回原上下文的
 * systemRunContext。调用方（如 ScanAgentRun）据此直接读取 systemRunContext / scopeId，不再强转；
 * 字段改名时编译器能在调用方报错。仍继承 Record<string, unknown> 索引签名，可整体作为
 * strategyContext 传递。只描述既有运行时投影，不新增字段；runtime 公开入口不导出本类型名。
 */
export interface SystemRunContextProjection extends SystemRunContext {
  systemRunContext: SystemRunContext;
}

export interface BuildSystemRunContextOptions {
  memoryCoordinator: MemoryCoordinator;
  scopeId: string;
  contextWindow?: ContextWindow | null;
  tracker?: ExplorationTracker | null;
  trace?: ActiveContext | null;
  activeContext?: ActiveContext | null;
  sharedState?: Record<string, unknown>;
  source?: string;
  outputType?: string;
  dimId?: string;
  dimensionId?: string;
  dimensionLabel?: string;
  projectLanguage?: string | null;
  submitToolName?: string;
  pipelineType?: PipelineType;
  dimensionMeta?: SystemRunDimensionMeta;
  extraFields?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function stripUndefined(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function createSystemRunContext(options: BuildSystemRunContextOptions): SystemRunContext {
  const activeContext =
    options.activeContext ?? options.memoryCoordinator.getActiveContext(options.scopeId);
  if (!activeContext) {
    throw new Error(`SystemRunContext requires an ActiveContext for scope "${options.scopeId}"`);
  }

  // trace 只是 activeContext 的别名。L5-P48 删除了“允许二者指向不同对象”的放行选项（四处零引用）：
  // 两者不同一律失败关闭——旧 JS 调用方即使仍传该键也会被忽略并在这里抛错，不会得到语义分叉的上下文。
  const trace = options.trace ?? activeContext;
  if (trace !== activeContext) {
    throw new Error('SystemRunContext trace and activeContext must refer to the same scope');
  }

  const sharedState = {
    ...(options.sharedState || {}),
    ...(options.projectLanguage !== undefined ? { _projectLanguage: options.projectLanguage } : {}),
    ...(options.dimensionMeta ? { _dimensionMeta: options.dimensionMeta } : {}),
    _dimensionScopeId: options.scopeId,
  } as SystemRunSharedState;

  return stripUndefined({
    ...(options.extraFields || {}),
    scopeId: options.scopeId,
    contextWindow: options.contextWindow || null,
    tracker: options.tracker || null,
    trace,
    activeContext,
    memoryCoordinator: options.memoryCoordinator,
    sharedState,
    source: options.source || 'system',
    outputType: options.outputType,
    dimId: options.dimId,
    dimensionId: options.dimensionId,
    dimensionLabel: options.dimensionLabel,
    projectLanguage: options.projectLanguage,
    submitToolName: options.submitToolName,
    pipelineType: options.pipelineType,
  }) as SystemRunContext;
}

export function isSystemRunContext(value: unknown): value is SystemRunContext {
  return (
    isRecord(value) &&
    typeof value.scopeId === 'string' &&
    isRecord(value.sharedState) &&
    !!value.memoryCoordinator
  );
}

export function projectSystemRunContext(context: SystemRunContext): SystemRunContextProjection {
  // stripUndefined 只剔除值为 undefined 的键：这里的必填字段（scopeId/trace/activeContext/
  // memoryCoordinator/sharedState/source/systemRunContext）都来自已构造的 SystemRunContext，
  // 不会是 undefined，可选字段缺失与接口的可选声明一致，因此按投影接口返回。
  return stripUndefined({
    ...context,
    systemRunContext: context,
    contextWindow: context.contextWindow || null,
    tracker: context.tracker || null,
    trace: context.trace,
    activeContext: context.activeContext,
    memoryCoordinator: context.memoryCoordinator,
    sharedState: context.sharedState,
    source: context.source,
    outputType: context.outputType,
    dimId: context.dimId,
    dimensionId: context.dimensionId,
    dimensionLabel: context.dimensionLabel,
    scopeId: context.scopeId,
    submitToolName: context.submitToolName,
    pipelineType: context.pipelineType,
  }) as SystemRunContextProjection;
}

export function expandSystemRunContext(input: Record<string, unknown>): Record<string, unknown> {
  const systemRunContext = input.systemRunContext;
  if (!isSystemRunContext(systemRunContext)) {
    return input;
  }

  const sharedState = isRecord(input.sharedState)
    ? { ...systemRunContext.sharedState, ...input.sharedState }
    : systemRunContext.sharedState;

  return {
    ...projectSystemRunContext(systemRunContext),
    ...input,
    systemRunContext,
    sharedState,
  };
}
