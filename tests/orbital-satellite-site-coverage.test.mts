import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { findPasses, ORBIT_ELEMENTS_MAX_AGE_DAYS } from '../shared/orbital/pass-geometry.js';
import { SENSOR_PROFILES, matchSensorProfile } from '../shared/orbital/sensor-profiles.js';
import { OPTICAL_MIN_SUN_ELEVATION_DEG } from '../shared/orbital/tiers.js';
import { composeWatchedSites } from '../shared/watched-sites.ts';
import {
  COVERAGE_RENEW_MS,
  coverageAt,
  imagingProfileFor,
  orbitElementsFromTle,
  satellitesCoveringSite,
  sitesCoveredBySatellite,
  watchedSiteAt,
  type TrackedSatelliteTle,
} from '../src/services/orbital/satellite-site-coverage.ts';
import { classifyYaogan, trackedSatelliteType } from '../src/services/orbital/yaogan-class.ts';

const names = JSON.parse(readFileSync(new URL('./fixtures/orbital/celestrak-names-2026-11-14.json', import.meta.url), 'utf8')) as {
  active: Array<[number, string]>;
  yaoganSatcat: Array<[number, string, 'PAY' | 'DEB', string | null]>;
};
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const DAY = 86_400_000;
const EPOCH_MS = Date.UTC(2026, 0, 1) + (317.5 - 1) * DAY; // 2026-11-13T12:00Z

function tle(noradId: number, name: string): TrackedSatelliteTle {
  const id = String(noradId).padStart(5, '0');
  const line1 = `1 ${id}U 15028A   26317.50000000  .00000100  00000-0  50000-4 0  9990`;
  const line2 = `2 ${id}  98.5660  30.0000 0001000  90.0000 270.0000 14.30815000500000`;
  return { noradId: String(noradId), name, line1, line2 };
}

const sentinel2a = tle(40697, 'SENTINEL-2A');
const sites = composeWatchedSites();

describe('Yaogan classification', () => {
  it('splits every Yaogan name into imaging, signals and unidentified', () => {
    const all = [...names.active.filter(([, n]) => /YAOGAN/.test(n)), ...names.yaoganSatcat.map(([id, n]) => [id, n] as [number, string])];
    assert.ok(all.length > 150);
    for (const [, name] of all) {
      const c = classifyYaogan(name);
      if (/^YAOGAN-\d+ (\d+)?[A-Z]$/.test(name)) assert.equal(c, 'signals', name);
      else if (/OBJECT|DEB/.test(name)) assert.equal(c, 'unidentified', name);
      else assert.equal(c, 'imaging', name);
    }
    assert.equal(classifyYaogan('YAOGAN-32 A'), 'signals');
    assert.equal(classifyYaogan('YAOGAN-43 01J'), 'signals');
    assert.equal(classifyYaogan('YAOGAN-51 OBJECT B'), 'unidentified');
    assert.equal(classifyYaogan('RSS-1 (YAOGAN-1)'), 'imaging');
    assert.equal(classifyYaogan('SENTINEL-2A'), null);
  });

  it('keeps signals and unidentified Yaogan objects out of the imagery lookup', () => {
    for (const [noradId, name] of [...names.active, ...names.yaoganSatcat.map(([id, n]) => [id, n] as [number, string])]) {
      const c = classifyYaogan(name);
      if (c !== 'signals' && c !== 'unidentified') continue;
      assert.equal(matchSensorProfile(noradId, name), null, `${name} matched a sensor profile`);
      assert.equal(imagingProfileFor({ noradId: String(noradId), name }), null, name);
    }
  });

  it('labels signals objects as signals on the layer and drops unidentified ones', () => {
    assert.equal(trackedSatelliteType('YAOGAN-30 02A', 'sar'), 'signals');
    assert.equal(trackedSatelliteType('YAOGAN OBJECT A', 'sar'), null);
    assert.equal(trackedSatelliteType('YAOGAN-35', 'sar'), 'sar');
    assert.equal(trackedSatelliteType('WORLDVIEW-3', 'optical'), 'optical');
  });
});

