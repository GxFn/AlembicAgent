---
schemaVersion: 1
diagramId: 06-tool-execution-imports
topic: "06"
title: 工具执行与安全 · 直接依赖
viewType: file-dependency
truthKind: in-progress-worktree
reviewDepth: L1
verifiedAt: 2026-10-23
baselineCommit: 37bdc7f7b6dc6e0fcc12b95de1dfa5251848b0b0
documentationOwner: AlembicAgent 架构文档维护者
sourcePaths:
  - src/agent/policies/Policy.ts
  - src/agent/policies/SafetyPolicy.ts
  - src/agent/runtime/toolPipeline/accessGates.ts
  - src/shared/projectPath.ts
  - src/tools/runtime/handlers/code.ts
  - src/tools/runtime/handlers/searchCacheGeneration.ts
  - src/tools/runtime/handlers/terminal.ts
  - src/tools/runtime/handlers/terminalSafety.ts
testPaths: []
contractPaths: []
refreshTriggers:
  - package.json
  - tsconfig.json
sourceFingerprint: sha256:f615a9b5c71381d2017a2247ea2332bb6bdf330fc09f917f1a35068476245b5b
testEvidence: anchored
externalContracts:
  - "@alembic/core：公开包端口，本图不递归扫描其实现；宿主装配只核对本仓契约。"
reviewRecord: evidence/readings.json
generatedBy: AST
---

# 工具执行与安全 · 精选直接依赖

[职责与边界](overview.md) · [真实调用](call-flow.md) · [当前全文与失败审阅](full-source-review.md)

选取本专题入口的最多8条直接依赖；完整库存可在阅读器「文件与依赖」查看。以仓库全路径为节点身份，同名文件不会合并。Core／Node／第三方包只在完整探索器的外部边界出现。

## 静态依赖 1

```mermaid
flowchart TB
  accTitle: 静态依赖 1
  accDescr: 这是文件直接导入，不是函数调用图；类型边不表示运行时执行。
  n0["SafetyPolicy.ts"]
  n1["terminalSafety.ts"]
  n2["accessGates.ts"]
  n3["code.ts"]
  n4["projectPath.ts"]
  n5["searchCacheGeneration.ts"]
  n0 -->|"E-T06-D1-01 直接导入"| n1
  n2 -->|"E-T06-D1-02 直接导入"| n1
  n3 -->|"E-T06-D1-03 直接导入"| n4
  n3 -->|"E-T06-D1-04 直接导入"| n5
```

### 本图术语说明

| 术语／节点 | 含义与范围 |
| --- | --- |
| SafetyPolicy.ts | `src/agent/policies/SafetyPolicy.ts`；文件直接依赖，箭头不表示执行先后。 |
| terminalSafety.ts | `src/tools/runtime/handlers/terminalSafety.ts`；文件直接依赖，箭头不表示执行先后。 |
| accessGates.ts | `src/agent/runtime/toolPipeline/accessGates.ts`；文件直接依赖，箭头不表示执行先后。 |
| code.ts | `src/tools/runtime/handlers/code.ts`；文件直接依赖，箭头不表示执行先后。 |
| projectPath.ts | `src/shared/projectPath.ts`；文件直接依赖，箭头不表示执行先后。 |
| searchCacheGeneration.ts | `src/tools/runtime/handlers/searchCacheGeneration.ts`；文件直接依赖，箭头不表示执行先后。 |

| 编号 | 代码依据 | 测试依据 | 关系与可证明范围 |
| --- | --- | --- | --- |
| E-T06-D1-01 | `src/agent/policies/SafetyPolicy.ts` → `src/tools/runtime/handlers/terminalSafety.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 #tools/runtime/handlers/terminalSafety.js；第 2 行，kind=import，typeOnly=false。只证明结构关系。 |
| E-T06-D1-02 | `src/agent/runtime/toolPipeline/accessGates.ts` → `src/tools/runtime/handlers/terminalSafety.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 #tools/runtime/handlers/terminalSafety.js；第 10 行，kind=import，typeOnly=false。只证明结构关系。 |
| E-T06-D1-03 | `src/tools/runtime/handlers/code.ts` → `src/shared/projectPath.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 #shared/projectPath.js；第 18 行，kind=import，typeOnly=false。只证明结构关系。 |
| E-T06-D1-04 | `src/tools/runtime/handlers/code.ts` → `src/tools/runtime/handlers/searchCacheGeneration.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ./searchCacheGeneration.js；第 28 行，kind=import，typeOnly=false。只证明结构关系。 |

## 静态依赖 2

```mermaid
flowchart TB
  accTitle: 静态依赖 2
  accDescr: 这是文件直接导入，不是函数调用图；类型边不表示运行时执行。
  n0["terminal.ts"]
  n1["projectPath.ts"]
  n2["searchCacheGeneration.ts"]
  n3["terminalSafety.ts"]
  n4["SafetyPolicy.ts"]
  n5["Policy.ts"]
  n0 -->|"E-T06-D2-01 直接导入"| n1
  n0 -->|"E-T06-D2-02 直接导入"| n2
  n0 -->|"E-T06-D2-03 直接导入"| n3
  n4 -->|"E-T06-D2-04 直接导入"| n5
```

### 本图术语说明

| 术语／节点 | 含义与范围 |
| --- | --- |
| terminal.ts | `src/tools/runtime/handlers/terminal.ts`；文件直接依赖，箭头不表示执行先后。 |
| projectPath.ts | `src/shared/projectPath.ts`；文件直接依赖，箭头不表示执行先后。 |
| searchCacheGeneration.ts | `src/tools/runtime/handlers/searchCacheGeneration.ts`；文件直接依赖，箭头不表示执行先后。 |
| terminalSafety.ts | `src/tools/runtime/handlers/terminalSafety.ts`；文件直接依赖，箭头不表示执行先后。 |
| SafetyPolicy.ts | `src/agent/policies/SafetyPolicy.ts`；文件直接依赖，箭头不表示执行先后。 |
| Policy.ts | `src/agent/policies/Policy.ts`；文件直接依赖，箭头不表示执行先后。 |

| 编号 | 代码依据 | 测试依据 | 关系与可证明范围 |
| --- | --- | --- | --- |
| E-T06-D2-01 | `src/tools/runtime/handlers/terminal.ts` → `src/shared/projectPath.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 #shared/projectPath.js；第 55 行，kind=import，typeOnly=false。只证明结构关系。 |
| E-T06-D2-02 | `src/tools/runtime/handlers/terminal.ts` → `src/tools/runtime/handlers/searchCacheGeneration.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ./searchCacheGeneration.js；第 69 行，kind=import，typeOnly=false。只证明结构关系。 |
| E-T06-D2-03 | `src/tools/runtime/handlers/terminal.ts` → `src/tools/runtime/handlers/terminalSafety.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ./terminalSafety.js；第 70 行，kind=import，typeOnly=false。只证明结构关系。 |
| E-T06-D2-04 | `src/agent/policies/SafetyPolicy.ts` → `src/agent/policies/Policy.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ./Policy.js；第 3 行，kind=import，typeOnly=false。只证明结构关系。 |

本页直接依赖已对照当前AST逐边重查；沿用稳定边ID，行号按当前源码更新。导入存在不表示本轮行为已执行；实际执行见页面证据。
