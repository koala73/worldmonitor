// Sprint 3a — content-age helpers for seed-climate-news.mjs.
//
// Why a separate module instead of inlining in the seeder:
//
// Tests can't import `seed-climate-news.mjs` directly because its top-level
// runSeed() call exits the process on import. Extracting the pure contentMeta
// here is the same drift-prevention pattern Sprint 2 settled on for
// disease-outbreaks (see `_disease-outbreaks-helpers.mjs` header) — the
// seeder imports this, the test imports this, so a future change can't drift
// silently between the two.
//
// Climate-news is simpler than disease-outbreaks: the seeder already filters
// out items with `publishedAt: 0` at parse time (seed-climate-news.mjs:76 +
// :132), so there is NO synthetic-tagging risk and NO publishTransform
// stripping needed — `item.publishedAt` is always a real, parsed RSS pubDate
// (or its fallback chain: pubDate → published → updated → dc:date).

/**
 * Compute newest/oldest content timestamps from the climate-news payload.
 *
 * - Reads `item.publishedAt` directly (no _originalPublishedMs/_synthetic
 *   helpers because the seeder rejects undated items at parse time).
 * - Excludes future-dated items beyond 1h clock-skew tolerance — matches the
 *   tolerance disease-outbreaks (Sprint 2) and list-feed-digest's
 *   FUTURE_DATE_TOLERANCE_MS use.
 * - Returns null when no items have a usable timestamp — runSeed writes
 *   newestItemAt: null, classifier reads as STALE_CONTENT.
 *
 * @param {{items: Array}} data
 * @param {number} nowMs - injectable "now" for deterministic tests; defaults to Date.now()
 */
export function climateNewsContentMeta(data, nowMs = Date.now()) {
  const items = Array.isArray(data?.items) ? data.items : [];
  let newest = -Infinity, oldest = Infinity, validCount = 0;
  const skewLimit = nowMs + 60 * 60 * 1000;
  for (const item of items) {
    const ts = item.publishedAt;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) continue;
    if (ts > skewLimit) continue;
    validCount++;
    if (ts > newest) newest = ts;
    if (ts < oldest) oldest = ts;
  }
  if (validCount === 0) return null;
  return { newestItemAt: newest, oldestItemAt: oldest };
}

/**
 * Sprint 3a pilot threshold (7 days). Climate news from the listed feeds
 * (Carbon Brief, Guardian Environment, NASA EO, UNEP, Phys.org, Copernicus,
 * Inside Climate News, Climate Central, ReliefWeb) collectively publish daily
 * to multiple-times-per-day. A 7-day budget tolerates a major holiday weekend
 * across all sources without paging on normal cadence — and trips on a real
 * upstream-aggregator outage where every feed's parse silently breaks.
 */
export const CLIMATE_NEWS_MAX_CONTENT_AGE_MIN = 7 * 24 * 60;
