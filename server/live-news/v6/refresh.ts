/**
 * v6 RSS refresh — self-hosted RSS clustering pipeline.
 *
 * Cadence: every 15 minutes. Each tick:
 *   1. Fetches 15 RSS feeds in parallel (per-feed Redis cache + 10-min TTL).
 *   2. Embeds new items via Gemini text-embedding-004 (free tier).
 *   3. Greedy-clusters at threshold 0.7.
 *   4. For each cluster, picks the longest plaintext description as
 *      the wire `summary` and the first available image as `imageUrl`.
 *   5. Merges into `live-news:v6:digest`, preserving enrichment fields
 *      from prior runs (location / region / country / isConflict).
 *
 * Enrichment runs separately in the intel-news enrich cron, with
 * `skipSummary: true` — LLM never generates a summary, only location +
 * region + isConflict. The license-safe approach.
 */

import { getCachedJson, setCachedJson } from '../../_shared/redis';
import { fetchAllFeeds, titleHashFor, type RawRssItem } from './_normalize';
import { clusterRssItems, type ClusteredItem } from './_cluster';

export const DIGEST_KEY = 'live-news:v6:digest';

// ── GDELT conflict candidates ──────────────────────────────────────────
//
// The intel-news GDELT cron writes theme-flagged conflict candidates to
// this key (see api/intel-news/v1/refresh.ts). We pull them into the
// SAME clustering pass as the RSS items so a GDELT story can attach to
// a trusted RSS cluster as corroboration. GDELT items never become a
// cluster's canonical, never contribute displayed content, and are
// gated out of any cluster that lacks ≥3 RSS publishers (read side).
const GDELT_CANDIDATES_KEY = 'gdelt:conflict-candidates:v1';

// GDELT category candidates — keyword-matched stories for the 9 non-conflict
// intel topics, written by api/intel-news/v1/refresh.ts. They cluster
// alongside RSS + conflict candidates; a cluster inherits a category when it
// has ≥1 RSS member + ≥1 category-tagged GDELT member.
const GDELT_CATEGORY_CANDIDATES_KEY = 'gdelt:category-candidates:v1';

/** Fixed high sourcePriority for GDELT items so they sort last anywhere
 *  priority matters. `pickCanonical` excludes them outright regardless. */
const GDELT_SOURCE_PRIORITY = 99;

/** Shape of entries in `gdelt:conflict-candidates:v1` — must match the
 *  `GdeltConflictCandidate` written by api/intel-news/v1/refresh.ts. */
interface GdeltConflictCandidate {
  title: string;
  link: string;
  source: string;
  publishedAt: number;
  location: { lat: number; lng: number; country: string | null; locationName: string | null } | null;
  sources: Array<{ source: string; title: string; link: string; publishedAt: number }>;
}

/** Shape of entries in `gdelt:category-candidates:v1` — must match the
 *  `GdeltCategoryCandidate` written by api/intel-news/v1/refresh.ts. */
interface GdeltCategoryCandidate {
  title: string;
  link: string;
  source: string;
  publishedAt: number;
  location: { lat: number; lng: number; country: string | null; locationName: string | null } | null;
  categories: string[];
  sources: Array<{ source: string; title: string; link: string; publishedAt: number }>;
}

/**
 * Load GDELT conflict candidates and convert them to `RawRssItem`s
 * tagged `origin: 'gdelt'` so they flow through the same clusterer.
 * titleHash is recomputed here with v6's own normalizer (don't trust
 * the cron's) so it lines up with RSS items.
 */
async function loadGdeltCandidates(): Promise<RawRssItem[]> {
  const raw = (await getCachedJson(GDELT_CANDIDATES_KEY)) as GdeltConflictCandidate[] | null;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const valid = raw.filter((c) => c && c.title && c.link);
  const hashes = await Promise.all(valid.map((c) => titleHashFor(c.title)));
  return valid.map((c, i) => ({
    source: c.source || 'GDELT',
    sourceUrl: '',
    sourcePriority: GDELT_SOURCE_PRIORITY,
    title: c.title,
    link: c.link,
    publishedAt: typeof c.publishedAt === 'number' ? c.publishedAt : Date.now(),
    description: '',
    body: '',
    imageUrl: null,
    titleHash: hashes[i]!,
    origin: 'gdelt' as const,
    gdeltLocation: c.location
      ? {
          latitude: c.location.lat,
          longitude: c.location.lng,
          country: c.location.country,
          locationName: c.location.locationName,
        }
      : null,
    gdeltSources: Array.isArray(c.sources) ? c.sources : [],
  }));
}

