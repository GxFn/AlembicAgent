# LLM 接入与调用合同

OpenAI、Ollama、Google、Claude、DeepSeek 的生成协议均由固定版本的 Vercel AI SDK provider 处理。既有 Provider、Transport 类名和包入口保持可用；厂商装配与策略留在各 transport，共同消息、结果和错误映射集中在内部 SDK 模块。

| Provider | 生成 | Embedding |
| --- | --- | --- |
| OpenAI / Ollama | OpenAI SDK，显式选择 chat/responses 协议 | OpenAI SDK |
| Google | Google SDK 原生协议 | Google SDK，Gateway 按 100 项分批重试 |
| Claude | Anthropic SDK 原生协议 | 继续明确声明不支持 |
| DeepSeek | DeepSeek SDK 原生协议，保留 V4 策略和文本工具兼容 | SDK 无此接口；保留已有可配置 `/embeddings` 兼容端点并验证返回向量，不宣称官方 DeepSeek 服务支持 |

调用链为 `AiProvider → LLMGateway → Transport → 模型服务`。SDK 使用公开的 V4 单次模型接口 `doGenerate` / `doEmbed`；它不执行 Alembic 工具、不自动修复工具调用，也不负责网络重试。Gateway 继续管理并发、限流、熔断和重试，AgentRuntime 继续管理运行预算、阶段和工具权限。Google 的已完成 embedding 批次保留在本次调用局部，后续批次失败不会重放它们。

## 配置解析与装配

Factory 选择逻辑 provider，公共 Provider 保留宿主所需的身份与回执字段，内部 `configuration.ts` 统一解析模型、连接和适配器选项。Transport 使用同一解析规则，SDK 不再自行从厂商通用环境变量读取凭据。配置、模型能力 Registry、请求参数策略和网络代理各有一个负责入口。

| 配置 | 规则 |
| --- | --- |
| provider | Factory 接受既有 `gemini` / `google-gemini` / `anthropic` 别名和大小写；Gateway 的显式模型前缀也使用同一别名规则。未知显式 provider 报错。 |
| endpoint | 非空显式 `baseUrl` > 对应 `ALEMBIC_<PROVIDER>_BASE_URL` > 注册默认值；优先级不取决于是否同时传 key。Google 裸根补 `/v1beta`，Ollama 裸根补 `/v1`，显式代理路径保留。 |
| credential | 显式 `apiKey` > 对应 Alembic 环境变量；`undefined` 表示继承，**空字符串表示保持无凭据**，不会从环境补回。未配置 Ollama key 时使用本地 dummy key。 |
| 生成模型 | 显式 `model` > 属于当前 provider 的 `ALEMBIC_AI_MODEL` > 注册默认模型。Google/Ollama 的直接构造也遵守该规则。未指定 provider 或指定 `auto` 时，全局模型供选中的主 provider 使用；切换到 fallback 时使用目标 provider 默认模型。 |
| embedding 模型 | 显式 `embedModel` > 属于当前 embedding provider 的 `ALEMBIC_EMBED_MODEL` > 厂商默认模型。独立 `createEmbedProvider()` 同步设置公开 `model` 与实际 embedding 模型，避免宿主回执记录成生成模型。 |
| 协议与推理 | OpenAI `apiStyle` > `ALEMBIC_OPENAI_API_STYLE` > `chat`；Ollama 不继承 OpenAI 的环境协议。DeepSeek `reasoningEffort` > 对应环境变量 > `high`，保留 `high/max` 规则。非法枚举保留原兼容默认并记录诊断。 |
| 并发 | 显式值 > Google 专属环境变量 > 通用环境变量 > 默认值；接受正整数字符串，拒绝零、负数、小数、NaN 和无穷值。公开容量提示与实际闸门共用解析结果和来源。 |

Provider、Gateway、直接 Transport 在创建时固定模型服务配置，惰性创建 SDK 不会重新吸入后来变化的 key、endpoint 或协议。重新配置请创建新实例；共享 Gateway 可通过 `getLLMGateway(config)` 重建。网络代理仍按请求读取既有代理变量，其优先级未改动。

