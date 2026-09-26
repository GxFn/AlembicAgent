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

/** 注册表拥有声明；调用方可修改自己的快照，不能回写默认权限或下一次编译。 */
function snapshotProfile(profile: AgentProfileDefinition): AgentProfileDefinition {
  const json = JSON.stringify(profile, (_key, value) => {
    if (typeof value === 'function') {
      throw new Error(`Agent profile "${profile.id}" must not contain functions`);
    }
    if (value instanceof Set || value instanceof Map) {
      throw new Error(`Agent profile "${profile.id}" must not contain Set or Map`);
    }
    return value;
  });
  return JSON.parse(json) as AgentProfileDefinition;
}

export default AgentProfileRegistry;
