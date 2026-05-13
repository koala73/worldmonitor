/**
 * Live-news v3 refresh — pulls news items from World News API's
 * search-news endpoint and merges them into a Redis-backed accumulator.
 *
 * # Why search-news only
 *
 * The earlier draft of this file also called `top-news` for clustered
 * multi-source canonicals. That endpoint is reserved for a later
 * milestone — for now we want raw volume from search-news, and rely
 * on the enrichment cron to fill summary/region/location.
 *
 * # Pipeline
 *
 *   1. Call search-news with a broad anglophone filter over the last
 *      ~3 hours. ~100 single-source articles per tick.
 *   2. Map each article → LiveNewsV3Item with `sources: [self]`.
 *   3. Merge into the existing Redis accumulator, idempotent on the
 *      stable article `id`. The enrichment cron later fills `summary`,
 *      `region`, `country`, `location`, `locationName`; subsequent
 *      refreshes preserve those fields.
 *   4. Drop items older than the rolling window (24 h). Cap total size.
 *
 * # Caching
 *
 *   Single Redis key:  live-news:wn:v1:digest
 *   TTL:               7 days (defensive — the cron rewrites it every 5
 *                      min, so the TTL only matters if the cron stops).
 *
 * # Failure mode
 *
 *   On API failure the cron returns `{ status: 'skipped' }`. The Redis
 *   accumulator keeps its last good payload, so the read endpoint keeps
 *   serving it. A 24-hour upstream outage is the worst case before the
 *   accumulator starts trimming items.
 */

import { searchNews, deriveSource, parsePublishDate, type WorldNewsArticle } from '../../_shared/worldnews-client';
import { getCachedJson, setCachedJson } from '../../_shared/redis';
import { sha256Hex } from '../../_shared/hash';

const DIGEST_KEY = 'live-news:wn:v1:digest';
const DIGEST_TTL_S = 7 * 24 * 60 * 60;  // 7 days
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 500;

/**
 * How far back the broad search-news pull reaches. The cron fires every
 * 5 min, so a 45-min window gives us a 9× overlap — enough slack to
 * cover Vercel cron drift (~30 s typical, up to several min worst case),
 * worldnewsapi's indexing lag (~5–10 min between publish and searchable),
 * and the occasional skipped tick — without re-fetching three hours of
 * already-accumulated articles on every call.
 */
const BROAD_SEARCH_WINDOW_HOURS = 0.75;
const BROAD_SEARCH_NUMBER = 100;            // max page size — 100 × 0.01 = 1 pt over the base
/** Anglophone source-countries — same audience scope as legacy v2's US RSS feeds,
 *  widened slightly so iOS users see Reuters UK + Guardian AU coverage too. */
const BROAD_SEARCH_COUNTRIES = 'us,gb,au,ca';

/**
 * Internal wire shape for one outlet on a story. Mirrors the v2 shape
 * (`AlternateSource` in server/live-news/v1/_dedup.ts) so iOS clients
 * decode v2 and v3 with the same struct.
 */
export interface LiveNewsV3Source {
  source: string;
  title: string;
  link: string;
  publishedAt: number;
}

/**
 * Top-level item shape. Field-compatible with v2 `LiveNewsItemWithSources`
 * so iOS reuses the existing NewsItem decoder. Enrichment-only fields
 * (`location`, `summary`, `isConflict`, etc.) start as null and may be
 * filled later by the enrichment cron — same pattern as v2.
 */
export interface LiveNewsV3Item {
  /** Stable worldnewsapi article id — used as the merge key on refresh. */
  id: number;
  source: string;          // bare host, e.g. "reuters.com"
  title: string;
  link: string;            // real article URL (no scrub on v3)
  publishedAt: number;     // ms since epoch
  isAlert: boolean;        // currently always false — API has no breaking flag
  titleHash: string;       // sha256 of normalized title, for enrichment cache reuse
  // Enrichment fields — populated later (or left null indefinitely)
  location: { latitude: number; longitude: number } | null;
  locationName: string | null;
  confidence: number | null;
  country: string | null;
  region?: string;
  summary: string | null;  // initial value comes from the API's `summary` field
  rawDescription: string | null;
  isConflict: boolean | null;
  sources: LiveNewsV3Source[];
}

export interface RefreshResult {
  status: 'ok' | 'skipped';
  fetched: number;
  merged: number;
  totalAfter: number;
  generatedAt: string;
  /** Diagnostic — non-fatal mapping skips (bad URL, missing title, etc.). */
  dropped: number;
}