describe('satellite site coverage', () => {
  it('reads epoch and mean motion from the TLE columns', () => {
    const elements = orbitElementsFromTle(sentinel2a);
    assert.ok(elements);
    assert.equal(elements.epochMs, EPOCH_MS);
    assert.equal(elements.meanMotionRevPerDay, 14.30815);
    assert.equal(elements.noradId, 40697);
    assert.equal(orbitElementsFromTle({ ...sentinel2a, line1: 'garbage' }), null);
  });

  it('lists the watched sites inside the footprint in the next 24 hours, earliest first', async () => {
    const nowMs = EPOCH_MS + 6 * 3_600_000;
    const coverage = await sitesCoveredBySatellite({ tle: sentinel2a, sites, nowMs });
    assert.equal(coverage.status, 'ok');
    if (coverage.status !== 'ok') return;
    assert.equal(coverage.sensor.profileId, matchSensorProfile(40697, 'SENTINEL-2A')!.id);
    assert.equal(coverage.windowEndMs - coverage.windowStartMs, DAY);
    assert.ok(coverage.sites.length > 0, 'a polar imager covers some watched site in a day');
    assert.ok(coverage.sites.length < sites.length);

    const profile = matchSensorProfile(40697, 'SENTINEL-2A')!;
    const elements = orbitElementsFromTle(sentinel2a)!;
    let previous = -Infinity;
    for (const entry of coverage.sites) {
      assert.ok(entry.passes[0]!.timeMs >= previous);
      previous = entry.passes[0]!.timeMs;
      const direct = findPasses({ elements, profile, point: { lat: entry.site.lat, lon: entry.site.lon }, window: { start: nowMs, end: nowMs + DAY }, now: nowMs });
      assert.equal(direct.status, 'ok');
      for (const pass of entry.passes) {
        assert.ok(pass.timeMs >= nowMs && pass.timeMs <= nowMs + DAY);
        const match = direct.passes.find((p) => p.timeMs === pass.timeMs);
        assert.ok(match?.inFootprint && match.coverage, `${entry.site.id} pass is inside the footprint`);
        assert.equal(pass.tier, 'opportunity');
      }
    }
  });

  it('lists no night passes for a daylight-only military imager', async () => {
    const gokturk = tle(41875, 'GOKTURK 1A');
    const profile = imagingProfileFor(gokturk)!;
    assert.equal(profile.category, 'military');
    assert.equal(profile.daylight, true);
    const nowMs = EPOCH_MS;
    const coverage = await sitesCoveredBySatellite({ tle: gokturk, sites, nowMs });
    assert.equal(coverage.status, 'ok');
    if (coverage.status !== 'ok') return;
    const elements = orbitElementsFromTle(gokturk)!;
    const listed = new Map(coverage.sites.map((e) => [e.site.id, new Set(e.passes.map((p) => p.timeMs))]));
    let nightInFootprint = 0;
    for (const site of sites) {
      const direct = findPasses({ elements, profile, point: { lat: site.lat, lon: site.lon }, window: { start: nowMs, end: nowMs + DAY }, now: nowMs });
      if (direct.status !== 'ok') continue;
      for (const pass of direct.passes) {
        if (!pass.inFootprint) continue;
        const night = pass.sunElevationDeg < OPTICAL_MIN_SUN_ELEVATION_DEG;
        if (night) nightInFootprint++;
        assert.equal(listed.get(site.id)?.has(pass.timeMs) ?? false, !night, `${site.id} pass at sun ${pass.sunElevationDeg.toFixed(1)}\u00B0`);
      }
    }
    assert.ok(nightInFootprint > 0, 'the fixture orbit has night passes over watched sites');
    assert.ok(coverage.sites.length > 0, 'and daylight ones');
  });

  it('gives signals and unidentified Yaogan objects no coverage, even with an imaging NORAD id', async () => {
    const yaoganImager = SENSOR_PROFILES.find((p) => p.id === 'yaogan')!.noradIds[0]!;
    const nowMs = EPOCH_MS;
    assert.deepEqual(await sitesCoveredBySatellite({ tle: tle(yaoganImager, 'YAOGAN-30 02A'), sites, nowMs }), { status: 'signals' });
    assert.deepEqual(await sitesCoveredBySatellite({ tle: tle(yaoganImager, 'YAOGAN OBJECT A'), sites, nowMs }), { status: 'excluded' });
    assert.deepEqual(await sitesCoveredBySatellite({ tle: tle(99_990, 'UNKNOWN SAT'), sites, nowMs }), { status: 'no-profile' });
  });

  it('refuses stale orbit elements instead of projecting them', async () => {
    const coverage = await sitesCoveredBySatellite({ tle: sentinel2a, sites, nowMs: EPOCH_MS + 30 * DAY });
    assert.equal(coverage.status, 'too-old');
  });

  it('reports a pass projection that throws as unavailable, not as stale orbit elements', async () => {
    // Elements dated a month after "now" are fresh by age but outside the pass
    // geometry's reach from the epoch, so findPasses() throws a RangeError.
    const coverage = await sitesCoveredBySatellite({ tle: sentinel2a, sites, nowMs: EPOCH_MS - 30 * DAY });
    assert.deepEqual(coverage, { status: 'unavailable' });
  });

  it('lists the satellites covering a site from the same scan as each satellite card', async () => {
    const nowMs = EPOCH_MS + 6 * 3_600_000;
    const tles = [sentinel2a, tle(40698, 'SENTINEL-2B'), tle(99999, 'UNPROFILED SAT')];
    const card = await sitesCoveredBySatellite({ tle: sentinel2a, sites, nowMs });
    assert.equal(card.status, 'ok');
    if (card.status !== 'ok') return;
    const entry = card.sites[0]!;
    const site = sites.find((s) => s.id === entry.site.id)!;

    const covering = await satellitesCoveringSite({ site, tles, nowMs });
    const own = covering.find((s) => s.noradId === '40697');
    assert.deepEqual(own?.passes, entry.passes, 'the site and the satellite card agree on the passes');
    assert.equal(own?.sensor.profileId, card.sensor.profileId);
    assert.ok(!covering.some((s) => s.noradId === '99999'), 'a satellite with no sensor profile covers nothing');
    for (let i = 1; i < covering.length; i++) assert.ok(covering[i]!.passes[0]!.timeMs >= covering[i - 1]!.passes[0]!.timeMs);

    const uncovered = sites.find((s) => !card.sites.some((e) => e.site.id === s.id))!;
    const none = await satellitesCoveringSite({ site: uncovered, tles: [sentinel2a], nowMs });
    assert.deepEqual(none, []);
  });

  it('fails a site whose every imaging scan failed, instead of reporting no coverage', async () => {
    const site = sites[0]!;
    await assert.rejects(satellitesCoveringSite({ site, tles: [sentinel2a], nowMs: EPOCH_MS - 30 * DAY }));
    await assert.rejects(satellitesCoveringSite({ site, tles: [sentinel2a], nowMs: EPOCH_MS + 30 * DAY }));
    assert.deepEqual(await satellitesCoveringSite({ site, tles: [tle(99999, 'UNPROFILED SAT')], nowMs: EPOCH_MS }), []);
  });

  it('reuses every satellite scan when a site is reopened, however many satellites are drawn', async () => {
    const nowMs = EPOCH_MS + 6 * 3_600_000;
    const card = await sitesCoveredBySatellite({ tle: sentinel2a, sites: [...sites], nowMs });
    if (card.status !== 'ok') throw new Error('expected coverage');
    const site = sites.find((s) => s.id === card.sites[0]!.site.id)!;
    const tles = Array.from({ length: 40 }, (_, i) => tle(60_000 + i, 'SENTINEL-2A'));
    const first = await satellitesCoveringSite({ site, tles, nowMs });
    const again = await satellitesCoveringSite({ site, tles, nowMs: nowMs + 60_000 });
    assert.equal(first.length, tles.length);
    assert.equal(again.length, first.length);
    again.forEach((s, i) => assert.equal(s.passes[0], first[i]!.passes[0], 'a reopened site reads the cached scan'));
  });

  it('matches a looked-up point to the watched site in its 0.01° cell, across the antimeridian', () => {
    const site = { id: 'x:1', name: 'One', lat: 10.123, lon: 179.999, countryCode: 'XX' };
    const near = { id: 'x:2', name: 'Two', lat: 10.12, lon: 179.996, countryCode: 'XX' };
    assert.equal(watchedSiteAt({ lat: 10.12, lon: -180 }, [near, site])?.id, 'x:1');
    assert.equal(watchedSiteAt({ lat: 10.12, lon: 179.996 }, [site, near])?.id, 'x:2');
    assert.equal(watchedSiteAt({ lat: 10.13, lon: 179.99 }, [site]), null);
    const real = sites[0]!;
    assert.equal(watchedSiteAt({ lat: Math.round(real.lat * 100) / 100, lon: Math.round(real.lon * 100) / 100 }, sites)?.id, real.id);
    const halfCell = { id: 'x:3', name: 'Half cell', lat: 26.205, lon: 50.615, countryCode: 'XX' };
    assert.equal(watchedSiteAt({ lat: 26.21, lon: 50.62 }, [halfCell])?.id, 'x:3', 'a half-cell rounding still matches');
    for (const s of sites) assert.equal(watchedSiteAt({ lat: Math.round(s.lat * 100) / 100, lon: Math.round(s.lon * 100) / 100 }, [s])?.id, s.id, s.id);
  });
});

