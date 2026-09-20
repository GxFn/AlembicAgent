# 工具宿主接入

`ToolRouterAdapter` 调用宿主的 `ToolContextFactoryContract.create(request)` 获取依赖。Agent 保留工具执行、权限、取消和结果归一化；宿主负责真实服务、可信身份、sandbox 及可变资源生命周期。

## 知识端口

从 `@alembic/agent/tools/runtime` 导入 `KnowledgeReadPort`、`KnowledgeManagementPort` 和 `ToolContext`：

- `knowledgeRead.getById` 返回普通 DTO 或 `null`，不暴露仓储实体。
- `knowledgeManagement` 按方法声明 `update/reject/score/validate` 支持情况；未提供的方法明确失败。
- 发布/准入继续使用 Core `RecipeProductionPort`，复核使用 Core `StagingManager`，进化使用 Core `ProposalGateway`，不合并生命周期语义。
- 宿主应将可信用户绑定在 adapter closure 中，再调用 Core 受控服务；不要把 raw repository 的 `update` 作为普通管理入口。
- `knowledgeRepo` 保留兼容。仅对应的新字段为 `undefined` 时才使用旧字段；显式端口缺方法、失败或取消都不回落旧仓储。

Main 的实际装配位于 `lib/tools/ToolContextFactory.ts`，`KnowledgeServiceAdapter.ts` 委托 Core `KnowledgeService.get/update/reject` 并转换 DTO。当前 Main 没有绑定 `score/validate`，调用会明确返回能力不可用；它们不会被伪装为成功。

`KnowledgeSearchPort` 返回 `KnowledgeSearchResult[]`。Main 将 Core `SearchResponse.items` 转成该 DTO，支持 `all`、limit 和 category；Core 当前没有 limit 前的生命周期筛选，因此不把 Agent 的 recipe/candidate 分类误传为 Core 的物理 kind，也不对已经截断的结果做事后过滤来冒充完整搜索。Main 声明 `supportedKinds: ['all']`，其 schema 收窄对应枚举；直接访问不支持的筛选会明确失败。其他已支持分类筛选的宿主可继续声明自己的 supportedKinds。

## Schema 查询与准入

目录实现 `ToolSchemaQueryPort.querySchemas(query)`，一次返回 `{ schemas, allowedTools, unavailable? }`。Runtime 使用同一结果生成模型输入和阶段执行限制。`query` 包含 selection、model、mode、firstRound 及当前 runtime 资源；泛型 `UnifiedToolCatalog` 保留模型覆盖和 lazy 行为，内置目录保留完整 action envelope。

| selection | 含义 |
| --- | --- |
| 缺省 / null | 不额外限制已注册工具 |
| [] / {} | 无工具 |
| `{ code: null }` 或 entry 为 undefined | code 的全部已注册动作 |
| `{ code: [] }` | 禁用 code |
| 未知/重复动作 | 过滤未知项、稳定去重，不回落全集 |

旧的 toToolSchemas、toToolSchemasForModel、toMixedSchemas、toToolSchemasForActions、toMixedSchemasForActions 保留包装；旧宿主只有这些方法时，Runtime 通过一个兼容入口查询并记录所选路径。非法显式 capability 合同会失败，不回落到旧 tools 列表扩大权限。Capability 的文本片段描述允许范围，实际可调用分支以本次 schema 为准。

宿主可实现 `ToolContextFactoryContract.getAvailability(runtime?)`。它返回 `ToolAvailabilitySnapshot`：actions 是稀疏的工具动作约束，parameters 按 tool/action/参数名声明可用枚举。缺项不施加额外约束，显式空集禁用对应工具或动作。Main 复用实际服务装配进行方法检查，不调用 create/forRequest 分配运行状态，不执行 search/get/写入/sandbox 探测；已有 DI 仍可能正常解析惰性实例。

`ToolRouter.describeAvailability` 按实际端口方法描述 graph、outline、knowledge 管理分支和运行期 memory/evidence。prime 可以使用 search-only 路径；只有某些 manage 分支可用时保留这些分支。服务可用性不是 actor 权限，也不是 Core 对具体业务输入的批准。

Adapter 的 explain、执行前检查、获得队列执行位置后的检查使用同一准入规则。排队期间撤销的能力不能继续执行；省略参数也要检查真实默认值。meta.tools 只查询当前有效 registry 视图，不修改全局注册表。

