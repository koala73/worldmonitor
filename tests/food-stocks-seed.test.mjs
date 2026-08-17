import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parsePsdForecastRows } from '../scripts/_food-stocks-helpers.mjs';
import {
  fetchFoodStocks,
  parseFaostatAreaMap,
  parseFaostatProductionRows,
  validateFoodStocks,
} from '../scripts/seed-food-stocks.mjs';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'food-stocks');
const brazilCorn = JSON.parse(readFileSync(join(FIXTURE_DIR, 'psd-brazil-corn-2021.json'), 'utf8'));

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('FAOSTAT parsers', () => {
  test('map area codes through ISO3 and leave unmapped rows out', () => {
    const map = parseFaostatAreaMap([
      { code: '231', iso3: 'USA', label: 'United States of America' },
      { code: '834', iso3: 'TZA', label: 'United Republic of Tanzania' },
      { code: '999', label: 'Not A Real Country' },
    ]);
    assert.equal(map.get('231'), 'US');
    assert.equal(map.get('834'), 'TZ');
    assert.equal(map.has('999'), false);
  });

  test('keeps the latest year and converts tonnes to 1000 MT', () => {
    const rows = parseFaostatProductionRows({
      data: [
        { 'Area Code': '231', Year: 2022, Value: 50_000_000 },
        { 'Area Code': '231', Year: 2023, Value: 49_000_000 },
      ],
    }, { commodity: 'wheat', areaMap: new Map([['231', 'US']]) });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].production, 49000);
    assert.equal(rows[0].calendarYear, 2023);
  });
});

