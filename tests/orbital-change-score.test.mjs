// Change scoring turns each watched land site's radar scenes into its one flag record. A
// baseline belongs to one orbit geometry, shared by the spacecraft of a constellation; an
// unusable scene is no observation; ports are never scored; and while the signal is
// shadowed the flag lives only under its own key, never in a site record or rollup.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { buildCatalog } from '../scripts/_orbital-catalog.mjs';
import {
  CHANGE_SHADOW,
  changeScoringExclusions,
  checkStatistics,
  continuedFlag,
  flagShadowKey,
  makeChangeStage,
  MAX_SCENE_ATTEMPTS,
  observationFromStatistics,
  radarGeometry,
  ScoringRefusal,
  scoreSiteChange,
  SHADOW_EXIT_RULE,
  shadowExitStatus,
  UnexpectedStatistics,
} from '../scripts/_orbital-change.mjs';
import { ArchiveRefusal, acquisitionsFromStac, countryKey, evaluateSites, ORBITAL_SITES_KEY, siteKey, stacSearchBody } from '../scripts/_orbital-sites.mjs';
import { makeArchiveSearch, makeFetchSites, makeStatisticsFetch, MAX_SEARCH_PAGES, publicationCommands } from '../scripts/seed-orbital-sites.mjs';
import { replayKnownChanges, replaySample, TARGETS } from '../scripts/replay-orbital-change.mjs';
import { SITE_WATER_PERCENT } from '../scripts/shared/orbital-site-water.mjs';
import { WATCHED_SITES } from '../scripts/shared/orbital-watched-sites.generated.mjs';
import { advanceTrack, geometryKey, newTrack } from '../scripts/shared/orbital/flag-record.js';
import orbitalSiteAlerts from '../scripts/lib/orbital-site-alerts.cjs';

const { publishOrbitalSiteAlerts } = orbitalSiteAlerts;

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

  it('counts a known change only when a raise falls inside the window after the event', async () => {
    const results = await replayKnownChanges();
    assert.ok(results.length >= 4);
    for (const result of results) {
      assert.ok(result.windowDays > 0 && Number.isFinite(Date.parse(result.eventDate)), `${result.file} names its event`);
      if (result.detected) {
        const raisedMs = Date.parse(result.firstRaiseInWindow);
        assert.ok(raisedMs >= Date.parse(result.eventDate) && raisedMs <= Date.parse(result.eventDate) + result.windowDays * DAY_MS);
      }
    }
    // Recorded outcome with the current thresholds (see docs/methodology/orbital-change-signal.mdx):
    // Zaporizhzhia raises five days before the dam breach and Gaza three months after the event,
    // so neither counts; Fordow and Natanz raise nothing. The plan's known-change target is not met,
    // and a change to the scorer that moves any of these must update this record.
    assert.deepEqual(Object.fromEntries(results.map((r) => [r.file, r.detected])), {
      'fordow-2025.json': false, 'gaza-2023.json': false, 'natanz-2025.json': false, 'znpp-2023.json': false,
    });
    const znpp = results.find((r) => r.file === 'znpp-2023.json');
    assert.ok(znpp.raisesOutsideWindow.some((d) => d < znpp.eventDate), 'a raise before the event is not a detection');
  });

  it('reproduces the recorded 90-day, 30-site replay, which misses the plan\'s retraction target', async () => {
    const { all, scored } = await replaySample();
    assert.equal(all.sites, 30);
    assert.deepEqual([all.raised, all.confirmed, all.retracted], [33, 3, 18]);
    assert.deepEqual([scored.sites, scored.raised, scored.confirmed, scored.retracted, scored.likelyEnvironmental], [24, 26, 2, 13, 1]);
    assert.ok(scored.retractedShare >= TARGETS.maxRetractedShare, 'the shadow-exit rule keeps this target, so the flag stays in shadow');
    assert.ok(scored.retractedShare >= SHADOW_EXIT_RULE.maxRetractedShare);
  });

  it('skips and counts a scene whose statistics fail on every run, then reads past it', async () => {
    const scenes = BASELINE_DB.map((db) => radarScene(db));
    const bad = scenes[2].itemId;
    const fetchStatistics = async (scene) => {
      if (scene.itemId === bad) throw new Error('HTTP 500');
      return scenes.find((s) => s.itemId === scene.itemId).statistics;
    };
    let flag = null;
    for (let run = 1; run < MAX_SCENE_ATTEMPTS; run += 1) {
      const result = await scoreSiteChange({ site: LAND, acquisitions: scenes, previous: flag, fetchStatistics, nowMs: NOW, deadlineMs: Infinity });
      flag = result.flag;
      assert.equal(result.stopped, 'HTTP 500');
      assert.equal(flag.unfinished, true);
      assert.equal(trackOf(flag).baseline.length, 2, 'what was folded before the failing scene is kept');
      assert.equal(flag.sceneFailures[bad], run);
    }
    const last = await scoreSiteChange({ site: LAND, acquisitions: scenes, previous: flag, fetchStatistics, nowMs: NOW, deadlineMs: Infinity });
    assert.equal(last.stopped, null);
    assert.equal(last.skippedScenes, 1);
    assert.equal(last.flag.counts.skippedScenes, 1);
    assert.deepEqual(last.flag.sceneFailures, {});
    assert.equal(last.flag.unfinished, false);
    assert.equal(trackOf(last.flag).baseline.length, 5, 'the scenes after the skipped one are folded');
  });

  it('counts every event, beyond the events the record keeps', async () => {
    const scenes = [...BASELINE_DB.map((db) => radarScene(db)), radarScene(42.5), radarScene(40), radarScene(42.5), radarScene(42.4)];
    const { flag } = await score(LAND, scenes);
    assert.deepEqual(flag.counts, { raised: 2, confirmed: 1, retracted: 1, skippedScenes: 0 });
  });
});

