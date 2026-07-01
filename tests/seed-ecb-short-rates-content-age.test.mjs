// Regression guard for the €STR partial-failure content-age softening.
//
// Bug: seed-ecb-short-rates fetches 4 series (€STR daily + 3 EURIBOR monthly).
// When the €STR fetch transiently fails but ≥1 EURIBOR succeeds, the seeder
// still publishes seed-meta (successCount > 0 → no throw). The old code derived
// the content-age span from the null `estrObservations`, nulling newest/oldest —
// which flips ecbEstr AND all three ecbEuribor* /api/health checks (they read
// the same seed-meta record) to STALE_CONTENT on the FIRST failed run. That is
// far more aggressive than the 10-day budget, which exists to fire only ~6
// business days into a GENUINE freeze (issue #3845).
//
// Fix: on €STR fetch failure, derive the span from the last-good €STR key
// (whose TTL is extended on failure). These tests lock the pure derivation:
// transient blip → keeps last-good span (no false stale); genuine freeze →
// preserved dates are old enough to still trip stale; no data at all → null.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveEstrContentMeta } from '../scripts/seed-ecb-short-rates.mjs';
import { DAY_MIN } from '../scripts/_content-age-helpers.mjs';

const NOW = Date.parse('2026-07-01T12:00:00Z');
const ESTR_BUDGET_MIN = 10 * DAY_MIN; // mirrors ESTR_MAX_CONTENT_AGE_MIN in the seeder
const ts = (d) => Date.parse(`${d}T00:00:00Z`);
const ageMin = (span) => (NOW - span.newestItemAt) / 60_000;

test('fresh €STR observations win — span comes from this run, not the preserved key', () => {
  const fresh = [{ date: '2026-06-29', value: 2.18 }, { date: '2026-06-30', value: 2.18 }];
  const preserved = [{ date: '2026-06-01', value: 2.1 }]; // stale — must be ignored
  const span = deriveEstrContentMeta(fresh, preserved, NOW);
  assert.equal(span.newestItemAt, ts('2026-06-30'));
  assert.equal(span.oldestItemAt, ts('2026-06-29'));
});

test('transient €STR fetch failure falls back to last-good key → NO false STALE_CONTENT', () => {
  const preserved = [
    { date: '2026-06-26', value: 2.18 },
    { date: '2026-06-29', value: 2.18 },
    { date: '2026-06-30', value: 2.18 },
  ];
  const span = deriveEstrContentMeta(null, preserved, NOW);
  assert.notEqual(span, null, 'span must not be null on a transient blip with last-good data');
  assert.equal(span.newestItemAt, ts('2026-06-30'));
  // 1-day-old content is comfortably inside the 10-day budget → health stays OK.
  assert.ok(ageMin(span) < ESTR_BUDGET_MIN, 'recent preserved data must read as fresh, not stale');
});

test('genuine €STR freeze still trips STALE_CONTENT — preserved dates are old enough', () => {
  // €STR frozen ~30 days: fetch keeps failing, last-good key holds only old dates.
  const preserved = [{ date: '2026-05-29', value: 2.1 }, { date: '2026-06-01', value: 2.1 }];
  const span = deriveEstrContentMeta(null, preserved, NOW);
  assert.notEqual(span, null);
  assert.equal(span.newestItemAt, ts('2026-06-01'));
  // Newest preserved observation is > budget old → /api/health flips STALE_CONTENT.
  assert.ok(ageMin(span) > ESTR_BUDGET_MIN, 'a real freeze must still exceed the content-age budget');
});

test('no fresh AND no last-good data → null span → STALE_CONTENT (sustained outage)', () => {
  assert.equal(deriveEstrContentMeta(null, null, NOW), null);
  assert.equal(deriveEstrContentMeta(null, [], NOW), null);
  assert.equal(deriveEstrContentMeta([], null, NOW), null);
  assert.equal(deriveEstrContentMeta([], [], NOW), null);
});

test('empty fresh array is treated as "no fresh" and falls back to preserved', () => {
  const preserved = [{ date: '2026-06-30', value: 2.18 }];
  const span = deriveEstrContentMeta([], preserved, NOW);
  assert.equal(span.newestItemAt, ts('2026-06-30'));
});

test('undatable preserved entries are skipped; a valid one still yields a span', () => {
  const preserved = [{ value: 2.1 }, { date: null }, { date: '2026-06-30', value: 2.18 }];
  const span = deriveEstrContentMeta(null, preserved, NOW);
  assert.equal(span.newestItemAt, ts('2026-06-30'));
});
