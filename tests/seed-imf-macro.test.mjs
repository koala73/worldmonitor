import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildImfMacroCountries, fetchImfMacroCountries } from '../scripts/seed-imf-macro.mjs';

describe('seed-imf-macro', () => {
  it('maps IMF macro indicators into ISO2 countries', () => {
    const year = String(new Date().getFullYear());

    const countries = buildImfMacroCountries({
      inflationData: { USA: { [year]: 3.2 } },
      currentAccountData: { USA: { [year]: -2.4 } },
      govRevenueData: { USA: { [year]: 27.8 } },
      cpiIndexData: { USA: { [year]: 144.2 } },
      cpiEndPeriodInflationData: { USA: { [year]: 3.6 } },
      govExpenditureData: { USA: { [year]: 36.1 } },
      primaryBalanceData: { USA: { [year]: -1.9 } },
    });

    assert.ok(countries.US, 'USA should map to US');
    assert.equal(countries.US.inflationPct, 3.2);
    assert.equal(countries.US.currentAccountPct, -2.4);
    assert.equal(countries.US.govRevenuePct, 27.8);
    assert.equal(countries.US.cpiIndex, 144.2);
    assert.equal(countries.US.cpiEndPeriodInflationPct, 3.6);
    assert.equal(countries.US.govExpenditurePct, 36.1);
    assert.equal(countries.US.primaryBalancePct, -1.9);
    assert.equal(countries.US.year, Number(year));
  });

  it('keeps the core macro payload when optional IMF indicators fail', async () => {
    const year = String(new Date().getFullYear());
    const optionalFailures = new Set(['PCPI', 'PCPIEPCH', 'GGX', 'GGXONLB_NGDP']);
    const warnings = [];

    const countries = await fetchImfMacroCountries(async (indicator) => {
      if (indicator === 'PCPIPCH') return { USA: { [year]: 3.1 } };
      if (indicator === 'BCA_NGDPD') return { USA: { [year]: -2.0 } };
      if (indicator === 'GGR_NGDP') return { USA: { [year]: 28.4 } };
      if (optionalFailures.has(indicator)) throw new Error(`missing ${indicator}`);
      throw new Error(`unexpected indicator ${indicator}`);
    }, (message) => {
      warnings.push(message);
    });

    assert.ok(countries.US, 'core IMF macro data should still map even if optional series fail');
    assert.equal(countries.US.inflationPct, 3.1);
    assert.equal(countries.US.currentAccountPct, -2.0);
    assert.equal(countries.US.govRevenuePct, 28.4);
    assert.equal(countries.US.cpiIndex, null);
    assert.equal(countries.US.cpiEndPeriodInflationPct, null);
    assert.equal(countries.US.govExpenditurePct, null);
    assert.equal(countries.US.primaryBalancePct, null);
    assert.equal(warnings.length, optionalFailures.size);
  });
});
