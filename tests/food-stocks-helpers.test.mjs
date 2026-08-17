import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FOOD_STOCKS_CANONICAL_KEY,
  FOOD_STOCKS_MAX_CONTENT_AGE_MIN,
  FOOD_STOCKS_WORLD_KEY,
  PSD_ATTRIBUTES,
  PSD_COMMODITIES,
  COMMODITY_KCAL_PER_KG,
  applyFaostatProductionFill,
  bucketKey,
  buildCountryRecord,
  computeCalorieWeightedStocksToUse,
  computeStocksToUseRatio,
  foodStocksContentMeta,
  formatMarketingYear,
  normalizePsdCountryCode,
  parsePsdForecastRows,
} from '../scripts/_food-stocks-helpers.mjs';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'food-stocks');

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

describe('PSD commodity registry', () => {
  test('staple set includes wheat, corn, rice, soybeans plus barley and palm oil', () => {
    assert.deepEqual(Object.keys(PSD_COMMODITIES).sort(), [
      'barley',
      'corn',
      'palmOil',
      'rice',
      'soybeans',
      'wheat',
    ]);
    assert.equal(PSD_COMMODITIES.wheat.code, '0410000');
    assert.equal(PSD_COMMODITIES.corn.code, '0440000');
    assert.equal(PSD_COMMODITIES.rice.code, '0422110');
    assert.equal(PSD_COMMODITIES.soybeans.code, '2222000');
    assert.equal(PSD_COMMODITIES.barley.code, '0430000');
    assert.equal(PSD_COMMODITIES.palmOil.code, '4243000');
  });

  test('storage key and world sentinel match the issue contract', () => {
    assert.equal(FOOD_STOCKS_CANONICAL_KEY, 'resilience:food-stocks:v1');
    assert.equal(FOOD_STOCKS_WORLD_KEY, '_world');
  });
});

describe('formatMarketingYear', () => {
  test('stores the PSD market year as a slash-year label, not a calendar year', () => {
    assert.equal(formatMarketingYear(2024), '2024/25');
    assert.equal(formatMarketingYear('2024'), '2024/25');
    assert.equal(formatMarketingYear('2024/25'), '2024/25');
  });

  test('rejects unusable values', () => {
    assert.equal(formatMarketingYear(null), null);
    assert.equal(formatMarketingYear(''), null);
    assert.equal(formatMarketingYear('FY24'), null);
  });
});

describe('parsePsdForecastRows — Brazil corn 2021 fixture (PSD Online)', () => {
  test('maps attribute rows onto one country-commodity record and keeps the raw unit', () => {
    const rows = loadFixture('psd-brazil-corn-2021.json');
    const parsed = parsePsdForecastRows(rows, { commodity: 'corn' });
    assert.equal(parsed.length, 1);
    const rec = parsed[0];
    assert.equal(rec.countryCode, 'BR');
    assert.equal(rec.commodity, 'corn');
    assert.equal(rec.marketingYear, '2021/22');
    assert.equal(rec.production, 116000);
    assert.equal(rec.consumption, 73000);
    assert.equal(rec.imports, 2000);
    assert.equal(rec.exports, 44500);
    assert.equal(rec.endingStocks, 4653);
    assert.equal(rec.unit, '1000 MT');
    assert.equal(rec.source, 'psd');
    assert.equal(rec.stocksToUseRatio, computeStocksToUseRatio(4653, 73000, 44500));
    // Spot-check vs the published PSD Online Brazil corn 2021/22 balance:
    // ending stocks 4.653 MMT / total use 117.5 MMT ≈ 3.96%.
    assert.ok(Math.abs(rec.stocksToUseRatio - 4653 / 117500) < 1e-12);
  });

  test('keeps the latest WASDE vintage when the same country-MY appears twice', () => {
    const rows = loadFixture('psd-brazil-corn-2021.json');
    const older = rows.map((row) => ({ ...row, calendarYear: 2021, month: 12, value: row.value * 2 }));
    const parsed = parsePsdForecastRows([...older, ...rows], { commodity: 'corn' });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].production, 116000);
    assert.equal(parsed[0].forecastYear, 2022);
    assert.equal(parsed[0].forecastMonth, 6);
  });
});

