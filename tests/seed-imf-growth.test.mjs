import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildImfGrowthCountries } from '../scripts/seed-imf-growth.mjs';

describe('seed-imf-growth', () => {
  it('maps IMF growth indicators into ISO2 countries and derives savings-investment gap', () => {
    const year = String(new Date().getFullYear());
    const prev = String(Number(year) - 1);

    const countries = buildImfGrowthCountries({
      realGdpGrowthData: { USA: { [prev]: 1.5, [year]: 2.4 } },
      nominalGdpPerCapitaData: { USA: { [year]: 81200 } },
      realGdpLocalData: { USA: { [year]: 23000 } },
      pppPerCapitaData: { USA: { [year]: 90000 } },
      pppGdpData: { USA: { [year]: 29500 } },
      investmentData: { USA: { [year]: 21.2 } },
      savingsData: { USA: { [year]: 18.7 } },
    });

    assert.ok(countries.US, 'USA should map to US');
    assert.equal(countries.US.realGdpGrowthPct, 2.4);
    assert.equal(countries.US.nominalGdpPerCapitaUsd, 81200);
    assert.equal(countries.US.savingsInvestmentGapPctGdp, -2.5);
    assert.equal(countries.US.year, Number(year));
  });

  it('filters IMF aggregate rows', () => {
    const year = String(new Date().getFullYear());
    const countries = buildImfGrowthCountries({
      realGdpGrowthData: {
        USA: { [year]: 2.1 },
        WEOWORLD: { [year]: 3.0 },
        G20: { [year]: 2.6 },
      },
      nominalGdpPerCapitaData: {},
      realGdpLocalData: {},
      pppPerCapitaData: {},
      pppGdpData: {},
      investmentData: {},
      savingsData: {},
    });

    assert.ok(countries.US, 'country rows should be preserved');
    assert.ok(!countries.WEOWORLD, 'WEOWORLD aggregate should be excluded');
    assert.ok(!countries.G20, 'G20 aggregate should be excluded');
  });
});
