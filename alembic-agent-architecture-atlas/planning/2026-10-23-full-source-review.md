# 原53个局部复核源码的全文审阅

状态：**全文审阅与Atlas验收已完成**。新快照：`agent-atlas-2026-10-23-v6`。

用户授权：逐个深入审阅剩余53个局部复核文件，补失败分支及图谱证据；仅修改Agent独立Atlas，保留现有产品改动和旧快照。基线为 `agent-atlas-2026-10-23-v5`，产品HEAD为 `37bdc7f7b6dc6e0fcc12b95de1dfa5251848b0b0`。

## 读取与证据口径

本轮重新读取53份当前全文，含所有未变化段落，不把上轮delta升级为“已通读”。共33,370库存行、323连续语义段、209条分支说明；行数按Atlas的split换行口径计入53个EOF空行。完整记录见[源码复核证据](../evidence/reviews/source-full-v6.json)。

| 分组 | 文件 | 库存行 | 新正文 |
| --- | ---: | ---: | --- |
| 记忆与上下文 | 15 | 10,613 | [全文说明](../maps/07-memory-context/full-source-review.md) |
| 工具处理器 | 2 | 8,779 | [全文说明](../maps/06-tool-execution/full-source-review.md) |
| Runtime与PCV | 15 | 8,883 | [全文说明](../maps/03-runtime-lifecycle/full-source-review.md) |
| 策略、预算、状态与诊断 | 10 | 3,205 | [全文说明](../maps/03-runtime-lifecycle/full-policy-review.md) |
| Profile与宿主装配 | 11 | 1,890 | [全文说明](../maps/02-service-orchestration/full-profile-review.md) |

209条分支中169条有已定位的相应断言，40条没有针对性验证或只有相邻用例。这里的数量不是AST分支覆盖率，不将全文阅读等同全部行为通过。新的分段校验拒绝缺文件、重复路径、来源漂移、区间缺口/重叠、空说明和伪造的断言定位，但机械连续性本身不能替代语义审阅。

其余237份源码只在字节与v5相同时继承原全文/累计全文记录。本轮没有重新通读这些文件；测试/脚本/配置仍保留实际partial/indexed状态。

## 本轮补清的边界

- 观察条目上限不等于完整轮次上限；ContextWindow保尾与provider-input预算仍可能超过目标值。
- SessionStore缺失evidenceStore才重建，显式空对象保持空；dispose不形成永久closed状态，快照不能代替宿主持久化。
- 运行期phase与独立AgentState不同；独立类的action/listener失败可能发生在phase/data或history已提交之后。
- 压缩预算和退出预算分属不同控制器；L4回调/日志错误可发生在已压缩、已计费之后，不能一律按零副作用解释。
- RECORD的广告schema、SDK返回校验、基础能力白名单和阶段门是不同层，单个门的兼容动作不证明整链放行。
- evidenceCapture后置统计异常可能让落账事实与persisted诊断不同；PCV内存侧表与候选引用不证明持久化或模型可见证据消费。
- code.write freshness检查不是原子CAS；terminal静态识别不读取脚本实际内容，sandboxed缺省值也不能证明OS隔离。
- QualityGatePolicy不是Pipeline质量门；描述性profile字段、额外工具列表与实际能力/宿主准入分别解释。

这些发现只落实为Atlas说明、证据和明确缺口，没有修复产品代码。

## 验证与留档

基线check:current及94图旧回执复验通过。扩展既有执行计划后，本轮36组、496次用例执行通过；76组旧记录的输入及harness匹配而复用。当前112组共1379次通过是当前报告集合，不把复用称作本轮新执行。

最终命令、实际浏览器渲染、范围SHA及新快照身份见[验证记录](../evidence/iterations/v6-full-validation.json)。57项Atlas自有测试、103图实际渲染、63页当前来源检查及构建全部通过；新v6历史视图确认可读。569个产品文件、原6份快照和18张旧PNG的SHA保持，本轮只增加1张阅读器截图。所有旧快照只读保留；不提交、不推送、不发布，因为用户未请求这些操作。

## 明确保留的验证缺口

40项逐项保留在结构化记录及五个正文的失败表中。代表项包括：非空但全无效候选先清旧代、跨JSONL/index文件一致性、scope释放挂起、L4 try外畸形输入、后置统计已落账却报零、状态回调提交后的异常、静态命令无法识别脚本真实行为、挂起compressor/audit等。

后续若要验证这些缺口，应分别设计受控故障注入，保持来源、断言与运行身份独立；若需要产品修复，应另行取得明确范围。真实AI、生产宿主、OS隔离和Core内部验收均不在本次通过范围。
