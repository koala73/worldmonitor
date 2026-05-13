/**
 * Live-news v3 refresh — pulls clustered top stories from World News API
 * (the new paid feed) and writes them into a Redis-backed accumulator.
 *
 * Why v3 instead of patching v2:
 *   • v2 pulls 15 RSS feeds and runs LLM dedup to cluster the same story
 *     across outlets. v3 gets the clustering free from the upstream API.
 *   • v2's response goes through a source/link scrub (we shadow outlet
 *     identity for legal reasons on the unlicensed RSS pipe). The v3
 *     upstream is a paid licensed feed — we ship the real source and
 *     the real article URL.
 *
 * The two pipelines coexist while we TestFlight the iOS switch. Legacy
 * iOS builds keep reading /v2 with its scrub; TestFlight builds read /v3
 * with real outlet data. Once we cut over App Store, we can retire v2.
 *
 * # Pipeline
 *
 *   1. Call top-news?source-country=us&language=en — one call returns
 *      ~10 clusters, each with 1-10 articles about the same story.
 *   2. Map each cluster → one LiveNewsItemWithSources:
 *      • canonical = cluster.news[0]
 *      • sources[] = every article in the cluster
 *   3. Merge into the existing Redis accumulator, idempotent on article
 *      id — so when the enrichment cron later fills in location / lat /
 *      lng / isConflict on an item, a subsequent refresh doesn't clobber
 *      those fields. We update title/sources/publishedAt; we preserve
 *      everything that was enriched.
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

import { topNews, deriveSource, parsePublishDate, type WorldNewsArticle } from '../../_shared/worldnews-client';
import { getCachedJson, setCachedJson } from '../../_shared/redis';
import { sha256Hex } from '../../_shared/hash';

const DIGEST_KEY = 'live-news:wn:v1:digest';
const DIGEST_TTL_S = 7 * 24 * 60 * 60;  // 7 days
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 200;

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
 * Map one cluster (canonical + alternates) into our wire shape. The
 * canonical's enrichment fields stay null — they get filled later by
 * the enrichment cron. The API's `summary` field is preserved as the
 * initial summary; the enrichment LLM will only re-paraphrase items
 * with no summary.
 */
async function clusterToItem(cluster: { news: WorldNewsArticle[] }): Promise<LiveNewsV3Item | null> {
  if (!cluster.news || cluster.news.length === 0) return null;

  const sources: LiveNewsV3Source[] = [];
  for (const a of cluster.news) {
    const s = mapToSource(a);
    if (s) sources.push(s);
  }
  if (sources.length === 0) return null;

  const canonical = cluster.news[0]!;
  const lead = sources[0]!;
  // SHA-256 of normalized title — keeps us compatible with the existing
  // enrichment-cache key scheme so v3 items can hit cached summaries
  // from v2 enrichment of identical headlines.
  const titleHash = await sha256Hex(normalizeTitleForHash(lead.title));

  return {
    id: canonical.id,
    source: lead.source,
    title: lead.title,
    link: lead.link,
    publishedAt: lead.publishedAt,
    isAlert: false,
    titleHash,
    location: null,
    locationName: null,
    confidence: null,
    country: null,
    summary: canonical.summary?.trim() || null,
    rawDescription: null,
    isConflict: null,
    sources,
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
      // Summary preference: keep an enriched one if it exists, otherwise
      // take whatever the fresh fetch came with (often the API's own).
      summary: prev.summary ?? next.summary,
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
 * Cron entry point. Idempotent — safe to invoke at any cadence; running
 * faster than the 5-min schedule just wastes a few worldnewsapi points.
 */
export async function refreshLiveNewsV3(): Promise<RefreshResult> {
  const startedAt = Date.now();

  const upstream = await topNews({ sourceCountry: 'us', language: 'en' });
  if (!upstream) {
    // The client already logged the failure reason. Accumulator stays as-is.
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
  for (const cluster of upstream.top_news ?? []) {
    const item = await clusterToItem(cluster);
    if (item) fresh.push(item);
    else dropped++;
  }

  const existing = ((await getCachedJson(DIGEST_KEY)) as LiveNewsV3Item[] | null) ?? [];
  const merged = mergeItems(existing, fresh);

  await setCachedJson(DIGEST_KEY, merged, DIGEST_TTL_S);

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[live-news:v3:refresh] fetched=${fresh.length} merged=${merged.length} ` +
    `existed=${existing.length} dropped=${dropped} in ${elapsedMs}ms`,
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
