import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveEnergyImportDependency } from '../server/worldmonitor/intelligence/v1/_energy-import-dependency.ts';

describe('resolveEnergyImportDependency', () => {
  it('publishes the audited World Bank observation with provenance', () => {
    const result = resolveEnergyImportDependency({
      iea: {
        energyImportDependency: {
          value: -9.001,
          year: 2023,
          source: 'worldbank',
        },
      },
    });

    assert.deepEqual(result, {
      available: true,
      value: -9.001,
      year: 2023,
      source: 'World Bank Open Data',
    });
  });

  it('does not turn a missing observation into a factual zero', () => {
    assert.deepEqual(resolveEnergyImportDependency({ iea: null }), {
      available: false,
      value: 0,
      year: 0,
      source: '',
    });
  });

  it('fails closed when provider provenance is not audited', () => {
    const result = resolveEnergyImportDependency({
      iea: {
        energyImportDependency: {
          value: 42,
          year: 2024,
          source: 'unknown-provider',
        },
      },
    });

    assert.equal(result.available, false);
    assert.equal(result.value, 0);
  });
});
