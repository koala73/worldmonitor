// Reservoir water-extent series (#10714 item 2): the producer measures each reservoir watched site from
// Sentinel-1 RTC statistics fixtures, carries the series forward, and is registered dark like the rest
// of Orbital Watch. No network: every upstream call is a fixture.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  MIN_VALID_PERCENT,
  SEARCH_LOOKBACK_DAYS,
  WATER_THRESHOLD_LINEAR,
  boxAreaKm2,
  freshReservoirCount,
  mergeSeries,
  orderTargets,
  pendingScenes,
  readingFromStatistics,
  reservoirTargets,
  searchSince,
  statisticsQuery,
} from '../scripts/_orbital-water-extent.mjs';
import {
  ORBITAL_WATER_EXTENT_KEY,
  buildSeedOptions,
  loadWatchlist,
  makeFetchWaterExtent,
  makeStatisticsFetch,
  waterExtentEnabled,
} from '../scripts/seed-orbital-water-extent.mjs';
import { WATCHED_SITES } from '../scripts/shared/orbital-watched-sites.generated.mjs';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const DAY = 86_400_000;
const watchlist = loadWatchlist();
const stats = (validPercent, validPixels, waterPixels) => ({
  properties: { statistics: { vv_b1: { valid_percent: validPercent, valid_pixels: validPixels, histogram: [[waterPixels], [0, WATER_THRESHOLD_LINEAR]] } } },
});
const scene = (id, daysAgo, orbit = 43) => ({
  id, properties: { datetime: new Date(NOW - daysAgo * DAY).toISOString(), platform: 'sentinel-1c', 'sat:relative_orbit': orbit, 'sat:orbit_state': 'ascending' },
});

describe('reservoir water extent: pure helpers', () => {
  it('targets every reservoir watched site with its watchlist core box', () => {
    const targets = reservoirTargets(WATCHED_SITES, watchlist);
    assert.equal(targets.length, 50);
    const kariba = targets.find((t) => t.reservoirId === 'kariba');
    assert.equal(kariba.siteId, 'reservoir:kariba');
    assert.deepEqual(kariba.box, watchlist.find((r) => r.id === 'kariba').core);
    assert.ok(!targets.some((t) => !t.siteId.startsWith('reservoir:')));
  });

  it('measures box area on the sphere', () => {
    const area = boxAreaKm2([27.7, -17.1, 28.1, -16.8]);
    assert.ok(area > 1400 && area < 1450, String(area));
  });

  it('asks titiler for one histogram bin below the -18 dB water threshold', () => {
    const q = new URLSearchParams(statisticsQuery('S1C_X_rtc'));
    assert.equal(q.get('collection'), 'sentinel-1-rtc');
    assert.equal(q.get('assets'), 'vv');
    assert.equal(q.get('histogram_bins'), '1');
    assert.equal(Number(q.get('histogram_range').split(',')[1]).toFixed(5), (10 ** -1.8).toFixed(5));
  });

  it('reads the water share of a scene that images the box and drops a slice edge', () => {
    assert.deepEqual(readingFromStatistics(stats(98.92, 777962, 558831), 1422.5), { waterPercent: 71.8, waterKm2: 1021.8, validPercent: 98.9 });
    assert.equal(readingFromStatistics(stats(MIN_VALID_PERCENT - 0.1, 1000, 10), 100), null);
    assert.equal(readingFromStatistics({ properties: {} }, 100), null);
    assert.equal(readingFromStatistics(stats(100, 0, 0), 100), null);
  });

  it('merges a series one reading per scene, newest first, inside retention', () => {
    const old = { sceneId: 'old', time: new Date(NOW - 800 * DAY).toISOString() };
    const a = { sceneId: 'a', time: new Date(NOW - 10 * DAY).toISOString(), waterPercent: 1 };
    const a2 = { ...a, waterPercent: 2 };
    const b = { sceneId: 'b', time: new Date(NOW - 2 * DAY).toISOString() };
    assert.deepEqual(mergeSeries([old, a], [a2, b], NOW).map((o) => [o.sceneId, o.waterPercent]), [['b', undefined], ['a', 2]]);
  });

  it('skips scenes already measured or already found partial, and backfills from the horizon', () => {
    const scenes = [{ sceneId: 'x', time: '2026-11-10T00:00:00Z' }, { sceneId: 'y', time: '2026-11-11T00:00:00Z' }, { sceneId: 'z', time: '2026-11-12T00:00:00Z' }];
    assert.deepEqual(pendingScenes(scenes, { observations: [{ sceneId: 'x' }], partialScenes: ['z'] }).map((s) => s.sceneId), ['y']);
    assert.equal(searchSince(null, NOW), new Date(NOW - SEARCH_LOOKBACK_DAYS * DAY).toISOString());
    assert.equal(searchSince({ searchedThrough: new Date(NOW - DAY).toISOString() }, NOW), new Date(NOW - 6 * DAY).toISOString());
  });

  it('serves the least recently completed reservoirs first', () => {
    const t = [{ siteId: 'a' }, { siteId: 'b' }, { siteId: 'c' }];
    const prior = { a: { searchedThrough: '2026-11-14T00:00:00Z' }, c: { searchedThrough: '2026-11-10T00:00:00Z' } };
    assert.deepEqual(orderTargets(t, prior).map((x) => x.siteId), ['b', 'c', 'a']);
  });
});

