# 阶段执行与知识提交的生命周期

## 运行边界与观察通知

Runtime 内部按状态所有权分工，公开包入口保持不变：

| 实现 | 负责内容 |
| --- | --- |
| `AgentRuntime` | 循环状态、取消与期限、PCV 记账、Hook/事件发送顺序、provider 调用和真实用量 |
| `runtime/llmInput.ts` | 工具 schema/choice 兼容策略、阶段投影预算和输入大小判定；仅观察阶段端口及预算数据 |
| `LLMInputAssembly` / `LLMInputMeasurement` | 既有消息与输入章节装配、完整 provider 请求的大小测量 |
| `runtime/processEvents.ts` | 普通快照到开发者文本/元数据的纯投影，包括脱敏、输出完整度和 Nudge 说明 |
| `runtime/toolReceipt.ts` | 已返回工具结果的条目组装与显式配额文本投影；保留原始对象身份，不执行工具或写入运行状态 |

事件时间与 PCV 快照仍在 Runtime 原构造点取得，先生成事件，再执行 Hook 和发送。事件 metadata 保持可附加，Hook 错误仍可在发送前写入。工具进度/总线与 `agent_process_event` 保留各自通道；显示投影不持有 Runtime、LoopContext、provider 或持久化端口。

`AgentRuntime.execute`、阶段尝试和 Transport 共用 `shared/operation.ts` 的四态生命周期。预先取消的运行不会进入策略；运行中取消会结束等待并保留已确认的工具回执和用量，父 signal 的取消原因传至子操作。超时先固定为 timeout，再取消子操作；同步的取消回调不能把它改成成功或主动取消。超长有限期限按 Node timer 上限分段等待。

硬超时继续通过 Error 拒绝，内部 Runtime/Service 共享的超时错误携带已确认的部分结果；普通执行或后置校验异常也保留本次 Runtime 绑定的已确认快照。相同 Error 被不同 Runtime 复用时按实例隔离，不采信任意外部 Error 自带的 partialResult。Service 返回 `timeout` 时保留这些工具回执、已知用量和诊断；仍在途的外部写入可能需要宿主读回，不能把取消或超时当作回滚。资源清理及清理诊断失败均不覆盖已确认结果。

`shared/observers.ts` 只负责旁路观察者的同步异常与 PromiseLike 拒绝隔离，由调用方决定诊断内容。AI 管理、JSON 恢复日志、runtime 进度和工具结果通知使用同一辅助入口。通知失败不能抹掉结果、重放工具或阻断后续监听者；诊断通道自身失败也不递归报告。权限判断仍由可等待、可返回 false 的执行前 Hook 完成。

EventBus 的 `publish` 使用监听快照隔离各个通道，保留 `once` 和监听器的 `this`；直接调用继承的 `emit` 仍遵守 Node 原有语义。request/reply 同步发布请求、按 correlationId 接受响应，等待期限复用 `runOperation`；reset 清理尚未完成的请求。Hook 同样使用分发快照，退订不会跳过后续阻断器；`once` 的领取状态在并发分发间共享。

开发者事件、终端 Nudge 输出、Hook 错误和新采集的生产台账共用 `utils/Redaction.ts` 处理已知凭据形态与敏感键纯量。引号内的多词值、数字值和嵌套 JSON 字符串均在对应表示层脱敏；未修改的 JSON 片段保持原始格式，换行数量保留。编码嵌套超过八层时返回可见的 `[redacted-nested-value]` 标记。送给模型的原始消息、业务工具回执和 LLM 最终回复保持原值，正常的数字 token 用量仍可观测，包括 `cacheWriteTokens`。台账 freshness 对输入使用同一脱敏规则；规则更新不改写已有台账，旧规则产物可能需要重新采集，也不声称识别所有未知凭据格式。

诊断计数只接受有限非负数，非法输入或累加溢出产生 `diagnostics_invalid_count`，保留合法字段与已有总量。合并聚合计数不按数值大小循环。诊断快照复制公开条目，宿主修改快照不会反写收集器。

无 Tracker 的循环同样执行 `maxIterations`；模型反复返回被禁止的工具调用，也不能绕过轮数上限。真实取消和期限优先于轮数耗尽。空响应和服务错误的重试等待响应同一 `AbortSignal`。

