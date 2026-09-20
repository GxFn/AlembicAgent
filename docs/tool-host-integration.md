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
