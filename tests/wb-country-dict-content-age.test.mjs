// Sprint 4 cohort follow-up — shared WB per-country-dict content-age helper.
//
// Tests cover the shared `wbCountryDictContentMeta` shape contract.
// Per-seeder budget assertions live in this file too — they're the
// fresh-arrival + steady-state regression guards that pin each seeder's
// budget against its observed publication lag (Sprint 3b/4 lesson:
// without these, a future budget tightening can silently re-introduce
// the immediate-page bug).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  yearToEndOfYearMs,
  wbCountryDictContentMeta,
} from '../scripts/_wb-country-dict-content-age-helpers.mjs';

const FIXED_NOW = Date.UTC(2026, 4, 5, 12);     // 2026-05-05T12:00 UTC — matches the live-WB-data verification date.

// ── yearToEndOfYearMs ────────────────────────────────────────────────────

test('yearToEndOfYearMs: 2024 → Dec 31 2024 23:59:59.999 UTC', () => {
  assert.equal(new Date(yearToEndOfYearMs(2024)).toISOString(), '2024-12-31T23:59:59.999Z');
});

test('yearToEndOfYearMs: numeric string "2024" parses identically', () => {
  assert.equal(yearToEndOfYearMs('2024'), yearToEndOfYearMs(2024));
});

test('yearToEndOfYearMs: invalid shapes return null', () => {
  assert.equal(yearToEndOfYearMs(undefined), null);
  assert.equal(yearToEndOfYearMs(null), null);
  assert.equal(yearToEndOfYearMs(''), null);
  assert.equal(yearToEndOfYearMs('garbage'), null);
  assert.equal(yearToEndOfYearMs(2024.5), null);
  assert.equal(yearToEndOfYearMs(1899), null);
  assert.equal(yearToEndOfYearMs(10000), null);
});

// ── wbCountryDictContentMeta ─────────────────────────────────────────────

test('contentMeta returns null when countries dict missing or non-object', () => {
  assert.equal(wbCountryDictContentMeta({}, FIXED_NOW), null);
  assert.equal(wbCountryDictContentMeta({ countries: null }, FIXED_NOW), null);
  assert.equal(wbCountryDictContentMeta({ countries: 'string' }, FIXED_NOW), null);
});

test('contentMeta returns null when no country has a usable year', () => {
  const data = { countries: { US: {}, GB: { year: null }, DE: { year: 'garbage' } } };
  assert.equal(wbCountryDictContentMeta(data, FIXED_NOW), null);
});

test('contentMeta picks newest (max) and oldest (min) year across countries', () => {
  const data = {
    countries: {
      US: { value: 5.4, year: 2024 },
      GB: { value: 7.1, year: 2024 },
      DE: { value: 4.2, year: 2023 },
      KW: { value: 8.0, year: 2021 },
      QA: { value: 6.8, year: 2020 },
    },
  };
  const cm = wbCountryDictContentMeta(data, FIXED_NOW);
  assert.equal(new Date(cm.newestItemAt).toISOString(), '2024-12-31T23:59:59.999Z');
  assert.equal(new Date(cm.oldestItemAt).toISOString(), '2020-12-31T23:59:59.999Z');
});

test('contentMeta excludes countries with invalid year shapes (mixed-validity dict)', () => {
  const data = {
    countries: {
      US: { value: 5.4, year: 2024 },
      INVALID: { value: 0, year: null },
      JUNK: { value: 0, year: 'foo' },
      KW: { value: 8.0, year: 2021 },
    },
  };
  const cm = wbCountryDictContentMeta(data, FIXED_NOW);
  assert.equal(new Date(cm.newestItemAt).toISOString(), '2024-12-31T23:59:59.999Z');
  assert.equal(new Date(cm.oldestItemAt).toISOString(), '2021-12-31T23:59:59.999Z');
});

test('contentMeta excludes future-dated years beyond 1h clock-skew tolerance', () => {
  const data = {
    countries: {
      US: { value: 5.4, year: 2024 },
      GARBAGE: { value: 0, year: 2099 },
      // EDGE: end-of-2026 = Dec 31 23:59:59 — that's ~7 months in the
      // FUTURE of FIXED_NOW (2026-05-05), so it's outside the 1h skew
      // tolerance and gets excluded. (Greptile PR #3603 P2 — pre-fix
      // comment incorrectly said "past FIXED_NOW".)
      EDGE: { value: 0, year: 2026 },
    },
  };
  const cm = wbCountryDictContentMeta(data, FIXED_NOW);
  assert.equal(new Date(cm.newestItemAt).toISOString(), '2024-12-31T23:59:59.999Z');
});

