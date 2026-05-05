// Sprint 4 IMF/WEO cohort — content-age contract for the 4 IMF SDMX seeders.
//
// Tests import the SAME imfWeoContentMeta the seeders run. Pinned to
// FIXED_NOW = 2026-05-05 (matches the WB cohort verification date) so all
// "fresh April 2026 vintage" assertions are deterministic.
//
// The KEY semantic difference from WB seeders (covered in
// `wb-country-dict-content-age.test.mjs`): IMF year is FORECAST horizon,
// NOT observation year. So the helper maps year → end-of-(year - 1) UTC
// ms, NOT end-of-year. A test that round-trips through the WB helper math
// would falsely reject every fresh IMF cache as future-dated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  imfForecastYearToMs,
  imfWeoContentMeta,
  IMF_WEO_MAX_CONTENT_AGE_MIN,
} from '../scripts/_imf-weo-content-age-helpers.mjs';

const FIXED_NOW = Date.UTC(2026, 4, 5, 12);     // 2026-05-05T12:00 UTC

test('IMF_WEO_MAX_CONTENT_AGE_MIN is 18 thirty-day months', () => {
  // 18mo = 16mo steady-state ceiling + 2mo slack. See helper JSDoc for
  // the derivation against the WEO April + October release cadence.
  assert.equal(IMF_WEO_MAX_CONTENT_AGE_MIN, 18 * 30 * 24 * 60);
});

// ── imfForecastYearToMs ──────────────────────────────────────────────────

test('imfForecastYearToMs: forecast year 2026 → end-of-2025 UTC ms', () => {
  // The KEY semantic: forecast year N → end-of-(N - 1). Encodes "the
  // latest fully-observed period this forecast vintage is built on."
  const ms = imfForecastYearToMs(2026);
  assert.equal(new Date(ms).toISOString(), '2025-12-31T23:59:59.999Z');
});

test('imfForecastYearToMs: forecast year 2024 → end-of-2023 UTC ms', () => {
  const ms = imfForecastYearToMs(2024);
  assert.equal(new Date(ms).toISOString(), '2023-12-31T23:59:59.999Z');
});

test('imfForecastYearToMs: numeric string "2026" parses identically', () => {
  assert.equal(imfForecastYearToMs('2026'), imfForecastYearToMs(2026));
});

test('imfForecastYearToMs: invalid shapes return null', () => {
  assert.equal(imfForecastYearToMs(undefined), null);
  assert.equal(imfForecastYearToMs(null), null);
  assert.equal(imfForecastYearToMs(''), null);
  assert.equal(imfForecastYearToMs('garbage'), null);
  assert.equal(imfForecastYearToMs(2024.5), null);
  assert.equal(imfForecastYearToMs(1899), null);
  assert.equal(imfForecastYearToMs(10000), null);
});

// ── imfWeoContentMeta ────────────────────────────────────────────────────

test('contentMeta returns null when countries dict missing or non-object', () => {
  assert.equal(imfWeoContentMeta({}, FIXED_NOW), null);
  assert.equal(imfWeoContentMeta({ countries: null }, FIXED_NOW), null);
  assert.equal(imfWeoContentMeta({ countries: 'string' }, FIXED_NOW), null);
});

test('contentMeta returns null when no country has a usable year', () => {
  const data = { countries: { US: {}, GB: { year: null }, DE: { year: 'garbage' } } };
  assert.equal(imfWeoContentMeta(data, FIXED_NOW), null);
});

test('contentMeta picks newest (max) and oldest (min) forecast year across countries', () => {
  const data = {
    countries: {
      US: { year: 2026 },     // freshest forecast horizon
      GB: { year: 2026 },
      DE: { year: 2025 },
      KW: { year: 2024 },     // late-reporter
    },
  };
  const cm = imfWeoContentMeta(data, FIXED_NOW);
  assert.equal(new Date(cm.newestItemAt).toISOString(), '2025-12-31T23:59:59.999Z', 'max forecast year 2026 → end-of-2025');
  assert.equal(new Date(cm.oldestItemAt).toISOString(), '2023-12-31T23:59:59.999Z', 'min forecast year 2024 → end-of-2023');
});

test('contentMeta excludes countries with invalid year shapes', () => {
  const data = {
    countries: {
      US: { year: 2026 },
      INVALID: { year: null },
      JUNK: { year: 'foo' },
      KW: { year: 2024 },
    },
  };
  const cm = imfWeoContentMeta(data, FIXED_NOW);
  assert.equal(new Date(cm.newestItemAt).toISOString(), '2025-12-31T23:59:59.999Z');
  assert.equal(new Date(cm.oldestItemAt).toISOString(), '2023-12-31T23:59:59.999Z');
});

