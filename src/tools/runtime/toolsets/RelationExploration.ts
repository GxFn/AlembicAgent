/**
 * 关系发现.探索 — Agent 只读地检索知识条目，并用代码事实验证条目之间的语义关系。
 *
 * 这是 relations pipeline explore 阶段的专用能力（L7-P19 / C04）。此前该阶段复用
 * knowledge_production + code_analysis，两者并集里 knowledge 只有 submit：提示第 1 步硬性
 * 要求的 knowledge.search 在运行时准入就被拒，模型拿不到真实知识条目 id，只能凭代码臆造
 * 关系；同时“只读发现”阶段却握有 knowledge.submit、terminal.exec、memory.save/note_finding
 * 等写权限。本能力把边界收敛为：
 *   - knowledge: search/detail —— 检索真实条目 id/标题并读取正文；不含 submit/manage/prime
 *   - code: read/search/outline —— 验证跨条目的代码引用；不含 structure/write
 *   - graph: query —— 调用关系与继承链查询；不含 overview
 * 不开放 terminal.exec（没有命令 allowlist 需要声明）、memory（relation profile 关闭记忆，
 * note_finding/save 属于 scan/generate 管线的 QualityGate 输入）与 evidence/meta。
 * 不复用 scan_analyze：它带 terminal.exec 与记忆写入，且提示片段强制“至少提交 3 条
 * note_finding”，会污染关系探索提示。
 */

import { RuntimeCapability } from './RuntimeCapability.js';

export class RelationExploration extends RuntimeCapability {
  get name() {
    return 'relation_exploration';
  }
  get description() {
    return 'Read-only relation exploration: knowledge search/detail, code read/search/outline, graph query';
  }

  get allowedTools() {
    return {
      knowledge: ['search', 'detail'],
      code: ['read', 'search', 'outline'],
      graph: ['query'],
    };
  }

  /**
   * relations pipeline 的 explore 阶段带自己的 systemPrompt（RELATIONS_EXPLORE_PROMPT），
   * AgentRuntime 以 systemPromptOverride 整体替换系统提示，此片段不会追加到该阶段；
   * 它服务于不经 pipeline 阶段、直接以本能力组装提示的运行（SystemPromptBuilder.build）。
   */
  get promptFragment() {
    return `## 关系探索能力
你是知识图谱架构师，只读地探索知识库中的知识条目，并用代码事实验证条目之间的语义关系。

工作流:
1. knowledge.search 按分类/关键词检索知识条目，记录每条结果的 id（UUID）与标题
2. knowledge.detail 读取候选条目的正文、触发条件与引用代码
3. code.search / code.read / code.outline 与 graph.query 验证跨条目的代码引用关系
4. 以 "[id:UUID] FromTitle → [id:UUID] ToTitle (type): evidence" 的结构化文本记录发现

关键规则:
- 本阶段只读：不新建或修改知识、不执行终端命令、不写入记忆
- 每条关系必须有明确的代码证据（文件名 + 代码片段）；不要臆造不存在的关系
- 优先引用 knowledge.search / knowledge.detail 返回的真实 id；标题不得改写或截断

${super.promptFragment}`;
  }
}