describe('orbital statistics responses', () => {
  const scene = radarScene(40);

  it('fails loudly on a response whose band keys the scorer does not know', () => {
    assert.equal(checkStatistics(scene, scene.statistics), scene.statistics);
    const renamed = { 'vv-b1': scene.statistics.vv_b1, vh_b1: scene.statistics.vh_b1 };
    assert.throws(() => checkStatistics(scene, renamed), (error) => error instanceof UnexpectedStatistics && /no vv_b1 band/.test(error.message));
    assert.throws(() => checkStatistics(scene, null), UnexpectedStatistics);
    assert.throws(() => checkStatistics(scene, { vv_b1: { valid_percent: 100 }, vh_b1: scene.statistics.vh_b1 }), /lack median, percentile_98/);
    const empty = { vv_b1: { valid_percent: 0 }, vh_b1: { valid_percent: 0 } };
    assert.equal(checkStatistics(scene, empty), empty, 'a band with too few valid pixels is a real answer');
  });

  it('checks the response in the statistics fetch, and the stage halts without marking the scene read', async () => {
    const fetchStatistics = makeStatisticsFetch({ fetchImpl: async () => Response.json({ properties: { statistics: { b1: {} } } }), minIntervalMs: 0 });
    await assert.rejects(fetchStatistics(scene, {}), UnexpectedStatistics);
    const stage = makeChangeStage({ fetchStatistics, budgetMs: 60_000, clock: () => NOW });
    const flag = await stage.score({ site: LAND, acquisitions: [scene], previous: null, nowMs: NOW });
    assert.deepEqual(flag.tracks, {}, 'the scene is not marked processed');
    assert.equal(stage.summary().haltKind, 'unexpected-response');
    assert.match(stage.summary().halted, /no vh_b1 band/);
  });
});