describe('reservoir water extent: producer', () => {
  const sites = WATCHED_SITES.filter((s) => s.id === 'reservoir:kariba' || s.id === 'reservoir:kakhovka' || s.id === 'port:1');
  const run = async ({ previous = null, statistics, search }) => {
    const calls = [];
    const fetchWaterExtent = makeFetchWaterExtent({
      sites, watchlist,
      readPrevious: async () => previous,
      searchScenes: async (body) => { calls.push(['search', body]); return search(body); },
      fetchStatistics: async (id, geometry) => { calls.push(['statistics', id, geometry]); return statistics(id); },
      now: () => NOW,
    });
    return { data: await fetchWaterExtent(), calls };
  };

  it('records readings for covering scenes and remembers partial slices', async () => {
    const { data, calls } = await run({
      search: () => ({ features: [scene('full', 4), scene('edge', 4), scene('older', 16)] }),
      statistics: (id) => (id === 'edge' ? stats(1.1, 9000, 9) : stats(99, 1000, 700)),
    });
    assert.equal(data.schema, 1);
    assert.deepEqual(Object.keys(data.reservoirs).sort(), ['reservoir:kakhovka', 'reservoir:kariba']);
    const kariba = data.reservoirs['reservoir:kariba'];
    assert.deepEqual(kariba.observations.map((o) => o.sceneId), ['full', 'older']);
    assert.equal(kariba.latest.waterPercent, 70);
    assert.equal(kariba.latest.relativeOrbit, 43);
    assert.deepEqual(kariba.partialScenes, ['edge']);
    assert.equal(kariba.searchedThrough, new Date(NOW).toISOString());
    const search = calls.find((c) => c[0] === 'search')[1];
    assert.deepEqual(search.collections, ['sentinel-1-rtc']);
    assert.equal(freshReservoirCount(data), 2);
  });

  it('carries the previous series forward and retries after an upstream error', async () => {
    const first = await run({ search: () => ({ features: [scene('s1', 8)] }), statistics: () => stats(100, 10, 5) });
    const { data, calls } = await run({
      previous: first.data,
      search: () => ({ features: [scene('s2', 1), scene('s1', 8)] }),
      statistics: () => { throw new Error('HTTP 502'); },
    });
    const kariba = data.reservoirs['reservoir:kariba'];
    assert.deepEqual(kariba.observations.map((o) => o.sceneId), ['s1'], 'kept the earlier reading');
    assert.equal(kariba.searchedThrough, first.data.reservoirs['reservoir:kariba'].searchedThrough, 'search window not advanced');
    assert.deepEqual(calls.filter((c) => c[0] === 'statistics').map((c) => c[1]), ['s2', 's2'], 's1 is not requested again');
  });

  it('keeps the series when the scene search fails', async () => {
    const first = await run({ search: () => ({ features: [scene('s1', 8)] }), statistics: () => stats(100, 10, 5) });
    const { data } = await run({ previous: first.data, search: () => { throw new Error('HTTP 503'); }, statistics: () => stats(100, 10, 5) });
    assert.deepEqual(data.reservoirs['reservoir:kariba'].observations.map((o) => o.sceneId), ['s1']);
  });

  it('posts the box as a GeoJSON feature with a User-Agent', async () => {
    let seen;
    const fetchStatistics = makeStatisticsFetch(async (url, init) => { seen = { url, init }; return { ok: true, json: async () => stats(100, 1, 1) }; });
    await fetchStatistics('S1C_X_rtc', { type: 'Polygon', coordinates: [] });
    assert.match(seen.url, /^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/statistics\?/);
    assert.match(seen.init.headers['User-Agent'], /WorldMonitor-Seed/);
    assert.equal(JSON.parse(seen.init.body).type, 'Feature');
  });
});

describe('reservoir water extent: seed contract', () => {
  it('validates a payload covering the whole watchlist and keeps the TTL above three daily runs', () => {
    const opts = buildSeedOptions(2);
    assert.ok(opts.ttlSeconds >= 3 * 86_400);
    assert.equal(opts.maxStaleMin, 4320);
    assert.equal(opts.validateFn({ schema: 1, reservoirs: { a: {}, b: {} } }), true);
    assert.equal(opts.validateFn({ schema: 1, reservoirs: { a: {} } }), false);
    assert.equal(typeof opts.afterFreshness, 'function');
  });

  it('ships dark with Orbital Watch', () => {
    assert.equal(waterExtentEnabled({}), false);
    assert.equal(waterExtentEnabled({ ORBITAL_WATCH_ENABLED: 'false' }), false);
    assert.equal(waterExtentEnabled({ ORBITAL_WATCH_ENABLED: ' TRUE ' }), true);
  });

  it('is registered in health, the climate bundle and the Railway watch paths', () => {
    const health = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');
    assert.match(health, new RegExp(`orbitalWaterExtent: '${ORBITAL_WATER_EXTENT_KEY}'`));
    assert.match(health, /orbitalWaterExtent: \{ key: 'seed-meta:orbital:water-extent', maxStaleMin: 4320/);
    assert.match(health, /ORBITAL_WATCH_ENABLED \? \[\] : \['orbitalSites', 'orbitalWaterExtent'\]/);
    const bundle = readFileSync(new URL('../scripts/seed-bundle-climate.mjs', import.meta.url), 'utf8');
    assert.match(bundle, /script: 'seed-orbital-water-extent\.mjs', seedMetaKey: 'orbital:water-extent', canonicalKey: 'orbital:water-extent:v1'/);
    const railway = readFileSync(new URL('../scripts/railway-services.json', import.meta.url), 'utf8');
    for (const path of ['scripts/seed-orbital-water-extent.mjs', 'scripts/_orbital-water-extent.mjs']) assert.ok(railway.includes(`"${path}"`), path);
  });
});
