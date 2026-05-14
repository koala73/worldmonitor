/**
 * Live-news v5 refresh — Newscatcher News API pipeline.
 *
 * Sits alongside v3 (World News API) and v4 (Webz.io) so all three
 * pipelines can be evaluated side-by-side via the debug picker in iOS.
 *
 * # Pipeline
 *
 *   1. POST /api/latest_headlines with clustering on. Returns ~N clusters,
 *      each containing one or more articles about the same story.
 *   2. Map each cluster → one `LiveNewsV5Item`:
 *      • canonical fields come from `cluster.articles[0]` (highest-rank
 *        outlet, per Newscatcher's ranking)
 *      • `sources[]` lists every outlet in the cluster
 *      • `summary` is taken from `nlp.summary` (license-safe API content)
 *      • `locationName` defaults to the top-mentioned NER location
 *      • Enrichment fields (location lat/lng, region, country, isConflict)
 *        start null — filled later by the location-only enrichment cron.
 *   3. Merge into `live-news:nc:v1:digest` by `cluster_id`; preserve
 *      enrichment fields from prior runs.
 *   4. Prune past the 24h rolling window; cap.
 *
 * # Caching
 *
 *   Single Redis key:  live-news:nc:v1:digest
 *   TTL:               7 days
 *
 * # Failure mode
 *
 *   On API failure the cron returns `{ status: 'skipped' }`. The Redis
 *   accumulator keeps its last good payload.
 */

import {
  latestHeadlines,
  deriveSource,
  deriveSummary,
  deriveLocationName,
  parsePublishDate,
  isClusteredResponse,
  type NewscatcherArticle,
  type NewscatcherCluster,
} from '../../_shared/newscatcher-client';
import { getCachedJson, setCachedJson } from '../../_shared/redis';
import { sha256Hex } from '../../_shared/hash';

const DIGEST_KEY = 'live-news:nc:v1:digest';
const DIGEST_TTL_S = 7 * 24 * 60 * 60;
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 500;

const HEADLINES_WINDOW = '3h';
const HEADLINES_LANG = 'en';
const HEADLINES_COUNTRIES = 'US,GB,AU,CA';
/** 0.7 is Newscatcher's default — broad clusters group different angles
 *  of the same story without merging adjacent topics. */
const CLUSTERING_THRESHOLD = 0.7;
/** Trial / Lite tier — request size kept modest to fit conservative quotas. */
const PAGE_SIZE = 50;

/** Per-source representation matching the v3/v4 wire shape so the iOS
 *  NewsItem Codable decodes all live-news endpoints identically. */
export interface LiveNewsV5Source {
  source: string;
  title: string;
  link: string;
  publishedAt: number;
}

/** Top-level item — wire-compatible with v3 / v4 / v2. `id` is the
 *  Newscatcher `cluster_id` (string), used as the merge key. */
export interface LiveNewsV5Item {
  id: string;
  source: string;
  title: string;
  link: string;
  publishedAt: number;
  isAlert: boolean;
  titleHash: string;
  // Enrichment-only fields.
  location: { latitude: number; longitude: number } | null;
  locationName: string | null;
  confidence: number | null;
  country: string | null;
  region?: string;
  summary: string | null;          // from nlp.summary (license-safe API content)
  rawDescription: string | null;
  isConflict: boolean | null;
  sources: LiveNewsV5Source[];
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

function mapToSource(a: NewscatcherArticle): LiveNewsV5Source | null {
  const source = deriveSource(a);
  const publishedAt = parsePublishDate(a.published_date);
  if (!source || !a.title || !a.link || publishedAt === null) return null;
  return { source, title: a.title, link: a.link, publishedAt };
}

/**
 * Map a Newscatcher cluster → one feed item. The first article in the
 * cluster is treated as canonical; every article (including the
 * canonical) becomes a `sources[]` entry. The location label and
 * summary come from the canonical's NLP data.
 */
async function clusterToItem(cluster: NewscatcherCluster): Promise<LiveNewsV5Item | null> {
  const articles = cluster.articles ?? [];
  if (articles.length === 0) return null;

  const sources: LiveNewsV5Source[] = [];
  for (const a of articles) {
    const s = mapToSource(a);
    if (s) sources.push(s);
  }
  if (sources.length === 0) return null;

  const canonical = articles[0]!;
  const lead = sources[0]!;
  const titleHash = await sha256Hex(normalizeTitleForHash(lead.title));

  return {
    id: cluster.cluster_id,
    source: lead.source,
    title: lead.title,
    link: lead.link,
    publishedAt: lead.publishedAt,
    isAlert: false,                                  // no breaking flag from Newscatcher
    titleHash,
    location: null,
    locationName: deriveLocationName(canonical),     // top NER location, or null
    confidence: null,
    country: null,
    summary: deriveSummary(canonical),               // nlp.summary verbatim
    rawDescription: null,
    isConflict: null,
    sources,
  };
}

function mergeItems(existing: LiveNewsV5Item[], fresh: LiveNewsV5Item[]): LiveNewsV5Item[] {
  const byId = new Map<string, LiveNewsV5Item>();
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
      locationName: prev.locationName ?? next.locationName,
      confidence: prev.confidence ?? next.confidence,
      country: prev.country ?? next.country,
      region: prev.region ?? next.region,
      // Summary tracks the upstream — never preserve a prior value
      // (defensive against legacy LLM-summary contamination).
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

export async function refreshLiveNewsV5(): Promise<RefreshResult> {
  const startedAt = Date.now();

  const resp = await latestHeadlines({
    when: HEADLINES_WINDOW,
    lang: HEADLINES_LANG,
    countries: HEADLINES_COUNTRIES,
    include_nlp_data: true,
    clustering_enabled: true,
    clustering_threshold: CLUSTERING_THRESHOLD,
    page_size: PAGE_SIZE,
  });

  if (!resp || !isClusteredResponse(resp)) {
    return {
      status: 'skipped',
      fetched: 0,
      totalAfter: 0,
      dropped: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  const fresh: LiveNewsV5Item[] = [];
  let dropped = 0;
  for (const cluster of resp.clusters ?? []) {
    const item = await clusterToItem(cluster);
    if (item) fresh.push(item);
    else dropped++;
  }

  const existing = ((await getCachedJson(DIGEST_KEY)) as LiveNewsV5Item[] | null) ?? [];
  const merged = mergeItems(existing, fresh);
  await setCachedJson(DIGEST_KEY, merged, DIGEST_TTL_S);

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[live-news:v5:refresh] clusters=${resp.clusters?.length ?? 0} ` +
    `total_hits=${resp.total_hits} fresh=${fresh.length} ` +
    `existed=${existing.length} after=${merged.length} ` +
    `dropped=${dropped} in ${elapsedMs}ms`,
  );

  return {
    status: 'ok',
    fetched: fresh.length,
    totalAfter: merged.length,
    dropped,
    generatedAt: new Date().toISOString(),
  };
}
