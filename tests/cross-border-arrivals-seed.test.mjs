import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import {
  ACCELERATION_RATIO,
  ARRIVALS_FLOOR,
  MIN_SITUATIONS,
  SITUATIONS,
  STOCK_FLOOR,
  advanceHistory,
  arrivalsAcceleration,
  dedupeSeries,
  fetchCrossBorderArrivals,
  latestByCountry,
  monthStarts,
  publishTransform,
  stockTrendAcceleration,
  sumByCountry,
  validate,
  windowsFromSince,
} from '../scripts/seed-cross-border-arrivals.mjs';

const centroids = JSON.parse(readFileSync(new URL('../scripts/data/country-centroids.json', import.meta.url), 'utf8'));

function row(overrides = {}) {
  return { geomaster_name: 'Chad', individuals: 1000, date: '2026-09-21', centroid_lat: 15.4, centroid_lon: 18.7, ...overrides };
}

describe('situation config', () => {
  it('names each situation once, with a valid flow kind and a placeable origin', () => {
    const ids = SITUATIONS.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(SITUATIONS.length >= MIN_SITUATIONS);
    for (const s of SITUATIONS) {
      assert.ok(Number.isInteger(s.svId) && s.svId > 0, s.id);
      assert.match(s.slug, /^[a-z0-9_-]+$/, s.id);
      for (const f of s.flows) {
        assert.ok(['outflow', 'return', 'arrival', 'death'].includes(f.kind), `${s.id}: ${f.kind}`);
        assert.ok(f.query.population_group || f.query.population_collection, `${s.id}: ${f.label} has no group`);
        const origin = f.origin ?? s.origin;
        if (origin) assert.ok(centroids[origin], `${s.id}: no centroid for ${origin}`);
      }
    }
  });

  it('covers at least four continents', () => {
    const origins = new Set(SITUATIONS.map((s) => s.id));
    for (const id of ['sudan', 'myanmar', 'mediterranean', 'americas']) assert.ok(origins.has(id), id);
  });
});

describe('latestByCountry (stock groups)', () => {
  it('keeps the latest report per country and resolves ISO2 and coordinates', () => {
    const rows = latestByCountry([
      row({ geomaster_name: 'Türkiye', individuals: 24911, date: '2024-10-31', centroid_lat: 39, centroid_lon: 35 }),
      row({ geomaster_name: 'Türkiye', individuals: 2208753, date: '2026-09-24', centroid_lat: 39, centroid_lon: 35 }),
      row(),
    ]);
    assert.deepEqual(rows.map((r) => [r.country, r.iso2, r.individuals, r.date]), [
      ['Türkiye', 'TR', 2208753, '2026-09-24'],
      ['Chad', 'TD', 1000, '2026-09-21'],
    ]);
    assert.deepEqual(rows[1].location, { latitude: 15.4, longitude: 18.7 });
  });

  it('drops rows without a usable name, count or date, and Null Island coordinates', () => {
    const rows = latestByCountry([
      row({ geomaster_name: '' }), row({ individuals: 'x' }), row({ individuals: -1 }), row({ date: 'n/a' }),
      row({ geomaster_name: 'Other (North Africa)', centroid_lat: 0, centroid_lon: 0 }),
    ]);
    assert.deepEqual(rows.map((r) => [r.country, r.iso2, r.location]), [['Other (North Africa)', '', undefined]]);
  });
});

describe('monthly flows', () => {
  it('lists month starts newest first, across a year boundary', () => {
    assert.deepEqual(monthStarts(Date.parse('2026-02-15T12:00:00Z'), 4), ['2026-02-01', '2026-01-01', '2025-12-01', '2025-11-01']);
  });

  it('turns since-sums into monthly counts', () => {
    assert.deepEqual(windowsFromSince([349, 12382, 24058, 34813]), [349, 12033, 11676, 10755]);
    assert.deepEqual(windowsFromSince([10, 5]), [10, 0], 'a shrinking sum never yields a negative month');
  });

  it('adds separate sea and land rows for one country', () => {
    const map = sumByCountry([
      row({ geomaster_name: 'Spain', individuals: 4000, date: '2026-09-30' }),
      row({ geomaster_name: 'Spain', individuals: 229, date: '2026-09-28' }),
    ]);
    assert.equal(map.get('Spain').individuals, 4229);
    assert.equal(map.get('Spain').date, '2026-09-30');
  });
});

