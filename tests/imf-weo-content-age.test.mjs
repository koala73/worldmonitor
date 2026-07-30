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
  maxIntegerYear,
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

// ── maxIntegerYear helper ───────────────────────────────────────────────

test('maxIntegerYear returns max across mixed valid+null+string years', () => {
  // Seeders pass each indicator's optional year to maxIntegerYear. Mix of
  // numbers, numeric strings, null, undefined, NaN, out-of-range — only
  // valid integer years 1900..9999 are considered.
  assert.equal(maxIntegerYear([2024, 2026, 2025]), 2026);
  assert.equal(maxIntegerYear([null, 2025, undefined, '2026', 2024]), 2026);
  assert.equal(maxIntegerYear([null, undefined]), null);
  assert.equal(maxIntegerYear([1899, 9999, 12345, NaN]), 9999);
  assert.equal(maxIntegerYear([2024.5, '2024.5', 2024]), 2024);
  assert.equal(maxIntegerYear(null), null);
  assert.equal(maxIntegerYear([]), null);
});

// ── Codex PR #3604 P2 regression guard: mixed-indicator-year ─────────────

test('mixed-indicator-year: latestYear (max forecast) drives content-age, not year (priority-first)', () => {
  // Codex PR #3604 P2. Real-world shape from seed-imf-external: the country
  // dict's `year` field is the priority-first non-null indicator's year
  // (`ca?.year ?? tm?.year ?? tx?.year`). When the priority-first indicator
  // (BCA) has only old data but a lower-priority indicator (TM_RPCH) has a
  // fresh 2026 forecast, the legacy `year` field reads 2024 — content-age
  // would map this to 2023-12-31 (~17mo old, near-stale) when the row
  // actually carries a fresh 2026 metric (~5mo old in May 2026, fresh).
  //
  // The fix: seeders populate `entry.latestYear = maxIntegerYear([all
  // indicator years])` and the helper prefers it over `entry.year`.
  const dataWithLatestYear = {
    countries: {
      // Mirrors a country with stale BCA but fresh import-volume forecast.
      US: { year: 2024, latestYear: 2026 },
    },
  };
  const dataWithoutLatestYear = {
    // Pre-fix shape (or downgraded cache during transition window): only
    // `year` populated. Helper falls back to `year` for back-compat.
    countries: { US: { year: 2024 } },
  };
  const cmWithLatest = imfWeoContentMeta(dataWithLatestYear, FIXED_NOW);
  const cmWithoutLatest = imfWeoContentMeta(dataWithoutLatestYear, FIXED_NOW);

  // With latestYear=2026 → end-of-2025 → ~5 months old in May 2026 → fresh.
  const ageMinWithLatest = (FIXED_NOW - cmWithLatest.newestItemAt) / 60000;
  assert.ok(
    ageMinWithLatest < 7 * 30 * 24 * 60,
    `latestYear-aware path must surface fresh metric (got ${(ageMinWithLatest / (30 * 24 * 60)).toFixed(1)}mo)`,
  );

  // Without latestYear → falls back to year=2024 → end-of-2023 → ~17mo old.
  const ageMinWithoutLatest = (FIXED_NOW - cmWithoutLatest.newestItemAt) / 60000;
  assert.ok(
    ageMinWithoutLatest > 12 * 30 * 24 * 60,
    `back-compat path (no latestYear) must read year (got ${(ageMinWithoutLatest / (30 * 24 * 60)).toFixed(1)}mo)`,
  );

  // newestItemAt must STRICTLY differ — proves the helper is reading
  // latestYear, not silently equating it with year.
  assert.ok(
    cmWithLatest.newestItemAt > cmWithoutLatest.newestItemAt,
    'latestYear must shift newestItemAt forward when fresher than year',
  );
});

