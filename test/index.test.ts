import { describe, expect, it } from 'vitest';

import { alembicAgentPackage } from '../src/index.js';

describe('alembicAgentPackage', () => {
  it('marks the package as Phase 8 remaining host contract migration', () => {
    expect(alembicAgentPackage).toEqual({
      packageName: '@alembic/agent',
      migrationPhase: 'phase-8-remaining-host-contract',
      implementationStatus: 'remaining-host-contract-exported',
    });
  });
});
