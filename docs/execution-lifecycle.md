# 阶段执行与知识提交的生命周期

## 运行边界与观察通知

`AgentRuntime.execute`、阶段尝试和 Transport 共用 `shared/operation.ts` 的四态生命周期。预先取消的运行不会进入策略；运行中取消会结束等待并保留已确认的工具回执和用量，父 signal 的取消原因传至子操作。超时先固定为 timeout，再取消子操作；同步的取消回调不能把它改成成功或主动取消。超长有限期限按 Node timer 上限分段等待。

硬超时继续通过 Error 拒绝，内部 Runtime/Service 共享的超时错误携带已确认的部分结果。Service 返回 `timeout` 时保留这些工具回执、已知用量和诊断；仍在途的外部写入可能需要宿主读回，不能把取消或超时当作回滚。资源清理及清理诊断失败均不覆盖已确认结果。

`shared/observers.ts` 只负责旁路观察者的同步异常与 PromiseLike 拒绝隔离，由调用方决定诊断内容。AI 管理、JSON 恢复日志、runtime 进度和工具结果通知使用同一辅助入口。通知失败不能抹掉结果、重放工具或阻断后续监听者；诊断通道自身失败也不递归报告。权限判断仍由可等待、可返回 false 的执行前 Hook 完成。

EventBus 的 `publish` 使用监听快照隔离各个通道，保留 `once` 和监听器的 `this`；直接调用继承的 `emit` 仍遵守 Node 原有语义。request/reply 同步发布请求、按 correlationId 接受响应，等待期限复用 `runOperation`；reset 清理尚未完成的请求。Hook 同样使用分发快照，退订不会跳过后续阻断器；`once` 的领取状态在并发分发间共享。

诊断计数只接受有限非负数，非法输入或累加溢出产生 `diagnostics_invalid_count`，保留合法字段与已有总量。合并聚合计数不按数值大小循环。诊断快照复制公开条目，宿主修改快照不会反写收集器。

## 阶段尝试

`PipelineStrategy` 负责阶段顺序、gate 路由、Core strict receipt 接入和结果汇总。`strategies/pipeline/attempt.ts` 负责单次尝试的期限、取消、工具观察和诊断；`shared/operation.ts` 仅提供异步操作的四种终态：`ok`、`timeout`、`aborted`、`error`。

阶段的 prompt 准备与 `reactLoop` 共用一次硬期限，仍保留 `budget.timeoutMs + 60_000` 的强制总结缓冲。没有配置阶段期限时，父 `AbortSignal` 仍能终止等待。超时先确定结果再取消子操作，避免宿主在 abort 回调里同步完成而覆盖超时结论。timer 和父 signal listener 由这次操作统一清理。

每次尝试使用独立 `DiagnosticsCollector`，关闭后只向父诊断合并一次快照。工具回调在活跃期保持 `stage.onToolCall` 优先于 `runtime.onToolCall`；旧尝试的迟到回调不会再次进入观察或用户钩子。宿主应通过 `sharedState` 或 gate artifact 传递跨阶段状态；准备和 gate 获得带本次 signal/diagnostics 的上下文视图，不能依赖其顶层字段写回。

超时或取消保留已经观察到的工具结果。若 native history 有对应 envelope，则保留该回执；返回结果与回调副本按 call ID 优先、其次按内容和发生次数配对，不合并两个不同 ID 或重复发生的调用。`StageResult.partial` 描述：

| 字段 | 含义 |
| --- | --- |
| `startedToolCalls` | native event bus 可观察到的开始次数；无法观察为 `null` |
| `completedToolCalls` | 本次已知完成回执数 |
| `requiresReadback` | 中断时存在未知或未完成执行，需要宿主核对真实结果 |

旧宿主即使忽略 signal，也能结束本次等待；这不保证外部代码停止运行。宿主回调、provider 和工具应继续响应取消，避免迟到写入共享状态。

宿主返回 `aborted: true` 时，即使父 signal 未取消，也会停止后续主阶段、gate 与修复重评，管线结果为 `aborted`。