test('contentMeta excludes future-dated forecasts beyond 1h clock-skew tolerance', () => {
  // Defensive: under the seeder's current weoYears() (currentYear, -1, -2),
  // max year = currentYear, so end-of-(year - 1) is always Dec 31 of
  // last calendar year — never future. But if a future seeder change
  // extends weoYears() to include currentYear+1 (longer forecast horizon),
  // year=2027 in May 2026 → end-of-2026 = Dec 31 2026 = ~7mo future →
  // should be rejected as "garbage" rather than reported as fresh.
  const data = {
    countries: {
      US: { year: 2026 },     // valid → end-of-2025 → past NOW
      FUTURE: { year: 2099 }, // far future → end-of-2098 → far future, excluded
      EDGE: { year: 2027 },   // year-1 = 2026, end-of-2026 = ~7mo future, excluded
    },
  };
  const cm = imfWeoContentMeta(data, FIXED_NOW);
  assert.equal(new Date(cm.newestItemAt).toISOString(), '2025-12-31T23:59:59.999Z');
});

// ── Pilot threshold sanity ───────────────────────────────────────────────
//
// IMF/WEO cadence: April + October vintages each year. After April 2026,
// max stored year = 2026 → newestItemAt = end-of-2025. Age in May 2026 =
// ~5 months. The 18-month budget should comfortably tolerate this AND
// the steady-state worst case (just before April 2027 release of 2027
// forecasts: max year = 2026, age = ~16 months).

test('fresh-arrival regression guard: April 2026 vintage (max year 2026, age ~5mo) does NOT trip', () => {
  const data = { countries: { US: { year: 2026 } } };
  const cm = imfWeoContentMeta(data, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin < IMF_WEO_MAX_CONTENT_AGE_MIN,
    `${Math.round(ageMin / 60 / 24 / 30)}mo < 18mo budget — fresh April vintage tolerated`,
  );
});

test('steady-state regression guard: just-before-April-2027 (max year 2026, age ~16mo) does NOT trip', () => {
  // FIXED_FUTURE pinned to mid-March 2027. WEO April 2027 hasn't
  // released yet, so max stored year = 2026 (carried over from Apr/Oct
  // 2026 vintages). Cache age = end-of-2025 → mid-March 2027 ≈ 14.5mo.
  // 18-month budget MUST tolerate this — it's the steady-state ceiling.
  const FIXED_FUTURE = Date.UTC(2027, 2, 15);     // March 15 2027
  const data = { countries: { US: { year: 2026 } } };
  const cm = imfWeoContentMeta(data, FIXED_FUTURE);
  const ageMin = (FIXED_FUTURE - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin < IMF_WEO_MAX_CONTENT_AGE_MIN,
    `${Math.round(ageMin / 60 / 24 / 30)}mo < 18mo budget — steady-state ceiling tolerated`,
  );
});

test('catastrophic stall: max year 2024 in May 2026 (age ~29mo) trips STALE_CONTENT', () => {
  // IMF should have published 2025 + 2026 forecasts by May 2026 (Apr 2025,
  // Oct 2025, Apr 2026 are all WEO release windows). Cache stuck at year
  // 2024 = both 2025 AND 2026 vintages missed → page on-call.
  const data = { countries: { US: { year: 2024 } } };
  const cm = imfWeoContentMeta(data, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin > IMF_WEO_MAX_CONTENT_AGE_MIN,
    `${Math.round(ageMin / 60 / 24 / 30)}mo > 18mo budget — STALE_CONTENT correctly fires`,
  );
});

test('semantic difference from WB cohort: forecast year 2026 in May 2026 maps to past (NOT future)', () => {
  // This test exists specifically to prevent a future refactor from
  // accidentally collapsing the WB and IMF helpers into one. Under WB's
  // end-of-year semantics, year=2026 → end-of-2026 = Dec 31 2026 = ~7mo
  // FUTURE in May 2026 → would be rejected by 1h skew limit → contentMeta
  // returns null → STALE_CONTENT for every fresh IMF cache. The IMF
  // helper's end-of-(year - 1) mapping prevents this trap.
  const data = { countries: { US: { year: 2026 } } };
  const cm = imfWeoContentMeta(data, FIXED_NOW);
  assert.ok(cm !== null, 'fresh IMF cache must NOT collapse to null under forecast-year semantics');
  assert.ok(cm.newestItemAt < FIXED_NOW, 'newestItemAt must be in the past, not future-dated');
});

test('late-reporter cohort does NOT drag newestItemAt down (G7 freshness wins)', () => {
  // Same shape pattern as WB cohort: late-publishing IMF members (e.g.
  // some EMs lag G7's WEO inclusion) shouldn't make the panel page when
  // G7 has fresh forecasts. Verify the dict mix produces G7-led
  // newestItemAt, NOT the laggard-led oldestItemAt.
  const data = {
    countries: {
      US: { year: 2026 },     // fresh G7
      GB: { year: 2026 },
      DE: { year: 2026 },
      VE: { year: 2024 },     // Venezuela lags WEO inclusion
      ER: { year: 2024 },
    },
  };
  const cm = imfWeoContentMeta(data, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin < IMF_WEO_MAX_CONTENT_AGE_MIN,
    'mixed-cadence dict: G7 freshness drives newestItemAt — late reporters do NOT cause false-positive page',
  );
});
