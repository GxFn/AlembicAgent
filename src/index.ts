export * from './agent/context/index.js';
export * from './agent/index.js';
export * from './agent/memory/index.js';
export * from './external/ai/index.js';
export * from './tools/index.js';

export const alembicAgentPackage = Object.freeze({
  packageName: '@alembic/agent',
  migrationPhase: 'phase-7-tool-v2-contract',
  implementationStatus: 'tool-v2-contract-exported',
});

export type AlembicAgentPackageInfo = typeof alembicAgentPackage;
