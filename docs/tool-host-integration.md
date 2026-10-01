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

detail、search、prime 及只读 validate 使用统一的可取消等待。没有 signal 参数的宿主服务可能继续运行，迟到结果和拒绝会被观察；取消后不会再开始下一项读取。已经开始的写入仍等待真实回执，诊断日志的同步/异步失败不改变取消状态或已确认的写入。

Agent 剥除无法证明的 coreCode 后，继续交给 Core 检查保留的来源字段。`SOURCE_REF_*` 与 `SNIPPET_MISMATCH` 等硬违规不能因附带坏片段而被过滤。文档/代码分类使用受控解析后的真实文件路径，文档的符号链接不能提升为代码证据。

## Schema 查询与准入

共享合同位于 `tools/kernel`：`manifest.ts` 定义能力元数据，`toolSchema.ts` 定义模型可见 schema 和查询合同，`request.ts` / `result.ts` 定义调用与回执。`catalog/CapabilityManifest.ts` 保留旧类型重导出；包的公开导入入口不变。`CapabilitySurface` 描述能力展示范围，`ToolSurface` 描述实际调用来源，两者继续保持各自的枚举。

目录实现 `ToolSchemaQueryPort.querySchemas(query)`，一次返回 `{ schemas, allowedTools, unavailable? }`。Runtime 使用同一结果生成模型输入和阶段执行限制。`query` 包含 selection、model、可选 apiModelId、mode、firstRound 及当前 runtime 资源；泛型 `UnifiedToolCatalog` 保留模型覆盖和 lazy 行为，内置目录保留完整 action envelope。

| selection | 含义 |
| --- | --- |
| 缺省 / null | 不额外限制已注册工具 |
| [] / {} | 无工具 |
| `{ code: null }` 或 entry 为 undefined | code 的全部已注册动作 |
| `{ code: [] }` | 禁用 code |
| 未知/重复动作 | 过滤未知项、稳定去重，不回落全集 |

Runtime 收集多个 capability 时取权限并集，null/undefined 动作通配占优；某个 capability 的空动作集不会否决另一个 capability 的授权。空项仍保留最早的工具插入位置。运行级 additionalTools 与阶段 additionalToolsOverride 继续追加合并，阶段空数组不清空运行级额外工具；capabilityOverride 的空数组只清空 capability。非法显式 allowedTools 会拒绝，不回落到 tools。

完整动作声明的快照共用于能力收集、查询和准入，先固定值及数组成员，再判断合法性。目录声明只枚举可见工具；准入与稀疏宿主约束仍检查自有隐藏键，复制时保持原枚举性，不把隐藏授权新增到模型列表。宿主参数约束的 tool/action 层保留继承和非枚举的数据字段，末层参数名维持自有可枚举语义，避免整理结构后丢失原有拒绝条件。

旧的 toToolSchemas、toToolSchemasForModel、toMixedSchemas、toToolSchemasForActions、toMixedSchemasForActions 保留包装；旧宿主只有这些方法时，Runtime 通过一个兼容入口查询并记录所选路径。非法显式 capability 合同会失败，不回落到旧 tools 列表扩大权限。Capability 的文本片段描述允许范围，实际可调用分支以本次 schema 为准。

显式 `mode: full` 优先选择旧宿主可用的完整投影方法；仅有 mixed 方法时保留兼容结果，并记录 `legacy_mode_degraded`。默认和 mixed 查询保持原探测顺序。降级日志失败不改变结果，各条路径仍按调用前的 selection 收窄权限。

查询前固定 selection 的自有快照，传给宿主的是独立副本；宿主或兼容通知修改入参不能扩大本次授权。 `schemaQuery.ts` 内部分别处理现代结果校验、旧方法选择，并共用最后的权限投影；两类目录的模型覆盖、lazy 状态和内置可用性仍由各自实现持有。查询端口保持同步：Promise 结果明确拒绝，并观察其迟到失败，避免未处理拒绝。兼容通知失败只记录 `legacy_diagnostic_failed`。泛型目录的 schema 参数投影也独立于注册定义；工具 handler 与活跃 runtime 资源保留原引用。