// ── Per-seeder budget regression guards ──────────────────────────────────
//
// Each migrated seeder gets its own pair of regression-guard tests that
// pin the EXACT failure mode the Sprint 3b/4 lessons taught us to look
// for: (a) fresh-arrival under budget (no false-positive on every cron
// run), (b) steady-state under budget (no false-positive mid-cycle when
// next year publishes late but legitimately).

const LOW_CARBON_BUDGET = 36 * 30 * 24 * 60;     // see seed-low-carbon-generation.mjs
const FOSSIL_BUDGET = 48 * 30 * 24 * 60;          // see seed-fossil-electricity-share.mjs

test('low-carbon: fresh-arrival regression guard — max year 2024 (~17mo) within 36mo budget', () => {
  // NUCL/HYRO max = 2024 verified live 2026-05-05; RNEW lags but is masked
  // by MAX-of-3 in the seeder's countries[iso2].year computation.
  const data = { countries: { US: { value: 60.5, year: 2024 } } };
  const cm = wbCountryDictContentMeta(data, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin < LOW_CARBON_BUDGET,
    `${Math.round(ageMin / 60 / 24 / 30)}mo < 36mo budget — fresh arrival within tolerance`,
  );
});

test('low-carbon: steady-state regression guard — max year 2023 (~29mo) within 36mo budget', () => {
  // Just before NUCL/HYRO 2025 data publishes (legitimately late at
  // L=18mo). Cache age = 29mo. 36mo budget = 30mo ceiling + 6mo slack
  // (Sprint 4 PR #3602 review lesson).
  const data = { countries: { US: { value: 60.5, year: 2023 } } };
  const cm = wbCountryDictContentMeta(data, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin < LOW_CARBON_BUDGET,
    `${Math.round(ageMin / 60 / 24 / 30)}mo < 36mo budget — within steady-state ceiling`,
  );
});

test('low-carbon: catastrophic stall — max year 2020 (~65mo) trips STALE_CONTENT', () => {
  const data = { countries: { US: { value: 60.5, year: 2020 } } };
  const cm = wbCountryDictContentMeta(data, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin > LOW_CARBON_BUDGET,
    `${Math.round(ageMin / 60 / 24 / 30)}mo > 36mo budget — STALE_CONTENT correctly fires`,
  );
});

test('fossil-share: fresh-arrival regression guard — max year 2023 (~29mo) within 48mo budget', () => {
  // Live verification 2026-05-05: EG.ELC.FOSL.ZS max year = 2023 (NOT
  // 2024 like the other WB indicators). That's already ~29mo at
  // fresh-arrival, so this indicator publishes slower than the rest.
  // 48mo budget MUST tolerate this — the failure mode caught on Sprint 3b.
  const data = { countries: { US: { value: 65.0, year: 2023 } } };
  const cm = wbCountryDictContentMeta(data, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin < FOSSIL_BUDGET,
    `${Math.round(ageMin / 60 / 24 / 30)}mo < 48mo budget — fresh arrival within tolerance`,
  );
});

test('fossil-share: steady-state regression guard — max year 2022 (~41mo) within 48mo budget', () => {
  // 2022-12-31 → 2026-05-05 ≈ 1221 days ≈ 40.7mo. Right at the steady-state
  // ceiling (29mo lag + 12mo cycle = 41mo). 48mo budget = 41mo ceiling +
  // 7mo slack — within tolerance. 36mo budget would have false-positived;
  // hence the per-seeder constant.
  const data = { countries: { US: { value: 65.0, year: 2022 } } };
  const cm = wbCountryDictContentMeta(data, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin < FOSSIL_BUDGET,
    `${Math.round(ageMin / 60 / 24 / 30)}mo < 48mo budget — within fossil-share steady-state ceiling`,
  );
});

test('fossil-share: catastrophic stall — max year 2018 (~89mo) trips STALE_CONTENT', () => {
  const data = { countries: { US: { value: 65.0, year: 2018 } } };
  const cm = wbCountryDictContentMeta(data, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin > FOSSIL_BUDGET,
    `${Math.round(ageMin / 60 / 24 / 30)}mo > 48mo budget — STALE_CONTENT correctly fires`,
  );
});

test('per-seeder budget separation: a 41mo cache trips low-carbon (36mo) but NOT fossil-share (48mo)', () => {
  // Demonstrates why per-seeder budgets matter: a low-carbon cache stuck
  // at 2022 for 41mo is a real stall (NUCL/HYRO normally publish 2024 by
  // now), but a fossil-share cache stuck at 2022 is just normal
  // steady-state (FOSL publishes ~30mo lag). Same age, different verdicts.
  const ageMs41 = 41 * 30 * 24 * 60 * 60 * 1000;
  assert.ok(ageMs41 / 60000 > LOW_CARBON_BUDGET, '41mo > low-carbon 36mo budget — trips');
  assert.ok(ageMs41 / 60000 < FOSSIL_BUDGET, '41mo < fossil-share 48mo budget — does NOT trip');
});