describe('fetchFoodStocks stages', () => {
  test('a FAOSTAT 502 leaves the PSD snapshot intact', async () => {
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.includes('codes/area')) return jsonResponse([]);
      if (href.includes('faostat')) return jsonResponse({ error: 'down' }, 502);
      const yearMatch = href.match(/\/year\/(\d{4})/);
      const year = yearMatch ? Number(yearMatch[1]) : 0;
      if (year !== 2025 || !href.includes('0440000')) return jsonResponse([]);
      if (href.includes('/world/year/')) {
        return jsonResponse([
          { commodityCode: '0440000', countryCode: '00', marketYear: '2025', calendarYear: '2026', month: 5, attributeId: 28, unitId: 8, value: 1_200_000 },
          { commodityCode: '0440000', countryCode: '00', marketYear: '2025', calendarYear: '2026', month: 5, attributeId: 125, unitId: 8, value: 1_000_000 },
          { commodityCode: '0440000', countryCode: '00', marketYear: '2025', calendarYear: '2026', month: 5, attributeId: 88, unitId: 8, value: 180_000 },
          { commodityCode: '0440000', countryCode: '00', marketYear: '2025', calendarYear: '2026', month: 5, attributeId: 176, unitId: 8, value: 80_000 },
        ]);
      }
      if (href.includes('0440000') && href.includes('/country/all/')) {
        return jsonResponse(brazilCorn.map((row) => ({ ...row, marketYear: 2025, calendarYear: 2026, month: 5 })));
      }
      return jsonResponse([]);
    };

    const snapshot = await fetchFoodStocks({
      fetchImpl,
      apiKey: 'test-key',
      now: new Date(Date.UTC(2026, 7, 12)),
      gapMs: 0,
    });

    assert.ok(snapshot.BR, 'Brazil PSD row must survive a FAOSTAT failure');
    assert.equal(snapshot.BR.commodities.corn.source, 'psd');
    assert.equal(snapshot.BR.commodities.corn.production, 116000);
    assert.ok(snapshot._world.commodities.corn);
    assert.equal(snapshot._world.commodities.corn.source, 'psd');
    assert.ok(Number.isFinite(snapshot._world.commodities.corn.stocksToUseRatio));
  });

  test('a 404 on the current marketing year falls through to the previous year', async () => {
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.includes('codes/area') || href.includes('faostat')) return jsonResponse([]);
      const yearMatch = href.match(/\/year\/(\d{4})/);
      const year = yearMatch ? Number(yearMatch[1]) : 0;
      if (year === 2026) return jsonResponse({ error: 'not published' }, 404);
      if (year !== 2025 || !href.includes('0440000')) return jsonResponse([]);
      if (href.includes('/world/year/')) {
        return jsonResponse([
          { commodityCode: '0440000', countryCode: '00', marketYear: '2025', calendarYear: '2026', month: 5, attributeId: 28, unitId: 8, value: 1_200_000 },
          { commodityCode: '0440000', countryCode: '00', marketYear: '2025', calendarYear: '2026', month: 5, attributeId: 125, unitId: 8, value: 1_000_000 },
          { commodityCode: '0440000', countryCode: '00', marketYear: '2025', calendarYear: '2026', month: 5, attributeId: 88, unitId: 8, value: 180_000 },
          { commodityCode: '0440000', countryCode: '00', marketYear: '2025', calendarYear: '2026', month: 5, attributeId: 176, unitId: 8, value: 80_000 },
        ]);
      }
      return jsonResponse(brazilCorn.map((row) => ({ ...row, marketYear: 2025, calendarYear: 2026, month: 5 })));
    };

    const snapshot = await fetchFoodStocks({
      fetchImpl,
      apiKey: 'test-key',
      now: new Date(Date.UTC(2026, 7, 12)),
      gapMs: 0,
    });

    assert.ok(snapshot.BR, '2026 country 404 must not abort the seed');
    assert.equal(snapshot.BR.commodities.corn.marketingYear, '2025/26');
    assert.ok(snapshot._world.commodities.corn);
  });

  const cornWorldRows = (my, cy) => ([
    { commodityCode: '0440000', countryCode: '00', marketYear: my, calendarYear: cy, month: 5, attributeId: 28, unitId: 8, value: 1_200_000 },
    { commodityCode: '0440000', countryCode: '00', marketYear: my, calendarYear: cy, month: 5, attributeId: 125, unitId: 8, value: 1_000_000 },
    { commodityCode: '0440000', countryCode: '00', marketYear: my, calendarYear: cy, month: 5, attributeId: 88, unitId: 8, value: 180_000 },
    { commodityCode: '0440000', countryCode: '00', marketYear: my, calendarYear: cy, month: 5, attributeId: 176, unitId: 8, value: 80_000 },
  ]);

  test('a 5xx on the current year does NOT silently republish the previous year', async () => {
    // The distinction that matters: a 404 means "not published yet" (walk back);
    // a 503 means "we do not know" and must not be read as an answer.
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.includes('codes/area') || href.includes('faostat')) return jsonResponse([]);
      const year = Number(href.match(/\/year\/(\d{4})/)?.[1] ?? 0);
      if (year === 2026) return jsonResponse({ error: 'upstream down' }, 503);
      if (year !== 2025 || !href.includes('0440000')) return jsonResponse([]);
      if (href.includes('/world/year/')) return jsonResponse(cornWorldRows('2025', '2026'));
      return jsonResponse(brazilCorn.map((row) => ({ ...row, marketYear: 2025, calendarYear: 2026, month: 5 })));
    };

    const snapshot = await fetchFoodStocks({
      fetchImpl, apiKey: 'test-key', now: new Date(Date.UTC(2026, 7, 12)), gapMs: 0,
    });

    // It may still fall back to 2025 data, but the run must be MARKED degraded so
    // the outage is not indistinguishable from a healthy publish.
    assert.equal(snapshot.stageNotes.degraded, true, 'a 5xx must mark the run degraded');
    assert.equal(snapshot.stageNotes.psd.corn.degraded, true);
  });

  test('a world-only response is not accepted as a healthy commodity', async () => {
    // country/all fails, world succeeds. Accepting on `parsed.length > 0` shipped
    // a commodity whose only stocks row was `_world`.
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.includes('codes/area') || href.includes('faostat')) return jsonResponse([]);
      if (!href.includes('0440000')) return jsonResponse([]);
      if (href.includes('/world/year/')) return jsonResponse(cornWorldRows('2025', '2026'));
      return jsonResponse({ error: 'boom' }, 500); // every country/all year fails
    };

    const snapshot = await fetchFoodStocks({
      fetchImpl, apiKey: 'test-key', now: new Date(Date.UTC(2026, 7, 12)), gapMs: 0,
    });

    assert.equal(snapshot.stageNotes.psd.corn.year, null, 'no year may be accepted on a world row alone');
    assert.equal(snapshot.stageNotes.psd.corn.countries, 0);
    assert.equal(snapshot.stageNotes.degraded, true);
    assert.equal(validateFoodStocks(snapshot), false, 'the degraded snapshot must not publish');
  });

  test('a healthy run is not marked degraded', async () => {
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.includes('codes/area') || href.includes('faostat')) return jsonResponse([]);
      const year = Number(href.match(/\/year\/(\d{4})/)?.[1] ?? 0);
      if (year !== 2026 || !href.includes('0440000')) return jsonResponse([]);
      if (href.includes('/world/year/')) return jsonResponse(cornWorldRows('2026', '2026'));
      return jsonResponse(brazilCorn.map((row) => ({ ...row, marketYear: 2026, calendarYear: 2026, month: 5 })));
    };
    const snapshot = await fetchFoodStocks({
      fetchImpl, apiKey: 'test-key', now: new Date(Date.UTC(2026, 7, 12)), gapMs: 0,
    });
    assert.equal(snapshot.stageNotes.degraded, false, 'a clean corn run must not be flagged degraded');
    assert.equal(snapshot.stageNotes.psd.corn.countries, 1);
  });

  test('validateFoodStocks requires country breadth, commodity coverage and real stocks', () => {
    const SLUGS = ['wheat', 'corn', 'rice', 'soybeans', 'barley', 'palmOil'];
    const worldWith = (slugs) => ({
      commodities: Object.fromEntries(slugs.map((s) => [s, { stocksToUseRatio: 0.2 }])),
    });
    const countriesWith = (n, rec) => Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`C${i}`, { commodities: { wheat: rec } }]),
    );
    const realStocks = { stocksToUseRatio: 0.1, endingStocks: 42, source: 'psd' };
    const healthy = { ...countriesWith(10, realStocks), _world: worldWith(SLUGS) };

    assert.equal(validateFoodStocks({}), false);
    assert.equal(validateFoodStocks(healthy), true, 'a healthy snapshot must publish');

    // Each guard must fire ON ITS OWN, or the floor is decorative.
    assert.equal(
      validateFoodStocks({ ...countriesWith(9, realStocks), _world: worldWith(SLUGS) }),
      false,
      'country floor',
    );
    assert.equal(
      validateFoodStocks({ ...countriesWith(10, realStocks), _world: worldWith(['wheat']) }),
      false,
      'five of six commodities missing from _world must not publish',
    );
    assert.equal(
      validateFoodStocks({ ...countriesWith(200, realStocks), _world: worldWith(['wheat']) }),
      false,
      'country breadth must NOT compensate for missing commodities — the exact hole in the old key-count floor',
    );
    assert.equal(
      validateFoodStocks({
        // FAOSTAT production-only fill: no endingStocks anywhere but _world.
        ...countriesWith(200, { stocksToUseRatio: null, endingStocks: null, source: 'faostat' }),
        _world: worldWith(SLUGS),
      }),
      false,
      'a world row plus FAOSTAT production fill is not a food-stocks snapshot',
    );
    assert.equal(validateFoodStocks({ ...countriesWith(10, realStocks) }), false, 'missing _world');
  });
});

describe('PSD fixture still parses after a live-shaped commodity code', () => {
  test('0440000 and 440000 are the same corn commodity', () => {
    const padded = brazilCorn.map((row) => ({ ...row, commodityCode: '0440000' }));
    const a = parsePsdForecastRows(brazilCorn, { commodity: 'corn' });
    const b = parsePsdForecastRows(padded, { commodity: 'corn' });
    assert.equal(a[0].production, b[0].production);
  });
});
