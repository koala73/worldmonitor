// Sprint 4 IMF/WEO cohort — content-age helper for IMF SDMX/WEO seeders.
//
// Why a separate module from `_wb-country-dict-content-age-helpers.mjs`:
// the per-country dict shape is the same, but `year` semantics are NOT.
// WB indicators store the OBSERVED year (Dec 31 of "year" is the latest
// observation date). IMF/WEO stores a FORECAST horizon — the seeder's
// `weoYears()` returns `[currentYear, currentYear-1, currentYear-2]` and
// `latestValue()` picks the first year that has a finite value. So the
// stored `year` is the most distant horizon for which IMF has published a
// forecast — it is NOT an observation date.
//
// Concretely: in May 2026, after the April 2026 WEO release, max stored
// year = 2026. End-of-2026 = Dec 31 2026 is 7 MONTHS IN THE FUTURE relative
// to NOW. Reusing `_wb-country-dict-content-age-helpers.mjs`'s end-of-year
// math + 1h skew limit would reject every fresh IMF cache as "future-dated
// garbage." That's the failure mode this module avoids.
//
// Mapping rationale: forecast year N → end-of-(N - 1) UTC ms.
//   Reads as: "the most recent fully-observed period that backs this
//   forecast vintage." For year=2026 → end-of-2025 = Dec 31 2025. That's
//   ~5 months ago in May 2026 — sensible "newestItemAt" for a 2026
//   forecast. For year=2024 → end-of-2023 = ~29mo ago in May 2026 —
//   correctly stale, signals IMF hasn't updated forecasts in over a year.
//
// Four production seeders match this contract (all use `latestValue()`
// + `weoYears()` from `_seed-utils.mjs`):
//   - seed-imf-external.mjs (BCA, TM_RPCH, TX_RPCH)
//   - seed-imf-growth.mjs (NGDP_RPCH, NGDPDPC, NGDP_R, PPPPC, PPPGDP, NID_NGDP, NGSD_NGDP)
//   - seed-imf-labor.mjs (LUR, LP)
//   - seed-imf-macro.mjs (PCPIPCH, BCA_NGDPD, GGR_NGDP, PCPI, PCPIEPCH, GGX_NGDP, GGXONLB_NGDP)
//
// All four use the same publication cadence (WEO April + October vintages)
// and therefore the same budget. Per-seeder budget overrides are NOT needed
// here — distinct from the WB cohort where FOSL.ZS publishes slower than
// LOSS/NUCL/HYRO. If a future IMF series migrates with a different cadence
// (e.g. monthly IFS data), it should NOT reuse this module.

/**
 * Convert an IMF forecast year to "newestItemAt" UTC ms.
 *
 * Maps forecast year N → end-of-(N - 1). Encodes: "the latest observation
 * period this forecast vintage is built on." Avoids the future-dated trap
 * that end-of-N would produce for current-year forecasts (e.g. year=2026
 * in May 2026 → end-of-2026 = 7mo future).
 *
 * Returns null on invalid shape — defensive.
 *
 * @param {number|string} year - forecast year stored by IMF seeders' `latestValue()`
 */
export function imfForecastYearToMs(year) {
  const n = typeof year === 'string' ? Number(year) : year;
  if (!Number.isInteger(n) || n < 1900 || n > 9999) return null;
  return Date.UTC(n - 1, 11, 31, 23, 59, 59, 999);
}

/**
 * Compute newest/oldest content timestamps from an IMF/WEO per-country dict.
 *
 * - newestItemAt = end-of-(MAX year - 1) — drives staleness against the
 *   freshest forecast horizon stored.
 * - oldestItemAt = end-of-(MIN year - 1) — informational; surfaces how
 *   stretched the per-country forecast cohort is.
 * - Returns null when no country has a usable year.
 * - 1h clock-skew tolerance — under the seeder's current `weoYears()`
 *   (`[currentYear, currentYear-1, currentYear-2]`), max year = currentYear,
 *   so end-of-(year - 1) is always ≤ Dec 31 of last calendar year, never
 *   future. The skew check is defensive against a future seeder change
 *   that extends the forecast horizon (e.g. `currentYear + 1`).
 *
 * @param {{countries: Record<string, {year: number}>}} data
 * @param {number} nowMs - injectable "now" for deterministic tests
 */
export function imfWeoContentMeta(data, nowMs = Date.now()) {
  const countries = data?.countries;
  if (!countries || typeof countries !== 'object') return null;
  const skewLimit = nowMs + 60 * 60 * 1000;
  let newest = -Infinity, oldest = Infinity, validCount = 0;
  for (const entry of Object.values(countries)) {
    const ts = imfForecastYearToMs(entry?.year);
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
 * IMF/WEO budget (18 thirty-day months ≈ 540 days).
 *
 * IMF WEO publishes ~April and ~October each year, each vintage labeled
 * with `currentYear` as its frontmost forecast horizon. So `max year` in
 * the cache advances at most twice per year.
 *
 * Steady-state model under the helper's "year → end-of-(year-1)" mapping:
 *   - After April N release: max year = N → newestItemAt = end-of-(N-1).
 *     Age = ~5 months (Jan-May of year N).
 *   - After October N release: max year still = N → age = ~11 months.
 *   - Just before April N+1 release: max year still = N → age = ~16 months.
 *   - After April N+1: max year advances to N+1 → newestItemAt resets to
 *     end-of-N → age = ~5 months again.
 *
 * Steady-state ceiling = 16 months (just before April release of N+1).
 * Budget = 16mo ceiling + 2mo slack = 18 months. STALE_CONTENT trips when
 * a full year of WEO releases is missed (both April AND October), which
 * is the right pager threshold for an IMF outage.
 */
export const IMF_WEO_MAX_CONTENT_AGE_MIN = 18 * 30 * 24 * 60;
