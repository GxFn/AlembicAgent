/**
 * UnifiedToolCatalog — 统一工具目录 (单源真相)
 *
 * 合并 `CapabilityCatalog`（manifest 查询）和 `ToolRegistry`（handler 查询）。
 * 继承 `CapabilityCatalog` 以保持对 `ToolRouter` 的兼容。
 *
 * 内部存储 `ToolDefinition`，对外暴露：
 *   - getManifest(id) — 返回 ToolCapabilityManifest（兼容 GovernanceEngine）
 *   - getHandler(id) — 返回 handler function
 *   - getInternalTool(id) — 兼容 InternalToolHandlerStore
 *   - toToolSchemas(ids?, model?) — 支持 per-model 描述覆盖
 *
 * @module tools/catalog/UnifiedToolCatalog
 */

import { CapabilityCatalog } from '#tools/catalog/CapabilityCatalog.js';
import type {
  CapabilityKind,
  ToolCapabilityManifest,
  ToolExecutionProfile,
  ToolGovernanceProfile,
  ToolRiskProfile,
  ToolSchemaProjection,
} from '#tools/catalog/CapabilityManifest.js';
import type {
  InternalToolHandler,
  InternalToolHandlerEntry,
  InternalToolHandlerStore,
  ToolRouterContract,
} from '#tools/kernel/index.js';

// ── Types inlined from deleted ToolDefinition.ts ──

export type ToolHandler = (
  args: Record<string, unknown>,
  context: Record<string, unknown>
) => unknown | Promise<unknown>;

export interface ToolDefinition {
  id: string;
  title: string;
  description: string;
  kind: CapabilityKind;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  risk: ToolRiskProfile;
  governance: ToolGovernanceProfile;
  execution: ToolExecutionProfile;
  handler: ToolHandler;
  modelOverrides?: Record<
    string,
    {
      description?: string;
      inputSchema?: Record<string, unknown>;
    }
  >;
}

function definitionToManifest(def: ToolDefinition): ToolCapabilityManifest {
  const surfaces: Array<'runtime' | 'http' | 'mcp' | 'dashboard' | 'skill' | 'internal'> = [
    'runtime',
  ];
  if (def.governance.allowInRemoteMcp) {
    surfaces.push('mcp');
  }
  if (!def.risk.sideEffect) {
    surfaces.push('http');
  }

  return {
    id: def.id,
    title: def.title,
    kind: def.kind,
    description: def.description,
    owner: 'core',
    lifecycle: 'active',
    surfaces,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    risk: def.risk,
    execution: def.execution,
    governance: def.governance,
    evals: {
      required: def.risk.sideEffect || def.governance.policyProfile !== 'read',
      cases: [],
    },
  };
}

function definitionToSchemaProjection(def: ToolDefinition, model?: string): ToolSchemaProjection {
  const override = model ? matchModelOverride(def, model) : undefined;
  return {
    name: def.id,
    description: override?.description ?? def.description,
    parameters: override?.inputSchema ?? def.inputSchema,
  };
}

function matchModelOverride(
  def: ToolDefinition,
  model: string
): { description?: string; inputSchema?: Record<string, unknown> } | undefined {
  if (!def.modelOverrides) {
    return undefined;
  }
  for (const [pattern, override] of Object.entries(def.modelOverrides)) {
    if (matchGlob(model, pattern)) {
      return override;
    }
  }
  return undefined;
}

function matchGlob(value: string, pattern: string): boolean {
  if (pattern === '*') {
    return true;
  }
  const starIdx = pattern.indexOf('*');
  if (starIdx < 0) {
    return value === pattern;
  }
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);
  return (
    value.startsWith(prefix) &&
    value.endsWith(suffix) &&
    value.length >= prefix.length + suffix.length
  );
}

export class UnifiedToolCatalog extends CapabilityCatalog implements InternalToolHandlerStore {
  readonly #defs = new Map<string, ToolDefinition>();
  #router: ToolRouterContract | null = null;

  constructor(defs: ToolDefinition[] = []) {
    super([]);
    this.registerDefinitions(defs);
  }

  // ── Router binding (replaces ToolRegistry.setRouter/getRouter) ──

  setRouter(router: ToolRouterContract | null): void {
    this.#router = router;
  }

  getRouter(): ToolRouterContract | null {
    return this.#router;
  }

  // ── Registration ──

