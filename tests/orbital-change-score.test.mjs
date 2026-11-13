// Change scoring turns each watched land site's radar scenes into its one flag record. A
// baseline belongs to one orbit geometry, shared by the spacecraft of a constellation; an
// unusable scene is no observation; ports are never scored; and while the signal is
// shadowed the flag lives only under its own key, never in a site record or rollup.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { buildCatalog } from '../scripts/_orbital-catalog.mjs';
import {
  flagShadowKey,
  makeChangeStage,
  observationFromStatistics,
  radarGeometry,
  ScoringRefusal,
  scoreSiteChange,
} from '../scripts/_orbital-change.mjs';
import { acquisitionsFromStac, countryKey, evaluateSites, ORBITAL_SITES_KEY, siteKey, stacSearchBody } from '../scripts/_orbital-sites.mjs';
import { makeArchiveSearch, makeFetchSites, publicationCommands } from '../scripts/seed-orbital-sites.mjs';
import { advanceTrack, geometryKey, newTrack } from '../scripts/shared/orbital/flag-record.js';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const DAY_MS = 86_400_000;
const GEOMETRY = { constellation: 'sentinel-1', relativeOrbit: 65, orbitState: 'descending', mode: 'IW', polarizations: ['VH', 'VV'] };
const BASELINE_DB = [40.0, 40.2, 39.9, 40.1, 39.8, 40.0];
const LAND = { id: 'nuclear-facility:test', name: 'Test plant', lat: 47.51, lon: 34.59, countryCode: 'UA', surface: 'land', origins: [{ list: 'nuclear-facility', id: 'test' }] };
const PORT = { ...LAND, id: 'port:test', surface: 'maritime', origins: [{ list: 'port', id: 'test' }] };

let sequence = 0;
/** A radar acquisition as the site seeder holds it, with the statistics the archive would answer. */
function radarScene(vvDb, { daysAgo, platform = 'Sentinel-1C', geometry = GEOMETRY, validPercent = 100 } = {}) {
  sequence += 1;
  const band = (db) => ({ median: db === null ? null : 10 ** (db / 20), percentile_98: db === null ? null : 10 ** ((db + 12) / 20), valid_percent: validPercent, valid_pixels: validPercent * 100 });
  return {
    itemId: `S1_${String(sequence).padStart(4, '0')}`,
    collection: 'sentinel-1-grd',
    profileId: 'sentinel-1',
    platform,
    datetime: new Date(NOW - (daysAgo ?? 100 - sequence) * DAY_MS).toISOString(),
    cloudCover: null,
    radar: geometry,
    statistics: { vv_b1: band(vvDb), vh_b1: band(vvDb === null ? 34 : vvDb - 6) },
  };
}

function fakeArchive(scenes) {
  const byId = new Map(scenes.map((scene) => [scene.itemId, scene.statistics]));
  const requested = [];
  return {
    requested,
    fetchStatistics: async (scene) => {
      requested.push(scene.itemId);
      return byId.get(scene.itemId);
    },
  };
}

async function score(site, acquisitions, previous = null, { backfill = null } = {}) {
  const archive = fakeArchive([...acquisitions, ...(backfill ?? [])]);
  const result = await scoreSiteChange({
    site, acquisitions, previous, fetchStatistics: archive.fetchStatistics,
    searchBackfill: backfill && (async () => backfill), nowMs: NOW, deadlineMs: Infinity,
  });
  return { ...result, requested: archive.requested };
}

const trackOf = (flag, geometry = GEOMETRY) => flag.tracks[geometryKey(geometry)];

