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
  MAX_SEARCH_PAGES,
  makeFetchWaterExtent,
  makeSceneSearch,
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
    assert.throws(() => readingFromStatistics({ properties: {} }, 100), /lacks the vv_b1 histogram/);
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
  const run = async ({ previous = null, statistics, search, budgetMs, now = () => NOW }) => {
    const calls = [];
    const fetchWaterExtent = makeFetchWaterExtent({
      sites, watchlist, budgetMs,
      readPrevious: async () => previous,
      searchScenes: async (body, options) => { calls.push(['search', body, options]); return search(body); },
      fetchStatistics: async (id, geometry) => { calls.push(['statistics', id, geometry]); return statistics(id); },
      now,
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
    const [, search, options] = calls.find((c) => c[0] === 'search');
    assert.deepEqual(search.collections, ['sentinel-1-rtc']);
    assert.ok(Number.isFinite(options.deadlineMs), 'the search is told the run deadline');
    assert.equal(freshReservoirCount(data), 2);
  });

  it('carries the previous series forward and retries after an upstream error', async () => {
    const first = await run({ search: () => ({ features: [scene('s1', 8)] }), statistics: () => stats(100, 10, 5) });
    let statisticsCalls = 0;
    const { data, calls } = await run({
      previous: first.data,
      search: () => ({ features: [scene('s2', 1), scene('s1', 8)] }),
      statistics: () => { statisticsCalls += 1; if (statisticsCalls === 1) throw new Error('HTTP 502'); return stats(100, 10, 5); },
    });
    const failed = Object.values(data.reservoirs).find((r) => r.observations.length === 1);
    const ok = Object.values(data.reservoirs).find((r) => r.observations.length === 2);
    assert.deepEqual(failed.observations.map((o) => o.sceneId), ['s1'], 'kept the earlier reading');
    assert.equal(failed.searchedThrough, first.data.reservoirs[failed.siteId].searchedThrough, 'search window not advanced');
    assert.equal(ok.searchedThrough, new Date(NOW).toISOString());
    assert.deepEqual(calls.filter((c) => c[0] === 'statistics').map((c) => c[1]), ['s2', 's2'], 's1 is not requested again');
  });

  it('fails the run when the archive answers no request, so seed-meta is not refreshed', async () => {
    const first = await run({ search: () => ({ features: [scene('s1', 8)] }), statistics: () => stats(100, 10, 5) });
    await assert.rejects(
      run({ previous: first.data, search: () => { throw new Error('HTTP 503'); }, statistics: () => stats(100, 10, 5) }),
      /every scene search failed/,
    );
    await assert.rejects(
      run({ previous: first.data, search: () => ({ features: [scene('s2', 1)] }), statistics: () => { throw new Error('HTTP 500'); } }),
      /every statistics request failed/,
    );
  });

  it('retries a scene whose statistics response is malformed instead of marking it partial', async () => {
    const { data } = await run({ search: () => ({ features: [scene('s1', 8), scene('s2', 9)] }), statistics: (id) => (id === 's1' ? { properties: {} } : stats(100, 10, 5)) });
    const kariba = data.reservoirs['reservoir:kariba'];
    assert.deepEqual(kariba.observations.map((o) => o.sceneId), ['s2']);
    assert.deepEqual(kariba.partialScenes, []);
    assert.equal(kariba.searchedThrough, null, 'search window not advanced');
  });

  it('makes no request once the budget is spent, even for reservoirs never measured', async () => {
    let clock = NOW;
    const { data, calls } = await run({
      budgetMs: 1_000,
      now: () => clock,
      search: () => { clock += 5_000; return { features: [scene('s1', 8)] }; },
      statistics: () => stats(100, 10, 5),
    });
    assert.deepEqual(calls.map((c) => c[0]), ['search'], 'one search, then the deadline stops every request');
    assert.deepEqual(Object.keys(data.reservoirs).sort(), ['reservoir:kakhovka', 'reservoir:kariba']);
    const untouched = Object.values(data.reservoirs).find((r) => r.observations.length === 0);
    assert.equal(untouched.searchedThrough, null);
  });

  it('keeps the series when one scene search fails', async () => {
    const first = await run({ search: () => ({ features: [scene('s1', 8)] }), statistics: () => stats(100, 10, 5) });
    let searches = 0;
    const { data } = await run({
      previous: first.data,
      search: () => { searches += 1; if (searches === 1) throw new Error('HTTP 503'); return { features: [] }; },
      statistics: () => stats(100, 10, 5),
    });
    for (const record of Object.values(data.reservoirs)) assert.deepEqual(record.observations.map((o) => o.sceneId), ['s1']);
  });

  it('follows search pages on the search host and flags a search with pages left over', async () => {
    const posts = [];
    const pageOf = (id, token) => ({
      features: [scene(id, 1)],
      links: token ? [{ rel: 'next', method: 'POST', href: 'https://planetarycomputer.microsoft.com/api/stac/v1/search', body: { token }, merge: true }] : [],
    });
    const search = makeSceneSearch(async (url, init) => {
      const body = JSON.parse(init.body);
      posts.push(body);
      const n = posts.length;
      return { ok: true, json: async () => pageOf(`p${n}`, n < 2 ? `next:${n}` : null) };
    });
    const two = await search({ collections: ['sentinel-1-rtc'] });
    assert.deepEqual(two.features.map((f) => f.id), ['p1', 'p2']);
    assert.equal(two.truncated, false);
    assert.deepEqual(posts[1], { collections: ['sentinel-1-rtc'], token: 'next:1' }, 'next page merges the token into the search');

    const endless = makeSceneSearch(async () => ({ ok: true, json: async () => pageOf('x', 'more') }));
    const capped = await endless({});
    assert.equal(capped.features.length, MAX_SEARCH_PAGES);
    assert.equal(capped.truncated, true);

    let clock = 0;
    const late = makeSceneSearch(async () => { clock += 10; return { ok: true, json: async () => pageOf('first', 'more') }; }, () => clock);
    const stopped = await late({}, { deadlineMs: 5 });
    assert.equal(stopped.features.length, 1, 'no further page is requested past the deadline');
    assert.equal(stopped.truncated, true);

    let pages = 0;
    const flaky = makeSceneSearch(async () => {
      pages += 1;
      if (pages === 2) return { ok: false, status: 502 };
      return { ok: true, json: async () => pageOf('first', 'more') };
    });
    const kept = await flaky({});
    assert.deepEqual(kept.features.map((f) => f.id), ['first'], 'a failed later page keeps the pages already read');
    assert.equal(kept.truncated, true);

    const offHost = makeSceneSearch(async () => ({ ok: true, json: async () => ({ features: [], links: [{ rel: 'next', href: 'https://example.com/steal' }] }) }));
    assert.equal((await offHost({})).truncated, true);
  });

  it('does not mark a truncated search complete', async () => {
    const { data } = await run({ search: () => ({ features: [scene('s1', 2)], truncated: true }), statistics: () => stats(100, 10, 5) });
    const kariba = data.reservoirs['reservoir:kariba'];
    assert.deepEqual(kariba.observations.map((o) => o.sceneId), ['s1']);
    assert.equal(kariba.searchedThrough, null);
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
