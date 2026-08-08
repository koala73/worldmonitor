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
 * Threshold for STALE_CONTENT alerting (150 days / ~5 months).
 *
 * IEA monthly net-imports/oil-stocks publish on an observed ~M+4 cadence
 * (NOT the M+2 the earlier comment assumed). The latest available month is
 * ~3.5-4 calendar months behind end-of-observation-month, so the helper's
 * `newestItemAt` is already ~95-100d old at the moment the freshest
 * snapshot first arrives — before any real staleness has accrued.
 *
 * Budget breakdown: ~100d for the natural M+4 lag at fresh-arrival + ~30d
 * for normal intra-cycle aging (the freshest month must remain the served
 * value until the NEXT month publishes ~a month later, so a healthy cache
 * naturally reaches ~128d before the next publication lands) + ~22d grace.
 * STALE_CONTENT trips only when the cache is frozen ~2 months past the
 * normal cycle (a genuine multi-month upstream freeze or seeder failure).
 *
 * Iteration history:
 *   - Sprint 3b initial PR (#3599) shipped 45d, which would have
 *     fired STALE_CONTENT on every fresh seed because 45d < natural
 *     lag. Greptile P1 caught it.
 *   - Sprint 3b shipped at 90d (assumed 60d M+2 lag + 30d slack for one
 *     missed publication).
 *   - 2026-05-09: bumped to 120d after IEA delayed Feb 2026 data by
 *     >24 days past expected publish window. Direct probe of
 *     `https://api.iea.org/netimports/monthly/?year=2026&month=02`
 *     returned `[]` at that time (no data on the upstream itself).
 *   - 2026-06-06: bumped to 150d. Live probe of
 *     `https://api.iea.org/netimports/latest` returned dataMonth
 *     `2026-02` (end-of-Feb, content age ~97.7d on Jun 6) as the NEWEST
 *     available month; `2026-03`/`2026-04` monthly endpoints returned
 *     `[]` (not yet published). So the freshest data the seeder can
 *     possibly serve is ~98d old, and the prior cached month (`2026-01`,
 *     ~125.7d) was already breaching the 120d budget despite no seeder or
 *     parse bug — the upstream simply runs ~M+4. 120d false-fires near
 *     the end of every normal publication cycle (healthy cache reaches
 *     ~128d before the next month lands). 150d absorbs the real cadence
 *     while still catching a genuine ~2-month freeze.
 */
export const IEA_OIL_STOCKS_MAX_CONTENT_AGE_MIN = 150 * 24 * 60;
