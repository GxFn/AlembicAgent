---
schemaVersion: 1
diagramId: 11-observability-imports
topic: "11"
title: 事件、诊断与脱敏 · 直接依赖
viewType: file-dependency
truthKind: in-progress-worktree
reviewDepth: L1
verifiedAt: 2026-10-23
baselineCommit: 37bdc7f7b6dc6e0fcc12b95de1dfa5251848b0b0
documentationOwner: AlembicAgent 架构文档维护者
sourcePaths:
  - src/agent/evidence/EvidenceLedgerStore.ts
  - src/agent/evidence/ProductionEvidenceLedgerAuthority.ts
  - src/agent/evidence/evidenceFileClass.ts
  - src/agent/runtime/AgentEventBus.ts
  - src/agent/runtime/AgentRuntime.ts
  - src/agent/runtime/DiagnosticsCollector.ts
  - src/agent/runtime/HookSystem.ts
  - src/agent/runtime/processEvents.ts
  - src/agent/utils/Redaction.ts
  - src/agent/utils/redaction/legacyFloor.ts
  - src/agent/utils/redaction/render.ts
  - src/agent/utils/redaction/sourcePolicy.ts
testPaths: []
contractPaths: []
refreshTriggers:
  - package.json
  - tsconfig.json
sourceFingerprint: sha256:02c273fb56d646eb6ed0dafe2a567d3f7ae8cd5694519ed3c9a905c7adced01c
testEvidence: anchored
externalContracts:
  - "@alembic/core：公开包端口，本图不递归扫描其实现；宿主装配只核对本仓契约。"
reviewRecord: evidence/readings.json
generatedBy: AST
---

# 事件、诊断与脱敏 · 精选直接依赖

[职责与边界](overview.md) · [真实调用](call-flow.md)

选取本专题入口与来源策略接线的直接依赖；完整库存可在阅读器「文件与依赖」查看。以仓库全路径为节点身份，同名文件不会合并。Core／Node／第三方包只在完整探索器的外部边界出现。

## 静态依赖 1

```mermaid
flowchart TB
  accTitle: 静态依赖 1
  accDescr: 这是文件直接导入，不是函数调用图；类型边不表示运行时执行。
  n0["ProductionEvidenceLedgerAuthority.ts"]
  n1["Redaction.ts"]
  n2["EvidenceLedgerStore.ts"]
  n3["AgentRuntime.ts"]
  n4["AgentEventBus.ts"]
  n0 -->|"E-T11-D1-01 直接导入"| n1
  n0 -->|"E-T11-D1-02 直接导入"| n2
  n3 -->|"E-T11-D1-03 直接导入"| n1
  n3 -->|"E-T11-D1-04 直接导入"| n4
```

### 本图术语说明

| 术语／节点 | 含义与范围 |
| --- | --- |
| ProductionEvidenceLedgerAuthority.ts | `src/agent/evidence/ProductionEvidenceLedgerAuthority.ts`；文件直接依赖，箭头不表示执行先后。 |
| Redaction.ts | `src/agent/utils/Redaction.ts`；文件直接依赖，箭头不表示执行先后。 |
| EvidenceLedgerStore.ts | `src/agent/evidence/EvidenceLedgerStore.ts`；文件直接依赖，箭头不表示执行先后。 |
| AgentRuntime.ts | `src/agent/runtime/AgentRuntime.ts`；文件直接依赖，箭头不表示执行先后。 |
| AgentEventBus.ts | `src/agent/runtime/AgentEventBus.ts`；文件直接依赖，箭头不表示执行先后。 |

| 编号 | 代码依据 | 测试依据 | 关系与可证明范围 |
| --- | --- | --- | --- |
| E-T11-D1-01 | `src/agent/evidence/ProductionEvidenceLedgerAuthority.ts` → `src/agent/utils/Redaction.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ../utils/Redaction.js；第 10 行，kind=import，typeOnly=false。只证明结构关系。 |
| E-T11-D1-02 | `src/agent/evidence/ProductionEvidenceLedgerAuthority.ts` → `src/agent/evidence/EvidenceLedgerStore.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ./EvidenceLedgerStore.js；第 11 行，kind=import，typeOnly=false。只证明结构关系。 |
| E-T11-D1-03 | `src/agent/runtime/AgentRuntime.ts` → `src/agent/utils/Redaction.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ../utils/Redaction.js；第 61 行，kind=import，typeOnly=false。只证明结构关系。 |
| E-T11-D1-04 | `src/agent/runtime/AgentRuntime.ts` → `src/agent/runtime/AgentEventBus.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ./AgentEventBus.js；第 62 行，kind=import，typeOnly=false。只证明结构关系。 |

## 静态依赖 2

```mermaid
flowchart TB
  accTitle: 静态依赖 2
  accDescr: 这是文件直接导入，不是函数调用图；类型边不表示运行时执行。
  n0["AgentRuntime.ts"]
  n1["DiagnosticsCollector.ts"]
  n2["HookSystem.ts"]
  n3["processEvents.ts"]
  n4["Redaction.ts"]
  n0 -->|"E-T11-D2-01 直接导入"| n1
  n0 -->|"E-T11-D2-02 直接导入"| n2
  n0 -->|"E-T11-D2-03 直接导入"| n3
  n2 -->|"E-T11-D2-04 直接导入"| n4
```

