// src/data/trafficBounds.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  greatCircleKm,
  deriveFetchCenter,
  clampBoundsAroundCenter,
} from './trafficBounds.js';

// Downtown Austin — matches the TomTom fixture tile neighbourhood.
const NADIR = { lat: 30.2672, lon: -97.7431 };

test('greatCircleKm sanity: Austin -> ~5 km north', () => {
  const d = greatCircleKm(NADIR.lat, NADIR.lon, NADIR.lat + 0.045, NADIR.lon);
  assert.ok(Math.abs(d - 5.0) < 0.1, `got ${d}`);
});

test('straight-down look: hit ~= nadir -> center unchanged (uses hit)', () => {
  const c = deriveFetchCenter({
    nadirLat: NADIR.lat, nadirLon: NADIR.lon,
    hitLat: NADIR.lat + 0.0001, hitLon: NADIR.lon - 0.0001,
    maxPullKm: 12,
  });
  assert.equal(c.source, 'hit');
  assert.ok(Math.abs(c.lat - (NADIR.lat + 0.0001)) < 1e-9);
  assert.ok(Math.abs(c.lon - (NADIR.lon - 0.0001)) < 1e-9);
});

test('oblique look within 12 km: uses the hit point verbatim', () => {
  const hit = { lat: NADIR.lat + 0.045, lon: NADIR.lon + 0.02 }; // ~5.3 km away
  const c = deriveFetchCenter({
    nadirLat: NADIR.lat, nadirLon: NADIR.lon,
    hitLat: hit.lat, hitLon: hit.lon,
    maxPullKm: 12,
  });
  assert.equal(c.source, 'hit');
  assert.equal(c.lat, hit.lat);
  assert.equal(c.lon, hit.lon);
});

test('horizon gaze: far hit is pulled back to 12 km along the bearing', () => {
  // Hit ~100 km due east of nadir.
  const hit = { lat: NADIR.lat, lon: NADIR.lon + 1.041 };
  assert.ok(greatCircleKm(NADIR.lat, NADIR.lon, hit.lat, hit.lon) > 90, 'precondition: far hit');
  const c = deriveFetchCenter({
    nadirLat: NADIR.lat, nadirLon: NADIR.lon,
    hitLat: hit.lat, hitLon: hit.lon,
    maxPullKm: 12,
  });
  assert.equal(c.source, 'pulled');
  const d = greatCircleKm(NADIR.lat, NADIR.lon, c.lat, c.lon);
  assert.ok(Math.abs(d - 12) < 0.05, `pulled distance ${d} km, expected ~12`);
  // Due-east bearing: latitude stays ~constant, longitude moves east but well
  // short of the hit.
  assert.ok(Math.abs(c.lat - NADIR.lat) < 0.01, `lat drifted: ${c.lat}`);
  assert.ok(c.lon > NADIR.lon && c.lon < hit.lon, `lon not between nadir and hit: ${c.lon}`);
});

test('pull cap is honored for other maxPullKm values', () => {
  const hit = { lat: NADIR.lat + 0.9, lon: NADIR.lon }; // ~100 km north
  const c = deriveFetchCenter({
    nadirLat: NADIR.lat, nadirLon: NADIR.lon,
    hitLat: hit.lat, hitLon: hit.lon,
    maxPullKm: 5,
  });
  assert.equal(c.source, 'pulled');
  const d = greatCircleKm(NADIR.lat, NADIR.lon, c.lat, c.lon);
  assert.ok(Math.abs(d - 5) < 0.05, `pulled distance ${d} km, expected ~5`);
});

test('pickEllipsoid failure (non-finite hit): falls back to the camera nadir', () => {
  for (const [hitLat, hitLon] of [[NaN, NaN], [undefined, undefined], [30.3, undefined]]) {
    const c = deriveFetchCenter({
      nadirLat: NADIR.lat, nadirLon: NADIR.lon,
      hitLat, hitLon,
      maxPullKm: 12,
    });
    assert.equal(c.source, 'nadir');
    assert.equal(c.lat, NADIR.lat);
    assert.equal(c.lon, NADIR.lon);
  }
});

test('span clamp: oversized bounds shrink to maxSpan centered on the given center', () => {
  const bounds = { south: 29.5, north: 30.5, west: -98.5, east: -97.5 }; // 1 degree spans
  const center = { lat: NADIR.lat, lon: NADIR.lon };
  const clamped = clampBoundsAroundCenter(bounds, center, 0.05);
  assert.ok(Math.abs((clamped.north - clamped.south) - 0.05) < 1e-12);
  assert.ok(Math.abs((clamped.east - clamped.west) - 0.05) < 1e-12);
  assert.ok(Math.abs((clamped.north + clamped.south) / 2 - center.lat) < 1e-12);
  assert.ok(Math.abs((clamped.east + clamped.west) / 2 - center.lon) < 1e-12);
});

test('span clamp: small bounds keep their span, recentered', () => {
  const bounds = { south: 30.0, north: 30.02, west: -98.0, east: -97.97 };
  const center = { lat: 30.30, lon: -97.70 };
  const clamped = clampBoundsAroundCenter(bounds, center, 0.05);
  assert.ok(Math.abs((clamped.north - clamped.south) - 0.02) < 1e-12);
  assert.ok(Math.abs((clamped.east - clamped.west) - 0.03) < 1e-12);
  assert.ok(Math.abs((clamped.north + clamped.south) / 2 - 30.30) < 1e-12);
  assert.ok(Math.abs((clamped.east + clamped.west) / 2 + 97.70) < 1e-12);
});

test('span clamp is idempotent on already-clamped bounds (loadRoadsForBounds re-clamp)', () => {
  const center = { lat: NADIR.lat, lon: NADIR.lon };
  const once = clampBoundsAroundCenter({ south: 29.5, north: 30.5, west: -98.5, east: -97.5 }, center, 0.05);
  const midpoint = { lat: (once.south + once.north) / 2, lon: (once.west + once.east) / 2 };
  const twice = clampBoundsAroundCenter(once, midpoint, 0.05);
  assert.deepEqual(twice, once);
});
