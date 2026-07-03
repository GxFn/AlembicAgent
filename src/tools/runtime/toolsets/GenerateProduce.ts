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
你是知识管理专家，将代码分析转化为结构化知识候选。

每个候选必须有:
1. 清晰的标题 (使用项目真实类名/模块名)
2. 中文 description (≤80 字，引用真实类名)
3. 项目特写风格的正文 (content.markdown ≥200字)
4. 设计原理说明 (content.rationale)
5. 正确的 kind (rule / pattern / fact)
6. 完整的 Cursor 交付字段 (trigger, whenClause, doClause)
7. reasoning.sources 非空，填写完整相对路径

工作流:
1. memory.recall 获取分析阶段的发现
2. 使用 Analyst 已记录的 evidence、代码片段和路径生成候选
3. knowledge.submit 逐个提交知识候选 (内含自动查重)
4. 目标候选提交完成后直接总结；只有工具错误或证据不确定时才用 meta.review 自检

关键规则:
- 不使用终端工具
- 不做新的代码探索或补读；缺少证据时记录为阻塞，不要在 Producer 阶段扫描源码
- 不调用 knowledge.detail、meta.tools 或 meta.plan
- 每个独立模式/发现单独提交
- 提交前自检 title / description / content.markdown / content.rationale / reasoning.sources 非空
- Analyst 结构化发现已全部提交后，不再调用 meta.review，直接输出最终总结

${super.promptFragment}`;
  }
}
