import type { AgentProfileDefinition } from '../../service/AgentRunContracts.js';
import { BOOTSTRAP_PROFILES } from './bootstrap.profile.js';
import { CHAT_PROFILES } from './chat.profile.js';
import { EVOLUTION_PROFILES } from './evolution.profile.js';
import { PROJECT_INDEX_MODULE_MINING_PROFILES } from './module-mining/ProjectIndexModuleMiningProfile.js';
import { PLAN_PROFILES } from './plan.profile.js';
import { RELATION_PROFILES } from './relation.profile.js';
import { SCAN_PROFILES } from './scan.profile.js';
import { SIGNAL_PROFILES } from './signal.profile.js';
import { TRANSLATION_PROFILES } from './translation.profile.js';

export const BUILTIN_PROFILES: AgentProfileDefinition[] = [
  ...CHAT_PROFILES,
  ...SCAN_PROFILES,
  ...RELATION_PROFILES,
  ...EVOLUTION_PROFILES,
  ...PLAN_PROFILES,
  ...PROJECT_INDEX_MODULE_MINING_PROFILES,
  ...TRANSLATION_PROFILES,
  ...SIGNAL_PROFILES,
  ...BOOTSTRAP_PROFILES,
];
