import type { AgentProfileDefinition } from '../../service/AgentRunContracts.js';
import { EVOLUTION_PROFILES } from './evolution.profile.js';
import { GENERATE_PROFILES } from './generate.profile.js';
import { SCOPED_MODULE_MINING_PROFILES } from './module-mining/ScopedModuleMiningProfile.js';
import { PLAN_PROFILES } from './plan.profile.js';
import { RELATION_PROFILES } from './relation.profile.js';
import { SCAN_PROFILES } from './scan.profile.js';
import { SIGNAL_PROFILES } from './signal.profile.js';
import { TRANSLATION_PROFILES } from './translation.profile.js';

export const BUILTIN_PROFILES: AgentProfileDefinition[] = [
  ...SCAN_PROFILES,
  ...RELATION_PROFILES,
  ...EVOLUTION_PROFILES,
  ...PLAN_PROFILES,
  ...SCOPED_MODULE_MINING_PROFILES,
  ...TRANSLATION_PROFILES,
  // signal-analysis 没有调用入口，但数组内容是公开值且宿主测试仍引用，移除随事项②的退役包（L8-C12）。
  ...SIGNAL_PROFILES,
  ...GENERATE_PROFILES,
];
