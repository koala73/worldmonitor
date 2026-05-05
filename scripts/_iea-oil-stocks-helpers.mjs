// Sprint 3b — content-age helpers for seed-iea-oil-stocks.mjs.
//
// Why a separate module: tests can't import seed-iea-oil-stocks.mjs directly
// (its `if (isMain) runSeed(...)` block runs the seed when `node` invokes
// the file, but the parsers/helpers are exported so importing the module
// itself is safe — top-level side-effects are guarded). However, to stay
// consistent with the Sprint 2/3a pattern (single source of truth shared
// by seeder + tests), the contentMeta + dataMonth parser live here.
//
// Shape contract: IEA oil stocks is a SINGLE-SNAPSHOT seeder. The fetcher
// returns `{members: [...], dataMonth: "YYYY-MM", seededAt: ISO-string}`.
// Every member shares the same `dataMonth` (the IEA observation period
// that all rows describe). There is no per-member published-at — the
// content-age signal is the single `dataMonth` string at the top level.
//
// `seededAt` is NOT a content timestamp — it's `new Date().toISOString()`
// captured at seed-run time, used only for cache-key bookkeeping.

/**
 * Convert a "YYYY-MM" dataMonth string to end-of-month UTC ms.
 *
 * The IEA monthly oil stocks report describes activity DURING the named
 * month, so the latest observation in dataMonth=2024-08 is August 31.
 * End-of-month is the most defensible "newestItemAt" — it represents the
 * last possible date the report could be observing.
 *
 * Returns null when input shape is unexpected — defensive against upstream
 * yearMonth parsing drift.
 *
 * @param {string} dataMonth - e.g. "2024-08"
 */
export function dataMonthToEndOfMonthMs(dataMonth) {
  if (typeof dataMonth !== 'string' || !/^\d{4}-\d{2}$/.test(dataMonth)) return null;
  const [year, month] = dataMonth.split('-').map(Number);
  if (month < 1 || month > 12) return null;
  // Date.UTC month is 0-indexed; passing month (NOT month-1) and day=0
  // gives the last day of the named month (e.g. month=8 → Aug 31 not Sep 0).
  return Date.UTC(year, month, 0, 23, 59, 59, 999);
}

/**
 * Compute newest/oldest content timestamps from the IEA oil stocks payload.
 *
 * Single-snapshot seeder: every member shares one dataMonth, so newest ===
 * oldest. We mirror the disease-outbreaks/climate-news return shape for
 * Sprint 1 mirror parity (api/_seed-envelope.js + server/_shared/seed-envelope.ts
 * expect both fields).
 *
 * Returns null when:
 *   - data.dataMonth is missing or unparseable
 *   - the parsed timestamp is in the future beyond 1h clock-skew tolerance
 *     (defensive against upstream "yearMonth" garbage that produces e.g.
 *     a 2099-12 dataMonth — would otherwise falsely report fresh content)
 *
 * @param {{dataMonth: string, members: Array}} data
 * @param {number} nowMs - injectable "now" for deterministic tests
 */
export function ieaOilStocksContentMeta(data, nowMs = Date.now()) {
  const ts = dataMonthToEndOfMonthMs(data?.dataMonth);
  if (ts == null) return null;
  const skewLimit = nowMs + 60 * 60 * 1000;
  if (ts > skewLimit) return null;
  return { newestItemAt: ts, oldestItemAt: ts };
}

/**
 * Sprint 3b pilot threshold (90 days).
 *
 * IEA monthly oil stocks publish on an M+2 cadence — August data
 * (`dataMonth = "2024-08"`, end-of-month = Aug 31) ships in late Oct
 * / early Nov, which is ~60-65 days AFTER end-of-observation-month.
 * That means at fresh-arrival the helper's `newestItemAt` is already
 * 60d old, before any real staleness has accrued.
 *
 * The budget therefore needs ~60d to cover the natural M+2 lag PLUS
 * ~30d slack for one missed publication = 90d total. STALE_CONTENT
 * trips when a month is missed entirely (e.g. cache stuck at
 * "2024-08" past mid-Jan when "2024-10" should have landed).
 *
 * (Sprint 3b initial PR shipped 45d, which would have fired
 * STALE_CONTENT on every fresh seed because 45d < natural lag.
 * Greptile P1 caught it; #3599 review.)
 */
export const IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN = 90 * 24 * 60;
