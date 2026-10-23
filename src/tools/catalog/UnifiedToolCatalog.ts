/**
 * UnifiedToolCatalog — 继承 CapabilityCatalog 的能力 manifest 存储（以下为 2026-10 核对的当前事实）。
 *
 * 生产用途：宿主把它注册为 `toolRegistry` 单例，只用继承来的 `register(manifest)` 存放
 * Dashboard/Skill manifest。它不参与工具执行，也不提供模型 schema：
 *   - 运行时工具执行只走 ToolRouterAdapter → ToolRouter → ActionHandler，ToolRouter 不读取任何 catalog；
 *   - 模型 schema 由宿主注册为 `capabilityCatalog` 的 RuntimeCapabilityCatalog 提供，不经本类；
 *   - AgentRuntime 只把它当作 RuntimeConfig.toolRegistry 端口（has/getManifest）原样持有，
 *     不再从它取 router。
 *
 * 收窄记录（W2a-02，审阅包 L3-P09，按事项②删除）：router 绑定（setRouter/getRouter）、ToolDefinition
 * 注册与 handler 存取（registerDefinition(s)/getDefinition/getHandler/getInternalTool）、只对这类注册生效
 * 的按模型 schema 覆盖（toToolSchemasForModel 与 modelOverrides）以及实例级 lazy 展开状态
 * （markExpanded/markExpandedAll/resetExpanded/expandedCount、toLightweightSchemas/toMixedSchemas）
 * 都已删除。删除前四处扫描（Agent src/test、宿主生产与测试、Plugin、Dashboard、Core）没有生产调用方。
 * schema 投影、list 过滤与 manifest 读写现在完全继承 CapabilityCatalog，本类没有自有成员。
 *
 * @module tools/catalog/UnifiedToolCatalog
 */

import Logger from '@alembic/core/logging';
import { observeSafely } from '#shared/observers.js';
import { CapabilityCatalog } from '#tools/catalog/CapabilityCatalog.js';

export class UnifiedToolCatalog extends CapabilityCatalog {
  /**
   * 显式不接受参数：父类构造参数是 manifest 数组，JS 调用方若仍按旧签名传入 ToolDefinition 数组，
   * 不能被当成 manifest 注册（旧定义没有 owner/lifecycle/surfaces，注册后会污染 list 与 schema）。
   * 这类参数被跳过，并记一条 warn（参数个数、首个参数形状与迁移方式，不输出参数内容）；
   * TypeScript 调用方传任何参数都是编译错误（rest 参数类型为 never）。
   */
  constructor(...legacyDefinitions: never[]) {
    super([]);
    if (legacyDefinitions.length > 0) {
      const first: unknown = legacyDefinitions[0];
      const shape = Array.isArray(first) ? `array of ${first.length}` : typeof first;
      observeSafely(
        () =>
          Logger.getInstance().warn(
            `[UnifiedToolCatalog] ignored ${legacyDefinitions.length} constructor argument(s) ` +
              `(first: ${shape}); ToolDefinition registration was removed (W2a-02 / L3-P09) and the ` +
              'catalog starts empty; register capability manifests with register(manifest) instead'
          ),
        () => undefined
      );
    }
  }
}

export default UnifiedToolCatalog;
