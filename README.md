# @alembic/agent

English | [简体中文](README.zh-CN.md)

Alembic Agent is the standalone runtime package for Alembic's agent
orchestration: a single ReAct (Thought → Action → Observation) execution
engine, an AI provider/transport stack covering five vendors, and a
contract-first tool system — extracted from the Alembic product repository so
hosts can embed it through dependency injection.

- **TypeScript + ESM (NodeNext), Node >= 22**, formatted/linted with Biome.
- Deterministic capabilities (ProjectContext, knowledge persistence, dimension
  configs, logging) are **not** implemented here — they are consumed through
  the `@alembic/core` package entrypoints.

## What this package is / is not

**Is:**

- **Agent execution engine** — one `AgentRuntime` ReAct kernel plus Strategy
  orchestration, Policy constraints, Capability composition, and layered
  memory/context.
- **AI provider layer** — a unified `AiProvider` abstraction over OpenAI,
  Claude, Google Gemini, DeepSeek, and Ollama, with per-vendor transports,
  reliability control (retry / circuit breaker / concurrency / 429 cooldown),
  parameter guarding, and structured-output repair.
- **Tool system** — a single-source tool registry + `ToolRouter` + kernel
  contracts, with built-in `code` / `terminal` / `knowledge` / `graph` /
  `memory` / `meta` handlers, a terminal safety model, and output compression.

**Is not:**

- Not the Core deterministic kernel (lives in `@alembic/core`).
- Not the Dashboard UI (lives in `AlembicDashboard`).
- Not the Codex MCP / marketplace / plugin delivery shell (lives in
  `AlembicPlugin`). Hosts only construct an `AgentRunInput` and call the
  service layer.

