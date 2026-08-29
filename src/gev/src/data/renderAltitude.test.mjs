// src/data/renderAltitude.test.mjs
//
// Locks pickRenderAltitudeM's priority chain — the SINGLE source of truth for
// where a flights-layer aircraft (and its dead-reckoned/tracked-camera
// derivatives) renders on the ellipsoidal globe:
//
//   onGround && finite(surfaceM) -> surfaceM
//   finite(geoAltM)              -> geoAltM
//   finite(baroAltM)             -> baroAltM + (geoidN ?? 0)
//   else                         -> fallback (caller's existing sticky default)
//
// baro+N is a visual FALLBACK, not geometric truth (OpenSky geo_altitude is
// the real WGS84 ellipsoidal value; barometric altitude is MSL-referenced
// and additionally subject to non-standard-pressure QNH error) — no test
// here asserts baro+N is exact, only that it matches the documented formula.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  geoidSurfaceLastResortM, pickRenderAltitudeM, reuseGroundedSurfaceM,
} from './renderAltitude.js';

test('onGround with a finite surfaceM wins over everything else', () => {
  const got = pickRenderAltitudeM({
    geoAltM: 500,
    baroAltM: 480,
    onGround: true,
    surfaceM: 121.5,
    geoidN: -26.9,
  });
  assert.equal(got, 121.5);
});

test('onGround but surfaceM not finite falls through to geoAltM', () => {
  const got = pickRenderAltitudeM({
    geoAltM: 5,
    baroAltM: 3,
    onGround: true,
    surfaceM: null,
    geoidN: -26.9,
  });
  assert.equal(got, 5);
});

test('airborne: finite geoAltM (WGS84 ellipsoidal) is used verbatim, geoidN ignored', () => {
  const got = pickRenderAltitudeM({
    geoAltM: 3048,
    baroAltM: 3000,
    onGround: false,
    surfaceM: null,
    geoidN: -26.9,
  });
  assert.equal(got, 3048);
});

test('Denver case: no geo_altitude, baro 1600 + N -17.3 -> ~=1582.7', () => {
  const got = pickRenderAltitudeM({
    geoAltM: null,
    baroAltM: 1600,
    onGround: false,
    surfaceM: null,
    geoidN: -17.3,
  });
  assert.ok(Math.abs(got - 1582.7) < 0.001, `expected ~=1582.7, got ${got}`);
});

test('baro path: geoidN omitted/undefined treated as 0 (not NaN)', () => {
  const got = pickRenderAltitudeM({
    geoAltM: null,
    baroAltM: 1000,
    onGround: false,
    surfaceM: null,
  });
  assert.equal(got, 1000);
});

test('baro path: geoidN explicitly null also treated as 0', () => {
  const got = pickRenderAltitudeM({
    geoAltM: null,
    baroAltM: 1000,
    onGround: false,
    surfaceM: null,
    geoidN: null,
  });
  assert.equal(got, 1000);
});

test('null-geo fallback: neither geoAltM nor baroAltM finite -> sentinel null', () => {
  const got = pickRenderAltitudeM({
    geoAltM: null,
    baroAltM: null,
    onGround: false,
    surfaceM: null,
    geoidN: -17.3,
  });
  assert.equal(got, null, 'caller applies its own existing sticky/default fallback on null');
});

test('grounded with no surfaceM and no geo/baro altitude -> still sentinel null (caller default)', () => {
  const got = pickRenderAltitudeM({
    geoAltM: null,
    baroAltM: null,
    onGround: true,
    surfaceM: null,
    geoidN: null,
  });
  assert.equal(got, null);
});

test('non-finite (NaN/Infinity) inputs are treated as missing, not thrown', () => {
  assert.equal(
    pickRenderAltitudeM({ geoAltM: NaN, baroAltM: 1200, onGround: false, surfaceM: null, geoidN: 5 }),
    1205
  );
  assert.equal(
    pickRenderAltitudeM({ geoAltM: Infinity, baroAltM: 1200, onGround: false, surfaceM: null, geoidN: 5 }),
    1205
  );
});

test('onGround with surfaceM = 0 (sea-level coast) is a legitimate finite value, not falsy-skipped', () => {
  const got = pickRenderAltitudeM({
    geoAltM: 10,
    baroAltM: 5,
    onGround: true,
    surfaceM: 0,
    geoidN: -32.2,
  });
  assert.equal(got, 0);
});

