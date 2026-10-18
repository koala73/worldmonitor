import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  DATASETS,
  imfHarmonisedCpi,
  parseEurostatResponse,
  pickFresherCpi,
  withImfCpiFallback,
} from '../scripts/seed-eurostat-country-data.mjs';

// Eurostat froze prc_hicp_manr (and the rest of the ECOICOP ver. 1 HICP family)
// at 2025-12 when HICP moved to ECOICOP ver. 2; prc_hicp_minr continues the
// series, with the basket keyed as coicop18 and the rate selected by unit.
describe('Eurostat country tile CPI', () => {
  it('reads the annual HICP rate from the live ECOICOP ver. 2 dataset', () => {
    assert.equal(DATASETS.cpi.id, 'prc_hicp_minr');
    assert.equal(DATASETS.cpi.params.coicop18, 'TOTAL');
    assert.equal(DATASETS.cpi.params.unit, 'RCH_A');
    assert.equal(DATASETS.cpi.params.coicop, undefined);
  });

  it('takes the newest and prior print from a prc_hicp_minr cube', () => {
    // Shape captured live 2026-09-23 (geo=DE&geo=FR, lastTimePeriod=2).
    const minr = {
      id: ['freq', 'unit', 'coicop18', 'geo', 'time'],
      size: [1, 1, 1, 2, 2],
      dimension: {
        geo: { category: { index: { DE: 0, FR: 1 } } },
        time: { category: { index: { '2026-07': 0, '2026-08': 1 } } },
      },
      value: { 0: 2.8, 1: 2.9, 2: 2.4, 3: 2.6 },
    };
    assert.deepEqual(parseEurostatResponse(minr, 'DE'), {
      value: 2.9, priorValue: 2.8, hasPrior: true, date: '2026-08',
    });
    assert.deepEqual(parseEurostatResponse(minr, 'FR'), {
      value: 2.6, priorValue: 2.4, hasPrior: true, date: '2026-08',
    });
  });
});

// The tile read Eurostat directly with no fallback, so the 2025-12 freeze was
// served as current for nine months. IMF's harmonised series is the same HICP
// measure (already seeded by seed-world-cpi-imf), so the tile falls back to it
// whenever it carries a newer month than Eurostat.
describe('Eurostat country tile CPI fallback to IMF harmonised HICP', () => {
  const dates = [
    '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01',
    '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
  ];
  // Year-ago 100 -> 102.9 (2.9%); prior month 100 -> 102.8 (2.8%).
  const values = [100, 100, 100.5, 100.6, 100.8, 101, 101.1, 101.3, 101.6, 101.9, 102.2, 102.4, 102.8, 102.9];
  const imf = {
    harmonised: {
      DE: { frequency: 'M', indexBase: '2020=100', points: dates.map((date, i) => ({ date, value: values[i] })) },
      FR: { frequency: 'M', points: [{ date: '2026-08', value: 120 }] },
    },
  };

  it('derives the latest and prior annual rate from the IMF index', () => {
    assert.deepEqual(imfHarmonisedCpi(imf, 'DE'), { value: 2.9, priorValue: 2.8, date: '2026-08', unit: '%' });
  });

  it('returns null without a year-ago point or for an unknown country', () => {
    assert.equal(imfHarmonisedCpi(imf, 'FR'), null);
    assert.equal(imfHarmonisedCpi(imf, 'PL'), null);
    assert.equal(imfHarmonisedCpi(null, 'DE'), null);
  });

  it('keeps Eurostat unless IMF carries a newer month', () => {
    const eurostatCurrent = { value: 2.9, priorValue: 2.8, date: '2026-08', unit: '%' };
    const eurostatFrozen = { value: 2.0, priorValue: 2.6, date: '2025-12', unit: '%' };
    const imfCpi = { value: 3.0, priorValue: 2.8, date: '2026-08', unit: '%' };
    assert.equal(pickFresherCpi(eurostatCurrent, imfCpi), eurostatCurrent);
    assert.equal(pickFresherCpi(eurostatFrozen, imfCpi), imfCpi);
    assert.equal(pickFresherCpi(undefined, imfCpi), imfCpi);
    assert.equal(pickFresherCpi(eurostatFrozen, null), eurostatFrozen);
  });

  it('replaces a frozen or missing Eurostat CPI per country and leaves other metrics alone', () => {
    const countries = {
      DE: {
        cpi: { value: 2.0, priorValue: 2.6, date: '2025-12', unit: '%' },
        unemployment: { value: 3.4, date: '2026-07', unit: '%' },
      },
      FR: { unemployment: { value: 7.5, date: '2026-07', unit: '%' } },
    };
    const { countries: out, imfCount } = withImfCpiFallback(countries, imf);
    assert.deepEqual(out.DE.cpi, { value: 2.9, priorValue: 2.8, date: '2026-08', unit: '%' });
    assert.deepEqual(out.DE.unemployment, countries.DE.unemployment);
    assert.equal(out.FR.cpi, undefined);
    assert.equal(imfCount, 1);
  });
});
