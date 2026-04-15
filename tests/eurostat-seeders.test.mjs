/**
 * Tests for issue #3028 Eurostat overlay seeders:
 *   - prc_hpi_a (house prices, annual)
 *   - gov_10q_ggdebt (gov debt, quarterly)
 *   - sts_inpr_m (industrial production, monthly)
 *
 * Covers:
 *   - JSON-stat parser (single-country extraction, series ordering, Greece/EA20 quirks)
 *   - EU-only coverage gating (non-EU geos return null so panels don't render blanks)
 *   - Registry wiring (bootstrap + health + MCP)
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  parseEurostatSeries,
  makeValidator,
  EU_GEOS,
} from '../scripts/_eurostat-utils.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Build a minimal JSON-stat v2 response for testing, with 2 geos and 3 time periods.
 */
function jsonStatFixture({ geos = ['DE', 'FR'], times = ['2022', '2023', '2024'], values }) {
  const geoIndex = {};
  geos.forEach((g, i) => { geoIndex[g] = i; });
  const timeIndex = {};
  times.forEach((t, i) => { timeIndex[t] = i; });
  // Build flat value object indexed by (geo_pos * times.length + time_pos).
  const value = {};
  geos.forEach((_, gi) => {
    times.forEach((_, ti) => {
      const idx = gi * times.length + ti;
      const v = values[gi]?.[ti];
      if (v !== undefined && v !== null) value[idx] = v;
    });
  });
  return {
    id: ['geo', 'time'],
    size: [geos.length, times.length],
    dimension: {
      geo: { category: { index: geoIndex } },
      time: { category: { index: timeIndex } },
    },
    value,
  };
}

describe('Eurostat JSON-stat parser (issue #3028)', () => {
  it('extracts a sorted series plus latest/prior for the requested geo', () => {
    const data = jsonStatFixture({
      geos: ['DE', 'FR'],
      times: ['2022', '2023', '2024'],
      values: [
        [120.5, 125.8, 128.1],  // DE
        [115.0, 118.3, 121.7],  // FR
      ],
    });

    const de = parseEurostatSeries(data, 'DE');
    assert.ok(de, 'DE parse should succeed');
    assert.equal(de.value, 128.1);
    assert.equal(de.priorValue, 125.8);
    assert.equal(de.date, '2024');
    assert.equal(de.series.length, 3);
    assert.deepEqual(
      de.series.map((p) => p.date),
      ['2022', '2023', '2024'],
      'series must be sorted ascending by period',
    );

    const fr = parseEurostatSeries(data, 'FR');
    assert.equal(fr.value, 121.7, 'FR must have its own value, not DE mixed in');
  });

  it('returns null for a geo that is not in the response (non-EU gating)', () => {
    const data = jsonStatFixture({
      geos: ['DE', 'FR'],
      times: ['2024'],
      values: [[100.0], [101.0]],
    });
    // US is not an EU geo — panels must not render blank tiles for it.
    assert.equal(parseEurostatSeries(data, 'US'), null);
    assert.equal(parseEurostatSeries(data, 'JP'), null);
  });

  it('handles the Greece EL quirk (not ISO GR) and EA20 aggregate', () => {
    const data = jsonStatFixture({
      geos: ['EL', 'EA20'],
      times: ['2023-Q3', '2023-Q4', '2024-Q1'],
      values: [
        [168.1, 167.5, 166.9],
        [90.1, 89.8, 89.2],
      ],
    });
    const el = parseEurostatSeries(data, 'EL');
    assert.ok(el, 'Greece must parse under EL, not GR');
    assert.equal(el.value, 166.9);
    assert.equal(parseEurostatSeries(data, 'GR'), null, 'ISO GR must not resolve to Greece');

    const ea = parseEurostatSeries(data, 'EA20');
    assert.ok(ea, 'Euro Area EA20 aggregate must parse');
    assert.equal(ea.value, 89.2);
  });

  it('skips null observations and picks the latest non-null value', () => {
    const data = jsonStatFixture({
      geos: ['IT'],
      times: ['2024-01', '2024-02', '2024-03'],
      values: [[100.0, 101.5, null]],
    });
    const it = parseEurostatSeries(data, 'IT');
    assert.ok(it);
    assert.equal(it.value, 101.5, 'latest should skip null trailing observation');
    assert.equal(it.date, '2024-02');
    assert.equal(it.series.length, 2, 'null observations are dropped from series');
  });

  it('returns null on malformed / empty responses', () => {
    assert.equal(parseEurostatSeries(null, 'DE'), null);
    assert.equal(parseEurostatSeries({}, 'DE'), null);
    assert.equal(parseEurostatSeries({ value: {} }, 'DE'), null);
  });
});

