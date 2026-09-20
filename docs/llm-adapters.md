# LLM 接入与调用合同

OpenAI 和 Ollama 的 OpenAI 兼容协议由固定版本的 Vercel AI SDK provider 处理。公开的 `OpenAiProvider`、`OllamaProvider`、`OpenAiTransport` 与包入口保持可用。Google、Claude、DeepSeek 目前继续使用各自的 transport。

调用链为 `AiProvider → LLMGateway → Transport → 模型服务`。SDK 使用公开的 V4 单次模型接口 `doGenerate` / `doEmbed`；它不执行 Alembic 工具、不自动修复工具调用，也不负责网络重试。Gateway 继续管理并发、限流、熔断和重试，AgentRuntime 继续管理运行预算、阶段和工具权限。

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
- SDK 现在验证原生 HTTP 响应形状。mock/兼容代理应返回真实协议字段，例如 Chat 的 `choices[].index` 和 Responses 的 `output` 内容块。仅返回客户端派生便利字段 `output_text` 的对象不属于原生 Responses wire 合同。
- Responses 的服务端 reasoning item 引用随消息保存，并经过 Gateway、AgentRuntime 和两种消息适配器回传；它们按 provider、model 和连接摘要隔离，不写入原始 endpoint 或凭据。更换连接时过滤不可复用的引用并记录诊断。当前模式依赖服务端保存的 item；本次没有新增 stateless encrypted-reasoning、流式或多模态能力。
- 用量与当前响应一起返回；未上报的细分项不伪造成零。响应包含无效工具调用时，已确认用量仍上报一次。SDK 原始错误 body/请求信息不进入普通错误链。
- embedding 验证数量、索引、维度与有限数值，并按原输入顺序返回。保留旧入口的每项 8000 字符边界并记录截断诊断。单次 OpenAI embedding 超过 SDK 上限会明确失败，由现有调用者批处理；adapter 不隐藏分批重放。

## 开发验证

使用 Node 22+。Provider 测试采用真实 SDK + fake HTTP，运行不需要真实 API key。`test/openai-sdk.test.ts` 覆盖原生协议、错误/重试、embedding 及真实 Runtime 工具回合；`test/structured-output-validation.test.ts` 以同一合同矩阵覆盖各公开 structured 入口。

依赖升级必须同时验证协议 fixture、取消与超时、细分用量、工具参数、推理回传、代理、公共导出及边界检查。运行 `npm run check` 完成仓库验证。
