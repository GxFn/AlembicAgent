# Strict 生产合同与管理端口

## 合同分层

`agent/production/StrictProductionPipeline.ts` 是兼容出口，保留原有运行时值与类型。实现位于 `production/strict/`：

| 模块 | 职责 | 主要依赖 |
| --- | --- | --- |
| `analysisLoop.ts` | 上下文白名单、epoch快照/推进、append-only扩展日程 | Core production、primitives |
| `analyst.ts` | population、induction、falsification、review守恒和fixpoint；跨进程重建再验证 | Core production、primitives |
| `lineage.ts` | Producer证据投影、假设血缘、因果修复节点 | analysisLoop、analyst、primitives |
| `expressions.ts` | 0/1/N表达集、前驱绑定、终态resolution与Core封印 | lineage、Core production、primitives |
| `gates.ts` | 阶段工具准入与Core typed-return适配 | Core production、primitives |
| `primitives.ts` | V1内部ID、hash、错误和深冻结 | node:crypto |

`StrictProductionStages` 装配真实阶段及宿主端口，`PipelineStrategy` 负责执行和控制路由。类型跟随其业务职责；内部模块不反向导入兼容出口。文件依赖由现有 `fileBoundaries` 强制，不增加包子路径。

Core canonicalize/create/validate仍是确定性裁决入口。读取已保存的Analyst epoch时仍重建并核对内部事实，外层hash相等不能替代Core验证。V1的本地hash编码保持原样；不能把不同排序/前缀的canonical函数当成等价工具替换。

## Gate 与快照

- G1在异步验证前后检查取消；取消后adapter不再继续读取epoch、检查新增查询或封印日程。外部port已执行的操作不因此回滚。
- 完整的epoch transition校验先于日程封印。`expansionPort.seal(expectedFinalScheduleHash?)`先生成/验证Core回执、比对预期，再写入本地sealed状态；错误预期不关闭日程。原无参调用保持。
- G2接受包含布尔`pass`字段或明确`action: pass/reject`的回执对象；真实宿主的`continue + pass:true`归一为`pass`并记录兼容日志。矛盾、未知或非布尔truthy判定失败关闭。这里只校验宿主回执形状，不替代独立review本身。
- hypothesis disposition只接受`survived`、`narrowed`、`refuted`、`unknown`。`unknown`仍使fixpoint失败，非法标签不能被当成已完成义务。
- JSON记录的深冻结遍历已冻结容器的子项，防止浅冻输入在hash封印后仍改变快照内容；共享引用使用本次调用的访问集合处理。

## 知识管理输入与结果

`knowledge.manage(update)`只允许声明的内容编辑字段。这个工具许可集合与当前Core KnowledgeService支持的内容字段对齐；生命周期、发布时间、复核状态、grace截止、统计和其他未声明字段均不能通过通用update写入。显式`undefined`也不能旁路字段检查。字段许可不替代Core服务的值对象校验、系统标签合并、retrieval profile验证或事务处理。

管理ID必须是非空字符串；score要求显式有限数值，不假设额外计分范围；evolution confidence限定0..1，缺席时保留既有默认值，非法显式输入不能被默认值覆盖。review-queue limit是正安全整数。

readiness/review-queue是可取消读取；已经发出的Core管理写入继续等待真实回执。异常结果保留Core `code`、`details`及readiness信息；写入状态区分：

| `writeState` | 含义 |
| --- | --- |
| `not-started` | 尚未发起写入，或Core明确在readiness门拒绝 |
| `unknown` | 已进入写入，但没有完整成功回执，需要读回 |
| `partial` | Core报告`STATE_DIVERGENCE`或已完成部分文件操作，需要按其details核对/修复 |

后两种结果带`requiresReadback:true`及诊断，不能声称生命周期保持不变，也不自动重试。Core的`skipped`保留为跳过并附原原因，不投影成新proposal成功。

## 宿主接入边界

当前本地Main的ToolContextFactory向`knowledgeRepo`注入原始Core repository。它的`findById`与Agent查询端口的`getById`不是同一个接口；它也不提供Agent管理口期望的`reject`、`score`、`validate`方法。原始repository的`update`不等价于KnowledgeService的受控更新。

宿主应注入明确adapter：读取方法映射到Core的读取入口与DTO；内容更新/拒绝调用已配置的KnowledgeService并提供可信服务上下文；评分和验证须连接实际拥有该能力的服务。Agent不生成替代数据库或虚构缺失实现，缺方法时返回`KNOWLEDGE_MANAGEMENT_PORT_UNAVAILABLE`，包含port/method。相关宿主接线属于Main仓库，本次未修改。

## 回归入口

- `strict-production-chain`、`strict-iterative-analysis`：真实factory、Main成功回执形状、typed Core gate、取消后的内部副作用与封印前验证。
- `strict-production-rework`：浅冻输入、合法/非法disposition、真实Core语义回执与血缘。
- `recipe-production-profile-adapter`：真实knowledge入口、受控输入、Core仓储合并、部分写入、取消和缺端口。
- `layer-contract`、公开签名及实际strict consumer：分层方向和消费者兼容。
