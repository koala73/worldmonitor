// Sprint 3b — IEA oil stocks content-age contract.
//
// Tests import the SAME ieaOilStocksContentMeta the seeder runs, so a
// future shape change in `_iea-oil-stocks-helpers.mjs` fails tests instead
// of silently drifting. nowMs is injected with FIXED_NOW for deterministic
// skew-limit behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dataMonthToEndOfMonthMs,
  ieaOilStocksContentMeta,
  IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN,
} from '../scripts/_iea-oil-stocks-helpers.mjs';

const FIXED_NOW = 1700000000000;     // 2023-11-14T22:13:20.000Z — stable test "now"

test('IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN is 90 days', () => {
  // 90d = ~60d natural M+2 lag + ~30d missed-publication slack. See helper
  // module's JSDoc on the threshold. Initial PR shipped 45d, which was
  // wrong: every fresh seed run would have tripped STALE_CONTENT because
  // 45d < the natural lag. Greptile P1 caught it on PR #3599.
  assert.equal(IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN, 90 * 24 * 60);
});

// ── dataMonthToEndOfMonthMs ──────────────────────────────────────────────

test('dataMonthToEndOfMonthMs: "2024-08" → Aug 31 23:59:59.999 UTC', () => {
  const ms = dataMonthToEndOfMonthMs('2024-08');
  assert.equal(new Date(ms).toISOString(), '2024-08-31T23:59:59.999Z');
});

test('dataMonthToEndOfMonthMs: "2024-02" picks Feb 29 in a leap year', () => {
  const ms = dataMonthToEndOfMonthMs('2024-02');
  assert.equal(new Date(ms).toISOString(), '2024-02-29T23:59:59.999Z');
});

test('dataMonthToEndOfMonthMs: "2023-02" picks Feb 28 in a non-leap year', () => {
  const ms = dataMonthToEndOfMonthMs('2023-02');
  assert.equal(new Date(ms).toISOString(), '2023-02-28T23:59:59.999Z');
});

test('dataMonthToEndOfMonthMs: "2024-12" picks Dec 31 (rollover safe)', () => {
  const ms = dataMonthToEndOfMonthMs('2024-12');
  assert.equal(new Date(ms).toISOString(), '2024-12-31T23:59:59.999Z');
});

test('dataMonthToEndOfMonthMs: invalid shapes return null', () => {
  assert.equal(dataMonthToEndOfMonthMs(undefined), null);
  assert.equal(dataMonthToEndOfMonthMs(null), null);
  assert.equal(dataMonthToEndOfMonthMs(''), null);
  assert.equal(dataMonthToEndOfMonthMs('2024'), null);
  assert.equal(dataMonthToEndOfMonthMs('2024-8'), null, 'single-digit month rejected');
  assert.equal(dataMonthToEndOfMonthMs('2024-13'), null, 'month > 12 rejected');
  assert.equal(dataMonthToEndOfMonthMs('2024-00'), null, 'month 0 rejected');
  assert.equal(dataMonthToEndOfMonthMs('not-a-date'), null);
  assert.equal(dataMonthToEndOfMonthMs(202408), null, 'numeric input rejected');
});

// ── ieaOilStocksContentMeta ──────────────────────────────────────────────

test('contentMeta returns null when dataMonth missing', () => {
  assert.equal(ieaOilStocksContentMeta({ members: [] }, FIXED_NOW), null);
  assert.equal(ieaOilStocksContentMeta({}, FIXED_NOW), null);
});

test('contentMeta returns null when dataMonth is unparseable', () => {
  assert.equal(ieaOilStocksContentMeta({ dataMonth: 'garbage' }, FIXED_NOW), null);
  assert.equal(ieaOilStocksContentMeta({ dataMonth: '2024' }, FIXED_NOW), null);
  assert.equal(ieaOilStocksContentMeta({ dataMonth: '2024-13' }, FIXED_NOW), null);
});

test('contentMeta: newest === oldest (single-snapshot shape)', () => {
  // FIXED_NOW = 2023-11-14, so 2023-09 is well within tolerance and not future.
  const cm = ieaOilStocksContentMeta({ dataMonth: '2023-09', members: [{}, {}, {}] }, FIXED_NOW);
  assert.ok(cm, 'returns a result');
  assert.equal(cm.newestItemAt, cm.oldestItemAt, 'single-snapshot: newest === oldest');
  assert.equal(new Date(cm.newestItemAt).toISOString(), '2023-09-30T23:59:59.999Z');
});