describe('marketing years are never calendar-bucketed', () => {
  test('US 2024/25 and EG 2023/24 wheat stay in distinct buckets even when forecast calendar year matches', () => {
    const rows = loadFixture('psd-wheat-split-marketing-years.json');
    const parsed = parsePsdForecastRows(rows, { commodity: 'wheat' });
    assert.equal(parsed.length, 2);

    const keys = new Set(parsed.map((rec) => bucketKey(rec)));
    assert.equal(keys.size, 2);
    assert.ok(keys.has('US:wheat:2024/25'));
    assert.ok(keys.has('EG:wheat:2023/24'));
    assert.ok(![...keys].some((key) => key.endsWith(':2024')), 'calendar year must not be the bucket');

    const us = parsed.find((rec) => rec.countryCode === 'US');
    const eg = parsed.find((rec) => rec.countryCode === 'EG');
    assert.equal(us.marketingYear, '2024/25');
    assert.equal(eg.marketingYear, '2023/24');
    assert.notEqual(us.marketingYear, eg.marketingYear);
  });
});

describe('computeStocksToUseRatio', () => {
  test('uses ending stocks / (consumption + exports)', () => {
    assert.equal(computeStocksToUseRatio(20, 80, 20), 0.2);
  });

  test('returns null when total use is zero or inputs are unusable', () => {
    assert.equal(computeStocksToUseRatio(10, 0, 0), null);
    assert.equal(computeStocksToUseRatio(null, 80, 20), null);
    assert.equal(computeStocksToUseRatio(10, Number.NaN, 20), null);
  });
});

describe('FAOSTAT production fill', () => {
  test('fills production-only rows for countries PSD does not cover', () => {
    const psd = [
      {
        countryCode: 'US',
        commodity: 'wheat',
        marketingYear: '2024/25',
        production: 50,
        consumption: 30,
        imports: 0,
        exports: 20,
        endingStocks: 10,
        stocksToUseRatio: 0.2,
        unit: '1000 MT',
        source: 'psd',
      },
    ];
    const filled = applyFaostatProductionFill(psd, [
      { countryCode: 'US', commodity: 'wheat', production: 999, calendarYear: 2024 },
      { countryCode: 'TZ', commodity: 'wheat', production: 120, calendarYear: 2024 },
    ], { commodity: 'wheat' });

    const us = filled.find((rec) => rec.countryCode === 'US');
    const tz = filled.find((rec) => rec.countryCode === 'TZ');
    assert.equal(us.production, 50, 'FAOSTAT must not overwrite a PSD production value');
    assert.equal(us.source, 'psd');
    assert.equal(tz.source, 'faostat');
    assert.equal(tz.production, 120);
    assert.equal(tz.endingStocks, null);
    assert.equal(tz.stocksToUseRatio, null);
    assert.equal(tz.marketingYear, '2024/25');
  });

  test('FAOSTAT calendar year becomes its own marketing year, not the latest PSD MY', () => {
    const filled = applyFaostatProductionFill([
      {
        countryCode: 'US',
        commodity: 'wheat',
        marketingYear: '2025/26',
        production: 50,
        consumption: 30,
        imports: 0,
        exports: 20,
        endingStocks: 10,
        stocksToUseRatio: 0.2,
        unit: '1000 MT',
        source: 'psd',
      },
    ], [
      { countryCode: 'TZ', commodity: 'wheat', production: 120, calendarYear: 2023 },
    ], { commodity: 'wheat' });

    const tz = filled.find((rec) => rec.countryCode === 'TZ');
    assert.equal(tz.marketingYear, '2023/24');
    assert.notEqual(tz.marketingYear, '2025/26');
  });

  test('a failed FAOSTAT stage leaves the PSD rows untouched', () => {
    const psd = [
      {
        countryCode: 'AR',
        commodity: 'corn',
        marketingYear: '2024/25',
        production: 50,
        consumption: 20,
        imports: 0,
        exports: 25,
        endingStocks: 5,
        stocksToUseRatio: 5 / 45,
        unit: '1000 MT',
        source: 'psd',
      },
    ];
    const frozen = structuredClone(psd);
    const out = applyFaostatProductionFill(psd, null, { commodity: 'corn' });
    assert.deepEqual(out, frozen);
    const outErr = applyFaostatProductionFill(psd, new Error('FAOSTAT 502'), { commodity: 'corn' });
    assert.deepEqual(outErr, frozen);
  });
});

