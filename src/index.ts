export * from './agent/index.js';
export * from './external/ai/index.js';
export * from './tools/index.js';

export const alembicAgentPackage = Object.freeze({
  packageName: '@alembic/agent',
  migrationPhase: 'phase-4-tool-system',
  implementationStatus: 'tool-system-migrated',
});

export type AlembicAgentPackageInfo = typeof alembicAgentPackage;
