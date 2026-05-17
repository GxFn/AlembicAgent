import { describe, expect, it } from 'vitest';

import { alembicAgentPackage } from '../src/index.js';

describe('alembicAgentPackage', () => {
  it('marks the package as Phase 10 remote bridge removal', () => {
    expect(alembicAgentPackage).toEqual({
      packageName: '@alembic/agent',
      migrationPhase: 'phase-10-remote-bridge-removal',
      implementationStatus: 'remote-bridge-contract-removed',
    });
  });
});
