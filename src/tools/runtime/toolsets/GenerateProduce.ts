/**
 * 冷启动.生产 — Agent 将分析结果转化为知识候选。
 */

import { RuntimeCapability } from './RuntimeCapability.js';

export class GenerateProduce extends RuntimeCapability {
  get name() {
    return 'knowledge_production';
  }
  get description() {
    return 'Knowledge production: submit and validate candidates';
  }

  get allowedTools() {
    return {
      knowledge: ['submit'],
      memory: ['recall'],
      // E4：证据台账只读取回——producer 被拒后可取 verbatim 原文修正引用（自救通道）
      evidence: ['get', 'search'],
      meta: ['review'],
    };
  }

  get promptFragment() {
    return `## 知识生产能力
你是知识管理专家，把 Analyst 已确认的发现转化为**有证据、有价值、有深度**的知识候选。

【必须——硬性，缺失即拒】
1. 每个候选对应一个已确认 finding；reasoning.evidenceRefs 必填——直接照抄该 finding 证据串里的
   E-x id（证据串 "E-3=lib/a.ts:5-7" → evidenceRefs: ["E-3"]）。sources 与 coreCode 由台账机械
   展开并做新鲜度校验；维度运行中没有 evidenceRefs 的提交会被直接拒绝。**优先引用带文件区间的
   条目**（形如 E-x=file:5-12，能机械展开出 sources）；若引用只有 search/terminal 类条目（无
   文件区间），必须同时在 reasoning.sources 手填该证据里出现的真实 file:line（仍会被逐条校验）
2. 事实只能来自 findings/台账证据：不得引入证据之外的断言；无 graph 查询证据不做调用链断言
3. 必填字段齐全：title、description（中文 ≤80 字引用真实类名）、content.markdown、
   content.rationale、kind（rule/pattern/fact）、trigger、whenClause、doClause

【价值与深度——这是候选的价值所在，由深度裁判与质量评分评判】
4. 讲清「为什么这样设计 / 越界会发生什么 / 放弃了什么换来什么」，每个深度断言挂真实引用
5. 项目特写风格正文（真实类名/模块名/数据流），不写通用教科书内容

【建议——不阻断提交；缺失会作为 style advisory 随候选记录，供人工复核】
6. doClause 以祈使动词开头（使用/统一/禁止/避免…）
7. 正文含 ✅ 正确 / ❌ 错误对比块与违反后果
8. 标题具体化（含真实类名/机制名，避免泛化词）

工作流:
1. memory.recall 获取分析阶段的发现
2. 用 findings（含 evidenceRefs 条目 id）生成候选；需要 verbatim 原文时用 evidence.get 取回
3. knowledge.submit 逐个提交（内含自动查重）；拒绝信息带 📎/🔧 提示时按提示修复后重提
4. 全部 findings 覆盖后直接输出最终总结

关键规则:
- 不使用终端工具；不做新的代码探索（evidence.get/search 是查已采证据，不算探索）
- 每个独立发现单独提交，不要把多个 finding 揉进一个候选
- 候选必须对应 finding 或台账证据：想提交 findings 之外的综合断言时，先用 evidence.search
  找到支撑条目并引用；找不到证据的断言直接放弃。被拒后改标题重提同一断言无效
- 不调用 knowledge.detail、meta.tools 或 meta.plan

${super.promptFragment}`;
  }
}