接入该新能力端口后，宿主准入拒绝在 handler 前返回 `TOOL_ACTION_DENIED` 或 `TOOL_UNAVAILABLE`，带 `writeState: 'not-started'`、`requiresReadback: false` 和 blocked 状态。未声明可用性的旧宿主保留 handler 错误路径。执行后的 Core 回执和异常继续原样归一化，不能用这类“未开始”标记覆盖已经发生的写入。

## 可空写回执

Core 公开写口允许返回 null 时，缺回执不能表示未写入或成功。Agent/Main 明确报告 `KNOWLEDGE_WRITE_RECEIPT_UNAVAILABLE`、`writeState: 'unknown'`、`requiresReadback: true`、`retryable: false`。严格生产停止后续 content-ready/CAS；HTTP 批量接口保留已确认成功子集，单列未知项。HTTP publication.confirmed 仍表示原有控制器确认门，不据此推断全批写入成功。

Core 已放入 created 列表并提供 id/lifecycle 的创建回执仍保留；其 raw 详情为空只降低详情投影，并给出 `KNOWLEDGE_CREATED_DETAILS_UNAVAILABLE`，不会再提交一次。

旧任务调用器必须收到成功信封及检查所需的结构化事实才能给出通过结论。缺失旧工具、取消、超时、partial 或缺少检查字段都明确失败，原信封保存在 Error.cause；本次没有为未接线的旧 DAG 工具创建替身。

## 状态作用域

`ToolCallRequest.runtime.resourceScope` 包含 `{ runId, viewId, revision }`，类型 `ToolResourceScope` 从包根导出。它由运行时或可信宿主生成，不能来自模型工具参数；`viewId` 在同一 run 内唯一。

| 生命周期 | 内容 | 释放点 |
| --- | --- | --- |
| 宿主 | Core 服务、无状态 compressor、sandbox bridge | 宿主退出 |
| run + 调用身份/维度 | 工具 SessionStore | `releaseScope({ runId })` |
| reactLoop 读取视图 | DeltaCache、SearchCache | `releaseScope({ runId, viewId })` |
| 视图 revision | 当前仍可见的文件读取基线 | 有损压缩、重置或工具结果裁剪后更换 |

`AgentRuntime.execute` 为一次运行生成独立 `runId`；其 stage 和并行 loop 继承该运行，每个 loop 有独立 `viewId`。直接调用 `reactLoop` 也建立和释放运行。两个 finally 分别释放视图和运行；成功、异常、取消、超时均适用。超时后的旧异步链不能重新开启已结束运行。清理错误会记录告警，保留原业务回执。

宿主的 router/factory 可实现可选的 `releaseScope(scope)`。旧实现仍可执行，但不自动获得资源释放能力。Main 已实现该接口：显式运行不会被兼容会话的 LRU 淘汰；旧 HTTP/宿主调用按 session/agent 与调用身份隔离，最多保留 128 个兼容会话；没有会话/运行身份的调用只拥有临时状态。需要跨调用记忆或先读后写的直接宿主应传明确 scope，并在 finally 释放。跨 run 的协作集合与证据台账仍通过显式 `sharedState` / memory 资源共享。

新 `ContextWindow` 在 L1/L3/L4 内容丢失和 reset 后更新 revision。旧 duck-typed window 无法报告 revision 时会告警，并保守禁用 delta 复用。重复读取一个大文件不能保证拿到全部内容；输出配额仍生效，应按行范围补读。

`DeltaCache.set` 记录磁盘版本指纹，用于写前新鲜度校验；它不声明全文已经展示。`check` 只有在完整输出有资格进入当前视图时建立增量基线。范围读、outline、batch/action 配额截断保留指纹但不建立全文可见性。读取视图重置后，修改已有文件需要重新读取。

## 接入验证

Agent 的 `test/tool-resource-scope.test.ts` 覆盖运行/视图传播与释放、裁剪、旧 window 和迟到 loop；Main 的 `ToolContextScope.test.ts` 覆盖真实 factory/router 隔离和写前门。Main 的 `KnowledgeServiceAdapter.test.ts` 通过真实 Core 与临时 SQLite 验证 DTO、系统字段保护、复核、取消和文件/数据库分歧回执，无需真实模型或 API key。

Schema/准入回归位于 Agent 的 tool-schema-projection、tool-availability、runtime-schema-query；任务真值位于 task-tool-outcomes。Main 的 MainToolAvailability 覆盖真实 AgentModule 装配和 HTTP 列表，KnowledgeWriteReceiptBoundary 与严格生产 Facade 集成用例覆盖缺回执时真实写入已发生的情况。