/**
 * Load GDELT category candidates and convert them to `RawRssItem`s tagged
 * `origin: 'gdelt'` + `gdeltCategories`. Same corroboration role as the
 * conflict candidates (never canonical, never displayed as content) — they
 * additionally carry the intel-topic tags the cluster inherits.
 */
async function loadCategoryCandidates(): Promise<RawRssItem[]> {
  const raw = (await getCachedJson(GDELT_CATEGORY_CANDIDATES_KEY)) as GdeltCategoryCandidate[] | null;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const valid = raw.filter(
    (c) => c && c.title && c.link && Array.isArray(c.categories) && c.categories.length > 0,
  );
  const hashes = await Promise.all(valid.map((c) => titleHashFor(c.title)));
  return valid.map((c, i) => ({
    source: c.source || 'GDELT',
    sourceUrl: '',
    sourcePriority: GDELT_SOURCE_PRIORITY,
    title: c.title,
    link: c.link,
    publishedAt: typeof c.publishedAt === 'number' ? c.publishedAt : Date.now(),
    description: '',
    body: '',
    imageUrl: null,
    titleHash: hashes[i]!,
    origin: 'gdelt' as const,
    gdeltCategories: c.categories,
    gdeltLocation: c.location
      ? {
          latitude: c.location.lat,
          longitude: c.location.lng,
          country: c.location.country,
          locationName: c.location.locationName,
        }
      : null,
    gdeltSources: Array.isArray(c.sources) ? c.sources : [],
  }));
}

const DIGEST_TTL_S = 3 * 24 * 60 * 60; // 3-day project max
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 500;
/**
 * Wall-clock cap on the parallel fan-out. With 159 feeds the slowest
 * 5-10 % (WashPost, CBC, ITV — large XML payloads + sometimes
 * Cloudflare challenges) can exceed 20 s. Bumped to 30 s; the Edge
 * function still has plenty of headroom before its function timeout
 * and the rest of the cron (clustering + Redis write) runs in <3 s.
 */
const FETCH_DEADLINE_MS = 30_000;

export interface RefreshResult {
  status: 'ok' | 'skipped';
  feeds: Record<string, 'ok' | 'empty' | 'timeout'>;
  fetched: number;
  clustered: number;
  totalAfter: number;
  generatedAt: string;
}

/**
 * Merge fresh clusters into the existing accumulator. Identity is the
 * canonical's titleHash. On hit we preserve all enrichment fields the
 * previous run accumulated (location / region / country / isConflict)
 * but always take the fresh summary + imageUrl + sources[] (since
 * those reflect current cluster membership across rolling feed fetches).
 */
function mergeItems(existing: ClusteredItem[], fresh: ClusteredItem[]): ClusteredItem[] {
  const byId = new Map<string, ClusteredItem>();
  for (const item of existing) {
    if (item?.id) byId.set(item.id, item);
  }
  for (const next of fresh) {
    const prev = byId.get(next.id);
    if (!prev) {
      byId.set(next.id, next);
      continue;
    }
    byId.set(next.id, {
      ...next,
      // Preserve enrichment from prior run.
      location: prev.location ?? next.location,
      locationName: prev.locationName ?? next.locationName,
      country: prev.country ?? next.country,
      region: prev.region ?? next.region,
      isConflict: prev.isConflict ?? next.isConflict,
      topics: prev.topics ?? next.topics,
      enrichVersion: prev.enrichVersion ?? next.enrichVersion,
      // Always take fresh summary/imageUrl/sources/isAlert — those
      // track cluster membership which changes as new outlets cover
      // the story.
    });
  }
  // Drop items past the rolling window, sort newest-first, cap.
  const cutoff = Date.now() - ROLLING_WINDOW_MS;
  return Array.from(byId.values())
    .filter((it) => it.publishedAt >= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, MAX_ITEMS);
}

