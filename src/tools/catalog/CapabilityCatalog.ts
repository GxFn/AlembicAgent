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
      return manifest.lifecycle !== 'disabled';
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

  /** 泛型目录保留原始 flat 参数结构；有 lazy 状态的子类只覆盖投影，不复制选择规则。 */
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
