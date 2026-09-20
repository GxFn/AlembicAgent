import type { ToolContext } from './registry.js';
import type { ToolActionAllowlist } from './toolSchema.js';

/** 仅描述接线能力；不是 actor 权限，也不保证单次业务输入会被 Core 接受。 */
export interface ToolUnavailableReason {
  tool: string;
  action?: string;
  operation?: string;
  reason: string;
}

export interface ToolAvailabilitySnapshot {
  /** 稀疏宿主约束：未声明的工具沿用已有合同；显式空数组禁用该工具。 */
  actions: ToolActionAllowlist;
  /** tool → action → 分支参数枚举；缺项未限制，空数组禁用整个 action。 */
  parameters?: Readonly<
    Record<string, Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>>
  >;
  unavailable?: ToolUnavailableReason[];
}

/**
 * 宿主无副作用地描述已绑定服务。会话存储由真实 scope factory 延迟创建，
 * 可用性查询只声明该工厂提供此能力，不为查询创建任何临时会话或 fake service。
 */
export interface ToolAvailabilityContext extends Partial<ToolContext> {
  sessionStoreAvailable?: boolean;
}
