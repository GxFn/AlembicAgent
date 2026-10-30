---
schemaVersion: 1
diagramId: reading-index
topic: "00"
title: 阅读路线
viewType: guide
truthKind: in-progress-worktree
reviewDepth: L0
verifiedAt: 2026-10-23
baselineCommit: 37bdc7f7b6dc6e0fcc12b95de1dfa5251848b0b0
documentationOwner: AlembicAgent 架构文档维护者
sourcePaths: []
testPaths: []
contractPaths:
  - package.json
refreshTriggers:
  - package.json
  - tsconfig.json
sourceFingerprint: sha256:1c43e85dbee2536b018674ac306d4dd9edf9c018f4f339e29ec572c6a00c3d1a
testEvidence: anchored
externalContracts:
  - "@alembic/core：公开包端口，本图不递归扫描其实现；宿主装配只核对本仓契约。"
reviewRecord: evidence/readings.json
generatedBy: mixed
---

# AlembicAgent 架构图谱

从[一次请求到工具回执的完整时序](13-end-to-end/complete-sequence.md)开始，再进入[状态与恢复](13-end-to-end/receipt-and-recovery.md)。

## 按问题选择专题

- [01 总体边界与公开入口](01-overall-architecture/overview.md)：Agent、Core与宿主各自拥有哪一层事实？
- [02 服务装配与编排](02-service-orchestration/overview.md)：Profile怎样成为一次真实运行？
- [03 循环、预算与取消](03-runtime-lifecycle/overview.md)：工具回合怎样结束，停止后留下什么？
- [04 AI与原生协议](04-ai-protocols/overview.md)：模型请求、重试与原生续接如何保持？
- [05 工具契约与目录](05-tool-contracts/overview.md)：模型看到的schema怎样对应执行权限？
- [06 工具执行与安全](06-tool-execution/overview.md)：从调用参数到文件或沙箱，边界在哪里？
- [07 记忆、上下文与提示](07-memory-context/overview.md)：哪些信息被召回、压缩或持久化？
- [08 证据与知识提交](08-evidence-knowledge/overview.md)：E-n怎样成为可复核的知识来源？
- [09 领域任务](09-domain-runs/overview.md)：六类run如何复用内核并解释结果？
- [10 严格生产与评审](10-strict-production/overview.md)：认知、封印与Core裁决分别由谁完成？
- [11 事件、诊断与脱敏](11-observability/overview.md)：观察副本如何与业务原值分离？
- [12 构建、边界与发布](12-build-contracts/overview.md)：源码、公开包和宿主消费如何验证？
- [13 一次请求到工具回执](13-end-to-end/overview.md)：沿一条真实调用链，从输入走到结果。

[图谱规范](00-diagram-standard.md) · [逐文件阅读索引](file-index.md)


## 深入Agent功能链

- [15个公开入口与宿主接线](01-overall-architecture/public-api-and-hosts.md)
- [Agent如何消费Core](01-overall-architecture/core-consumption.md)
- [分析发现到知识候选回执](13-end-to-end/knowledge-production.md)
- [证据提交的失败与回执](08-evidence-knowledge/failure-and-receipts.md)
- [六类run的权限与结果](09-domain-runs/result-matrix.md)


## 当前深读与失败分支

- [Runtime、缓存与后处理](03-runtime-lifecycle/runtime-failure-deep-review.md)
- [阶段门与提示装配](02-service-orchestration/stage-failures-and-prompts.md)
- [终端执行与合同](06-tool-execution/terminal-failures-and-contracts.md)
- [scope与会话恢复](07-memory-context/source-review-and-recovery.md)
- [凭据检测边界](11-observability/detector-failure-boundaries.md)


## 当前基线与任务路线

- [复核与退役去向](source-rebase.md)：114 个变化／新增源码逐文件决定，176 个未变源码继承依据。
- [宿主接入路线](01-overall-architecture/public-api-and-hosts.md)：公开入口、端口、最小输入、结果与释放责任。
- [回执后观察失败](03-runtime-lifecycle/runtime-failure-deep-review.md#scenario-observer-failure)、[取消与超时](03-runtime-lifecycle/state-and-recovery.md#scenario-cancel-timeout)、[HOST 诊断](03-runtime-lifecycle/runtime-failure-deep-review.md#scenario-host-failure)。
- [创建后未就绪](13-end-to-end/knowledge-production.md#scenario-created-not-ready)、[scope 释放](03-runtime-lifecycle/runtime-failure-deep-review.md#scenario-scope-release)、[按来源脱敏](11-observability/source-policy-and-channels.md#scenario-source-policy)。

阅读器的“来源与维护”按采样报告漂移；“从故障出发”筛选这些稳定入口。旧版本缺少索引时明确显示未记录。

## 原53个局部复核文件的当前全文说明

- [Profile与宿主装配](02-service-orchestration/full-profile-review.md)：11文件，声明编译、模板、factory、Builder与系统上下文。
- [策略、预算与诊断](03-runtime-lifecycle/full-policy-review.md)：10文件，退出/压缩分工、同步状态副作用与诊断聚合。
- [Runtime与PCV](03-runtime-lifecycle/full-source-review.md)：15文件，运行边界、事件、管道回程与归属说明。
- [工具处理器](06-tool-execution/full-source-review.md)：2文件，代码读写、终端安全静态边界和失败结果。
- [记忆与上下文](07-memory-context/full-source-review.md)：15文件，投影、计划、L4、代际保存与恢复。

每个文件有连续区间和失败/恢复解释；未定位测试的分支明确保留，不以全文标记替代运行验证。
