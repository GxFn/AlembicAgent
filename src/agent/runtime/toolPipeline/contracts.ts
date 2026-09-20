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
export type ToolLoopPort = Pick<
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
  | 'toolCalls'
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
/** before 钩子返回值 */
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
