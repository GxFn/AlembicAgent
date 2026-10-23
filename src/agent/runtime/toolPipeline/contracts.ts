/** 工具管道的类型边界；只依赖类型，不加载 Runtime、具体策略或 handler。 */
import type { AgentRuntime } from '../AgentRuntime.js';
import type { ToolMetadata as RuntimeToolMetadata } from '../AgentRuntimeTypes.js';
import type { LoopContext } from '../LoopContext.js';

/** 工具调用描述 */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  id: string;
}

/** 仅暴露工具执行实际使用的 Runtime 端口，避免中间件依赖整个执行循环。 */
export type ToolRuntimePort = Pick<
  AgentRuntime,
  | 'id'
  | 'presetName'
  | 'projectRoot'
  | 'dataRoot'
  | 'fileCache'
  | 'lang'
  | 'logger'
  | 'aiProvider'
  | 'policies'
  | 'toolRegistry'
  | 'toolRouter'
  | 'emitProgress'
  | 'bus'
>;
export type ToolLoopPort = Partial<Pick<LoopContext, 'resourceScope' | 'toolSchemas'>> &
  Pick<
    LoopContext,
    | 'abortSignal'
    | 'allowedToolIds'
    | 'allowedToolActions'
    | 'budget'
    | 'capabilities'
    | 'context'
    | 'diagnostics'
    | 'evidenceLedger'
    | 'iteration'
    | 'memoryCoordinator'
    | 'sharedState'
    | 'source'
    | 'trace'
    | 'tracker'
  >;
export interface ToolPipelineContext {
  runtime: ToolRuntimePort;
  loopCtx: ToolLoopPort;
  iteration: number;
}
/** 公共 use/execute 保留原来的完整上下文，已有自定义 hook 仍可使用 Runtime 的其它公开方法。 */
export interface ToolExecContext {
  runtime: AgentRuntime;
  loopCtx: LoopContext;
  iteration: number;
}
/** 公共 metadata 单源，只在内部增加缓存键。 */
export interface ToolMetadata extends RuntimeToolMetadata {
  cacheKey?: string;
}
/**
 * before 钩子返回值。
 *
 * - `blocked: true`：阻止后续 before 与执行器；engine 会把成功形或缺失的 result 归一为失败 payload（I44）。
 * - 非 blocked 且 `result !== undefined`：只表示跳过执行器，用该值作为本次结果（null/0/false/'' 都有效）。
 *   engine 不再把它隐式记为缓存命中（L5-P19，决定②）；是否算命中由短路中间件自行写
 *   `metadata.cacheHit`（真实快照复用另写 `metadata.duplicateShortCircuit`）声明，
 *   deterministicDuplicateGuard 就是这样做的。未声明时 engine 只记一条日志说明未计入命中。
 * - 返回 undefined 或 `result === undefined`：继续下一个 before。
 */
export interface BeforeVerdict {
  blocked?: boolean;
  result?: unknown;
}

/** 工具中间件 */
export interface ToolMiddleware<Context extends ToolPipelineContext = ToolExecContext> {
  name: string;
  before?: (
    call: ToolCall,
    ctx: Context,
    metadata: ToolMetadata
  ) => BeforeVerdict | undefined | Promise<BeforeVerdict | undefined>;
  after?: (
    call: ToolCall,
    result: unknown,
    ctx: Context,
    metadata: ToolMetadata
  ) => void | Promise<void>;
}
export type ToolExecutor<Context extends ToolPipelineContext = ToolExecContext> = (
  call: ToolCall,
  context: Context,
  metadata: ToolMetadata
) => Promise<unknown>;