兼容默认仍保留：Facade 超时 300 秒，直接 Gateway/Transport 超时 120 秒；Facade 默认重试 3 次，Claude 默认 0 次；Google Facade 默认并发 2，其余 Facade 及直接 Gateway 默认 4。Ollama Facade 的默认地址为 `localhost:11434/v1`，直接 Gateway 的注册默认为 `127.0.0.1:11434/v1`。自动发现顺序仍为 Google→OpenAI→Claude→DeepSeek，错误回退候选顺序仍为 Google→OpenAI→DeepSeek→Claude。

OpenAI、Claude、DeepSeek 的公开 `baseUrl` 保留配置原字符串，SDK 负责 API 路径规范化；尤其不能改写 DeepSeek 端点导致宿主严格回执不匹配。错误与规范化诊断只记录字段、provider 和处理结果，不输出 key 或完整 endpoint。已知字符串字段类型不合法时，在构造边界抛 `LLM_INVALID_REQUEST`。

升级时若原调用传 `apiKey: ''` 以继承环境，应改为省略该字段或传 `undefined`。`TransportConfig.apiKey` 已改为可选。DeepSeek 的兼容 embedding 请求现在使用有效 `embedModel`，仍不表示官方服务提供 embedding API。

## 调用和取消

`chat`、`chatWithTools`、`chatWithStructuredOutput`、`embed`、`summarize` 和 `probe` 都接受可选的 `abortSignal`。旧调用参数仍然有效。

```ts
import { OpenAiProvider } from '@alembic/agent/ai';

const provider = new OpenAiProvider({
  apiKey: process.env.ALEMBIC_OPENAI_API_KEY,
  model: process.env.ALEMBIC_AI_MODEL,
  maxRetries: 1,
});
const controller = new AbortController();
const value = await provider.chatWithStructuredOutput('生成标题', {
  abortSignal: controller.signal,
  schema: {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
    additionalProperties: false,
  },
});
```

取消会穿过排队、HTTP 和响应读取边界；宿主传入的任意取消原因统一为 `AbortError`，原原因保留为 cause。单次请求超时保持 `ETIMEDOUT`，继续由 Gateway 的重试策略处理。取消不应计为模型服务故障；已经取消的请求不会因迟到响应重新成功。

| 方法 | 普通失败/不可用的兼容语义 | 取消 |
| --- | --- | --- |
| `chat` / `chatWithTools` | 请求失败抛错；非法工具参数不会变成可执行的 `{}` | 抛 `AbortError` |
| `chatWithStructuredOutput` | 解析或 schema 不符返回 `null`；请求失败仍抛错 | 抛 `AbortError` |
| `embed` | 旧 facade 对普通失败返回 `[]`，保留上层检索降级；直接 transport 抛错 | 抛 `AbortError`，不降为空向量 |
| `AiProvider.probe` | 请求错误抛错 | 抛 `AbortError` |
| `LLMGateway.probe` | 普通请求失败返回 `false` | 抛错并停止 `resolveWithFallback` |

宿主必须逐级转发 signal。Provider 接受取消参数不代表 Core 搜索、批量 embedding 或所有后台 job 已自动获得父取消信号。不要用全局可变 signal 绑定共享 provider。

## 结构化输出

未传 `schema` 时，保留原有 JSON 提取行为。传入 `schema` 时，先用 Ajv 编译原始 schema，失败则不发模型请求；返回完整 JSON 后执行本地验证。可以去掉最外层 JSON 代码围栏，但不会修复截断 JSON 后当成完整结果。

默认使用 JSON Schema draft-07；显式声明的 2019-09、2020-12 使用相应实例。支持 ajv-formats 的标准格式；未知关键字、不支持的 draft、未解析引用、异步 schema 明确拒绝。不会请求远端 schema，也不会补默认值、强制转换类型或删除额外字段。验证器按调用持有，避免同 `$id` 或修改过的 schema 串用。

schema 只验证输出结构，不替代 Strict 知识生产的证据、结束原因和写入回执检查。失败/修复路径可通过 `structured-output` 诊断区分。

## 模型协议与兼容边界

