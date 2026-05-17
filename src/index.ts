export * from './agent/context/index.js';
export * from './agent/index.js';
export * from './agent/memory/index.js';
export * from './external/ai/index.js';
export * from './tools/index.js';

export const alembicAgentPackage = Object.freeze({
  packageName: '@alembic/agent',
  migrationPhase: 'phase-5-memory-context',
  implementationStatus: 'memory-context-migrated',
});

export type AlembicAgentPackageInfo = typeof alembicAgentPackage;