  registerDefinition(def: ToolDefinition): void {
    if (this.#defs.has(def.id)) {
      throw new Error(`Tool '${def.id}' already registered in UnifiedToolCatalog`);
    }
    this.#defs.set(def.id, def);
    // Also register as CapabilityManifest for backward compatibility
    super.register(definitionToManifest(def));
  }

  registerDefinitions(defs: ToolDefinition[]): void {
    for (const def of defs) {
      this.registerDefinition(def);
    }
  }

  // ── Handler Access ──

  getHandler(id: string): ToolHandler | null {
    return this.#defs.get(id)?.handler ?? null;
  }

  getDefinition(id: string): ToolDefinition | null {
    return this.#defs.get(id) ?? null;
  }

  // ── InternalToolHandlerStore compatibility ──

  getInternalTool(name: string): InternalToolHandlerEntry | null {
    const def = this.#defs.get(name);
    if (!def) {
      return null;
    }

    return {
      name: def.id,
      description: def.description,
      parameters: def.inputSchema,
      metadata: {
        owner: 'core',
        lifecycle: 'active',
        sideEffect: def.risk.sideEffect,
        policyProfile: def.governance.policyProfile,
        auditLevel: def.governance.auditLevel,
      },
      handler: def.handler as unknown as InternalToolHandler,
    };
  }

  // ── Per-model Schema Projection ──

  /**
   * Override parent's toToolSchemas to support per-model description overrides.
   * When `model` is provided, tool descriptions are matched against modelOverrides.
   */
  toToolSchemasForModel(ids?: readonly string[] | null, model?: string): ToolSchemaProjection[] {
    const manifests = this.list({ ids });
    return manifests.map((manifest) => {
      const def = this.#defs.get(manifest.id);
      if (def && model) {
        return definitionToSchemaProjection(def, model);
      }
      return {
        name: manifest.id,
        description: manifest.description,
        parameters: manifest.inputSchema,
      };
    });
  }

  // ── Lazy Loading: lightweight / mixed schema projection ──

  /** Tools that have been "expanded" (used by the agent — full schema shown). */
  readonly #expandedToolIds = new Set<string>();

  /** Mark a tool as expanded (called after the tool is used in a round). */
  markExpanded(toolId: string): void {
    this.#expandedToolIds.add(toolId);
  }

  /** Mark multiple tools as expanded. */
  markExpandedAll(toolIds: string[]): void {
    for (const id of toolIds) {
      this.#expandedToolIds.add(id);
    }
  }

  /** Reset expanded state (e.g. between pipeline stages). */
  resetExpanded(): void {
    this.#expandedToolIds.clear();
  }

  /**
   * Lightweight schema: name + one-line description only (no parameters).
   * Used for tools the agent hasn't touched yet to reduce token overhead.
   */
  toLightweightSchemas(ids?: readonly string[] | null): ToolSchemaProjection[] {
    return this.list({ ids }).map((manifest) => ({
      name: manifest.id,
      description: manifest.description.split('\n')[0].slice(0, 120),
      parameters: { type: 'object', properties: {} },
    }));
  }

  /**
   * Mixed schema projection:
   *   - Expanded tools → full schema (with optional model override)
   *   - Not-yet-used tools → lightweight (name + description only)
   *
   * This reduces the total token cost of tool schemas from ~50-80% to ~20-30%
   * in large toolsets (30+ tools).
   *
   * @param ids - Allowed tool IDs
   * @param model - Current model name for per-model overrides
   * @param firstRound - If true, all tools get full schema (first iteration)
   */
  toMixedSchemas(
    ids?: readonly string[] | null,
    model?: string,
    firstRound = false
  ): ToolSchemaProjection[] {
    if (firstRound) {
      return this.toToolSchemasForModel(ids, model);
    }

    const manifests = this.list({ ids });
    return manifests.map((manifest) => {
      if (this.#expandedToolIds.has(manifest.id)) {
        const def = this.#defs.get(manifest.id);
        if (def && model) {
          return definitionToSchemaProjection(def, model);
        }
        return {
          name: manifest.id,
          description: manifest.description,
          parameters: manifest.inputSchema,
        };
      }
      return {
        name: manifest.id,
        description: manifest.description.split('\n')[0].slice(0, 120),
        parameters: { type: 'object', properties: {} },
      };
    });
  }

  // ── Inspection ──

  get definitionCount(): number {
    return this.#defs.size;
  }

  get expandedCount(): number {
    return this.#expandedToolIds.size;
  }

  listDefinitionIds(): string[] {
    return [...this.#defs.keys()];
  }
}

export default UnifiedToolCatalog;
