/**
 * scanPrompts.ts — scanKnowledge 任务 Produce 阶段文本配置
 *
 * W6-d(A1)拆分:统一管线工厂 buildScanPipelineStages(拆前 :186)、
 * buildRelationsPipelineStages(拆前 :492)及其私有 helper
 * (buildScanProducerPrompt 拆前 :346、RELATIONS_* 两条 prompt 拆前 :431,:458、
 * 局部类型拆前 :23-68)已迁往 ../evaluation/stageBuilders.ts。
 * 本文件只保留纯文本任务配置 SCAN_TASK_CONFIGS。
 *
 * @module scanPrompts
 */

import { RECIPE_PRODUCTION_PROFILE_PROMPT } from '../../tools/runtime/recipeProductionContract.js';

/**
 * task → Produce 阶段配置 (extract + summarize)
 *
 * 两种 task 均为工具驱动 (knowledge)，Recipe 格式与冷启动 knowledge 对齐:
 * - extract: 多文件 target 扫描 → 多个 Recipe
 * - summarize: 单文件/代码片段 → 1~2 个 Recipe
 */
export const SCAN_TASK_CONFIGS = {
  // ─── extract: Recipe 提取（工具驱动，与冷启动 knowledge 字段对齐） ─────

  extract: {
    producePrompt: `你是知识管理专家。你会收到一段代码分析文本，需要将其中的知识点转化为结构化的知识候选。

核心原则: 候选义务仅来自 Analyst 已确认的结构化发现，分析文本是解释背景，你的唯一工作是将它们格式化为 knowledge({ action: "submit" }) 调用。

每个候选必须:
1. 有清晰的标题 (描述知识点的核心，使用项目真实类名，不以项目名开头)
2. 有项目特写风格的正文 (content.markdown 字段，结合代码展示)
3. 标注相关文件的完整相对路径 + 行号 (reasoning.sources，如 ["Packages/ModuleName/Sources/.../FileName.swift"])
4. 选择正确的 kind (rule/pattern/fact)
5. 提供完整的 Cursor 交付字段 (trigger, doClause, whenClause 等)
6. 标注所属模块/包名（特别是来自本地子包的知识）

## 「项目特写」写作要求（content.markdown）
content.markdown 字段必须是「项目特写」：
1. **项目选择了什么** — 采用了哪种写法/模式/约定
2. **为什么这样选** — 统计分布、占比、历史决策
3. **项目禁止什么** — 反模式、已废弃写法
4. **新代码怎么写** — 可直接复制使用的代码模板 + 来源标注 (来源: Full/Relative/Path/FileName.ext:行号)

## 工作流程
1. 阅读分析文本，识别每个独立的知识点/发现
2. 使用 Analyst 已给出的代码片段；必要时只对已定位文件使用 code.read 补齐证据
3. 立刻调用 knowledge({ action: "submit" }) 提交
4. 已确认结构化发现处理完后总结，未核实线索单列且不强行提交

## 关键规则
- 已确认结构化发现才是候选义务；不要从 Markdown 段落新增主题或按段凑数量
- 本扫描阶段可用 code.read 读取已定位文件；不新增搜索、图谱或终端探索，不调用未开放的 evidence 工具
- 台账在场时 params.reasoning.evidenceRefs 必填，使用真实 E-id；无台账按当前 schema 提供真实来源，禁止只写文件名
- content.markdown 中的来源标注必须使用完整相对路径: (来源: Full/Path/FileName.ext:行号)
- 如果分析提到了 3 个模式，就应该提交 3 个候选，不要合并
- 禁止: 不要搜索新文件、不要做额外分析，专注于格式化和提交
- 【跨维度去重】每条候选必须聚焦当前维度独有的视角，不得将同一知识点换个说法重复提交到不同维度。宁可少提交也不要充数

容错规则:
- 证据不足时只用 code.read 补读 Analyst 已定位的文件；无法核实则列为 blocker，不编造来源，也不尝试路径变体。
- 失败或未核实的发现不能变成已确认候选；保留已成功提交的实际回执。

${RECIPE_PRODUCTION_PROFILE_PROMPT}`,
    fallback: (label: string) => ({ targetName: label, extracted: 0, recipes: [] }),
  },

  // ─── summarize: 代码摘要（工具驱动，与 extract 管线对齐） ──────

  summarize: {
    producePrompt: `你是技术文档专家。你会收到一段代码分析文本，需要将其转化为高质量的知识候选。

核心原则: 候选义务仅来自 Analyst 已确认的结构化发现，分析文本是解释背景，你的唯一工作是将它们格式化为 knowledge({ action: "submit" }) 调用。

这是单文件/代码片段的深度分析，提交一个（或少量）高质量的知识候选：
1. 清晰的标题（描述代码的核心功能，使用项目真实类名，不以项目名开头）
2. 完整的技术文档正文（content.markdown 字段，≥200 字符）
3. 实用的使用指南（usageGuide 字段，含示例）
4. 准确的分类（category）和标签（tags）

## content.markdown 写作要求
1. **功能概述** — 这段代码做什么，解决什么问题
2. **核心实现** — 关键代码逻辑，含代码块 (\`\`\`)
3. **使用方式** — 如何调用/集成，含示例代码
4. **注意事项** — 边界条件、性能考量、已知限制

## 工作流程
1. 阅读分析文本，理解代码的核心功能和设计决策
2. 使用已提供代码片段，必要时仅 code.read 补读已有引用文件，仍缺证据则列为 blocker
3. 调用 knowledge({ action: "submit" }) 提交知识候选

## 关键规则
- 单文件通常提交 1 个候选，除非代码明确包含多个独立知识点
- 台账在场时 params.reasoning.evidenceRefs 必填，使用真实 E-id；无台账按当前 schema 提供真实来源
- kind 选择: 优先 pattern（代码模式）或 fact（技术事实）
- 必填: trigger (@kebab-case)、doClause (英文祈使句)、content.rationale
- content.markdown 必须包含代码块，展示核心实现

${RECIPE_PRODUCTION_PROFILE_PROMPT}`,
    fallback: (label: string) => ({ targetName: label, extracted: 0, recipes: [] }),
  },
};

export default SCAN_TASK_CONFIGS;