describe('country record + calorie-weighted aggregate', () => {
  test('weights stocks-to-use by consumption calories and skips fill-only commodities', () => {
    const commodities = {
      wheat: {
        marketingYear: '2024/25',
        production: 100,
        consumption: 80,
        imports: 0,
        exports: 10,
        endingStocks: 18,
        stocksToUseRatio: 18 / 90,
        unit: '1000 MT',
        source: 'psd',
      },
      rice: {
        marketingYear: '2024/25',
        production: 40,
        consumption: null,
        imports: null,
        exports: null,
        endingStocks: null,
        stocksToUseRatio: null,
        unit: '1000 MT',
        source: 'faostat',
      },
    };
    const record = buildCountryRecord('IN', commodities);
    assert.equal(record.aggregate.calorieWeightedStocksToUse, 18 / 90);
    assert.equal(computeCalorieWeightedStocksToUse({ rice: commodities.rice }), null);
  });

  test('the kcal table actually changes the aggregate', () => {
    // TWO contributing commodities is the minimum for weighting to be
    // observable: with one, weighted/weight collapses to (ratio*w)/w = ratio and
    // the result is scale-invariant, so gutting COMMODITY_KCAL_PER_KG (or even
    // inverting it) cannot fail the assertion above.
    const commodities = {
      // palmOil 8840 kcal/kg vs soybeans 1470 — a ~6x weight difference.
      palmOil: { consumption: 100, stocksToUseRatio: 0.5, source: 'psd' },
      soybeans: { consumption: 100, stocksToUseRatio: 0.1, source: 'psd' },
    };
    const actual = computeCalorieWeightedStocksToUse(commodities);
    const expected = (0.5 * 100 * COMMODITY_KCAL_PER_KG.palmOil + 0.1 * 100 * COMMODITY_KCAL_PER_KG.soybeans)
      / (100 * COMMODITY_KCAL_PER_KG.palmOil + 100 * COMMODITY_KCAL_PER_KG.soybeans);
    assert.ok(Math.abs(actual - expected) < 1e-12);

    // Pin the direction: calorie weighting must pull the aggregate toward the
    // energy-dense commodity, i.e. above the unweighted mean of 0.3.
    assert.ok(actual > 0.3, `expected calorie weighting to favour palm oil, got ${actual}`);
    // ...and it must not simply equal either input ratio, which is what the
    // single-contributor fixture above degenerates to.
    assert.notEqual(actual, 0.5);
    assert.notEqual(actual, 0.1);
  });

  test('consumption weighting is not ignored', () => {
    const equalRatios = {
      palmOil: { consumption: 1, stocksToUseRatio: 0.9, source: 'psd' },
      soybeans: { consumption: 1000, stocksToUseRatio: 0.1, source: 'psd' },
    };
    const actual = computeCalorieWeightedStocksToUse(equalRatios);
    // soybeans dominates on volume (1000 vs 1) despite lower kcal/kg, so the
    // aggregate must sit near 0.1, not near the midpoint.
    assert.ok(actual < 0.25, `volume weighting must dominate here, got ${actual}`);
  });
});

