/**
 * Compatibility shim — the tool call context contract now lives in the
 * canonical home `src/tools/kernel/context.ts`. Removed once all importers are
 * repointed to `#tools/kernel`.
 */

export * from '#tools/kernel/context.js';
