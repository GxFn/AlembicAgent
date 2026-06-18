/**
 * Compatibility shim — the tool request + router contract now lives in the
 * canonical home `src/tools/kernel/request.ts`. Removed once all importers are
 * repointed to `#tools/kernel`.
 */

export * from '#tools/kernel/request.js';