describe('world + country code normalization', () => {
  test('maps PSD world sentinels onto _world and leaves ISO-2 alone', () => {
    assert.equal(normalizePsdCountryCode('0'), FOOD_STOCKS_WORLD_KEY);
    assert.equal(normalizePsdCountryCode(0), FOOD_STOCKS_WORLD_KEY);
    assert.equal(normalizePsdCountryCode('00'), FOOD_STOCKS_WORLD_KEY);
    assert.equal(normalizePsdCountryCode('WORLD'), FOOD_STOCKS_WORLD_KEY);
    assert.equal(normalizePsdCountryCode('us'), 'US');
    assert.equal(normalizePsdCountryCode(''), null);
  });

  test('parses live api.fas.usda.gov world rows whose countryCode is 00', () => {
    const parsed = parsePsdForecastRows([
      { commodityCode: '0440000', countryCode: '00', marketYear: '2021', calendarYear: '2022', month: 6, attributeId: 28, unitId: 8, value: 1_200_000 },
      { commodityCode: '0440000', countryCode: '00', marketYear: '2021', calendarYear: '2022', month: 6, attributeId: 125, unitId: 8, value: 1_000_000 },
      { commodityCode: '0440000', countryCode: '00', marketYear: '2021', calendarYear: '2022', month: 6, attributeId: 88, unitId: 8, value: 180_000 },
      { commodityCode: '0440000', countryCode: '00', marketYear: '2021', calendarYear: '2022', month: 6, attributeId: 176, unitId: 8, value: 80_000 },
    ], { commodity: 'corn' });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].countryCode, FOOD_STOCKS_WORLD_KEY);
    assert.equal(parsed[0].production, 1_200_000);
    // World stocks-to-use EXCLUDES exports: world exports are internal transfers
    // that net against world imports and are already inside the importer's
    // domestic consumption. Hardcoded, NOT computeStocksToUseRatio(...) — the
    // previous assertion compared the function against itself and so could not
    // observe the denominator being wrong.
    assert.equal(parsed[0].stocksToUseRatio, 80_000 / 1_000_000);
    assert.equal(parsed[0].totalUse, 1_000_000);
  });

  test('a country row still counts exports in total use, unlike _world', () => {
    const rows = (countryCode) => ([
      { commodityCode: '0440000', countryCode, marketYear: '2021', calendarYear: '2022', month: 6, attributeId: 125, unitId: 8, value: 1_000_000 },
      { commodityCode: '0440000', countryCode, marketYear: '2021', calendarYear: '2022', month: 6, attributeId: 88, unitId: 8, value: 180_000 },
      { commodityCode: '0440000', countryCode, marketYear: '2021', calendarYear: '2022', month: 6, attributeId: 176, unitId: 8, value: 80_000 },
    ]);
    const [country] = parsePsdForecastRows(rows('BR'), { commodity: 'corn' });
    const [world] = parsePsdForecastRows(rows('00'), { commodity: 'corn' });
    assert.equal(country.stocksToUseRatio, 80_000 / 1_180_000);
    assert.equal(world.stocksToUseRatio, 80_000 / 1_000_000);
    assert.ok(world.stocksToUseRatio > country.stocksToUseRatio);
  });
});

