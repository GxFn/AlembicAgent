export const alembicAgentPackage = Object.freeze({
  packageName: '@alembic/agent',
  migrationPhase: 'phase-1-bootstrap',
  implementationStatus: 'bootstrap-only',
});

export type AlembicAgentPackageInfo = typeof alembicAgentPackage;
