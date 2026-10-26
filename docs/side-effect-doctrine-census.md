# AlembicAgent Side-Effect Doctrine Census (P2 AD4)

As-found census of doctrine surfaces in `src/` at baseline 765a558, derived
2026-06-12 for the AD4 Agent leg. Doctrine (AD0 standing rule, user-adopted):
"no import-time work, no module-scope mutable state, no direct singleton
reach-through in new/changed code; effects flow through injected ports."
Machine companion: `config/side-effect-doctrine.json` (blessed-singleton list,
layer-contract config idiom). Dispositions are behavior-preserving; redesigns
go through controller-decided waves.

## Current reconciliation (2026-09-18)

The tables below preserve the 2026-06-12 baseline rather than claim its paths
and counts are current. The current machine record uses `src/tools/runtime/`
and `RuntimeCapability`. `TemporaryToolRegistry` has already retired. Since
W1-04 (2026-10-22) `SessionStore` no longer registers a cleanup timer: its
read-only tool cache, TTL and the `cleanupIntervalMs`/`ttlMs` keys were removed,
and W2a-10 removed its checkpoint file chain. No file under `src/` consumes
`timerRegistry` any more. The compressor now shares one
lazy initialization Promise between concurrent callers instead of exposing a
premature `parsersLoaded` flag. Its obsolete lint exemption has been removed.
The former RuntimeCapability reach-up exception was already resolved by the
kernel extraction recorded in `config/layer-contract.json` on 2026-06-19;
the stale standing exception has now been removed from the machine record.

Path refresh (2026-10-23, W-CL1, checked against 1d03823 plus this change): rows that cited
the former `tools/v2` tree now cite their current `src/tools/runtime/` files,
the `pathGuard` and `timerRegistry` citations point at current code, and the
I6 `SessionStore` freeze cites `RETIRED_TOOL_CACHE_STATS`. Every other line
number below remains the 2026-06-12 baseline.

Current side effects and host responsibilities are described in
`docs/entrypoint-effects.md`; public singleton compatibility and the existing
Core-owned memory adapter exception remain in force.

The 2026-09-21 AI review keeps the existing M1 proxy-cache owner and its cap of
8. Its Map is now initialized lazily, and the Map identity invalidates pending
initialization after clear. Entries share initialization and retain fetch borrows;
eviction drops cache ownership, then closes the dispatcher after the last borrow.
This needs no separate module-level generation counter or new managed owner. The
old empty-Map lint exemption has been removed because the cache now uses the
documented null-slot lifecycle; the HookSystem counter exemption remains.

## 1. Module-scope singletons and registries

S2 below is kept as a baseline record only: it was retired on 2026-10-23 and is no
longer in the machine record's `blessedSingletons`.

| Id | Item | Site | Disposition |
| --- | --- | --- | --- |
| S1 | `ModelRegistry` lazy module singleton (`let _instance` + `getModelRegistry()`) | `src/ai/registry/ModelRegistry.ts:127-134` | BLESSED — named in the AD0 whitelist draft as "ModelRegistry (Agent)"; AD4 confirms. Lazy init, no import-time work. |
| S2 | `LLMGateway` lazy module singleton (`let _gateway` + shared accessor + reset hook) | `src/ai/gateway/LLMGateway.ts:459-479` (baseline) | RETIRED 2026-10-23 (W2a-11 / L2-P21, user-approved decision ②) — the shared accessor and reset hook were removed from `.` and `./ai` together with the module-level slot; rebuilding the shared instance with a new config used to drop the old instance's circuit breaker and concurrency state. Each `AiProvider` owns its own `LLMGateway`; direct callers construct `new LLMGateway(config)`. The blessed-singleton row was removed from `config/side-effect-doctrine.json` in the same change. |
| S3 | `AgentEventBus` lazy class singleton (`static #instance`, `getInstance()`, `resetInstance()` removes all listeners) | `src/agent/runtime/AgentEventBus.ts:47-72` | BLESSED — cross-strategy broadcast seam on the public runtime surface; reset hook present; `setMaxListeners(100)` declared. |

