import type {
  CapabilityLifecycle,
  CapabilitySurface,
  ToolCapabilityManifest,
} from '#tools/kernel/manifest.js';
import type {
  ToolSchemaProjection,
  ToolSchemaQuery,
  ToolSchemaQueryPort,
  ToolSchemaQueryResult,
} from '#tools/kernel/toolSchema.js';
import { selectToolActions } from '#tools/kernel/toolSelection.js';

export interface CapabilityListFilter {
  surface?: CapabilitySurface;
  lifecycle?: CapabilityLifecycle;
  ids?: readonly string[] | null;
}

export class CapabilityCatalog implements ToolSchemaQueryPort {
  #manifests = new Map<string, ToolCapabilityManifest>();

  constructor(manifests: ToolCapabilityManifest[] = []) {
    this.registerAll(manifests);
  }

  register(manifest: ToolCapabilityManifest) {
    if (!manifest.id) {
      throw new Error('Capability manifest must have an id');
    }
    if (this.#manifests.has(manifest.id)) {
      throw new Error(`Capability '${manifest.id}' already registered`);
    }
    this.#manifests.set(manifest.id, manifest);
  }

  registerAll(manifests: ToolCapabilityManifest[]) {
    for (const manifest of manifests) {
      this.register(manifest);
    }
  }

  unregister(id: string) {
    return this.#manifests.delete(id);
  }

  has(id: string) {
    return this.#manifests.has(id);
  }

  getManifest(id: string) {
    return this.#manifests.get(id) || null;
  }

  /**
   * 按 surface/lifecycle/ids 过滤已注册的 manifest（多个条件同时生效，取交集）。
   *
   * 禁用项的可见性：
   *   - 调用方显式传入 lifecycle 时只按该值相等过滤，所以 list({ lifecycle: 'disabled' })
   *     返回禁用项，这与 CapabilityListFilter.lifecycle 的类型承诺一致（L3-C11）；
   *   - 没有传 lifecycle 时默认排除 disabled。querySchemas 内部用无参 this.list()，
   *     因此模型可见的 schema 仍然不会包含禁用能力。
   */
  list(filter: CapabilityListFilter = {}) {
    const ids = filter.ids ? new Set(filter.ids) : null;
    return [...this.#manifests.values()].filter((manifest) => {
      if (ids && !ids.has(manifest.id)) {
        return false;
      }
      if (filter.lifecycle && manifest.lifecycle !== filter.lifecycle) {
        return false;
      }
      if (filter.surface && !manifest.surfaces.includes(filter.surface)) {
        return false;
      }
      // 与上面的 lifecycle 相等检查使用同一个“已显式请求”判定（非空值）：JS 调用方传入
      // null/'' 时既不做 lifecycle 过滤，也不放出禁用项，保持与无参调用一致。
      return Boolean(filter.lifecycle) || manifest.lifecycle !== 'disabled';
    });
  }

  toToolSchemas(ids?: readonly string[] | null): ToolSchemaProjection[] {
    return this.querySchemas({ selection: ids }).schemas;
  }

  querySchemas(query: ToolSchemaQuery = {}): ToolSchemaQueryResult {
    const manifests = this.list();
    const allowedTools = selectToolActions(
      query.selection,
      manifests.map(({ id }) => id)
    );
    return {
      schemas: manifests
        .filter(({ id }) => Object.hasOwn(allowedTools, id))
        .map((manifest) => this.projectSchema(manifest, query)),
      allowedTools,
    };
  }

  /**
   * 泛型目录保留原始 flat 参数结构：只有显式 mode:'lightweight' 给名称加首行描述，其余（含
   * AgentRuntime 使用的 mixed + firstRound:true）一律给完整 schema。目录不持有任何按实例的展开
   * 状态，也不按模型改写 schema；UnifiedToolCatalog 的 lazy 覆盖已删除（W2a-02 / L3-P09），
   * 所以子类直接继承本投影。子类若要改投影只能覆盖本方法，不复制 querySchemas 的选择规则。
   */
  protected projectSchema(
    manifest: ToolCapabilityManifest,
    query: ToolSchemaQuery
  ): ToolSchemaProjection {
    const lightweight = query.mode === 'lightweight';
    return {
      name: manifest.id,
      description: lightweight
        ? manifest.description.split('\n')[0].slice(0, 120)
        : manifest.description,
      // 投影由调用方拥有；编辑本轮 JSON schema 不能反写注册合同或后续查询。
      parameters: lightweight
        ? { type: 'object', properties: {} }
        : structuredClone(manifest.inputSchema),
    };
  }

  get size() {
    return this.#manifests.size;
  }
}

export default CapabilityCatalog;
