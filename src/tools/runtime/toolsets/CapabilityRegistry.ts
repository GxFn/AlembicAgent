import type { Capability } from './Capability.js';
import { Conversation } from './Conversation.js';
import { Evolution } from './Evolution.js';
import { GenerateAnalyze } from './GenerateAnalyze.js';
import { GenerateProduce } from './GenerateProduce.js';
import { ScanAnalyze } from './ScanAnalyze.js';
import { ScanProduce } from './ScanProduce.js';
import { System } from './System.js';

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
