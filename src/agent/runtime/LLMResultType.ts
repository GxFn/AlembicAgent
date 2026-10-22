/**
 * LLMResultType — LLM 调用结果的控制流标记
 *
 * 替代 `{ __continue: true }` 魔术值，用命名常量标记“本轮不产出结果、回到循环顶部重试”。
 *
 * 实际边界（I49 / L5-P48）：主循环只识别 CONTINUE（AgentRuntime.reactLoop 比较 `type === CONTINUE`）。
 * 早期设计保留的 TEXT / TOOL_CALLS / ERROR / FATAL 从未被分派，已随事项②“公开面收窄”删除（四处零引用）；
 * LLMResult.type 同步收窄为 `typeof LLMResultType.CONTINUE`，continueResult() 无需强转即可作为 LLMResult，
 * 返回其他 type 值在编译期报错。常量名与运行时种类（冻结对象）不变。
 *
 * 使用场景:
 *   - #callLLM() 返回值标记（空响应重试、toolChoice 违规后重试）
 *   - #handleAiError() 返回值标记（错误恢复后重试）
 *   - ReAct 循环顶部的 CONTINUE 分支判断
 *
 * @module LLMResultType
 */

export const LLMResultType = Object.freeze({
  /** 继续循环 — 空响应重试、错误恢复后重试（主循环唯一识别的值） */
  CONTINUE: 'continue',
});

/**
 * 创建 CONTINUE 类型的结果
 * @returns `{ type: 'continue' }`；主循环见到它即回到循环顶部开始下一轮
 */
export function continueResult() {
  return { type: LLMResultType.CONTINUE };
}