宿主返回的 schema 成员、name/parameters、有效动作值和不可用原因先读取为本地声明快照，再按原形状规则校验。稀疏数组按含有 undefined 条目拒绝，不静默丢弃；变化 getter 不能在校验后把禁用动作改成全开放或把对象参数换成字符串。仅在选中工具后展开其描述和扩展字段，函数 metadata 与活跃资源引用保留，不深克隆；旧宿主省略 description 的兼容行为不变。旧查询的 model/firstRound 使用进入接口时的声明快照；选中工具的扩展 getter 在本次投影时取值，不承诺延迟到后续消费者才读取。这不是完整 JSON Schema 语义验证。

Runtime 保留传入的完整 modelRef，并显式提供首个冒号后的 `apiModelId`，包括模型名自身的后续冒号。模型覆盖按原声明顺序匹配这两个明确名称。旧目录直接调用只按传入 model 字符串匹配，不擅自拆分 `qwen2:latest` 这类裸模型名；catalog 不持有另一份 provider 注册表。

宿主可实现 `ToolContextFactoryContract.getAvailability(runtime?)`。它返回 `ToolAvailabilitySnapshot`：actions 是稀疏的工具动作约束，parameters 按 tool/action/参数名声明可用枚举。缺项不施加额外约束，显式空集禁用对应工具或动作。Main 复用实际服务装配进行方法检查，不调用 create/forRequest 分配运行状态，不执行 search/get/写入/sandbox 探测；已有 DI 仍可能正常解析惰性实例。

Runtime 在循环初始化时用同一次 schema 投影的 `unavailable` 生成「本次运行不可用的工具」说明，追加到系统提示末尾（能力片段、阶段系统提示覆盖都适用）。静态提示里仍会提到的工具（例如没有图谱服务时的 `graph.query`）由这段说明明确标为不可调用；说明只反映宿主接线缺口，一次循环内不变。

`ToolRouter.describeAvailability` 按实际端口方法描述 graph、outline、knowledge 管理分支和运行期 memory/evidence。prime 可以使用 search-only 路径；只有某些 manage 分支可用时保留这些分支。服务可用性不是 actor 权限，也不是 Core 对具体业务输入的批准。

Adapter 的 explain、执行前检查、获得队列执行位置后的检查使用同一准入规则。 每次检查只消费本次固定并验证的动作/参数声明；快照不跨排队等待缓存，获得执行位置后仍读取最新宿主可用性和权限。排队期间撤销的能力不能继续执行；省略参数也要检查真实默认值。meta.tools 只查询当前有效 registry 视图，不修改全局注册表。

公开的 `allowToolDecision` / `denyToolDecision` 保留原签名；显式 allowed、stage、reason 优先于 extras 中的同名字段，extras 只补充其余元数据。旧调用如果用冲突 extras 反转裁决，应改为调用对应的 allow/deny 入口；实际 Router 的权限检查链保持独立。

完整权限合同必须是动作映射；字符串、混合类型数组、稀疏数组或显式 null 不能代替它。宿主参数约束必须是字符串枚举，不接受字符串的子串匹配。查询和执行共用校验，非法声明明确拒绝。可用性回调中触发的取消，在首次宿主 context 分配前和最终 handler 入口前重新检查。

`runtime/parameters.ts` 统一参数形状验证和维度提交字段变体。Ajv 检查嵌套 required、items、范围和额外字段规则，不转换类型、填默认值或删除输入。编译缓存按 schema 身份、内容及变体区分，最多保留64项，不共享 `$id` 空间。Core/handler 的证据与业务门继续负责语义判断。

模型描述要求 canonical evidenceRefs 和 scope；执行仍接受旧 sources 输入及 Core 支持的 scope 形式，先由 authoring 从真实台账推导 refs，再过 Core 门。形状通过不代表来源已经证明。进入原生 router 后，tool/action/params 固定为本次调用快照；宿主资源与权限保持活跃引用，排队期间的撤权仍能生效。`execute` 与 `executeChildCall` 的各类回执均保留入场 parentCallId。

