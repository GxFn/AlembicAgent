# Memory runtime：读取、预算与向量缓存

Agent 保留记忆策略和装配，Core 提供现有 SQLite schema 和公共 IO/search 能力。此设计没有新增数据库、索引服务或宿主代理。

## 实际调用链

`insightPreset → buildAnalystPrompt → readPersistentMemorySection → PersistentMemory → MemoryRetriever` 是 Analyst 历史记忆的真实读链。`AgentRuntime → MemoryCoordinator.buildDynamicMemoryPrompt` 负责每轮工作记忆。`MemoryCoordinator.buildMemoryPrompt` 是可组合三层记忆的公共便利入口。

`MemoryReadPolicy` 只管理单次读取的期限、取消和诊断。`MemoryPrompt` 统一预算分配、section 来源与实际 token 估算。Facade、检索、会话存储各保留本来的职责，宿主仍可注入兼容端口。

`ActiveContext.maxRecentRounds` 与 `MemoryCoordinator.createDimensionScope` 的同名配置共用校验：缺省为 3，显式 0 表示立即压缩；负数、小数、NaN 与无穷值在创建时抛出 `RangeError`，避免压缩循环无法退出。非法 scope 配置不会替换当前上下文或清除已有预算。观察保留与 `memory.note_finding` 写入回归集中在 `test/ActiveContext.test.ts`，L4 记忆包与压缩回归集中在 `test/ContextWindow.test.ts`。

`ActiveContext.distill()` 同时包含已压缩观察与滑动窗口里最新的观察，调用蒸馏不推进保留状态。公开的计划、发现、序列化快照拥有嵌套数据副本；只有明确命名的 `getPlanStepsMutable()` 供阶段机写回进度。批量读取按每个成员的实际回执记录成功路径，失败文件不进入已读集合或计划完成判断。

L4 使用结构化记忆包，成功替换前重新核对消息快照与读取视图版本；并发追加、阶段重置或另一轮压缩会使旧摘要失效。已付用量仍返回，日志失败也不改变压缩结果。Runtime 将已确认提交事实独立传入消息历史，不用经过字符裁剪的显示文本推断是否写入成功；该内部 metadata 不进入 SDK 请求。L2 保留 nudge/记忆摘要边界，替换引导文字不会删除相邻用户事实。

## 写入与恢复

`EpisodicConsolidator` 先提取候选；`clearPrevious=true` 经现有 `consolidate` 选项 `clearPreviousBootstrap` 传递，在同一 SQLite 事务中清理旧 bootstrap 记忆、维护和写入新候选。提取失败不触及存储，任一写入失败整体回滚。默认 `PersistentMemory` 支持该选项；自定义语义记忆端口须实现同样的原子替换语义。普通 `clearBootstrapMemories()` 入口仍保留。

同批候选按顺序解决冲突，每个候选都能看到本事务中前一个候选的写入。固化、scope 创建、记忆读取及检查点日志属于观察通道，异常或异步拒绝不会覆盖已确认结果。

`SessionStore.storeDimensionReport()` 在校验完整新报告后替换该报告及其派生证据、交叉引用；独立 `addEvidence()` 数据保留。检查点中的 `reportDimId` 标识派生索引归属，普通证据查询会移除此内部字段。旧快照通过原报告匹配已有索引，旧 `E-id=path` 键归一到真实路径。查询、Producer 投影和 `toJSON()` 返回独立快照；顶层项目便捷配置与 `projectContext` 合并，显式 `projectContext` 优先。

检查点先写同目录临时文件，再 rename 替换目标；写入或重命名失败保留上次有效文件并抛出错误。注入 WriteZone 时写入、重命名与清理走同一边界。`MemoryCoordinator.checkpoint()` 仍是记录失败诊断的兼容便利入口，需要确认持久化的宿主应直接等待 `saveCheckpoint()`。这提供原子文件替换，不宣称跨进程事务或断电持久性。

`ConversationStore` 使用同一个 data zone 读取和写入；损坏的 JSONL 记录逐条跳过并报告，合法相邻记录保留。读取预算包含截断标记，过长摘要不挤掉最近消息；摘要生成期间的对话变更会使旧结果失效。

## 探索与 Producer 接口

探索计数采用执行回执，失败调用只计尝试；深度配额使用同一条已核实发现的实际深度槽交集。Producer 停滞提醒使用距上次成功提交的轮数。提示层共享确认/未确认发现的投影，按完整事实记录去重，保留原始代码片段与不同证据。

冷启动 Producer 使用已有 evidence，扫描 Producer 保留 `ScanProduce` 实际开放的定向 `code.read`；提示不为任何阶段增加工具权限。`note_finding` 使用顶层 `evidenceRefs`，维度知识提交使用 `params.reasoning.evidenceRefs`。Core 的 evidence starter map 与旧数组形态均可进入现有 Producer 装配。

## 读取与预算