强制摘要只有 `forcedSummary.ts` 一个实现入口。它保留 Runtime 的身份提示、显式输出预算和温度，使用有界的真实工具回执，优先容纳最新结果；参数和回执分别分配空间，失败、部分结果和截断都有标识。摘要失败或空响应保留工具结果并报告降级，不再追加第二次摘要；取消后的迟到文本丢弃，已知 input/output/reasoning/cache 用量仍归原调用统计。

LLM 输入压缩只删除逐字重复的完整长行，不通过子串、大小写或缩进猜测等价。Producer 历史只有在请求 ID 非空、唯一且与回执一一对应时才折叠；摘要合并只修改本次装配生成的对象。PCV 从已确认工具结果累计证据，批次中途取消也保留已完成部分；现代 `evidenceRefs` 通过本轮台账解析为精确来源。PCV 始终是观察数据，缺失链接按当前快照重算，不升级为新的生产门。

模型请求仍按“工具策略 → 阶段压缩/装配 → PCV 观察 → 大小校验 → Hook → 进度/日志 → provider”执行。最后一个宿主观察回调之后再次检查取消；已取消的请求不进入注入的 provider 端口。输入过大仍保留 PCV 观察并按原规则抑制强制摘要。Scan 的阶段说明与工具说明共用补证权限判定，只有原本允许 `code.read` 的 Scan Producer 可补读已有引用文件，普通 Producer 的探索限制不变。

工具宿主请求在安全策略和装配完成后、真实 router 入口前再次检查取消；已取消时保留明确的 aborted 失败观察，不调用宿主。正常回执继续按“pipeline after → 两份历史 → onToolCall → 逐条 PCV → 文本配额/读视图 → 字符记账 → 事件/Hook → 模型历史”的顺序处理。args/result/envelope 的身份保持不变，阶段观察者仍可从对应历史关联原 envelope。

pipeline 已获得结果、但 after 或最后的效率记账抛错时，内部 WeakMap 按原 Error、本次调用 context 与 call 身份保存回执。Runtime 只消费自己的记录一次，补入真实部分历史并报告 `TOOL_POSTPROCESSING_FAILED`，随后保留原异常退出；不采信外部 Error 自带 partial 字段，不重放工具、不补发成功事件，也不把未完成的观察链标记为完成。PCV、预算和轮次收尾在这条失败路径不继续推进。

## 服务与任务装配

`AgentProfileRegistry` 保存可序列化声明的自有快照，get/list 的修改不回写注册表。Service 与直接 RuntimeBuilder 共用 ProfileCompiler 解释引用、声明式 policy 和覆盖项，避免两条调用路径得到不同预算。Legacy preset params 只接入既有预算字段，业务参数不能隐式替换能力或策略。preset 展开和 stage factory 返回本次独立的普通配置容器，函数、Policy 实例和闭包中的宿主端口保持身份。

Service 的 metadata.context 与显式 promptContext 共用一次优先级规则，显式字段优先。独立运行的 shouldAbort 在开工时检查；异步检查的等待响应父 signal 与显式期限，检查结束后不轮询。日志是旁路，不能把已完成或已失败的业务结果改写。运行中的停止继续由 AbortSignal 和 Runtime 负责。

任务投影保持执行状态与已确认产物分离。扫描失败返回 error，同时保留真实已入库的 recipes；它不从 provider 文本制造身份。关系发现只有成功运行才返回可写图的关系。Plan、模块和进化任务抛出的错误保留 cause/partialResult，宿主可检查已确认工作；翻译解析观察者失败不覆盖原文降级结果。Scan 和 insight 共用提交重试字段与回执判定，权限与各自预算继续独立。

严格 Plan 的冻结 query 校验与 Core 语义拒绝共用原有因果修复次数；provider 失败和禁止的工具调用不变成语义重试。模块拆分按共同父目录下的子目录分组，保留原始项目相对文件路径；单个超大目录保留内聚性。分组标签编码且派生 ID 避让所有真实输入 ID，防止合并结果覆盖兄弟模块。

旧 task 工具名在默认 Router 中仍按现有合同失败关闭。迁移需要明确的等价工具/服务端口；本轮没有增加猜测的别名。Task 成功/失败投影测试集中在 task-tool-outcomes，实际 scan/Core 持久化集成测试保留。

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