describe('orbital change scoring', () => {
  it('reads the orbit geometry from archive items and keeps it on radar acquisitions', () => {
    const feature = {
      id: 'S1C_IW_GRDH_1SDV_20261110', collection: 'sentinel-1-grd',
      properties: { datetime: '2026-11-10T03:55:46Z', platform: 'SENTINEL-1C', 'sat:relative_orbit': 65, 'sat:orbit_state': 'descending', 'sar:instrument_mode': 'IW', 'sar:polarizations': ['VV', 'VH'] },
    };
    const [acquisition] = acquisitionsFromStac([feature]);
    assert.deepEqual(acquisition.radar, GEOMETRY);
    assert.equal(radarGeometry({ ...feature.properties, 'sat:relative_orbit': undefined }), null);
    assert.ok(stacSearchBody(LAND, NOW).fields.include.includes('properties.sat:relative_orbit'));
  });

  it('never scores a port or other maritime site', async () => {
    const scenes = BASELINE_DB.map((db) => radarScene(db));
    const { flag, requested } = await score(PORT, scenes);
    assert.equal(flag, null);
    assert.deepEqual(requested, []);
  });

  it('shares one baseline across two spacecraft of a constellation on the same orbit', async () => {
    const scenes = BASELINE_DB.map((db, i) => radarScene(db, { platform: i % 2 ? 'Sentinel-1A' : 'Sentinel-1C' }));
    const { flag } = await score(LAND, scenes);
    assert.deepEqual(Object.keys(flag.tracks), [geometryKey(GEOMETRY)]);
    assert.equal(trackOf(flag).state, 'monitoring');
  });

  it('starts a new baseline when the acquisition mode changes', async () => {
    const extraWide = { ...GEOMETRY, mode: 'EW', polarizations: ['HH', 'HV'] };
    const scenes = [...BASELINE_DB.map((db) => radarScene(db)), radarScene(46, { geometry: extraWide })];
    const { flag } = await score(LAND, scenes);
    assert.equal(trackOf(flag).state, 'monitoring');
    assert.equal(trackOf(flag, extraWide).state, 'baseline-building');
    assert.deepEqual(flag.events, []);
  });

  it('neither confirms nor retracts a raised flag from a different relative orbit', async () => {
    const otherOrbit = { ...GEOMETRY, relativeOrbit: 14, orbitState: 'ascending' };
    const scenes = [...BASELINE_DB.map((db) => radarScene(db)), radarScene(42.5), radarScene(42.5, { geometry: otherOrbit }), radarScene(40, { geometry: otherOrbit })];
    const { flag } = await score(LAND, scenes);
    assert.equal(trackOf(flag).state, 'raised');
    assert.deepEqual(flag.events.map((event) => event.kind), ['raised']);
    assert.equal(flag.state, 'raised');
  });

  it('reaches monitoring from archived scenes without a new acquisition, and backfills once', async () => {
    const archived = BASELINE_DB.map((db, i) => radarScene(db, { daysAgo: 100 - i * 12 }));
    const first = await score(LAND, [], null, { backfill: archived });
    assert.equal(first.flag.state, 'monitoring');
    assert.equal(first.flag.backfilledAt, NOW);
    let searched = false;
    const second = await scoreSiteChange({
      site: LAND, acquisitions: [], previous: first.flag, fetchStatistics: async () => assert.fail('no scene is new'),
      searchBackfill: async () => { searched = true; return archived; }, nowMs: NOW, deadlineMs: Infinity,
    });
    assert.equal(searched, false);
    assert.deepEqual(second.flag.tracks, first.flag.tracks);
  });

  it('keeps the flag and retries backfill next run when the archived-scene search fails', async () => {
    const scenes = [radarScene(40)];
    const { flag, stopped, requests } = await scoreSiteChange({
      site: LAND, acquisitions: scenes, previous: null, fetchStatistics: async () => assert.fail('nothing is scored'),
      searchBackfill: async () => { throw new Error('Planetary Computer HTTP 503'); }, nowMs: NOW, deadlineMs: Infinity,
    });
    assert.equal(stopped, 'Planetary Computer HTTP 503');
    assert.equal(requests, 0);
    assert.equal(flag.backfilledAt, null);
    assert.deepEqual(flag.tracks, {});
  });

  it('treats a scene without valid pixels as no observation', async () => {
    const baseline = BASELINE_DB.map((db) => radarScene(db));
    const { flag: before } = await score(LAND, baseline);
    const empty = radarScene(55, { validPercent: 0 });
    const { flag } = await score(LAND, [...baseline, empty], before);
    assert.equal(trackOf(flag).state, 'monitoring');
    assert.deepEqual(trackOf(flag).baseline, trackOf(before).baseline);
    assert.equal(trackOf(flag).lastDatetime, empty.datetime, 'the empty scene is not requested again');
    assert.equal(observationFromStatistics(empty, null), null);
  });

  it('skips a null statistic instead of reading it as zero', () => {
    const scene = radarScene(null);
    const observation = observationFromStatistics(scene, scene.statistics);
    assert.deepEqual(Object.keys(observation.values).sort(), ['vh_median', 'vh_p98']);
    const track = BASELINE_DB.reduce((t, db) => advanceTrack(t, observationFromStatistics(radarScene(db), radarScene(db).statistics)).track, newTrack(GEOMETRY));
    const next = advanceTrack(track, observation);
    assert.equal(next.track.state, 'monitoring', 'a missing band is not a change to minus infinity or zero');
    assert.equal(next.event, null);
  });

  it('keeps what it folded before a failed statistics request and resumes there next run', async () => {
    const scenes = BASELINE_DB.map((db) => radarScene(db));
    let calls = 0;
    const failing = async (scene) => {
      calls += 1;
      if (calls === 4) throw new Error('HTTP 502');
      return scenes.find((s) => s.itemId === scene.itemId).statistics;
    };
    const partial = await scoreSiteChange({ site: LAND, acquisitions: scenes, previous: null, fetchStatistics: failing, nowMs: NOW, deadlineMs: Infinity });
    assert.equal(partial.stopped, 'HTTP 502');
    assert.equal(trackOf(partial.flag).baseline.length, 3);
    const { flag, requested } = await score(LAND, scenes, partial.flag);
    assert.deepEqual(requested, scenes.slice(3).map((s) => s.itemId));
    assert.equal(trackOf(flag).state, 'monitoring');
  });

  it('starts over when the site moves, keeping its event history', async () => {
    const scenes = [...BASELINE_DB.map((db) => radarScene(db)), radarScene(42.5)];
    const { flag } = await score(LAND, scenes);
    const moved = await score({ ...LAND, lat: 47.6 }, [], flag);
    assert.deepEqual(moved.flag.tracks, {});
    assert.deepEqual(moved.flag.events, flag.events);
  });

  it('raises on at least half of the sites with a known change, from recorded archive statistics', () => {
    const dir = new URL('./fixtures/orbital/change-replay/', import.meta.url);
    const replays = readdirSync(dir).map((file) => {
      const { scenes } = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
      const tracks = {};
      const kinds = [];
      for (const recorded of scenes) {
        const radar = radarGeometry({ 'sat:relative_orbit': recorded.relativeOrbit, 'sat:orbit_state': recorded.orbitState, 'sar:instrument_mode': recorded.mode, 'sar:polarizations': recorded.polarizations });
        const observation = observationFromStatistics({ ...recorded, radar }, recorded.statistics);
        if (!observation) continue;
        const key = geometryKey(radar);
        const next = advanceTrack(tracks[key] ?? newTrack(radar), observation);
        tracks[key] = next.track;
        if (next.event) kinds.push(next.event.kind);
      }
      return { file, raised: kinds.includes('raised') };
    });
    assert.ok(replays.length >= 4);
    const raised = replays.filter((replay) => replay.raised).length;
    assert.ok(raised * 2 >= replays.length, `raised at ${raised} of ${replays.length} sites`);
  });
});

