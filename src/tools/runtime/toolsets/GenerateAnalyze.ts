/**
 * 冷启动.分析 — Agent 分析项目源码，提取结构化发现。
 */

import { RuntimeCapability } from './RuntimeCapability.js';

export class GenerateAnalyze extends RuntimeCapability {
  get name() {
    return 'code_analysis';
  }
  get description() {
    return 'Code analysis: search, read, outline, structure, graph, terminal';
  }

  get allowedTools() {
    return {
      code: ['search', 'read', 'outline', 'structure'],
      terminal: ['exec'],
      graph: ['overview', 'query'],
      memory: ['save', 'recall', 'note_finding', 'get_previous_evidence'],
      // E4：证据台账只读取回——查已采证据不是探索，RECORD 相仍可用
      evidence: ['get', 'search'],
      meta: ['plan'],
    };
  }

  get promptFragment() {
    return `## 代码分析能力
你是高级软件架构师，负责深度分析项目代码结构。

分析策略:
| 阶段 | 目标 |
|------|------|
| 全局扫描 | graph.overview + code.structure 获取项目概览 |
| 结构化探索 | graph.query + code.search 批量搜索关键模式 |
| 深度验证 | code.read 阅读关键实现 |
| 结构化记录 | note_finding 记录关键发现（含证据和重要性评分），这是 QualityGate 重要质量依据和硬性步骤 |

关键规则:
- 批量搜索: code.search({ patterns: [...] })
- 大文件自动返回 outline，需要时用 startLine/endLine 读取
- 不要重复搜索相同关键词
- 调用关系优先用 graph.query(type: "callers")
- 每发现重要模式/问题，立即调用 note_finding({ finding: "...", evidenceRefs: ["E-12"], importance: 8 })——evidenceRefs 引用工具返回尾部 [evidence] 标注的台账条目 id，手写 file:line 会被拒收；优先引用带文件区间的条目（read 类采集，search 命中后先 read 关键文件再记录）；允许在全局扫描、结构化探索、深度验证阶段就主动提交，不要等到总结阶段
- importance ≥7 的发现必须至少填一个深度槽（designIntent/boundaries/failureModes/tradeoffs——为什么这样设计/边界在哪/越界会怎样/换来了什么），内容与引用证据一致，按 1.5 条计入配额；读不到真实证据的槽位留空
- 输出最终报告前，必须确认核心发现已经通过 note_finding 写入；最终 Markdown 不能替代该工具调用；缺少或不足会直接影响 QualityGate 评分并触发 retry；RECORD 阶段只允许补写 note_finding，SUMMARIZE 阶段会停止所有工具
- 搜索前先用 memory({ action: "get_previous_evidence", params: { query: "类名/文件名" } }) 检查前序维度是否已有发现

${super.promptFragment}`;
  }
}
