import { describe, expect, it } from 'vitest';

import { alembicAgentPackage } from '../src/index.js';

describe('alembicAgentPackage', () => {
  it('exposes the stable package descriptor', () => {
    expect(alembicAgentPackage).toEqual({
      packageName: '@alembic/agent',
    });
  });
});
