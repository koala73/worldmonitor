// Sprint 4 — content-age helpers for seed-power-reliability.mjs.
//
// Why a separate module: same as Sprint 2/3a/3b — tests need to import the
// real production code instead of replicating it; otherwise the
// in-memory↔canonical contract can drift silently.
//
// Shape contract (different from Sprint 2/3a per-item arrays AND from
// Sprint 3b single-snapshot period):
//
//   data.countries: { US: { value: 5.4, year: 2024 }, KW: { value: 8.1, year: 2023 }, ... }
//   data.seededAt:  ISO timestamp (seeder-run wall clock — NOT content age)
//
// Each country reports its OWN year. WB indicators publish annually but
// late-reporters (KW/QA/AE) lag G7 by 1-2 years. The "content-age" signal
// is therefore the MAX year across all countries (the freshest data point
// the cache has seen anywhere) — once year-(N+1) data lands for any
// country, newestItemAt advances and the staleness clock resets.
//
// `seededAt` is NOT a content timestamp. It's `new Date().toISOString()`
// captured at seed-run time, used for cache-key bookkeeping. Same trap as
// Sprint 3b's iea-oil-stocks: confusing it with content age would defeat
// the entire content-age probe — a healthy seeder cron would always show
// "fresh" while the underlying WB data hadn't published a new year in
// months.

/**
 * Convert a year (number or numeric string like "2024") to end-of-year UTC ms.
 *
 * The WB indicator value labelled `"2024"` represents observations DURING
 * that calendar year, so the latest possible observation date is Dec 31.
 * End-of-year is the most defensible "newestItemAt" — it represents the
 * last possible date the report could be observing. Mirrors the
 * Sprint 3b end-of-period rationale.
 *
 * Returns null when input shape is unexpected — defensive against upstream
 * `record.date` parsing drift (WB API has been known to return null/empty
 * date for in-progress observations).
 *
 * @param {number|string} year
 */
export function yearToEndOfYearMs(year) {
  const n = typeof year === 'string' ? Number(year) : year;
  if (!Number.isInteger(n) || n < 1900 || n > 9999) return null;
  return Date.UTC(n, 11, 31, 23, 59, 59, 999);
}

/**
 * Compute newest/oldest content timestamps from the per-country payload.
 *
 * - newestItemAt = end-of-year(max year across countries) — drives staleness
 * - oldestItemAt = end-of-year(min year across countries) — informational,
 *   surfaces "how stretched is the per-country reporting cohort"
 * - Returns null when no country has a usable year — runSeed writes
 *   newestItemAt: null, classifier reads as STALE_CONTENT.
 * - Excludes future-dated years beyond 1h clock-skew tolerance (defensive
 *   against upstream year=2099 garbage that would otherwise falsely report
 *   fresh).
 *
 * @param {{countries: Record<string, {year: number}>}} data
 * @param {number} nowMs - injectable "now" for deterministic tests
 */
export function powerReliabilityContentMeta(data, nowMs = Date.now()) {
  const countries = data?.countries;
  if (!countries || typeof countries !== 'object') return null;
  const skewLimit = nowMs + 60 * 60 * 1000;
  let newest = -Infinity, oldest = Infinity, validCount = 0;
  for (const entry of Object.values(countries)) {
    const ts = yearToEndOfYearMs(entry?.year);
    if (ts == null) continue;
    if (ts > skewLimit) continue;
    validCount++;
    if (ts > newest) newest = ts;
    if (ts < oldest) oldest = ts;
  }
  if (validCount === 0) return null;
  return { newestItemAt: newest, oldestItemAt: oldest };
}

/**
 * Sprint 4 pilot threshold (24 months / 730 days, expressed in minutes).
 *
 * Why 24 months — verified against live WB data 2026-05-05:
 *
 *   curl https://api.worldbank.org/v2/country/USA;CHN;...;KWT/indicator/EG.ELC.LOSS.ZS
 *
 * On that date G7 max year was 2024 (end-of-2024 = Dec 31 2024 = ~17
 * months before the seed run). Plan §477-485 originally proposed 13
 * months but that's structurally wrong: WB year-N data lands in cache
 * 12-18 months after end-of-N (publication lag varies), so a 13-month
 * budget would have tripped STALE_CONTENT immediately on every successful
 * fresh-arrival — same trap Greptile P1 caught on Sprint 3b PR #3599.
 *
 * Steady-state model:
 *   - Year N data lands at age = 12-18 months (publication lag)
 *   - Year (N+1) data lands ~12 months later, resetting the clock
 *   - Worst case during steady state: age = ~30 months (just before next
 *     year drops AND publication lag is at upper end)
 *   - 24-month budget catches catastrophic stalls (>2y silent upstream)
 *     without false-positive paging during normal "between publications"
 *
 * If a future migration uses an indicator with worse publication lag
 * (some WB indicators like FI.RES.TOTL.MO publish on Q+2 quarterly so
 * are fresher; others lag 24+ months), bump per-indicator. Don't reuse
 * this constant blindly across the 4-indicator Sprint 4 cohort —
 * audit each one's actual fresh-arrival age.
 */
export const POWER_RELIABILITY_MAX_CONTENT_AGE_MIN = 24 * 30 * 24 * 60;
