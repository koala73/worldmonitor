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

  it('renders real GDP growth + inflation + unemployment + GDP/capita + revenue rows', () => {
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
      'Real GDP Growth', 'CPI Inflation', 'Unemployment', 'GDP / Capita', 'Gov Revenue',
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

  it('renders public spending %GDP with a flat trend (level is descriptive, not directional)', () => {
    const rows = buildImfEconomicIndicators(bundle({
      macro: {
        inflationPct: null, currentAccountPct: null, govRevenuePct: null,
        cpiIndex: null, cpiEopPct: null, govExpenditurePct: 57.2, primaryBalancePct: null,
        year: 2024,
      },
    }));
    const spend = rows.find(r => r.label === 'Public Spending')!;
    assert.equal(spend.value, '57.2% GDP');
    assert.equal(spend.trend, 'flat');
    assert.equal(spend.source, 'IMF WEO');
  });

  it('renders gov revenue %GDP with a flat trend', () => {
    const rows = buildImfEconomicIndicators(bundle({
      macro: {
        inflationPct: null, currentAccountPct: null, govRevenuePct: 32.5,
        cpiIndex: null, cpiEopPct: null, govExpenditurePct: null, primaryBalancePct: null,
        year: 2024,
      },
    }));
    const rev = rows.find(r => r.label === 'Gov Revenue')!;
    assert.equal(rev.value, '32.5% GDP');
    assert.equal(rev.trend, 'flat');
    assert.equal(rev.source, 'IMF WEO');
  });

  it('marks meaningful primary surplus (>+1) with an upward trend and signed value', () => {
    const rows = buildImfEconomicIndicators(bundle({
      macro: {
        inflationPct: null, currentAccountPct: null, govRevenuePct: null,
        cpiIndex: null, cpiEopPct: null, govExpenditurePct: null, primaryBalancePct: 2.1,
        year: 2024,
      },
    }));
    const pb = rows.find(r => r.label === 'Primary Balance')!;
    assert.equal(pb.value, '+2.1% GDP');
    assert.equal(pb.trend, 'up');
    assert.equal(pb.source, 'IMF WEO');
  });

  it('keeps primary balance flat for small surplus (between 0 and +1)', () => {
    const rows = buildImfEconomicIndicators(bundle({
      macro: {
        inflationPct: null, currentAccountPct: null, govRevenuePct: null,
        cpiIndex: null, cpiEopPct: null, govExpenditurePct: null, primaryBalancePct: 0.5,
        year: 2024,
      },
    }));
    const pb = rows.find(r => r.label === 'Primary Balance')!;
    assert.equal(pb.value, '+0.5% GDP');
    assert.equal(pb.trend, 'flat');
  });

  it('keeps primary balance flat for mild deficit (between -3 and 0)', () => {
    const rows = buildImfEconomicIndicators(bundle({
      macro: {
        inflationPct: null, currentAccountPct: null, govRevenuePct: null,
        cpiIndex: null, cpiEopPct: null, govExpenditurePct: null, primaryBalancePct: -1.0,
        year: 2024,
      },
    }));
    const pb = rows.find(r => r.label === 'Primary Balance')!;
    assert.equal(pb.value, '-1.0% GDP');
    assert.equal(pb.trend, 'flat');
  });

  it('orders directional rows before flat context rows so Primary Balance survives the caller\'s 6-row slice', () => {
    // When all 7 IMF rows fire, the consumer (CountryDeepDivePanel via
    // country-intel.ts:1288) caps the indicators array at 6. If Primary
    // Balance — the most informative directional fiscal signal — were
    // emitted last, it would be the first row sliced off. Order asserts
    // the priority: directional macro rows first (growth / inflation /
    // unemployment / primary balance), then flat context rows
    // (gdp-per-capita / public spending / gov revenue).
    const rows = buildImfEconomicIndicators(bundle({
      macro: {
        inflationPct: 3.4, currentAccountPct: -2.1, govRevenuePct: 30,
        cpiIndex: null, cpiEopPct: null, govExpenditurePct: 57.2, primaryBalancePct: -2.5,
        year: 2024,
      },
      growth: {
        realGdpGrowthPct: 0.7, gdpPerCapitaUsd: 47800, realGdp: null,
        gdpPerCapitaPpp: null, gdpPpp: null, investmentPct: null, savingsPct: null,
        savingsInvestmentGap: null, year: 2024,
      },
      labor: {
        unemploymentPct: 7.4, populationMillions: 65.5, year: 2024,
      },
    }));
    assert.deepEqual(rows.map(r => r.label), [
      'Real GDP Growth',
      'CPI Inflation',
      'Unemployment',
      'Primary Balance',
      'GDP / Capita',
      'Public Spending',
      'Gov Revenue',
    ]);
  });

  it('marks severe primary deficit (<-3) with a downward trend', () => {
    const rows = buildImfEconomicIndicators(bundle({
      macro: {
        inflationPct: null, currentAccountPct: null, govRevenuePct: null,
        cpiIndex: null, cpiEopPct: null, govExpenditurePct: null, primaryBalancePct: -4.0,
        year: 2024,
      },
    }));
    const pb = rows.find(r => r.label === 'Primary Balance')!;
    assert.equal(pb.value, '-4.0% GDP');
    assert.equal(pb.trend, 'down');
  });

  it('keeps primary balance flat at the exact upper boundary (+1.0)', () => {
    // Pins the inclusivity of `> 1` so a future refactor to `>= 1`
    // would be caught (greptile P2: PR #3668).
    const rows = buildImfEconomicIndicators(bundle({
      macro: {
        inflationPct: null, currentAccountPct: null, govRevenuePct: null,
        cpiIndex: null, cpiEopPct: null, govExpenditurePct: null, primaryBalancePct: 1.0,
        year: 2024,
      },
    }));
    const pb = rows.find(r => r.label === 'Primary Balance')!;
    assert.equal(pb.value, '+1.0% GDP');
    assert.equal(pb.trend, 'flat');
  });

  it('keeps primary balance flat at the exact lower boundary (-3.0)', () => {
    // Pins the inclusivity of `< -3` so a future refactor to `<= -3`
    // would be caught (greptile P2: PR #3668).
    const rows = buildImfEconomicIndicators(bundle({
      macro: {
        inflationPct: null, currentAccountPct: null, govRevenuePct: null,
        cpiIndex: null, cpiEopPct: null, govExpenditurePct: null, primaryBalancePct: -3.0,
        year: 2024,
      },
    }));
    const pb = rows.find(r => r.label === 'Primary Balance')!;
    assert.equal(pb.value, '-3.0% GDP');
    assert.equal(pb.trend, 'flat');
  });

  it('skips rows whose values are null or non-finite (covers all 7 IMF fields)', () => {
    // Covers Number.isFinite guards across every IMF field — not just
    // inflation. Catches a future regression where the guard is dropped
    // on one of the new fiscal fields (greptile P2: PR #3668).
    const rows = buildImfEconomicIndicators(bundle({
      macro: {
        inflationPct: NaN,
        currentAccountPct: null,
        govRevenuePct: Infinity,
        cpiIndex: null,
        cpiEopPct: null,
        govExpenditurePct: NaN,
        primaryBalancePct: -Infinity,
        year: 2025,
      },
      growth: {
        realGdpGrowthPct: NaN,
        gdpPerCapitaUsd: Infinity,
        realGdp: null,
        gdpPerCapitaPpp: null,
        gdpPpp: null,
        investmentPct: null,
        savingsPct: null,
        savingsInvestmentGap: null,
        year: 2025,
      },
      labor: {
        unemploymentPct: NaN,
        populationMillions: null,
        year: 2025,
      },
    }));
    assert.equal(rows.length, 0);
  });
});
