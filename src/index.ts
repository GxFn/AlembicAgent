export * from './agent/index.js';
export * from './external/ai/index.js';

export const alembicAgentPackage = Object.freeze({
  packageName: '@alembic/agent',
  migrationPhase: 'phase-3-ai-provider',
  implementationStatus: 'ai-provider-migrated',
});

export type AlembicAgentPackageInfo = typeof alembicAgentPackage;
