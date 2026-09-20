/** 知识读取只返回 DTO；仓储实体与可信调用身份由宿主 adapter 处理。 */
export interface KnowledgeReadPort {
  getById(id: string): Promise<Record<string, unknown> | null>;
}

/**
 * 普通管理动作的宿主能力面。方法可选表示宿主未提供该能力，不能据此绕过 Core 服务。
 * 已开始的写入仍等待真实回执；返回值不被 Agent 当作另一套生命周期状态机。
 */
export interface KnowledgeManagementPort {
  update?(id: string, data: Record<string, unknown>): Promise<unknown>;
  reject?(id: string, reason: string): Promise<unknown>;
  score?(id: string, score: number): Promise<unknown>;
  validate?(id: string): Promise<unknown>;
}
