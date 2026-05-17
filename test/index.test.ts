import { describe, expect, it } from 'vitest';

import { alembicAgentPackage } from '../src/index.js';

describe('alembicAgentPackage', () => {
  it('marks the package as Phase 7 Tool V2 contract migration', () => {
    expect(alembicAgentPackage).toEqual({
      packageName: '@alembic/agent',
      migrationPhase: 'phase-7-tool-v2-contract',
      implementationStatus: 'tool-v2-contract-exported',
    });
  });
});