- `retrieve`、`toPromptSection`、`embedAllMemories`、`computeEmbeddingRelevance` 接受可选 `abortSignal`、`timeoutMs`、`deadlineAt`、`onDiagnostic`。旧调用不需要新增参数。
- 默认读取期限为 5000ms；显式零时长立即结束，显式 `Infinity` 允许调用方取消时间限制。非法时间值回到有界默认值并产生诊断。
- 嵌套读取和批量回填共享绝对 deadline；Prompt 端口给内层召回留出少量渲染收尾时间。超时不随每个条目重新开始。
- embedding 故障、无效向量或超时时保留词汇相关性结果；用户取消时丢弃迟到输出，不更新访问热度。访问计数只记录真正返回或注入的记忆。
- 真实 Analyst 的会话摘要与持久记忆分别受共享 analyst profile 预算控制，默认 4000 总预算中的 1400 与 600 tokens。旧自定义端口即使忽略预算，装配边界仍会裁剪。
- 一层失败不屏蔽另一层。SessionStore 已提供的 reflection 不重复注入；按任务关键词优先放入相关维度和发现，再由现有 `memory.get_previous_evidence` 查询详情。
- Coordinator 的预算余量按 scope 保存。同一次组合装配固定起始总预算；并行读取、配置变更或另一维度的 `allocateBudget` 不会扩大该请求的额度。旧 `_lastSurplus` 仅保留作诊断兼容。
- 所有记忆裁剪共用 CJK 感知估算并计算分隔符和裁剪说明；这是一致的本地估算，不声称等同某个厂商的精确 tokenizer。

## 宿主调用

```ts
const matches = await persistentMemory.retrieve('transaction boundary', {
  limit: 5,
  timeoutMs: 1000,
  abortSignal: controller.signal,
  onDiagnostic: event => diagnostics.record(event),
});

const count = await persistentMemory.embedAllMemories(20, {
  timeoutMs: 5000,
  abortSignal: controller.signal,
});
```

示例中的 `persistentMemory`、`controller` 和诊断接收器由宿主注入。embedding 回调现在可以接收第二个可选参数 `{ abortSignal }`，单参数 `(text) => provider.embed(text)` 仍兼容。若宿主忽略 signal，Agent 能停止等待并拒绝迟到结果，不能代替宿主取消实际 HTTP 请求。

`insightPreset` 从 strategy context 转发 `abortSignal`，并支持 `memoryReadTimeoutMs`、`memoryTokenBudget` 覆盖；读取诊断进入当前 run 的 DiagnosticsCollector。直接调用 `buildAnalystPrompt` 可通过末尾可选 memory options 参数传入同类控制。

## 向量 sidecar v2

`.asd/context/memory_embeddings.json` 保存可重建缓存，记忆正文仍在既有 SQLite 表中：

```json
{
  "schemaVersion": 2,
  "embeddings": {
    "memory-id": { "vector": [0.1, 0.2], "contentHash": "<正文的 sha256>" }
  }
}
```

`get(id)`、`set(id, vector)`、`batchSet` 等旧接口保留。v1 的 `id → number[]` 文件仍可读；内容感知召回只使用有匹配正文 hash 的向量。旧记录或正文变化后的记录会由下一次 `embedAllMemories` 回填，期间词汇召回仍可用。旧程序读取 v2 缓存可能将其视为需重建缓存，因此回滚前应按该版本重新生成；不涉及数据库迁移或事实数据丢失。

向量数组在读写边界复制，拒绝无效数值和零向量。查询 embedding 返回后重新读取活跃记忆；批量回填在写入前再次核对当前正文、过期状态和取消信号。

写入采用临时文件加 rename；注入 WriteZone 时，读写和临时文件都使用同一公共 IO 边界。写入失败保留 dirty，后续显式 `flushSync()` 或新的写入可重试。`dispose()` 尝试 flush 并释放自身定时器，之后拒绝新变更；若最后一次写失败，仍允许显式 flush 重试。debounce timer 不会延长进程寿命，因此短任务退出前应显式 flush 或 dispose。宿主负责关闭自己创建的 embedding store 和数据库，PersistentMemory 不擅自关闭借入资源。

内容 hash 描述正文；向量空间另由 `profileId` 标识。以不同 profile 创建 store 时不会复用旧空间的缓存，维度相同也不能绕过该检查。若宿主直接更换已有实例的 embedding 函数，须同步管理 profile 或显式 `clear()` 后回填。LLM 路由与独立 embedding 接线分开。

## 诊断与验证

诊断包含读取阶段、状态、原因及必要预算，不记录查询、记忆正文、凭证或 provider 原始异常。诊断回调自身抛错不会打断执行；回调触发取消后仍会在写入前复查。

`memory-context.test.ts` 覆盖真实 SQLite / sidecar、预算、期限、并发 scope、版本及重试；`llm-input-layering.test.ts` 覆盖真实 Analyst preset 接线和反思去重。Provider/Transport 测试分别按公开配置与协议边界整合，保留各自独立输入、断言和清理 hook。
