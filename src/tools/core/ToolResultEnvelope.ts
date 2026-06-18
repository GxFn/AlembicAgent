/**
 * Compatibility shim. The tool result contract now lives in the canonical home
 * `src/tools/kernel/result.ts`. This re-export keeps existing `src/tools/core`
 * consumers (and the ToolRuntimeBridge seam) green during the tool-system
 * convergence; it is deleted once all importers are repointed to
 * `#tools/kernel`.
 */

export * from '#tools/kernel/result.js';
