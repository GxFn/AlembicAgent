# @alembic/agent

[English](README.md) | 简体中文

Alembic Agent 是 Alembic 的独立 Agent 运行时包:一个统一的 ReAct
(Thought → Action → Observation)执行引擎、覆盖五家厂商的 AI
provider/transport 栈、以及契约优先的工具系统 —— 从 Alembic
产品仓库中抽离,供宿主通过依赖注入嵌入使用。

- **TypeScript + ESM(NodeNext),Node >= 22**,使用 Biome 统一格式化与 lint。
- 确定性能力(ProjectContext、知识持久化、维度配置、日志)**不在本仓实现**,
  一律通过 `@alembic/core` 包入口消费。

## 本包是什么 / 不是什么

**是:**

- **Agent 执行引擎** —— 唯一的 `AgentRuntime` ReAct 内核,叠加 Strategy
  编排、Policy 约束、Capability 组合与分层记忆/上下文。
- **AI provider 适配层** —— 统一的 `AiProvider` 抽象收敛 OpenAI、Claude、
  Google Gemini、DeepSeek、Ollama 五家厂商,含各厂商 transport、可靠性控制
  (重试 / 熔断 / 并发 / 429 冷却)、参数守卫与结构化输出修复。
- **工具系统** —— 单源工具注册表 + `ToolRouter` + kernel 契约,内建
  `code` / `terminal` / `knowledge` / `graph` / `memory` / `meta`
  六类 handler,附终端安全模型与输出压缩。

**不是:**

- 不含 Core 确定性内核(在 `@alembic/core`)。
- 不含 Dashboard UI(在 `AlembicDashboard`)。
- 不含 Codex MCP / marketplace / 插件交付壳(在 `AlembicPlugin`)。
  宿主只负责构造 `AgentRunInput` 并调用服务层。

