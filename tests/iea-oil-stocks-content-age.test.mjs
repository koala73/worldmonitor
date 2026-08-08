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

test('IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN is 150 days', () => {
  // 150d = ~100d natural ~M+4 lag at fresh-arrival + ~30d normal intra-cycle
  // aging + ~22d grace. See helper module's JSDoc for the iteration history
  // (45d → 90d → 120d → 150d). The 2026-06-06 bump from 120d → 150d followed
  // a live upstream probe: `https://api.iea.org/netimports/latest` returned
  // dataMonth "2026-02" (~97.7d old) as the NEWEST available month, with
  // `.../monthly/?year=2026&month=03` and `&month=04` returning `[]` (not yet
  // published). The prior cached month ("2026-01", ~125.7d) was breaching the
  // 120d budget despite no seeder/parse bug — IEA simply runs ~M+4, so 120d
  // false-fired near the end of every normal publication cycle.
  assert.equal(IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN, 150 * 24 * 60);
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

// ── Pilot threshold sanity (anti-drift on the 150-day budget) ───────────

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

test('pilot threshold: dataMonth ~14 days old is within 150-day budget (no false positive)', () => {
  // FIXED_NOW = 2023-11-14. "2023-10" → end-of-Oct = ~14d ago. Trivially fresh.
  const cm = ieaOilStocksContentMeta({ dataMonth: '2023-10' }, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin < IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN,
    `${Math.round(ageMin)}min < budget ${IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN}min — STALE_CONTENT does NOT fire on normal ~M+4 cadence`,
  );
});

test('live-cadence regression guard: ~M+4 freshest IEA data does NOT trip STALE_CONTENT', () => {
  // The exact false-positive the 2026-06-06 120d→150d bump fixed. Live probe
  // 2026-06-06: `https://api.iea.org/netimports/latest` → dataMonth "2026-02"
  // (~97.7d old) was the NEWEST available month (2026-03/04 empty upstream).
  // Worst case under steady cadence: that freshest snapshot must remain the
  // served value until 2026-03 publishes (~a month later), aging to ~128d.
  // A healthy cache at the END of its normal cycle MUST NOT page.
  const NOW = Date.UTC(2026, 6, 6);              // Jul 6 2026 — ~1mo after probe, before 2026-03 lands
  const cm = ieaOilStocksContentMeta({ dataMonth: '2026-02' }, NOW);
  const ageMin = (NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin < IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN,
    `2026-02 (freshest IEA month) aged to ${Math.round(ageMin / 60 / 24)}d < ${IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN / 60 / 24}d budget — normal ~M+4 cycle does NOT page`,
  );
});

test('threshold: dataMonth ~198d old (multiple missed publications) trips STALE_CONTENT', () => {
  // FIXED_NOW = 2023-11-14T22:13:20Z. "2023-04" → end-of-Apr = ~198d ago,
  // past the 150d budget. Simulates a genuine multi-month upstream freeze
  // (~2 months past the normal ~M+4 cycle) — on-call should be paged.
  // Pre-bump this test used "2023-05" (~168d) which was decisively past the
  // old 120d budget but only ~18d past the new 150d budget; pushed back one
  // month so the trip remains unambiguous.
  const cm = ieaOilStocksContentMeta({ dataMonth: '2023-04' }, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin > IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN,
    `${Math.round(ageMin / 60 / 24)}d > budget ${IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN / 60 / 24}d — STALE_CONTENT would fire`,
  );
});

test('threshold: ~M+4 data frozen ~2 extra months trips STALE_CONTENT', () => {
  // Realistic freeze incident: cache holds dataMonth="2023-08" (Aug data).
  // Under the normal ~M+4 cadence Aug would be the served value through ~Dec,
  // refreshed to Sep around Jan. By Mar 15 2024 — ~2 months past when Sep/Oct
  // data should have rolled in — staleness is unambiguous. ~197d > 150d
  // budget: clearly trips. Pre-bump this used Feb 1 2024 (~154d), only ~4d
  // past the new 150d budget — too close to the boundary to be a useful
  // regression guard. Pushed forward six weeks.
  const FIXED_FUTURE = Date.UTC(2024, 2, 15);    // Mar 15 2024 UTC
  const cm = ieaOilStocksContentMeta({ dataMonth: '2023-08' }, FIXED_FUTURE);
  const ageMin = (FIXED_FUTURE - cm.newestItemAt) / 60000;
  assert.ok(
    ageMin > IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN,
    `Aug 2023 data on Mar 15 2024: ${Math.round(ageMin / 60 / 24)}d > ${IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN / 60 / 24}d budget — STALE_CONTENT trips`,
  );
});
