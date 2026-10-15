/**
 * scanPrompts.ts — scanKnowledge 任务 Produce 阶段文本配置
 *
 * W6-d(A1)拆分:统一管线工厂 buildScanPipelineStages(拆前 :186)、
 * buildRelationsPipelineStages(拆前 :492)及其私有 helper
 * (buildScanProducerPrompt 拆前 :346、RELATIONS_* 两条 prompt 拆前 :431,:458、
 * 局部类型拆前 :23-68)已迁往 ../evaluation/stageBuilders.ts。
 * 本文件只保留纯文本任务配置 SCAN_TASK_CONFIGS。
 *
 * L6-P23（C59）：knowledge.submit 字段清单与软硬门禁分级不再在这里手写，统一拼接
 * ./producerRetry.ts 的共享合同（字段说明取自 Core describeSubmitToolFields），与冷启动
 * Producer、拒绝重试提示逐字一致；本文件只保留 scan 自己的任务语义与工作流程。
 *
 * @module scanPrompts
 */

import { RECIPE_PRODUCTION_PROFILE_PROMPT } from '../../tools/runtime/recipeProductionContract.js';
import {
  PRODUCER_SUBMIT_FIELD_CONTRACT,
  PRODUCER_SUBMIT_HARD_GATES,
  PRODUCER_SUBMIT_STYLE_ADVISORIES,
} from './producerRetry.js';

/**
 * scan 两个任务共用的提交合同段：硬门 / 风格建议分级 + 字段清单。scan 在 dimensionScopeId=scan:<label>
 * 下按 cold-start 档位过门禁（3 文件下限、path:start-end 来源都生效），提示必须让模型事先知道，
 * 而不是靠拒绝消息反推。共享段不含 insight 的「不补读源码」限制，scan 的 code.read 补读权限不变。
 */
const SCAN_SUBMIT_CONTRACT = [
  PRODUCER_SUBMIT_HARD_GATES,
  PRODUCER_SUBMIT_STYLE_ADVISORIES,
  PRODUCER_SUBMIT_FIELD_CONTRACT,
].join('\n\n');

/**
 * task → Produce 阶段配置 (extract + summarize)
 *
 * 两种 task 均为工具驱动 (knowledge)，Recipe 格式与冷启动 knowledge 对齐:
 * - extract: 多文件 target 扫描 → 多个 Recipe
 * - summarize: 单文件/代码片段 → 1~2 个 Recipe
 *
 * analyzeMaxIterations 是 Analyze 阶段迭代上限的单一来源（L8-C02）：scanPipeline 阶段工厂用它写
 * analyze 阶段预算，ScanAgentRun 用它写 systemRunContext 的 tracker 预算。两处此前各自硬编码 12/24，
 * 只改一处就会让 tracker 预算与阶段预算错位（tracker 提前进入总结阶段）。
 */
export const SCAN_TASK_CONFIGS = {
  // ─── extract: Recipe 提取（工具驱动，与冷启动 knowledge 字段对齐） ─────

  extract: {
    producePrompt: `你是知识管理专家。你会收到一段代码分析文本，需要将其中的知识点转化为结构化的知识候选。

核心原则: 候选义务仅来自 Analyst 已确认的结构化发现，分析文本是解释背景，你的唯一工作是将它们格式化为 knowledge({ action: "submit" }) 调用。

每个候选必须:
1. 有清晰的标题 (描述知识点的核心，使用项目真实类名，不以项目名开头)
2. 有项目特写风格的正文 (content.markdown 字段，结合代码展示)
3. 标注相关文件的完整相对路径 + 行区间 (reasoning.sources，如 ["Packages/ModuleName/Sources/.../FileName.swift:42-58"]；裸路径会被门禁拒绝)
4. 选择正确的 kind (rule/pattern/fact)
5. 按下方 knowledge.submit 字段合同填写全部必填交付字段 (trigger、whenClause、doClause、dontClause 等)
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
- 本扫描阶段可用 code.read 读取已定位文件；不新增代码搜索、图谱或终端探索。evidence.get/search 只读已采证据台账、不算探索：提交被拒时用 evidence.search 查条目 id、evidence.get 取 verbatim 原文，修正 evidenceRefs 后重提
- 台账在场时 params.reasoning.evidenceRefs 必填，使用真实 E-id；无台账按当前 schema 提供真实来源，禁止只写文件名
- content.markdown 中的来源标注必须使用完整相对路径: (来源: Full/Path/FileName.ext:行号)
- 如果分析提到了 3 个模式，就应该提交 3 个候选，不要合并
- 禁止: 不要搜索新文件、不要做额外分析，专注于格式化和提交
- 【跨维度去重】每条候选必须聚焦当前维度独有的视角，不得将同一知识点换个说法重复提交到不同维度。宁可少提交也不要充数

容错规则:
- 证据不足时只用 code.read 补读 Analyst 已定位的文件；无法核实则列为 blocker，不编造来源，也不尝试路径变体。
- 失败或未核实的发现不能变成已确认候选；保留已成功提交的实际回执。

${SCAN_SUBMIT_CONTRACT}

${RECIPE_PRODUCTION_PROFILE_PROMPT}`,
    fallback: (label: string) => ({ targetName: label, extracted: 0, recipes: [] }),
    // 多文件扫描需要更多分析轮次。
    analyzeMaxIterations: 24,
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
- kind 选择: 单文件证据默认 kind=fact（技术事实）；只有确属该文件局部的模式/规则才用 pattern/rule，并且必须在 params 中显式声明 scope: "narrow"——rule/pattern 默认要求至少 3 个不同文件，否则会被门禁拒绝
- 来源必须指向项目内真实文件并带行区间（reasoning.sources / (来源: …) 写 path:起行-止行）；找不到真实文件来源时不编造路径，列为 blocker
- 必填字段以下方 knowledge.submit 字段合同为准（含 whenClause、dontClause、content.rationale）
- content.markdown 应包含代码块，展示核心实现

${SCAN_SUBMIT_CONTRACT}

${RECIPE_PRODUCTION_PROFILE_PROMPT}`,
    fallback: (label: string) => ({ targetName: label, extracted: 0, recipes: [] }),
    // 单文件/片段摘要只需较少分析轮次。
    analyzeMaxIterations: 12,
  },
};