质量门的拒绝、未知动作或相互矛盾的结果不能报告 `completed`。显式 `skipOnFail=false` 仍允许后续清理阶段执行，最终结果保留未通过事实。超时判断使用各阶段的最终回执，成功重试不被历史超时记录重新判为失败。`QualityGatePolicy.toGateConfig()` 负责将 Policy 的 `ok` 翻译为 Pipeline 的 `pass`；缺少拒绝原因不会把失败变成通过。多条 SafetyPolicy 按全部同意执行，`g`/`y` 正则的匹配游标不在调用间共享。

## 证据与评审边界

`EvidenceCapture` 保存模型实际得到的工具观察，`EvidenceCollector` 从成功观察提取可引用源码片段，`EvidenceLedgerStore` 负责追加存储和恢复，`ProductionEvidenceLedgerAuthority` 校验严格生产的身份与完整快照。失败批次成员不会被成功成员覆盖；批量落账中途失败时，中间件保留已经确认的条目标注与统计，并报告 `persisted` 数量。写入失败不表示前项回滚。

源码片段只取连续原文。outline/delta/unchanged 仍可作为台账中的工具观察，但不进入可照抄的源码片段；read/search 共用字符和每文件片段预算。只有明确完成的零命中搜索产生负空间信号，省略、截断、取消和错误都不等于没有找到。V1 报告与 V2 工件共用采集投影：`referencedFiles` 保留分析提及路径，`groundedFiles` 仅保留已采集源码片段的路径；覆盖度与深度门优先使用后者。旧宿主未提供该字段时保留原合同。

台账在成功 append 后推进编号；同进程重复打开的 store 在磁盘版本变化后刷新，再读取或分配 ID。宿主仍负责每份台账只由一个进程写入，本接口不提供跨进程事务锁。严格快照和生产采集检查当前磁盘完整性；已观察到的历史删除或改写使当前 authority 失效，修复磁盘后需重新打开；截断内容只支持已完整捕获的行范围。各维度可以有独立 runtime session；跨维度导入先检查来源文件内部的 session 一致性、dimension、完整序号与内容哈希，再重编号，不能通过重算哈希认证损坏来源。普通历史读取仍可保留兼容条目，严格 authority 不接受旧哈希或部分台账。

严格 Producer 在封印表达集前检查 proposal kind、非空引用数组及 authored 对象形状，Core 继续负责语义裁决。独立评审输出的分数与引用数组必须满足原始类型，不能先转换或过滤再宣称有效；mining judge 的 `uphold` 必须与既有四轴结论一致。Durable reviewer 接受 provider 的正常 `completed` 结束状态，超长期限按 Node timer 上限分段等待。评审失败、取消和超时沿既有错误与诊断合同返回，不改动生产阈值。

质量门的深度重试与摘要重写测试集中在 `analysis-quality-gates.test.ts`；证据保真、台账恢复、严格 lineage 和 durable authority 各由原有测试入口验证。

## 子任务协调

`AgentRunCoordinator` 在启动子任务前确认 partitioner 和 merger。`onChildResult` / `onTierComplete` 可能负责持久化，异常仍拒绝父运行；错误附带 `partialResult` 和 `coordinationFailures`。已启动子任务结算后保留各自真实回执，尚未启动的任务停止派发。每个结果按计划索引保存，重复使用同一个输入对象也不会互相覆盖。取消阻止的 tier 不发送完成回调。

`FanOutStrategy` 向子策略传递执行配置，每个 item 使用独立诊断，最后合并一次。子 Pipeline 只获得所需的 loop 与工具观察接口，不读取父 Runtime 的共享迭代计数；中断时无法观察的工具启动数继续报告未知。显式注入同一个 ContextWindow、Tracker 或 ActiveContext 时，item 串行使用这些可变资源，并记录诊断。跨维度需要独立 Runtime 的宿主流程继续使用 Coordinator。

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
- `AgentRuntime`、`llm-input-layering`、`agent-surface-floor`：摘要回执和预算、输入保真、策略及协调器边界；公开出口与接口合同集中在 `contract-surface`。
- `Redaction`、`EvidenceLedgerStore`、`llm-input-layering`、`hook-system`：文本格式、台账 freshness，以及真实开发者事件与业务返回的隔离。

测试复用现有文件、参数化场景与临时项目，不需要真实 API key。`npm run check` 同时检查构建、导入边界、冻结公开接口、相邻宿主消费和完整测试集。