describe('WASDE vintage handling', () => {
  const row = (attributeId, value, month) => ({
    commodityCode: '0440000', countryCode: 'AR', marketYear: 2024,
    calendarYear: 2025, month, attributeId, unitId: 8, value,
  });

  test('a partial revision updates only the restated attributes and keeps the balance sheet', () => {
    // May carries the full balance; June restates production only.
    const parsed = parsePsdForecastRows([
      row(PSD_ATTRIBUTES.PRODUCTION, 50_000, 5),
      row(PSD_ATTRIBUTES.DOMESTIC_CONSUMPTION, 15_000, 5),
      row(PSD_ATTRIBUTES.EXPORTS, 33_000, 5),
      row(PSD_ATTRIBUTES.ENDING_STOCKS, 2_000, 5),
      row(PSD_ATTRIBUTES.PRODUCTION, 51_000, 6),
    ], { commodity: 'corn' });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].production, 51_000, 'newer vintage wins for the restated attribute');
    assert.equal(parsed[0].consumption, 15_000, 'older vintage survives for attributes not restated');
    assert.equal(parsed[0].exports, 33_000);
    assert.equal(parsed[0].endingStocks, 2_000);
    assert.equal(parsed[0].stocksToUseRatio, 2_000 / 48_000);
  });

  test('vintage merge is order-independent', () => {
    const older = [
      row(PSD_ATTRIBUTES.PRODUCTION, 50_000, 5),
      row(PSD_ATTRIBUTES.DOMESTIC_CONSUMPTION, 15_000, 5),
      row(PSD_ATTRIBUTES.ENDING_STOCKS, 2_000, 5),
    ];
    const newer = [row(PSD_ATTRIBUTES.PRODUCTION, 51_000, 6)];
    const forward = parsePsdForecastRows([...older, ...newer], { commodity: 'corn' })[0];
    const reverse = parsePsdForecastRows([...newer, ...older], { commodity: 'corn' })[0];
    for (const key of ['production', 'consumption', 'endingStocks', 'stocksToUseRatio']) {
      assert.equal(forward[key], reverse[key], `${key} must not depend on row order`);
    }
    assert.equal(forward.production, 51_000);
    assert.equal(forward.consumption, 15_000);
  });

  test('rows with no calendarYear are still parsed, not silently dropped', () => {
    // vintageRank returns -1 for a missing calendarYear. Comparing that against a
    // re-derived group rank of 0+month dropped every row of such a response.
    const parsed = parsePsdForecastRows([
      { commodityCode: '0440000', countryCode: 'BR', marketYear: 2021, month: 6, attributeId: PSD_ATTRIBUTES.PRODUCTION, unitId: 8, value: 116_000 },
      { commodityCode: '0440000', countryCode: 'BR', marketYear: 2021, month: 6, attributeId: PSD_ATTRIBUTES.DOMESTIC_CONSUMPTION, unitId: 8, value: 73_000 },
      { commodityCode: '0440000', countryCode: 'BR', marketYear: 2021, month: 6, attributeId: PSD_ATTRIBUTES.ENDING_STOCKS, unitId: 8, value: 4_653 },
    ], { commodity: 'corn' });
    assert.equal(parsed.length, 1, 'a response without calendarYear must not yield zero records');
    assert.equal(parsed[0].production, 116_000);
    assert.equal(parsed[0].endingStocks, 4_653);
  });
});