describe('orbital change scoring exclusions', () => {
  const at = (id, lat, lon, origins = 1) => ({ id, lat, lon, surface: 'land', origins: Array.from({ length: origins }, (_, i) => ({ list: 'x', id: `${id}-${i}` })) });

  it('leaves out water points and all but one site of a group whose footprints overlap', () => {
    const sites = [at('a', 10, 10), at('b', 10.015, 10.005, 2), at('c', 10.03, 10.01), at('d', 20, 20), at('w', 30, 30), { ...at('p', 10, 10), surface: 'maritime' }];
    const excluded = changeScoringExclusions(sites, { w: 80, d: 40 });
    assert.deepEqual(Object.fromEntries(excluded), { w: 'water', a: 'duplicate of b', c: 'duplicate of b' });
  });

  it('measures water for every registry land site, and leaves out the registry water points the review named', () => {
    const land = WATCHED_SITES.filter((site) => site.surface === 'land');
    assert.deepEqual(land.filter((site) => !(site.id in SITE_WATER_PERCENT)).map((site) => site.id), [], 'run scripts/measure-orbital-site-water.mjs after a registry change');
    const excluded = changeScoringExclusions(WATCHED_SITES, SITE_WATER_PERCENT);
    assert.equal(excluded.get('conflict-zone:strait_hormuz'), 'water');
    assert.equal(excluded.get('military-base:fleet_activities'), 'water', 'the Okinawa placeholder coordinate is open sea');
    const scored = land.filter((site) => !excluded.has(site.id));
    for (let i = 0; i < scored.length; i += 1) {
      for (let j = i + 1; j < scored.length; j += 1) {
        const [a, b] = [scored[i], scored[j]];
        const overlap = Math.abs(a.lat - b.lat) < 0.02 && Math.abs(a.lon - b.lon) < 0.02 / Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
        assert.ok(!overlap, `${a.id} and ${b.id} share pixels`);
      }
    }
  });
});

