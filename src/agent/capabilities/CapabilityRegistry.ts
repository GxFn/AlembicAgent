import type { Capability } from '#tools/runtime/toolsets/Capability.js';
import { Conversation } from '#tools/runtime/toolsets/Conversation.js';
import { Evolution } from '#tools/runtime/toolsets/Evolution.js';
import { GenerateAnalyze } from '#tools/runtime/toolsets/GenerateAnalyze.js';
import { GenerateProduce } from '#tools/runtime/toolsets/GenerateProduce.js';
import { ScanAnalyze } from '#tools/runtime/toolsets/ScanAnalyze.js';
import { ScanProduce } from '#tools/runtime/toolsets/ScanProduce.js';
import { System } from '#tools/runtime/toolsets/System.js';

type CapabilityConstructor = new (opts?: Record<string, unknown>) => Capability;

export const CapabilityRegistry = {
  _registry: new Map<string, CapabilityConstructor>([
    ['conversation', Conversation as CapabilityConstructor],
    ['code_analysis', GenerateAnalyze as CapabilityConstructor],
    ['knowledge_production', GenerateProduce as CapabilityConstructor],
    ['scan_production', ScanProduce as CapabilityConstructor],
    ['scan_analyze', ScanAnalyze as CapabilityConstructor],
    ['system_interaction', System as CapabilityConstructor],
    ['evolution_analysis', Evolution as CapabilityConstructor],
  ]),

  create(name: string, opts: Record<string, unknown> = {}): Capability {
    const Cls = this._registry.get(name);
    if (!Cls) {
      throw new Error(`Unknown capability: ${name}`);
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