- OpenAI 默认仍为 Chat Completions；通过 `apiStyle: 'responses'` 或 `ALEMBIC_OPENAI_API_STYLE` 明确选择 Responses。Ollama 使用自身逻辑身份和代理配置，默认不继承 OpenAI 的全局协议选择。
- Google 使用 `x-goog-api-key` 请求头及原生 `parametersJsonSchema` / `responseJsonSchema` 字段，支持 `ALEMBIC_GOOGLE_BASE_URL`；自定义代理应兼容这些原生字段。Claude 的 system 使用原生内容块格式，schema 选择 `output_config.format`，不自动创建 JSON 格式化工具；显式 `maxRetries` 由 Gateway 执行，默认仍为 0。
- `toolChoice: none` 是调用者的禁用意图，即使厂商不支持同名 wire 参数，也不暴露可调用工具；违背该意图的工具建议会被拒绝。原生和 DeepSeek 文本转译的参数共用 schema 校验，同次响应的重复调用 ID 明确拒绝。
- SDK 现在验证原生 HTTP 响应形状。mock/兼容代理应返回真实协议字段，例如 Chat 的 `choices[].index` 和 Responses 的 `output` 内容块。仅返回客户端派生便利字段 `output_text` 的对象不属于原生 Responses wire 合同。
- Responses 的服务端 reasoning item 引用，以及其他协议的 thinking、签名和 opaque/redacted 块，随消息经过 Gateway、AgentRuntime 和两种消息适配器回传。续接数据按 provider、model 和连接摘要隔离，不携带原始 endpoint 或凭据。内容块保留顺序，可见文本以范围引用、工具以 ID 引用，避免再复制整份业务历史；更换连接或历史投影变化时记录不兼容诊断。普通进度事件省略推理原文和签名。Responses 模式仍依赖服务端 item 保存期限；未新增 stateless encrypted-reasoning、SSE 或多模态入口。
- 带续接信息的 assistant 消息保持原子性，L2 文本合并不会破坏其范围引用和签名序列；预算估算包含仍可能回传的旧 reasoning 内容，避免只计最近两轮，也避免与 replay 块重复计数。
- DeepSeek V4 工具模式保留 reasoning 回传、`tool_choice` 省略和原有 reasoning 输出预算下限，预算提升会记录诊断；孤立工具历史仍显式转为文本。文本 `<function_calls>` 转译有独立诊断与调用 ID 前缀，不等同原生调用。
- 用量与当前响应一起返回；缓存读取/创建和 reasoning 细分仅在上报时返回，异常或负数计数不进入预算。Claude 输入总量包含缓存输入，Google 输出总量包含 thinking。响应含无效工具调用时，已确认用量仍上报一次。HTTP 2xx 的无效协议 body 归为 `LLM_INVALID_RESPONSE`，不伪造空文本成功；SDK 原始错误 body/请求信息不进入普通错误链。
- 已识别的 SDK 本地参数/能力错误归为 `LLM_INVALID_REQUEST`，不伪造 HTTP 状态、不重试、不计入服务端熔断；调用者修正输入后仍可使用同一 Provider。
- embedding 验证数量、索引、维度与有限数值，并按原输入顺序返回。保留旧入口的每项 8000 字符边界并记录截断诊断。单次 OpenAI embedding 超过 SDK 上限会明确失败，由现有调用者批处理；adapter 不隐藏分批重放。

## 开发验证

使用 Node 22+。Provider 测试采用真实 SDK + fake HTTP，运行不需要真实 API key。`test/ai-configuration.test.ts` 集中覆盖入口配置、容量提示、URL 规则、快照和回执兼容；原独立容量提示测试已合入此处。`test/openai-sdk.test.ts` 与 `test/native-provider-sdk.test.ts` 覆盖原生协议、错误/重试、embedding、私有字段回传及真实 Runtime 工具回合；`test/structured-output-validation.test.ts` 以同一合同矩阵覆盖各公开 structured 入口。

依赖升级必须同时验证协议 fixture、取消与超时、细分用量、工具参数、推理回传、代理、公共导出及边界检查。运行 `npm run check` 完成仓库验证。
