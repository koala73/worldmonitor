// Sprint 4 — Power-reliability (WB EG.ELC.LOSS.ZS) content-age contract.
//
// Tests import the SAME powerReliabilityContentMeta the seeder runs, so a
// future shape change in `_power-reliability-helpers.mjs` fails tests
// instead of silently drifting (Sprint 2/3a/3b pattern).
//
// nowMs is injected with FIXED_NOW for deterministic skew-limit and
// budget-threshold behavior. The fresh-arrival regression guard test
// is the Sprint 3b lesson made concrete: pin the EXACT failure mode
// (budget < natural fresh-arrival age = immediate page on every cron
// tick) so a future budget tightening can't reintroduce it invisibly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  yearToEndOfYearMs,
  powerReliabilityContentMeta,
  POWER_RELIABILITY_MAX_CONTENT_AGE_MIN,
} from '../scripts/_power-reliability-helpers.mjs';

const FIXED_NOW = Date.UTC(2026, 4, 5, 12);     // 2026-05-05T12:00 UTC — matches the live-WB-data verification date in the helper JSDoc.

test('POWER_RELIABILITY_MAX_CONTENT_AGE_MIN is 24 months', () => {
  assert.equal(POWER_RELIABILITY_MAX_CONTENT_AGE_MIN, 24 * 30 * 24 * 60);
});

// ── yearToEndOfYearMs ────────────────────────────────────────────────────

test('yearToEndOfYearMs: 2024 → Dec 31 2024 23:59:59.999 UTC', () => {
  const ms = yearToEndOfYearMs(2024);
  assert.equal(new Date(ms).toISOString(), '2024-12-31T23:59:59.999Z');
});

test('yearToEndOfYearMs: numeric string "2024" parses identically', () => {
  assert.equal(yearToEndOfYearMs('2024'), yearToEndOfYearMs(2024));
});

test('yearToEndOfYearMs: invalid shapes return null', () => {
  assert.equal(yearToEndOfYearMs(undefined), null);
  assert.equal(yearToEndOfYearMs(null), null);
  assert.equal(yearToEndOfYearMs(''), null);
  assert.equal(yearToEndOfYearMs('not-a-year'), null);
  assert.equal(yearToEndOfYearMs(2024.5), null, 'non-integer rejected');
  assert.equal(yearToEndOfYearMs(1899), null, 'pre-1900 rejected');
  assert.equal(yearToEndOfYearMs(10000), null, '5-digit year rejected');
  assert.equal(yearToEndOfYearMs({}), null);
});

// ── powerReliabilityContentMeta ──────────────────────────────────────────

test('contentMeta returns null when countries dict missing', () => {
  assert.equal(powerReliabilityContentMeta({}, FIXED_NOW), null);
  assert.equal(powerReliabilityContentMeta({ countries: null }, FIXED_NOW), null);
  assert.equal(powerReliabilityContentMeta({ countries: 'string' }, FIXED_NOW), null);
});

test('contentMeta returns null when countries dict is empty', () => {
  assert.equal(powerReliabilityContentMeta({ countries: {} }, FIXED_NOW), null);
});

test('contentMeta returns null when no country has a usable year', () => {
  const data = { countries: { US: {}, GB: { year: null }, DE: { year: 'garbage' } } };
  assert.equal(powerReliabilityContentMeta(data, FIXED_NOW), null);
});

test('contentMeta picks newest year (max across countries) and oldest year (min across countries)', () => {
  const data = {
    countries: {
      US: { value: 5.4, year: 2024 },
      GB: { value: 7.1, year: 2024 },
      DE: { value: 4.2, year: 2023 },
      KW: { value: 8.0, year: 2021 },     // late reporter
      QA: { value: 6.8, year: 2020 },     // late reporter
    },
  };
  const cm = powerReliabilityContentMeta(data, FIXED_NOW);
  assert.ok(cm);
  assert.equal(new Date(cm.newestItemAt).toISOString(), '2024-12-31T23:59:59.999Z', 'max year = 2024');
  assert.equal(new Date(cm.oldestItemAt).toISOString(), '2020-12-31T23:59:59.999Z', 'min year = 2020');
});

test('contentMeta excludes countries with invalid year shapes (mixed-validity dict)', () => {
  const data = {
    countries: {
      US: { value: 5.4, year: 2024 },     // valid, fresh
      INVALID: { value: 0, year: null },  // skipped
      JUNK: { value: 0, year: 'foo' },    // skipped
      KW: { value: 8.0, year: 2021 },     // valid, older
    },
  };
  const cm = powerReliabilityContentMeta(data, FIXED_NOW);
  assert.equal(new Date(cm.newestItemAt).toISOString(), '2024-12-31T23:59:59.999Z');
  assert.equal(new Date(cm.oldestItemAt).toISOString(), '2021-12-31T23:59:59.999Z');
});