### 本图术语说明

| 术语／节点 | 含义与范围 |
| --- | --- |
| AgentRuntime.ts | `src/agent/runtime/AgentRuntime.ts`；文件直接依赖，箭头不表示执行先后。 |
| DiagnosticsCollector.ts | `src/agent/runtime/DiagnosticsCollector.ts`；文件直接依赖，箭头不表示执行先后。 |
| HookSystem.ts | `src/agent/runtime/HookSystem.ts`；文件直接依赖，箭头不表示执行先后。 |
| processEvents.ts | `src/agent/runtime/processEvents.ts`；文件直接依赖，箭头不表示执行先后。 |
| Redaction.ts | `src/agent/utils/Redaction.ts`；文件直接依赖，箭头不表示执行先后。 |

| 编号 | 代码依据 | 测试依据 | 关系与可证明范围 |
| --- | --- | --- | --- |
| E-T11-D2-01 | `src/agent/runtime/AgentRuntime.ts` → `src/agent/runtime/DiagnosticsCollector.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ./DiagnosticsCollector.js；第 86 行，kind=import，typeOnly=false。只证明结构关系。 |
| E-T11-D2-02 | `src/agent/runtime/AgentRuntime.ts` → `src/agent/runtime/HookSystem.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ./HookSystem.js；第 99 行，kind=import，typeOnly=false。只证明结构关系。 |
| E-T11-D2-03 | `src/agent/runtime/AgentRuntime.ts` → `src/agent/runtime/processEvents.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ./processEvents.js；第 121 行，kind=import，typeOnly=false。只证明结构关系。 |
| E-T11-D2-04 | `src/agent/runtime/HookSystem.ts` → `src/agent/utils/Redaction.ts` | 未覆盖：静态依赖由本图谱解析器反例测试支持；不把 import 当作行为覆盖。 | TypeScript AST 解析 ../utils/Redaction.js；第 21 行，kind=import，typeOnly=false。只证明结构关系。 |



## 来源策略的直接依赖

```mermaid
flowchart TB
  accTitle: 来源策略的直接依赖
  accDescr: 图边只表示已核对的调用或参数交接，来源通道与失败边界见下表。
  redaction["Redaction.ts"]
  policy["sourcePolicy.ts"]
  classify["evidenceFileClass.ts"]
  floor["legacyFloor.ts"]
  render["render.ts"]
  redaction -->|"E-T11-D3-01 直接导入"| policy
  policy -->|"E-T11-D3-02 直接导入"| classify
  policy -->|"E-T11-D3-03 直接导入"| floor
  policy -->|"E-T11-D3-04 直接导入"| render
```

### 本图术语说明

| 节点／术语 | 含义与代码定位 |
| --- | --- |
| Redaction.ts | `src/agent/utils/Redaction.ts`；文件直接依赖，不表示业务调用时序。 |
| sourcePolicy.ts | `src/agent/utils/redaction/sourcePolicy.ts`；文件直接依赖，不表示业务调用时序。 |
| evidenceFileClass.ts | `src/agent/evidence/evidenceFileClass.ts`；文件直接依赖，不表示业务调用时序。 |
| legacyFloor.ts | `src/agent/utils/redaction/legacyFloor.ts`；文件直接依赖，不表示业务调用时序。 |
| render.ts | `src/agent/utils/redaction/render.ts`；文件直接依赖，不表示业务调用时序。 |

| 编号 | 代码依据 | 测试依据 | 关系与可证明范围 |
| --- | --- | --- | --- |
| E-T11-D3-01 | `src/agent/utils/Redaction.ts` → `src/agent/utils/redaction/sourcePolicy.ts` | 未覆盖：静态依赖定位，不把import当行为验证。 | TypeScript AST 解析 ./redaction/sourcePolicy.js；第 32 行，kind=import，typeOnly=false。只证明结构关系。 |
| E-T11-D3-02 | `src/agent/utils/redaction/sourcePolicy.ts` → `src/agent/evidence/evidenceFileClass.ts` | 未覆盖：静态依赖定位，不把import当行为验证。 | TypeScript AST 解析 ../../evidence/evidenceFileClass.js；第 50 行，kind=import，typeOnly=false。只证明结构关系。 |
| E-T11-D3-03 | `src/agent/utils/redaction/sourcePolicy.ts` → `src/agent/utils/redaction/legacyFloor.ts` | 未覆盖：静态依赖定位，不把import当行为验证。 | TypeScript AST 解析 ./legacyFloor.js；第 54 行，kind=import，typeOnly=false。只证明结构关系。 |
| E-T11-D3-04 | `src/agent/utils/redaction/sourcePolicy.ts` → `src/agent/utils/redaction/render.ts` | 未覆盖：静态依赖定位，不把import当行为验证。 | TypeScript AST 解析 ./render.js；第 63 行，kind=import，typeOnly=false。只证明结构关系。 |
