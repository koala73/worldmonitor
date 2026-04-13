import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildImfExternalCountries } from '../scripts/seed-imf-external.mjs';

describe('seed-imf-external', () => {
  it('maps balance-of-payments indicators and derives trade balance', () => {
    const year = String(new Date().getFullYear());
    const countries = buildImfExternalCountries({
      exportsData: { USA: { [year]: 3100 } },
      importsData: { USA: { [year]: 4100 } },
      currentAccountData: { USA: { [year]: -950 } },
      importVolumeGrowthData: { USA: { [year]: 2.0 } },
      exportVolumeGrowthData: { USA: { [year]: 1.4 } },
    });

    assert.ok(countries.US, 'USA should map to US');
    assert.equal(countries.US.exportsUsd, 3100);
    assert.equal(countries.US.importsUsd, 4100);
    assert.equal(countries.US.tradeBalanceUsd, -1000);
    assert.equal(countries.US.currentAccountUsd, -950);
  });

  it('filters IMF aggregate rows', () => {
    const year = String(new Date().getFullYear());
    const countries = buildImfExternalCountries({
      exportsData: { WEOWORLD: { [year]: 1000 }, USA: { [year]: 100 } },
      importsData: {},
      currentAccountData: {},
      importVolumeGrowthData: {},
      exportVolumeGrowthData: {},
    });

    assert.ok(countries.US, 'country rows should be preserved');
    assert.ok(!countries.WEOWORLD, 'WEOWORLD aggregate should be excluded');
  });
});
