/**
 * Live-news v4 refresh — Webz.io News API Lite pipeline.
 *
 * # Why v4 alongside v3
 *
 * v3 pulls from World News API; v4 pulls from Webz.io. Both write to
 * separate Redis keys so they can run in parallel for evaluation — the
 * iOS app can be pointed at either by changing the path in APIEndpoint.
 * Once Webz proves itself we keep v4 live and v3 stays as a fallback;
 * until then both are warm.
 *
 * # Pipeline
 *
 *   1. One search-news call per tick. `q=language:english thread.country:(US OR GB OR AU OR CA)`
 *   2. ~10 posts come back (Lite tier caps every call at 10 articles).
 *   3. Map each post → LiveNewsV4Item; sources[] is [self] (no clustering
 *      in Webz Lite output).
 *   4. Merge into `live-news:webz:v1:digest` idempotently by uuid.
 *      Preserves enrichment fields from prior runs.
 *   5. Drop items past the 24h rolling window, sort newest-first, cap.
 *
 * # Quota
 *
 *   Free Lite tier: 1,000 calls/month = ~33/day. The cron is intentionally
 *   slower than the v3 worldnews cron (every 30 min vs every 5 min) to
 *   stay under the monthly cap until a paid plan is in place. After paid,
 *   bump the schedule in vercel.json without changing any code here.
 *
 * # Caching
 *
 *   Single Redis key:  live-news:webz:v1:digest
 *   TTL:               7 days (defensive — cron rewrites every 30 min,
 *                      TTL only matters if the cron stops).
 *
 * # Failure mode
 *
 *   On API failure the cron returns `{ status: 'skipped' }`. The Redis
 *   accumulator keeps its last good payload, so the read endpoint keeps
 *   serving it.
 */

import { searchNews, deriveSource, parsePublishDate, deriveSummary, type WebzPost } from '../../_shared/webz-client';
import { getCachedJson, setCachedJson } from '../../_shared/redis';
import { sha256Hex } from '../../_shared/hash';

const DIGEST_KEY = 'live-news:webz:v1:digest';
const DIGEST_TTL_S = 3 * 24 * 60 * 60; // 3-day project max
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 500;

/** Lucene query — anglophone coverage matching the v3 worldnews cron. */
const LIVE_NEWS_QUERY = 'language:english thread.country:(US OR GB OR AU OR CA)';

/**
 * Per-source representation that matches the v3 wire shape, so iOS
 * `NewsItem` Codable decodes both endpoints without changes.
 */
export interface LiveNewsV4Source {
  source: string;
  title: string;
  link: string;
  publishedAt: number;
}

/**
 * Top-level item — wire-compatible with `LiveNewsV3Item` (and with the
 * legacy v2 `LiveNewsItemWithSources`) so iOS decodes all three. The
 * `id` is a string here (Webz uuid) rather than the number used by
 * v3 (worldnewsapi article id); iOS uses `link` as its identity so the
 * id type difference is invisible to the client.
 */
export interface LiveNewsV4Item {
  /** Webz uuid — used as the merge key on refresh. */
  id: string;
  source: string;
  title: string;
  link: string;
  publishedAt: number;
  isAlert: boolean;
  titleHash: string;
  // Enrichment fields — populated later by the enrich cron.
  location: { latitude: number; longitude: number } | null;
  locationName: string | null;
  confidence: number | null;
  country: string | null;
  region?: string;
  summary: string | null;
  rawDescription: string | null;
  isConflict: boolean | null;
  sources: LiveNewsV4Source[];
}

export interface RefreshResult {
  status: 'ok' | 'skipped';
  fetched: number;
  totalAfter: number;
  dropped: number;
  generatedAt: string;
}

