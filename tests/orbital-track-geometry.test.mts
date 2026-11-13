import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { findPasses, parseOrbitElements } from '../shared/orbital/pass-geometry.js';
import type { GeoPoint, OmmRecord, OrbitElements, Pass } from '../shared/orbital/pass-geometry.js';
import { matchSensorProfile } from '../shared/orbital/sensor-profiles.js';
import type { SensorProfile } from '../shared/orbital/sensor-profiles.js';
import { buildPassTrack, trackPositionAt, type FootprintRing, type PassTrack } from '../src/services/orbital/track-geometry.ts';
import { createTrackReplay } from '../src/services/orbital/track-replay.ts';

const { records } = JSON.parse(readFileSync(new URL('./fixtures/orbital/celestrak-gp-2026-11-13.json', import.meta.url), 'utf8')) as { records: OmmRecord[] };

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-13T12:00:00Z');

function satellite(name: string): { elements: OrbitElements; profile: SensorProfile } {
  const omm = records.find((record) => record.OBJECT_NAME === name);
  assert.ok(omm, `fixture has ${name}`);
  const elements = parseOrbitElements(omm);
  const profile = matchSensorProfile(elements.noradId, elements.name);
  assert.ok(profile, `${name} has a sensor profile`);
  return { elements, profile };
}

function passes(name: string, point: GeoPoint, hours = 72): { elements: OrbitElements; profile: SensorProfile; passes: Pass[] } {
  const { elements, profile } = satellite(name);
  const result = findPasses({ elements, profile, point, window: { start: NOW - hours * HOUR, end: NOW }, now: NOW });
  assert.ok(result.passes.length > 0, `${name} passes over ${point.lat}, ${point.lon}`);
  return { elements, profile, passes: result.passes };
}

const lons = (track: PassTrack) => track.segments.flat().map((p) => p.lon);

function insideRing(ring: FootprintRing, { lat, lon }: GeoPoint): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const signedArea = (ring: FootprintRing) => ring.slice(1).reduce((sum, [x, y], i) => sum + ring[i]![0] * y - x * ring[i]![1], 0);

