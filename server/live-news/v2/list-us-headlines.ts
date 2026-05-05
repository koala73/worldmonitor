/**
 * `GET /api/live-news/v2/list-us-headlines` — handler core (v2).
 *
 * Same pipeline as v1, with one difference: when the LLM dedup classifier
 * decides two items cover the same story, we no longer drop the duplicate.
 * Instead the canonical surfaces them as a `sources[]` array so clients can
 * show "Also covered by Reuters, BBC, AP" on a single feed entry.
 *
 * v1 (`/api/live-news/v1/list-us-headlines`) is unchanged — existing iOS
 * builds keep working. v2 is opt-in for new builds.
 *
 * Caching: separate Redis key (`live-news:us:v2-sources:v1`) so v1 and v2
 * caches never poison each other. Per-feed caches and per-headline LLM
 * enrichment caches are reused as-is — same upstream data, different
 * presentation.
 */

import { cachedFetchJson } from '../../_shared/redis';
import { keepAlive } from '../../_shared/keep-alive';
import { buildBaseDigest } from '../v1/_normalize';
import { attachCachedEnrichment, enrichMissingAsync } from '../v1/_enrich-combined';
import {
  loadCachedDedupMap,
  applyDedupWithSources,
  classifyUnknownsAsync,
  type LiveNewsItemWithSources,
} from '../v1/_dedup';

const TOP_LEVEL_TTL_S = 30;
const NEGATIVE_TTL_S = 30;
const FAN_OUT_DEADLINE_MS = 20_000;

export interface ListUsHeadlinesV2Response {
  items: LiveNewsItemWithSources[];
  feedStatuses: Record<string, 'ok' | 'empty' | 'timeout'>;
  generatedAt: string;
  /** Diagnostic — how many items were missing a cached location at digest time. */
  pendingEnrichment: number;
  /** Diagnostic — mirrored for iOS Codable compatibility (combined enrichment). */
  pendingParaphrase: number;
}

/** In-memory last-good — fallback if Redis is hard-down on a cold instance. */
let lastGoodResponse: ListUsHeadlinesV2Response | null = null;

async function buildDigestPayload(): Promise<ListUsHeadlinesV2Response> {
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), FAN_OUT_DEADLINE_MS);

  try {
    const { items, feedStatuses } = await buildBaseDigest(deadline.signal);

    // Read path — identical to v1.
    const [missingEnrichment, dedupMap] = await Promise.all([
      attachCachedEnrichment(items),
      loadCachedDedupMap(items),
    ]);

    // Write path — identical to v1. Both endpoints share the same enrichment
    // and dedup-classification caches, so calling either endpoint warms the
    // caches that benefit both.
    if (missingEnrichment.length > 0) {
      console.log(`[live-news:v2] Kicking off enrichment for ${missingEnrichment.length} items`);
      keepAlive(enrichMissingAsync(missingEnrichment), 'live-news-v2:enrich');
    }
    const unknownDedup = items.filter((it) => !dedupMap.has(it.titleHash));
    if (unknownDedup.length > 0) {
      console.log(`[live-news:v2] Kicking off dedup classification for ${unknownDedup.length} items`);
      keepAlive(classifyUnknownsAsync(items, dedupMap), 'live-news-v2:dedup');
    }

    // The only meaningful divergence from v1: keep duplicates on the
    // canonical as `sources[]` instead of dropping them.
    const grouped = applyDedupWithSources(items, dedupMap);

    // Diagnostics
    const totalSources = grouped.reduce((sum, it) => sum + it.sources.length, 0);
    const multiSource = grouped.filter((it) => it.sources.length > 1).length;
    const withSummary = grouped.filter((it) => typeof it.summary === 'string' && it.summary.length > 0).length;
    const withLocation = grouped.filter((it) => it.location !== null).length;
    console.log(
      `[live-news:v2] returning ${grouped.length} stories, ${totalSources} total sources ` +
      `(${multiSource} multi-source). withSummary=${withSummary}/${grouped.length} ` +
      `withLocation=${withLocation}/${grouped.length}`,
    );

    return {
      items: grouped,
      feedStatuses,
      generatedAt: new Date().toISOString(),
      pendingEnrichment: missingEnrichment.length,
      pendingParaphrase: missingEnrichment.length,
    };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

/**
 * Public entrypoint. Always returns a response (even an empty one if every
 * upstream fails). Mirrors the v1 last-good fallback so a hard-Redis-down
 * cold instance still serves the most recently successful payload.
 */
export async function listUsHeadlinesV2(): Promise<ListUsHeadlinesV2Response> {
  // Distinct cache key — v1 and v2 must not contaminate each other. Bump the
  // suffix when the v2 wire shape changes (just like v1 does with `live-news:us:v6`).
  // Kept at v2-sources:v1 — same rationale as v1 digest. The `isConflict`
  // field rides through on each item's enrichment as it refreshes naturally;
  // the digest cache layer doesn't need a forced rebuild.
  const cacheKey = 'live-news:us:v2-sources:v1';

  try {
    const result = await cachedFetchJson<ListUsHeadlinesV2Response>(
      cacheKey,
      TOP_LEVEL_TTL_S,
      async () => buildDigestPayload(),
      NEGATIVE_TTL_S,
    );

    if (result) {
      lastGoodResponse = result;
      return result;
    }
  } catch (err) {
    console.warn('[live-news:v2] listUsHeadlinesV2 failed:', err instanceof Error ? err.message : err);
  }

  if (lastGoodResponse) return lastGoodResponse;
  return {
    items: [],
    feedStatuses: {},
    generatedAt: new Date().toISOString(),
    pendingEnrichment: 0,
    pendingParaphrase: 0,
  };
}
