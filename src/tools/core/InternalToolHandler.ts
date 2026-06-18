/**
 * Compatibility shim — the internal tool handler contract now lives in the
 * canonical home `src/tools/kernel/handler.ts`. Removed once all importers are
 * repointed to `#tools/kernel`.
 */

export * from '#tools/kernel/handler.js';