以上边界由冻结的可执行 manifest(`AgentRuntimeResponsibility`、
`AgentInterfaceContract`、`AgentRuntimeBoundary`)固化,并由边界 lint
门禁强制(见[验证](#验证))。

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│ Surface Layer   HTTP · CLI · MCP · Workflow(宿主表面)         │
│                 只构造 AgentRunInput                           │
└───────────────────────────────┬──────────────────────────────┘
                                │ AgentRunInput
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ AgentService    统一服务入口 + profile 编译                    │
│                 校验 → AgentProfileCompiler →                  │
│                 (AgentRunCoordinator 扇出?) →                  │
│                 AgentRuntimeBuilder → runtime.execute →        │
│                 规范化 AgentRunResult(异常降级为结构化结果,   │
│                 绝不外抛)                                      │
└───────────────────────────────┬──────────────────────────────┘
                                │ CompiledAgentProfile
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ AgentRuntimeBuilder   profile + DI(container/tools/ai/root)  │
│                       → preset 合并 → strategy 解析 →          │
│                       capabilities → PolicyEngine → Runtime    │
└───────────────────────────────┬──────────────────────────────┘
                                │ new AgentRuntime(config)
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ AgentRuntime    ReAct 循环(Thought → Action → Observation)   │
│   ├─ Capability   技能 / 工具白名单组合                        │
│   ├─ Strategy     Single / Pipeline / FanOut / Adaptive        │
│   ├─ Policy       Budget(硬停机)/ Safety(硬拦截)/          │
│   │               QualityGate(软告警)                        │
│   └─ 横切: 记忆 / 上下文 / 事件 / 诊断 / PCV 证据 / 预算压缩   │
└───────────────────────────────┬──────────────────────────────┘
                                │ tool call
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ Action Layer    ToolRouter → handler(code / terminal /       │
│                 knowledge / graph / memory / meta)            │
│                 只执行动作,不选择 profile                     │
└──────────────────────────────────────────────────────────────┘
```

基线 preset(一个 profile 声明 capabilities、strategy、policies;
`AgentProfileCompiler` 把所有 profile 输入形态统一编译成
`CompiledAgentProfile`):

| Preset      | Capabilities            | Strategy          | Policies          |
| ----------- | ----------------------- | ----------------- | ----------------- |
| `chat`      | Conversation + Analysis | Single            | Budget(8 轮)    |
| `bootstrap` | Analysis + Knowledge    | FanOut + Pipeline | Budget + Quality  |
| `scan`      | Analysis + Knowledge    | Pipeline          | Budget + Quality  |

领域化 run(`src/agent/runs/`:plan、scan、evolution、relation、
translation、module mining)以领域 profile 与结果投影包装同一个服务入口。
`AgentRunCoordinator` 负责扇出:切分 → 并行 child run(child runner 就是
`AgentService.run` 本身)→ 合并;child 失败转为部分结果,不会炸掉整批。

## 目录地图

| 目录 | 职责 |
| ---- | ---- |
| `src/agent/service/` | `AgentService` 入口、`AgentRuntimeBuilder` DI 装配、run 契约、系统运行上下文工厂 |
| `src/agent/runtime/` | `AgentRuntime` ReAct 内核、`LoopContext`、`ExitController`、`BudgetController`、`ToolExecutionPipeline`、LLM 输入装配/计量、钩子/事件/诊断、冻结接口契约、PCV 节点证据(observe-only) |
| `src/agent/profiles/` | Preset、可序列化 profile 定义、`AgentProfileCompiler`、注册表 |
| `src/agent/strategies/` | `Single` / `FanOut` / `Adaptive` / `Pipeline` 编排策略 |
| `src/agent/policies/` | `PolicyEngine` 与 Budget / Safety / QualityGate 三类 policy |
| `src/agent/capabilities/` | Capability 注册表(技能 + 工具白名单组合) |
| `src/agent/memory/` + `src/agent/domain/` | 三层记忆(`ActiveContext` 工作记忆 / `SessionStore` 会话记忆 / `PersistentMemory` SQLite 语义记忆),由 `MemoryCoordinator` 统一协调;证据采集与情节固化 |
| `src/agent/context/` | `ContextWindow`(多级递进压缩)、`ExplorationTracker` 探索追踪、计划跟踪、nudge 引导 |
| `src/agent/prompts/` | Insight 提示词体系(analyst → producer → gate → evolver)与扫描提示词 |
| `src/agent/runs/` + `coordination/` + `tasks/` | 领域化 run、扇出协调、宿主 task 处理器 |
| `src/ai/` | `AiProvider` 抽象、`LLMGateway`、各厂商 transport、`ModelRegistry`、可靠性、`ParameterGuard`、结构化输出 |
| `src/tools/` | kernel 契约、`UnifiedToolCatalog`、runtime 注册/路由、handler、终端安全、输出压缩器 + CLI parser、`DeltaCache` |

## 包出口

子路径入口(见 `package.json` 的 `exports`):`.`、`./agent`、`./service`、
`./runtime`、`./prompts`、`./domain`、`./tasks`、`./profiles`、`./ai`、
`./tools/runtime`、`./memory`、`./context`。

内部 import 使用 `#agent/*`、`#ai/*`、`#shared/*`、`#tools/*` 别名
(`alembic-dev` 条件下解析到 `src/`,否则解析到 `dist/`)。

## 关键运行时保证

- **结构化结果,异常绝不外泄** —— 单次执行路径的异常被降级成完整的
  `AgentRunResult`,状态归一为五态(success / blocked / aborted / timeout /
  error);冻结的 `AgentInterfaceContract` 固化结果分支、普通输出策略与
  失败分类学。
- **预算只压缩,退出归退出** —— session 预算阈值只触发分级上下文压缩;
  终止由 max-iterations / timeout / `ExitController` 退出信号负责,并有
  强制总结兜底,保证最终回复永不为空。
- **工具安全** —— `terminal` 在全局危险命令黑名单 + 只读 allowlist
  双层安全下执行,可用时走沙箱(降级时记审计);`code.write` 强制
  写前新鲜度门(read-before-write / TOCTOU),由 run 级共享的
  `DeltaCache` 支撑。
- **可观测优先** —— 钩子、事件总线、诊断收集器,加上 observe-only 的
  PCV 节点证据引擎(grounding enforcement 默认 `off`);每条
  fallback / 降级 / 重试路径都记录触发条件与选择路径。
- **Token 纪律** —— LLM 输入经计量与预算裁剪;工具输出走
  ANSI strip → 折叠 → 专用 parser 的压缩管线(git / grep / test / lint /
  tree / package 各有 parser),截断保首尾。

## 安装与本地开发

Workspace 本地开发刻意通过相邻源码 checkout 消费 Core
(local-source-first 基线):

```json
"@alembic/core": "file:../AlembicCore"
```

```bash
npm install
npm run build        # tsc -> dist/
npm test             # vitest run(mock provider,不需要真实 API key)
```

运行时依赖:`@alembic/core`、`better-sqlite3`、`drizzle-orm`、`undici`。

## 验证

`npm run check` 是完整门禁链:typecheck、Biome lint,以及边界/契约门禁 ——

| 门禁 | 强制内容 |
| ---- | -------- |
| `lint:agent-import-boundary` / `lint:core-import-boundary` | 只允许包入口 import;不得伸进 Core 内部路径 |
| `lint:public-api-boundary` + `smoke:public-signatures` | 冻结的公共 API 表面与签名 |
| `lint:layer-contract` / `lint:space-edges` | 分层与模块边规则 |
| `lint:doctrine` | 副作用信条 —— 无 import-time 工作,副作用一律经注入端口流动(见 `docs/side-effect-doctrine-census.md`) |
| `lint:naming` / `lint:retired-symbols` | 命名规则;已退役符号不得复活 |
| `verify:validation-floor` | 最低验证下限 |
| `test` | vitest 套件(`test/`),含接口契约、终端安全、PCV observe-only 表征/验收测试 |

AI provider 改动必须用 mock provider 通过测试 —— 测试绝不依赖真实
API key。入口点的已声明副作用固化在 `docs/entrypoint-effects.md` 与
`test/entrypoint-effects.test.ts`。

## 发布

发布预览单独 staging:

```bash
npm run release:pack-preview
```

`release:stage` 先构建,再把发布包 stage 到 `tmp/release/` 下;staged
manifest 会把本地 `file:../AlembicCore` 依赖替换成 registry 版
`@alembic/core`,并把 Core 源码 commit 记录进 `.alembic-source.json`。
`prepack` 挂了 `release:package-guard`,从仓库根直接 `npm pack`
无法把开发版 manifest 发出去。

## 许可证

MIT