/** Cron entry point. Idempotent — safe to invoke any number of times. */
export async function refreshLiveNewsV6(): Promise<RefreshResult> {
  const startedAt = Date.now();

  // ── Phase 1: RSS fan-out ─────────────────────────────────────────────
  const fetchStart = Date.now();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), FETCH_DEADLINE_MS);

  let normalized;
  try {
    normalized = await fetchAllFeeds(deadline.signal);
  } finally {
    clearTimeout(timer);
  }
  const fetchMs = Date.now() - fetchStart;
  const okFeeds = Object.values(normalized.feedStatuses).filter((s) => s === 'ok').length;
  const emptyFeeds = Object.values(normalized.feedStatuses).filter((s) => s === 'empty').length;
  const timedOutFeeds = Object.values(normalized.feedStatuses).filter((s) => s === 'timeout').length;
  console.log(
    `[live-news:v6:refresh] phase=fetch elapsed=${fetchMs}ms ` +
    `feeds_total=${Object.keys(normalized.feedStatuses).length} ` +
    `ok=${okFeeds} empty=${emptyFeeds} timeout=${timedOutFeeds} ` +
    `items=${normalized.items.length}`,
  );

  if (normalized.items.length === 0) {
    console.warn('[live-news:v6:refresh] no items returned from any feed — abort');
    return {
      status: 'skipped',
      feeds: normalized.feedStatuses,
      fetched: 0,
      clustered: 0,
      totalAfter: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  // ── Phase 1b: GDELT conflict + category candidates ───────────────────
  const [gdeltItems, gdeltCategoryItems] = await Promise.all([
    loadGdeltCandidates(),
    loadCategoryCandidates(),
  ]);
  console.log(
    `[live-news:v6:refresh] phase=gdelt conflict=${gdeltItems.length} ` +
    `category=${gdeltCategoryItems.length}`,
  );

  // ── Phase 2: Embed + cluster ─────────────────────────────────────────
  // RSS + GDELT items go through ONE clustering pass. GDELT items attach
  // to RSS clusters as corroboration; GDELT-only clusters are dropped
  // inside clusterRssItems (no trusted anchor).
  const clusterStart = Date.now();
  const clustered = await clusterRssItems([
    ...normalized.items,
    ...gdeltItems,
    ...gdeltCategoryItems,
  ]);
  const clusterMs = Date.now() - clusterStart;
  const multiSource = clustered.filter((c) => c.sources.length > 1).length;
  const gdeltBacked = clustered.filter(
    (c) => c.sources.some((s) => s.origin === 'gdelt'),
  ).length;
  console.log(
    `[live-news:v6:refresh] phase=cluster elapsed=${clusterMs}ms ` +
    `clusters=${clustered.length} multi_source=${multiSource} ` +
    `gdelt_corroborated=${gdeltBacked}`,
  );

  // ── Phase 3: Merge + Redis write ─────────────────────────────────────
  // 5 s read timeout (vs the 1.5 s user-facing default): the digest is a
  // multi-MB compressed blob and a timed-out read here is destructive —
  // it forces a rebuild-from-scratch that drops accumulated enrichment.
  // This is a cron, so a slightly longer wait costs nothing.
  const writeStart = Date.now();
  const existing = ((await getCachedJson(DIGEST_KEY, false, 5_000)) as ClusteredItem[] | null) ?? [];
  const merged = mergeItems(existing, clustered);
  await setCachedJson(DIGEST_KEY, merged, DIGEST_TTL_S);
  const writeMs = Date.now() - writeStart;
  console.log(
    `[live-news:v6:refresh] phase=write elapsed=${writeMs}ms ` +
    `existed=${existing.length} after=${merged.length}`,
  );

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[live-news:v6:refresh] DONE total=${elapsedMs}ms ` +
    `(fetch=${fetchMs} cluster=${clusterMs} write=${writeMs}) ` +
    `multi_source=${multiSource}/${clustered.length}`,
  );

  return {
    status: 'ok',
    feeds: normalized.feedStatuses,
    fetched: normalized.items.length,
    clustered: clustered.length,
    totalAfter: merged.length,
    generatedAt: new Date().toISOString(),
  };
}
