---
schemaVersion: 1
diagramId: 01-core-consumption
topic: "01"
title: Agent 的 Core 消费边界
viewType: guide
truthKind: in-progress-worktree
reviewDepth: L1
verifiedAt: 2026-10-23
baselineCommit: 37bdc7f7b6dc6e0fcc12b95de1dfa5251848b0b0
documentationOwner: AlembicAgent 架构文档维护者
sourcePaths:
  - src/**/*.ts
  - src/agent/context/ContextWindow.ts
  - src/agent/context/ConversationStore.ts
  - src/agent/context/ExplorationTracker.ts
  - src/agent/evaluation/DurableSemanticReviewRuntime.ts
  - src/agent/evaluation/InvestigatedEmptyReviewer.ts
  - src/agent/evaluation/qualityGates.ts
  - src/agent/evidence/ProductionEvidenceLedgerAuthority.ts
  - src/agent/evidence/loopLedger.ts
  - src/agent/memory/MemoryConsolidator.ts
  - src/agent/memory/MemoryRetriever.ts
  - src/agent/memory/MemoryStore.ts
  - src/agent/memory/SessionStore.ts
  - src/agent/profiles/definitions/plan.profile.ts
  - src/agent/prompts/insightAnalyst.ts
  - src/agent/runs/evolution/EvolutionAgentRun.ts
  - src/agent/runs/plan/PlanAgentRun.ts
  - src/agent/runtime/AgentInterfaceContract.ts
  - src/ai/AiProvider.ts
  - src/tools/runtime/handlers/knowledge/contracts.ts
  - src/tools/runtime/handlers/knowledge/management.ts
  - src/tools/runtime/handlers/recipeProductionAdapter.ts
testPaths: []
contractPaths:
  - config/core-import-boundary.json
refreshTriggers:
  - package.json
  - tsconfig.json
sourceFingerprint: sha256:1a81113d6d6a21d404747512c7ef2ef6c7237efec03ad629c9f1b7c4ee199bd1
testEvidence: anchored
externalContracts:
  - Core 仅以公开包合同或宿主注入端口出现；此页不复制、审阅或验收 Core 内部实现。
reviewRecord: evidence/scoped-execution.json
generatedBy: mixed
---

# Agent 如何消费 Core

本页只索引 Agent 源码中的外部包引用与接缝，不递归收集 Core 内部文件。已只读参考“Review AlembicCore architecture”的知识持久化/恢复/serving分层方法；这里的结论仍取自 Agent 的输入、调用与回执，不继承 Core 窗口的测试通过或治理结论。

[公开入口与宿主接线](public-api-and-hosts.md) · [知识结果解释](../08-evidence-knowledge/overview.md)

## 当前源码的外部 facade 引用

| Core facade | 源码导入语句数 | 其中纯类型 | Agent 导入点示例 |
| --- | --- | --- | --- |
| `@alembic/core` | 2 | 1 | `src/tools/runtime/handlers/knowledge/contracts.ts`；`src/tools/runtime/handlers/recipeProductionAdapter.ts` |
| `@alembic/core/dimensions` | 3 | 0 | `src/agent/evidence/loopLedger.ts`；`src/agent/prompts/insightAnalyst.ts` |
| `@alembic/core/events` | 1 | 1 | `src/agent/memory/SessionStore.ts` |
| `@alembic/core/evolution` | 1 | 1 | `src/agent/runs/evolution/EvolutionAgentRun.ts` |
| `@alembic/core/host-agent-workflows` | 3 | 0 | `src/agent/evaluation/DurableSemanticReviewRuntime.ts`；`src/agent/evidence/ProductionEvidenceLedgerAuthority.ts` |
| `@alembic/core/io` | 3 | 2 | `src/agent/context/ConversationStore.ts`；`src/agent/memory/MemoryConsolidator.ts` |
| `@alembic/core/knowledge` | 16 | 2 | `src/agent/evaluation/DurableSemanticReviewRuntime.ts`；`src/agent/evaluation/qualityGates.ts` |
| `@alembic/core/logging` | 90 | 0 | `src/agent/context/ContextWindow.ts`；`src/agent/context/ConversationStore.ts` |
| `@alembic/core/memory` | 1 | 0 | `src/agent/memory/MemoryStore.ts` |
| `@alembic/core/plans` | 2 | 0 | `src/agent/profiles/definitions/plan.profile.ts`；`src/agent/runs/plan/PlanAgentRun.ts` |
| `@alembic/core/production` | 9 | 2 | `src/agent/evaluation/DurableSemanticReviewRuntime.ts`；`src/agent/evaluation/InvestigatedEmptyReviewer.ts` |
| `@alembic/core/project-context-foundation` | 1 | 0 | `src/agent/runs/plan/PlanAgentRun.ts` |
| `@alembic/core/search` | 3 | 0 | `src/agent/memory/MemoryRetriever.ts`；`src/agent/memory/MemoryStore.ts` |
| `@alembic/core/shared` | 1 | 0 | `src/agent/runtime/AgentInterfaceContract.ts` |
| `@alembic/core/sustain` | 1 | 1 | `src/tools/runtime/handlers/knowledge/management.ts` |

合计 137 条源码导入语句、15 个 facade；本次按Agent当前src的TypeScript AST重新计数，属于静态结构事实。重复导入语句各计一次，类型导入与混合导入分开分类。产品Core boundary扫描还包含test/scripts，检查结果必须看匹配当前输入的页面证据，不能沿用历史521文件/287引用的通过声明。

## 四条责任线

| 接缝 | Agent 负责 | Core／宿主负责 | 本页不能推出的结论 |
| --- | --- | --- | --- |
| knowledge.submit | 证据 refs 展开、新鲜度、输入准备、取消与结果投影 | 注入的 RecipeProductionPort 创建/暂存及 readiness | created 不表示 ready 或 published；当前组合样板是 fake gateway。 |
| Plan | 模型输入、无工具循环、有界语义修复、调用校验 | Core 公开阶段规则；strict validateReceipt 的宿主事实权威 | JSON 合法不代表真实项目计划适用或宿主已封印。 |
| Strict/durable review | Agent 认知、证据读取、受控 provider 调用、attestation 接入 | Core 的绑定/签名裁决；宿主可信密钥和权威注入 | 不能把 durable 这条路径的通过用于掩盖旧 G2 身份/裁决缺口。 |
| Memory与I/O基础能力 | scope、召回/固化策略、上下文压缩与工具编排 | 公共 schema/事件/I/O 等基础合同，宿主持久位置与权限；SessionStore checkpoint不再是当前接缝 | 导入 Core 不等于 Agent 已有实际 DB、OS 沙箱或发布权限。 |

定位：`src/tools/runtime/handlers/knowledge/contracts.ts#RecipeGatewayLike`；`src/agent/runs/plan/PlanAgentRun.ts#runStrictPlanAgent`；`src/agent/evaluation/DurableSemanticReviewRuntime.ts#createDurableSemanticReviewRuntime`；`src/agent/memory/MemoryStore.ts#MemoryStore`。

## 检查与停止点

`config/core-import-boundary.json` 仍由原始产品边界检查消费；其冻结 referenceLimits 不是本页的实时计数，也不由图谱自动更新。新增引用是否允许，以正式 Core policy 与该扫描器结果判断。

本页仅重算Agent源码引用并复核调用合同；Agent消费边界检查的实际执行见页面证据，不据此声明Core build/test通过。若需要改变 Core 行为，应把所需公开合同交给 Core 窗口；本图谱不会补一个 Agent 内部持久化副本来绕开边界。