describe('orbital change stage in the site seeder', () => {
  const celestrak = JSON.parse(readFileSync(new URL('./fixtures/orbital/celestrak-gp-2026-11-13.json', import.meta.url), 'utf8'));
  const catalog = buildCatalog({ records: celestrak.records, previous: null, nowMs: NOW });

  function memoryStore() {
    const kv = new Map();
    const read = (keyOf) => async (ids) => new Map(ids.filter((id) => kv.has(keyOf(id))).map((id) => [id, kv.get(keyOf(id))]));
    return {
      kv,
      readCatalog: async () => catalog,
      readIndex: async () => kv.get(ORBITAL_SITES_KEY) ?? null,
      readRecords: read(siteKey),
      readFlags: read(flagShadowKey),
      write: async (commands) => {
        for (const [verb, key, value] of commands) {
          if (verb === 'DEL') kv.delete(key);
          else if (verb === 'SET') kv.set(key, JSON.parse(value));
        }
      },
    };
  }

  async function run({ shadow }) {
    const scenes = [...BASELINE_DB.map((db) => radarScene(db)), radarScene(42.5), radarScene(42.4)];
    const archive = fakeArchive(scenes);
    const store = memoryStore();
    const { fetchSites, publishAtomically } = makeFetchSites({
      store, sites: [LAND, PORT], registryVersion: 'test', clock: () => NOW,
      searchArchive: async () => scenes,
      scoring: { fetchStatistics: archive.fetchStatistics, budgetMs: 60_000, shadow },
    });
    const index = await fetchSites();
    await publishAtomically(index, { canonicalKey: ORBITAL_SITES_KEY, payload: JSON.stringify(index), ttlSeconds: 60 });
    return { store, index, requested: archive.requested };
  }

  it('writes a shadowed flag only to its shadow key: no site record or country rollup carries it', async () => {
    const { store, index, requested } = await run({ shadow: undefined });
    assert.equal(store.kv.get(flagShadowKey(LAND.id)).state, 'confirmed');
    assert.equal(store.kv.get(siteKey(LAND.id)).flag, null);
    assert.ok(store.kv.get(countryKey('UA')).sites.every((site) => site.flag === null));
    assert.equal(store.kv.has(flagShadowKey(PORT.id)), false, 'a port has no flag record');
    assert.equal(requested.length, 8, 'only the land site was scored');
    assert.deepEqual(index.change, { shadow: true, scoredSites: 1, statisticsRequests: 8, halted: null });
    assert.ok(!JSON.stringify(store.kv.get(siteKey(LAND.id))).includes('confirmed'));
  });

  it('puts the flag on the site record and its projection on the rollup once the shadow ends', async () => {
    const { store } = await run({ shadow: false });
    assert.equal(store.kv.get(siteKey(LAND.id)).flag.state, 'confirmed');
    const site = store.kv.get(countryKey('UA')).sites.find((entry) => entry.siteId === LAND.id);
    assert.equal(site.flag.state, 'confirmed');
    assert.equal(site.flag.wording, 'imagery statistics changed');
    assert.equal(store.kv.has(flagShadowKey(LAND.id)), false);
  });

  it('keeps every previous flag when the statistics service refuses', async () => {
    const stage = makeChangeStage({ fetchStatistics: async () => { throw new ScoringRefusal('HTTP 429'); }, budgetMs: 60_000, clock: () => NOW });
    const previous = { schema: 1, footprint: { lat: LAND.lat, lon: LAND.lon, halfSizeDeg: 0.01 }, tracks: {}, events: [], backfilledAt: NOW };
    assert.equal(await stage.score({ site: LAND, acquisitions: [radarScene(40)], previous, nowMs: NOW }), previous);
    assert.equal(stage.summary().halted, 'HTTP 429');
  });

  it('stops scoring, keeping the previous flag, when the archive refuses the backfill search', async () => {
    const searchArchive = makeArchiveSearch({ fetchImpl: async () => new Response(null, { status: 429 }), minIntervalMs: 0 });
    const stage = makeChangeStage({ fetchStatistics: async () => assert.fail('nothing is scored'), searchBackfill: searchArchive.backfill, budgetMs: 60_000, clock: () => NOW });
    assert.equal(await stage.score({ site: LAND, acquisitions: [radarScene(40)], previous: null, nowMs: NOW }), null);
    assert.match(stage.summary().halted, /HTTP 429/);
  });

  it('scores the least recently scored sites first, so sites a short budget missed catch up next run', async () => {
    const sites = ['a', 'b', 'c'].map((id) => ({ ...LAND, id: `hotspot:${id}` }));
    const scored = [];
    const change = {
      shadow: true,
      previousFlags: new Map([['hotspot:a', { updatedAt: NOW - DAY_MS }], ['hotspot:c', { updatedAt: NOW - 3 * DAY_MS }]]),
      score: async ({ site }) => { scored.push(site.id); return null; },
      summary: () => null,
    };
    await evaluateSites({ sites, catalog, previousRecords: new Map(), cursor: null, searchArchive: async () => [], nowMs: NOW, deadlineMs: Infinity, clock: () => NOW, change });
    assert.deepEqual(scored, ['hotspot:b', 'hotspot:c', 'hotspot:a']);
  });

  it('refreshes shadow keys of sites it did not evaluate and deletes those of removed sites', () => {
    const commands = publicationCommands(
      { siteWrites: [], retainedSiteIds: ['hotspot:b'], rollupWrites: [], flagWrites: [{ siteId: 'hotspot:a' }], deletes: [flagShadowKey('gone')] },
      { canonicalKey: ORBITAL_SITES_KEY, payload: '{}', ttlSeconds: 60 },
    );
    assert.ok(commands.some(([verb, key]) => verb === 'SET' && key === flagShadowKey('hotspot:a')));
    assert.ok(commands.some(([verb, key]) => verb === 'EXPIRE' && key === flagShadowKey('hotspot:b')));
    assert.ok(commands.some(([verb, key]) => verb === 'DEL' && key === flagShadowKey('gone')));
  });
});
