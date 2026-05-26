// Drift guard for scripts/seed-military-cii.mjs.
//
// The seed job is self-contained by necessity — scripts/ cannot import from server/ or
// src/ under the Railway nixpacks packaging — so it re-embeds country reference tables
// with the server modules as the implicit source of truth. Nothing at runtime detects
// when the two copies diverge. Tests CAN cross the boundary, so this asserts parity.
//
// Covers the two exact-match tables (TIER1 country set, country bounding boxes). The
// seed's COUNTRY_KEYWORDS and MMSI MID tables are intentionally trimmed subsets and are
// not asserted here — behavioural tests in seed-military-cii.test.mts cover those.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TIER1_COUNTRIES as SEED_TIER1,
  COUNTRY_BBOX as SEED_BBOX,
  geoToCountry as seedGeoToCountry,
} from '../scripts/seed-military-cii.mjs';
import { TIER1_COUNTRIES as SERVER_TIER1 } from '../server/worldmonitor/intelligence/v1/_shared.ts';
import {
  COUNTRY_BBOX as SERVER_BBOX,
  geoToCountry as serverGeoToCountry,
} from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';

test('seed TIER1_COUNTRIES matches the server source of truth exactly', () => {
  assert.deepEqual(
    SEED_TIER1,
    SERVER_TIER1,
    'scripts/seed-military-cii.mjs TIER1_COUNTRIES has drifted from server/.../_shared.ts — '
      + 'the seed would score a different country set than the CII engine',
  );
});

test('seed COUNTRY_BBOX matches the server source of truth exactly', () => {
  assert.deepEqual(
    SEED_BBOX,
    SERVER_BBOX,
    'scripts/seed-military-cii.mjs COUNTRY_BBOX has drifted from get-risk-scores.ts — '
      + 'the seed would attribute flights/vessels to stale country boundaries',
  );
});

test('seed geoToCountry agrees with server geoToCountry across overlap + non-overlap probes', () => {
  // The drift tests above lock down BBOX entries by value, but the
  // smallest-area-first sort heuristic decides who wins for points inside
  // multiple bboxes — a future change to that heuristic on the server
  // (e.g., centroid-distance) would silently diverge. These probes hit
  // four real TIER1 overlap zones where the area-sort is the discriminator:
  //   - LB inside IL bbox (LB area ~2.4 < IL area ~6.1)
  //   - AE inside SA bbox (AE area ~14.7 < SA area ~331)
  //   - AF inside IR bbox (AF area ~132 < IR area ~284)
  //   - KP inside CN bbox (KP area ~41 < CN area ~2178)
  // Plus four unambiguous interior points so a degenerate seed implementation
  // (e.g., always returning null or always returning the first match) can't pass.
  const PROBES: Array<[number, number, string]> = [
    [33.2, 35.5, 'LB'],   // overlap: IL∩LB → LB smaller wins
    [24.0, 53.0, 'AE'],   // overlap: SA∩AE → AE smaller wins
    [33.0, 62.0, 'AF'],   // overlap: IR∩AF → AF smaller wins
    [40.0, 126.0, 'KP'],  // overlap: CN∩KP → KP smaller wins
    [39.0, -98.0, 'US'],  // unambiguous central US
    [55.7, 37.6, 'RU'],   // Moscow
    [31.5, 35.0, 'IL'],   // unambiguous interior IL (south of LB overlap zone)
    [0.0, -150.0, null as unknown as string], // open Pacific — neither resolves
  ];
  for (const [lat, lon, expected] of PROBES) {
    const seedResult = seedGeoToCountry(lat, lon);
    const serverResult = serverGeoToCountry(lat, lon);
    assert.equal(
      seedResult,
      serverResult,
      `seed/server geoToCountry disagree at (${lat}, ${lon}): seed=${seedResult} server=${serverResult}`,
    );
    assert.equal(
      seedResult,
      expected,
      `probe (${lat}, ${lon}) — expected ${expected}, both returned ${seedResult}`,
    );
  }
});
