# Memory runtime：读取、预算与向量缓存

Agent 保留记忆策略和装配，Core 提供现有 SQLite schema 和公共 IO/search 能力。此设计没有新增数据库、索引服务或宿主代理。

## 实际调用链

`insightPreset → buildAnalystPrompt → readPersistentMemorySection → PersistentMemory → MemoryRetriever` 是 Analyst 历史记忆的真实读链。`AgentRuntime → MemoryCoordinator.buildDynamicMemoryPrompt` 负责每轮工作记忆。`MemoryCoordinator.buildMemoryPrompt` 是可组合三层记忆的公共便利入口。

`MemoryReadPolicy` 只管理单次读取的期限、取消和诊断。`MemoryPrompt` 统一预算分配、section 来源与实际 token 估算。Facade、检索、会话存储各保留本来的职责，宿主仍可注入兼容端口。

`ActiveContext.maxRecentRounds` 与 `MemoryCoordinator.createDimensionScope` 的同名配置共用校验：缺省为 3，显式 0 表示立即压缩；负数、小数、NaN 与无穷值在创建时抛出 `RangeError`，避免压缩循环无法退出。非法 scope 配置不会替换当前上下文或清除已有预算。观察保留与 `memory.note_finding` 写入回归集中在 `test/ActiveContext.test.ts`，L4 记忆包与压缩回归集中在 `test/ContextWindow.test.ts`。

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

内容 hash 不包含 embedding 模型身份。宿主切换到不同模型，特别是维度相同的模型时，应调用 `clear()` 并重新回填，不能把正文一致误当向量空间一致。

## 诊断与验证

诊断包含读取阶段、状态、原因及必要预算，不记录查询、记忆正文、凭证或 provider 原始异常。诊断回调自身抛错不会打断执行；回调触发取消后仍会在写入前复查。

`memory-context.test.ts` 覆盖真实 SQLite / sidecar、预算、期限、并发 scope、版本及重试；`llm-input-layering.test.ts` 覆盖真实 Analyst preset 接线和反思去重。Provider/Transport 测试分别按公开配置与协议边界整合，保留各自独立输入、断言和清理 hook。