describe('acceleration', () => {
  it('flags arrivals that doubled against the earlier median and pass the floor', () => {
    assert.equal(arrivalsAcceleration([25000, 11676, 10755, 9350]).accelerating, true);
    assert.equal(arrivalsAcceleration([12033, 11676, 10755, 9350]).accelerating, false);
    assert.equal(arrivalsAcceleration([ARRIVALS_FLOOR - 1, 10, 10, 10]).accelerating, false, 'below the floor');
    assert.equal(arrivalsAcceleration([25000, 11676]).accelerating, false, 'too few earlier periods');
  });

  it('flags a stock that grew per day at least twice as fast as usual', () => {
    const points = [['2026-04-30', 416184], ['2026-05-31', 421896], ['2026-06-30', 425664], ['2026-07-31', 426448], ['2026-08-31', 472619]];
    const result = stockTrendAcceleration(points);
    assert.equal(result.latestDelta, 46171);
    assert.equal(result.latestDays, 31);
    assert.equal(result.accelerating, true);
    assert.equal(stockTrendAcceleration(points.slice(0, -1)).accelerating, false);
  });

  it('does not flag a step below the floor however fast', () => {
    const points = [['2026-01-01', 0], ['2026-02-01', 10], ['2026-03-01', 20], ['2026-04-01', 30], ['2026-05-01', STOCK_FLOOR - 1]];
    assert.equal(stockTrendAcceleration(points).accelerating, false);
    assert.ok(ACCELERATION_RATIO >= 2);
  });

  it('keeps the last figure when the portal repeats a date', () => {
    assert.deepEqual(dedupeSeries([['2026-06-29', 3634452], ['2026-06-01', 3625299], ['2026-06-29', 3682887]]), [['2026-06-01', 3625299], ['2026-06-29', 3682887]]);
  });
});

describe('advanceHistory', () => {
  it('reports the change since the previous report once the date advances', () => {
    let state = advanceHistory(undefined, '2026-08-31', 426448);
    assert.equal(state.change, undefined);
    state = advanceHistory(state.history, '2026-08-31', 426448);
    assert.deepEqual(state.history, [['2026-08-31', 426448]], 'a repeat of the same report adds nothing');
    state = advanceHistory(state.history, '2026-09-30', 472619);
    assert.deepEqual(state.change, { since: '2026-08-31', delta: 46171 });
  });

  it('keeps a bounded history and ignores malformed points', () => {
    let points = [['bad'], null];
    for (let m = 1; m <= 12; m++) points = advanceHistory(points, `2026-${String(m).padStart(2, '0')}-01`, m).history;
    assert.equal(points.length, 8);
    assert.deepEqual(points[0], ['2026-05-01', 5]);
  });
});

describe('publishTransform', () => {
  it('keeps the report history out of the public payload', () => {
    assert.deepEqual(publishTransform({ situations: [1], history: { a: [] } }), { situations: [1] });
  });
});

