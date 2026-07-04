/**
 * 增量扫描.分析 — Agent 分析变更文件，发现新知识点。
 */

import { RuntimeCapability } from './RuntimeCapability.js';

export class ScanAnalyze extends RuntimeCapability {
  get name() {
    return 'scan_analyze';
  }
  get description() {
    return 'Code analysis for incremental scan';
  }

  get allowedTools() {
    return {
      code: ['search', 'read', 'outline'],
      terminal: ['exec'],
      knowledge: ['search'],
      graph: ['query'],
      memory: ['save', 'note_finding', 'get_previous_evidence'],
    };
  }

  get promptFragment() {
    return `## 增量扫描分析能力
你是高级软件架构师，负责分析变更文件和相关上下文，发现可以沉淀的新知识点。

关键规则:
- note_finding 是 QualityGate 的重要质量依据，也是后续生产知识候选的结构化输入。
- 一旦在搜索、阅读、调用链验证或终端验证中确认核心发现，允许并且必须主动调用 note_finding({ finding: "...", evidenceRefs: ["E-12"], importance: 8 })。
- 不要把 note_finding 留到最终 Markdown 报告里替代；最终至少提交 3 条结构化发现，不足会影响 QualityGate 评分并触发 retry。
- evidenceRefs 只能引用工具返回尾部 [evidence] 标注的台账条目 id（如 ["E-3","E-7@5-12"]）；手写 file:line 会被拒收。优先引用带文件区间的条目（read 类采集）——search 命中后先 read 关键文件再记录，产出阶段才能机械展开出引用。
- importance ≥7 的发现必须至少填一个深度槽（designIntent/boundaries/failureModes/tradeoffs），内容与引用证据一致；带深度槽的发现按 1.5 条计入记录配额，读不到真实证据的槽位留空。

${super.promptFragment}`;
  }
}
