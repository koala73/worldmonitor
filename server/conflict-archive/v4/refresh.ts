/**
 * Conflict-archive v4 refresh — Newscatcher conflict-tagged seed.
 *
 * Same pattern as v3 (webz) and v2 (worldnews): a manual one-shot
 * bootstrap to fill the archive on day one. After that, the archive
 * grows organically — the enrichment cron tags live-news-nc items
 * as isConflict and copies them here.
 *
 * # Pipeline
 *
 *   1. POST /api/search with a tight conflict query + clustering on.
 *   2. Map each cluster → ConflictArchiveItemV4 with `origin: 'newscatcher'`.
 *      `summary` comes from `nlp.summary` (license-safe API content).
 *      `locationName` defaults to the top NER location; LLM may
 *      overwrite later. lat/lng remain null until the enrich cron runs.
 *   3. Merge into the existing archive idempotently by cluster_id.
 *   4. Prune past 30-day retention. Cap.
 */

import {
  searchNews,
  deriveSource,
  deriveSummary,
  deriveLocationName,
  parsePublishDate,
  isClusteredResponse,
  type NewscatcherArticle,
  type NewscatcherCluster,
} from '../../_shared/newscatcher-client';
import { getCachedJson, setCachedJson } from '../../_shared/redis';
import type { ConflictArchiveItem } from '../v1/_store';

/** Single Redis key — v4 archive in its own namespace. */
export const ARCHIVE_NC_KEY = 'conflict:archive:nc:v1';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_S = Math.floor(RETENTION_MS / 1000);
const MAX_ITEMS = 2000;

/** Conflict-keyword query — same intent as the webz / worldnews seeds. */
const CONFLICT_QUERY =
  '"airstrike" OR "missile strike" OR shelling OR "armed clash" OR ' +
  '"ground assault" OR "drone strike" OR "armed conflict" OR ' +
  'bombardment OR "rocket attack" OR "war crime" OR ' +
  '"military offensive" OR insurgents';

export type ConflictArchiveItemV4 = Omit<ConflictArchiveItem, 'origin'> & {
  origin: 'newscatcher' | 'webz' | 'worldnews' | 'live-news' | 'gdelt';
};

export interface RefreshResult {
  status: 'ok' | 'skipped';
  fetched: number;
  totalAfter: number;
  dropped: number;
  generatedAt: string;
}

function clusterToItem(cluster: NewscatcherCluster): ConflictArchiveItemV4 | null {
  const articles = cluster.articles ?? [];
  if (articles.length === 0) return null;
  const canonical: NewscatcherArticle = articles[0]!;

  const source = deriveSource(canonical);
  const publishedAt = parsePublishDate(canonical.published_date);
  if (!source || !canonical.title || !canonical.link || publishedAt === null) return null;

  // sources[] from every article in the cluster.
  const sources: ConflictArchiveItemV4['sources'] = [];
  for (const a of articles) {
    const s = deriveSource(a);
    const pa = parsePublishDate(a.published_date);
    if (s && a.title && a.link && pa !== null) {
      sources.push({ source: s, title: a.title, link: a.link, publishedAt: pa });
    }
  }

  return {
    id: `nc-${cluster.cluster_id}`,
    source,
    title: canonical.title,
    link: canonical.link,
    publishedAt,
    isAlert: false,
    summary: deriveSummary(canonical),
    location: null,
    locationName: deriveLocationName(canonical),
    country: null,
    region: null,
    sources: sources.length > 0 ? sources : null,
    origin: 'newscatcher',
  };
}

function mergeArchive(
  existing: ConflictArchiveItemV4[],
  fresh: ConflictArchiveItemV4[],
): ConflictArchiveItemV4[] {
  const byId = new Map<string, ConflictArchiveItemV4>();
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
      summary: next.summary,                       // never preserve old summary
      location: prev.location ?? next.location,
      locationName: prev.locationName ?? next.locationName,
      country: prev.country ?? next.country,
      region: prev.region ?? next.region,
      sources: prev.sources ?? next.sources,
    });
  }
  const cutoff = Date.now() - RETENTION_MS;
  return Array.from(byId.values())
    .filter((it) => typeof it.publishedAt === 'number' && it.publishedAt >= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, MAX_ITEMS);
}

export async function refreshConflictArchiveV4(): Promise<RefreshResult> {
  const startedAt = Date.now();

  // `/api/search` does NOT accept `when` — that's a latest_headlines-only
  // param (it returns 403 "Invalid Parameter: 'when'"). Use `from_` with
  // YYYY-MM-DD instead to scope to the last 24 hours of coverage.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const resp = await searchNews({
    q: CONFLICT_QUERY,
    from_: yesterday,
    lang: 'en',
    include_nlp_data: true,
    clustering_enabled: true,
    clustering_threshold: 0.7,
    page_size: 100,
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

  const fresh: ConflictArchiveItemV4[] = [];
  let dropped = 0;
  for (const cluster of resp.clusters ?? []) {
    const item = clusterToItem(cluster);
    if (item) fresh.push(item);
    else dropped++;
  }

  const existing = ((await getCachedJson(ARCHIVE_NC_KEY)) as ConflictArchiveItemV4[] | null) ?? [];
  const merged = mergeArchive(existing, fresh);
  await setCachedJson(ARCHIVE_NC_KEY, merged, RETENTION_S);

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[conflict-archive:v4:refresh] clusters=${resp.clusters?.length ?? 0} ` +
    `existed=${existing.length} after=${merged.length} dropped=${dropped} ` +
    `in ${elapsedMs}ms`,
  );

  return {
    status: 'ok',
    fetched: fresh.length,
    totalAfter: merged.length,
    dropped,
    generatedAt: new Date().toISOString(),
  };
}
