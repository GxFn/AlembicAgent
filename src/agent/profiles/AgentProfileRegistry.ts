import type { AgentProfileDefinition } from '../service/AgentRunContracts.js';
import { BUILTIN_PROFILES } from './definitions/index.js';

export class AgentProfileRegistry {
  #profiles = new Map<string, AgentProfileDefinition>();

  constructor(profiles: AgentProfileDefinition[] = BUILTIN_PROFILES) {
    for (const profile of profiles) {
      this.register(profile);
    }
  }

  register(profile: AgentProfileDefinition) {
    if (!profile.id) {
      throw new Error('Agent profile id is required');
    }
    this.#profiles.set(profile.id, snapshotProfile(profile));
    return this;
  }

  get(id: string) {
    const profile = this.#profiles.get(id);
    return profile ? snapshotProfile(profile) : null;
  }

  require(id: string) {
    const profile = this.get(id);
    if (!profile) {
      throw new Error(`Unknown agent profile: "${id}"`);
    }
    return profile;
  }

  list() {
    return [...this.#profiles.values()].map(snapshotProfile);
  }
}

/**
 * 注册表拥有声明；调用方可修改自己的快照，不能回写默认权限或下一次编译。
 *
 * 快照只接受纯 JSON 数据（L8-C02）：普通对象、数组、字符串、有限数字、布尔、null，以及会被省略的
 * undefined 对象字段。其余值在注册期带键路径 fail-fast，而不是让 JSON 往返静默改写语义：
 *   - 函数、Set/Map：保留原有拒绝文案；
 *   - RegExp 会被序列化成 {}，SafetyPolicy.commandBlacklist 随之退化成匹配一切的 /(?:)/；
 *   - Date 的 toJSON 先于 replacer 执行，value 已经是字符串，所以必须读 this[key] 取原值判断；
 *   - NaN / ±Infinity 会被写成 null，预算类数字因此悄悄失效；
 *   - 其他类实例（含 Policy）会丢掉原型与方法，只剩自有字段；bigint/symbol 不可序列化或被静默丢弃。
 * get/list 读出的快照也走这里，但存入的已是纯数据，不会再触发拒绝。
 */
function snapshotProfile(profile: AgentProfileDefinition): AgentProfileDefinition {
  // 记录每个容器在声明里的键路径，报错时能指出是哪一个字段，例如 defaults.policies[0].commandBlacklist[0]。
  const paths = new WeakMap<object, string>();
  const json = JSON.stringify(profile, function (this: unknown, key: string, value: unknown) {
    const holder = this as Record<string, unknown>;
    const parentPath = paths.get(holder) ?? '';
    const path = Array.isArray(holder)
      ? `${parentPath}[${key}]`
      : parentPath && key
        ? `${parentPath}.${key}`
        : key;
    // 原值：Date 等带 toJSON 的对象在 replacer 前已被转换，只有 holder[key] 还是声明里的真实值。
    const raw = holder[key];
    const rejection = describeNonJsonValue(raw);
    if (rejection) {
      throw new Error(nonJsonValueMessage(profile.id, path || '<root>', rejection));
    }
    // 子节点的 holder 是本次返回的 value（纯数据下与原值是同一个对象），按它登记路径。
    if (value && typeof value === 'object') {
      paths.set(value, path);
    }
    return value;
  });
  return JSON.parse(json) as AgentProfileDefinition;
}

/** 函数与 Set/Map 沿用旧文案前缀（调用方按它断言），其余非 JSON 值统一说明“只接受 JSON 数据”。 */
function nonJsonValueMessage(profileId: string, path: string, rejection: string) {
  if (rejection === 'function') {
    return `Agent profile "${profileId}" must not contain functions (at ${path})`;
  }
  if (rejection === 'Set' || rejection === 'Map') {
    return `Agent profile "${profileId}" must not contain Set or Map (at ${path}: ${rejection})`;
  }
  return `Agent profile "${profileId}" must contain only JSON data: ${path} is ${rejection}`;
}

/** 返回非纯 JSON 值的类别名；纯数据（含会被省略的 undefined）返回 null。 */
function describeNonJsonValue(value: unknown): string | null {
  if (typeof value === 'function') {
    return 'function';
  }
  if (typeof value === 'bigint' || typeof value === 'symbol') {
    return `a ${typeof value}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return Number.isNaN(value) ? 'NaN' : String(value);
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (value instanceof Set) {
    return 'Set';
  }
  if (value instanceof Map) {
    return 'Map';
  }
  if (Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    // 自带 toJSON 的普通对象会被替换成 toJSON 的返回值，声明内容同样被静默改写。
    return typeof (value as { toJSON?: unknown }).toJSON === 'function'
      ? 'an object with a toJSON method'
      : null;
  }
  const constructorName =
    typeof prototype?.constructor === 'function' && prototype.constructor.name
      ? prototype.constructor.name
      : 'object';
  return `a ${constructorName} instance`;
}

export default AgentProfileRegistry;
