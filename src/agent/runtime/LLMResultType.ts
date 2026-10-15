/**
 * LLMResultType — LLM 调用结果的控制流标记
 *
 * 替代 `{ __continue: true }` 魔术值，用命名常量标记“本轮不产出结果、回到循环顶部重试”。
 *
 * 实际边界（I49）：主循环只识别 CONTINUE（AgentRuntime.reactLoop 比较 `type === CONTINUE`）；
 * TEXT / TOOL_CALLS / ERROR / FATAL 是早期设计保留的公开值，运行时不按它们分派——
 * 返回 `{ type: 'fatal' }` 不会让循环退出，而是按普通 LLM 结果处理。LLMResult.type 仍是 string，
 * continueResult() 在调用点强转为 LLMResult，编译器不会检查 type 取值，分派只靠运行时比较。
 * 非 CONTINUE 成员已标为废弃（deprecated 标签），随待决事项②“公开面收窄”删除并把 type 收紧为字面量。
 *
 * 使用场景:
 *   - #callLLM() 返回值标记（空响应重试）
 *   - #handleAiError() 返回值标记（错误恢复后重试）
 *   - ReAct 循环顶部的 CONTINUE 分支判断
 *
 * @module LLMResultType
 */

export const LLMResultType = Object.freeze({
  /** 继续循环 — 空响应重试、错误恢复后重试（主循环唯一识别的值） */
  CONTINUE: 'continue',
  /** @deprecated 保留值：文本响应。主循环不按此值分派；随事项②删除。 */
  TEXT: 'text',
  /** @deprecated 保留值：工具调用。主循环不按此值分派；随事项②删除。 */
  TOOL_CALLS: 'tool_calls',
  /** @deprecated 保留值：可恢复错误。主循环不按此值分派；随事项②删除。 */
  ERROR: 'error',
  /** @deprecated 保留值：不可恢复错误。主循环不会因此值退出；随事项②删除。 */
  FATAL: 'fatal',
});

/**
 * 创建 CONTINUE 类型的结果
 * @returns `{ type: 'continue' }`；主循环见到它即回到循环顶部开始下一轮
 */
export function continueResult() {
  return { type: LLMResultType.CONTINUE };
}
