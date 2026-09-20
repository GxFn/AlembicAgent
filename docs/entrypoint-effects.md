# Entrypoint Effects — Declared Inflow/Outflow (AD6)

AlembicAgent's public entrypoint families and what each MAY touch. Pinned by
`test/entrypoint-effects.test.ts` (no-undeclared-effects snapshots on
representative calls with temp roots and stubbed transports — no real provider
calls). Effects not listed here are undeclared — finding one is a doctrine
violation to report, not to absorb.

## Family 1 — package facades (the 15 exact exports)

`@alembic/agent` root plus `./agent ./service ./runtime ./prompts ./domain
./tasks ./profiles ./ai ./tools/runtime ./memory ./context ./runs ./production
./evaluation` (G5 boundary;
consumed by Alembic per the space-edge config).

- **Importing performs NO work** (post-AD4): no filesystem or network effects are expected at import; provider configuration is resolved during construction; the Core
  logger is acquired lazily on first use (AD4 I1-I4). Proven by the
  clean-child-process import snapshot across all 15 facades.
- **Direct AI network calls use injected/configured provider transports**:
  every outbound call flows AiProvider → LLMGateway → transport `fetch`
  (OpenAI/DeepSeek/Google/Ollama endpoints from provider config or env);
  proxy use is the env-configured undici dispatcher (bounded
  `proxyDispatcherCache`, AD4 M1). Tool handlers can also delegate process/network effects to host-injected services; terminal sandbox enforcement remains host-owned.
- **Agent session memory storage**: `agent/memory/MemoryStore` reads and writes
  `semantic_memories` through the better-sqlite3 handle its CALLER injects
  (constructor parameter; standing AD2 charter exception with the Option-C
  end-state trigger). Agent opens no databases of its own.
- **Runtime persistence only under caller-provided roots**: conversation/
  session/memory stores write under `<projectRoot>/.asd/...` with a
  pathGuard write-safety assertion at construction; Runtime builders default projectRoot to the current working directory when omitted; Evidence Ledger placement uses dataRoot. File tools can also read/write project source within their policy boundary.

## Family 2 — shipped tooling

`package.json` has NO `bin` field and packs `dist/` plus the English and Chinese READMEs
(`files[]`; pack floor 432). The repo `scripts/*.mjs` include gates, probes, isolated evaluation reports, and explicit build/release/codemod operations — they are not shipped and not
an entrypoint family for consumers.

## Charter completeness (AD2 cross-check, findings only)

Against the AD2-confirmed Agent charter (owns LLM provider/tool runtime — V2
catalog, transports, classification; consumes `@alembic/core` only;
must-never knowledge persistence / HTTP surface; declared SD-4 exception):

- **No orphan capability**: all 15 exports map to charter "owns" lines —
  ai/transports/classification (`./ai`: providers, transports, registry,
  gateway, errorClassify), live tool runtime (`./tools/runtime`, root tools
  barrel), agent orchestration over them (`./agent ./service ./runtime
  ./prompts ./domain ./tasks ./profiles ./memory ./context`, strict Plan run
  (`./runs`), strict analysis/Producer contracts (`./production`), and
  independent review (`./evaluation`) + root facade).
- **No charter line without code**: provider adapters, V2 catalog, live
  terminal.exec handling, and error classification all exist and are gate-pinned.
- **Must-never holds**: no HTTP SERVER surface exists (transports are
  outbound clients the charter owns); no knowledge-base persistence
  (agent memory/session stores are agent-session state, not the knowledge
  store; the only knowledge-adjacent touch is the SD-4 declared READ).
- **Locator census note**: Agent has ZERO `getServiceContainer()`-class
  service-locator sites (AD4/AD6 census) — the locator-retirement design
  line is vacuously satisfied in this repo.
