// Tool-runtime capabilities (re-exported from the runtime capability modules)
export { BootstrapAnalyze as CodeAnalysis } from '#tools/runtime/capabilities/BootstrapAnalyze.js';
export { BootstrapProduce as KnowledgeProduction } from '#tools/runtime/capabilities/BootstrapProduce.js';
export { Conversation } from '#tools/runtime/capabilities/Conversation.js';
export { Evolution as EvolutionAnalysis } from '#tools/runtime/capabilities/Evolution.js';
export { ScanProduce as ScanProduction } from '#tools/runtime/capabilities/ScanProduce.js';
export { System as SystemInteraction } from '#tools/runtime/capabilities/System.js';
export { Capability } from './Capability.js';
export { CapabilityRegistry } from './CapabilityRegistry.js';

import { BootstrapAnalyze } from '#tools/runtime/capabilities/BootstrapAnalyze.js';
import { BootstrapProduce } from '#tools/runtime/capabilities/BootstrapProduce.js';
import { Conversation } from '#tools/runtime/capabilities/Conversation.js';
import { Evolution } from '#tools/runtime/capabilities/Evolution.js';
import { System } from '#tools/runtime/capabilities/System.js';
import { Capability } from './Capability.js';
import { CapabilityRegistry } from './CapabilityRegistry.js';

export default {
  Capability,
  Conversation: Conversation,
  CodeAnalysis: BootstrapAnalyze,
  KnowledgeProduction: BootstrapProduce,
  SystemInteraction: System,
  EvolutionAnalysis: Evolution,
  CapabilityRegistry,
};
