import { describe, expect, it } from 'vitest';

import { alembicAgentPackage } from '../src/index.js';

describe('alembicAgentPackage', () => {
  it('marks the package as Phase 9 terminal contract migration', () => {
    expect(alembicAgentPackage).toEqual({
      packageName: '@alembic/agent',
      migrationPhase: 'phase-9-terminal-contract',
      implementationStatus: 'terminal-contract-exported',
    });
  });
});