describe('content clock is marketing-year presence, not fetch time', () => {

  const worldSnapshot = (commodities) => ({
    [FOOD_STOCKS_WORLD_KEY]: {
      commodities: Object.fromEntries(
        Object.entries(commodities).map(([slug, my]) => [slug, { marketingYear: my, stocksToUseRatio: 0.2 }]),
      ),
    },
  });
  const ageDays = (meta, now) => (now - meta.newestItemAt) / 86_400_000;
  const NOW = Date.UTC(2026, 7, 12);

  test('contentMeta is stale when the world marketing year is old', () => {
    const meta = foodStocksContentMeta(worldSnapshot({ wheat: '2022/23' }), NOW);
    assert.ok(meta);
    const ageMin = (NOW - meta.newestItemAt) / 60000;
    assert.ok(
      ageMin > FOOD_STOCKS_MAX_CONTENT_AGE_MIN,
      `stale MY 2022/23 in Aug 2026 must exceed the ${FOOD_STOCKS_MAX_CONTENT_AGE_MIN / (24 * 60)}d window (age ${Math.round(ageMin / (24 * 60))}d)`,
    );
  });

  test('a current marketing year stays inside the window', () => {
    const meta = foodStocksContentMeta(worldSnapshot({ wheat: '2025/26' }), NOW);
    const ageMin = (NOW - meta.newestItemAt) / 60000;
    assert.ok(ageMin < FOOD_STOCKS_MAX_CONTENT_AGE_MIN);
  });

  test('ONE fresh commodity cannot mask five frozen ones', () => {
    // The regression this clock exists to catch: under a max() reduction this
    // snapshot reported age 0 and STALE_CONTENT never fired.
    const meta = foodStocksContentMeta(worldSnapshot({
      corn: '2026/27',
      wheat: '2022/23',
      rice: '2022/23',
      soybeans: '2022/23',
      barley: '2022/23',
      palmOil: '2022/23',
    }), NOW);
    assert.ok(meta);
    const ageMin = (NOW - meta.newestItemAt) / 60000;
    assert.ok(
      ageMin > FOOD_STOCKS_MAX_CONTENT_AGE_MIN,
      `five frozen commodities must age the clock even with corn current (age ${Math.round(ageMin / (24 * 60))}d)`,
    );
  });

  test('a fresh country row cannot mask a frozen world row', () => {
    const snapshot = worldSnapshot({ wheat: '2022/23' });
    snapshot.US = { commodities: { corn: { marketingYear: '2026/27', stocksToUseRatio: 0.1 } } };
    const meta = foodStocksContentMeta(snapshot, NOW);
    const ageMin = (NOW - meta.newestItemAt) / 60000;
    assert.ok(ageMin > FOOD_STOCKS_MAX_CONTENT_AGE_MIN, 'clock must read _world, not any country');
  });

  test('all-current world commodities are quiet', () => {
    const meta = foodStocksContentMeta(worldSnapshot({
      corn: '2026/27', wheat: '2026/27', rice: '2026/27',
      soybeans: '2026/27', barley: '2026/27', palmOil: '2026/27',
    }), NOW);
    assert.equal(ageDays(meta, NOW), 0);
  });

  test('FAOSTAT-lagged country rows do not false-alarm a healthy snapshot', () => {
    // FAOSTAT fill marketing years trail PSD by 1-3 years by construction, so a
    // min() over the WHOLE snapshot would page on perfectly healthy data.
    const snapshot = worldSnapshot({
      corn: '2026/27', wheat: '2026/27', rice: '2026/27',
      soybeans: '2026/27', barley: '2026/27', palmOil: '2026/27',
    });
    snapshot.NG = { commodities: { corn: { marketingYear: '2023/24', source: 'faostat' } } };
    const meta = foodStocksContentMeta(snapshot, NOW);
    assert.equal(ageDays(meta, NOW), 0, 'FAOSTAT lag must not age the clock');
  });

  test('a late palm-oil marketing-year roll stays inside the budget', () => {
    // palmOil runs Oct-Sep. A single hardcoded 31 Aug end would age this ~30 days
    // early and fire on a merely-late roll.
    const meta = foodStocksContentMeta(worldSnapshot({
      corn: '2026/27', wheat: '2026/27', rice: '2026/27',
      soybeans: '2026/27', barley: '2026/27', palmOil: '2025/26',
    }), Date.UTC(2026, 11, 1));
    const ageMin = (Date.UTC(2026, 11, 1) - meta.newestItemAt) / 60000;
    assert.ok(
      ageMin < FOOD_STOCKS_MAX_CONTENT_AGE_MIN,
      `late palmOil roll must stay inside the ${FOOD_STOCKS_MAX_CONTENT_AGE_MIN / (24 * 60)}d budget (age ${Math.round(ageMin / (24 * 60))}d)`,
    );
  });

  test('a bogus future marketing year is rejected, not treated as fresh', () => {
    assert.equal(foodStocksContentMeta(worldSnapshot({ corn: '2090/91' }), NOW), null);
  });

  test('a missing _world fails closed', () => {
    assert.equal(foodStocksContentMeta({ US: { commodities: { corn: { marketingYear: '2026/27' } } } }, NOW), null);
  });
});
