// Sprint 4 cohort follow-up — shared content-age helper for WB seeders that
// produce a per-country dict with each country carrying its own annual year.
//
// Shape contract:
//
//   { countries: { [ISO2]: { value: number, year: number } }, seededAt: string }
//
// Three production seeders match this shape (all WB indicators on annual
// cadence, all using mrv=5 + per-country latest-year selection):
//
//   - seed-power-reliability.mjs     (EG.ELC.LOSS.ZS)              — Sprint 4 PR #3602
//   - seed-low-carbon-generation.mjs (EG.ELC.NUCL.ZS + RNEW + HYRO,
//                                     summed value, MAX year of 3)
//   - seed-fossil-electricity-share.mjs (EG.ELC.FOSL.ZS)
//
// Why a shared helper instead of one per seeder: the contentMeta math is
// identical across all three (find max year across countries, convert to
// end-of-year UTC ms, apply 1h skew-limit). Only the BUDGET differs per
// indicator (publication lag varies — see the PR description for live-WB
// verification numbers). Each seeder imports this `wbCountryDictContentMeta`
// + brings its own `MAX_CONTENT_AGE_MIN` constant inline.
//
// Power-reliability still has its own `_power-reliability-helpers.mjs` for
// now (its PR #3602 is already in review; backporting can come as a
// follow-up after merge to keep that PR's diff focused). The math IS
// identical — verify with `diff`.

/**
 * Convert a year (number or numeric string like "2024") to end-of-year UTC ms.
 *
 * The WB indicator value labelled `"2024"` represents observations DURING
 * that calendar year, so the latest possible observation date is Dec 31.
 * End-of-year is the most defensible "newestItemAt".
 *
 * Returns null when input shape is unexpected — defensive against upstream
 * `record.date` parsing drift.
 *
 * @param {number|string} year
 */
export function yearToEndOfYearMs(year) {
  const n = typeof year === 'string' ? Number(year) : year;
  if (!Number.isInteger(n) || n < 1900 || n > 9999) return null;
  return Date.UTC(n, 11, 31, 23, 59, 59, 999);
}

/**
 * Compute newest/oldest content timestamps from a per-country dict payload.
 *
 * - newestItemAt = end-of-year(MAX year across countries) — drives staleness.
 *   Late-reporters (KW/QA/AE typically lag G7 by 1-2 years) do NOT drag
 *   the panel into STALE_CONTENT — once any country's year advances, the
 *   clock resets.
 * - oldestItemAt = end-of-year(MIN year across countries) — informational,
 *   surfaces "how stretched is the per-country reporting cohort."
 * - Returns null when no country has a usable year — runSeed writes
 *   newestItemAt: null, classifier reads as STALE_CONTENT.
 * - Excludes future-dated years beyond 1h clock-skew tolerance (defensive
 *   against upstream year=2099 garbage).
 *
 * @param {{countries: Record<string, {year: number}>}} data
 * @param {number} nowMs - injectable "now" for deterministic tests
 */
export function wbCountryDictContentMeta(data, nowMs = Date.now()) {
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
