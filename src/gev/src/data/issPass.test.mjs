// src/data/issPass.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twoline2satrec } from 'satellite.js';
import { findNextIssPass, lookAnglesAt } from './issPass.js';

// Canonical archived ISS TLE (valid checksums; epoch 2008-09-20 ~12:25 UTC).
const L1 = '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const L2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
const AUSTIN = { latDeg: 30.2672, lonDeg: -97.7431 };
const FROM_MS = Date.UTC(2008, 8, 20, 12, 30, 0); // just after the TLE epoch

test('finds a structurally-consistent ISS pass within 24h of the TLE epoch', () => {
  const satrec = twoline2satrec(L1, L2);
  const pass = findNextIssPass({ satrec, ...AUSTIN, fromMs: FROM_MS, minElevDeg: 10 });
  assert.ok(pass, 'expected a pass within 24h at 30°N for a 51.6° inclination orbit');
  assert.ok(pass.riseMs > FROM_MS);
  assert.ok(pass.riseMs < pass.maxElevMs && pass.maxElevMs < pass.setMs);
  assert.ok(pass.maxElevDeg >= 10);
  assert.ok(pass.riseAzDeg >= 0 && pass.riseAzDeg < 360);

  // Independent re-check: elevation at the reported peak really is the max-ish
  // and ≥ threshold; one minute before rise it is below threshold.
  const peak = lookAnglesAt(satrec, pass.maxElevMs, AUSTIN.latDeg, AUSTIN.lonDeg);
  assert.ok(peak && Math.abs(peak.elevDeg - pass.maxElevDeg) < 1.5);
  const before = lookAnglesAt(satrec, pass.riseMs - 60_000, AUSTIN.latDeg, AUSTIN.lonDeg);
  assert.ok(before && before.elevDeg < 10);
});

test('returns null when no pass clears an absurd threshold', () => {
  const satrec = twoline2satrec(L1, L2);
  const pass = findNextIssPass({ satrec, ...AUSTIN, fromMs: FROM_MS, minElevDeg: 89.9, horizonHours: 2 });
  assert.equal(pass, null);
});
