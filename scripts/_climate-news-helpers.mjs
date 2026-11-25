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
 * Climate Central, ReliefWeb) collectively publish daily
 * to multiple-times-per-day. A 7-day budget tolerates a major holiday weekend
 * across all sources without paging on normal cadence — and trips on a real
 * upstream-aggregator outage where every feed's parse silently breaks.
 */
export const CLIMATE_NEWS_MAX_CONTENT_AGE_MIN = 7 * 24 * 60;

// Per-item age cap for the latest-news panel. Climate Central's feed still
// carries 2021-2022 articles that would otherwise fill the 100-item cap.
export const CLIMATE_NEWS_MAX_ITEM_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const OFF_EARTH_RE = /\b(mars|martian|rover|exoplanets?|jupiter|saturn|venus)\b/i;

// Applied to feeds whose scope is wider than climate (ReliefWeb's climate
// theme also tags generic humanitarian bulletins and AI-policy reports).
const CLIMATE_TOPIC_RE = /\b(climat\w*|clim[aá]tic\w*|weather|floods?|flooding|inondations?|inundaci\w*|droughts?|s[eé]cheresses?|sequ[ií]as?|heat\s*waves?|heatwaves?|extreme heat|canicul\w*|wildfires?|bushfires?|forest fires?|incendi\w*|cyclones?|hurricanes?|typhoons?|storms?|monsoons?|rainfall|el ni[nñ]o|la ni[nñ]a|emissions?|carbon|greenhouse|warming|sea[- ]level|glaciers?|deforestation|biodiversity|environment\w*|environnement\w*|disaster risk|resilience|adaptation)\b/i;

export function resolveReliefWebUrl(urlAlias) {
  if (typeof urlAlias !== 'string' || !urlAlias.trim()) return '';
  try {
    return new URL(urlAlias.trim(), 'https://reliefweb.int').href;
  } catch {
    return '';
  }
}

// `topics` carries source-side tags (ReliefWeb disaster types) that count as
// topic evidence but are not part of the published item.
export function isClimateNewsItemRelevant(item, { requireTopicMatch = false } = {}) {
  const text = `${item?.title || ''} ${item?.summary || ''}`;
  if (OFF_EARTH_RE.test(text)) return false;
  return !requireTopicMatch || CLIMATE_TOPIC_RE.test(`${text} ${(item?.topics || []).join(' ')}`);
}

/**
 * Merge per-feed results into the newest-first, URL-deduplicated panel list.
 *
 * @param {Array<{feed: {requireTopicMatch?: boolean}, items: Array}>} feedResults
 * @param {number} nowMs
 * @param {number} maxItems
 */
export function selectClimateNewsItems(feedResults, nowMs = Date.now(), maxItems = 100) {
  const oldestAllowed = nowMs - CLIMATE_NEWS_MAX_ITEM_AGE_MS;
  const candidates = [];
  for (const { feed, items } of feedResults) {
    for (const item of items) {
      if (!(item.publishedAt >= oldestAllowed)) continue;
      if (!isClimateNewsItemRelevant(item, feed)) continue;
      const { topics: _topics, ...published } = item;
      candidates.push(published);
    }
  }
  candidates.sort((a, b) => b.publishedAt - a.publishedAt);

  const seenUrls = new Set();
  const selected = [];
  for (const item of candidates) {
    if (seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);
    selected.push(item);
    if (selected.length >= maxItems) break;
  }
  return selected;
}
