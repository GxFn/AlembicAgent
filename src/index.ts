export * from './agent/context/index.js';
export * from './agent/index.js';
export * from './agent/memory/index.js';
export * from './external/ai/index.js';
export * from './tools/index.js';

export const alembicAgentPackage = Object.freeze({
  packageName: '@alembic/agent',
  migrationPhase: 'phase-10-remote-bridge-removal',
  implementationStatus: 'remote-bridge-contract-removed',
});

export type AlembicAgentPackageInfo = typeof alembicAgentPackage;