These boundaries are pinned by frozen, executable manifests
(`AgentRuntimeResponsibility`, `AgentInterfaceContract`,
`AgentRuntimeBoundary`) and enforced by boundary lint gates (see
[Verification](#verification)).

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Surface Layer   HTTP · CLI · MCP · Workflow (hosts)           │
│                 only construct an AgentRunInput               │
└───────────────────────────────┬──────────────────────────────┘
                                │ AgentRunInput
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ AgentService    unified entrypoint + profile compilation      │
│                 validate → AgentProfileCompiler →             │
│                 (AgentRunCoordinator fan-out?) →              │
│                 AgentRuntimeBuilder → runtime.execute →       │
│                 normalized AgentRunResult (errors degraded    │
│                 to structured results, never thrown)          │
└───────────────────────────────┬──────────────────────────────┘
                                │ CompiledAgentProfile
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ AgentRuntimeBuilder   profile + DI (container/tools/ai/root)  │
│                       → preset merge → strategy resolution →  │
│                       capabilities → PolicyEngine → Runtime   │
└───────────────────────────────┬──────────────────────────────┘
                                │ new AgentRuntime(config)
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ AgentRuntime    ReAct loop (Thought → Action → Observation)   │
│   ├─ Capability   skill / tool-allowlist composition          │
│   ├─ Strategy     Single / Pipeline / FanOut / Adaptive       │
│   ├─ Policy       Budget (hard stop) / Safety (hard block) /  │
│   │               QualityGate (soft warning)                  │
│   └─ cross-cutting: memory / context / events / diagnostics / │
│                     PCV evidence / budget compression         │
└───────────────────────────────┬──────────────────────────────┘
                                │ tool call
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ Action Layer    ToolRouter → handlers (code / terminal /      │
│                 knowledge / graph / memory / meta)            │
│                 executes actions; never selects profiles      │
└──────────────────────────────────────────────────────────────┘
```

Baseline presets (a profile declares capabilities, strategy, and policies;
`AgentProfileCompiler` compiles every profile input form into one
`CompiledAgentProfile`):

| Preset      | Capabilities            | Strategy          | Policies         |
| ----------- | ----------------------- | ----------------- | ---------------- |
| `chat`      | Conversation + Analysis | Single            | Budget (8 turns) |
| `bootstrap` | Analysis + Knowledge    | FanOut + Pipeline | Budget + Quality |
| `scan`      | Analysis + Knowledge    | Pipeline          | Budget + Quality |

Domain runs (`src/agent/runs/`: plan, scan, evolution, relation, translation,
module mining) wrap the same service entrypoint with domain profiles and
result projections. `AgentRunCoordinator` handles fan-out: partition →
parallel child runs through `AgentService.run` itself → merge; child failures
become partial results instead of aborting the batch.

## Directory map

| Directory | Responsibility |
| --------- | -------------- |
| `src/agent/service/` | `AgentService` entrypoint, `AgentRuntimeBuilder` DI assembly, run contracts, system-run context factory |
| `src/agent/runtime/` | `AgentRuntime` ReAct kernel, `LoopContext`, `ExitController`, `BudgetController`, `ToolExecutionPipeline`, LLM input assembly/measurement, hooks/events/diagnostics, frozen interface contracts, PCV node evidence (observe-only) |
| `src/agent/profiles/` | Presets, serializable profile definitions, `AgentProfileCompiler`, registries |
| `src/agent/strategies/` | `Single` / `FanOut` / `Adaptive` / `Pipeline` orchestration |
| `src/agent/policies/` | `PolicyEngine` with Budget / Safety / QualityGate policies |
| `src/agent/capabilities/` | Capability registry (skill + tool-allowlist composition) |
| `src/agent/memory/` + `src/agent/domain/` | Three-tier memory (`ActiveContext` working / `SessionStore` session / `PersistentMemory` SQLite semantic) coordinated by `MemoryCoordinator`; evidence collection and episodic consolidation |
| `src/agent/context/` | `ContextWindow` (staged progressive compression), `ExplorationTracker`, plan tracking, nudges |
| `src/agent/prompts/` | Insight prompt suite (analyst → producer → gate → evolver) and scan prompts |
| `src/agent/runs/` + `coordination/` + `tasks/` | Domain runs, fan-out coordination, host task handlers |
| `src/ai/` | `AiProvider` abstraction, `LLMGateway`, per-vendor transports, `ModelRegistry`, reliability, `ParameterGuard`, structured output |
| `src/tools/` | Kernel contracts, `UnifiedToolCatalog`, runtime registry/router, handlers, terminal safety, output compressor + CLI parsers, `DeltaCache` |

## Package exports

Subpath entrypoints (see `exports` in `package.json`): `.`, `./agent`,
`./service`, `./runtime`, `./prompts`, `./domain`, `./tasks`, `./profiles`,
`./ai`, `./tools/runtime`, `./memory`, `./context`.

Internal imports use the `#agent/*`, `#ai/*`, `#shared/*`, `#tools/*` aliases
(resolved to `src/` under the `alembic-dev` condition, `dist/` otherwise).

## Key runtime guarantees

- **Structured results, never leaked exceptions** — single-run execution
  errors are degraded into a complete `AgentRunResult` with a five-state
  status (success / blocked / aborted / timeout / error); the frozen
  `AgentInterfaceContract` pins the result branches, the ordinary-output
  policy, and the failure taxonomy.
- **Budget compresses, exit decides** — session-budget thresholds only
  trigger staged context compression; termination belongs to max-iterations /
  timeout / `ExitController` exit signals, with a forced-summary fallback so
  the final reply is never empty.
- **Tool safety** — `terminal` runs behind a global dangerous-command
  blocklist plus a read-only allowlist, sandboxed when available (audited on
  degradation); `code.write` enforces a read-before-write freshness (TOCTOU)
  gate backed by a run-scoped shared `DeltaCache`.
- **Observability first** — hooks, an event bus, a diagnostics collector, and
  the observe-only PCV node-evidence engine (grounding enforcement defaults to
  `off`); every fallback / degraded / retry path logs its trigger and choice.
- **Token discipline** — LLM input assembly is measured and budget-trimmed;
  tool outputs go through an ANSI-strip → fold → dedicated-parser compression
  pipeline (git / grep / test / lint / tree / package parsers) with
  head+tail-preserving truncation.

## Install & local development

Workspace development intentionally consumes Core through the adjacent source
checkout (local-source-first baseline):

```json
"@alembic/core": "file:../AlembicCore"
```

```bash
npm install
npm run build        # tsc -> dist/
npm test             # vitest run (mock providers; no real API keys required)
```

Runtime dependencies: `@alembic/core`, `better-sqlite3`, `drizzle-orm`,
`undici`.

## Verification

`npm run check` is the full gate chain: typecheck, Biome lint, and the
boundary/contract gates —

| Gate | Enforces |
| ---- | -------- |
| `lint:agent-import-boundary` / `lint:core-import-boundary` | package-entry imports only; no reaching into Core internals |
| `lint:public-api-boundary` + `smoke:public-signatures` | frozen public API surface and signatures |
| `lint:layer-contract` / `lint:space-edges` | layering and module-edge rules |
| `lint:doctrine` | side-effect doctrine — no import-time work, effects flow through injected ports (see `docs/side-effect-doctrine-census.md`) |
| `lint:naming` / `lint:retired-symbols` | naming rules; retired symbols stay dead |
| `verify:validation-floor` | minimum validation floor |
| `test` | vitest suite (`test/`), including interface-contract, terminal-safety, and PCV observe-only characterization/acceptance tests |

AI provider changes must pass with mock providers — tests never depend on real
API keys. Declared entrypoint side effects are pinned in
`docs/entrypoint-effects.md` and `test/entrypoint-effects.test.ts`.

## Release

Publish previews are staged separately:

```bash
npm run release:pack-preview
```

`release:stage` builds and stages a publish package under `tmp/release/`; the
staged manifest replaces the local `file:../AlembicCore` dependency with the
registry `@alembic/core` version and records the Core source commit in
`.alembic-source.json`. `prepack` runs `release:package-guard`, so a raw
`npm pack` from the repo root cannot ship the development manifest.

## License

MIT
