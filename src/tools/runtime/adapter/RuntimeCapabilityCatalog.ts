/**
 * RuntimeCapabilityCatalog — 从 TOOL_REGISTRY 生成 ToolSchemaProjection。
 *
 * 实现 AgentRuntime.#getToolSchemas() 期望的 duck-type 接口:
 *   toToolSchemas(ids?) → ToolSchemaProjection[]
 *   toMixedSchemas?(ids?, model?, firstRound?) → ToolSchemaProjection[]
 *   getManifest(id) → manifest | null
 *   markExpanded?(id) → void
 *
 * schema 格式:
 *   { name: "code", description: "...", parameters: { action: enum, params: ... } }
 */

import type { ToolSchemaProjection } from '#tools/catalog/CapabilityManifest.js';
import { generateLightweightSchemas, TOOL_REGISTRY } from '../registry.js';

export type ToolActionAllowlist = Record<string, readonly string[] | null | undefined>;

export class RuntimeCapabilityCatalog {
  #expandedTools = new Set<string>();

  /** 生成指定工具的完整 schema */
  toToolSchemas(ids?: readonly string[] | ToolActionAllowlist | null): ToolSchemaProjection[] {
    return generateSchemas(ids);
  }

  /** 同上 (model 参数对此实现无意义) */
  toToolSchemasForModel(
    ids?: readonly string[] | ToolActionAllowlist | null,
    _model?: string
  ): ToolSchemaProjection[] {
    return generateSchemas(ids);
  }

  /**
   * 混合模式: 首轮用轻量 schema，后续用完整 schema（已展开的工具）。
   * schema 已足够轻量，直接返回完整版。
   */
  toMixedSchemas(
    ids?: readonly string[] | ToolActionAllowlist | null,
    _model?: string,
    _firstRound?: boolean
  ): ToolSchemaProjection[] {
    return generateSchemas(ids);
  }

  /** 生成 action 级约束 schema；由 AgentRuntime 的 capability contract 直接驱动。 */
  toToolSchemasForActions(allowedTools?: ToolActionAllowlist | null): ToolSchemaProjection[] {
    return generateSchemas(allowedTools);
  }

  /** action 级约束的混合 schema 入口，保持 runtime lazy-loading 调用语义。 */
  toMixedSchemasForActions(
    allowedTools?: ToolActionAllowlist | null,
    _model?: string,
    _firstRound?: boolean
  ): ToolSchemaProjection[] {
    return generateSchemas(allowedTools);
  }

  /** 无 manifest 概念，返回 null — ToolRouter 直接从 TOOL_REGISTRY 查 */
  getManifest(_id: string) {
    return null;
  }

  get expandedCount() {
    return this.#expandedTools.size;
  }

  markExpanded(id: string) {
    this.#expandedTools.add(id);
  }

  has(id: string): boolean {
    return Object.hasOwn(TOOL_REGISTRY, id);
  }
}

function generateSchemas(
  idsOrAllowed?: readonly string[] | ToolActionAllowlist | null
): ToolSchemaProjection[] {
  const allowed = normalizeAllowedTools(idsOrAllowed);
  const schemas = generateLightweightSchemas(allowed);
  return schemas.map((s) => ({
    name: s.name,
    description: s.description,
    parameters: s.parameters,
  }));
}

function normalizeAllowedTools(
  idsOrAllowed?: readonly string[] | ToolActionAllowlist | null
): Record<string, string[]> | undefined {
  if (!idsOrAllowed) {
    return undefined;
  }
  const allowed: Record<string, string[]> = {};

  if (Array.isArray(idsOrAllowed)) {
    for (const id of idsOrAllowed) {
      const spec = TOOL_REGISTRY[id];
      if (spec) {
        allowed[id] = Object.keys(spec.actions);
      }
    }
    return allowed;
  }

  for (const [id, actionNames] of Object.entries(idsOrAllowed as ToolActionAllowlist)) {
    const spec = TOOL_REGISTRY[id];
    if (!spec) {
      continue;
    }
    if (!actionNames) {
      allowed[id] = Object.keys(spec.actions);
      continue;
    }
    const existing = actionNames.filter((action: string) => Object.hasOwn(spec.actions, action));
    if (existing.length > 0) {
      allowed[id] = [...new Set(existing)];
    }
  }

  return allowed;
}