// reuseGroundedSurfaceM — taxiing surface reuse (adversarial-review [medium]).
test('reuseGroundedSurfaceM: a warm current fix is used directly', () => {
  assert.equal(reuseGroundedSurfaceM(1620.4, 1619.8), 1620.4);
});

test('reuseGroundedSurfaceM: current miss falls back to the previous fix ground', () => {
  // The taxiing case: current-fix cache miss (null), but last poll's fix was
  // warmed — reuse its ~flat-airport ground instead of the 0 m sentinel.
  assert.equal(reuseGroundedSurfaceM(null, 1619.8), 1619.8);
});

test('reuseGroundedSurfaceM: both miss -> null sentinel (caller default applies)', () => {
  assert.equal(reuseGroundedSurfaceM(null, null), null);
  assert.equal(reuseGroundedSurfaceM(NaN, undefined), null);
});

test('reuseGroundedSurfaceM: sea-level 0 ground is finite and reused, not falsy-skipped', () => {
  assert.equal(reuseGroundedSurfaceM(0, 5), 0);
  assert.equal(reuseGroundedSurfaceM(null, 0), 0);
});

test('taxiing aircraft over nonzero terrain resolves every poll after the first (no stuck 0 m)', () => {
  // Simulate the poll loop for a no-baro/no-geo on-ground aircraft that moves
  // to a NEW 5-decimal-rounded coordinate each poll over Denver-elevation
  // terrain (~1620 m). Each poll's warm batch resolves THAT poll's fix for the
  // NEXT poll, so `cachedCurrent` misses every poll but `cachedPrev` (last
  // poll's now-warmed fix) hits from poll 2 onward.
  const GROUND = 1620;
  const warm = new Map();                 // stands in for terrainHeights cache
  const key = (lat) => lat.toFixed(5);
  let prevFixLat = null;
  const rendered = [];
  for (let poll = 0; poll < 4; poll++) {
    const lat = 39.85000 + poll * 0.001;  // ~111 m/poll — a fresh key every poll
    const cachedCurrent = warm.has(key(lat)) ? warm.get(key(lat)) : null;
    const cachedPrev = prevFixLat != null && warm.has(key(prevFixLat)) ? warm.get(key(prevFixLat)) : null;
    const surfaceM = reuseGroundedSurfaceM(cachedCurrent, cachedPrev);
    const renderAltM = pickRenderAltitudeM({
      geoAltM: null, baroAltM: null, onGround: true, surfaceM, geoidN: -17.3,
    });
    rendered.push(renderAltM);
    // end-of-poll warm batch resolves this poll's fix for later polls
    warm.set(key(lat), GROUND);
    prevFixLat = lat;
  }
  // Poll 0 has no prior fix (brand-new contact) -> sentinel null (caller uses
  // its 0 m grounded default for one poll). Polls 1..3 reuse the previous
  // fix's ground and never stick underground.
  assert.equal(rendered[0], null, 'first poll: no prior warm fix yet -> caller default');
  assert.deepEqual(rendered.slice(1), [GROUND, GROUND, GROUND], 'subsequent polls resolve via previous fix');
});

// ---------------------------------------------------------------------------
// geoidSurfaceLastResortM — the geoid guess must never outrank what the
// contact already knows (field incident 2026-08-21: a Re:Earth outage plus
// this guess dropped a parked contact through the mesh at a Texas field).
// ---------------------------------------------------------------------------

test('geoid last resort: a first sighting with no altitude at all gets the guess', () => {
  assert.equal(geoidSurfaceLastResortM({
    geoAltM: null, baroAltM: null, priorRenderM: null, geoidN: -27.4,
  }), -27.4);
});

test('geoid last resort: a contact that already has a render height HOLDS it', () => {
  assert.equal(geoidSurfaceLastResortM({
    geoAltM: null, baroAltM: null, priorRenderM: 168.2, geoidN: -27.4,
  }), null, 'null leaves surfaceM cold, so the caller falls through to its own hold');
});

test('geoid last resort: any reported altitude outranks the guess', () => {
  assert.equal(geoidSurfaceLastResortM({
    geoAltM: 190, baroAltM: null, priorRenderM: null, geoidN: -27.4,
  }), null);
  assert.equal(geoidSurfaceLastResortM({
    geoAltM: null, baroAltM: 165, priorRenderM: null, geoidN: -27.4,
  }), null);
});

test('geoid last resort: no geoid grid yet means no guess to make', () => {
  assert.equal(geoidSurfaceLastResortM({
    geoAltM: null, baroAltM: null, priorRenderM: null, geoidN: undefined,
  }), null);
});