function normalizeTitleForHash(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Map one upstream article into a `LiveNewsV3Source` entry. Returns null
 * if the article is missing required fields (we'd rather drop the entry
 * than ship a half-built source line to iOS).
 */
function mapToSource(a: WorldNewsArticle): LiveNewsV3Source | null {
  const source = deriveSource(a.url);
  const publishedAt = parsePublishDate(a.publish_date);
  if (!source || !a.title || !a.url || publishedAt === null) return null;
  return {
    source,
    title: a.title,
    link: a.url,
    publishedAt,
  };
}

/**
 * Merge new items with whatever is already in the accumulator. Identity
 * is the stable worldnewsapi `id` — same id wins. On a hit we preserve
 * every enrichment field the previous run accumulated; we only refresh
 * the cluster's source list, the canonical title/link, and publishedAt.
 */
function mergeItems(existing: LiveNewsV3Item[], fresh: LiveNewsV3Item[]): LiveNewsV3Item[] {
  const byId = new Map<number, LiveNewsV3Item>();
  for (const item of existing) {
    if (typeof item?.id === 'number') byId.set(item.id, item);
  }
  for (const next of fresh) {
    const prev = byId.get(next.id);
    if (!prev) {
      byId.set(next.id, next);
      continue;
    }
    // Preserve enrichment from the previous run; take everything else fresh.
    byId.set(next.id, {
      ...next,
      location: prev.location ?? next.location,
      locationName: prev.locationName ?? next.locationName,
      confidence: prev.confidence ?? next.confidence,
      country: prev.country ?? next.country,
      region: prev.region ?? next.region,
      // Summary always tracks the upstream licensed API — never preserve
      // a prior value (which could be an old LLM-generated rewrite from
      // before the license terms changed). If the API later stops shipping
      // a summary for an article, we accept the regression rather than
      // serve a non-licensed paraphrase.
      summary: next.summary,
      isConflict: prev.isConflict ?? next.isConflict,
    });
  }
  // Drop items past the rolling window, then sort newest-first and cap.
  const cutoff = Date.now() - ROLLING_WINDOW_MS;
  return Array.from(byId.values())
    .filter((it) => it.publishedAt >= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, MAX_ITEMS);
}

/**
 * Map one upstream search-news article into a wire item. Single-source —
 * `sources[]` is `[self]` because search-news doesn't ship cluster info.
 */
async function articleToItem(a: WorldNewsArticle): Promise<LiveNewsV3Item | null> {
  const self = mapToSource(a);
  if (!self) return null;
  const titleHash = await sha256Hex(normalizeTitleForHash(self.title));
  return {
    id: a.id,
    source: self.source,
    title: self.title,
    link: self.link,
    publishedAt: self.publishedAt,
    isAlert: false,
    titleHash,
    location: null,
    locationName: null,
    confidence: null,
    country: null,
    summary: a.summary?.trim() || null,
    rawDescription: null,
    isConflict: null,
    sources: [self],
  };
}

/**
 * Cron entry point. One search-news call per tick — broad anglophone
 * pull over the last few hours, ~100 single-source items.
 *
 * Idempotent — safe to invoke at any cadence; running faster than the
 * 5-min schedule just spends extra worldnewsapi points.
 */
export async function refreshLiveNewsV3(): Promise<RefreshResult> {
  const startedAt = Date.now();

  const earliestPublishDate = formatWorldNewsDate(Date.now() - BROAD_SEARCH_WINDOW_HOURS * 60 * 60 * 1000);

  const searchResp = await searchNews({
    language: 'en',
    sourceCountries: BROAD_SEARCH_COUNTRIES,
    earliestPublishDate,
    sort: 'publish-time',
    sortDirection: 'DESC',
    number: BROAD_SEARCH_NUMBER,
  });

  if (!searchResp) {
    // Failed — the client already logged. Accumulator stays as-is.
    return {
      status: 'skipped',
      fetched: 0,
      merged: 0,
      totalAfter: 0,
      dropped: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  const fresh: LiveNewsV3Item[] = [];
  let dropped = 0;
  for (const a of searchResp.news ?? []) {
    const item = await articleToItem(a);
    if (item) fresh.push(item);
    else dropped++;
  }

  const existing = ((await getCachedJson(DIGEST_KEY)) as LiveNewsV3Item[] | null) ?? [];
  const merged = mergeItems(existing, fresh);

  await setCachedJson(DIGEST_KEY, merged, DIGEST_TTL_S);

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[live-news:v3:refresh] search=${searchResp.news?.length ?? 0} ` +
    `fresh=${fresh.length} existed=${existing.length} after=${merged.length} ` +
    `dropped=${dropped} in ${elapsedMs}ms`,
  );

  return {
    status: 'ok',
    fetched: fresh.length,
    merged: fresh.length,
    totalAfter: merged.length,
    dropped,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Format a JS millisecond timestamp into the World News API's expected
 * date string: `YYYY-MM-DD HH:MM:SS` in UTC.
 */
function formatWorldNewsDate(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
}
