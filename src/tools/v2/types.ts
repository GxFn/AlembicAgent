/**
 * Compatibility shim — the tool registry + handler execution contract now lives
 * in the canonical home `src/tools/kernel/registry.ts`. Removed once all V2
 * consumers are repointed to `#tools/kernel`.
 */

export * from '#tools/kernel/registry.js';