describe('pass ground track', () => {
  it('splits a track over the antimeridian into segments that meet on it, with no line across the map', () => {
    const { elements, profile, passes: found } = passes('SENTINEL-2A', { lat: -17.7, lon: 178.5 });
    const crossing = found
      .map((pass) => buildPassTrack(elements, profile.footprint, pass))
      .find((track) => track !== null && track.segments.length > 1);
    assert.ok(crossing, 'a Fiji pass crosses the antimeridian');
    assert.equal(crossing.segments.length, 2);
    for (const segment of crossing.segments) {
      for (let i = 1; i < segment.length; i += 1) assert.ok(Math.abs(segment[i]!.lon - segment[i - 1]!.lon) < 10, 'no jump inside a segment');
    }
    const [west, east] = crossing.segments as [PassTrack['segments'][0], PassTrack['segments'][0]];
    const end = west[west.length - 1]!;
    const start = east[0]!;
    assert.equal(Math.abs(end.lon), 180);
    assert.equal(start.lon, -end.lon);
    assert.equal(start.lat, end.lat);
    assert.equal(start.timeMs, end.timeMs);
    for (const ring of crossing.footprint) {
      for (const [lon] of ring) assert.ok(lon >= -180 && lon <= 180, `footprint longitude ${lon} stays on the map`);
    }
  });

  it('keeps every position inside the map range and spans the replay window', () => {
    const { elements, profile, passes: found } = passes('LANDSAT 9', { lat: 48.85, lon: 2.35 });
    const pass = found[0]!;
    const track = buildPassTrack(elements, profile.footprint, pass);
    assert.ok(track);
    assert.equal(track.key, `${pass.noradId}:${pass.timeMs}`);
    assert.ok(lons(track).every((lon) => lon >= -180 && lon <= 180));
    assert.equal(track.startMs, pass.timeMs - 12 * 60_000);
    assert.equal(track.endMs, pass.timeMs + 12 * 60_000);
    assert.deepEqual(track.closest, { lon: pass.subSatellite.lon, lat: pass.subSatellite.lat, timeMs: pass.timeMs });
  });

  it('draws a nadir swath around the ground track and closes each ring counter-clockwise', () => {
    const { elements, profile, passes: found } = passes('SENTINEL-2B', { lat: 48.85, lon: 2.35 });
    const track = buildPassTrack(elements, profile.footprint, found[0]!);
    assert.ok(track);
    assert.equal(track.footprint.length, 1);
    const ring = track.footprint[0]!;
    assert.deepEqual(ring[0], ring[ring.length - 1], 'ring is closed');
    assert.ok(signedArea(ring) > 0, 'ring winds counter-clockwise');
    assert.ok(insideRing(ring, track.closest), 'the sub-satellite point sits inside the swath');
  });

  it('draws a side-looking radar footprint off the ground track, on the look side only', () => {
    const { elements, profile, passes: found } = passes('SENTINEL-1C', { lat: 48.85, lon: 2.35 });
    assert.equal(profile.footprint.kind, 'side-looking');
    const track = buildPassTrack(elements, profile.footprint, found[0]!);
    assert.ok(track);
    assert.equal(track.footprint.length, 1);
    assert.equal(insideRing(track.footprint[0]!, track.closest), false, 'the nadir point is outside the radar swath');
  });

  it('never joins a polar footprint across the map', () => {
    const { elements, profile, passes: found } = passes('TERRA', { lat: 84, lon: 30 });
    for (const pass of found) {
      const track = buildPassTrack(elements, profile.footprint, pass);
      assert.ok(track);
      for (const ring of track.footprint) {
        for (let i = 1; i < ring.length; i += 1) {
          assert.ok(Math.abs(ring[i]![0] - ring[i - 1]![0]) <= 180, 'no ring edge jumps across the map');
        }
        const span = Math.max(...ring.map(([lon]) => lon)) - Math.min(...ring.map(([lon]) => lon));
        assert.ok(span < 360, 'a ring never wraps the whole map');
      }
    }
  });

  it('returns no track, and throws nothing, when the orbit gives no positions for the pass', () => {
    const { elements, profile, passes: found } = passes('SENTINEL-2C', { lat: 48.85, lon: 2.35 });
    assert.equal(buildPassTrack(elements, profile.footprint, { ...found[0]!, timeMs: Number.NaN }), null);
    assert.equal(buildPassTrack(elements, profile.footprint, found[0]!, { trackHalfMinutes: 0 }), null);
  });

  it('places the replay position on the track and holds it at the ends', () => {
    const { elements, profile, passes: found } = passes('SENTINEL-2A', { lat: 25.2, lon: 55.27 });
    const track = buildPassTrack(elements, profile.footprint, found[0]!);
    assert.ok(track);
    const atClosest = trackPositionAt(track, track.closest.timeMs);
    assert.ok(Math.abs(atClosest.lat - track.closest.lat) < 0.2 && Math.abs(atClosest.lon - track.closest.lon) < 0.2);
    assert.deepEqual(trackPositionAt(track, track.startMs - HOUR), track.segments[0]![0]);
    const last = track.segments[track.segments.length - 1]!;
    assert.deepEqual(trackPositionAt(track, track.endMs + HOUR), last[last.length - 1]);
  });
});

describe('pass replay', () => {
  const track = (() => {
    const { elements, profile, passes: found } = passes('SENTINEL-2A', { lat: 25.2, lon: 55.27 });
    return buildPassTrack(elements, profile.footprint, found[0]!)!;
  })();

  function frames() {
    const queue = new Map<number, (now: number) => void>();
    let next = 1;
    return {
      requestFrame: (callback: (now: number) => void) => { queue.set(next, callback); return next++; },
      cancelFrame: (handle: number) => { queue.delete(handle); },
      run(now: number) {
        const pending = [...queue.values()];
        queue.clear();
        for (const callback of pending) callback(now);
      },
      get pending() { return queue.size; },
    };
  }

  it('places the marker at closest approach without animating when motion is reduced', () => {
    const clock = frames();
    const positions: unknown[] = [];
    createTrackReplay(track, (point) => positions.push(point), { ...clock, prefersReducedMotion: () => true }).play();
    assert.deepEqual(positions, [track.closest]);
    assert.equal(clock.pending, 0, 'no animation frame was requested');
  });

  it('flies the marker from the start of the track and settles at closest approach', () => {
    const clock = frames();
    const positions: Array<{ timeMs: number }> = [];
    createTrackReplay(track, (point) => positions.push(point), { ...clock, prefersReducedMotion: () => false, durationMs: 1000 }).play();
    clock.run(0);
    clock.run(500);
    clock.run(1000);
    assert.equal(positions[0]!.timeMs, track.startMs);
    assert.equal(positions[1]!.timeMs, (track.startMs + track.endMs) / 2);
    assert.deepEqual(positions[2], track.closest);
    assert.equal(clock.pending, 0);
  });

  it('stops moving the marker once stopped', () => {
    const clock = frames();
    const positions: unknown[] = [];
    const replay = createTrackReplay(track, (point) => positions.push(point), { ...clock, prefersReducedMotion: () => false });
    replay.play();
    clock.run(0);
    replay.stop();
    clock.run(100);
    assert.equal(positions.length, 1);
    assert.equal(clock.pending, 0);
  });
});
