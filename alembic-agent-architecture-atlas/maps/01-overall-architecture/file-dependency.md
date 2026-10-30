---
schemaVersion: 1
diagramId: 01-overall-architecture-imports
topic: "01"
title: 总体边界与公开入口 · 直接依赖
viewType: file-dependency
truthKind: in-progress-worktree
reviewDepth: L1
verifiedAt: 2026-10-23
baselineCommit: 37bdc7f7b6dc6e0fcc12b95de1dfa5251848b0b0
documentationOwner: AlembicAgent 架构文档维护者
sourcePaths:
  - src/agent/coordination/AgentRunCoordinator.ts
  - src/agent/profiles/AgentProfileCompiler.ts
  - src/agent/profiles/AgentProfileRegistry.ts
  - src/agent/profiles/AgentStageFactoryRegistry.ts
  - src/agent/runs/index.ts
  - src/agent/runtime/AgentInterfaceContract.ts
  - src/agent/runtime/AgentRuntimeBoundary.ts
  - src/agent/runtime/AgentRuntimeResponsibility.ts
  - src/agent/service/index.ts
  - src/tools/kernel/index.ts
testPaths: []
contractPaths: []
refreshTriggers:
  - package.json
  - tsconfig.json
sourceFingerprint: sha256:9a355c459bf8ec3d23661622f98662cc95fde018bf9049b4d35d06960dd84f2e
testEvidence: anchored
externalContracts:
  - "@alembic/core：公开包端口，本图不递归扫描其实现；宿主装配只核对本仓契约。"
reviewRecord: evidence/readings.json
generatedBy: AST
---

# 总体边界与公开入口 · 精选直接依赖

[职责与边界](overview.md) · [真实调用](call-flow.md)

选取本专题入口的最多8条直接依赖；完整库存可在阅读器「文件与依赖」查看。以仓库全路径为节点身份，同名文件不会合并。Core／Node／第三方包只在完整探索器的外部边界出现。

## 静态依赖 1

```mermaid
flowchart TB
  accTitle: 静态依赖 1
  accDescr: 这是文件直接导入，不是函数调用图；类型边不表示运行时执行。
  n0["AgentRuntimeBoundary.ts"]
  n1["AgentRuntimeResponsibility.ts"]
  n2["AgentInterfaceContract.ts"]
  n3["kernel/index.ts"]
  n4["service/index.ts"]
  n5["AgentRunCoordinator.ts"]
  n0 -->|"E-T01-D1-01 直接导入"| n1
  n2 -->|"E-T01-D1-02 类型依赖"| n0
  n2 -->|"E-T01-D1-03 直接导入"| n3
  n4 -->|"E-T01-D1-04 再导出"| n5
```

### 本图术语说明

| 术语／节点 | 含义与范围 |
| --- | --- |
| AgentRuntimeBoundary.ts | `src/agent/runtime/AgentRuntimeBoundary.ts`；文件直接依赖，箭头不表示执行先后。 |
| AgentRuntimeResponsibility.ts | `src/agent/runtime/AgentRuntimeResponsibility.ts`；文件直接依赖，箭头不表示执行先后。 |
| AgentInterfaceContract.ts | `src/agent/runtime/AgentInterfaceContract.ts`；文件直接依赖，箭头不表示执行先后。 |
| kernel/index.ts | `src/tools/kernel/index.ts`；文件直接依赖，箭头不表示执行先后。 |
| service/index.ts | `src/agent/service/index.ts`；文件直接依赖，箭头不表示执行先后。 |
| AgentRunCoordinator.ts | `src/agent/coordination/AgentRunCoordinator.ts`；文件直接依赖，箭头不表示执行先后。 |

| 编号 | 代码依据 | 测试依据 | 关系与可证明范围 |
| --- | --- | --- | --- |
| E-T01-D1-01 | `src/agent/runtime/AgentRuntimeBoundary.ts` → `src/agent/runtime/AgentRuntimeResponsibility.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ./AgentRuntimeResponsibility.js；第 1 行，kind=import，typeOnly=true。只证明结构关系。 |
| E-T01-D1-02 | `src/agent/runtime/AgentInterfaceContract.ts` → `src/agent/runtime/AgentRuntimeBoundary.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ./AgentRuntimeBoundary.js；第 14 行，kind=import，typeOnly=true。只证明结构关系。 |
| E-T01-D1-03 | `src/agent/runtime/AgentInterfaceContract.ts` → `src/tools/kernel/index.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 #tools/kernel/index.js；第 8 行，kind=import，typeOnly=false。只证明结构关系。 |
| E-T01-D1-04 | `src/agent/service/index.ts` → `src/agent/coordination/AgentRunCoordinator.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ../coordination/AgentRunCoordinator.js；第 1 行，kind=re-export，typeOnly=false。只证明结构关系。 |

## 静态依赖 2

```mermaid
flowchart TB
  accTitle: 静态依赖 2
  accDescr: 这是文件直接导入，不是函数调用图；类型边不表示运行时执行。
  n0["service/index.ts"]
  n1["AgentProfileCompiler.ts"]
  n2["AgentProfileRegistry.ts"]
  n3["AgentStageFactoryRegistry.ts"]
  n4["runs/index.ts"]
  n0 -->|"E-T01-D2-01 再导出"| n1
  n0 -->|"E-T01-D2-02 再导出"| n2
  n0 -->|"E-T01-D2-03 再导出"| n3
  n0 -->|"E-T01-D2-04 再导出"| n4
```

### 本图术语说明

| 术语／节点 | 含义与范围 |
| --- | --- |
| service/index.ts | `src/agent/service/index.ts`；文件直接依赖，箭头不表示执行先后。 |
| AgentProfileCompiler.ts | `src/agent/profiles/AgentProfileCompiler.ts`；文件直接依赖，箭头不表示执行先后。 |
| AgentProfileRegistry.ts | `src/agent/profiles/AgentProfileRegistry.ts`；文件直接依赖，箭头不表示执行先后。 |
| AgentStageFactoryRegistry.ts | `src/agent/profiles/AgentStageFactoryRegistry.ts`；文件直接依赖，箭头不表示执行先后。 |
| runs/index.ts | `src/agent/runs/index.ts`；文件直接依赖，箭头不表示执行先后。 |

| 编号 | 代码依据 | 测试依据 | 关系与可证明范围 |
| --- | --- | --- | --- |
| E-T01-D2-01 | `src/agent/service/index.ts` → `src/agent/profiles/AgentProfileCompiler.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ../profiles/AgentProfileCompiler.js；第 2 行，kind=re-export，typeOnly=false。只证明结构关系。 |
| E-T01-D2-02 | `src/agent/service/index.ts` → `src/agent/profiles/AgentProfileRegistry.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ../profiles/AgentProfileRegistry.js；第 3 行，kind=re-export，typeOnly=false。只证明结构关系。 |
| E-T01-D2-03 | `src/agent/service/index.ts` → `src/agent/profiles/AgentStageFactoryRegistry.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ../profiles/AgentStageFactoryRegistry.js；第 4 行，kind=re-export，typeOnly=false。只证明结构关系。 |
| E-T01-D2-04 | `src/agent/service/index.ts` → `src/agent/runs/index.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ../runs/index.js；第 5 行，kind=re-export，typeOnly=false。只证明结构关系。 |

本页直接依赖已对照当前AST逐边重查；沿用稳定边ID，行号按当前源码更新。导入存在不表示本轮行为已执行；实际执行见页面证据。
