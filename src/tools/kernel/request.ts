/**
 * 工具调用请求与路由契约：ToolCallRequest、ToolExecutionRequest 与 ToolRouterContract。
 *
 * 当前事实（2026-10 核对 Agent 与宿主源码）：
 * - ToolRouterContract 当前唯一实现是 ToolRouterAdapter；宿主的 toolRouter 单例就是它，
 *   宿主没有第二个路由实现。
 * - 生产调用链只用到契约上的 execute 与 releaseScope；契约上的 explain、executeChildCall 在
 *   Agent 与宿主中都没有调用方（ToolRouterAdapter.executeChildCall 只是委托 execute；内部
 *   ToolRouter.explain 是另一个方法），因此已改为可选（L3-C09）：新的实现者只需实现 execute，
 *   kernel/routing.ts 的形状守卫也只要求 execute。ToolRouterAdapter 仍保留这两个方法。
 * - ToolCallRequest.governance 没有读取方，传入的 gatewayAction 等不会触发任何门禁；
 *   ToolExecutionAdapter 与 ToolExecutionPreviewRequest 没有实现者。宿主 dashboard 操作只
 *   使用 ToolExecutionRequest 的形状。
 */

import type {
  ToolActor,
  ToolCallContext,
  ToolCallSource,
  ToolRuntimeCallContext,
  ToolScopeRelease,
  ToolSurface,
} from './context.js';
import type { ToolDecision, ToolExecutionPreview } from './decision.js';
import type { CapabilityKind, ToolCapabilityManifest } from './manifest.js';
import type { ToolResultEnvelope } from './result.js';

export interface ToolCallRequest {
  toolId: string;
  args: Record<string, unknown>;
  surface: ToolSurface;
  actor: ToolActor;
  source: ToolCallSource;
  parentCallId?: string;
  abortSignal?: AbortSignal | null;
  runtime?: ToolRuntimeCallContext;
  governance?: {
    gatewayAction?: string | null;
    gatewayResource?: string;
    gatewayData?: Record<string, unknown>;
  };
}

export interface ToolExecutionRequest {
  manifest: ToolCapabilityManifest;
  args: Record<string, unknown>;
  context: ToolCallContext;
  decision: ToolDecision;
}

export interface ToolExecutionPreviewRequest {
  manifest: ToolCapabilityManifest;
  args: Record<string, unknown>;
  projectRoot: string;
}

export interface ToolExecutionAdapter {
  readonly kind: CapabilityKind;
  preview?(request: ToolExecutionPreviewRequest): ToolExecutionPreview | null;
  execute(request: ToolExecutionRequest): Promise<ToolResultEnvelope>;
}

export interface ToolRouterContract {
  /** 可选生命周期接缝；旧宿主仍可运行，新宿主必须释放自己持有的可变状态。 */
  releaseScope?(scope: ToolScopeRelease): void | Promise<void>;
  /** 唯一必需的执行入口：运行时桥（runtimeBridge）只经由它进入路由。 */
  execute(request: ToolCallRequest): Promise<ToolResultEnvelope>;
  /**
   * 可选：子调用入口。生产链没有调用方；需要父子关联的调用方可直接把 parentCallId
   * 放进 execute 的请求，ToolRouterAdapter 的实现也只是委托 execute。
   */
  executeChildCall?(
    request: ToolCallRequest & { parentCallId: string }
  ): Promise<ToolResultEnvelope>;
  /** 可选：只做准入预判、不执行工具。生产链没有调用方，调用前必须先判断是否存在。 */
  explain?(request: ToolCallRequest): Promise<ToolDecision>;
}
