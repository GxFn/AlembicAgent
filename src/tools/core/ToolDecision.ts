/**
 * Compatibility shim — the tool decision contract now lives in the canonical
 * home `src/tools/kernel/decision.ts`. Removed once all importers are repointed
 * to `#tools/kernel`.
 */

export * from '#tools/kernel/decision.js';