test('mixed-indicator-year: latestYear=null falls back to year (no panic on missing field)', () => {
  // Defensive: maxIntegerYear returns null when no indicator year is valid
  // (all-null country). Seeder writes `latestYear: null`. Helper should
  // fall back to `year`, NOT crash and NOT return null for the country.
  const data = {
    countries: {
      US: { year: 2025, latestYear: null },
    },
  };
  const cm = imfWeoContentMeta(data, FIXED_NOW);
  assert.ok(cm !== null, 'must not collapse to null when latestYear is null but year is valid');
  assert.equal(cm.newestItemAt, Date.UTC(2024, 11, 31, 23, 59, 59, 999), 'must use year=2025 → end-of-2024');
});

// ── Horizon-extension regression-guard (Sprint 4 + Codex PR #3604 review) ──

test('horizon extension regression-guard: currentYear+1 forecast WOULD silently false-page under current skew filter', () => {
  // Tripwire: if a future Sprint extends `weoYears()` to include
  // `currentYear+1` to surface forward forecasts, this test will start
  // failing and force a revisit of the helper's skew filter.
  //
  // Concrete trap (under FIXED_NOW = 2026-05-05): pretend the seeder
  // populated entries with `year: 2027` (April 2026 release's frontmost
  // forecast horizon). The helper maps 2027 → end-of-2026 = Dec 31 2026 =
  // ~7mo future relative to FIXED_NOW. The 1h skew filter excludes this
  // entry. validCount=0 → returns null → envelope newestItemAt=null →
  // health classifier reads STALE_CONTENT for a genuinely-fresh cache.
  //
  // Today this is harmless because no seeder writes year=2027 in May
  // 2026 (weoYears = [2026, 2025, 2024]). Documenting it here so any
  // change to weoYears() to include +1 is forced to come revisit this
  // filter (either widen skew tolerance, or shift the year→ms mapping).
  const futureHorizon = { countries: { US: { year: 2027 }, GB: { year: 2027 } } };
  const cm = imfWeoContentMeta(futureHorizon, FIXED_NOW);
  assert.equal(
    cm,
    null,
    'currentYear+1 cohort currently collapses to null — regression test asserts the trap shape, NOT desired behavior',
  );

  // Mixed cohort: one fresh +1 entry alongside a stale -2 entry. Skew
  // filter excludes the +1, so newestItemAt regresses to the laggard.
  const mixedTrap = {
    countries: {
      US: { year: 2027 },          // fresh +1, gets filtered out
      VE: { year: 2024 },          // stale -2
    },
  };
  const cmMixed = imfWeoContentMeta(mixedTrap, FIXED_NOW);
  assert.ok(cmMixed !== null, 'mixed cohort with one valid entry must not collapse');
  // newestItemAt comes from VE=2024 (the only entry that passed the filter)
  // → end-of-2023 ≈ 17mo old. If horizon extension lands without revisiting
  // the filter, fresh data masquerades as stale.
  assert.equal(
    cmMixed.newestItemAt,
    Date.UTC(2023, 11, 31, 23, 59, 59, 999),
    'mixed cohort newestItemAt regresses to laggard when +1 is filtered — trap is real',
  );
});

test('mixed-indicator-year: cohort with mixed shapes — newestItemAt picks max latestYear across all', () => {
  // Heterogeneous cohort exercising every code path simultaneously.
  // newestItemAt must be the MAX across all valid years (latestYear when
  // present, year when not). oldestItemAt must be the MIN.
  const data = {
    countries: {
      US: { year: 2024, latestYear: 2026 },  // fresh metric tucked behind stale primary
      GB: { year: 2025 },                     // pre-fix shape, no latestYear
      VE: { year: 2024, latestYear: null },   // all-null indicators except primary
      DE: { year: 2026, latestYear: 2026 },
    },
  };
  const cm = imfWeoContentMeta(data, FIXED_NOW);
  // Max year considered = 2026 (US.latestYear, DE.latestYear) → end-of-2025.
  assert.equal(cm.newestItemAt, Date.UTC(2025, 11, 31, 23, 59, 59, 999));
  // Min year considered = 2024 (VE.year fallback, GB had 2025) → end-of-2023.
  assert.equal(cm.oldestItemAt, Date.UTC(2023, 11, 31, 23, 59, 59, 999));
});
