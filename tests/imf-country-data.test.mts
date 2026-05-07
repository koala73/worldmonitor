import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildImfEconomicIndicators, type ImfCountryBundle } from '../src/services/imf-country-data.ts';

function bundle(overrides: Partial<ImfCountryBundle> = {}): ImfCountryBundle {
  return {
    macro: null,
    growth: null,
    labor: null,
    external: null,
    fetchedAt: 0,
    ...overrides,
  };
}

describe('buildImfEconomicIndicators (panel rendering)', () => {
  it('returns no rows when no IMF data is present', () => {
    assert.deepEqual(buildImfEconomicIndicators(bundle()), []);
  });

  it('renders real GDP growth + inflation + unemployment + GDP/capita rows', () => {
    const rows = buildImfEconomicIndicators(bundle({
      macro: {
        inflationPct: 3.4, currentAccountPct: -2.1, govRevenuePct: 30,
        cpiIndex: null, cpiEopPct: null, govExpenditurePct: null, primaryBalancePct: null,
        year: 2025,
      },
      growth: {
        realGdpGrowthPct: 2.7, gdpPerCapitaUsd: 78500, realGdp: null,
        gdpPerCapitaPpp: null, gdpPpp: null, investmentPct: null, savingsPct: null,
        savingsInvestmentGap: null, year: 2025,
      },
      labor: {
        unemploymentPct: 4.2, populationMillions: 333.3, year: 2025,
      },
    }));
    assert.deepEqual(rows.map(r => r.label), [
      'Real GDP Growth', 'CPI Inflation', 'Unemployment', 'GDP / Capita',
    ]);
    assert.equal(rows[0].value, '+2.7%');
    assert.equal(rows[0].trend, 'up');
    assert.equal(rows[1].value, '+3.4%');
    assert.equal(rows[1].trend, 'up'); // 3.4% inflation: warning but not crisis
    assert.equal(rows[2].value, '4.2%');
    assert.equal(rows[2].trend, 'up'); // <5% unemployment is good
    assert.equal(rows[3].value, '$78.5k');
    for (const row of rows) assert.equal(row.source, 'IMF WEO');
  });

  it('flags stagflation: rising inflation + contracting growth', () => {
    const rows = buildImfEconomicIndicators(bundle({
      macro: {
        inflationPct: 12, currentAccountPct: null, govRevenuePct: null,
        cpiIndex: null, cpiEopPct: null, govExpenditurePct: null, primaryBalancePct: null,
        year: 2025,
      },
      growth: {
        realGdpGrowthPct: -1.4, gdpPerCapitaUsd: null, realGdp: null,
        gdpPerCapitaPpp: null, gdpPpp: null, investmentPct: null, savingsPct: null,
        savingsInvestmentGap: null, year: 2025,
      },
    }));
    const growth = rows.find(r => r.label === 'Real GDP Growth')!;
    const infl = rows.find(r => r.label === 'CPI Inflation')!;
    assert.equal(growth.value, '-1.4%');
    assert.equal(growth.trend, 'down');
    assert.equal(infl.value, '+12.0%');
    assert.equal(infl.trend, 'down'); // >5% inflation flagged downward
  });

  it('marks high unemployment with a downward trend', () => {
    const rows = buildImfEconomicIndicators(bundle({
      labor: { unemploymentPct: 22.5, populationMillions: null, year: 2025 },
    }));
    const lur = rows.find(r => r.label === 'Unemployment')!;
    assert.equal(lur.value, '22.5%');
    assert.equal(lur.trend, 'down');
  });

  it('formats sub-$1k GDP/capita with the dollar prefix', () => {
    const rows = buildImfEconomicIndicators(bundle({
      growth: {
        realGdpGrowthPct: null, gdpPerCapitaUsd: 850, realGdp: null,
        gdpPerCapitaPpp: null, gdpPpp: null, investmentPct: null, savingsPct: null,
        savingsInvestmentGap: null, year: 2025,
      },
    }));
    const gdp = rows.find(r => r.label === 'GDP / Capita')!;
    assert.equal(gdp.value, '$850');
  });

  it('skips rows whose values are null or non-finite', () => {
    const rows = buildImfEconomicIndicators(bundle({
      macro: {
        inflationPct: NaN, currentAccountPct: null, govRevenuePct: null,
        cpiIndex: null, cpiEopPct: null, govExpenditurePct: null, primaryBalancePct: null,
        year: 2025,
      },
    }));
    assert.equal(rows.length, 0);
  });
});