describe('fetchCrossBorderArrivals', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function stub(handler) {
    const urls = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      return handler(url);
    };
    return urls;
  }

  it('builds stock and monthly flows, reports change from history, and isolates a failing situation', async () => {
    const urls = stub((url) => {
      const sv = url.searchParams.get('sv_id');
      if (sv === '14') return new Response('gone', { status: 404 });
      if (url.pathname.endsWith('/timeseries')) {
        return Response.json({ data: { timeseries: [{ data_date: '2026-08-31', individuals: 100 }] } });
      }
      if (sv === '100') {
        const from = url.searchParams.get('fromDate');
        const sums = { '2026-10-01': 349, '2026-09-01': 12382, '2026-08-01': 24058, '2026-07-01': 34813, '2026-06-01': 44163, '2026-01-01': 78128 };
        return Response.json({ data: [row({ geomaster_name: 'Spain', individuals: sums[from] ?? 0, date: '2026-09-30' })] });
      }
      return Response.json({ data: [row({ individuals: 959126 })] });
    });
    const data = await fetchCrossBorderArrivals({
      nowMs: Date.parse('2026-10-08T00:00:00Z'),
      previousHistory: {
        'sudan|outflow|Refugees from Sudan|Chad': [['2026-09-07', 950000]],
        'drc|outflow|Refugees from the DRC|Uganda': [['2026-09-30', 600000]],
      },
    });

    assert.deepEqual(data.unavailable, ['drc']);
    assert.equal(data.situations.length, SITUATIONS.length - 1);
    const sudan = data.situations.find((s) => s.id === 'sudan');
    const chad = sudan.flows[0].countries[0];
    assert.equal(chad.iso2, 'TD');
    assert.deepEqual(chad.change, { since: '2026-09-07', delta: 9126 });
    assert.deepEqual(data.history['sudan|outflow|Refugees from Sudan|Chad'], [['2026-09-07', 950000], ['2026-09-21', 959126]]);
    assert.deepEqual(data.history['drc|outflow|Refugees from the DRC|Uganda'], [['2026-09-30', 600000]], 'a failed situation keeps its history');
    assert.deepEqual(sudan.flows[0].originLocation, { latitude: centroids.SD[0], longitude: centroids.SD[1] });

    const med = data.situations.find((s) => s.id === 'mediterranean').flows.find((f) => f.kind === 'arrival');
    assert.equal(med.measure, 'monthly');
    assert.deepEqual(med.months.map((m) => `${m.month}:${m.individuals}`), ['2026-10:349', '2026-09:12033', '2026-08:11676', '2026-07:10755', '2026-06:9350']);
    assert.equal(med.total, 78128);

    // Stock groups are always read as the latest report, never summed since a date.
    for (const url of urls.filter((u) => u.pathname.endsWith('/sublocation') && u.searchParams.get('sv_id') !== '100')) {
      assert.equal(url.searchParams.get('fromDate'), '1900-01-01');
    }
  });

  it('judges the newest monthly point as complete when the portal has not posted the current month', async () => {
    stub((url) => {
      if (url.searchParams.get('sv_id') !== '100') return new Response('gone', { status: 404 });
      if (url.pathname.endsWith('/timeseries')) {
        return Response.json({ data: { timeseries: [
          { year: 2026, month: 7, individuals: 10755 },
          { year: 2026, month: 8, individuals: 11676 },
          { year: 2026, month: 9, individuals: 12033 },
        ] } });
      }
      return Response.json({ data: [row({ geomaster_name: 'Spain', individuals: 100, date: '2026-09-30' })] });
    });
    const early = await fetchCrossBorderArrivals({ nowMs: Date.parse('2026-10-02T00:00:00Z'), previousHistory: {} });
    assert.equal(early.situations.find((s) => s.id === 'mediterranean').trend.latestDelta, 12033);
    const later = await fetchCrossBorderArrivals({ nowMs: Date.parse('2026-09-20T00:00:00Z'), previousHistory: {} });
    assert.equal(later.situations.find((s) => s.id === 'mediterranean').trend.latestDelta, 11676, 'the current month stays unjudged');
  });

  it('fails validation when too few situations answer', async () => {
    stub(() => new Response('gone', { status: 404 }));
    const data = await fetchCrossBorderArrivals({ nowMs: Date.now(), previousHistory: {} });
    assert.equal(data.situations.length, 0);
    assert.equal(validate(data), false);
  });
});
