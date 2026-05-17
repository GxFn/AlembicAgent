import { describe, expect, it } from 'vitest';

import { alembicAgentPackage } from '../src/index.js';

describe('alembicAgentPackage', () => {
  it('marks the package as Phase 6 contract surface migration', () => {
    expect(alembicAgentPackage).toEqual({
      packageName: '@alembic/agent',
      migrationPhase: 'phase-6-contract-surface',
      implementationStatus: 'explicit-agent-subpaths-exported',
    });
  });
});
