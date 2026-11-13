import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { findPasses, parseOrbitElements } from '../shared/orbital/pass-geometry.js';
import type { GeoPoint, OmmRecord, OrbitElements, Pass } from '../shared/orbital/pass-geometry.js';
import { matchSensorProfile } from '../shared/orbital/sensor-profiles.js';
import type { SensorProfile } from '../shared/orbital/sensor-profiles.js';
import { buildPassTrack, continuousTrack, framingBounds, pointNear, sweptSwath, trackPositionAt, type FootprintRing, type PassTrack } from '../src/services/orbital/track-geometry.ts';
import { createTrackReplay, replayWindow, type ReplayFrame } from '../src/services/orbital/track-replay.ts';

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

  it('sweeps the swath along the pass, with its leading edge across the track at the replay moment', () => {
    const { elements, profile, passes: found } = passes('SENTINEL-2B', { lat: 25.112, lon: 55.139 });
    const track = buildPassTrack(elements, profile.footprint, found[0]!);
    assert.ok(track);
    const [side] = track.swath;
    assert.ok(side);
    assert.deepEqual(sweptSwath(track, side.timesMs[0]! - 1), { rings: [], leadingEdge: [] });
    const half = sweptSwath(track, track.closest.timeMs);
    assert.equal(half.leadingEdge.length, 1);
    const [inner, outer] = half.leadingEdge[0]! as [[number, number], [number, number]];
    const mid = { lon: (inner[0] + outer[0]) / 2, lat: (inner[1] + outer[1]) / 2 };
    assert.ok(Math.hypot(mid.lon - track.closest.lon, mid.lat - track.closest.lat) < 0.2, 'a nadir swath edge is centred on the satellite');
    const area = (rings: FootprintRing[]) => rings.reduce((sum, ring) => sum + Math.abs(signedArea(ring)), 0);
    const whole = sweptSwath(track, side.timesMs[side.timesMs.length - 1]! + 1);
    assert.ok(area(half.rings) > 0.3 * area(whole.rings) && area(half.rings) < 0.7 * area(whole.rings), 'half the pass sweeps about half the swath');
    assert.ok(Math.abs(area(whole.rings) - area(track.footprint)) < 1e-6, 'the whole pass sweeps the whole footprint');
  });

  it('puts a right-looking radar leading edge off the track to the right of travel', () => {
    const { elements, profile, passes: found } = passes('SENTINEL-1C', { lat: 25.112, lon: 55.139 }, 240);
    const track = buildPassTrack(elements, profile.footprint, found[0]!);
    assert.ok(track);
    const { leadingEdge } = sweptSwath(track, track.closest.timeMs);
    assert.equal(leadingEdge.length, 1);
    const before = trackPositionAt(track, track.closest.timeMs - 20_000);
    const heading = [track.closest.lon - before.lon, track.closest.lat - before.lat];
    for (const [lon, lat] of leadingEdge[0]!) {
      const offset = [lon - track.closest.lon, lat - track.closest.lat];
      assert.ok(heading[0]! * offset[1]! - heading[1]! * offset[0]! < 0, 'every edge point lies right of the direction of travel');
    }
  });

  it('frames a right-looking radar swath together with the looked-up point', () => {
    const point = { lat: 25.112, lon: 55.139 };
    const { elements, profile, passes: found } = passes('SENTINEL-1C', point, 240);
    const track = found
      .map((pass) => buildPassTrack(elements, profile.footprint, pass))
      .find((candidate) => candidate?.footprint.some((ring) => insideRing(ring, point)));
    assert.ok(track, 'a Sentinel-1C swath covers the point');
    const [[west, south], [east, north]] = framingBounds(track, point);
    const inside = (lon: number, lat: number) => lon >= west && lon <= east && lat >= south && lat <= north;
    assert.ok(inside(point.lon, point.lat) && inside(track.closest.lon, track.closest.lat));
    for (const [lon, lat] of sweptSwath(track, track.closest.timeMs).leadingEdge.flat()) assert.ok(inside(lon, lat));
    assert.ok(east - west < 15 && north - south < 15, `close enough to see the swath beside the track: ${east - west} x ${north - south}`);
  });

  it('frames a pass over the antimeridian without spanning the whole map', () => {
    const point = { lat: -17.7, lon: 178.5 };
    const { elements, profile, passes: found } = passes('SENTINEL-2A', point);
    for (const pass of found) {
      const track = buildPassTrack(elements, profile.footprint, pass)!;
      const [[west], [east]] = framingBounds(track, point);
      assert.ok(east - west < 60, 'the box, centred on the point, stays local to it');
    }
  });

  it('centres the frame on the point, past 180 when the point sits by the antimeridian', () => {
    const point = { lat: -16.85, lon: 179.95 };
    const { elements, profile, passes: found } = passes('SENTINEL-2A', point);
    for (const pass of found) {
      const [[west, south], [east, north]] = framingBounds(buildPassTrack(elements, profile.footprint, pass)!, point);
      assert.ok(Math.abs((west + east) / 2 - point.lon) < 1e-9 && Math.abs((south + north) / 2 - point.lat) < 1e-9, 'the point is the centre');
      assert.ok(east > 180, 'the far side of 180 is framed');
    }
  });

  it('draws a pass across the antimeridian as whole shapes, continuous past 180 near the point', () => {
    const point = { lat: -17.7, lon: 178.5 };
    const { elements, profile, passes: found } = passes('SENTINEL-2A', point);
    const crossing = found.map((pass) => buildPassTrack(elements, profile.footprint, pass)).find((track) => track !== null && track.footprint.length > 1);
    assert.ok(crossing, 'a Fiji footprint is split at the antimeridian');
    const { path, footprint } = continuousTrack(crossing, point.lon);
    for (let i = 1; i < path.length; i += 1) assert.ok(Math.abs(path[i]![0] - path[i - 1]![0]) < 5, 'the track never jumps across the map');
    assert.equal(footprint.length, crossing.swath.length, 'one whole ring per band, not cut at 180');
    assert.ok(footprint.flat().some(([lon]) => lon > 180), 'the band runs on past 180');
    for (const time of crossing.swath[0]!.timesMs.slice(1)) {
      const { rings, leadingEdge } = sweptSwath(crossing, time, point.lon);
      assert.equal(rings.length, 1);
      for (const [lon] of [...rings.flat(), ...leadingEdge.flat()]) assert.ok(Math.abs(lon - point.lon) < 20, 'swept shapes stay beside the point');
    }
    assert.ok(Math.abs(pointNear({ lon: -179.5, lat: 0 }, 179.9).lon - 180.5) < 1e-9);
  });

  it('keeps the swept swath and its leading edge inside the map across the antimeridian', () => {
    const { elements, profile, passes: found } = passes('SENTINEL-2A', { lat: -17.7, lon: 178.5 });
    const crossing = found
      .map((pass) => buildPassTrack(elements, profile.footprint, pass))
      .find((track) => track !== null && track.footprint.length > 1);
    assert.ok(crossing, 'a Fiji footprint is split at the antimeridian');
    const times = crossing.swath[0]!.timesMs;
    for (const time of times) {
      const { rings, leadingEdge } = sweptSwath(crossing, time + 1);
      for (const [lon] of [...rings.flat(), ...leadingEdge.flat()]) assert.ok(lon >= -180 && lon <= 180);
      for (const line of leadingEdge) {
        for (let i = 1; i < line.length; i += 1) assert.ok(Math.abs(line[i]![0] - line[i - 1]![0]) <= 180, 'no edge jumps across the map');
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

  it('places the marker at acquisition without animating when motion is reduced', () => {
    const clock = frames();
    const seen: ReplayFrame[] = [];
    const replay = createTrackReplay(track, (frame) => seen.push(frame), { ...clock, prefersReducedMotion: () => true });
    replay.play();
    assert.equal(replay.reducedMotion, true);
    assert.deepEqual(seen, [{ point: track.closest, progress: 1, playing: false }]);
    assert.equal(clock.pending, 0, 'no animation frame was requested');
    replay.seek(0.5);
    assert.equal(clock.pending, 0, 'scrubbing does not animate either');
    assert.equal(seen[1]!.progress, 0.5);
  });

  it('flies the marker from the start of the swath and settles at acquisition', () => {
    const clock = frames();
    const seen: ReplayFrame[] = [];
    createTrackReplay(track, (frame) => seen.push(frame), { ...clock, prefersReducedMotion: () => false, durationMs: 1000 }).play();
    clock.run(0);
    clock.run(500);
    clock.run(1000);
    const { fromMs, toMs } = replayWindow(track);
    assert.ok(fromMs < toMs && toMs === track.closest.timeMs);
    assert.deepEqual(seen[0], { point: seen[1]!.point, progress: 0, playing: true }, 'play shows the start before the first frame');
    assert.equal(seen[1]!.point.timeMs, fromMs);
    assert.equal(seen[2]!.point.timeMs, (fromMs + toMs) / 2);
    assert.deepEqual(seen[3], { point: track.closest, progress: 1, playing: false });
    assert.equal(clock.pending, 0);
  });

  it('pauses, scrubs and resumes from the scrubbed moment', () => {
    const clock = frames();
    const seen: ReplayFrame[] = [];
    const replay = createTrackReplay(track, (frame) => seen.push(frame), { ...clock, prefersReducedMotion: () => false, durationMs: 1000 });
    replay.play();
    clock.run(0);
    clock.run(200);
    replay.pause();
    assert.equal(clock.pending, 0);
    assert.deepEqual(seen.at(-1), { ...seen.at(-2)!, playing: false });
    replay.seek(0.75);
    assert.equal(seen.at(-1)!.progress, 0.75);
    replay.play();
    clock.run(1000);
    clock.run(1100);
    assert.ok(Math.abs(seen.at(-1)!.progress - 0.85) < 1e-9, 'playing resumes from the scrubbed moment');
  });

  it('stops moving the marker once stopped', () => {
    const clock = frames();
    const seen: unknown[] = [];
    const replay = createTrackReplay(track, (frame) => seen.push(frame), { ...clock, prefersReducedMotion: () => false });
    replay.play();
    clock.run(0);
    replay.stop();
    clock.run(100);
    assert.equal(seen.length, 2);
    assert.equal(clock.pending, 0);
  });
});
