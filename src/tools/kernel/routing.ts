/**
 * Tool routing service helpers — wrap/resolve a ToolRouterContract through the
 * service-contract seam. Canonical home (formerly
 * src/tools/core/ToolRoutingServices.ts).
 *
 * 形状守卫只要求 execute（L3-C09）：explain/executeChildCall 在契约上是可选的，生产链也不
 * 调用它们，所以只实现 execute 的路由同样可以经这个接缝注入。
 * resolveToolRouterFromContext 的公开返回值仍是 ToolRouterContract | null；“未配置”与
 * “已配置但形状不符”通过不同级别的诊断日志区分（debug / warn），不改变返回类型。
 */

import Logger from '@alembic/core/logging';
import type { ToolCallContext, ToolRoutingServiceContract } from './context.js';
import type { ToolRouterContract } from './request.js';

export function createToolRoutingServiceContract(
  toolRouter: ToolRouterContract | null | undefined
): ToolRoutingServiceContract {
  return {
    toolRouter: toolRouter || null,
  };
}

export function resolveToolRouterFromContext(context: ToolCallContext): ToolRouterContract | null {
  const routed = context.serviceContracts?.toolRouting?.toolRouter;
  if (routed === undefined || routed === null) {
    // 未配置是常态（宿主目前不注入这个接缝），只记 debug，便于和形状不符的 warn 区分。
    Logger.getInstance().debug(
      `[resolveToolRouterFromContext] tool routing service contract not configured; ` +
        `hasServiceContracts=${context.serviceContracts ? 'yes' : 'no'}; ` +
        `tool=${context.toolId || '(unknown)'}; callId=${context.callId || '(unknown)'}; result=null`
    );
    return null;
  }
  if (isToolRouterContract(routed)) {
    return routed;
  }
  // 已配置却不是可执行的路由：拒绝返回它，避免调用方在 execute 处才以 TypeError 失败。
  Logger.getInstance().warn(
    `[resolveToolRouterFromContext] configured serviceContracts.toolRouting.toolRouter rejected: ` +
      `execute is not a function; valueType=${typeof routed}; ` +
      `keys=${describeKeys(routed)}; tool=${context.toolId || '(unknown)'}; ` +
      `callId=${context.callId || '(unknown)'}; result=null`
  );
  return null;
}

function isToolRouterContract(value: unknown): value is ToolRouterContract {
  // 只检查唯一必需的 execute；可选的 explain/executeChildCall/releaseScope 不参与判定。
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as ToolRouterContract).execute === 'function'
  );
}

/** 只列出前几个自有键名，用于诊断形状不符；不输出任何值。 */
function describeKeys(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return '(none)';
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return '(none)';
  }
  const shown = keys.slice(0, 8).join(',');
  return keys.length > 8 ? `${shown},…(+${keys.length - 8})` : shown;
}
