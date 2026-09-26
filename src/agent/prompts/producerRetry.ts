import { hasPersistedCandidate, isKnowledgeSubmit } from '../utils/toolOutcomes.js';

/** Scan 与 insight 的提交修复共用真实回执和字段合同；不改变各自工具权限与重试预算。 */
export function buildProducerRetryPrompt(source?: { toolCalls?: readonly unknown[] }): string {
  const rejected = (source?.toolCalls || []).filter(
    (call) => isKnowledgeSubmit(call) && !hasPersistedCandidate(call)
  ).length;
  return `你的 ${rejected} 个提交被拒绝了。请根据拒绝原因改进后重新提交，确保:
1. content 必须是对象: { markdown: "...", rationale: "...", pattern: "..." }
2. content.markdown 字段 ≥ 200 字符，含代码块 (\`\`\`)
3. content.rationale 必填 — 设计原理说明（为什么这样设计）
4. 台账在场时 params.reasoning.evidenceRefs 必填，引用真实 E-id；无台账时按当前 schema 提供 reasoning.sources 与真实路径、行号
5. 标题使用项目真实类名，不以项目名开头
6. description 中文简述 ≤80 字，引用真实类名
7. 必填: title、description、trigger (@kebab-case)、kind (rule/pattern/fact)、doClause (英文祈使句)`;
}
