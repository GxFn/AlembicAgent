/**
 * UnifiedToolCatalog — 继承 CapabilityCatalog 的能力清单目录（以下为 2026-10 核对的当前事实）。
 *
 * 生产用途：宿主把它注册为 `toolRegistry` 单例，只用继承来的 `register(manifest)` 存放
 * Dashboard/Skill manifest。它不参与工具执行，也不提供模型 schema：
 *   - 运行时工具执行只走 ToolRouterAdapter → ToolRouter → ActionHandler，ToolRouter 不读取任何 catalog；
 *   - 模型 schema 由宿主注册为 `capabilityCatalog` 的 RuntimeCapabilityCatalog 提供，不经本类。
 *   - 生产中读取本实例的只有两处：AgentRuntime/AgentRuntimeBuilder 的 getRouter 兜底（恒为 null，
 *     见下）和 duplicateCache 的 getManifest。后者按运行时工具 id 查询，而运行时工具不在这里
 *     注册，所以目前查不到（去留待决，见 L3-C08）。存进来的 Dashboard/Skill manifest 没有读取方。
 *
 * 兼容公开面（在冻结签名清单内，生产中没有消费者，收窄与否待决）：
 *   - registerDefinition/getDefinition/getHandler：按 ToolDefinition 注册并取 handler，只有测试使用；
 *   - getInternalTool：实现 InternalToolHandlerStore，只有测试调用；owner 固定写成 'core'；
 *   - setRouter/getRouter：src 与宿主都没有 setRouter 调用，AgentRuntime/AgentRuntimeBuilder
 *     里的 getRouter 兜底在生产中因此恒为 null。
 *
 * lazy 展开状态（markExpanded 等）存在本实例上，不按运行隔离，同一实例被多次运行共用时
 * 会跨运行累积；宿主 schema 查询不经本类，所以这份状态在生产中不影响模型看到的 schema。
 *
 * @module tools/catalog/UnifiedToolCatalog
 */

import { CapabilityCatalog } from '#tools/catalog/CapabilityCatalog.js';
import type {
  InternalToolHandler,
  InternalToolHandlerEntry,
  InternalToolHandlerStore,
  ToolRouterContract,
} from '#tools/kernel/index.js';
import type {
  CapabilityKind,
  ToolCapabilityManifest,
  ToolExecutionProfile,
  ToolGovernanceProfile,
  ToolRiskProfile,
} from '#tools/kernel/manifest.js';
import type { ToolSchemaProjection, ToolSchemaQuery } from '#tools/kernel/toolSchema.js';

// ── ToolDefinition 兼容公开面的类型（只服务 registerDefinition 路径，生产中没有注册方） ──

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

function definitionToSchemaProjection(
  def: ToolDefinition,
  model?: string,
  apiModelId?: string
): ToolSchemaProjection {
  const override = model ? matchModelOverride(def, model, apiModelId) : undefined;
  return {
    name: def.id,
    description: override?.description ?? def.description,
    parameters: structuredClone(override?.inputSchema ?? def.inputSchema),
  };
}

function matchModelOverride(
  def: ToolDefinition,
  model: string,
  apiModelId?: string
): { description?: string; inputSchema?: Record<string, unknown> } | undefined {
  if (!def.modelOverrides) {
    return undefined;
  }
  for (const [pattern, override] of Object.entries(def.modelOverrides)) {
    // 只使用调用方明确提供的 API 身份；旧裸 id 可含冒号，目录不能自行猜测/拆分。
    // 同一项同时接受两种名称并沿用声明顺序，不能让后面的 '*' 抢走首个匹配。
    if (matchGlob(model, pattern) || (apiModelId !== undefined && matchGlob(apiModelId, pattern))) {
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

  // ── Router 绑定（兼容公开面）：src 与宿主都没有 setRouter 调用，生产中 getRouter 恒为 null ──

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
    // 同时登记一份由定义推导的 manifest，让继承来的 getManifest/list/querySchemas 能看到它；
    // 推导时 owner 固定为 'core'，不代表真实归属。
    super.register(definitionToManifest(def));
    this.#defs.set(def.id, def);
  }

  override unregister(id: string): boolean {
    const removed = super.unregister(id);
    this.#defs.delete(id);
    this.#expandedToolIds.delete(id);
    return removed;
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

  // ── InternalToolHandlerStore 兼容实现：接口没有生产读取方，本方法只有测试调用 ──

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
   * 新增的包装方法（不是父类 toToolSchemas 的覆盖）：等价于
   * querySchemas({ selection: ids, model, mode: 'full' })。
   * 传入 model 时，按注册定义的 modelOverrides 匹配描述与参数覆盖。
   */
  toToolSchemasForModel(ids?: readonly string[] | null, model?: string): ToolSchemaProjection[] {
    return this.querySchemas({ selection: ids, model, mode: 'full' }).schemas;
  }

  // ── lazy 投影：lightweight / mixed ──
  // 展开状态挂在实例上，不按运行隔离；只有调用方之后再查询 mixed schema 时才会体现。
  // 运行时每次 reactLoop 只查询一次 schema，“按轮展开”在当前调用链上不成立。

  /** 已展开的工具 id（mixed 投影时这些工具给完整 schema）；实例级状态。 */
  readonly #expandedToolIds = new Set<string>();

  /** 标记一个工具为已展开；只影响本实例此后的 mixed 查询。 */
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

  /** 轻量 schema：只给名称和首行描述（最多 120 字符），参数为空对象。 */
  toLightweightSchemas(ids?: readonly string[] | null): ToolSchemaProjection[] {
    return this.querySchemas({ selection: ids, mode: 'lightweight' }).schemas;
  }

  /**
   * mixed 投影：
   *   - 已展开的工具 → 完整 schema（传入 model 时应用 modelOverrides）；
   *   - 未展开的工具 → 轻量 schema（名称加首行描述）。
   * 没有经过测量的 token 节省数据，这里不给比例。
   *
   * @param ids - 允许的工具 id；null/undefined 表示目录内全部可见工具
   * @param model - 当前模型名，用于匹配 modelOverrides
   * @param firstRound - 为 true 时所有工具都给完整 schema
   */
  toMixedSchemas(
    ids?: readonly string[] | null,
    model?: string,
    firstRound = false
  ): ToolSchemaProjection[] {
    return this.querySchemas({ selection: ids, model, mode: 'mixed', firstRound }).schemas;
  }

  protected override projectSchema(
    manifest: ToolCapabilityManifest,
    query: ToolSchemaQuery
  ): ToolSchemaProjection {
    const lightweight =
      query.mode === 'lightweight' ||
      (query.mode === 'mixed' && !query.firstRound && !this.#expandedToolIds.has(manifest.id));
    if (lightweight) {
      return super.projectSchema(manifest, { ...query, mode: 'lightweight' });
    }
    const def = this.#defs.get(manifest.id);
    return def && query.model
      ? definitionToSchemaProjection(def, query.model, query.apiModelId)
      : super.projectSchema(manifest, { ...query, mode: 'full' });
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