test('contentMeta excludes future-dated months beyond 1h clock-skew tolerance', () => {
  // FIXED_NOW = 2023-11-14T22:13:20Z. dataMonth "2099-12" → Dec 31 2099 — far future, must reject.
  assert.equal(ieaOilStocksContentMeta({ dataMonth: '2099-12' }, FIXED_NOW), null);
});

test('contentMeta accepts current month (skewLimit edge — must NOT reject the month containing FIXED_NOW)', () => {
  // FIXED_NOW = 2023-11-14T22:13:20Z; "2023-11" → Nov 30 23:59:59 — that's
  // ~16 days AFTER FIXED_NOW, well past the 1h skew-limit tolerance.
  // This documents a deliberate design choice: dataMonth points to END of
  // the named period, so the seeder should NOT publish a dataMonth that
  // hasn't fully ended yet (IEA's M+2 lag means current-month is never
  // available anyway). If this assumption breaks, the test will surface it.
  assert.equal(
    ieaOilStocksContentMeta({ dataMonth: '2023-11' }, FIXED_NOW),
    null,
    'end-of-current-month is in the future relative to FIXED_NOW (mid-month) — rejected by skew-limit',
  );
});

test('contentMeta accepts last fully-completed month', () => {
  // FIXED_NOW = 2023-11-14, so "2023-10" → Oct 31 23:59:59 is in the past.
  const cm = ieaOilStocksContentMeta({ dataMonth: '2023-10' }, FIXED_NOW);
  assert.ok(cm);
  assert.equal(new Date(cm.newestItemAt).toISOString(), '2023-10-31T23:59:59.999Z');
});

// ── Pilot threshold sanity (anti-drift on the 90-day budget) ────────────

test('fresh-arrival regression guard: ~60d-old fresh M+2 data does NOT trip STALE_CONTENT', () => {
  // The exact failure mode caught by Greptile P1 on the initial 45d budget:
  // when IEA publishes "2024-08" data in late Oct/early Nov, end-of-Aug is
  // ~60-65d before fresh-arrival NOW. A budget below ~60d would fire
  // STALE_CONTENT immediately on every successful seed run.
  //
  // FIXED_NOW = 2023-11-14T22:13:20Z. dataMonth "2023-09" → end-of-Sept
  // = ~45d ago. dataMonth "2023-08" → end-of-Aug = ~75d ago. Use 2023-08
  // to simulate freshly-arrived M+2 data at the upper end of the natural
  // arrival-age range. This MUST be within budget.
  const cm = ieaOilStocksContentMeta({ dataMonth: '2023-08' }, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin < IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN,
    `${Math.round(ageMin / 60 / 24)}d < ${IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN / 60 / 24}d budget — fresh M+2 arrival does NOT page`,
  );
});

test('pilot threshold: dataMonth ~14 days old is within 90-day budget (no false positive)', () => {
  // FIXED_NOW = 2023-11-14. "2023-10" → end-of-Oct = ~14d ago. Trivially fresh.
  const cm = ieaOilStocksContentMeta({ dataMonth: '2023-10' }, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin < IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN,
    `${Math.round(ageMin)}min < budget ${IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN}min — STALE_CONTENT does NOT fire on normal M+2 cadence`,
  );
});

test('pilot threshold: dataMonth ~120d old (multiple missed publications) trips STALE_CONTENT', () => {
  // FIXED_NOW = 2023-11-14T22:13:20Z. "2023-07" → end-of-Jul = ~106d ago,
  // past the 90d budget. Simulates "Aug AND Sept data both missed" or "Aug
  // arrived very late" scenarios where on-call should be paged.
  const cm = ieaOilStocksContentMeta({ dataMonth: '2023-07' }, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin > IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN,
    `${Math.round(ageMin / 60 / 24)}d > budget ${IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN / 60 / 24}d — STALE_CONTENT would fire`,
  );
});

test('pilot threshold: M+2 lag scenario — Sept data still in cache by Feb 1 (5 months later) trips STALE_CONTENT', () => {
  // Realistic incident pattern: cache holds dataMonth="2023-09" (Sept data,
  // M+2 publication = late Nov 2023). By Feb 1 2024 — three months past
  // expected publication of Oct AND Nov data — staleness is unambiguous.
  // 154d > 90d budget: clearly trips.
  const FIXED_FUTURE = Date.UTC(2024, 1, 1);     // Feb 1 2024 UTC
  const cm = ieaOilStocksContentMeta({ dataMonth: '2023-09' }, FIXED_FUTURE);
  const ageMin = (FIXED_FUTURE - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin > IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN,
    `Sept 2023 data on Feb 1 2024: ${Math.round(ageMin / 60 / 24)}d > ${IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN / 60 / 24}d budget — STALE_CONTENT trips`,
  );
});
