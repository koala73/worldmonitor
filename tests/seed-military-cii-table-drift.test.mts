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

import { TIER1_COUNTRIES as SEED_TIER1, COUNTRY_BBOX as SEED_BBOX } from '../scripts/seed-military-cii.mjs';
import { TIER1_COUNTRIES as SERVER_TIER1 } from '../server/worldmonitor/intelligence/v1/_shared.ts';
import { COUNTRY_BBOX as SERVER_BBOX } from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';

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
