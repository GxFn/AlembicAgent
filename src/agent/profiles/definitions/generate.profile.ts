import type { AgentProfileDefinition } from '../../service/AgentRunContracts.js';

export const GENERATE_PROFILES: AgentProfileDefinition[] = [
  {
    id: 'generate-session',
    title: 'Bootstrap Session',
    serviceKind: 'system-analysis',
    lifecycle: 'experimental',
    basePreset: 'insight',
    defaults: {
      actionSpace: { mode: 'none' },
    },
    strategy: {
      type: 'fanout',
      childProfile: 'generate-dimension',
      partitioner: 'generateSessionDimensions',
      merge: 'generateSessionResults',
    },
    concurrency: {
      mode: 'tiered',
      concurrency: { env: 'ALEMBIC_BOOTSTRAP_CONCURRENCY', default: 2 },
      partitioner: 'generateSessionDimensions',
      childProfile: 'generate-dimension',
      merge: 'generateSessionResults',
      abortPolicy: 'finish-tier',
    },
    projection: 'agent-result',
  },
  {
    id: 'generate-dimension',
    title: 'Bootstrap Dimension',
    serviceKind: 'system-analysis',
    lifecycle: 'experimental',
    basePreset: 'insight',
    defaults: {
      actionSpace: { mode: 'none' },
    },
    strategy: { type: 'pipeline', factory: 'generateDimensionPipeline' },
    projection: 'agent-result',
  },
];