function normalizeTitleForHash(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Map one Webz post to our wire item.
 *
 * Returns null if essential fields are missing (no source, no title, no
 * usable publish date). Better to drop than ship a half-built row.
 */
async function postToItem(p: WebzPost): Promise<LiveNewsV4Item | null> {
  const source = deriveSource(p);
  const publishedAt = parsePublishDate(p.published);
  if (!source || !p.title || !p.url || publishedAt === null) return null;

  const titleHash = await sha256Hex(normalizeTitleForHash(p.title));
  const self: LiveNewsV4Source = {
    source,
    title: p.title,
    link: p.url,
    publishedAt,
  };

  // `entities.locations` is a free signal from Webz — first listed
  // location goes into `locationName` so iOS rows get a label without
  // waiting for LLM enrichment. The LLM cron may overwrite with a
  // more precise place name later.
  const firstLoc = p.entities?.locations?.[0]?.name?.trim();
  const initialLocationName = firstLoc && firstLoc.length > 0 ? firstLoc : null;

  return {
    id: p.uuid,
    source,
    title: p.title,
    link: p.url,
    publishedAt,
    isAlert: !!p.breaking,
    titleHash,
    location: null,
    locationName: initialLocationName,
    confidence: null,
    country: null,
    summary: deriveSummary(p),
    rawDescription: null,
    isConflict: null,
    sources: [self],
  };
}

/**
 * Merge new items into the existing accumulator. Identity is the
 * stable Webz uuid. On hit, preserve every enrichment field — only
 * refresh title/link/sources/publishedAt/summary from the fresh fetch.
 *
 * `summary` is taken fresh (never preserved) so a stale LLM summary
 * from an earlier code version would be wiped — same legal-safety
 * rule as the v3 pipeline.
 */
function mergeItems(existing: LiveNewsV4Item[], fresh: LiveNewsV4Item[]): LiveNewsV4Item[] {
  const byId = new Map<string, LiveNewsV4Item>();
  for (const item of existing) {
    if (typeof item?.id === 'string') byId.set(item.id, item);
  }
  for (const next of fresh) {
    const prev = byId.get(next.id);
    if (!prev) {
      byId.set(next.id, next);
      continue;
    }
    byId.set(next.id, {
      ...next,
      location: prev.location ?? next.location,
      // locationName: prefer enrichment if present, else keep webz entity hint.
      locationName: prev.locationName ?? next.locationName,
      confidence: prev.confidence ?? next.confidence,
      country: prev.country ?? next.country,
      region: prev.region ?? next.region,
      summary: next.summary,
      isConflict: prev.isConflict ?? next.isConflict,
    });
  }
  const cutoff = Date.now() - ROLLING_WINDOW_MS;
  return Array.from(byId.values())
    .filter((it) => it.publishedAt >= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, MAX_ITEMS);
}

/**
 * Cron entry point. Idempotent — safe to invoke at any cadence; running
 * faster than the configured schedule just spends extra Webz quota.
 */
export async function refreshLiveNewsV4(): Promise<RefreshResult> {
  const startedAt = Date.now();

  const resp = await searchNews({ q: LIVE_NEWS_QUERY });
  if (!resp) {
    return {
      status: 'skipped',
      fetched: 0,
      totalAfter: 0,
      dropped: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  const fresh: LiveNewsV4Item[] = [];
  let dropped = 0;
  for (const p of resp.posts ?? []) {
    const item = await postToItem(p);
    if (item) fresh.push(item);
    else dropped++;
  }

  const existing = ((await getCachedJson(DIGEST_KEY)) as LiveNewsV4Item[] | null) ?? [];
  const merged = mergeItems(existing, fresh);
  await setCachedJson(DIGEST_KEY, merged, DIGEST_TTL_S);

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[live-news:v4:refresh] posts=${resp.posts?.length ?? 0} ` +
    `fresh=${fresh.length} existed=${existing.length} after=${merged.length} ` +
    `dropped=${dropped} requestsLeft=${resp.requestsLeft} in ${elapsedMs}ms`,
  );

  return {
    status: 'ok',
    fetched: fresh.length,
    totalAfter: merged.length,
    dropped,
    generatedAt: new Date().toISOString(),
  };
}
