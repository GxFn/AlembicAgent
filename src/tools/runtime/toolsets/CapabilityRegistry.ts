import type { Capability } from './Capability.js';
import { Conversation } from './Conversation.js';
import { Evolution } from './Evolution.js';
import { GenerateAnalyze } from './GenerateAnalyze.js';
import { GenerateProduce } from './GenerateProduce.js';
import { RelationExploration } from './RelationExploration.js';
import { ScanAnalyze } from './ScanAnalyze.js';
import { ScanProduce } from './ScanProduce.js';

type CapabilityConstructor = new (opts?: Record<string, unknown>) => Capability;

/**
 * 已从注册表撤下、不能再按名解析的能力，以及撤下原因（L4-P33 / I06）。
 *
 * system_interaction（System 类）同时开放 code.write 与没有 commandAllowlist 的 terminal.exec；
 * 注册在这里时，任何 profile 只要在 skills 里写上这个名字，编译后的 runtimeOverrides.capabilities
 * 就会经 AgentRuntimeBuilder.build / AgentRuntime 阶段能力解析拿到写文件与不受限终端权限。
 * 宿主生产与测试代码都不引用这个名称，所以先撤下注册；System 类与 barrel 导出是否删除
 * 随待决事项②处理，这里不动公开导出。
 *
 * 这张表只用于让误配 profile 的报错说明原因，不参与解析：撤下的名字一律按未知能力拒绝。
 */
const RETIRED_CAPABILITY_REASONS: ReadonlyMap<string, string> = new Map([
  [
    'system_interaction',
    'retired from the registry because it granted code.write and terminal.exec without a command allowlist',
  ],
]);

export const CapabilityRegistry = {
  _registry: new Map<string, CapabilityConstructor>([
    ['conversation', Conversation as CapabilityConstructor],
    ['code_analysis', GenerateAnalyze as CapabilityConstructor],
    ['knowledge_production', GenerateProduce as CapabilityConstructor],
    ['scan_production', ScanProduce as CapabilityConstructor],
    ['scan_analyze', ScanAnalyze as CapabilityConstructor],
    // system_interaction 不再注册：见 RETIRED_CAPABILITY_REASONS。
    ['evolution_analysis', Evolution as CapabilityConstructor],
    // relations pipeline explore 阶段的只读能力（L7-P19）；不含 submit/terminal/memory 写入。
    ['relation_exploration', RelationExploration as CapabilityConstructor],
  ]),

  create(name: string, opts: Record<string, unknown> = {}): Capability {
    const Cls = this._registry.get(name);
    if (!Cls) {
      // 未注册的名字一律拒绝，不回退到任何默认能力；撤下的名字附带原因，方便定位误配的 profile。
      const retiredReason = RETIRED_CAPABILITY_REASONS.get(name);
      throw new Error(
        retiredReason
          ? `Unknown capability: ${name} (${retiredReason})`
          : `Unknown capability: ${name}`
      );
    }
    return new Cls(opts);
  },

  register(name: string, cls: CapabilityConstructor) {
    this._registry.set(name, cls);
  },

  get names(): string[] {
    return [...this._registry.keys()];
  },
};
