/**
 * RuntimeCapabilityCatalog — 从 TOOL_REGISTRY 生成 ToolSchemaProjection。
 *
 * querySchemas 一次返回模型 schema 和有效动作集合；宿主只提供无副作用的可用性快照。
 * 旧 schema 方法保留为 wrapper。内置规格始终使用 action envelope，不按 model/lazy
 * 丢弃参数；泛型目录的模型覆盖和 lazy 行为由各自实现保留。
 *
 * schema 格式:
 *   { name: "code", description: "...", parameters: { action: enum, params: ... } }
 */

import type { ToolAvailabilitySnapshot } from '#tools/kernel/availability.js';
import type { ToolRuntimeCallContext } from '#tools/kernel/context.js';
import type {
  ToolActionAllowlist,
  ToolSchemaProjection,
  ToolSchemaQuery,
  ToolSchemaQueryPort,
  ToolSchemaQueryResult,
} from '#tools/kernel/toolSchema.js';
import { isToolActionAllowed, normalizeToolActions } from '#tools/kernel/toolSelection.js';
import { projectRegistrySchemas, TOOL_REGISTRY } from '../registry.js';
import { createToolRegistryView } from '../selection.js';

export type { ToolActionAllowlist } from '#tools/kernel/toolSchema.js';

export class RuntimeCapabilityCatalog implements ToolSchemaQueryPort {
  #expandedTools = new Set<string>();
  readonly #availability?: (
    runtime?: ToolRuntimeCallContext
  ) => ToolAvailabilitySnapshot | undefined;

  constructor(
    options: {
      availability?: (runtime?: ToolRuntimeCallContext) => ToolAvailabilitySnapshot | undefined;
    } = {}
  ) {
    this.#availability = options.availability;
  }

  querySchemas(query: ToolSchemaQuery = {}): ToolSchemaQueryResult {
    const availability = this.#availability?.(query.runtime);
    const view = createToolRegistryView(TOOL_REGISTRY, query.selection, availability);
    const allowedTools = normalizeToolActions(
      undefined,
      Object.fromEntries(
        Object.entries(view).map(([tool, spec]) => [tool, Object.keys(spec.actions)])
      )
    );
    const selected = normalizeToolActions(
      query.selection,
      Object.fromEntries(
        Object.entries(TOOL_REGISTRY).map(([tool, spec]) => [tool, Object.keys(spec.actions)])
      )
    );
    const unavailable = availability?.unavailable
      ?.filter(({ tool, action }) => isToolActionAllowed(selected, tool, action))
      .map((reason) => ({ ...reason }));
    return {
      schemas: projectRegistrySchemas(
        view,
        query.selection != null || availability !== undefined,
        availability?.parameters
      ),
      allowedTools,
      ...(unavailable?.length ? { unavailable } : {}),
    };
  }

  /** 生成指定工具的完整 schema */
  toToolSchemas(ids?: readonly string[] | ToolActionAllowlist | null): ToolSchemaProjection[] {
    return this.querySchemas({ selection: ids }).schemas;
  }

  /** 同上 (model 参数对此实现无意义) */
  toToolSchemasForModel(
    ids?: readonly string[] | ToolActionAllowlist | null,
    _model?: string
  ): ToolSchemaProjection[] {
    return this.querySchemas({ selection: ids, model: _model }).schemas;
  }

  /**
   * 兼容旧混合模式入口；内置 schema 已经是轻量 action envelope，始终保留参数形状。
   */
  toMixedSchemas(
    ids?: readonly string[] | ToolActionAllowlist | null,
    _model?: string,
    _firstRound?: boolean
  ): ToolSchemaProjection[] {
    return this.querySchemas({
      selection: ids,
      model: _model,
      mode: 'mixed',
      firstRound: _firstRound,
    }).schemas;
  }

  /** 生成 action 级约束 schema；由 AgentRuntime 的 capability contract 直接驱动。 */
  toToolSchemasForActions(allowedTools?: ToolActionAllowlist | null): ToolSchemaProjection[] {
    return this.querySchemas({ selection: allowedTools }).schemas;
  }

  /** action 级约束的混合 schema 入口，保持 runtime lazy-loading 调用语义。 */
  toMixedSchemasForActions(
    allowedTools?: ToolActionAllowlist | null,
    _model?: string,
    _firstRound?: boolean
  ): ToolSchemaProjection[] {
    return this.querySchemas({
      selection: allowedTools,
      model: _model,
      mode: 'mixed',
      firstRound: _firstRound,
    }).schemas;
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