describe('orbital shadow exit', () => {
  const flagWith = (confirmed, retracted) => ({ counts: { raised: confirmed + retracted, confirmed, retracted, skippedScenes: 0 } });

  it('encodes R26: 30 days and 30 resolved flags, fewer than one in ten retracted', () => {
    assert.equal(CHANGE_SHADOW, true, 'the shadow stays on until a reviewed change ends it');
    assert.deepEqual(SHADOW_EXIT_RULE, { minDays: 30, minResolvedFlags: 30, maxRetractedShare: 0.1 });
    const since = NOW - 31 * DAY_MS;
    assert.equal(shadowExitStatus({ shadowSince: since, flags: [flagWith(28, 2)], nowMs: NOW }).ready, true);
    assert.deepEqual(shadowExitStatus({ shadowSince: NOW - 29 * DAY_MS, flags: [flagWith(30, 0)], nowMs: NOW }).blockers, ['29 of 30 shadow days']);
    assert.deepEqual(shadowExitStatus({ shadowSince: since, flags: [flagWith(20, 2), null], nowMs: NOW }).blockers, ['22 of 30 resolved flags']);
    assert.deepEqual(shadowExitStatus({ shadowSince: since, flags: [flagWith(4, 16), flagWith(10, 0)], nowMs: NOW }).blockers, ['retracted share 0.533 is not under 0.1']);
  });

  it('continues from the newer of the live and shadow flags', () => {
    const live = { updatedAt: NOW - DAY_MS };
    const shadowed = { updatedAt: NOW };
    assert.equal(continuedFlag(null, shadowed), shadowed);
    assert.equal(continuedFlag(live, null), live);
    assert.equal(continuedFlag(live, shadowed), shadowed);
    assert.equal(continuedFlag({ updatedAt: NOW + 1 }, shadowed).updatedAt, NOW + 1);
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

  async function run({ shadow, alerts = null, scenes = [...BASELINE_DB.map((db) => radarScene(db)), radarScene(42.5), radarScene(42.4)], store = memoryStore(), nowMs = NOW }) {
    const archive = fakeArchive(scenes);
    const { fetchSites, publishAtomically } = makeFetchSites({
      store, sites: [LAND, PORT], registryVersion: 'test', clock: () => nowMs, waterPercent: {},
      searchArchive: async () => scenes,
      scoring: { fetchStatistics: archive.fetchStatistics, budgetMs: 60_000, shadow },
      alerts,
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
    const { exit, ...summary } = index.change;
    assert.deepEqual(summary, { shadow: true, scoredSites: 1, unfinishedSites: 0, skippedSites: 0, excludedSites: 0, skippedScenes: 0, lastStopReason: null, statisticsRequests: 8, halted: null, haltKind: null });
    assert.deepEqual({ ...exit, blockers: exit.blockers.length }, { shadowSince: NOW, days: 0, confirmed: 1, retracted: 0, resolved: 1, retractedShare: 0, ready: false, blockers: 2 });
    assert.ok(!JSON.stringify(store.kv.get(siteKey(LAND.id))).includes('confirmed'));
  });

  it('carries the shadow start across runs, so the R26 days are counted from the first shadow run', async () => {
    const store = memoryStore();
    await run({ shadow: undefined, store });
    const { index } = await run({ shadow: undefined, store, nowMs: NOW + 31 * DAY_MS });
    assert.equal(index.change.exit.shadowSince, NOW);
    assert.equal(index.change.exit.days, 31);
  });

  it('promotes the shadow flag record when the shadow ends, instead of restarting from an empty baseline', async () => {
    const store = memoryStore();
    const baseline = BASELINE_DB.map((db) => radarScene(db));
    await run({ shadow: undefined, store, scenes: baseline });
    const shadowed = store.kv.get(flagShadowKey(LAND.id));
    assert.equal(shadowed.state, 'monitoring');
    const next = [radarScene(42.5), radarScene(42.4)];
    const { requested } = await run({ shadow: false, store, scenes: [...baseline, ...next], nowMs: NOW + 1 });
    assert.deepEqual(requested, next.map((scene) => scene.itemId), 'only scenes the shadow flag had not seen are read');
    const live = store.kv.get(siteKey(LAND.id)).flag;
    assert.equal(live.state, 'confirmed');
    assert.deepEqual(trackOf(live).confirmedBy.raisedBy.itemId, next[0].itemId);
    assert.equal(live.counts.confirmed, 1);
    assert.equal(store.kv.get(countryKey('UA')).sites.find((entry) => entry.siteId === LAND.id).flag.state, 'confirmed');
  });

  it('leaves excluded sites unscored', async () => {
    const scenes = BASELINE_DB.map((db) => radarScene(db));
    const archive = fakeArchive(scenes);
    const store = memoryStore();
    const { fetchSites } = makeFetchSites({
      store, sites: [LAND], registryVersion: 'test', clock: () => NOW, searchArchive: async () => scenes,
      scoring: { fetchStatistics: archive.fetchStatistics, budgetMs: 60_000 }, waterPercent: { [LAND.id]: 90 },
    });
    const index = await fetchSites();
    assert.deepEqual(archive.requested, []);
    assert.equal(index.change.excludedSites, 1);
  });

  it('puts the flag on the site record and its projection on the rollup once the shadow ends', async () => {
    const { store } = await run({ shadow: false });
    assert.equal(store.kv.get(siteKey(LAND.id)).flag.state, 'confirmed');
    const site = store.kv.get(countryKey('UA')).sites.find((entry) => entry.siteId === LAND.id);
    assert.equal(site.flag.state, 'confirmed');
    assert.equal(site.flag.wording, 'imagery statistics changed');
    assert.equal(store.kv.has(flagShadowKey(LAND.id)), false);
  });

  function alertSink() {
    let state = null;
    const events = [];
    const alerts = (records, { shadow }) => publishOrbitalSiteAlerts(records, {
      shadow,
      now: () => NOW,
      readState: async () => state,
      writeState: async (_key, next) => { state = structuredClone(next); return true; },
      publish: async (event) => { events.push(event); return true; },
    });
    return { alerts, events };
  }

  it('sends no confirmed-change alert while the flag is shadowed', async () => {
    const sink = alertSink();
    const { store } = await run({ shadow: undefined, alerts: sink.alerts });
    assert.equal(store.kv.get(flagShadowKey(LAND.id)).state, 'confirmed', 'the shadow flag is confirmed');
    assert.deepEqual(sink.events.filter((event) => event.eventType === 'orbital_site_change'), []);
  });

  it('sends one confirmed-change alert per site once the shadow ends, and none on the next run', async () => {
    const sink = alertSink();
    await run({ shadow: false, alerts: sink.alerts });
    const changes = sink.events.filter((event) => event.eventType === 'orbital_site_change');
    assert.deepEqual(changes.map((event) => event.payload.siteId), [LAND.id]);
    await run({ shadow: false, alerts: sink.alerts });
    assert.equal(sink.events.filter((event) => event.eventType === 'orbital_site_change').length, 1);
  });

  it('keeps what a site folded before the statistics service refused, and scores nothing more that run', async () => {
    const scenes = BASELINE_DB.map((db) => radarScene(db));
    let calls = 0;
    const fetchStatistics = async (scene) => {
      calls += 1;
      if (calls === 4) throw new ScoringRefusal('HTTP 429');
      return scenes.find((s) => s.itemId === scene.itemId).statistics;
    };
    const stage = makeChangeStage({ fetchStatistics, budgetMs: 60_000, clock: () => NOW });
    const flag = await stage.score({ site: LAND, acquisitions: scenes, previous: null, nowMs: NOW });
    assert.equal(trackOf(flag).baseline.length, 3, 'progress before the refusal is kept');
    assert.equal(flag.unfinished, true);
    assert.equal(stage.summary().halted, 'HTTP 429');
    assert.equal(stage.summary().haltKind, 'refusal');
    const previous = { updatedAt: NOW - DAY_MS };
    assert.equal(await stage.score({ site: LAND, acquisitions: scenes, previous, nowMs: NOW }), previous);
    assert.equal(stage.summary().skippedSites, 1);
  });

  it('counts a site whose scoring stopped early as unfinished, with the reason', async () => {
    const stage = makeChangeStage({ fetchStatistics: async () => { throw new Error('HTTP 502'); }, budgetMs: 60_000, clock: () => NOW });
    await stage.score({ site: LAND, acquisitions: [radarScene(40)], previous: null, nowMs: NOW });
    assert.deepEqual(stage.summary(), { shadow: true, scoredSites: 0, unfinishedSites: 1, skippedSites: 0, excludedSites: 0, skippedScenes: 0, lastStopReason: 'HTTP 502', statisticsRequests: 1, halted: null, haltKind: null });
  });

  it('stops scoring when the archive refuses the backfill search, leaving backfill for a later run', async () => {
    const searchArchive = makeArchiveSearch({ fetchImpl: async () => new Response(null, { status: 429 }), minIntervalMs: 0 });
    const stage = makeChangeStage({ fetchStatistics: async () => assert.fail('nothing is scored'), searchBackfill: searchArchive.backfill, budgetMs: 60_000, clock: () => NOW });
    const flag = await stage.score({ site: LAND, acquisitions: [radarScene(40)], previous: null, nowMs: NOW });
    assert.deepEqual(flag.tracks, {});
    assert.equal(flag.backfilledAt, null);
    assert.equal(flag.unfinished, true);
    assert.match(stage.summary().halted, /HTTP 429/);
    assert.equal(stage.summary().haltKind, 'refusal');
  });

  it('follows the archive search to its next pages', async () => {
    const bodies = [];
    const feature = (i) => ({ id: `S1_${i}`, collection: 'sentinel-1-grd', properties: { datetime: new Date(NOW - i * 3_600_000).toISOString(), platform: 'SENTINEL-1C' } });
    const searchArchive = makeArchiveSearch({
      minIntervalMs: 0,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        const page = bodies.length;
        return Response.json({ features: [feature(page)], links: [{ rel: 'next', method: 'POST', body: { ...body, token: `next:${page}` } }] });
      },
    });
    const acquisitions = await searchArchive(LAND, NOW);
    assert.equal(bodies.length, MAX_SEARCH_PAGES);
    assert.equal(acquisitions.length, MAX_SEARCH_PAGES);
    assert.equal(bodies[1].token, 'next:1');
  });

  it('spaces concurrent statistics requests by the throttle interval', async () => {
    const started = [];
    const fetchStatistics = makeStatisticsFetch({
      minIntervalMs: 40,
      fetchImpl: async () => { started.push(performance.now()); return Response.json({ properties: { statistics: radarScene(40).statistics } }); },
    });
    await Promise.all([radarScene(40), radarScene(40), radarScene(40)].map((scene) => fetchStatistics(scene, {})));
    started.sort((x, y) => x - y);
    assert.ok(started.every((at, i) => i === 0 || at - started[i - 1] >= 35), `started at ${started}`);
  });

  it('scores unfinished sites first, then the least recently scored, so sites a short budget missed catch up next run', async () => {
    const sites = ['a', 'b', 'c', 'd'].map((id) => ({ ...LAND, id: `hotspot:${id}` }));
    const scored = [];
    const change = {
      shadow: true,
      previousFlags: new Map([['hotspot:a', { updatedAt: NOW - DAY_MS }], ['hotspot:c', { updatedAt: NOW - 3 * DAY_MS }], ['hotspot:d', { updatedAt: NOW, unfinished: true }]]),
      score: async ({ site }) => { scored.push(site.id); return null; },
      summary: () => null,
    };
    await evaluateSites({ sites, catalog, previousRecords: new Map(), cursor: null, searchArchive: async () => [], nowMs: NOW, deadlineMs: Infinity, clock: () => NOW, change });
    assert.deepEqual(scored, ['hotspot:d', 'hotspot:b', 'hotspot:c', 'hotspot:a']);
  });

  it('checks a published record\'s size only with the flag scoring returned, not the one it replaces', async () => {
    const oversized = { state: 'monitoring', wording: 'imagery statistics changed', updatedAt: NOW - DAY_MS, tracks: {}, events: [], padding: 'x'.repeat(64 * 1024) };
    const scoredFlag = { state: 'monitoring', wording: 'imagery statistics changed', updatedAt: NOW, tracks: {}, events: [] };
    const change = { shadow: false, previousFlags: new Map(), score: async () => scoredFlag, summary: () => null };
    const { records } = await evaluateSites({
      sites: [LAND], catalog, previousRecords: new Map([[LAND.id, { flag: oversized }]]), cursor: null,
      searchArchive: async () => [], nowMs: NOW, deadlineMs: Infinity, clock: () => NOW, change,
    });
    assert.deepEqual(records.get(LAND.id).flag, scoredFlag);
  });

  it('keeps live flags on the records of sites searched before an archive refusal', async () => {
    const liveFlag = { state: 'monitoring', wording: 'imagery statistics changed', updatedAt: NOW - DAY_MS, tracks: {}, events: [] };
    const sites = [LAND, { ...LAND, id: 'nuclear-facility:test2' }];
    const change = { shadow: false, previousFlags: new Map(), score: async () => assert.fail('nothing is scored after a refusal'), summary: () => null };
    let calls = 0;
    const { records, refused } = await evaluateSites({
      sites, catalog, previousRecords: new Map([[LAND.id, { flag: liveFlag }]]), cursor: null, nowMs: NOW, deadlineMs: Infinity, clock: () => NOW, change,
      searchArchive: async () => { calls += 1; if (calls === 2) throw new ArchiveRefusal('HTTP 429'); return []; },
    });
    assert.match(refused, /429/);
    assert.deepEqual(records.get(LAND.id).flag, liveFlag);
  });

  it('keeps a site\'s previous record, instead of failing the run, when its new record is over the size cap', async () => {
    const oversized = { state: 'monitoring', wording: 'imagery statistics changed', updatedAt: NOW, tracks: {}, events: [], padding: 'x'.repeat(64 * 1024) };
    const change = { shadow: false, previousFlags: new Map(), score: async () => oversized, summary: () => null };
    const { records, failed } = await evaluateSites({
      sites: [LAND], catalog, previousRecords: new Map(), cursor: null, searchArchive: async () => [], nowMs: NOW, deadlineMs: Infinity, clock: () => NOW, change,
    });
    assert.equal(records.has(LAND.id), false);
    assert.match(failed[0].reason, /over/);
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
