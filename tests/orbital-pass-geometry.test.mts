import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { PASS_WINDOW_MAX_DAYS, findPasses, groundTrack, parseOrbitElements } from '../shared/orbital/pass-geometry.js';
import type { GeoPoint, OmmRecord, OrbitElements, Pass } from '../shared/orbital/pass-geometry.js';
import { isLandOrCoast } from '../shared/orbital/coverage.js';
import { matchSensorProfile } from '../shared/orbital/sensor-profiles.js';
import type { SensorProfile } from '../shared/orbital/sensor-profiles.js';
import { sunElevationDeg } from '../shared/orbital/sun.js';
import { decidePassTier } from '../shared/orbital/tiers.js';

const readFixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/orbital/${name}`, import.meta.url), 'utf8'));
const { records } = readFixture('celestrak-gp-2026-11-13.json') as { records: OmmRecord[] };
const { acquisitions } = readFixture('archive-acquisitions-2026-11.json') as {
  acquisitions: Array<{ point: string; lat: number; lon: number; family: string; platform: string; itemId: string; acquiredAt: string }>;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FIXTURE_NOW = Date.parse('2026-11-13T12:00:00Z');

function satellite(name: string): { elements: OrbitElements; profile: SensorProfile } {
  const omm = records.find((record) => record.OBJECT_NAME === name);
  assert.ok(omm, `fixture has ${name}`);
  const elements = parseOrbitElements(omm);
  const profile = matchSensorProfile(elements.noradId, elements.name);
  assert.ok(profile, `${name} has a sensor profile`);
  return { elements, profile };
}

function passesNear(name: string, point: GeoPoint, centreMs: number, halfWindowMs: number, now = FIXTURE_NOW) {
  const { elements, profile } = satellite(name);
  const result = findPasses({ elements, profile, point, window: { start: centreMs - halfWindowMs, end: centreMs + halfWindowMs }, now });
  return { result, profile, elements };
}

function closestTo(passes: Pass[], timeMs: number): Pass {
  const pass = [...passes].sort((a, b) => Math.abs(a.timeMs - timeMs) - Math.abs(b.timeMs - timeMs))[0];
  assert.ok(pass, 'a pass was found');
  return pass;
}

function destination(from: GeoPoint, bearingDeg: number, distanceKm: number): GeoPoint {
  const R = 6371;
  const rad = Math.PI / 180;
  const d = distanceKm / R;
  const lat1 = from.lat * rad;
  const lon1 = from.lon * rad;
  const b = bearingDeg * rad;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 / rad, lon: ((lon2 / rad + 540) % 360) - 180 };
}

function bearing(from: GeoPoint, to: GeoPoint): number {
  const rad = Math.PI / 180;
  const y = Math.sin((to.lon - from.lon) * rad) * Math.cos(to.lat * rad);
  const x = Math.cos(from.lat * rad) * Math.sin(to.lat * rad) - Math.sin(from.lat * rad) * Math.cos(to.lat * rad) * Math.cos((to.lon - from.lon) * rad);
  return Math.atan2(y, x) / rad;
}

function trackBearingAt(elements: OrbitElements, timeMs: number): { subSatellite: GeoPoint; headingDeg: number } {
  const [segment] = groundTrack(elements, { start: timeMs - 1000, end: timeMs + 1000 }, 1);
  assert.ok(segment && segment.length === 3, 'three track samples one second apart');
  return { subSatellite: segment[1], headingDeg: bearing(segment[0], segment[2]) };
}

describe('pass geometry against published archive acquisitions', () => {
  it('covers at least 20 reference points', () => {
    assert.ok(acquisitions.length >= 20, `${acquisitions.length} reference acquisitions`);
  });

  for (const acquisition of acquisitions) {
    it(`${acquisition.platform} over ${acquisition.point} lands within 60 s of the archived acquisition`, () => {
      const acquiredMs = Date.parse(acquisition.acquiredAt);
      const { result, profile } = passesNear(acquisition.platform.toUpperCase(), acquisition, acquiredMs, 6 * HOUR);
      assert.equal(result.status, 'ok');
      const pass = closestTo(result.passes, acquiredMs);
      assert.ok(Math.abs(pass.timeMs - acquiredMs) <= 60_000, `pass ${pass.time} vs archive ${acquisition.acquiredAt}`);
      assert.equal(pass.inFootprint, true, 'the archived point is inside the modelled footprint');
      assert.equal(decidePassTier(pass, profile, { status: 'match', itemId: acquisition.itemId }, FIXTURE_NOW).kind, 'confirmed-image');
      assert.equal(decidePassTier(pass, profile, { status: 'unanswered' }, FIXTURE_NOW).kind, 'likely-imaged');
    });
  }
});

describe('pass geometry rules', () => {
  const paris = acquisitions.find((a) => a.point === 'paris' && a.family === 'sentinel-2')!;
  const berlin = acquisitions.find((a) => a.point === 'berlin' && a.family === 'sentinel-1')!;

  it('returns a single Sentinel-2 morning pass over Paris within 60 s of the archive', () => {
    const acquiredMs = Date.parse(paris.acquiredAt);
    const { result } = passesNear('SENTINEL-2B', paris, acquiredMs, 30 * 60_000);
    const imaging = result.passes.filter((pass) => pass.inFootprint);
    assert.equal(imaging.length, 1);
    assert.ok(Math.abs(imaging[0].timeMs - acquiredMs) <= 60_000);
    assert.ok(imaging[0].sunElevationDeg >= 5, 'daylight at the morning pass');
  });

  it('keeps a closest approach just inside either end of the window, and invents none at the edge', () => {
    const acquiredMs = Date.parse(paris.acquiredAt);
    const { elements, profile } = satellite('SENTINEL-2B');
    const search = (start: number, end: number) =>
      findPasses({ elements, profile, point: paris, window: { start, end }, now: FIXTURE_NOW }).passes;
    const [pass] = search(acquiredMs - 30 * 60_000, acquiredMs + 30 * 60_000).filter((p) => p.inFootprint);
    assert.ok(pass, 'reference pass');
    assert.equal(search(pass.timeMs - 30 * 60_000, pass.timeMs + 3_000).filter((p) => p.inFootprint).length, 1, 'approach 3 s before the end');
    assert.equal(search(pass.timeMs - 3_000, pass.timeMs + 30 * 60_000).filter((p) => p.inFootprint).length, 1, 'approach 3 s after the start');
    assert.deepEqual(search(pass.timeMs + 90_000, pass.timeMs + 30 * 60_000), [], 'no pass at a start that follows the approach');
    assert.deepEqual(search(pass.timeMs - 30 * 60_000, pass.timeMs - 90_000), [], 'no pass at an end that precedes the approach');
  });

  it('skips states SGP4 cannot propagate instead of throwing', () => {
    const omm = records.find((record) => record.OBJECT_NAME === 'SENTINEL-2B')!;
    const elements = parseOrbitElements({ ...omm, MEAN_MOTION: 17.5 });
    const { profile } = satellite('SENTINEL-2B');
    const epochMs = elements.epochMs;
    const result = findPasses({ elements, profile, point: paris, window: { start: epochMs, end: epochMs + DAY }, now: epochMs });
    assert.deepEqual(result.passes, []);
    assert.deepEqual(groundTrack(elements, { start: epochMs, end: epochMs + HOUR }), []);
  });

  it('rejects a window that is unbounded, outside the Date range, reversed or longer than the search limit', () => {
    const { elements, profile } = satellite('SENTINEL-2B');
    const search = (start: number, end: number) => () => findPasses({ elements, profile, point: paris, window: { start, end }, now: FIXTURE_NOW });
    assert.throws(search(FIXTURE_NOW, Infinity), RangeError);
    assert.throws(search(FIXTURE_NOW, Number.NaN), RangeError);
    assert.throws(search(2 ** 68, 2 ** 68 + HOUR), RangeError);
    assert.doesNotThrow(search(8.64e15 - HOUR, 8.64e15));
    assert.throws(search(FIXTURE_NOW, FIXTURE_NOW - HOUR), RangeError);
    assert.throws(search(FIXTURE_NOW - 7 * DAY, FIXTURE_NOW + 365 * DAY), RangeError);
    assert.doesNotThrow(search(FIXTURE_NOW - 7 * DAY, FIXTURE_NOW - 7 * DAY + PASS_WINDOW_MAX_DAYS * DAY));
    assert.throws(() => groundTrack(elements, { start: FIXTURE_NOW, end: Infinity }), RangeError);
    assert.throws(() => groundTrack(elements, { start: 2 ** 68, end: 2 ** 68 + HOUR }), RangeError);
    assert.throws(() => groundTrack(elements, { start: FIXTURE_NOW, end: FIXTURE_NOW + HOUR }, 0), RangeError);
  });

  it('gives Sentinel-1 no likely-imaged pass on the side it does not look', () => {
    const acquiredMs = Date.parse(berlin.acquiredAt);
    const imaged = closestTo(passesNear('SENTINEL-1C', berlin, acquiredMs, 30 * 60_000).result.passes, acquiredMs);
    const { subSatellite, headingDeg } = trackBearingAt(satellite('SENTINEL-1C').elements, imaged.timeMs);
    const mirrored = destination(subSatellite, headingDeg - 90, imaged.groundDistanceKm);
    const { result, profile } = passesNear('SENTINEL-1C', mirrored, acquiredMs, 30 * 60_000);
    const pass = closestTo(result.passes, acquiredMs);
    assert.equal(pass.side, 'left');
    assert.equal(pass.inFootprint, false);
    assert.notEqual(decidePassTier(pass, profile, { status: 'unanswered' }, FIXTURE_NOW).kind, 'likely-imaged');
  });

  it('gives Sentinel-1 no likely-imaged pass inside the swath width but outside the incidence band', () => {
    const acquiredMs = Date.parse(berlin.acquiredAt);
    const imaged = closestTo(passesNear('SENTINEL-1C', berlin, acquiredMs, 30 * 60_000).result.passes, acquiredMs);
    const { subSatellite, headingDeg } = trackBearingAt(satellite('SENTINEL-1C').elements, imaged.timeMs);
    const nearNadir = destination(subSatellite, headingDeg + 90, 100);
    const { result, profile } = passesNear('SENTINEL-1C', nearNadir, acquiredMs, 30 * 60_000);
    const pass = closestTo(result.passes, acquiredMs);
    assert.equal(pass.side, 'right');
    assert.ok(pass.incidenceDeg < 29.1, `incidence ${pass.incidenceDeg.toFixed(1)} is below the band`);
    assert.equal(pass.inFootprint, false);
    assert.notEqual(decidePassTier(pass, profile, { status: 'unanswered' }, FIXTURE_NOW).kind, 'likely-imaged');
  });

  it('excludes an open-ocean point from Sentinel-2 coverage', () => {
    const midAtlantic = { lat: 30, lon: -40 };
    const { result, profile } = passesNear('SENTINEL-2A', midAtlantic, FIXTURE_NOW - 3 * DAY, 3 * DAY);
    const overhead = result.passes.filter((pass) => pass.inFootprint);
    assert.ok(overhead.length > 0, 'Sentinel-2A flies over the point');
    for (const pass of overhead) {
      assert.equal(pass.coverage, false);
      assert.equal(decidePassTier(pass, profile, { status: 'unanswered' }, FIXTURE_NOW).kind, 'passed-overhead');
    }
  });

  it('labels a military pass capability overhead with and without an archive match', () => {
    const { result, profile } = passesNear('YAOGAN-50 03', { lat: 25.03, lon: 121.56 }, FIXTURE_NOW - 2 * DAY, 2 * DAY);
    const pass = result.passes.find((candidate) => candidate.inFootprint);
    assert.ok(pass, 'a Yaogan pass within assumed reach');
    assert.deepEqual(decidePassTier(pass, profile, { status: 'match', itemId: 'public-scene' }, FIXTURE_NOW), { kind: 'capability-overhead' });
    assert.deepEqual(decidePassTier(pass, profile, { status: 'no-match' }, FIXTURE_NOW), { kind: 'capability-overhead' });
    assert.deepEqual(decidePassTier(pass, profile, null, FIXTURE_NOW), { kind: 'capability-overhead' });
  });

  it('does not call an optical pass likely imaged when the sun is below 5 degrees', () => {
    const tromso = { lat: 69.65, lon: 18.96 };
    const { result, profile } = passesNear('SENTINEL-2A', tromso, FIXTURE_NOW - 3 * DAY, 3 * DAY);
    const pass = result.passes.find((candidate) => candidate.inFootprint);
    assert.ok(pass, 'Sentinel-2A flies over Tromso');
    assert.ok(pass.sunElevationDeg < 5, `sun at ${pass.sunElevationDeg.toFixed(1)} degrees`);
    assert.equal(decidePassTier(pass, profile, { status: 'unanswered' }, FIXTURE_NOW).kind, 'passed-overhead');
    const atThreeDegrees = { ...pass, sunElevationDeg: 3 };
    assert.equal(decidePassTier(atThreeDegrees, profile, { status: 'unanswered' }, FIXTURE_NOW).kind, 'passed-overhead');
  });

  it('handles 89 degrees north without errors or duplicate passes inside 60 s', () => {
    for (const name of ['SENTINEL-2A', 'SENTINEL-1C', 'ISS (ZARYA)', 'LANDSAT 9']) {
      const { result } = passesNear(name, { lat: 89, lon: 45 }, FIXTURE_NOW - DAY, DAY);
      assert.equal(result.status, 'ok');
      const times = result.passes.map((pass) => pass.timeMs).sort((a, b) => a - b);
      times.slice(1).forEach((time, index) => assert.ok(time - times[index] >= 60_000, `${name} passes 60 s apart`));
    }
  });

  it('returns too-old with no passes when the elements are stale', () => {
    const { elements, profile } = satellite('SENTINEL-2A');
    const now = elements.epochMs + 8 * DAY;
    const result = findPasses({ elements, profile, point: paris, window: { start: now - DAY, end: now }, now });
    assert.equal(result.status, 'too-old');
    assert.deepEqual(result.passes, []);
  });

  it('splits an antimeridian-crossing ground track into continuous segments', () => {
    const { elements } = satellite('SENTINEL-2A');
    const segments = groundTrack(elements, { start: FIXTURE_NOW, end: FIXTURE_NOW + 3 * HOUR }, 30);
    assert.ok(segments.length > 1, 'the track crosses the antimeridian');
    assert.equal(segments.flat().length, 3 * 120 + 1);
    for (const segment of segments) {
      segment.slice(1).forEach((point, index) => assert.ok(Math.abs(point.lon - segment[index].lon) < 180, 'no jump across the map'));
    }
  });

  it('flags every pass in a future window as an opportunity', () => {
    const { result, profile } = passesNear('SENTINEL-2C', paris, FIXTURE_NOW + 36 * HOUR, 36 * HOUR);
    assert.ok(result.passes.length > 0);
    for (const pass of result.passes) {
      assert.equal(pass.opportunity, true);
      assert.deepEqual(decidePassTier(pass, profile, { status: 'match', itemId: 'x' }, FIXTURE_NOW), { kind: 'opportunity' });
    }
  });

  it('notes "not in archive" once the archive answered with no match after the publication delay', () => {
    const acquiredMs = Date.parse(paris.acquiredAt);
    const { result, profile } = passesNear('SENTINEL-2B', paris, acquiredMs, 30 * 60_000);
    const pass = closestTo(result.passes, acquiredMs);
    const beforeDelay = pass.timeMs + (profile.archiveWaitHours! - 1) * HOUR;
    const afterDelay = pass.timeMs + (profile.archiveWaitHours! + 1) * HOUR;
    assert.deepEqual(decidePassTier(pass, profile, { status: 'no-match' }, beforeDelay), { kind: 'likely-imaged' });
    assert.deepEqual(decidePassTier(pass, profile, { status: 'no-match' }, afterDelay), { kind: 'passed-overhead', note: 'not-in-archive' });
  });

  it('marks a point 3 km inside the footprint edge, and not one 20 km inside', () => {
    const acquiredMs = Date.parse(paris.acquiredAt);
    const imaged = closestTo(passesNear('SENTINEL-2B', paris, acquiredMs, 30 * 60_000).result.passes, acquiredMs);
    const { elements } = satellite('SENTINEL-2B');
    const { subSatellite, headingDeg } = trackBearingAt(elements, imaged.timeMs);
    const halfSwathKm = 290 / 2;
    for (const [insideKm, expected] of [[3, true], [20, false]] as const) {
      const point = destination(subSatellite, headingDeg + 90, halfSwathKm - insideKm);
      const pass = closestTo(passesNear('SENTINEL-2B', point, acquiredMs, 30 * 60_000).result.passes, imaged.timeMs);
      assert.equal(pass.inFootprint, true);
      assert.equal(pass.edgeOfSwath, expected, `${insideKm} km inside the edge`);
    }
  });
});

describe('every profiled family has a working fixture', () => {
  const lowOrbit: Array<[string, GeoPoint, string]> = [
    ['SENTINEL-2A', { lat: 48.85, lon: 2.35 }, 'likely-imaged'],
    ['SENTINEL-1C', { lat: 52.52, lon: 13.4 }, 'likely-imaged'],
    ['LANDSAT 9', { lat: 39.74, lon: -104.99 }, 'likely-imaged'],
    ['TERRA', { lat: -1.29, lon: 36.82 }, 'daily-mosaic'],
    ['CAPELLA-14 (ACADIA-4)', { lat: 35.68, lon: 139.69 }, 'within-reach'],
    ['YAOGAN-50 03', { lat: 25.03, lon: 121.56 }, 'capability-overhead'],
    ['ISS (ZARYA)', { lat: 40.71, lon: -74.0 }, 'passed-overhead'],
  ];
  for (const [name, point, tier] of lowOrbit) {
    it(`${name} produces at least one pass tiered ${tier}`, () => {
      const { result, profile } = passesNear(name, point, FIXTURE_NOW - 3.5 * DAY, 3.5 * DAY);
      assert.equal(result.status, 'ok');
      const tiers = result.passes.filter((pass) => pass.inFootprint).map((pass) => decidePassTier(pass, profile, { status: 'unanswered' }, FIXTURE_NOW).kind);
      assert.ok(tiers.includes(tier as never), `${name} tiers: ${tiers.join(', ')}`);
    });
  }

  const geostationary: Array<[string, GeoPoint]> = [
    ['GOES 19', { lat: 0, lon: -75 }],
    ['GOES 18', { lat: 21.3, lon: -157.86 }],
    ['HIMAWARI-9', { lat: 35.68, lon: 139.69 }],
    ['METEOSAT-12 (MTG-I1)', { lat: 48.85, lon: 2.35 }],
  ];
  for (const [name, point] of geostationary) {
    it(`${name} returns a visibility record, not imaging passes`, () => {
      const { result } = passesNear(name, point, FIXTURE_NOW, DAY);
      assert.equal(result.status, 'geostationary');
      assert.deepEqual(result.passes, []);
      if (result.status === 'geostationary') assert.equal(result.visibility.visible, true);
    });
  }

  it('reports a geostationary satellite on the far side of the Earth as not visible', () => {
    const { result } = passesNear('HIMAWARI-9', { lat: 0, lon: -40 }, FIXTURE_NOW, DAY);
    assert.equal(result.status === 'geostationary' && result.visibility.visible, false);
  });
});

describe('sun elevation', () => {
  it('matches the solar geometry at known instants', () => {
    assert.ok(sunElevationDeg(new Date('2026-03-20T12:07:00Z'), 0, 0) > 88, 'equinox noon at the equator');
    const parisNoon = sunElevationDeg(new Date('2026-11-13T11:45:00Z'), 48.85, 2.35);
    assert.ok(Math.abs(parisNoon - 23.1) < 1, `Paris November noon ${parisNoon.toFixed(1)}`);
    assert.ok(sunElevationDeg(new Date('2026-11-13T23:45:00Z'), 48.85, 2.35) < -50, 'Paris midnight');
  });
});

describe('land and coast coverage', () => {
  it('counts land and near-shore water, not open ocean', () => {
    assert.equal(isLandOrCoast(48.85, 2.35), true);
    assert.equal(isLandOrCoast(35.9, 14.4), true, 'Malta');
    assert.equal(isLandOrCoast(-17.7, 178.0), true, 'Fiji near the antimeridian');
    assert.equal(isLandOrCoast(30, -40), false, 'mid-Atlantic');
    assert.equal(isLandOrCoast(71.125, 0), false, 'Norwegian Sea');
    assert.equal(isLandOrCoast(75, 0), false, 'Greenland Sea');
    assert.equal(isLandOrCoast(72, -5), false, 'Greenland Sea west of Jan Mayen');
    assert.equal(isLandOrCoast(85, 0), false, 'Arctic Ocean');
    assert.equal(isLandOrCoast(-30, -140), false, 'South Pacific');
    assert.equal(isLandOrCoast(60, 100), true, 'central Siberia');
    assert.equal(isLandOrCoast(68, -178), true, 'Chukotka east of the antimeridian');
    assert.equal(isLandOrCoast(67, 179), true, 'Chukotka west of the antimeridian');
    assert.equal(isLandOrCoast(-18.2, -178.8), true, 'Lakeba, Fiji, east of the antimeridian');
    assert.equal(isLandOrCoast(-80, 0), true, 'Antarctic plateau');
    assert.equal(isLandOrCoast(-75, -100), true, 'West Antarctica');
    assert.equal(isLandOrCoast(-89.9, 10), true, 'South Pole');
    assert.doesNotThrow(() => isLandOrCoast(90, 180));
    assert.doesNotThrow(() => isLandOrCoast(-90, -180));
  });

  it('leaves open water in every row north of the Southern Ocean', () => {
    for (let lat = 89.875; lat > -60; lat -= 0.25) {
      let land = 0;
      for (let lon = -179.875; lon < 180; lon += 0.25) if (isLandOrCoast(lat, lon)) land++;
      assert.ok(land / 1440 < 0.9, `row at ${lat} is ${((100 * land) / 1440).toFixed(1)}% land`);
    }
  });

  it('is reproducible from the committed Natural Earth source', () => {
    const run = spawnSync(process.execPath, ['scripts/generate-orbital-land-coast-mask.mjs', '--check'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  });
});