接入该新能力端口后，宿主准入拒绝在 handler 前返回 `TOOL_ACTION_DENIED` 或 `TOOL_UNAVAILABLE`，带 `writeState: 'not-started'`、`requiresReadback: false` 和 blocked 状态。未声明可用性的旧宿主保留 handler 错误路径。执行后的 Core 回执和异常继续原样归一化，不能用这类“未开始”标记覆盖已经发生的写入。

可选 `progressEmitter` / `eventBusPublisher` 中间件与 tracker 共用完整回执的成功判定：blocked、aborted、timeout、error、needs-confirmation 或 `ok: false` 均报告失败，即使 payload 中仍有部分读回数据。`ok: true` 的可用 partial 回执保持成功，业务 payload 和原始 envelope 均保留。这两种通知中间件需显式安装；默认 Runtime 仍通过自身事件路径通知宿主。

Handler 的 `_meta.resultStatus` 可显式给出终态，Adapter 优先保留它。终端中断继续保留部分输出与兼容 `ok: true`，消费者必须同时检查 `status`：已取消信号为 aborted，信号明确携带 TimeoutError 为 timeout。旧 sandbox 的 137 还可能来自输出配额强杀；原因不明时为 error，并附 `terminal_execution_interrupted`，不能据部分输出判定命令成功。已经取得的中断输出不再进入无用的压缩调用。

其他非零退出码和 executor 异常同样给出明确失败终态，保留已有 stdout/stderr。`ok: true` 只保留历史“取得了工具输出”的兼容含义，不能单独用来判定命令成功。

## 结果显示边界

每个 adapter 回执独立持有 diagnostics、trust 及诊断数组；普通输出另行复制 cache、失败分类、artifact/resource 元数据。外部回执先用 `isToolResultEnvelope` 检查完整字段和诊断形状，枚举不做字符串强制转换，不因几个同名字段就认定有效。

结构化显示投影保留对象自有数据，支持 null 原型 DTO；Date 使用原生 ISO 表示，无效 Date 为 null。自定义 `toJSON` 和 getter 不执行，循环、不支持值、超过 64 层或 4096 节点的详情以安全占位及 `TOOL_RESULT_DISPLAY_*` 诊断表示。先为当前层字段预留位置，再处理子结构，避免大块详情吞掉同层的回执身份。显示降级不改变已确认的 `ok/status`，不触发写入重试。

内部回执仍保留业务字段；`projectToolResultOrdinaryOutput` / `presentToolResult` 按既有字段规则清理结构化内容和 JSON 文本两个载体，输出不含可执行序列化钩子。纯文本保持原有语义，这不是任意自由文本的敏感内容检测器。

## 可空写回执

Core 公开写口允许返回 null 时，缺回执不能表示未写入或成功。Agent/Main 明确报告 `KNOWLEDGE_WRITE_RECEIPT_UNAVAILABLE`、`writeState: 'unknown'`、`requiresReadback: true`、`retryable: false`。严格生产停止后续 content-ready/CAS；HTTP 批量接口保留已确认成功子集，单列未知项。HTTP publication.confirmed 仍表示原有控制器确认门，不据此推断全批写入成功。

Core 已放入 created 列表并提供 id/lifecycle 的创建回执仍保留；其 raw 详情为空或详情 getter/投影失败只降低详情投影，并给出 `KNOWLEDGE_CREATED_DETAILS_UNAVAILABLE`，不会再提交一次。附加日志、readiness 和会话记录不能覆盖该身份。

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

两种缓存容量必须是非负安全整数；非法值在构造时抛出 `RangeError`，0 继续表示禁用缓存。`SearchCache.makeKey` 使用 JSON 元组区分 pattern、glob 和 regex，避免分隔符碰撞；调用方应把返回值当作不透明键，不手写或解析其格式。升级时重新创建已有缓存实例；真实 code.search 自有的结构化键与写后失效机制保持不变。

## 文件工具与输出