test('contentMeta excludes future-dated years beyond 1h clock-skew tolerance', () => {
  // FIXED_NOW = 2026-05-05. Year 2099 is far future; year 2026 itself
  // resolves to end-of-2026 = Dec 31 23:59:59 — also future. Both must
  // be excluded as "garbage publication" rather than fresh content.
  const data = {
    countries: {
      US: { value: 5.4, year: 2024 },     // fresh
      GARBAGE: { value: 0, year: 2099 },  // far future — excluded
      EDGE: { value: 0, year: 2026 },     // end-of-2026 is past FIXED_NOW (May 5) → excluded
    },
  };
  const cm = powerReliabilityContentMeta(data, FIXED_NOW);
  assert.equal(new Date(cm.newestItemAt).toISOString(), '2024-12-31T23:59:59.999Z');
});

// ── Pilot threshold sanity (anti-drift on the 24-month budget) ──────────

test('fresh-arrival regression guard: max year 2024 in May 2026 (~17mo) does NOT trip STALE_CONTENT', () => {
  // The exact failure mode caught on Sprint 3b: budget too tight relative
  // to natural fresh-arrival age. WB EG.ELC.LOSS.ZS verified 2026-05-05:
  // max year = 2024 (G7 + China), end-of-2024 = Dec 31 2024 = ~17 months
  // before FIXED_NOW. A budget below ~17mo would page on every working
  // seed run. 24mo budget MUST tolerate this case — otherwise the probe
  // is broken-by-design.
  const data = { countries: { US: { value: 5.4, year: 2024 } } };
  const cm = powerReliabilityContentMeta(data, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin < POWER_RELIABILITY_MAX_CONTENT_AGE_MIN,
    `${Math.round(ageMin / 60 / 24 / 30)}mo < ${POWER_RELIABILITY_MAX_CONTENT_AGE_MIN / 60 / 24 / 30}mo budget — fresh WB arrival does NOT page`,
  );
});

test('boundary: max year 2023 in May 2026 (~29mo) DOES trip — by then 2024 data should have arrived', () => {
  // Steady-state late-cycle: cache holds 2023 data, FIXED_NOW = May 2026.
  // 2023-12-31 → 2026-05-05 ≈ 891 days ≈ 29.7 months — past 24-month budget.
  // This is the correct STALE_CONTENT signal: by May 2026, 2024 data SHOULD
  // have arrived (verified via live WB API on the same date), so a cache
  // still holding only 2023 data is a real upstream regression worth paging.
  const data = { countries: { US: { value: 5.4, year: 2023 } } };
  const cm = powerReliabilityContentMeta(data, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin > POWER_RELIABILITY_MAX_CONTENT_AGE_MIN,
    `${Math.round(ageMin / 60 / 24 / 30)}mo > 24mo budget — STALE_CONTENT fires (correct: 2024 should have landed by May 2026)`,
  );
});

test('pilot threshold: max year 2018 (catastrophic stall, 8+ years old) trips STALE_CONTENT', () => {
  const data = { countries: { US: { value: 5.4, year: 2018 } } };
  const cm = powerReliabilityContentMeta(data, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin > POWER_RELIABILITY_MAX_CONTENT_AGE_MIN,
    `${Math.round(ageMin / 60 / 24 / 30)}mo >> 24mo budget — clearly STALE_CONTENT`,
  );
});

test('pilot threshold: late-reporter cohort does NOT drag newestItemAt down (G7 freshness wins)', () => {
  // The whole point of using MAX year (not MIN) is that late-reporters
  // (Kuwait, Qatar at year 2021) shouldn't make the panel page when the
  // G7 cohort is reporting 2024. Verify the dict mix produces the G7-led
  // newestItemAt, NOT the KW-led oldestItemAt.
  const data = {
    countries: {
      US: { value: 5.4, year: 2024 },
      GB: { value: 7.1, year: 2024 },
      DE: { value: 4.2, year: 2024 },
      KW: { value: 8.0, year: 2021 },
      QA: { value: 6.8, year: 2020 },
      AE: { value: 9.2, year: 2021 },
    },
  };
  const cm = powerReliabilityContentMeta(data, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin < POWER_RELIABILITY_MAX_CONTENT_AGE_MIN,
    'mixed-cadence dict: G7 freshness drives newestItemAt — late-reporters do NOT cause false-positive page',
  );
});