非 strict 的快速重试仍受 `retryBudget` 和一次上限约束，只在宿主显式返回零工具超时，或 native 观察确认循环内没有工具开始时允许。宿主若携带 `partial`，其中已知工具活动、未知开始次数或读回要求均会否决重试；已有部分回执保留。未知执行历史的硬超时不据此重试。所有尝试的已知用量与迭代次数均累计；最终阶段结果描述最后一次尝试，最终回复取实际最后主阶段，避免被旧 repair 微阶段覆盖。

## 知识工具职责

`tools/runtime/handlers/knowledge.ts` 保留 `handle` 与 Core 风格规则重导出的原入口，动作和包 exports 保持不变。内部模块按调用顺序分层：

| 模块 | 负责内容 |
| --- | --- |
| `contracts.ts` | 注入端口类型与 Agent 来源词汇；Core production 类型仍从包入口接入 |
| `input.ts` | 输入类型检查、维度/语言默认值、候选字段归一化 |
| `sources.ts` | 已声明范围的真实文件提示与来源投影，调用既有 Core authoring adapter |
| `authoring.ts` | 证据展开、稳定预算、有限风格修复、Core authoring 门禁 |
| `sessionState.ts` | 跨调用和阶段浅拷贝保持身份的计数盒 |
| `submission.ts` | 写入前最后取消检查、调用 Core createOrStage、分流生产结果 |
| `submissionResult.ts` | 已创建回执的 readiness、会话记录和结果投影；仅接收 readiness 读口 |
| `queries.ts` | search、prime、detail 的只读结果 |
| `management.ts` | publish/readiness、staging review 和 evolution proposal 接入 |
| `operation.ts` | 写前取消检查与写后取消诊断 |

`authoring` 不接收 Core 写口。字段输入、authoring 判定、实际写入与写后附加处理分别有可审核边界。`config/layer-contract.json` 对这些文件逐一限定运行时依赖；通用生命周期和单次阶段尝试不能反向导入业务编排。Core 的证据/epoch/发布裁决与本仓库 symlink 安全 resolver 继续保留。

## 写入前后

写入前的取消返回失败，不启动下一项副作用。风格修复默认 30 秒，经 `AiProvider.chat` 将子 signal 传至真实 transport；旧 provider 忽略取消时丢弃迟到响应。准备完成后的 `await` 仍可能让父取消先发生，所以最终检查位于 `createOrStage` 调用前。

Core 已确认创建后，结果保留 `status: created`、`id`、`candidateId`、`lifecycle`。readiness 或同步/异步会话记录失败只设置 `_meta.degraded` 和 `diagnosticWarnings`。无法读取 readiness 时返回 `readinessStatus: unavailable`，省略 `readiness`，不把“未知”伪装成 Core 的 `ready: false`。

Core 当前的 `createOrStage`、`publish` 端口不接收 signal；已开始的调用要等待真实回执，取消不代表回滚。发布前的 readiness 等待可以取消，进入 publish 后则保留 Core 的实际结果。

题目提交、风格修复、waiver 和拒绝统计使用稳定 `_sessionCounters`。已有顶层 `_submitTitleAttempts` 按原引用接入，预算不重置；合法的 `constructor`、`__proto__` 标题使用自有字典项计数。

## 验证入口

- `agent-lifecycle`、`pipeline-outcome-abandoned`：准备挂起、取消、超时竞态、部分结果、回调与重试总账。
- `recipe-production-profile-adapter`：真实 Core authoring/production 接口、写入前后取消、readiness/会话记录失败、共享预算与 graph 修复一致性。
- `SubmitEvidenceExpansion`、`provider-facades`：风格修复期限和实际 mock transport 的 signal。
- `layer-contract`：使用实际配置验证禁止的反向依赖。

测试复用现有文件、参数化场景与临时项目，不需要真实 API key。`npm run check` 同时检查构建、导入边界、冻结公开接口、相邻宿主消费和完整测试集。