fallback 搜索与 code.read 共用真实路径约束，拒绝项目外符号链接。code.write 仅将 ENOENT 视作新文件；无法读取当前版本时不能绕过写前门。创建目录后、写入前再次检查取消，写入开始后保留实际 IO 结果。开始尝试写入时更新该 SearchCache 实例的私有 generation，避免成功或部分写后继续命中旧搜索；旧 get/set-only 宿主无需新增方法，容量/TTL仍由宿主负责。

搜索展示保留完整命中行；预算容不下的行改为有限 file/line 定位及遗漏说明，不能把剪裁内容作为 verbatim 证据。原始缓存不被展示投影改写，Runtime 末层消息配额继续生效。

rg 的退出码1表示无匹配，其他错误不冒充空成功；仅明确缺少可执行文件时走 JS RegExp fallback。取消、原有15秒期限、输出上限或带命中的失败均保留已观察子集并标记 incomplete，不缓存这类结果。此时 total 仅代表已观察数量。两条搜索路径都兑现 contextLines，周边行与命中内容分开，证据采集只使用完整命中行。

终端 stdout/stderr 保留前导空白，专用解析器只压缩 stdout，stderr 仍进入总预算。复合命令使用通用输出；解析器无法确认格式或完整性时记录降级并保留原文。截断提示本身计入预算，长单行保留头尾。测试、lint 和包管理摘要分开计算总数与展示上限，不能把进度日志或多个运行摘要合成成功结论。

## 终端沙箱

`terminal.exec` 通过 `ToolContext.sandboxExecutor` 执行；沙箱不可用时的降级由执行器自己报告（`diagnostics.sandboxed/fallbackUsed/degradeReason`），Agent 原样带入结果与审计。宿主没有注入执行器时，Agent 在启动任何进程之前拒绝调用，结果状态为 `blocked`，诊断码 `terminal_sandbox_required`。只有 `ToolContext.allowUnsandboxedTerminal === true` 时才以普通子进程执行（继承宿主环境变量），结果带 `[unsandboxed:missing_sandbox_executor]` 标记；该开关面向测试夹具和自担风险的受信宿主，生产宿主不应打开。

## 其他宿主能力

graph 等待同步或异步宿主读取，保留宿主统计字段，不把未完成查询补成零计数。没有方法是能力不可用，方法返回 null 才表示空结果。备用查询保留原优先级及 this，并记录选择路径；取消后不再启动备用读取。当前 Main 没有装配 projectGraph，本能力通过明确的宿主端口接入。

memory.save 和 meta.plan 等待宿主保存调用完成；已开始的保存不通过取消竞速伪造回滚。没有 sessionStore 时，meta.plan 仍能提供结构化规划，但返回 `recorded: false` 与诊断。WorkflowRegistry 继续作为 Agent 侧定义注册表，Core 确定性 workflow 能力仍由 Core 拥有。

## 接入验证

Agent 的 `test/tool-resource-scope.test.ts` 覆盖运行/视图传播与释放、裁剪、旧 window 和迟到 loop；Main 的 `ToolContextScope.test.ts` 覆盖真实 factory/router 隔离和写前门。Main 的 `KnowledgeServiceAdapter.test.ts` 通过真实 Core 与临时 SQLite 验证 DTO、系统字段保护、复核、取消和文件/数据库分歧回执，无需真实模型或 API key。

Schema/准入回归集中在 Agent 的 tool-schema-projection、tool-availability；前者同时覆盖 Runtime 到外部宿主的真实查询与执行链。可选事件中间件位于 runtime-efficiency，任务真值位于 task-tool-outcomes。Main 的 MainToolAvailability 覆盖真实 AgentModule 装配和 HTTP 列表，KnowledgeWriteReceiptBoundary 与严格生产 Facade 集成用例覆盖缺回执时真实写入已发生的情况。

原生参数、调度及父身份回归归 tool-runtime-contract；宿主读取/保存和回执归 tool-system；文件读写与证据配额归 tool-resource-scope；终端安全归 runtime-terminal-safety；压缩器和八类解析器集中到 tool-output-compression。它们使用受控端口、临时目录和模拟进程输出，不依赖真实模型凭据。
