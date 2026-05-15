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
import { fetchAllFeeds } from './_normalize';
import { clusterRssItems, type ClusteredItem } from './_cluster';

export const DIGEST_KEY = 'live-news:v6:digest';
const DIGEST_TTL_S = 3 * 24 * 60 * 60; // 3-day project max
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 500;
const FETCH_DEADLINE_MS = 20_000;

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
      confidence: prev.confidence ?? next.confidence,
      // Always take fresh summary/imageUrl/sources — those track cluster
      // membership which changes as new outlets cover the story.
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

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), FETCH_DEADLINE_MS);

  let normalized;
  try {
    normalized = await fetchAllFeeds(deadline.signal);
  } finally {
    clearTimeout(timer);
  }

  if (normalized.items.length === 0) {
    console.warn('[live-news:v6:refresh] no items returned from any feed');
    return {
      status: 'skipped',
      feeds: normalized.feedStatuses,
      fetched: 0,
      clustered: 0,
      totalAfter: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  const clustered = await clusterRssItems(normalized.items);

  const existing = ((await getCachedJson(DIGEST_KEY)) as ClusteredItem[] | null) ?? [];
  const merged = mergeItems(existing, clustered);
  await setCachedJson(DIGEST_KEY, merged, DIGEST_TTL_S);

  const elapsedMs = Date.now() - startedAt;
  const multiSource = clustered.filter((c) => c.sources.length > 1).length;
  console.log(
    `[live-news:v6:refresh] feeds=${Object.keys(normalized.feedStatuses).length} ` +
    `raw=${normalized.items.length} clusters=${clustered.length} ` +
    `multi-source=${multiSource} existed=${existing.length} after=${merged.length} ` +
    `in ${elapsedMs}ms`,
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
