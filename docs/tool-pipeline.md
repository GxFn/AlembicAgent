# 工具执行管道：职责与依赖

`AgentRuntime` 通过 `createToolPipeline()` 运行工具。`ToolExecutionPipeline.ts` 保留公开 class、注册方法和默认装配；实际职责按模块放在 `runtime/toolPipeline/`。`@alembic/agent/runtime` 只公开 `createToolPipeline` 与 `ToolExecutionPipeline` 两个管道入口，单个中间件不再从包入口导出。

## 文件职责

| 文件 | 唯一职责 | 不承担的职责 |
| --- | --- | --- |
| `runtime/ToolExecutionPipeline.ts` | 中间件注册表、公开兼容入口、默认组装顺序 | 工具请求翻译、缓存准入、业务记账 |
| `toolPipeline/contracts.ts` | 共享调用、metadata、middleware 与 executor 类型 | 任何运行时加载或副作用 |
| `toolPipeline/engine.ts` | 顺序执行 before / executor / after，汇总执行计数 | 导入工厂、路由器、策略或 handler |
| `toolPipeline/callNormalization.ts` | 工具字段读取、直接 note_finding 到 memory 请求的兼容翻译 | 权限决定、执行、缓存 |
| `toolPipeline/runtimeBridge.ts` | 唯一宿主路由调用点，装配请求并处理 envelope/异常 | 阶段准入、候选创建、结果缓存 |
| `toolPipeline/accessGates.ts` | capability 白名单、参数大小、Runtime SafetyPolicy 与命令约束 | 执行工具或存储结果 |
| `toolPipeline/phaseGates.ts` | Evolution、record repair、Analyst VERIFY、Producer 的动作范围 | 宿主传输和结果记账 |
| `toolPipeline/duplicateCache.ts` | 绑定 snapshot 和策略的只读结果复用 | 可变状态读取、副作用、失败结果缓存 |
| `toolPipeline/observations.ts` | 证据采集、tracker/trace 观察 | 工具调度、提交内容验证、宿主事件通知 |
| `toolPipeline/submissionLedger.ts` | 对真实持久化候选登记覆盖信息 | 创建候选、AI 修复、权限决策 |

Core 继续拥有确定性知识生产能力；工具 handler 继续拥有具体工具动作。管道不复制这两层的实现。

## 执行顺序与接口语义

默认 before 顺序是：allowlist → 参数大小 → Runtime safety → Evolution → record repair → Analyst VERIFY → Producer → snapshot cache。之后调用宿主路由。

默认 after 顺序是：snapshot cache → evidence → tracker → trace → submission ledger。缓存保留采集标注前的结果；随后证据注入 envelope，trace 看到带标注的结果，tracker 的 isNew 再传给 trace。

- `before` 返回 `blocked: true` 会阻止后续 before 与宿主调用。
- 显式 `result` 同样短路，`null`、`false`、`0`、空字符串都是有效结果；`undefined` 表示继续。非 blocked 的短路只表示跳过宿主调用，引擎不会把它记为缓存命中；是否算命中由短路中间件自己写 `metadata.cacheHit` 声明（snapshot 复用还会写 `duplicateShortCircuit`）。未声明命中的短路会留一条 `TOOL_SHORT_CIRCUIT_NOT_COUNTED_AS_CACHE_HIT` 日志。
- 短路后仍按注册正序执行所有 after。这里不是 onion middleware 的逆序回卷。
- 自定义 before/after 抛错继续向上传播；不会为了统计完整而吞掉安全门禁异常。需要容错的证据采集在自身边界处理并记录降级。
- 宿主执行抛错或返回非 Error 拒绝值，由 bridge 归一化为明确 error。失败不进入 duplicate cache；下一次相同调用重新触达宿主，成功后才允许复用。这不是引擎自动重试。

`new ToolExecutionPipeline()` 仍用于显式自定义组装，但只能装入调用方自己的中间件；仓库内置的控制门和观察者不再单独公开，需要它们时使用 `createToolPipeline()`。工具事件只由 Runtime 在结果格式化后发送，管道不提供通知中间件。

## 类型与共享身份

内部实现依赖窄的 `ToolRuntimePort`、`ToolLoopPort`。公开 `use/execute` 的上下文保留完整 `AgentRuntime` 和 `LoopContext`，已有自定义 middleware 不会因拆分丢失方法类型。

`ToolMetadata` 以既有公共类型为单源，内部只扩展 `cacheKey`。请求桥保持 sharedState、Set、memory coordinator、evidence ledger 和 AbortSignal 的引用身份；不通过深拷贝制造另一套运行状态。

## 可执行分层

`config/layer-contract.json` 的 `fileBoundaries` 明确每个文件可以使用的运行时依赖。engine 和 contracts 的允许列表为空；engine 的执行器由入口注入。`toolPipeline/` 下新增文件必须登记，不能悄悄形成反向依赖。

`lint:layer-contract` 使用 TypeScript AST 区分真实运行时引用和类型桥，并将 relative 与 `#alias` 写法映射到同一源码路径。受约束文件的非字面动态加载无法审查时拒绝；外部包及 `node:` 依赖也按原 specifier 精确约束。类型桥仍豁免，现有顶层 agent/ai/tools/shared 规则继续生效。静态门禁不分析任意函数别名、eval 或宿主注入函数的实现。

## 验证入口

- `runtime-efficiency.test.ts`：public use/execute 生命周期、短路值、异常传播、真实默认链观察顺序、失败→恢复→缓存。
- 原 EvidenceCapture、phase-chain、ExplorationStrategies、tool contract 与 lifecycle 测试继续验证接线、权限、取消、证据和提交。
- `layer-contract.test.ts`：实际 CLI 在临时仓库上的正反例，防止目录拆分后规则无效。
- 真实 strict consumer 编译公开 middleware 上下文；公共签名和 import smoke 保持入口边界。
