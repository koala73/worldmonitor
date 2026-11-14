import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { findPasses } from '../shared/orbital/pass-geometry.js';
import { SENSOR_PROFILES, matchSensorProfile } from '../shared/orbital/sensor-profiles.js';
import { composeWatchedSites } from '../shared/watched-sites.ts';
import {
  imagingProfileFor,
  orbitElementsFromTle,
  satellitesCoveringSite,
  sitesCoveredBySatellite,
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

  it('answers the reverse question for one site from the same passes', async () => {
    const nowMs = EPOCH_MS + 6 * 3_600_000;
    const coverage = await sitesCoveredBySatellite({ tle: sentinel2a, sites, nowMs });
    assert.equal(coverage.status, 'ok');
    if (coverage.status !== 'ok') return;
    const first = coverage.sites[0]!;
    const over = await satellitesCoveringSite({ site: first.site, tles: [sentinel2a, tle(99_990, 'UNKNOWN SAT'), tle(40697, 'YAOGAN-30 02A')], nowMs });
    assert.deepEqual(over.map((s) => s.noradId), ['40697']);
    assert.deepEqual(over[0]!.passes, first.passes);
  });
});

describe('privacy and dark launch', () => {
  it('computes coverage without a network call or analytics', () => {
    for (const file of ['src/services/orbital/satellite-site-coverage.ts', 'src/services/orbital/yaogan-class.ts', 'src/components/orbital-satellite-sites-view.ts']) {
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