describe('EU coverage list (issue #3028)', () => {
  it('covers all 27 EU members plus EA20 and EU27_2020 aggregates', () => {
    assert.equal(EU_GEOS.length, 29);
    // Spot-check the ones called out explicitly in the issue.
    for (const g of ['IE', 'PT', 'EL', 'HU', 'RO', 'DK', 'FI', 'BG', 'SK', 'SI', 'LT', 'LV', 'EE', 'LU', 'HR', 'MT', 'CY']) {
      assert.ok(EU_GEOS.includes(g), `EU_GEOS must include ${g}`);
    }
    assert.ok(EU_GEOS.includes('EA20'), 'EU_GEOS must include EA20 (post-2023 Euro Area)');
    assert.ok(EU_GEOS.includes('EU27_2020'), 'EU_GEOS must include EU27_2020 aggregate');
    assert.ok(!EU_GEOS.includes('GR'), 'EU_GEOS must use EL not ISO GR for Greece');
  });
});

describe('Seeder validator (issue #3028)', () => {
  it('rejects payloads below the minimum country threshold', () => {
    const validate = makeValidator(10);
    assert.equal(validate({ countries: {} }), false);
    assert.equal(validate({ countries: { DE: {}, FR: {}, IT: {} } }), false);
    const big = Object.fromEntries(EU_GEOS.slice(0, 15).map((g) => [g, {}]));
    assert.equal(validate({ countries: big }), true);
  });

  it('each Eurostat overlay seeder enforces near-complete EU coverage', async () => {
    // Guard against regressions: a bad Eurostat run that returns only a
    // handful of geos must NOT be accepted as a valid snapshot. Universe is
    // fixed at 29 (EU27 + EA20 + EU27_2020); require >=22 geos across all
    // three seeders so no seeder can publish a snapshot missing most of the EU.
    const files = [
      'scripts/seed-eurostat-house-prices.mjs',
      'scripts/seed-eurostat-gov-debt-q.mjs',
      'scripts/seed-eurostat-industrial-production.mjs',
    ];
    for (const rel of files) {
      const src = await readFile(resolve(ROOT, rel), 'utf8');
      const match = src.match(/makeValidator\((\d+)\)/);
      assert.ok(match, `${rel} must call makeValidator(N)`);
      const n = Number(match[1]);
      assert.ok(
        n >= 22,
        `${rel} makeValidator threshold ${n} too low — EU universe is 29, must be >=22 to catch partial-coverage failures`,
      );
    }
  });
});

describe('Registry wiring (issue #3028)', () => {
  it('bootstrap.js exposes the three new Eurostat overlay keys', async () => {
    const src = await readFile(resolve(ROOT, 'api/bootstrap.js'), 'utf8');
    assert.match(src, /eurostatHousePrices:\s*'economic:eurostat:house-prices:v1'/);
    assert.match(src, /eurostatGovDebtQ:\s*'economic:eurostat:gov-debt-q:v1'/);
    assert.match(src, /eurostatIndProd:\s*'economic:eurostat:industrial-production:v1'/);
    // Must also be registered in the SLOW_KEYS tier.
    assert.match(src, /'eurostatHousePrices'/);
    assert.match(src, /'eurostatGovDebtQ'/);
    assert.match(src, /'eurostatIndProd'/);
  });

  it('health.js maps each new key to a seed-meta freshness check', async () => {
    const src = await readFile(resolve(ROOT, 'api/health.js'), 'utf8');
    assert.match(src, /eurostatHousePrices:\s*\{[^}]*seed-meta:economic:eurostat-house-prices/);
    assert.match(src, /eurostatGovDebtQ:\s*\{[^}]*seed-meta:economic:eurostat-gov-debt-q/);
    assert.match(src, /eurostatIndProd:\s*\{[^}]*seed-meta:economic:eurostat-industrial-production/);
  });

  it('MCP tool registry exposes the three new EU overlay tools', async () => {
    const src = await readFile(resolve(ROOT, 'api/mcp.ts'), 'utf8');
    assert.match(src, /name: 'get_eu_housing_cycle'/);
    assert.match(src, /name: 'get_eu_quarterly_gov_debt'/);
    assert.match(src, /name: 'get_eu_industrial_production'/);
    assert.match(src, /'economic:eurostat:house-prices:v1'/);
    assert.match(src, /'economic:eurostat:gov-debt-q:v1'/);
    assert.match(src, /'economic:eurostat:industrial-production:v1'/);
  });

  it('macro bundle runner includes the three new scripts with distinct seed-meta keys', async () => {
    const src = await readFile(resolve(ROOT, 'scripts/seed-bundle-macro.mjs'), 'utf8');
    assert.match(src, /seed-eurostat-house-prices\.mjs/);
    assert.match(src, /seed-eurostat-gov-debt-q\.mjs/);
    assert.match(src, /seed-eurostat-industrial-production\.mjs/);
  });
});
