/**
 * @module tools/kernel
 *
 * Canonical tool-system contract — the single source of truth for the tool
 * result envelope, decision, request, router contract, call context, handler,
 * and registry types. Replaces the former src/tools/core (V1) and
 * src/tools/v2/types (V2) split; no version labels.
 *
 * Migration in progress: types are relocated here cluster by cluster and the
 * old `core/*` + `v2/types` modules remain thin re-export shims until every
 * consumer is repointed to `#tools/kernel`.
 */

export * from './context.js';
export * from './decision.js';
export * from './handler.js';
export * from './presenter.js';
export * from './registry.js';
export * from './request.js';
export * from './result.js';
export * from './routing.js';
