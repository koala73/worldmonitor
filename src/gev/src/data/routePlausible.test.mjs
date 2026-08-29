// src/data/routePlausible.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routePlausible, greatCircleKm } from './routePlausible.js';

const SFO = { lat: 37.6188, lon: -122.3754 };
const LAX = { lat: 33.9416, lon: -118.4085 };
const JFK = { lat: 40.6413, lon: -73.7781 };

test('greatCircleKm sanity: SFO→LAX ≈ 543 km', () => {
  const d = greatCircleKm(SFO.lat, SFO.lon, LAX.lat, LAX.lon);
  assert.ok(Math.abs(d - 543) < 15, `got ${d}`);
});

test('plane mid-route SFO→LAX: plausible', () => {
  assert.equal(routePlausible({
    latDeg: 35.8, lonDeg: -120.4, altitudeM: 10000, verticalRateMps: 0,
    origin: SFO, destination: LAX,
  }), true);
});

test('plane in London with an SFO→LAX route: implausible', () => {
  assert.equal(routePlausible({
    latDeg: 51.5, lonDeg: -0.12, altitudeM: 10000, verticalRateMps: 0,
    origin: SFO, destination: LAX,
  }), false);
});

test('vertical trend: low climbing plane near SFO — origin must be local', () => {
  const nearSfo = { latDeg: 37.7, lonDeg: -122.4, altitudeM: 2500 };
  // JFK→SFO passes geometry (near destination), but a CLIMBING plane here just
  // departed — origin JFK (far) contradicts it.
  assert.equal(routePlausible({ ...nearSfo, verticalRateMps: 8, origin: JFK, destination: SFO }), false);
  // The same plane DESCENDING is arriving at SFO — plausible.
  assert.equal(routePlausible({ ...nearSfo, verticalRateMps: -8, origin: JFK, destination: SFO }), true);
});

test('missing data never hides a route (cannot judge → allow)', () => {
  assert.equal(routePlausible({ latDeg: 35.8, lonDeg: -120.4, origin: null, destination: null }), true);
  assert.equal(routePlausible({
    latDeg: 51.5, lonDeg: -0.12,
    origin: { lat: null, lon: null }, destination: null,
  }), true);
});
