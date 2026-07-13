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

核心原则: 分析文本已经包含了所有发现，你的唯一工作是将它们格式化为 knowledge({ action: "submit" }) 调用。

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
2. 用 code({ action: "read", params: { filePaths: ["Full/Path/To/FileA.swift", "Full/Path/To/FileB.swift"], maxLines: 80 } }) 批量获取关键代码片段
3. 立刻调用 knowledge({ action: "submit" }) 提交
4. 重复直到分析中的所有知识点都已提交

## 关键规则
- 分析中的每个要点/段落都应转化为至少一个候选
- code({ action: "read" }) 支持 filePaths 数组批量读取多个文件，一次调用完成
- reasoning.sources 必须是非空数组，填写文件的完整相对路径（从项目根目录开始），禁止只写文件名
- content.markdown 中的来源标注必须使用完整相对路径: (来源: Full/Path/FileName.ext:行号)
- 如果分析提到了 3 个模式，就应该提交 3 个候选，不要合并
- 禁止: 不要搜索新文件、不要做额外分析，专注于格式化和提交
- 【跨维度去重】每条候选必须聚焦当前维度独有的视角，不得将同一知识点换个说法重复提交到不同维度。宁可少提交也不要充数

容错规则:
- 如果 code({ action: "read" }) 返回"文件不存在"或错误，不要重试同一文件的其他路径变体
- 文件读取失败时，直接使用分析文本中已有的代码和描述来提交候选
- 永远不要因为文件读取失败而跳过知识点 — 分析文本已经包含足够信息
- 先提交候选，再考虑是否需要读取更多代码（提交优先于验证）

${RECIPE_PRODUCTION_PROFILE_PROMPT}`,
    fallback: (label: string) => ({ targetName: label, extracted: 0, recipes: [] }),
  },

  // ─── summarize: 代码摘要（工具驱动，与 extract 管线对齐） ──────

  summarize: {
    producePrompt: `你是技术文档专家。你会收到一段代码分析文本，需要将其转化为高质量的知识候选。

核心原则: 分析文本已经包含了所有发现，你的唯一工作是将它们格式化为 knowledge({ action: "submit" }) 调用。

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
2. 如需验证细节，用 code({ action: "read" }) 获取代码片段
3. 调用 knowledge({ action: "submit" }) 提交知识候选

## 关键规则
- 单文件通常提交 1 个候选，除非代码明确包含多个独立知识点
- reasoning.sources 必须是非空数组，填写源文件路径
- kind 选择: 优先 pattern（代码模式）或 fact（技术事实）
- 必填: trigger (@kebab-case)、doClause (英文祈使句)、content.rationale
- content.markdown 必须包含代码块，展示核心实现

${RECIPE_PRODUCTION_PROFILE_PROMPT}`,
    fallback: (label: string) => ({ targetName: label, extracted: 0, recipes: [] }),
  },
};

export default SCAN_TASK_CONFIGS;