describe('#10758 item 5: the coverage cache', () => {
  const MINUTE = 60_000;
  // A copy of the registry is a different cache owner, so it always scans fresh.
  const fresh = (nowMs: number) => sitesCoveredBySatellite({ tle: sentinel2a, sites: [...sites], nowMs });

  // Every scan builds its own site objects and a read only filters passes, so a shared
  // site object proves the answer came from memory rather than from another scan.
  const firstSite = (coverage: Awaited<ReturnType<typeof fresh>>) => {
    assert.equal(coverage.status, 'ok');
    if (coverage.status !== 'ok') throw new Error('unreachable');
    assert.ok(coverage.sites.length > 0, 'the window covers at least one site');
    return coverage.sites[0]!.site;
  };

  it('serves an identical scan from memory, equal to a fresh scan', async () => {
    const owner = [...sites];
    const cached = await sitesCoveredBySatellite({ tle: sentinel2a, sites: owner, nowMs: EPOCH_MS });
    const again = await sitesCoveredBySatellite({ tle: sentinel2a, sites: owner, nowMs: EPOCH_MS });
    assert.equal(firstSite(again), firstSite(cached), 'the second read reuses the first scan');
    assert.deepEqual(again, cached);
    const scanned = await fresh(EPOCH_MS);
    assert.notEqual(firstSite(scanned), firstSite(cached), 'another registry owner scans on its own');
    assert.deepEqual(cached, scanned);
  });

  it('scans again once the element set has grown too old, as a fresh scan does', async () => {
    const owner = [...sites];
    const limitMs = orbitElementsFromTle(sentinel2a)!.epochMs + ORBIT_ELEMENTS_MAX_AGE_DAYS * DAY;
    const inside = await sitesCoveredBySatellite({ tle: sentinel2a, sites: owner, nowMs: limitMs - 30 * MINUTE });
    assert.equal(inside.status, 'ok');
    const past = await sitesCoveredBySatellite({ tle: sentinel2a, sites: owner, nowMs: limitMs + MINUTE });
    assert.equal(past.status, 'too-old');
    assert.deepEqual(past, await fresh(limitMs + MINUTE));
  });

  it('drops passes already behind on read, matching the fresh scan of the same window', async () => {
    await sitesCoveredBySatellite({ tle: sentinel2a, sites, nowMs: EPOCH_MS });
    const readAt = EPOCH_MS + 40 * MINUTE;
    const cached = await sitesCoveredBySatellite({ tle: sentinel2a, sites, nowMs: readAt });
    assert.equal(cached.status, 'ok');
    if (cached.status !== 'ok') return;
    assert.equal(cached.windowStartMs, EPOCH_MS, 'the window has not slid far enough to rescan');
    assert.ok(cached.sites.every((entry) => entry.passes.every((p) => p.timeMs > readAt)));
    assert.deepEqual(cached, coverageAt(await fresh(EPOCH_MS), readAt));
  });

  it('rescans once the window has slid, equal to a fresh scan from then', async () => {
    const owner = [...sites];
    const slid = EPOCH_MS + COVERAGE_RENEW_MS;
    const first = await sitesCoveredBySatellite({ tle: sentinel2a, sites: owner, nowMs: EPOCH_MS });
    const before = await sitesCoveredBySatellite({ tle: sentinel2a, sites: owner, nowMs: slid - 1 });
    assert.equal(before.status === 'ok' && before.windowStartMs, EPOCH_MS, 'just before the slide the first scan still answers');
    assert.equal(firstSite(before), firstSite(first));
    const rescanned = await sitesCoveredBySatellite({ tle: sentinel2a, sites: owner, nowMs: slid });
    assert.equal(rescanned.status === 'ok' && rescanned.windowStartMs, slid);
    assert.notEqual(firstSite(rescanned), firstSite(first), 'the slid window is a new scan');
    assert.deepEqual(rescanned, await fresh(slid));
  });

  it('rescans a new element set for the same satellite', async () => {
    const renewed = { ...sentinel2a, line1: sentinel2a.line1.replace('26317.50000000', '26317.45000000') };
    const before = await sitesCoveredBySatellite({ tle: sentinel2a, sites, nowMs: EPOCH_MS });
    const after = await sitesCoveredBySatellite({ tle: renewed, sites, nowMs: EPOCH_MS });
    assert.deepEqual(after, await sitesCoveredBySatellite({ tle: renewed, sites: [...sites], nowMs: EPOCH_MS }));
    assert.equal(before.status, after.status);
    assert.notDeepEqual(after, before, 'a moved epoch moves the passes');
  });
});

describe('privacy and dark launch', () => {
  it('computes coverage without a network call or analytics', () => {
    for (const file of ['src/services/orbital/satellite-site-coverage.ts', 'src/services/orbital/yaogan-class.ts', 'src/components/orbital-satellite-sites-view.ts', 'src/components/orbital-site-satellites-view.ts']) {
      const text = source(file);
      assert.doesNotMatch(text, /\bfetch\(|XMLHttpRequest|sendBeacon|ServiceClient|getRpcBaseUrl|trackEvent|umami|analytics/i, file);
    }
  });

  it('leaves the satellite layer unchanged while Orbital Watch is dark', () => {
    const globe = source('src/components/GlobeMap.ts');
    assert.match(globe, /const positions = ORBITAL_WATCH_ENABLED \? orbitalLayerSatellites\(input\) : input;/);
    assert.match(globe, /const pinnedCard = ORBITAL_WATCH_ENABLED && d\._kind === 'satellite';/);
    assert.match(globe, /if \(ORBITAL_WATCH_ENABLED\) \{\s*el\.classList\.add\('osat-card'\);/);
    assert.equal(globe.match(/orbital-satellite-sites-view/g)?.length, 1, 'the view loads lazily from one place');
  });
});