Of the four singletons named by the AD4 design, only `ModelRegistry` lives in
this repo. `Logger` (`@alembic/core/logging`), `pathGuard`
(`@alembic/core/io`), and `timerRegistry` (`@alembic/core/events`) are
Core-owned; their disposition belongs to the Core AD4 leg. Agent-side
consumption facts: Logger reach-through 30 call sites across 28 files (all
constructor/function-scoped after this leg's I1-I4 remediation); pathGuard 1
site (import and `assertProjectWriteSafe` call at
`src/agent/context/ConversationStore.ts:36,104`); timerRegistry had 2
consumers at the baseline (`TemporaryToolRegistry` and `SessionStore`), both
with paired clear on dispose. Both are gone now (see the reconciliation
above), so Agent `src/` has no timerRegistry consumer.

## 2. Module-scope mutable state

| Id | Item | Site | Disposition |
| --- | --- | --- | --- |
| M1 | `proxyDispatcherCache` Map (undici proxy dispatchers) | `src/ai/transport/LLMTransport.ts:28-29` | BLESSED as managed cache — lifecycle policy already implemented: cap `MAX_PROXY_DISPATCHER_CACHE_SIZE = 8`, close/destroy on eviction, null-caching of failed init; rationale documented in-file (socket/keep-alive reuse in the resident daemon). |
| M2 | `parsers[]` + `parsersLoaded` lazy-init flag (baseline; now one shared `parserLoading` Promise plus `loadedParsers`, see the reconciliation) | `src/tools/runtime/compressor/OutputCompressor.ts:83,88` | BLESSED as lazy-init state — write-once idempotent loader explicitly designed to avoid import-time parser loading. |
| M3 | `_hookCounter` monotonic id counter | `src/agent/runtime/HookSystem.ts:104` | BLESSED — uniqueness-only counter; all behavioral hook state is instance-scoped (`#hooks`, `#hookErrors`). |
| M4 | Declarative constant tables: `TOOL_REGISTRY` spec table, `VALID_*`/`IGNORED_DIRS`/`BLOCKED_BINS`/`NON_CACHEABLE*`/`RETRYABLE_NETWORK_CODES` Sets, frozen defaults | `src/tools/runtime/registry.ts`, various (census grep 2026-06-12) | HEALTHY per AD0 ("frozen constant Sets are fine") — constant data, never mutated after module init. No action. |

## 3. Import-time work

| Id | Item | Site | Disposition |
| --- | --- | --- | --- |
| I1 | `const _pipelineLogger = Logger.getInstance()` at module scope | `src/agent/strategies/PipelineStrategy.ts:163` | REMEDIATED this leg — lazy accessor; the Core logger singleton now materializes on first use, not at import. Restart semantics unchanged (same process-lifetime singleton; lazy first-touch). |
| I2 | `const logger = Logger.getInstance()` at module scope | `src/agent/runtime/forcedSummary.ts:65` | REMEDIATED this leg — same lazy accessor conversion. |
| I3 | `const logger = Logger.getInstance()` at module scope | `src/agent/prompts/insightGate.ts:26` | REMEDIATED this leg — same lazy accessor conversion. |
| I4 | `const logger = Logger.getInstance()` at module scope | `src/ai/gateway/LLMGateway.ts:40` | REMEDIATED this leg — same lazy accessor conversion. |
| I5 | `const STYLE_GUIDE = buildProducerStyleGuide()` | `src/agent/prompts/insightProducer.ts:133` | HEALTHY — pure deterministic string composition over Core constants (verified in `@alembic/core` `domain/knowledge/StyleGuide.ts`); no IO, no env, no mutable capture. Same class as frozen constants. |
| I6 | `const execAsync = promisify(exec)` and `Object.freeze(...)` defaults (the SessionStore freeze is now `RETIRED_TOOL_CACHE_STATS`) | `src/tools/runtime/handlers/terminal.ts:72`, `src/agent/memory/SessionStore.ts:75` | HEALTHY — pure wrapper construction. |

Constructor-scoped `Logger.getInstance()` acquisitions (e.g.
`src/agent/runtime/AgentEventBus.ts:55`, memory/context stores) are
construction-time effects through the blessed Core singleton — compliant with
the doctrine as written; the injected-port end state for Logger is Core-leg /
future-wave scope.

## 4. Listener registrations and disposal

| Id | Item | Site | Finding |
| --- | --- | --- | --- |
| L1 | `child.stdout`/`child.stderr` `.on('data')`, `child.on('close'/'error')` | `src/tools/runtime/handlers/code.ts:666,689,704,727` | HEALTHY — per-spawn listeners scoped to the child process lifetime; no leak surface. |
| L2 | `registerDefaultHooks` bridges (2 × `hookSystem.on`, `llm:call:before`/`llm:call:after`; the dead exit-hook bridge was removed with the never-dispatched hook events in L5-P41) | `src/agent/runtime/HookSystem.ts:362,375` | HEALTHY — `HookSystem` is per-`AgentRuntime` instance (`src/agent/runtime/AgentRuntime.ts:340`), `on()` returns an unsubscribe, and all hook state dies with the runtime instance; no module-scope HookSystem exists. |
| L3 | `AgentEventBus` listeners | `src/agent/strategies/pipeline/attempt.ts:83,127` | HEALTHY in-repo — `subscribe()`/`request()` and their subscription and pending-reply maps were removed in L5-P41, so listeners exist only as inherited EventEmitter `on`/`off` registrations; the only Agent-internal site is the pipeline attempt's paired `on`/`off` of `TOOL_CALL_START` (strategies otherwise only publish); `resetInstance()` removes all listeners; host-side subscriptions are host-owned lifecycles. |
| L4 | timer registrations | none (baseline: `TemporaryToolRegistry` and `SessionStore`) | RETIRED — at the baseline both `timerRegistry.setInterval` sites had a paired `timerRegistry.clear` on dispose; `TemporaryToolRegistry` has since retired and the `SessionStore` interval was removed with its read-only tool cache in W1-04, so no timer registration remains under `src/`. |

Zero missing-disposal sites found; AD4 item (4) is satisfied by this census
with no code change required.

## 5. Standing exceptions NOT in this leg's scope

- SD-4 raw-SQL `semantic_memories` read adapter
  (`src/agent/memory/MemoryStore.ts`) — standing declared exception (AD2
  charter); Option-C end-state trigger is a user register row. Untouched.
- `CapabilityV2` → `Capability` inheritance reach-up (the class is now
  `RuntimeCapability`, `src/tools/runtime/toolsets/RuntimeCapability.ts:15`) —
  placement-class register item (B5). Resolved by the 2026-06-19 kernel
  extraction recorded in `config/layer-contract.json`; the stale standing
  exception has been removed from the machine record (see the reconciliation).
