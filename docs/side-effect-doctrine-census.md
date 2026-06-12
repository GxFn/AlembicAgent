# AlembicAgent Side-Effect Doctrine Census (P2 AD4)

As-found census of doctrine surfaces in `src/` at baseline 765a558, derived
2026-06-12 for the AD4 Agent leg. Doctrine (AD0 standing rule, user-adopted):
"no import-time work, no module-scope mutable state, no direct singleton
reach-through in new/changed code; effects flow through injected ports."
Machine companion: `config/side-effect-doctrine.json` (blessed-singleton list,
layer-contract config idiom). Dispositions are behavior-preserving; redesigns
go through controller-decided waves.

## 1. Module-scope singletons and registries

| Id | Item | Site | Disposition |
| --- | --- | --- | --- |
| S1 | `ModelRegistry` lazy module singleton (`let _instance` + `getModelRegistry()`) | `src/ai/registry/ModelRegistry.ts:127-134` | BLESSED — named in the AD0 whitelist draft as "ModelRegistry (Agent)"; AD4 confirms. Lazy init, no import-time work. |
| S2 | `LLMGateway` lazy module singleton (`let _gateway` + `getLLMGateway(config?)` + `resetLLMGateway()`) | `src/ai/gateway/LLMGateway.ts:459-479` | BLESSED — public `./ai` API; explicit reset hook; documented config-rebuild semantics (explicit config rebuilds the instance). Container-managing would change the public API (STOP class). |
| S3 | `AgentEventBus` lazy class singleton (`static #instance`, `getInstance()`, `resetInstance()` clears listeners/subscriptions) | `src/agent/runtime/AgentEventBus.ts:47-79` | BLESSED — cross-strategy broadcast seam on the public runtime surface; reset hook present; `setMaxListeners(100)` declared. |

Of the four singletons named by the AD4 design, only `ModelRegistry` lives in
this repo. `Logger` (`@alembic/core/logging`), `pathGuard`
(`@alembic/core/io`), and `timerRegistry` (`@alembic/core/events`) are
Core-owned; their disposition belongs to the Core AD4 leg. Agent-side
consumption facts: Logger reach-through 30 call sites across 28 files (all
constructor/function-scoped after this leg's I1-I4 remediation); pathGuard 1
site (`src/agent/context/ConversationStore.ts:25,68`); timerRegistry 2
consumers, both with paired clear on dispose
(`src/agent/forge/TemporaryToolRegistry.ts:242,255`,
`src/agent/memory/SessionStore.ts:200,871`).

## 2. Module-scope mutable state

| Id | Item | Site | Disposition |
| --- | --- | --- | --- |
| M1 | `proxyDispatcherCache` Map (undici proxy dispatchers) | `src/ai/transport/LLMTransport.ts:28-29` | BLESSED as managed cache — lifecycle policy already implemented: cap `MAX_PROXY_DISPATCHER_CACHE_SIZE = 8`, close/destroy on eviction, null-caching of failed init; rationale documented in-file (socket/keep-alive reuse in the resident daemon). |
| M2 | `parsers[]` + `parsersLoaded` lazy-init flag | `src/tools/v2/compressor/OutputCompressor.ts:21-22` | BLESSED as lazy-init state — write-once idempotent loader explicitly designed to avoid import-time parser loading. |
| M3 | `_hookCounter` monotonic id counter | `src/agent/runtime/HookSystem.ts:96` | BLESSED — uniqueness-only counter; all behavioral hook state is instance-scoped (`#hooks`, `#hookErrors`). |
| M4 | Declarative constant tables: `TOOL_REGISTRY` spec table, `VALID_*`/`IGNORED_DIRS`/`BLOCKED_BINS`/`NON_CACHEABLE*`/`RETRYABLE_NETWORK_CODES` Sets, frozen defaults | `src/tools/v2/registry.ts`, various (census grep 2026-06-12) | HEALTHY per AD0 ("frozen constant Sets are fine") — constant data, never mutated after module init. No action. |

## 3. Import-time work

| Id | Item | Site | Disposition |
| --- | --- | --- | --- |
| I1 | `const _pipelineLogger = Logger.getInstance()` at module scope | `src/agent/strategies/PipelineStrategy.ts:163` | REMEDIATED this leg — lazy accessor; the Core logger singleton now materializes on first use, not at import. Restart semantics unchanged (same process-lifetime singleton; lazy first-touch). |
| I2 | `const logger = Logger.getInstance()` at module scope | `src/agent/runtime/forcedSummary.ts:65` | REMEDIATED this leg — same lazy accessor conversion. |
| I3 | `const logger = Logger.getInstance()` at module scope | `src/agent/prompts/insightGate.ts:26` | REMEDIATED this leg — same lazy accessor conversion. |
| I4 | `const logger = Logger.getInstance()` at module scope | `src/ai/gateway/LLMGateway.ts:40` | REMEDIATED this leg — same lazy accessor conversion. |
| I5 | `const STYLE_GUIDE = buildProducerStyleGuide()` | `src/agent/prompts/insightProducer.ts:133` | HEALTHY — pure deterministic string composition over Core constants (verified in `@alembic/core` `domain/knowledge/StyleGuide.ts`); no IO, no env, no mutable capture. Same class as frozen constants. |
| I6 | `const execAsync = promisify(exec)` and `Object.freeze(...)` defaults | `src/tools/v2/handlers/terminal.ts:19`, `src/agent/memory/SessionStore.ts:45` | HEALTHY — pure wrapper construction. |

Constructor-scoped `Logger.getInstance()` acquisitions (e.g.
`src/agent/runtime/AgentEventBus.ts:60`, memory/context stores) are
construction-time effects through the blessed Core singleton — compliant with
the doctrine as written; the injected-port end state for Logger is Core-leg /
future-wave scope.

## 4. Listener registrations and disposal

| Id | Item | Site | Finding |
| --- | --- | --- | --- |
| L1 | `child.stdout.on('data')`, `child.on('close'/'error')` | `src/tools/v2/handlers/code.ts:186,197,217` | HEALTHY — per-spawn listeners scoped to the child process lifetime; no leak surface. |
| L2 | `registerDefaultHooks` bridges (3 × `hookSystem.on`) | `src/agent/runtime/HookSystem.ts:307,320,333` | HEALTHY — `HookSystem` is per-`AgentRuntime` instance (`src/agent/runtime/AgentRuntime.ts:205`), `on()` returns an unsubscribe, and all hook state dies with the runtime instance; no module-scope HookSystem exists. |
| L3 | `AgentEventBus` subscriptions | — | HEALTHY in-repo — zero Agent-internal persistent `.on(`/`.subscribe(` sites found (strategies only publish); `resetInstance()` removes all listeners; host-side subscriptions are host-owned lifecycles. |
| L4 | timer registrations | `src/agent/forge/TemporaryToolRegistry.ts:255`, `src/agent/memory/SessionStore.ts:200` | HEALTHY — both `timerRegistry.setInterval` sites have paired `timerRegistry.clear` on dispose (`:242`, `:871`). |

Zero missing-disposal sites found; AD4 item (4) is satisfied by this census
with no code change required.

## 5. Standing exceptions NOT in this leg's scope

- SD-4 raw-SQL `semantic_memories` read adapter
  (`src/agent/memory/MemoryStore.ts`) — standing declared exception (AD2
  charter); Option-C end-state trigger is a user register row. Untouched.
- `CapabilityV2` → `Capability` inheritance reach-up
  (`src/tools/v2/capabilities/CapabilityV2.ts:9`) — placement-class register
  item (B5), owned by the layer-contract blessing in
  `config/layer-contract.json`. Untouched.
