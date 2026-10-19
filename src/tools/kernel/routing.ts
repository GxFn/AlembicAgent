/**
 * Tool routing service helpers — wrap/resolve a ToolRouterContract through the
 * service-contract seam. Canonical home (formerly
 * src/tools/core/ToolRoutingServices.ts).
 *
 * 形状守卫只要求 execute（L3-C09）：explain/executeChildCall 在契约上是可选的，生产链也不
 * 调用它们，所以只实现 execute 的路由同样可以经这个接缝注入。
 * 但“可选”不等于“放开形状”：toolRouter 的静态类型是 unknown，这个守卫是唯一的运行时校验，
 * 所以 explain/executeChildCall 只要出现就必须是函数（值为 undefined 视同未提供），否则按
 * request.ts 约定“先判存在再调用”的调用方会在调用处抛 TypeError。
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
  // 已配置却形状不符：拒绝返回它，避免调用方在 execute / explain / executeChildCall 处才以
  // TypeError 失败。日志点名具体不符的成员和各成员的 typeof，只输出类型不输出值。
  Logger.getInstance().warn(
    `[resolveToolRouterFromContext] configured serviceContracts.toolRouting.toolRouter rejected: ` +
      `invalidMembers=${describeInvalidMembers(routed)}; ` +
      `memberTypes=${describeMemberTypes(routed)}; ` +
      `rule=execute must be a function, explain/executeChildCall must be undefined or functions; ` +
      `valueType=${typeof routed}; keys=${describeKeys(routed)}; ` +
      `tool=${context.toolId || '(unknown)'}; callId=${context.callId || '(unknown)'}; result=null`
  );
  return null;
}

/** 参与运行时形状校验的成员：execute 必需，其余两个可选但给了就必须是函数。 */
const OPTIONAL_ROUTER_METHODS = ['explain', 'executeChildCall'] as const;
const CHECKED_ROUTER_MEMBERS = ['execute', ...OPTIONAL_ROUTER_METHODS] as const;

function isToolRouterContract(value: unknown): value is ToolRouterContract {
  // releaseScope 同为可选成员，但不在本守卫的校验范围内（父提交起就未校验）。
  return !!value && typeof value === 'object' && listInvalidRouterMembers(value).length === 0;
}

/** 返回形状不符的成员名；空数组表示 execute 是函数且可选方法要么缺省要么是函数。 */
function listInvalidRouterMembers(value: object): string[] {
  const record = value as Record<string, unknown>;
  const invalid: string[] = [];
  if (typeof record.execute !== 'function') {
    invalid.push('execute');
  }
  for (const name of OPTIONAL_ROUTER_METHODS) {
    // 可选方法缺省（含显式 undefined）合法；null、数字、字符串等非函数值都不合法。
    if (record[name] !== undefined && typeof record[name] !== 'function') {
      invalid.push(name);
    }
  }
  return invalid;
}

function describeInvalidMembers(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return '(value is not an object)';
  }
  return listInvalidRouterMembers(value).join(',');
}

/** 只输出受校验成员的 typeof（null 单独标出），用于诊断形状不符；不输出任何值。 */
function describeMemberTypes(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return '(none)';
  }
  const record = value as Record<string, unknown>;
  return CHECKED_ROUTER_MEMBERS.map(
    (name) => `${name}:${record[name] === null ? 'null' : typeof record[name]}`
  ).join(',');
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
